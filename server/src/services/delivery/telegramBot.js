import { env } from '../../config/env.js';
import { JobState } from '../../models/JobState.js';
import { sharedChannels } from './channels/index.js';
import { defaultDeps } from './botReports/data.js';
import {
  REPORT_COMMANDS, answerCommand, canonicalCommand, createRateLimiter, resolveLanguage,
} from './botReports/commands.js';
import { hospitalList, resetHospitalListsForTests } from './botReports/hospitalLists.js';
import { placeById, placeForPoint } from './botReports/places.js';
import { routePlaceById } from './botReports/routePlaces.js';
import { hospitalsInternals } from '../hospitals.js';
import { renderHospitalPage, renderHospitalsExpired } from './botReports/routeText.js';
import {
  commandMenu, esc, renderBusy, renderError, renderHelp, toPlain,
} from './botReports/text.js';
import { consumeTelegramLink, unlinkTelegramChat } from './linking.js';

// The bot's side of the conversation. /start <code> connects this chat to an alert profile, /stop disconnects it, /help lists the commands,
// and the weather commands (/update, /heat, /rain, /wind, /thunderstorm, /lightning, /forecast, /route, /alerts, /status) answer from the stored
// forecast (botReports/). A shared location is resolved to an area immediately; coordinates are never stored.
const WEB = () => esc(`${env.channels.publicUrl}/alert`);

const REPLIES = {
  en: {
    linked: () => '<b>Connected</b>\nAkashSathi alerts will arrive here.\n\n/update — weather forecast\n/stop — stop alerts',
    invalid: () => `This link has expired or was already used.\nOpen ${WEB()} and choose "Connect Telegram".`,
    stopped: () => '<b>Stopped</b>\nYou will no longer receive alerts here.\n\n/help — weather commands',
    nothing: () => 'No AkashSathi alert profile was connected to this chat.',
  },
  bn: {
    linked: () => '<b>সংযুক্ত হয়েছে</b>\nআকাশসাথীর সতর্কবার্তা এখানে আসবে।\n\n/update — আবহাওয়ার পূর্বাভাস\n/stop — সতর্কবার্তা বন্ধ',
    invalid: () => `এই লিংকের মেয়াদ শেষ অথবা এটি আগেই ব্যবহার হয়েছে।\n${WEB()} থেকে "টেলিগ্রাম সংযুক্ত করুন" বেছে নিন।`,
    stopped: () => '<b>বন্ধ করা হয়েছে</b>\nএই চ্যাটে আর সতর্কবার্তা আসবে না।\n\n/help — আবহাওয়ার কমান্ড',
    nothing: () => 'এই চ্যাটে আকাশসাথীর কোনো সতর্কবার্তা প্রোফাইল সংযুক্ত ছিল না।',
  },
};

// Before a chat is linked there is no stored language, so the reply carries both.
const both = (key) => `${REPLIES.en[key]()}\n\n${REPLIES.bn[key]()}`;
const say = (key, lang) => (lang === 'bn' || lang === 'en' ? REPLIES[lang][key]() : both(key));

const recent = new Set();
function seen(updateId) {
  if (updateId === undefined) return false;
  if (recent.has(updateId)) return true;
  recent.add(updateId);
  if (recent.size > 500) recent.delete(recent.values().next().value);
  return false;
}

// One chat may send only so many weather requests in ten minutes (TELEGRAM_COMMAND_LIMIT); /start, /stop and /help are never limited.
const limiter = createRateLimiter();

// The question the bot just asked a chat ("Which place?" after /thunderstorm, "Where do you start?" after /route Bandarban), kept in memory
// for a few minutes so a plain place name or a shared location answers that command. Only the command name and, for /route, the id of the
// end already chosen are kept: nothing about the person, never coordinates.
const ASKED_FOR_MS = 5 * 60_000;
const ASKING = new Set(['ask-place', 'ambiguous', 'not-found', 'ask-route', 'ask-route-start', 'ask-route-end', 'route-ambiguous', 'route-not-found', 'route-unclear']);
const asked = new Map();

function rememberQuestion(chatId, command, nowMs, extra = {}) {
  asked.delete(chatId);
  asked.set(chatId, { command: extra.command ?? command, at: nowMs, routeTo: extra.routeTo ?? null, routeFrom: extra.routeFrom ?? null });
  if (asked.size > 5000) asked.delete(asked.keys().next().value);
}

// -> { command, routeTo, routeFrom } or null.
function takeQuestion(chatId, nowMs) {
  const entry = asked.get(chatId);
  asked.delete(chatId);
  return entry && nowMs - entry.at <= ASKED_FOR_MS ? entry : null;
}

// The ids a /route question has already settled, as answerCommand takes them.
const pendingRoute = (question) => ({ routeToId: question?.routeTo ?? null, routeFromId: question?.routeFrom ?? null });

export function resetBotForTests() {
  recent.clear();
  limiter.reset();
  asked.clear();
  resetHospitalListsForTests();
}

// A reply with formatting. If Telegram refuses the markup (it should not), the same words go out as plain text instead of nothing.
async function sendReport(channels, chatId, { text, buttons = null, requestLocation = false, removeKeyboard = false }) {
  try {
    await channels.telegram.send({ to: chatId, content: { text, parseMode: 'HTML', buttons, requestLocation, removeKeyboard } });
  } catch (error) {
    if (error?.kind !== 'permanent') return;
    try {
      await channels.telegram.send({ to: chatId, content: { text: toPlain(text) } });
    } catch {
      // The person may already have blocked the bot; nothing more to do.
    }
  }
}

async function replyPlain(channels, chatId, text) {
  try {
    await channels.telegram.send({ to: chatId, content: { text } });
  } catch {
    // The person may already have blocked the bot; nothing more to do.
  }
}

// A /route search may ask the road service three times (one road and two detours), so it counts three against the chat's limit.
const ROUTE_WEIGHT = 3;

// Runs one weather command and sends its replies. Returns the action for the caller (and the tests).
async function runWeatherCommand(channels, chatId, request, { now, deps }) {
  const languageCode = request.languageCode ?? null;
  const route = request.command === 'route';
  const verdict = limiter.hit(chatId, now.getTime(), route ? ROUTE_WEIGHT : 1);
  if (!verdict.allowed) {
    if (verdict.announce) await replyPlain(channels, chatId, renderBusy(resolveLanguage({ languageCode })));
    return { handled: true, action: 'rate-limited' };
  }
  // A road search takes a few seconds: show "typing…" meanwhile. Best effort.
  if (route) channels.telegram.sendChatAction?.(chatId)?.catch?.(() => {});
  try {
    const result = await answerCommand({
      ...request, chatId, nowMs: now.getTime(), deps,
    });
    if (ASKING.has(result.action)) rememberQuestion(chatId, request.command, now.getTime(), result.remember);
    else asked.delete(chatId);
    for (const message of result.messages) await sendReport(channels, chatId, message);
    return { handled: true, action: result.action };
  } catch (error) {
    console.error(`[telegram] could not answer /${request.command}: ${error?.name ?? 'error'}`);
    await replyPlain(channels, chatId, renderError(resolveLanguage({ languageCode })));
    return { handled: true, action: 'error' };
  }
}

// A pressed inline button: "r:<command>:<place id>:<language>", or a route's "t:<from id>:<to id>:<departure>:<language>" (routeText.js).
// Anything that does not parse is ignored, never trusted; route ids are looked up again (an unknown one gets "this button has expired").
const BUTTON_DATA = /^r:([a-z_]+):([0-9A-Za-z]{1,24}):(bn|en)$/;
const ROUTE_BUTTON = /^t:([0-9A-Za-z]{1,24}):([0-9A-Za-z]{1,24}):(0|3|m):(bn|en)$/;
// A route report's hospital list (routeText.js hospitalsButton / renderHospitalPage): "h:<token>:<language>" opens it in a new message,
// "hp:<token>:<page>:<language>" turns that message to another page. Paging reads the kept list only, so it is not rate-limited.
const HOSPITALS_OPEN = /^h:([A-Za-z0-9_-]{8}):(bn|en)$/;
const HOSPITALS_PAGE = /^hp:([A-Za-z0-9_-]{8}):(\d{1,3}):(bn|en)$/;

async function showHospitals(channels, chatId, { token, page, lang, messageId = null }, now) {
  const list = hospitalList(token, now.getTime());
  if (!list) {
    await replyPlain(channels, chatId, renderHospitalsExpired(lang));
    return { handled: true, action: 'hospitals-expired' };
  }
  const { text, buttons } = renderHospitalPage(list, page, { token, lang, nowMs: now.getTime() });
  if (messageId === null || !channels.telegram.edit) {
    await sendReport(channels, chatId, { text, buttons });
    return { handled: true, action: 'hospitals' };
  }
  try {
    await channels.telegram.edit({ to: chatId, messageId, content: { text, parseMode: 'HTML', buttons } });
  } catch {
    // A second tap on an old button asks for the page already shown ("message is not modified"); the message is already right.
  }
  return { handled: true, action: 'hospitals-page' };
}

async function handleButton(update, { channels, now, deps }) {
  const query = update.callback_query;
  const chat = query?.message?.chat;
  if (!chat || chat.type !== 'private' || typeof query.data !== 'string') return { handled: false };
  if (seen(update.update_id)) return { handled: false, duplicate: true };

  try {
    await channels.telegram.answerCallbackQuery?.(query.id);
  } catch {
    // Only the spinner on the button; the reply is what matters.
  }
  const open = HOSPITALS_OPEN.exec(query.data);
  if (open) return showHospitals(channels, String(chat.id), { token: open[1], page: 0, lang: open[2] }, now);
  const turn = HOSPITALS_PAGE.exec(query.data);
  if (turn) {
    return showHospitals(channels, String(chat.id), {
      token: turn[1], page: Number(turn[2]), lang: turn[3], messageId: query.message.message_id ?? null,
    }, now);
  }
  const trip = ROUTE_BUTTON.exec(query.data);
  if (trip) {
    return runWeatherCommand(channels, String(chat.id), {
      command: 'route', routeIds: { from: trip[1], to: trip[2] }, departure: trip[3], langOverride: trip[4], languageCode: query.from?.language_code,
    }, { now, deps });
  }
  const match = BUTTON_DATA.exec(query.data);
  if (!match || !REPORT_COMMANDS.has(match[1]) || !placeById(match[2])) return { handled: true, action: 'ignored' };
  return runWeatherCommand(channels, String(chat.id), {
    command: match[1], placeId: match[2], langOverride: match[3], languageCode: query.from?.language_code,
  }, { now, deps });
}

export async function handleTelegramUpdate(update, { channels = sharedChannels(), now = new Date(), deps = defaultDeps } = {}) {
  if (update?.callback_query) return handleButton(update, { channels, now, deps });

  const message = update?.message ?? update?.edited_message;
  // Groups and channels are ignored: alerts go to one person's private chat only.
  if (!message || message.chat?.type !== 'private' || (typeof message.text !== 'string' && !message.location)) return { handled: false };
  if (seen(update.update_id)) return { handled: false, duplicate: true };

  const chatId = String(message.chat.id);
  const reply = (text) => sendReport(channels, chatId, { text });

  if (message.location) {
    const point = message.location;
    // A Telegram update can be forged at the webhook boundary only with the webhook secret; still validate every GPS value.
    const valid = Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
      && (point.horizontal_accuracy === undefined || (Number.isFinite(point.horizontal_accuracy) && point.horizontal_accuracy <= 10_000));
    const place = valid ? placeForPoint(point.latitude, point.longitude) : null;
    if (update.edited_message) {
      const subscriber = await deps.subscriberForChat(chatId, now);
      if (!subscriber) return { handled: true, action: 'ignored' };
      const reportedAt = new Date((message.edit_date ?? message.date) * 1000);
      if (!Number.isFinite(+reportedAt)) return { handled: true, action: 'ignored' };
      if (!point.live_period) {
        await deps.refreshTelegramFollow(subscriber, { pcode: null, messageId: message.message_id, reportedAt, stopped: true }, now);
        return { handled: true, action: 'location-stopped' };
      }
      if (!place) return { handled: true, action: 'location-unmatched' };
      await deps.refreshTelegramFollow(subscriber, { pcode: place?.id ?? null, messageId: message.message_id, reportedAt,
      }, now);
      return { handled: true, action: 'location-refreshed' };
    }
    if (!place) {
      await reply('Could not match that position to a Bangladesh area (or it is too imprecise). Choose an area by name.\nবাংলাদেশের কোনো এলাকার সঙ্গে অবস্থান মেলানো যায়নি।');
      return { handled: true, action: 'location-unmatched' };
    }
    const subscriber = await deps.subscriberForChat(chatId, now);
    const reportedAt = new Date(message.date * 1000);
    if (!Number.isFinite(+reportedAt) || +reportedAt < +now - 15 * 60_000 || +reportedAt > +now + 60_000) {
      await reply('That location update is too old. Share it again.\nঅবস্থানের তথ্য পুরনো। আবার পাঠান।');
      return { handled: true, action: 'location-stale' };
    }
    let live = false;
    if (subscriber && point.live_period) {
      try {
        live = await deps.beginTelegramFollow(subscriber, { pcode: place.id, messageId: message.message_id, livePeriod: point.live_period, reportedAt }, now);
      } catch (error) {
        if (error?.status !== 409) throw error;
      }
      if (!live && subscriber.currentArea && subscriber.currentArea.source !== 'telegram' && subscriber.currentArea.expiresAt > now) {
        await reply(subscriber.language === 'bn' ? 'ওয়েব পাতায় অবস্থান অনুসরণ চলছে। Telegram-এ অনুসরণ শুরুর আগে সেখানে থামান।' : 'The web page is following your location. Stop it there before following in Telegram.');
      }
    }
    // A location sent in answer to "Which place?" answers that command (/thunderstorm, /rain...); otherwise it gets the general report.
    // In answer to /route's "Where do you start?" it is the start: the exact point goes to the road search once and is not kept.
    const question = takeQuestion(chatId, now.getTime());
    if (question?.command === 'route') {
      return runWeatherCommand(channels, chatId, {
        command: 'route', routeFromPoint: { lat: point.latitude, lon: point.longitude }, routeToId: question.routeTo, languageCode: message.from?.language_code,
      }, { now, deps });
    }
    const command = question?.command ?? 'update';
    return runWeatherCommand(channels, chatId, {
      command, placeId: place.id, sharedPlace: live ? 'live' : 'once', languageCode: message.from?.language_code,
      sharedPoint: command === 'flood_safety' ? { lat: point.latitude, lon: point.longitude } : null,
    }, { now, deps });
  }
  if (update.edited_message) return { handled: true, action: 'ignored' };

  const [first = '', ...rest] = message.text.trim().split(/\s+/);
  const command = first.split('@')[0].toLowerCase();

  if (command === '/start' && rest[0]) {
    const result = await consumeTelegramLink(rest[0], chatId, now);
    await reply(result.ok ? say('linked', result.language) : say('invalid', null));
    return { handled: true, action: result.ok ? 'linked' : 'invalid' };
  }

  if (command === '/stop') {
    const subscriber = await deps.subscriberForChat(chatId, now);
    if (subscriber) await deps.stopTelegramFollow?.(subscriber, now);
    const result = await unlinkTelegramChat(chatId);
    await reply(result.count ? say('stopped', result.language) : say('nothing', null));
    return { handled: true, action: 'stopped' };
  }

  if (command === '/follow' || command === '/unfollow') {
    if (command === '/follow') {
      const verdict = limiter.hit(chatId, +now);
      if (!verdict.allowed) {
        if (verdict.announce) await replyPlain(channels, chatId, renderBusy(resolveLanguage({ languageCode: message.from?.language_code })));
        return { handled: true, action: 'rate-limited' };
      }
    }
    const subscriber = await deps.subscriberForChat(chatId, now);
    if (!subscriber) {
      await reply(say('nothing', null));
      return { handled: true, action: 'not-linked' };
    }
    if (command === '/unfollow') {
      await deps.stopTelegramFollow(subscriber, now);
      await reply(subscriber.language === 'bn' ? 'অবস্থান অনুসরণ বন্ধ হয়েছে। সংরক্ষিত এলাকার সতর্কবার্তা চালু থাকবে।' : 'Location following stopped. Saved-area alerts remain on.');
      return { handled: true, action: 'unfollowed' };
    }
    if (!(await deps.requestTelegramFollow(subscriber, now))) {
      await reply(subscriber.language === 'bn' ? 'ওয়েব পাতায় অবস্থান অনুসরণ চলছে। Telegram-এ অনুসরণ শুরুর আগে সেখানে থামান।' : 'The web page is following your location. Stop it there before following in Telegram.');
      return { handled: true, action: 'follow-conflict' };
    }
    await reply(subscriber.language === 'bn'
      ? 'পরবর্তী ৫ মিনিটের মধ্যে Telegram-এর 📎 Location → Share Live Location বেছে নিন। শুধু এলাকা কোড ১৫ মিনিটের জন্য রাখা হয়; স্থানাঙ্ক রাখা হয় না। লাইভ শেয়ারিং বন্ধ হলে এলাকা নিজে মেয়াদোত্তীর্ণ হবে। থামাতে /unfollow।'
      : 'Within 5 minutes, use Telegram 📎 Location → Share Live Location. Only an area code is kept for 15 minutes after each update; coordinates are discarded. Sharing stops updating when Telegram ends it. Send /unfollow to stop.');
    return { handled: true, action: 'follow-requested' };
  }

  const name = canonicalCommand(command);
  if (name) return runWeatherCommand(channels, chatId, { command: name, rest, languageCode: message.from?.language_code }, { now, deps });

  // A plain message right after the bot asked "Which place?" is the place (for /route: the missing end, or a whole trip).
  const question = first.startsWith('/') ? null : takeQuestion(chatId, now.getTime());
  if (question) {
    return runWeatherCommand(channels, chatId, {
      command: question.command, rest: [first, ...rest], ...pendingRoute(question), languageCode: message.from?.language_code,
    }, { now, deps });
  }

  // An unrecognized slash command should not dump the entire help manual.
  if (first.startsWith('/') && command !== '/help') {
    const lang = await deps.telegramLanguage(chatId);
    await reply(
      lang === 'bn'
        ? 'কমান্ডটি পাওয়া যায়নি। সব কমান্ড দেখতে /help লিখুন।'
        : 'Command not recognized. Send /help to see all commands.'
    );
    return { handled: true, action: 'help' };
  }

  await reply(renderHelp(await deps.telegramLanguage(chatId)));
  return { handled: true, action: 'help' };
}

// ---------- receiving updates ----------

const OFFSET_KEY = 'telegram-bot';
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function loadOffset() {
  const row = await JobState.findOne({ key: OFFSET_KEY }).lean();
  return Number(row?.detail?.offset) || 0;
}

const saveOffset = (offset) => JobState.updateOne({ key: OFFSET_KEY }, { $set: { detail: { offset }, lastCompletedAt: new Date(), lastStatus: 'ok' } }, { upsert: true });

// The "/" list in the chat: English for everyone, Bangla for people whose Telegram is set to Bangla. A failure only costs the menu.
async function registerMenu(telegram, log) {
  if (!telegram.setCommands) return;
  try {
    await telegram.setCommands(commandMenu('en'));
    await telegram.setCommands(commandMenu('bn'), 'bn');
    log.log('[telegram] command menu registered');
  } catch (error) {
    log.error(`[telegram] could not register the command menu: ${error.message}`);
  }
}

// Starts receiving updates: by webhook when TELEGRAM_WEBHOOK_URL (and a valid secret) are set, otherwise by long polling, which needs no
// public address and is what local development uses. Returns { stop() }, or null when Telegram is not configured.
export function startTelegramBot({ channels = sharedChannels(), log = console } = {}) {
  const telegram = channels.telegram;
  if (!telegram.available) return null;

  const controller = new AbortController();
  const webhook = env.channels.telegram.webhookUrl && env.channels.telegram.webhookSecret;
  if (env.channels.telegram.webhookUrl && !env.channels.telegram.webhookSecret) {
    log.error('[telegram] TELEGRAM_WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is missing or invalid (16-256 characters of A-Z a-z 0-9 _ -). Falling back to polling.');
  }

  async function run() {
    // The place list and the hospital file are read once, at start, so the first /route does not wait for them.
    try {
      routePlaceById('');
      hospitalsInternals.loadDataset();
    } catch {
      // A broken hospital file is reported by /route itself ("hospital search is unavailable").
    }
    try {
      await telegram.getUsername();
      await registerMenu(telegram, log);
      if (webhook) {
        await telegram.setWebhook(env.channels.telegram.webhookUrl, env.channels.telegram.webhookSecret);
        log.log('[telegram] webhook registered');
        return;
      }
      await telegram.deleteWebhook();
    } catch (error) {
      log.error(`[telegram] setup failed: ${error.message}`);
      if (webhook) return;
    }

    log.log('[telegram] polling for updates');
    let offset = await loadOffset().catch(() => 0);
    while (!controller.signal.aborted) {
      try {
        const updates = await telegram.getUpdates(offset, 25, controller.signal);
        for (const update of updates) {
          try {
            await handleTelegramUpdate(update, { channels });
          } catch (error) {
            log.error(`[telegram] could not handle an update: ${error.message}`);
          }
          offset = Math.max(offset, update.update_id + 1);
        }
        if (updates.length) await saveOffset(offset).catch(() => {});
      } catch (error) {
        if (controller.signal.aborted) return;
        log.error(`[telegram] ${error.message}`);
        await sleep(error.kind === 'auth' ? 5 * 60_000 : 10_000, controller.signal);
      }
    }
  }

  run().catch((error) => log.error(`[telegram] ${error.message}`));
  return { stop: () => controller.abort() };
}
