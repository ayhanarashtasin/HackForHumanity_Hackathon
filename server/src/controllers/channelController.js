import { PHONE_CHANNELS } from '../config/alertConstants.js';
import { env } from '../config/env.js';
import { safeEqual } from '../services/alerts/tokens.js';
import { sharedChannels } from '../services/delivery/channels/index.js';
import {
  assertChannel, channelOverview, createTelegramLink, removeChannel, startPhoneVerification, verifyPhone,
} from '../services/delivery/linking.js';
import { handleTelegramUpdate } from '../services/delivery/telegramBot.js';
import { Subscriber } from '../models/Subscriber.js';

// The subscriber's side of connecting Telegram, WhatsApp or SMS. Same rules as the rest of /api/alerts: the device cookie identifies the
// profile, and none of these handlers can trigger a weather-provider request. (Sending a verification code or building a Telegram link
// is a message to the person's own channel, started by their own click.)
const fresh = (subscriber) => Subscriber.findById(subscriber._id).lean();

export async function getChannels(req, res) {
  res.json({ data: channelOverview(req.subscriber, sharedChannels()) });
}

export async function linkTelegram(req, res) {
  const link = await createTelegramLink(req.subscriber, sharedChannels());
  res.json({ data: link });
}

export async function startVerification(req, res) {
  const name = req.params.channel;
  assertChannel(name, PHONE_CHANNELS);
  const { phone, consent, lang } = req.body ?? {};
  const pending = await startPhoneVerification(req.subscriber, name, { phone, consent, lang }, { channels: sharedChannels() });
  res.json({ data: { pending } });
}

export async function verifyChannel(req, res) {
  const name = req.params.channel;
  assertChannel(name, PHONE_CHANNELS);
  await verifyPhone(req.subscriber, name, req.body?.code);
  res.json({ data: channelOverview(await fresh(req.subscriber), sharedChannels()) });
}

export async function unlinkChannel(req, res) {
  await removeChannel(req.subscriber, req.params.channel);
  res.json({ data: channelOverview(await fresh(req.subscriber), sharedChannels()) });
}

// Telegram posts updates here when the webhook is registered. The secret header proves the request came from Telegram; without a configured
// secret the endpoint does not exist. Always answers 200 for an authentic update, so a bug cannot trigger a retry storm.
export async function telegramWebhook(req, res) {
  const expected = env.channels.telegram.webhookSecret;
  const given = req.get('x-telegram-bot-api-secret-token');
  if (!expected || !given || !safeEqual(given, expected)) return res.status(404).json({ message: 'API route not found.' });

  try {
    await handleTelegramUpdate(req.body);
  } catch (error) {
    console.error(`[telegram] could not handle an update: ${error?.name ?? 'error'}`);
  }
  return res.json({ ok: true });
}
