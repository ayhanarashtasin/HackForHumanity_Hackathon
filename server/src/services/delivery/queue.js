import { DELIVERY_CHANNELS, PHONE_CHANNELS, SEVERITY_RANK } from '../../config/alertConstants.js';
import { env } from '../../config/env.js';
import { Delivery } from '../../models/Delivery.js';
import { Notification } from '../../models/Notification.js';
import { Subscriber } from '../../models/Subscriber.js';
import { reevaluateSubscriber } from '../alerts/engine.js';
import { ChannelError } from './errors.js';
import { renderMessage } from './format.js';
import {
  dayStart, hazardAllowsChannel, inQuietHours, isCritical, meetsMinSeverity, quietEndsAt, skipsQuietHours, stageKey,
} from './policy.js';
import { decrypt } from './secretBox.js';

// Stored notifications -> external messages. The inbox is the source of truth; this layer only copies what is already visible there.
//   enqueue   every active notification of a person who linked a channel becomes one pending Delivery row per channel and stage
//             (a unique key makes this idempotent: running it every few seconds never duplicates anything);
//   dispatch  pending rows are claimed one at a time, re-checked against the notification and the person's choices at send time,
//             sent, and either finished, deferred (quiet hours), retried with back-off, or failed with a reason.
const MINUTE = 60_000;
const RETRY_DELAYS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const AUTH_RETRY = 10 * MINUTE;
const LEASE = 2 * MINUTE;
const PURGE_DAYS = 30;
const CHUNK = 400;

// What a profile has linked, by channel: the Telegram chat id, or the encrypted phone number of a verified WhatsApp/SMS channel.
export function linkedChannels(subscriber) {
  const channels = subscriber.channels ?? {};
  const linked = {};
  if (typeof channels.telegram?.chatId === 'string' && channels.telegram.chatId) linked.telegram = channels.telegram.chatId;
  for (const name of PHONE_CHANNELS) {
    if (channels[name]?.verifiedAt && channels[name]?.phoneEnc) linked[name] = channels[name].phoneEnc;
  }
  return linked;
}

// When this notification last became worth sending: it was published, or it escalated / was released since.
function triggerTime(notification) {
  let latest = +new Date(notification.publishedAt);
  for (const entry of notification.lifecycle ?? []) {
    if (['published', 'escalated'].includes(entry.type)) latest = Math.max(latest, +new Date(entry.at));
  }
  return latest;
}

const availableNames = (channels) => DELIVERY_CHANNELS.filter((name) => channels[name]?.available);

export async function enqueueDeliveries({ channels, nowMs = Date.now() }) {
  const active = availableNames(channels);
  const result = { subscribers: 0, queued: 0 };
  if (!active.length) return result;

  const now = new Date(nowMs);
  const linkedAny = active.map((name) => (name === 'telegram'
    ? { 'channels.telegram.chatId': { $type: 'string' } }
    : { [`channels.${name}.verifiedAt`]: { $ne: null } }));
  const subscribers = await Subscriber.find(
    { status: 'active', isDemo: { $ne: true }, expiresAt: { $gt: now }, $or: linkedAny },
    { channels: 1 },
  ).lean();
  result.subscribers = subscribers.length;

  const since = nowMs - env.channels.maxAgeMinutes * MINUTE;
  const purgeAfter = new Date(nowMs + PURGE_DAYS * 86_400_000);

  for (let i = 0; i < subscribers.length; i += CHUNK) {
    const group = subscribers.slice(i, i + CHUNK);
    const byId = new Map(group.map((subscriber) => [String(subscriber._id), subscriber]));
    const notifications = await Notification.find({
      subscriberId: { $in: group.map((subscriber) => subscriber._id) },
      status: 'active',
      validUntil: { $gt: now },
      publishedAt: { $ne: null },
      isDemo: { $ne: true },
      // Stale or unavailable data never starts a message: the same rule the engine applies to new notifications.
      dataStatus: { $nin: ['STALE', 'UNAVAILABLE'] },
      updatedAt: { $gte: new Date(since) },
    }, { subscriberId: 1, severity: 1, hazardType: 1, renotifications: 1, publishedAt: 1, lifecycle: 1 }).lean();

    const ops = [];
    for (const notification of notifications) {
      if (triggerTime(notification) < since) continue;
      const linked = linkedChannels(byId.get(String(notification.subscriberId)) ?? {});

      for (const channel of active) {
        if (!linked[channel] || !meetsMinSeverity(channel, notification.severity) || !hazardAllowsChannel(notification.hazardType, channel)) continue;
        ops.push({
          updateOne: {
            filter: { notificationId: notification._id, channel, stageKey: stageKey(notification) },
            update: {
              $setOnInsert: {
                subscriberId: notification.subscriberId,
                severity: notification.severity,
                rank: SEVERITY_RANK[notification.severity] ?? 1,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: now,
                leaseUntil: null,
                createdAt: now,
                purgeAfter,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (ops.length) {
      const written = await Delivery.bulkWrite(ops, { ordered: false });
      result.queued += written.upsertedCount ?? 0;
    }
  }
  return result;
}

// Takes a channel away from a profile (the person asked, or the channel told us it can no longer reach them) and drops its waiting messages.
export async function unlinkChannel(subscriberId, channel, reason = 'channel_unlinked') {
  await Subscriber.updateOne({ _id: subscriberId }, { $unset: { [`channels.${channel}`]: '' } });
  if (channel === 'telegram') {
    const cleared = await Subscriber.updateOne({ _id: subscriberId, 'currentArea.source': 'telegram' }, { $set: { currentArea: null } });
    if (cleared.modifiedCount) await reevaluateSubscriber(subscriberId);
  }
  await Delivery.updateMany(
    { subscriberId, channel, status: { $in: ['pending', 'sending'] } },
    { $set: { status: 'skipped', skippedReason: reason, leaseUntil: null } },
  );
}

const short = (text) => String(text ?? '').slice(0, 160);

export async function dispatchDue({
  channels, nowMs = Date.now(), limit = 200, concurrency = 4,
}) {
  const now = new Date(nowMs);
  const stats = {
    sent: 0, failed: 0, skipped: 0, retried: 0, deferred: 0,
  };

  // A worker that died mid-send leaves a lease behind; the row goes back to pending (the unique key still guards against a double send
  // of the same stage only if it was recorded, so a crash between "sent" and "recorded" can repeat one message: at-least-once).
  await Delivery.updateMany({ status: 'sending', leaseUntil: { $lt: now } }, { $set: { status: 'pending', leaseUntil: null } });

  const halted = new Set(); // channels whose credentials were rejected during this cycle
  let claimed = 0;

  // Rows for one person on one channel are handled one after another: the daily cap counts what was just sent, which parallel workers
  // would not see. (A lease keeps a second process from running a cycle at the same time.)
  const chains = new Map();
  function serialized(key, task) {
    const run = (chains.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  async function processRow(row) {
    const finish = (set) => Delivery.updateOne({ _id: row._id }, { $set: { leaseUntil: null, ...set } });
    const skip = async (reason) => {
      await finish({ status: 'skipped', skippedReason: reason });
      stats.skipped += 1;
    };
    const channel = channels[row.channel];

    if (!channel?.available) return skip('channel_unavailable');
    if (halted.has(row.channel)) {
      await finish({ status: 'pending', nextAttemptAt: new Date(nowMs + AUTH_RETRY) });
      stats.retried += 1;
      return;
    }

    const [notification, subscriber] = await Promise.all([
      Notification.findById(row.notificationId).lean(),
      Subscriber.findById(row.subscriberId, { status: 1, expiresAt: 1, preferences: 1, channels: 1 }).lean(),
    ]);

    // Everything below is re-checked now, not when the row was queued: minutes may have passed.
    if (!notification || notification.status !== 'active' || +notification.validUntil <= nowMs) return skip('no_longer_active');
    if (stageKey(notification) !== row.stageKey) return skip('superseded');
    if (!hazardAllowsChannel(notification.hazardType, row.channel)) return skip('channel_not_for_hazard');
    if (!subscriber || subscriber.expiresAt <= now) return skip('subscriber_inactive');
    if (subscriber.status !== 'active') return skip('subscriber_paused');

    const target = linkedChannels(subscriber)[row.channel];
    if (!target) return skip('channel_unlinked');

    const quiet = subscriber.preferences?.quietHours;
    if (!skipsQuietHours(notification) && inQuietHours(quiet, nowMs)) {
      const resumeAt = quietEndsAt(quiet, nowMs);
      if (resumeAt >= +notification.validUntil) return skip('expired_in_quiet_hours');
      await finish({ status: 'pending', nextAttemptAt: new Date(resumeAt) });
      stats.deferred += 1;
      return;
    }

    if (!isCritical(notification.severity)) {
      const sentToday = await Delivery.countDocuments({
        subscriberId: subscriber._id, channel: row.channel, status: 'sent', sentAt: { $gte: dayStart(nowMs) },
      });
      if (sentToday >= env.channels.dailyCap[row.channel]) return skip('daily_cap');
    }

    let to = target;
    if (PHONE_CHANNELS.includes(row.channel)) {
      try {
        to = decrypt(target);
      } catch {
        return skip('unreadable_number'); // the secret changed: the person has to verify the number again
      }
    }

    const attempts = row.attempts + 1;
    try {
      const content = renderMessage(row.channel, notification, { nowMs });
      const { providerMessageId = null } = await channel.send({ to, content, lang: notification.lang });
      await finish({ status: 'sent', sentAt: new Date(), providerMessageId, attempts, errorClass: null, lastError: null });
      stats.sent += 1;
    } catch (error) {
      const failure = error instanceof ChannelError ? error : new ChannelError('retry', 'Unexpected delivery error.');
      const base = { attempts, errorClass: failure.kind, lastError: short(failure.message) };

      if (failure.kind === 'blocked') {
        await finish({ ...base, status: 'failed' });
        await unlinkChannel(subscriber._id, row.channel, 'channel_blocked');
        stats.failed += 1;
        return;
      }

      const credentialProblem = failure.kind === 'auth' || failure.kind === 'config';
      if (credentialProblem) halted.add(row.channel);

      if ((failure.kind === 'retry' || credentialProblem) && attempts < env.channels.maxAttempts) {
        const wait = credentialProblem ? AUTH_RETRY : (failure.retryAfterMs ?? RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        const next = nowMs + wait;
        if (next < +notification.validUntil) {
          await finish({ ...base, status: 'pending', nextAttemptAt: new Date(next) });
          stats.retried += 1;
          return;
        }
      }
      await finish({ ...base, status: 'failed' });
      stats.failed += 1;
    }
  }

  async function worker() {
    while (claimed < limit) {
      claimed += 1;
      const row = await Delivery.findOneAndUpdate(
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { $set: { status: 'sending', leaseUntil: new Date(nowMs + LEASE) } },
        { sort: { rank: -1, nextAttemptAt: 1 }, returnDocument: 'after' },
      ).lean();
      if (!row) return;

      try {
        await serialized(`${row.subscriberId}:${row.channel}`, () => processRow(row));
      } catch (error) {
        // Never lose a row to an unexpected bug: hand it back for the next cycle and keep going.
        await Delivery.updateOne({ _id: row._id }, { $set: { status: 'pending', leaseUntil: null, nextAttemptAt: new Date(nowMs + MINUTE), lastError: short(error?.name) } });
        stats.retried += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, worker));
  return stats;
}

export async function runDeliveryCycle({ channels, nowMs = Date.now(), limit, concurrency } = {}) {
  const queued = await enqueueDeliveries({ channels, nowMs });
  const sent = await dispatchDue({ channels, nowMs, limit, concurrency });
  return { ...queued, ...sent, status: 'ok' };
}

// Counts for the administrator: what went out, what is waiting, what failed and why, per channel, over the last `hours`.
export async function deliveryStats({ hours = 24, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - hours * 3_600_000);
  const rows = await Delivery.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { channel: '$channel', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const reasons = await Delivery.aggregate([
    { $match: { createdAt: { $gte: since }, $or: [{ skippedReason: { $ne: null } }, { errorClass: { $ne: null } }], status: { $in: ['failed', 'skipped'] } } },
    { $group: { _id: { channel: '$channel', reason: { $ifNull: ['$skippedReason', '$errorClass'] } }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ]);

  const byChannel = Object.fromEntries(DELIVERY_CHANNELS.map((channel) => [channel, {
    pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, reasons: [],
  }]));
  for (const row of rows) byChannel[row._id.channel][row._id.status] = row.count;
  for (const row of reasons) byChannel[row._id.channel].reasons.push({ reason: row._id.reason, count: row.count });
  return { hours, byChannel };
}
