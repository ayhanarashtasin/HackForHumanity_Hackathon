import { randomInt } from 'node:crypto';
import { DELIVERY_CHANNELS, PHONE_CHANNELS } from '../../config/alertConstants.js';
import { env } from '../../config/env.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { Subscriber } from '../../models/Subscriber.js';
import { HttpError, badRequest, serviceUnavailable } from '../alerts/errors.js';
import { hashToken, newToken } from '../alerts/tokens.js';
import { maskPhone, normalizeBdMobile } from './phone.js';
import { unlinkChannel } from './queue.js';
import { encrypt, hmac } from './secretBox.js';

// Connecting a channel to an anonymous profile. There are no accounts, so ownership is proved in the channel itself:
//   Telegram       the browser asks for a one-time link; opening it in Telegram sends `/start <code>` to the bot, which learns the chat id;
//   WhatsApp, SMS  the person enters a Bangladeshi mobile number, ticks a consent box, and types the six-digit code sent to that number.
// Nothing is ever sent to a number that has not been verified, and the code can be tried only a few times.
export const CHANNEL_CONSENT_VERSION = 'ch-1';
export const LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', sms: 'SMS' };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LINK_TTL_MS = 15 * MINUTE;
const OTP_TTL_MS = 10 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_MS = MINUTE;
const OTP_PER_HOUR = 5;

// Per number across every profile: a stranger cannot make the app text one victim's phone over and over.
const numberLimiter = createRateLimiter({ windowMs: HOUR, max: 3 });

export function resetLinkLimits() {
  numberLimiter.clear();
}

export function assertChannel(name, allowed = DELIVERY_CHANNELS) {
  if (!allowed.includes(name)) throw badRequest('Unknown channel.');
}

function requireAvailable(channels, name) {
  if (!channels[name]?.available) throw serviceUnavailable(`${LABELS[name]} alerts are not set up on this server yet.`);
}

// What the page shows for each channel. Never includes a chat id, a full phone number or any code.
export function channelOverview(subscriber, channels, now = new Date()) {
  const overview = {};
  for (const name of DELIVERY_CHANNELS) {
    const state = subscriber.channels?.[name];
    const entry = { available: Boolean(channels[name]?.available), linked: false, minSeverity: env.channels.minSeverity[name] };

    if (name === 'telegram') {
      entry.linked = Boolean(state?.chatId);
      entry.linkedAt = state?.linkedAt ?? null;
      entry.botUsername = channels.telegram.peekUsername?.() ?? null;
      entry.linkPending = Boolean(state?.linkExpiresAt && state.linkExpiresAt > now);
    } else {
      entry.linked = Boolean(state?.verifiedAt && state?.phoneEnc);
      entry.phoneMask = entry.linked ? (state.phoneMask ?? null) : null;
      entry.verifiedAt = state?.verifiedAt ?? null;
      const pending = state?.pending;
      entry.pending = pending?.otpExpiresAt && pending.otpExpiresAt > now ? { phoneMask: pending.phoneMask, expiresAt: pending.otpExpiresAt } : null;
    }
    overview[name] = entry;
  }
  return overview;
}

// ---------- Telegram ----------

export async function createTelegramLink(subscriber, channels, now = new Date()) {
  requireAvailable(channels, 'telegram');
  const username = await channels.telegram.getUsername().catch(() => null);
  if (!username) throw serviceUnavailable('Telegram cannot be reached right now. Please try again in a moment.');

  const code = newToken();
  const expiresAt = new Date(+now + LINK_TTL_MS);
  await Subscriber.updateOne(
    { _id: subscriber._id },
    { $set: { 'channels.telegram.linkCodeHash': hashToken(code), 'channels.telegram.linkExpiresAt': expiresAt } },
  );
  return { url: `https://t.me/${username}?start=${code}`, botUsername: username, expiresAt };
}

// The bot received `/start <code>` from a private chat. One chat belongs to one profile: linking it here frees it from any other.
export async function consumeTelegramLink(code, chatId, now = new Date()) {
  if (typeof code !== 'string' || code.length < 20 || code.length > 100) return { ok: false };
  const subscriber = await Subscriber.findOne({
    'channels.telegram.linkCodeHash': hashToken(code),
    'channels.telegram.linkExpiresAt': { $gt: now },
    expiresAt: { $gt: now },
  }, { language: 1 }).lean();
  if (!subscriber) return { ok: false };

  const chat = String(chatId);
  const others = await Subscriber.find({ _id: { $ne: subscriber._id }, 'channels.telegram.chatId': chat }, { _id: 1 }).lean();
  for (const other of others) await unlinkChannel(other._id, 'telegram', 'chat_moved');

  // Replacing the whole sub-document also removes the one-time code.
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: { 'channels.telegram': { chatId: chat, linkedAt: now } } });
  return { ok: true, language: subscriber.language };
}

// `/stop` in the chat: every profile linked to that chat stops receiving messages there.
export async function unlinkTelegramChat(chatId) {
  const chat = String(chatId);
  const linked = await Subscriber.find({ 'channels.telegram.chatId': chat }, { _id: 1, language: 1 }).lean();
  for (const subscriber of linked) await unlinkChannel(subscriber._id, 'telegram', 'stopped_in_chat');
  return { count: linked.length, language: linked[0]?.language ?? null };
}

export async function telegramLanguage(chatId) {
  const subscriber = await Subscriber.findOne({ 'channels.telegram.chatId': String(chatId) }, { language: 1 }).lean();
  return subscriber?.language ?? null;
}

// ---------- WhatsApp and SMS ----------

const otpHash = (subscriberId, code) => hmac(`otp:${subscriberId}:${code}`);

export async function startPhoneVerification(subscriber, name, { phone, consent, lang } = {}, { channels, now = new Date(), makeCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0') } = {}) {
  assertChannel(name, PHONE_CHANNELS);
  requireAvailable(channels, name);
  if (consent !== true) throw badRequest('Please confirm that you agree to receive alerts at this number.', { consent: 'required' });

  const e164 = normalizeBdMobile(phone);
  if (!e164) throw badRequest('Enter a Bangladeshi mobile number, for example 01712 345678.', { phone: 'invalid' });

  const state = subscriber.channels?.[name] ?? {};
  const sentAt = state.pending?.otpSentAt;
  if (sentAt && +now - +sentAt < OTP_COOLDOWN_MS) throw new HttpError(429, 'Please wait a minute before asking for another code.');

  const windowOpen = state.otpWindowStart && +now - +state.otpWindowStart < HOUR;
  const requests = windowOpen ? (state.otpWindowCount ?? 0) : 0;
  if (requests >= OTP_PER_HOUR) throw new HttpError(429, 'Too many codes were requested. Please try again in an hour.');
  if (!numberLimiter.attempt(`${name}:${hmac(e164)}`).allowed) throw new HttpError(429, 'Too many codes were sent to this number. Please try again later.');

  const code = makeCode();
  const pending = {
    phoneEnc: encrypt(e164),
    phoneMask: maskPhone(e164),
    consentAt: now,
    otpHash: otpHash(subscriber._id, code),
    otpExpiresAt: new Date(+now + OTP_TTL_MS),
    otpAttempts: 0,
    otpSentAt: now,
  };
  await Subscriber.updateOne(
    { _id: subscriber._id },
    { $set: {
      [`channels.${name}.pending`]: pending,
      [`channels.${name}.otpWindowStart`]: windowOpen ? state.otpWindowStart : now,
      [`channels.${name}.otpWindowCount`]: requests + 1,
    } },
  );

  try {
    await channels[name].sendCode({ to: e164, code, lang: lang === 'bn' || subscriber.language === 'bn' ? 'bn' : 'en' });
  } catch (error) {
    // The code was never delivered: forget it so the person is not left waiting on one that cannot arrive.
    await Subscriber.updateOne({ _id: subscriber._id }, { $unset: { [`channels.${name}.pending`]: '' } });
    const unreachable = error?.kind === 'blocked' ? 'That number cannot receive messages from AkashSathi.' : `The code could not be sent by ${LABELS[name]}. Please check the number and try again later.`;
    throw error?.kind === 'blocked' ? badRequest(unreachable) : serviceUnavailable(unreachable, 502);
  }
  return { phoneMask: pending.phoneMask, expiresAt: pending.otpExpiresAt };
}

export async function verifyPhone(subscriber, name, code, { now = new Date() } = {}) {
  assertChannel(name, PHONE_CHANNELS);
  const typed = String(code ?? '').trim();
  if (!/^\d{6}$/.test(typed)) throw badRequest('Enter the six-digit code.', { code: 'invalid' });

  // The attempt is counted before it is compared, atomically, so parallel guesses cannot exceed the limit.
  const row = await Subscriber.findOneAndUpdate(
    {
      _id: subscriber._id,
      [`channels.${name}.pending.otpExpiresAt`]: { $gt: now },
      [`channels.${name}.pending.otpAttempts`]: { $lt: OTP_MAX_ATTEMPTS },
    },
    { $inc: { [`channels.${name}.pending.otpAttempts`]: 1 } },
    { returnDocument: 'after' },
  ).lean();

  if (!row) {
    const known = await Subscriber.findById(subscriber._id, { channels: 1 }).lean();
    const pending = known?.channels?.[name]?.pending;
    if (pending && pending.otpAttempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Please ask for a new code.');
    throw badRequest('That code has expired. Please ask for a new one.', { code: 'expired' });
  }

  const pending = row.channels[name].pending;
  if (otpHash(subscriber._id, typed) !== pending.otpHash) {
    const left = OTP_MAX_ATTEMPTS - pending.otpAttempts;
    throw badRequest(left > 0 ? 'That code is not right. Please check it and try again.' : 'Too many wrong codes. Please ask for a new code.', { code: 'wrong' });
  }

  await Subscriber.updateOne(
    { _id: subscriber._id },
    { $set: {
      [`channels.${name}`]: {
        phoneEnc: pending.phoneEnc,
        phoneMask: pending.phoneMask,
        verifiedAt: now,
        consentAt: pending.consentAt,
        consentVersion: CHANNEL_CONSENT_VERSION,
        otpWindowCount: 0,
      },
    } },
  );
  return { phoneMask: pending.phoneMask, verifiedAt: now };
}

export async function removeChannel(subscriber, name) {
  assertChannel(name);
  await unlinkChannel(subscriber._id, name, 'removed_by_user');
}
