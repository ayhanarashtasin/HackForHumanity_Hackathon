import { env } from '../../config/env.js';
import { MorningDigest } from '../../models/MorningDigest.js';
import { Subscriber } from '../../models/Subscriber.js';
import { addDays, dhakaDate, dhakaWallTime } from '../time.js';
import { resolveLanguage } from './botReports/commands.js';
import { defaultDeps } from './botReports/data.js';
import { placesForAreas } from './botReports/places.js';
import { forecastFor, freshnessOf, todayIdx } from './botReports/readings.js';
import { buttonsFor, renderMorning, toPlain } from './botReports/text.js';
import { ChannelError } from './errors.js';
import { inQuietHours } from './policy.js';
import { unlinkChannel } from './queue.js';

// The morning weather message: once a day, at the set time (Bangladesh time), every Telegram chat connected to a profile with a saved area
// receives today's weather for that area. It is the same forecast and the same words as /update and the other commands, sent without being
// asked. It never calls a weather provider and puts nothing about the person into the text: the saved area only chooses where to look.
//   one row per person per day (MorningDigest) makes the send idempotent across ticks and across servers;
//   a person's quiet hours are respected (the message waits for them to end, and is skipped if the window has closed by then);
//   a forecast that is not current is never sent as "today's weather": the job waits until it is, or skips the day;
//   it does not count against the daily alert cap and never holds up an alert, because it does not use the delivery queue at all.
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEASE_MS = 2 * MINUTE;
const RETRY_DELAYS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const AUTH_RETRY = 10 * MINUTE;
const PURGE_DAYS = 30;
const MIN_WINDOW_MS = 10 * MINUTE;

const short = (text) => String(text ?? '').slice(0, 160);

// The send window of one Bangladesh day: it opens at the set time and closes `graceHours` later (never later than midnight, because a
// morning message is about the day it is sent on, and never sooner than ten minutes so that a tick is certain to fall inside it).
export function digestWindow(nowMs, {
  time = env.channels.morningDigest.time, graceHours = env.channels.morningDigest.graceHours,
} = {}) {
  const date = dhakaDate(new Date(nowMs));
  const opensAt = dhakaWallTime(date, time).getTime();
  const midnight = dhakaWallTime(addDays(date, 1), '00:00').getTime();
  const closesAt = Math.min(opensAt + Math.max(graceHours * HOUR, MIN_WINDOW_MS), midnight);
  return {
    date, opensAt, closesAt, open: nowMs >= opensAt && nowMs < closesAt,
  };
}

// The right to send today's message to one person: the first worker to insert the (person, day) row gets it; a row left behind by a
// crashed worker (lease over) or waiting for a retry that is now due can be taken over. Anything else (sent, skipped, failed, in progress
// elsewhere) is not ours. -> the row, or null.
async function claim(subscriberId, date, nowMs) {
  const now = new Date(nowMs);
  const leaseUntil = new Date(nowMs + LEASE_MS);
  try {
    const created = await MorningDigest.updateOne(
      { subscriberId, date },
      {
        $setOnInsert: {
          status: 'sending', attempts: 0, sentParts: 0, leaseUntil, createdAt: now, purgeAfter: new Date(nowMs + PURGE_DAYS * DAY),
        },
      },
      { upsert: true },
    );
    if (created.upsertedCount === 1) return { _id: created.upsertedId, attempts: 0, sentParts: 0 };
  } catch (error) {
    if (error?.code === 11000) return null; // another worker inserted it a moment ago
    throw error;
  }
  return MorningDigest.findOneAndUpdate(
    {
      subscriberId,
      date,
      $or: [{ status: 'retry', nextAttemptAt: { $lte: now } }, { status: 'sending', leaseUntil: { $lt: now } }],
    },
    { $set: { status: 'sending', leaseUntil } },
    { returnDocument: 'after' },
  ).lean();
}

// A message with formatting. If Telegram refuses the markup (it should not), the same words go out as plain text instead of nothing.
async function sendMessage(telegram, chatId, { text, buttons }) {
  try {
    await telegram.send({ to: chatId, content: { text, parseMode: 'HTML', buttons } });
  } catch (error) {
    if (error?.kind !== 'permanent') throw error;
    await telegram.send({ to: chatId, content: { text: toPlain(text) } });
  }
}

// -> { sent, failed, skipped, retried, deferred, status } where status is 'idle' (outside the window or Telegram is not set up),
// 'no-forecast' or 'stale-forecast' (nothing is sent, the next tick tries again) or 'ok'.
export async function runMorningDigest({
  channels, nowMs = Date.now(), deps = defaultDeps, log = console, limit = 5000, concurrency = 4,
} = {}) {
  const stats = {
    sent: 0, failed: 0, skipped: 0, retried: 0, deferred: 0,
  };
  const telegram = channels?.telegram;
  const window = digestWindow(nowMs);
  if (!telegram?.available || !window.open) return { ...stats, status: 'idle' };

  const ctx = deps.loadForecast({ now: nowMs });
  if (!ctx.baseRaw) return { ...stats, status: 'no-forecast' };
  if (freshnessOf(ctx[ctx.base]?.info).status !== 'ok') return { ...stats, status: 'stale-forecast' };

  const now = new Date(nowMs);
  const done = await MorningDigest.find({ date: window.date, status: { $in: ['sent', 'skipped', 'failed'] } }, { subscriberId: 1 }).lean();
  const subscribers = await Subscriber.find(
    {
      status: 'active',
      isDemo: { $ne: true },
      expiresAt: { $gt: now },
      'channels.telegram.chatId': { $type: 'string' },
      _id: { $nin: done.map((row) => row.subscriberId) },
    },
    {
      channels: 1, language: 1, areas: 1, preferences: 1,
    },
  ).limit(limit).lean();

  // Many people share a place: its forecast and its lightning check are worked out once per run.
  const forecasts = new Map();
  const forecastOf = (place) => {
    if (!forecasts.has(place.id)) forecasts.set(place.id, forecastFor(place, ctx));
    return forecasts.get(place.id);
  };
  const lightnings = new Map();
  const lightningOf = (place) => {
    if (!lightnings.has(place.id)) {
      lightnings.set(place.id, Promise.resolve().then(() => deps.lightningFor(place, { nowMs })).catch(() => ({ pick: null, error: true })));
    }
    return lightnings.get(place.id);
  };

  let halted = false; // the bot token was rejected: every other send would fail the same way

  async function processOne(subscriber) {
    // Quiet hours are the person's choice: nothing is claimed, so the next tick looks again until their window ends (or ours closes).
    if (inQuietHours(subscriber.preferences?.quietHours, nowMs)) {
      stats.deferred += 1;
      return;
    }
    const row = await claim(subscriber._id, window.date, nowMs);
    if (!row) return;

    const finish = (set) => MorningDigest.updateOne({ _id: row._id }, { $set: { leaseUntil: null, ...set } });
    const skip = async (reason) => {
      await finish({ status: 'skipped', skippedReason: reason });
      stats.skipped += 1;
    };

    const places = placesForAreas(subscriber.areas, 2);
    if (!places.length) return skip('no_area');

    let messages;
    try {
      const lang = resolveLanguage({ subscriber });
      const alertCount = await Promise.resolve().then(() => deps.alertsFor(subscriber, nowMs)).then((result) => result.items.length).catch(() => null);
      messages = [];
      for (const place of places) {
        const forecast = forecastOf(place);
        // A place the stored forecast does not cover today has nothing to report; saying "unavailable" every morning would only be noise.
        if (!forecast.available || !todayIdx(forecast).length) continue;
        messages.push({
          text: renderMorning(forecast, {
            lang, nowMs, lightning: await lightningOf(place), alertCount,
          }),
          buttons: buttonsFor(place, lang),
        });
      }
    } catch (error) {
      // The words could not be built: trying again would fail the same way.
      await finish({ status: 'failed', errorClass: 'render', lastError: short(error?.name) });
      stats.failed += 1;
      return;
    }
    if (!messages.length) return skip('no_forecast');

    const chatId = subscriber.channels.telegram.chatId;
    const attempts = row.attempts + 1;
    try {
      // A retry continues after the messages that already went out, so a person with two saved areas is not sent the first one twice.
      for (let i = row.sentParts ?? 0; i < messages.length; i += 1) {
        await sendMessage(telegram, chatId, messages[i]);
        await MorningDigest.updateOne({ _id: row._id }, { $set: { sentParts: i + 1 } });
      }
      await finish({
        status: 'sent', sentAt: new Date(), attempts, errorClass: null, lastError: null,
      });
      stats.sent += 1;
    } catch (error) {
      const failure = error instanceof ChannelError ? error : new ChannelError('retry', 'Unexpected delivery error.');
      const base = { attempts, errorClass: failure.kind, lastError: short(failure.message) };

      if (failure.kind === 'blocked') {
        // The person blocked the bot or deleted the chat: stop sending to it (the same rule the alert queue follows).
        await finish({ ...base, status: 'failed' });
        await unlinkChannel(subscriber._id, 'telegram', 'channel_blocked');
        stats.failed += 1;
        return;
      }

      const credentialProblem = failure.kind === 'auth' || failure.kind === 'config';
      if (credentialProblem) halted = true;
      if ((failure.kind === 'retry' || credentialProblem) && attempts < env.channels.maxAttempts) {
        const wait = credentialProblem ? AUTH_RETRY : (failure.retryAfterMs ?? RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        if (nowMs + wait < window.closesAt) {
          await finish({ ...base, status: 'retry', nextAttemptAt: new Date(nowMs + wait) });
          stats.retried += 1;
          return;
        }
      }
      await finish({ ...base, status: 'failed' });
      stats.failed += 1;
    }
  }

  let next = 0;
  async function worker() {
    while (!halted && next < subscribers.length) {
      const subscriber = subscribers[next];
      next += 1;
      try {
        await processOne(subscriber);
      } catch (error) {
        // Never let one person stop the rest. A row left in "sending" is taken over once its lease is over.
        log.error(`[morning-digest] could not process one profile: ${error?.name ?? 'error'}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(subscribers.length, 1)) }, worker));

  return { ...stats, status: 'ok', recipients: subscribers.length };
}
