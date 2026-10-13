import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { errorHandler, notFound } from '../src/middleware/errorHandler.js';
import { Delivery } from '../src/models/Delivery.js';
import { JobState } from '../src/models/JobState.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { createAlertRoutes } from '../src/routes/alertRoutes.js';
import { overview } from '../src/services/alerts/admin.js';
import { saveSnapshot } from '../src/services/alerts/snapshots.js';
import { createSubscriber, deleteSubscriber } from '../src/services/alerts/subscribers.js';
import { ChannelError } from '../src/services/delivery/errors.js';
import { resetSharedChannels, setSharedChannels } from '../src/services/delivery/channels/index.js';
import {
  consumeTelegramLink, createTelegramLink, resetLinkLimits, startPhoneVerification, unlinkTelegramChat, verifyPhone,
} from '../src/services/delivery/linking.js';
import { formatHm } from '../src/services/time.js';
import {
  deliveryStats, dispatchDue, enqueueDeliveries, linkedChannels, runDeliveryCycle,
} from '../src/services/delivery/queue.js';
import { defaultDeps } from '../src/services/delivery/botReports/data.js';
import { loadForecast } from '../src/services/delivery/botReports/readings.js';
import { decrypt, encrypt } from '../src/services/delivery/secretBox.js';
import { handleTelegramUpdate, resetBotForTests } from '../src/services/delivery/telegramBot.js';
import { forecastInputs, NOW as FORECAST_NOW } from './support/botFixtures.js';
import { BADDA } from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MODELS = [Subscriber, Notification, Delivery, JobState, WeatherSnapshot];
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SECRET = 'a-test-channel-secret-0123456789';
const PHONE = '+8801712345678';

// The clock is the real one: Mongoose stamps updatedAt itself, and the "recent enough to send" filter reads it.
let now;
const original = {};

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all(MODELS.map((model) => model.init()));
  for (const key of ['secret', 'dailyCap', 'minSeverity', 'maxAttempts', 'maxAgeMinutes']) original[key] = structuredClone(env.channels[key]);
});

beforeEach(async () => {
  if (!testUri) return;
  now = Date.now();
  await Promise.all(MODELS.map((model) => model.deleteMany({})));
  Object.assign(env.channels, structuredClone(original), { secret: SECRET });
  env.channels.minSeverity = { telegram: 'ADVISORY', whatsapp: 'WARNING', sms: 'WARNING' };
  env.channels.dailyCap = { telegram: 20, whatsapp: 6, sms: 6 };
  resetLinkLimits();
  resetBotForTests();
});

after(async () => {
  resetSharedChannels();
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- builders ----------

function stub(name, behaviour = async () => ({ providerMessageId: `${name}-1` })) {
  const sent = [];
  const channel = {
    name,
    available: true,
    sent,
    peekUsername: () => 'AkashSathiBot',
    getUsername: async () => 'AkashSathiBot',
    async send(args) {
      sent.push(args);
      return behaviour(args, sent.length);
    },
    async sendCode({ to, code, lang }) {
      sent.push({ code: true, to, codeValue: code, lang });
      return behaviour({ to, code }, sent.length);
    },
  };
  return channel;
}

const channelSet = (overrides = {}) => ({
  telegram: stub('telegram'), whatsapp: { name: 'whatsapp', available: false }, sms: stub('sms'), ...overrides,
});

const FARMER = { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' };

async function person({ telegram = true, sms = false, language = 'en', status = 'active', isDemo = false, quiet = null } = {}) {
  const { subscriber } = await createSubscriber({
    occupation: 'farmer', language, homeAreaPcode: BADDA, consent: true, occupationData: FARMER,
  }, { now: new Date(now), isDemo });
  const set = { status };
  if (telegram) set['channels.telegram'] = { chatId: String(555000 + Math.floor(Math.random() * 99999)), linkedAt: new Date(now) };
  if (sms) set['channels.sms'] = { phoneEnc: encrypt(PHONE), phoneMask: '+8801•••••678', verifiedAt: new Date(now), consentAt: new Date(now), consentVersion: 'ch-1' };
  if (quiet) set['preferences.quietHours'] = quiet;
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: set });
  return subscriber._id;
}

async function alertFor(subscriberId, overrides = {}) {
  const at = new Date(now - 5 * MINUTE);
  return Notification.create({
    subscriberId,
    hazardEventId: new mongoose.Types.ObjectId(),
    occupation: 'farmer',
    scenarioId: 'FARM-01',
    ruleVersion: 'prototype-1',
    ruleStatus: 'prototype',
    severity: 'WARNING',
    title: 'Heavy rain expected near Badda',
    message: 'Heavy rain is forecast for Badda, Dhaka this afternoon. Cover harvested crop.',
    recommendedActions: [{ key: 'cover_crop', text: 'Cover harvested crop' }],
    lang: 'en',
    affectedArea: { scope: 'upazila', upazilaPcode: BADDA, name: 'Badda', text: 'Badda, Dhaka' },
    reasonForSelection: 'You farm near Badda.',
    hazardType: 'HEAVY_RAIN',
    hazardLevel: 2,
    validFrom: new Date(now - HOUR),
    validUntil: new Date(now + 5 * HOUR),
    status: 'active',
    publishedAt: at,
    publishedBy: 'engine',
    lifecycle: [{ at, type: 'created' }],
    purgeAfter: new Date(now + 30 * 86_400_000),
    ...overrides,
  });
}

const rows = (filter = {}) => Delivery.find(filter).sort({ createdAt: 1 }).lean();

// ---------- queue ----------

dbTest('the delivery cycle queues once, sends once, and running it again does nothing', async () => {
  const id = await person();
  const alert = await alertFor(id);
  const channels = channelSet();

  const first = await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(first.queued, 1);
  assert.equal(first.sent, 1);
  assert.equal(channels.telegram.sent.length, 1);
  assert.match(channels.telegram.sent[0].content.text, /^\[WARNING\] Heavy rain expected near Badda/);

  const second = await runDeliveryCycle({ channels, nowMs: now + MINUTE });
  assert.equal(second.queued, 0);
  assert.equal(second.sent, 0);
  assert.equal(channels.telegram.sent.length, 1);

  const [row] = await rows();
  assert.equal(String(row.notificationId), String(alert._id));
  assert.equal(row.status, 'sent');
  assert.equal(row.stageKey, 'WARNING:0');
  assert.equal(row.attempts, 1);
  assert.equal(row.providerMessageId, 'telegram-1');
  assert.ok(row.sentAt);
  // Only references and outcomes are stored: no message text, no chat id.
  assert.equal(JSON.stringify(row).includes('Heavy rain'), false);
});

dbTest('a person with several channels gets one message on each, and an unavailable channel is left alone', async () => {
  const id = await person({ telegram: true, sms: true });
  await alertFor(id);
  const channels = channelSet();

  const result = await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(result.sent, 2);
  assert.equal(channels.telegram.sent.length, 1);
  assert.equal(channels.sms.sent.length, 1);
  assert.equal(channels.sms.sent[0].to, PHONE, 'the stored number is decrypted only at send time');
  assert.match(channels.sms.sent[0].content.text, /^AkashSathi WARNING: Heavy rain expected near Badda/);

  // The same person on a server where WhatsApp is not set up: nothing is queued for it.
  assert.equal((await rows({ channel: 'whatsapp' })).length, 0);
});

dbTest('an escalation or an allowed re-notification is a new stage and is sent again; a silent refresh is not', async () => {
  const id = await person();
  const alert = await alertFor(id);
  const channels = channelSet();
  await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(channels.telegram.sent.length, 1);

  // evidence changes silently: same severity, same stage
  await Notification.updateOne({ _id: alert._id }, { $set: { message: 'Heavy rain is forecast for Badda, Dhaka this evening.' } });
  await runDeliveryCycle({ channels, nowMs: now + MINUTE });
  assert.equal(channels.telegram.sent.length, 1);

  // severity rises: the engine records an 'escalated' lifecycle entry
  const later = now + 10 * MINUTE;
  await Notification.updateOne({ _id: alert._id }, {
    $set: { severity: 'CRITICAL', title: 'Lightning detected near Badda' },
    $push: { lifecycle: { at: new Date(later), type: 'escalated' } },
  });
  await runDeliveryCycle({ channels, nowMs: later });
  assert.equal(channels.telegram.sent.length, 2);
  assert.match(channels.telegram.sent[1].content.text, /^\[CRITICAL\] Lightning detected near Badda/);

  // a lightning re-notification stage
  await Notification.updateOne({ _id: alert._id }, { $set: { renotifications: 1 }, $push: { lifecycle: { at: new Date(later + MINUTE), type: 'escalated' } } });
  await runDeliveryCycle({ channels, nowMs: later + MINUTE });
  assert.equal(channels.telegram.sent.length, 3);

  // ...and the same stage again is never repeated
  await runDeliveryCycle({ channels, nowMs: later + 2 * MINUTE });
  assert.equal(channels.telegram.sent.length, 3);
  assert.deepEqual((await rows()).map((row) => row.stageKey).sort(), ['CRITICAL:0', 'CRITICAL:1', 'WARNING:0']);
});

dbTest('a stage that was superseded before it was sent is skipped: the person gets the newest one only', async () => {
  const id = await person();
  const alert = await alertFor(id);
  const channels = channelSet();

  await enqueueDeliveries({ channels, nowMs: now });
  await Notification.updateOne({ _id: alert._id }, { $set: { severity: 'CRITICAL' }, $push: { lifecycle: { at: new Date(now + MINUTE), type: 'escalated' } } });
  await enqueueDeliveries({ channels, nowMs: now + MINUTE });
  const stats = await dispatchDue({ channels, nowMs: now + MINUTE });

  assert.equal(stats.sent, 1);
  assert.equal(stats.skipped, 1);
  const byStage = Object.fromEntries((await rows()).map((row) => [row.stageKey, row]));
  assert.equal(byStage['WARNING:0'].skippedReason, 'superseded');
  assert.equal(byStage['CRITICAL:0'].status, 'sent');
  assert.equal(channels.telegram.sent.length, 1);
});

dbTest('SMS and WhatsApp start at WARNING so a free advisory never costs money, while Telegram carries advisories', async () => {
  const id = await person({ telegram: true, sms: true });
  await alertFor(id, { severity: 'ADVISORY' });
  const channels = channelSet();

  await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(channels.telegram.sent.length, 1);
  assert.equal(channels.sms.sent.length, 0);
  assert.equal((await rows({ channel: 'sms' })).length, 0);

  env.channels.minSeverity.sms = 'ADVISORY';
  await runDeliveryCycle({ channels, nowMs: now + MINUTE });
  assert.equal(channels.sms.sent.length, 1, 'the operator can lower it');
});

dbTest('demo profiles, paused profiles, stale data, finished alerts and old alerts are never sent', async () => {
  const channels = channelSet();

  const demo = await person({ isDemo: true });
  await alertFor(demo);

  const paused = await person({ status: 'paused' });
  await alertFor(paused);

  const stale = await person();
  await alertFor(stale, { dataStatus: 'STALE' });
  const unavailable = await person();
  await alertFor(unavailable, { dataStatus: 'UNAVAILABLE' });

  const withdrawn = await person();
  await alertFor(withdrawn, { status: 'withdrawn' });
  const expired = await person();
  await alertFor(expired, { status: 'active', validUntil: new Date(now - MINUTE) });
  const draft = await person();
  await alertFor(draft, { status: 'draft', publishedAt: null });

  const old = await person();
  const longAgo = new Date(now - 6 * HOUR);
  await alertFor(old, { publishedAt: longAgo, lifecycle: [{ at: longAgo, type: 'created' }] });
  await Notification.collection.updateOne({ subscriberId: old }, { $set: { updatedAt: longAgo } });

  const result = await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(result.queued, 0);
  assert.equal(channels.telegram.sent.length, 0);
});

dbTest('a message that became invalid while it waited is dropped at send time, with a reason', async () => {
  const id = await person();
  const alert = await alertFor(id);
  const channels = channelSet();
  await enqueueDeliveries({ channels, nowMs: now });

  await Notification.updateOne({ _id: alert._id }, { $set: { status: 'withdrawn' } });
  const stats = await dispatchDue({ channels, nowMs: now });
  assert.equal(stats.sent, 0);
  assert.equal((await rows())[0].skippedReason, 'no_longer_active');

  // paused after queueing
  const other = await person();
  await alertFor(other);
  await enqueueDeliveries({ channels, nowMs: now });
  await Subscriber.updateOne({ _id: other }, { $set: { status: 'paused' } });
  await dispatchDue({ channels, nowMs: now });
  assert.ok((await rows({ subscriberId: other })).every((row) => row.skippedReason === 'subscriber_paused'));

  // unlinked after queueing
  const third = await person();
  await alertFor(third);
  await enqueueDeliveries({ channels, nowMs: now });
  await Subscriber.updateOne({ _id: third }, { $unset: { 'channels.telegram': '' } });
  await dispatchDue({ channels, nowMs: now });
  assert.ok((await rows({ subscriberId: third })).every((row) => row.skippedReason === 'channel_unlinked'));
});

dbTest('quiet hours hold non-urgent messages until they end, expire them if the alert ends first, and never delay CRITICAL (CTX-04)', async () => {
  const quiet = { enabled: true, start: formatHm(new Date(now - HOUR)), end: formatHm(new Date(now + HOUR)) };
  const channels = channelSet();

  const sleeper = await person({ quiet });
  await alertFor(sleeper, { severity: 'WARNING', validUntil: new Date(now + 6 * HOUR) });
  await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(channels.telegram.sent.length, 0);
  const [held] = await rows({ subscriberId: sleeper });
  assert.equal(held.status, 'pending');
  assert.ok(Math.abs(+held.nextAttemptAt - (now + HOUR)) < 2 * MINUTE, 'resumes when quiet hours end');
  assert.equal(held.attempts, 0, 'waiting is not a failed attempt');

  // once quiet hours are over the message goes out
  await runDeliveryCycle({ channels, nowMs: now + HOUR + MINUTE });
  assert.equal(channels.telegram.sent.length, 1);

  // an alert that ends before quiet hours do is not sent late
  const brief = await person({ quiet });
  await alertFor(brief, { severity: 'ADVISORY', validUntil: new Date(now + 30 * MINUTE) });
  await dispatchDue({ channels, nowMs: now }).then(() => enqueueDeliveries({ channels, nowMs: now })).then(() => dispatchDue({ channels, nowMs: now }));
  assert.equal((await rows({ subscriberId: brief }))[0].skippedReason, 'expired_in_quiet_hours');

  // lightning is critical: it goes out in the middle of the night
  const urgent = await person({ quiet });
  await alertFor(urgent, { severity: 'CRITICAL', title: 'Lightning detected near Badda' });
  const before = channels.telegram.sent.length;
  await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(channels.telegram.sent.length, before + 1);
});

dbTest('the daily cap limits routine messages per person and channel, but never a CRITICAL alert', async () => {
  env.channels.dailyCap.telegram = 2;
  const id = await person();
  for (let i = 0; i < 3; i += 1) await alertFor(id, { scenarioId: `FARM-0${i + 1}`, severity: 'ADVISORY' });
  const channels = channelSet();

  await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(channels.telegram.sent.length, 2);
  assert.equal((await rows({ status: 'skipped' }))[0].skippedReason, 'daily_cap');

  await alertFor(id, { scenarioId: 'CONS-01', severity: 'CRITICAL' });
  await runDeliveryCycle({ channels, nowMs: now + MINUTE });
  assert.equal(channels.telegram.sent.length, 3);
});

dbTest('a temporary failure is retried with back-off, then given up, and the attempts are counted', async () => {
  env.channels.maxAttempts = 3;
  const id = await person();
  await alertFor(id);
  const channels = channelSet({ telegram: stub('telegram', async () => { throw new ChannelError('retry', 'Telegram is unavailable (HTTP 502).'); }) });

  await runDeliveryCycle({ channels, nowMs: now });
  let [row] = await rows();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(+row.nextAttemptAt, now + MINUTE, 'first retry after a minute');
  assert.equal(row.errorClass, 'retry');

  await dispatchDue({ channels, nowMs: now + 30_000 });
  assert.equal(channels.telegram.sent.length, 1, 'not retried before it is due');

  await dispatchDue({ channels, nowMs: now + MINUTE });
  [row] = await rows();
  assert.equal(row.attempts, 2);
  assert.equal(+row.nextAttemptAt, now + MINUTE + 5 * MINUTE, 'then five minutes');

  await dispatchDue({ channels, nowMs: now + 6 * MINUTE });
  [row] = await rows();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  assert.match(row.lastError, /unavailable/);
  assert.equal(channels.telegram.sent.length, 3);
});

dbTest('the provider\'s own retry-after is honoured, and a retry is never scheduled past the end of the alert', async () => {
  const id = await person();
  await alertFor(id, { validUntil: new Date(now + 3 * MINUTE) });
  const channels = channelSet({ telegram: stub('telegram', async () => { throw new ChannelError('retry', 'slow down', { retryAfterMs: 10 * MINUTE }); }) });

  await runDeliveryCycle({ channels, nowMs: now });
  const [row] = await rows();
  assert.equal(row.status, 'failed', 'a retry in 10 minutes would arrive after the 3-minute alert ended');
});

dbTest('a chat that blocked the bot is unlinked and its waiting messages are dropped', async () => {
  const id = await person({ sms: true });
  await alertFor(id, { scenarioId: 'FARM-01' });
  await alertFor(id, { scenarioId: 'FARM-02' });
  const channels = channelSet({ telegram: stub('telegram', async () => { throw new ChannelError('blocked', 'This chat cannot receive messages from the bot.'); }) });

  const stats = await runDeliveryCycle({ channels, nowMs: now, concurrency: 1 });
  assert.equal(stats.failed, 1);

  const profile = await Subscriber.findById(id).lean();
  assert.equal(profile.channels.telegram, undefined, 'Telegram is unlinked');
  assert.ok(profile.channels.sms.verifiedAt, 'the other channel is untouched');
  const telegramRows = await rows({ channel: 'telegram' });
  assert.deepEqual(telegramRows.map((row) => row.status).sort(), ['failed', 'skipped']);
  assert.equal(channels.telegram.sent.length, 1, 'it stopped trying');
  assert.equal(channels.sms.sent.length, 2);
});

dbTest('rejected credentials pause the channel without failing anyone\'s alerts', async () => {
  const first = await person();
  const second = await person();
  await alertFor(first);
  await alertFor(second);
  const channels = channelSet({ telegram: stub('telegram', async () => { throw new ChannelError('auth', 'Telegram rejected the bot token.'); }) });

  const stats = await runDeliveryCycle({ channels, nowMs: now, concurrency: 1 });
  assert.equal(stats.failed, 0);
  assert.equal(channels.telegram.sent.length, 1, 'one attempt, then the channel is halted for this cycle');
  const all = await rows();
  assert.ok(all.every((row) => row.status === 'pending'));
  assert.ok(all.every((row) => +row.nextAttemptAt >= now + 9 * MINUTE), 'checked again in ten minutes, when the operator may have fixed it');
});

dbTest('the most urgent messages are sent first', async () => {
  const id = await person();
  await alertFor(id, { scenarioId: 'FARM-01', severity: 'ADVISORY' });
  await alertFor(id, { scenarioId: 'CONS-01', severity: 'CRITICAL', title: 'Lightning' });
  await alertFor(id, { scenarioId: 'FARM-02', severity: 'WARNING' });
  const channels = channelSet();

  await runDeliveryCycle({ channels, nowMs: now, concurrency: 1 });
  assert.deepEqual(channels.telegram.sent.map((call) => call.content.text.match(/^\[(\w+)\]/)[1]), ['CRITICAL', 'WARNING', 'ADVISORY']);
});

dbTest('a number that can no longer be decrypted (the secret changed) is skipped, not sent in the clear or retried forever', async () => {
  const id = await person({ telegram: false, sms: true });
  await alertFor(id);
  env.channels.secret = 'a-completely-different-secret-9876';
  const channels = channelSet();

  const stats = await runDeliveryCycle({ channels, nowMs: now });
  assert.equal(stats.sent, 0);
  assert.equal((await rows())[0].skippedReason, 'unreadable_number');
});

dbTest('a worker that died mid-send leaves a lease that expires and the message is picked up again', async () => {
  const id = await person();
  const alert = await alertFor(id);
  const channels = channelSet();
  await enqueueDeliveries({ channels, nowMs: now });
  await Delivery.updateOne({ notificationId: alert._id }, { $set: { status: 'sending', leaseUntil: new Date(now + MINUTE) } });

  assert.equal((await dispatchDue({ channels, nowMs: now })).sent, 0, 'still leased');
  assert.equal((await dispatchDue({ channels, nowMs: now + 3 * MINUTE })).sent, 1);
});

dbTest('the administrator\'s counts show what went out, what waits and why messages were not sent', async () => {
  const id = await person();
  await alertFor(id);
  const sleeper = await person({ quiet: { enabled: true, start: formatHm(new Date(now - HOUR)), end: formatHm(new Date(now + HOUR)) } });
  await alertFor(sleeper);
  const withdrawn = await person();
  const gone = await alertFor(withdrawn);
  const channels = channelSet();
  await enqueueDeliveries({ channels, nowMs: now });
  await Notification.updateOne({ _id: gone._id }, { $set: { status: 'withdrawn' } });
  await dispatchDue({ channels, nowMs: now });

  const stats = await deliveryStats({ hours: 24, nowMs: now });
  assert.equal(stats.byChannel.telegram.sent, 1);
  assert.equal(stats.byChannel.telegram.pending, 1);
  assert.equal(stats.byChannel.telegram.skipped, 1);
  assert.deepEqual(stats.byChannel.telegram.reasons, [{ reason: 'no_longer_active', count: 1 }]);
  assert.equal(stats.byChannel.sms.sent, 0);
});

dbTest('deleting a profile removes its delivery log with it', async () => {
  const id = await person();
  await alertFor(id);
  await runDeliveryCycle({ channels: channelSet(), nowMs: now });
  assert.equal(await Delivery.countDocuments(), 1);

  await deleteSubscriber(await Subscriber.findById(id).lean());
  assert.equal(await Delivery.countDocuments(), 0);
  assert.equal(await Notification.countDocuments(), 0);
});

dbTest('only a verified phone number or a linked chat counts as a channel', async () => {
  const id = await person({ telegram: false });
  await Subscriber.updateOne({ _id: id }, { $set: {
    'channels.sms.pending': { phoneEnc: encrypt(PHONE), phoneMask: 'x', otpHash: 'h', otpExpiresAt: new Date(now + HOUR), otpAttempts: 0 },
    'channels.telegram.linkCodeHash': 'abc',
  } });
  assert.deepEqual(linkedChannels(await Subscriber.findById(id).lean()), {}, 'a pending number and an unused link code deliver nothing');
});

// ---------- linking ----------

dbTest('Telegram: a one-time link connects one chat, expires, and cannot be reused', async () => {
  const id = await person({ telegram: false });
  const channels = channelSet();
  const { url, expiresAt } = await createTelegramLink(await Subscriber.findById(id).lean(), channels, new Date(now));
  assert.match(url, /^https:\/\/t\.me\/AkashSathiBot\?start=[A-Za-z0-9_-]{43}$/);
  assert.equal(+expiresAt, now + 15 * MINUTE);

  const code = url.split('start=')[1];
  const stored = await Subscriber.findById(id).lean();
  assert.equal(JSON.stringify(stored).includes(code), false, 'only a hash of the code is stored');

  assert.equal((await consumeTelegramLink('x'.repeat(43), '999', new Date(now))).ok, false);
  assert.equal((await consumeTelegramLink(code, '999', new Date(now + 16 * MINUTE))).ok, false, 'expired');
  assert.equal((await consumeTelegramLink(code, '999', new Date(now + MINUTE))).ok, true);
  assert.equal((await consumeTelegramLink(code, '999', new Date(now + MINUTE))).ok, false, 'single use');

  const linked = await Subscriber.findById(id).lean();
  assert.equal(linked.channels.telegram.chatId, '999');
  assert.equal(linked.channels.telegram.linkCodeHash, undefined);
});

dbTest('Telegram: one chat belongs to one profile, and linking it again frees the earlier profile', async () => {
  const channels = channelSet();
  const first = await person({ telegram: false });
  const second = await person({ telegram: false });
  const link = async (id) => (await createTelegramLink(await Subscriber.findById(id).lean(), channels, new Date(now))).url.split('start=')[1];

  await consumeTelegramLink(await link(first), '777', new Date(now));
  await alertFor(first);
  await enqueueDeliveries({ channels, nowMs: now });
  await consumeTelegramLink(await link(second), '777', new Date(now));

  assert.equal((await Subscriber.findById(first).lean()).channels?.telegram, undefined);
  assert.equal((await Subscriber.findById(second).lean()).channels.telegram.chatId, '777');
  assert.ok((await rows({ subscriberId: first })).every((row) => row.status === 'skipped'), 'the old profile\'s waiting messages are dropped');
});

dbTest('the bot: /start with a code connects the chat, /stop disconnects it, anything else gets help, groups are ignored', async () => {
  const id = await person({ telegram: false, language: 'bn' });
  const channels = channelSet();
  const code = (await createTelegramLink(await Subscriber.findById(id).lean(), channels, new Date(now))).url.split('start=')[1];
  const message = (text, chat = { id: 4242, type: 'private' }, updateId) => ({ update_id: updateId, message: { chat, text } });

  assert.deepEqual(await handleTelegramUpdate(message('/start nonsense-code-0000000000000', undefined, 1), { channels }), { handled: true, action: 'invalid' });
  assert.match(channels.telegram.sent.at(-1).content.text, /This link has expired/);
  assert.match(channels.telegram.sent.at(-1).content.text, /এই লিংকের মেয়াদ/, 'before a chat is linked the reply is in both languages');

  assert.deepEqual(await handleTelegramUpdate(message(`/start ${code}`, undefined, 2), { channels }), { handled: true, action: 'linked' });
  assert.match(channels.telegram.sent.at(-1).content.text, /সংযুক্ত হয়েছে/, 'then in the profile\'s language');
  assert.equal(channels.telegram.sent.at(-1).content.parseMode, 'HTML');
  assert.doesNotMatch(channels.telegram.sent.at(-1).content.text, /পরীক্ষামূলক|সরকারি সতর্কীকরণ/);
  assert.equal(channels.telegram.sent.at(-1).to, '4242');
  assert.equal((await Subscriber.findById(id).lean()).channels.telegram.chatId, '4242');

  // Telegram delivering the same update twice must not produce a second (error) reply
  const count = channels.telegram.sent.length;
  assert.equal((await handleTelegramUpdate(message(`/start ${code}`, undefined, 2), { channels })).duplicate, true);
  assert.equal(channels.telegram.sent.length, count);

  assert.equal((await handleTelegramUpdate(message('hello'), { channels })).action, 'help');
  assert.equal((await handleTelegramUpdate(message('/start@AkashSathiBot'), { channels })).action, 'help');
  assert.deepEqual(await handleTelegramUpdate(message('/start x', { id: -100, type: 'group' }), { channels }), { handled: false });
  assert.deepEqual(await handleTelegramUpdate({ update_id: 9 }, { channels }), { handled: false });

  assert.equal((await handleTelegramUpdate(message('/stop'), { channels })).action, 'stopped');
  assert.equal((await Subscriber.findById(id).lean()).channels?.telegram, undefined);
  assert.match(channels.telegram.sent.at(-1).content.text, /বন্ধ করা হয়েছে/);

  await handleTelegramUpdate(message('/stop'), { channels });
  assert.match(channels.telegram.sent.at(-1).content.text, /No AkashSathi alert profile was connected/);
  assert.equal((await unlinkTelegramChat('4242')).count, 0);
});

dbTest('the weather commands for a connected chat use its saved area and active alerts, and none of its answers appear', async () => {
  const id = await person({ telegram: false, language: 'bn' });
  const channels = channelSet();
  const code = (await createTelegramLink(await Subscriber.findById(id).lean(), channels, new Date(now))).url.split('start=')[1];
  await handleTelegramUpdate({ update_id: 1, message: { chat: { id: 4242, type: 'private' }, text: `/start ${code}` } }, { channels });

  await alertFor(id);
  await alertFor(id, { title: 'An old notice', status: 'withdrawn' });
  await alertFor(id, { title: 'Expired notice', validUntil: new Date(now - HOUR) });
  const inputs = forecastInputs();
  const deps = { ...defaultDeps, loadForecast: () => loadForecast({ ...inputs, now: FORECAST_NOW }) };
  const ask = async (text, updateId, language) => {
    const next = channels.telegram.sent.length;
    await handleTelegramUpdate({ update_id: updateId, message: { chat: { id: 4242, type: 'private' }, text, from: { language_code: language } } }, { channels, deps, now: new Date(now) });
    return channels.telegram.sent[next].content;
  };

  const update = await ask('/update', 10);
  assert.equal(update.parseMode, 'HTML');
  assert.match(update.text, /বাড্ডা/, 'the saved area, in the profile language');
  assert.match(update.text, /১টি সক্রিয় সতর্কবার্তা/, 'one active alert (not the withdrawn or the expired one)');
  assert.ok(update.buttons.flat().every((button) => button.data.endsWith(':bn')));
  for (const word of ['farmer', 'rice', 'harvest', 'cropStage', 'workload', 'pump']) assert.ok(!update.text.toLowerCase().includes(word), word);

  const alerts = await ask('/alerts', 11);
  assert.match(alerts.text, /<b>সতর্কতা<\/b> · Heavy rain expected near Badda\nমেয়াদ:/);
  assert.ok(!/An old notice|Expired notice/.test(alerts.text));
  assert.ok(!/Cover harvested crop|You farm|farm/i.test(alerts.text), 'the title and time only, never the reason or the advice');

  assert.match((await ask('/heat', 12)).text, /বাড্ডা/);
  assert.match((await ask('/heat Savar, Dhaka', 13)).text, /সাভার|Savar/, 'a typed place beats the saved area');

  // Disconnected: the weather commands still work for anyone, but there is no saved area and no alerts
  await handleTelegramUpdate({ update_id: 14, message: { chat: { id: 4242, type: 'private' }, text: '/stop' } }, { channels, deps });
  assert.match((await ask('/update', 15, 'en')).text, /Which place\?/);
  assert.match((await ask('/rain Badda', 16, 'en')).text, /<b>Badda<\/b>/);
  assert.match((await ask('/alerts', 17, 'en')).text, /not connected to an alert profile/);
  const help = await ask('/help', 18, 'en');
  assert.equal(help.parseMode, 'HTML');
  assert.match(help.text, /<b>AkashSathi · Commands<\/b>/);
  assert.match(help.text, /\/thunderstorm — thunderstorm outlook/);
});

dbTest('lightning: the most recent stored check for the circle around a place is what is reported, and nothing is called when none exists', async () => {
  const channels = channelSet();
  const deps = { ...defaultDeps, loadForecast: () => loadForecast({ ...forecastInputs(), now: FORECAST_NOW }) };
  let updateId = 100;
  const ask = async (text) => {
    updateId += 1;
    await handleTelegramUpdate({ update_id: updateId, message: { chat: { id: 31, type: 'private' }, text } }, { channels, deps, now: new Date(now) });
    return channels.telegram.sent.at(-1).content.text;
  };

  assert.match(await ask('/lightning Savar'), /Lightning has not been checked yet\./, 'an upazila with no stored check');
  assert.match(await ask('/lightning Badda'), /Lightning has not been checked yet/, 'a city thana is covered by the same search circle');

  const probe = (status, data, at) => saveSnapshot({
    provider: 'xweather', product: 'lightning-summary', queryKey: 'c:BD-C08', scope: { gate: 'open', radiusKm: 100 }, status, data, now: new Date(at),
  });
  await probe('NO_MATCH', { count: 0 }, now - 20 * MINUTE);
  assert.match(await ask('/lightning Badda'), /is out of date/, 'an open-gate check is current for 15 minutes');
  await probe('NO_MATCH', { count: 0 }, now - 10 * MINUTE);
  assert.match(await ask('/lightning Badda'), /No lightning was recorded at the last check/);

  await probe('FRESH', { count: 3 }, now - 2 * MINUTE);
  const reported = await ask('/lightning Badda');
  assert.match(reported, /Lightning was recorded\.\nLast check: .*\nStrikes \(previous 5 min\): 3\nSearch radius: 100 km/);
  assert.match(await ask('/update Badda'), /⚡ Last lightning check: .* · 3 recorded \(100 km\)\./);
  assert.match(await ask('/lightning Dhaka'), /Lightning was recorded/, 'a district uses the circle around its centre');
});

dbTest('phone verification: consent and a Bangladeshi number are required, the code is sent, and nothing is stored in the clear', async () => {
  const id = await person({ telegram: false });
  const channels = channelSet();
  const profile = () => Subscriber.findById(id).lean();

  const subscriber = await profile();
  await assert.rejects(startPhoneVerification(subscriber, 'sms', { phone: '01712345678', consent: false }, { channels }), (error) => error.status === 400 && error.details.consent === 'required');
  await assert.rejects(startPhoneVerification(subscriber, 'sms', { phone: '+14155550100', consent: true }, { channels }), (error) => error.status === 400 && error.details.phone === 'invalid');
  await assert.rejects(startPhoneVerification(subscriber, 'telegram', { phone: '01712345678', consent: true }, { channels }), (error) => error.status === 400);
  await assert.rejects(startPhoneVerification(subscriber, 'whatsapp', { phone: '01712345678', consent: true }, { channels }), (error) => error.status === 503, 'WhatsApp is not set up in this channel set');
  assert.equal(channels.sms.sent.length, 0, 'nothing is sent for a rejected request');

  const result = await startPhoneVerification(subscriber, 'sms', { phone: '0171 234 5678', consent: true }, { channels, now: new Date(now), makeCode: () => '042917' });
  assert.match(result.phoneMask, /^\+8801•+678$/);
  assert.deepEqual(channels.sms.sent.at(-1), { code: true, to: PHONE, codeValue: '042917', lang: 'en' });

  const stored = JSON.stringify(await profile());
  assert.equal(stored.includes('042917'), false, 'the code is stored only as a hash');
  assert.equal(stored.includes('1712345678'), false, 'the number is stored only encrypted');
  const pending = (await profile()).channels.sms.pending;
  assert.equal(decrypt(pending.phoneEnc), PHONE);
  assert.equal((await profile()).channels.sms.verifiedAt, undefined);
  assert.deepEqual(linkedChannels(await profile()), {}, 'an unverified number delivers nothing');
});

dbTest('phone verification: the right code connects the number; wrong codes are limited and a new code resets nothing for free', async () => {
  const id = await person({ telegram: false });
  const channels = channelSet();
  const profile = () => Subscriber.findById(id).lean();
  await startPhoneVerification(await profile(), 'sms', { phone: '01712345678', consent: true }, { channels, now: new Date(now), makeCode: () => '123456' });

  // wrong codes: counted atomically, and after five even the right one is refused
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(verifyPhone(await profile(), 'sms', '000000', { now: new Date(now + MINUTE) }), (error) => error.status === 400 || error.status === 429);
  }
  await assert.rejects(verifyPhone(await profile(), 'sms', '123456', { now: new Date(now + MINUTE) }), (error) => error.status === 429);
  assert.equal((await profile()).channels.sms.verifiedAt, undefined);

  // a fresh code (after the cool-down) starts again
  await startPhoneVerification(await profile(), 'sms', { phone: '01712345678', consent: true }, { channels, now: new Date(now + 2 * MINUTE), makeCode: () => '654321' });
  await assert.rejects(verifyPhone(await profile(), 'sms', '12345', { now: new Date(now + 3 * MINUTE) }), (error) => error.details.code === 'invalid');
  await assert.rejects(verifyPhone(await profile(), 'sms', '123456', { now: new Date(now + 3 * MINUTE) }), (error) => error.details.code === 'wrong');
  await assert.rejects(verifyPhone(await profile(), 'sms', '654321', { now: new Date(now + 20 * MINUTE) }), (error) => error.details.code === 'expired');

  await startPhoneVerification(await profile(), 'sms', { phone: '01712345678', consent: true }, { channels, now: new Date(now + 21 * MINUTE), makeCode: () => '111222' });
  const result = await verifyPhone(await profile(), 'sms', '111222', { now: new Date(now + 22 * MINUTE) });
  assert.match(result.phoneMask, /678$/);

  const connected = await profile();
  assert.ok(connected.channels.sms.verifiedAt);
  assert.equal(connected.channels.sms.pending, undefined, 'the pending number and code are gone');
  assert.equal(connected.channels.sms.consentVersion, 'ch-1');
  assert.deepEqual(Object.keys(linkedChannels(connected)), ['sms']);
  assert.equal(decrypt(connected.channels.sms.phoneEnc), PHONE);
});

dbTest('re-verifying a different number never lets the old verification apply to it', async () => {
  const id = await person({ telegram: false, sms: true });
  const channels = channelSet();
  const profile = () => Subscriber.findById(id).lean();
  const before = (await profile()).channels.sms.phoneEnc;

  await startPhoneVerification(await profile(), 'sms', { phone: '01898765432', consent: true }, { channels, now: new Date(now), makeCode: () => '555555' });
  const mid = await profile();
  assert.equal(mid.channels.sms.phoneEnc, before, 'still the old, verified number');
  assert.equal(decrypt(mid.channels.sms.pending.phoneEnc), '+8801898765432');
  assert.equal(decrypt(linkedChannels(mid).sms), PHONE, 'deliveries keep going to the verified number until the new one is proved');

  await verifyPhone(await profile(), 'sms', '555555', { now: new Date(now + MINUTE) });
  assert.equal(decrypt((await profile()).channels.sms.phoneEnc), '+8801898765432');
});

dbTest('code requests are limited: a cool-down, an hourly cap per profile and per number, and a send failure leaves nothing pending', async () => {
  const id = await person({ telegram: false });
  const channels = channelSet();
  const profile = () => Subscriber.findById(id).lean();

  const go = async (at, phone = '01712345678') => startPhoneVerification(await profile(), 'sms', { phone, consent: true }, { channels, now: new Date(at) });
  await go(now);
  await assert.rejects(go(now + 30_000), (error) => error.status === 429, 'one code a minute');
  await go(now + 70_000);
  await go(now + 140_000);
  await assert.rejects(go(now + 210_000), (error) => error.status === 429 && /Too many codes were sent to this number/.test(error.message), 'three per hour for one number, whoever asks');

  // a different number is its own count; the per-profile hourly cap is five
  await go(now + 280_000, '01811111111');
  await go(now + 350_000, '01822222222');
  await assert.rejects(go(now + 420_000, '01833333333'), (error) => error.status === 429 && /Too many codes were requested/.test(error.message));

  // a gateway failure: nothing is left pending, and the error is for the person, not the provider's text
  const other = await person({ telegram: false });
  const failing = channelSet({ sms: stub('sms', async () => { throw new ChannelError('retry', 'The SMS gateway is unavailable (HTTP 503).'); }) });
  await assert.rejects(
    startPhoneVerification(await Subscriber.findById(other).lean(), 'sms', { phone: '01955555555', consent: true }, { channels: failing, now: new Date(now) }),
    (error) => error.status === 502 && !/503|gateway/i.test(error.message),
  );
  assert.equal((await Subscriber.findById(other).lean()).channels?.sms?.pending, undefined);
});

// ---------- HTTP ----------

let server;
let base;
let webhook;
let webhookBase;

async function listen(application) {
  const instance = application.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

before(async () => {
  if (!testUri) return;
  const api = express();
  api.use(express.json({ limit: '10kb' }));
  api.use('/api/alerts', createAlertRoutes({ subscribeLimit: { windowMs: 60_000, max: 1000 }, codeLimit: { windowMs: 60_000, max: 1000 } }));
  api.use(notFound);
  api.use(errorHandler);
  ({ instance: server, url: base } = await listen(api));
  ({ instance: webhook, url: webhookBase } = await listen(app));
});

after(async () => {
  for (const instance of [server, webhook]) if (instance) await new Promise((resolve) => instance.close(resolve));
});

async function signUp() {
  const response = await fetch(`${base}/api/alerts/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ occupation: 'farmer', language: 'en', homeAreaPcode: BADDA, consent: true, occupationData: FARMER }),
  });
  assert.equal(response.status, 201);
  return response.headers.getSetCookie()[0].split(';')[0];
}

const call = (cookie, path, method = 'GET', body) => fetch(`${base}/api/alerts${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

dbTest('the channel endpoints need the device cookie and show only masked, non-secret state', async () => {
  setSharedChannels(channelSet());
  assert.equal((await call(null, '/me/channels')).status, 401);
  assert.equal((await call(null, '/me/channels/telegram/link', 'POST')).status, 401);

  const cookie = await signUp();
  const overview = (await (await call(cookie, '/me/channels')).json()).data;
  assert.deepEqual(Object.keys(overview), ['telegram', 'whatsapp', 'sms']);
  assert.equal(overview.telegram.available, true);
  assert.equal(overview.whatsapp.available, false);
  assert.equal(overview.telegram.linked, false);
  assert.equal(overview.telegram.botUsername, 'AkashSathiBot');
  assert.equal(overview.sms.minSeverity, 'WARNING');

  const link = (await (await call(cookie, '/me/channels/telegram/link', 'POST')).json()).data;
  assert.match(link.url, /^https:\/\/t\.me\/AkashSathiBot\?start=/);

  const unavailable = await call(cookie, '/me/channels/whatsapp/start', 'POST', { phone: '01712345678', consent: true });
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).message, /WhatsApp alerts are not set up/, 'a person is told why, in plain words');
  assert.equal((await call(cookie, '/me/channels/telegram/start', 'POST', { phone: '01712345678', consent: true })).status, 400);
  assert.equal((await call(cookie, '/me/channels/nope', 'DELETE')).status, 400);
});

dbTest('over HTTP: request a code, verify it, see the masked number, then disconnect', async () => {
  const channels = channelSet();
  setSharedChannels(channels);
  const cookie = await signUp();

  const started = await call(cookie, '/me/channels/sms/start', 'POST', { phone: '01712345678', consent: true, lang: 'en' });
  assert.equal(started.status, 200);
  const sentCode = channels.sms.sent.find((call2) => call2.code).codeValue;
  assert.match(sentCode, /^\d{6}$/);
  const pendingView = (await (await call(cookie, '/me/channels')).json()).data.sms;
  assert.equal(pendingView.linked, false);
  assert.match(pendingView.pending.phoneMask, /678$/);
  assert.equal(JSON.stringify(pendingView).includes('1712345678'), false);

  assert.equal((await call(cookie, '/me/channels/sms/verify', 'POST', { code: '000000' })).status, 400);
  const verified = await call(cookie, '/me/channels/sms/verify', 'POST', { code: sentCode });
  assert.equal(verified.status, 200);
  const sms = (await verified.json()).data.sms;
  assert.equal(sms.linked, true);
  assert.match(sms.phoneMask, /^\+8801•+678$/);

  // the profile itself never exposes channel secrets
  const me = JSON.stringify(await (await call(cookie, '/me')).json());
  assert.equal(me.includes('phoneEnc'), false);
  assert.equal(me.includes('otpHash'), false);
  assert.equal(me.includes('chatId'), false);

  const removed = await call(cookie, '/me/channels/sms', 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.sms.linked, false);
});

dbTest('editing the profile does not disconnect a channel', async () => {
  const channels = channelSet();
  setSharedChannels(channels);
  const cookie = await signUp();
  const subscriber = await Subscriber.findOne({}).lean();
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: { 'channels.telegram': { chatId: '31337', linkedAt: new Date() } } });

  const response = await call(cookie, '/me', 'PUT', { occupation: 'farmer', language: 'bn', homeAreaPcode: BADDA, consent: true, occupationData: FARMER });
  assert.equal(response.status, 200);
  assert.equal((await Subscriber.findById(subscriber._id).lean()).channels.telegram.chatId, '31337');
});

dbTest('the Telegram webhook answers only requests that carry the secret, and accepts a body larger than the rest of the API allows', async () => {
  const channels = channelSet();
  setSharedChannels(channels);
  env.channels.telegram.webhookSecret = 'webhook-secret-0123456789';
  const post = (headers, body) => fetch(`${webhookBase}/api/channels/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const update = (text, updateId) => ({ update_id: updateId, message: { chat: { id: 8080, type: 'private' }, text } });

  assert.equal((await post({}, update('hi', 1))).status, 404, 'no secret');
  assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'wrong' }, update('hi', 2))).status, 404);
  assert.equal(channels.telegram.sent.length, 0);

  const ok = await post({ 'x-telegram-bot-api-secret-token': 'webhook-secret-0123456789' }, update('hi', 3));
  assert.equal(ok.status, 200);
  assert.equal(channels.telegram.sent.length, 1);
  assert.equal(channels.telegram.sent[0].to, '8080');

  // 5,000 Bangla letters are about 15 kB: more than the 10 kB limit of the rest of the API, and Telegram would retry a rejection
  const long = await post({ 'x-telegram-bot-api-secret-token': 'webhook-secret-0123456789' }, update('আ'.repeat(5000), 4));
  assert.equal(long.status, 200);

  env.channels.telegram.webhookSecret = '';
  assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'webhook-secret-0123456789' }, update('hi', 5))).status, 404, 'without a configured secret the endpoint does not exist');
});

dbTest('the administrator overview shows which channels are set up and how many profiles use them, never who', async () => {
  const id = await person({ telegram: true, sms: true });
  await person({ telegram: true });
  await alertFor(id);
  const channels = channelSet();
  setSharedChannels(channels);
  await runDeliveryCycle({ channels, nowMs: now });

  const { delivery } = await overview(now);
  assert.equal(delivery.enabled, true);
  assert.deepEqual(Object.keys(delivery.channels), ['telegram', 'whatsapp', 'sms']);
  assert.equal(delivery.channels.telegram.available, true);
  assert.equal(delivery.channels.whatsapp.available, false);
  assert.equal(delivery.channels.telegram.linkedProfiles, 2);
  assert.equal(delivery.channels.sms.linkedProfiles, 1);
  assert.equal(delivery.channels.whatsapp.linkedProfiles, 0);
  assert.equal(delivery.channels.telegram.last24h.sent, 1);
  assert.equal(delivery.channels.sms.last24h.sent, 1);
  assert.deepEqual(delivery.minSeverity, { telegram: 'ADVISORY', whatsapp: 'WARNING', sms: 'WARNING' });

  const text = JSON.stringify(delivery);
  for (const secret of ['555', 'phoneEnc', 'chatId', 'token', '+8801']) assert.equal(text.includes(secret), false, `overview must not contain ${secret}`);
});
