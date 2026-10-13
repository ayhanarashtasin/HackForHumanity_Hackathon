import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { EngineSettings } from '../src/models/EngineSettings.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { createSubscriber, setCurrentArea } from '../src/services/alerts/subscribers.js';
import { subscriberForChat } from '../src/services/delivery/linking.js';
import { beginTelegramFollow, refreshTelegramFollow, requestTelegramFollow, stopTelegramFollow } from '../src/services/delivery/telegramLocation.js';
import { BADDA, SAVAR } from './support/alertFixtures.js';

const uri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !uri }, fn);

before(async () => {
  if (!uri) return;
  await mongoose.connect(uri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Subscriber, HazardEvent, Notification, EngineSettings].map((model) => model.init()));
});
beforeEach(async () => {
  if (!uri) return;
  await Promise.all([Subscriber, HazardEvent, Notification, EngineSettings].map((model) => model.deleteMany({})));
  resetSettingsCache();
});
after(async () => {
  try { if (uri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
  finally { await mongoose.disconnect(); }
});

dbTest('live Telegram locations follow movement into and out of hazards, without changing saved places', async () => {
  const now = new Date();
  const nowMs = +now;
  const { subscriber } = await createSubscriber({
    occupation: 'rickshaw_labourer', language: 'en', homeAreaPcode: BADDA, consent: true,
    occupationData: { shiftStart: '00:00', shiftEnd: '23:59', workload: 'heavy', outdoorExposure: 'on_road' },
  }, { now });
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: { 'channels.telegram.chatId': '4242', 'channels.telegram.linkedAt': now } });
  await HazardEvent.create({
    eventKey: `telegram:location:${randomUUID()}`, hazardType: 'OBSERVED_LIGHTNING',
    source: { provider: 'xweather' }, coverage: { scope: 'upazila', upazilaPcodes: [SAVAR] }, level: 2,
    evidence: { metrics: { count: 3, nearestKm: 8, lastStrikeAtMs: nowMs - 60_000 } },
    validFrom: new Date(nowMs - 60_000), validUntil: new Date(nowMs + 60 * 60_000),
    firstDetectedAt: now, lastConfirmedAt: now, lastUpdatedAt: now,
  });

  let linked = await subscriberForChat('4242', now);
  assert.equal(await beginTelegramFollow(linked, { pcode: SAVAR, messageId: 12, livePeriod: 3600, reportedAt: now }, now), false, 'one-time sharing is not consent');
  assert.equal((await Subscriber.findById(linked._id).lean()).currentArea, null);
  await requestTelegramFollow(linked, now);
  linked = await subscriberForChat('4242', now);
  assert.equal(await beginTelegramFollow(linked, { pcode: SAVAR, messageId: 12, livePeriod: 3600, reportedAt: now }, now), true);
  let [alert] = await Notification.find({ subscriberId: linked._id }).lean();
  assert.equal(alert.status, 'active');
  assert.equal(alert.evidence.matchedArea.role, 'current');
  assert.equal((await Subscriber.findById(linked._id).lean()).areas[0].upazilaPcode, BADDA);
  await assert.rejects(setCurrentArea(await Subscriber.findById(linked._id).lean(), BADDA, now), (error) => error.status === 409);

  linked = await subscriberForChat('4242', now);
  assert.equal(await refreshTelegramFollow(linked, { pcode: BADDA, messageId: 12, reportedAt: new Date(nowMs + 30_000) }, new Date(nowMs + 30_000)), true);
  [alert] = await Notification.find({ subscriberId: linked._id }).lean();
  assert.equal(alert.status, 'withdrawn');
  assert.equal(alert.withdrawalReason, 'location-changed');
  assert.equal(await refreshTelegramFollow(linked, { pcode: SAVAR, messageId: 12, reportedAt: now }, new Date(nowMs + 35_000)), false, 'an older edit cannot restore a previous area');

  linked = await subscriberForChat('4242', now);
  assert.equal(await refreshTelegramFollow(linked, { pcode: SAVAR, messageId: 12, reportedAt: new Date(nowMs + 60_000) }, new Date(nowMs + 60_000)), true);
  [alert] = await Notification.find({ subscriberId: linked._id }).lean();
  assert.equal(alert.status, 'active');
  assert.equal(await Notification.countDocuments({ subscriberId: linked._id }), 1);

  linked = await subscriberForChat('4242', now);
  assert.equal(await refreshTelegramFollow(linked, { pcode: BADDA, messageId: 999, reportedAt: new Date(nowMs + 90_000) }, new Date(nowMs + 90_000)), false, 'another live message cannot take over');
  await Subscriber.updateOne({ _id: linked._id }, { $set: { currentArea: null } });
  linked = await subscriberForChat('4242', now);
  assert.equal(await refreshTelegramFollow(linked, { pcode: SAVAR, messageId: 12, reportedAt: new Date(nowMs + 16 * 60_000) }, new Date(nowMs + 16 * 60_000)), true, 'a later live edit resumes after area expiry');
  assert.equal((await Subscriber.findById(linked._id).lean()).currentArea.upazilaPcode, SAVAR);
  linked = await subscriberForChat('4242', now);
  await stopTelegramFollow(linked, new Date(nowMs + 16 * 60_000 + 30_000));
  assert.equal((await Subscriber.findById(linked._id).lean()).currentArea, null);
  assert.equal(await refreshTelegramFollow(linked, { pcode: SAVAR, messageId: 12, reportedAt: new Date(nowMs + 16 * 60_000 + 45_000) }, new Date(nowMs + 16 * 60_000 + 45_000)), false, 'an in-flight edit cannot restart a stopped session');
  assert.equal((await Notification.findById(alert._id).lean()).status, 'withdrawn');
});

dbTest('web and Telegram following cannot silently replace each other', async () => {
  const now = new Date();
  const { subscriber } = await createSubscriber({
    occupation: 'rickshaw_labourer', language: 'en', homeAreaPcode: BADDA, consent: true,
    occupationData: { shiftStart: '00:00', shiftEnd: '23:59', workload: 'heavy', outdoorExposure: 'on_road' },
  }, { now });
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: { 'channels.telegram.chatId': '4242', 'channels.telegram.linkedAt': now } });
  const web = await setCurrentArea(subscriber, BADDA, now);
  assert.equal(await requestTelegramFollow(web, now), false);
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: { 'channels.telegram.followPendingUntil': new Date(+now + 60_000) } });
  const linked = await subscriberForChat('4242', now);
  assert.equal(await beginTelegramFollow(linked, { pcode: SAVAR, messageId: 12, livePeriod: 3600, reportedAt: now }, now), false);
  assert.equal((await Subscriber.findById(linked._id).lean()).currentArea.upazilaPcode, BADDA);
  await setCurrentArea(web, null, now);
  const again = await subscriberForChat('4242', now);
  assert.equal(await beginTelegramFollow(again, { pcode: SAVAR, messageId: 12, livePeriod: 3600, reportedAt: now }, now), true);
  await assert.rejects(setCurrentArea(again, BADDA, now), (error) => error.status === 409);
  await stopTelegramFollow(await subscriberForChat('4242', now), now);
  assert.equal((await Subscriber.findById(linked._id).lean()).currentArea, null);
});
