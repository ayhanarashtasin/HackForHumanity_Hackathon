import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { JobState } from '../src/models/JobState.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { EngineSettings } from '../src/models/EngineSettings.js';
import {
  evaluateSubscriberNow, reevaluateSubscriber, runTick,
} from '../src/services/alerts/engine.js';
import { expireEnded, withdrawEvent } from '../src/services/alerts/events.js';
import { listInbox, markAllRead, markRead } from '../src/services/alerts/inbox.js';
import { applyEvent } from '../src/services/alerts/notify.js';
import { resetSettingsCache, updateSettings } from '../src/services/alerts/settings.js';
import { createSubscriber, updateProfile } from '../src/services/alerts/subscribers.js';
import {
  BADDA, DHAKA, HOUR, NOW, SAVAR,
} from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Subscriber, HazardEvent, Notification, WeatherSnapshot, EngineSettings, JobState].map((model) => model.init()));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([Subscriber, HazardEvent, Notification, WeatherSnapshot, EngineSettings, JobState].map((model) => model.deleteMany({})));
  resetSettingsCache();
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- fixtures ----------
const STEPS = 16;
const stepStarts = Array.from({ length: STEPS }, (_, i) => new Date(NOW - HOUR + i * 3 * HOUR).toISOString());

// Cached provider data as the engine reads it. `at` indexes the 3-hour step (0 = 09:00-12:00 local, 1 = 12:00-15:00, ...).
function makeSources({
  pcode = BADDA, rain = {}, pop = {}, hi = {}, gust = {}, openMeteoStatus = 'FRESH', bmdStatus = 'FRESH',
} = {}) {
  const column = (overrides, fallback) => Array.from({ length: STEPS }, (_, i) => overrides[i] ?? fallback);
  const checkedAt = new Date(NOW - 5 * 60_000).toISOString();
  const common = { name: 'x', dataTime: checkedAt, checkedAt, message: null };
  return {
    bmd: {
      ...common,
      name: 'bmd',
      status: bmdStatus,
      data: {
        steps: stepStarts,
        locations: { [pcode]: { temp: column({}, 29), rh: column({}, 70), hi: column(hi, 20), wg: column(gust, 15), rf: column({}, 0), ws: column({}, 8) } },
        daily: { days: [], locations: {} },
      },
    },
    openMeteo: {
      ...common,
      name: 'openMeteo',
      status: openMeteoStatus,
      data: {
        steps: stepStarts,
        locations: { [pcode]: { rf: column(rain, 0), pop: column(pop, 20), hi: column(hi, 20), temp: column({}, 29), wg: column(gust, 15), ts: column({}, 0) } },
      },
    },
  };
}

const profile = (occupation, data, extra = {}) => ({
  occupation, language: 'en', homeAreaPcode: BADDA, occupationData: data, consent: true, ...extra,
});

const FARMER = { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' };
const RICKSHAW = { shiftStart: '09:00', shiftEnd: '18:00', workload: 'heavy', outdoorExposure: 'on_road' };

async function signUp(occupation, data, extra) {
  const { subscriber } = await createSubscriber(profile(occupation, data, extra), { now: new Date(NOW) });
  return subscriber;
}

const notificationsOf = (subscriber, filter = {}) => Notification.find({ subscriberId: subscriber._id, ...filter }).sort({ scenarioId: 1 }).lean();
const tick = (sources, nowMs = NOW) => runTick({ nowMs, sources });

// ---------- detection to notification ----------
dbTest('a rain forecast creates one event and one notification per eligible subscriber, sent automatically', async () => {
  const farmer = await signUp('farmer', FARMER);
  const rickshaw = await signUp('rickshaw_labourer', RICKSHAW);
  const fisherman = await signUp('fisherman', { waterBody: 'river', status: 'ashore' }, { homeAreaPcode: SAVAR });

  const stats = await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  assert.equal(stats.eventsCreated, 1);
  assert.equal(stats.areas, 2, 'Badda and Savar are monitored, nothing else');

  const events = await HazardEvent.find({}).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].hazardType, 'HEAVY_RAIN');
  assert.equal(events[0].level, 1);
  assert.deepEqual(events[0].coverage.upazilaPcodes, [BADDA]);
  assert.deepEqual(events[0].coverage.districtPcodes, [], 'an upazila forecast is never a district-wide claim');
  assert.match(events[0].eventKey, /^fc:open-meteo:302604:HEAVY_RAIN:/);
  assert.equal(events[0].evidence.rule.status, 'prototype');

  const farmerNotes = await notificationsOf(farmer);
  assert.deepEqual(farmerNotes.map((n) => n.scenarioId), ['FARM-01']);
  assert.equal(farmerNotes[0].severity, 'ADVISORY');
  assert.equal(farmerNotes[0].status, 'active', 'sent automatically: no administrator step');
  assert.equal(farmerNotes[0].publishedBy, 'engine');
  assert.equal(farmerNotes[0].origin, 'automatic');
  assert.equal(farmerNotes[0].readAt, null);
  assert.ok(farmerNotes[0].message.length > 20);

  assert.deepEqual((await notificationsOf(rickshaw)).map((n) => n.scenarioId), ['WORK-04']);
  assert.deepEqual(await notificationsOf(fisherman), [], 'a river fisherman in another upazila has no rain scenario and a different area');
});

dbTest('running the engine again changes nothing: no duplicate events or notifications', async () => {
  await signUp('farmer', FARMER);
  const sources = makeSources({ rain: { 1: 9 }, pop: { 1: 80 } });
  await tick(sources);
  const before = { events: await HazardEvent.countDocuments(), notes: await Notification.countDocuments(), first: await Notification.findOne().lean() };

  const again = await tick(sources);
  assert.equal(again.eventsCreated, 0);
  assert.equal(again.notificationsCreated, 0);
  assert.equal(await HazardEvent.countDocuments(), before.events);
  assert.equal(await Notification.countDocuments(), before.notes);
  const after = await Notification.findOne().lean();
  assert.equal(after.revision, before.first.revision, 'no write when nothing changed');
  assert.equal(String(after.updatedAt), String(before.first.updatedAt));
});

dbTest('a heavier forecast updates the same event and escalates the notification, putting it back to unread', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const [first] = await notificationsOf(farmer);
  await markRead(farmer._id, first._id, new Date(NOW));
  assert.ok((await Notification.findById(first._id).lean()).readAt);

  const stats = await tick(makeSources({ rain: { 1: 26 }, pop: { 1: 90 } }), NOW + 2 * 60_000);
  assert.equal(stats.eventsCreated, 0, 'the same event, updated');
  assert.equal(await HazardEvent.countDocuments(), 1);

  const [escalated] = await notificationsOf(farmer);
  assert.equal(String(escalated._id), String(first._id));
  assert.equal(escalated.severity, 'WARNING', 'heavy rain starting within six hours');
  assert.equal(escalated.readAt, null, 'an escalation shows as new again');
  assert.equal(escalated.revision, 2);
  assert.equal(escalated.lifecycle.at(-1).type, 'escalated');
  assert.equal(await Notification.countDocuments({ subscriberId: farmer._id }), 1);
});

dbTest('a small change updates the evidence silently; it neither re-notifies nor writes a lifecycle entry', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 20 }, pop: { 1: 80 } }));
  const [first] = await notificationsOf(farmer);
  await markRead(farmer._id, first._id, new Date(NOW));

  await tick(makeSources({ rain: { 1: 21 }, pop: { 1: 80 } }), NOW + 2 * 60_000);
  const [after] = await notificationsOf(farmer);
  assert.equal(after.revision, first.revision);
  assert.ok(after.readAt, 'still read');
  assert.equal(after.lifecycle.length, first.lifecycle.length);
});

dbTest('stale data never creates an alert, and an existing alert is annotated but not escalated', async () => {
  const farmer = await signUp('farmer', FARMER);
  const stale = await tick(makeSources({ rain: { 1: 30 }, pop: { 1: 90 }, openMeteoStatus: 'STALE' }));
  assert.equal(stale.eventsCreated, 0);
  assert.equal(stale.blocked, 1, 'the engine says why nothing was created');
  assert.equal(await Notification.countDocuments(), 0);

  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const [created] = await notificationsOf(farmer);
  await tick(makeSources({ rain: { 1: 60 }, pop: { 1: 90 }, openMeteoStatus: 'STALE' }), NOW + 60_000);
  const [after] = await notificationsOf(farmer);
  assert.equal(after.severity, created.severity, 'a stale source cannot escalate');
  assert.equal((await HazardEvent.findOne().lean()).level, 1);
  assert.equal((await HazardEvent.findOne().lean()).dataStatus, 'STALE', 'but the event says its data is stale');
});

dbTest('an event the fresh forecast no longer shows is withdrawn by the system, never called an all-clear', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  assert.equal((await notificationsOf(farmer))[0].status, 'active');

  const stats = await tick(makeSources({}), NOW + 60_000);
  assert.equal(stats.eventsSuperseded, 1);
  const event = await HazardEvent.findOne().lean();
  assert.equal(event.lifecycle, 'superseded');
  assert.equal(event.withdrawal.source, 'system');
  const [note] = await notificationsOf(farmer);
  assert.equal(note.status, 'withdrawn');
  assert.equal(note.withdrawalReason, 'forecast-updated');
  assert.match(note.lifecycle.at(-1).note, /not an all-clear/);
  assert.doesNotMatch(note.lifecycle.at(-1).note, /\bsafe\b/i);
});

dbTest('a source that is missing or stale never supersedes an alert', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const stats = await tick(makeSources({ openMeteoStatus: 'STALE' }), NOW + 60_000);
  assert.equal(stats.eventsSuperseded, 0);
  assert.equal((await notificationsOf(farmer))[0].status, 'active');
});

dbTest('expiry ends events and notifications by time, and finished notifications are never resurrected', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const stats = await expireEnded(NOW + 10 * HOUR);
  assert.equal(stats.events, 1);
  assert.equal(stats.sent, 1);
  const [note] = await notificationsOf(farmer);
  assert.equal(note.status, 'expired');
  assert.match(note.lifecycle.at(-1).note, /This is not an all-clear/);

  const event = await HazardEvent.findOne();
  await applyEvent(event, { nowMs: NOW + 10 * HOUR, settings: {} });
  assert.equal((await Notification.findById(note._id).lean()).status, 'expired');
});

dbTest('the per-hazard kill switch stops the engine creating events of that type', async () => {
  await signUp('farmer', FARMER);
  await updateSettings({ hazardEnabled: { HEAVY_RAIN: false } });
  const stats = await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  assert.equal(stats.eventsCreated, 0);
  assert.equal(await Notification.countDocuments(), 0);
  await updateSettings({ hazardEnabled: { HEAVY_RAIN: true } });
  assert.equal((await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }))).eventsCreated, 1);
});

// ---------- the hold (an optional safety valve; off by default) ----------
dbTest('with a hold on, notifications wait as drafts: invisible to the subscriber until an administrator releases them', async () => {
  const farmer = await signUp('farmer', FARMER);
  await updateSettings({ hold: { ADVISORY: true } });
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));

  const [draft] = await notificationsOf(farmer);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.publishedAt, null);
  const inbox = await listInbox(farmer._id, { view: 'active', now: new Date(NOW) });
  assert.equal(inbox.items.length, 0, 'drafts never reach the inbox');
  assert.equal(inbox.unread, 0);

  const event = await HazardEvent.findOne();
  const summary = await applyEvent(event, {
    nowMs: NOW, settings: { hold: { ADVISORY: true } }, publishNow: true, publishedBy: 'admin', batchId: 'b_test', bypassCap: true,
  });
  assert.equal(summary.released, 1);
  const [released] = await notificationsOf(farmer);
  assert.equal(released.status, 'active');
  assert.equal(released.publishedBy, 'admin');
  assert.equal(released.batchId, 'b_test');
  assert.equal((await listInbox(farmer._id, { view: 'active', now: new Date(NOW) })).items.length, 1);
});

dbTest('a dry run reports what would happen and writes nothing', async () => {
  await signUp('farmer', FARMER);
  await signUp('rickshaw_labourer', RICKSHAW);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  await Notification.deleteMany({});

  const event = await HazardEvent.findOne();
  const summary = await applyEvent(event, { nowMs: NOW, settings: {}, dryRun: true, publishNow: true });
  assert.equal(summary.inserted, 2);
  assert.deepEqual(summary.groups.map((g) => g.scenarioId).sort(), ['FARM-01', 'WORK-04']);
  const group = summary.groups.find((g) => g.scenarioId === 'FARM-01');
  assert.equal(group.newCount, 1);
  assert.ok(group.sample.en.message && group.sample.bn.message, 'the preview shows both languages');
  assert.equal(await Notification.countDocuments(), 0, 'nothing was written');
});

dbTest('send-now by role reaches only that role and reports what the engine already sent', async () => {
  const farmer = await signUp('farmer', FARMER);
  const rickshaw = await signUp('rickshaw_labourer', RICKSHAW);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  await Notification.deleteOne({ subscriberId: rickshaw._id });

  const event = await HazardEvent.findOne();
  const farmersOnly = await applyEvent(event, { nowMs: NOW, settings: {}, roles: ['farmer'], publishNow: true, publishedBy: 'admin', bypassCap: true });
  assert.equal(farmersOnly.inserted, 0);
  assert.equal(farmersOnly.groups[0].alreadySent, 1, 'the click cannot duplicate what the engine sent');
  assert.equal(await Notification.countDocuments({ subscriberId: rickshaw._id }), 0, 'a role filter never reaches other roles');

  const labourers = await applyEvent(event, { nowMs: NOW, settings: {}, roles: ['rickshaw_labourer'], publishNow: true, publishedBy: 'admin', bypassCap: true });
  assert.equal(labourers.inserted, 1);
  assert.equal((await Notification.findOne({ subscriberId: rickshaw._id }).lean()).publishedBy, 'admin');
  assert.ok(await Notification.findOne({ subscriberId: farmer._id }));
});

// ---------- people, profiles and areas ----------
dbTest('a new subscriber sees an alert that is already active (backfill), and a profile edit withdraws alerts that no longer apply', async () => {
  await signUp('rickshaw_labourer', RICKSHAW);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));

  const farmer = await signUp('farmer', FARMER);
  assert.equal((await notificationsOf(farmer)).length, 0, 'nothing until it is evaluated');
  const backfill = await evaluateSubscriberNow(farmer._id, { nowMs: NOW });
  assert.equal(backfill.inserted, 1);
  assert.equal((await notificationsOf(farmer))[0].scenarioId, 'FARM-01');

  // The crop is no longer at harvest: the harvest alert stops applying and the planting rule takes over.
  const updated = await updateProfile(farmer, profile('farmer', { ...FARMER, cropStage: 'planting' }), new Date(NOW));
  const changes = await reevaluateSubscriber(updated._id, { nowMs: NOW });
  assert.equal(changes.withdrawn, 1);
  const notes = await notificationsOf(updated);
  assert.deepEqual(notes.map((n) => [n.scenarioId, n.status]), [['FARM-01', 'withdrawn'], ['FARM-02', 'active']]);
  assert.equal(notes[0].withdrawalReason, 'profile-changed');
  assert.match(notes[0].lifecycle.at(-1).note, /not an all-clear/);
});

dbTest('a district-wide event reaches a subscriber with an area in that district and is described as district-wide', async () => {
  const farmer = await signUp('farmer', FARMER, { homeAreaPcode: SAVAR });
  const now = new Date(NOW);
  const event = await HazardEvent.create({
    eventKey: `adm:test:${randomUUID()}`,
    hazardType: 'HEAVY_RAIN',
    origin: 'admin-declared',
    source: { provider: 'admin', product: 'declared' },
    coverage: { scope: 'district', upazilaPcodes: [], districtPcodes: [DHAKA], matchMethod: 'district' },
    level: 2,
    evidence: { asserted: { by: 'administrator', at: now } },
    validFrom: new Date(NOW + HOUR),
    validUntil: new Date(NOW + 6 * HOUR),
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
  });
  const summary = await applyEvent(event, { nowMs: NOW, settings: {}, publishNow: true, publishedBy: 'admin', bypassCap: true });
  assert.equal(summary.inserted, 1);
  const [note] = await notificationsOf(farmer);
  assert.equal(note.affectedArea.scope, 'district');
  assert.equal(note.affectedArea.upazilaPcode, null);
  assert.match(note.affectedArea.text, /district-wide notice/);
  assert.equal(note.origin, 'admin-declared');
  assert.equal(note.ruleStatus, 'admin');
  assert.equal(note.severity, 'WARNING', 'heavy rain close to harvest');
});

dbTest('administrator withdrawal is recorded separately and its text is never an all-clear', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const event = await HazardEvent.findOne();
  await withdrawEvent(event, { source: 'administrator', reason: 'Issued in error', nowMs: NOW + 60_000 });

  const after = await HazardEvent.findById(event._id).lean();
  assert.equal(after.lifecycle, 'withdrawn');
  assert.equal(after.withdrawal.source, 'administrator');
  assert.equal(after.withdrawal.reason, 'Issued in error');
  const [note] = await notificationsOf(farmer);
  assert.equal(note.status, 'withdrawn');
  assert.match(note.lifecycle.at(-1).note, /withdrew this alert\. This is not an all-clear\. Reason: Issued in error/);
});

dbTest('at most three new ADVISORY notifications a day per subscriber; WARNING and CRITICAL are never capped', async () => {
  const farmer = await signUp('farmer', { ...FARMER, cropStage: 'planting' });
  const now = new Date(NOW);
  const rainEvent = (n, level = 1) => HazardEvent.create({
    eventKey: `fc:test:${n}`,
    hazardType: 'HEAVY_RAIN',
    origin: 'detected',
    source: { provider: 'open-meteo' },
    coverage: { scope: 'upazila', upazilaPcodes: [BADDA], districtPcodes: [], matchMethod: 'representative_point' },
    level,
    evidence: { metrics: { rain3hMm: 10, rain24hMm: 10, popPercent: 80 }, rule: { key: 'HEAVY_RAIN', version: 'prototype-1', status: 'prototype' } },
    validFrom: new Date(NOW + HOUR),
    validUntil: new Date(NOW + 5 * HOUR),
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
  });

  for (let i = 1; i <= 4; i += 1) await applyEvent(await rainEvent(i), { nowMs: NOW, settings: {} });
  assert.equal(await Notification.countDocuments({ subscriberId: farmer._id }), env.alerts.dailyAdvisoryCap, 'the fourth advisory was not sent');
  const capped = await applyEvent(await rainEvent(5), { nowMs: NOW, settings: {} });
  assert.equal(capped.skippedCap, 1);
  assert.equal((await applyEvent(await rainEvent(6), { nowMs: NOW, settings: {}, bypassCap: true })).inserted, 1, 'an administrator send is not capped');
});

// ---------- the inbox ----------
dbTest('the inbox lists current alerts most severe first, pages earlier ones, and only the owner can mark them read', async () => {
  const farmer = await signUp('farmer', FARMER);
  const other = await signUp('farmer', FARMER);
  const base = {
    scenarioId: 'FARM-01', ruleVersion: 'prototype-1', ruleStatus: 'prototype', title: 't', message: 'm', recommendedActions: [], lang: 'en',
    affectedArea: { scope: 'upazila', text: 'Badda, Dhaka' }, reasonForSelection: 'r', hazardType: 'HEAVY_RAIN', status: 'active', publishedAt: new Date(NOW),
    validFrom: new Date(NOW - HOUR), validUntil: new Date(NOW + 5 * HOUR), purgeAfter: new Date(NOW + 30 * 24 * HOUR),
  };
  const make = (subscriber, i, severity, extra = {}) => Notification.create({
    ...base, subscriberId: subscriber._id, hazardEventId: new mongoose.Types.ObjectId(), scenarioId: `S-${i}`, severity, ...extra,
  });
  const advisory = await make(farmer, 1, 'ADVISORY');
  const critical = await make(farmer, 2, 'CRITICAL');
  const warning = await make(farmer, 3, 'WARNING');
  await make(farmer, 4, 'WARNING', { status: 'draft' });
  await make(farmer, 5, 'WARNING', { status: 'withdrawn' });
  await make(farmer, 6, 'ADVISORY', { validUntil: new Date(NOW - HOUR) });
  const foreign = await make(other, 7, 'CRITICAL');

  const current = await listInbox(farmer._id, { view: 'active', now: new Date(NOW) });
  assert.deepEqual(current.items.map((item) => item.severity), ['CRITICAL', 'WARNING', 'ADVISORY'], 'drafts, withdrawn and ended alerts are not current');
  assert.equal(current.unread, 3);
  assert.ok(current.items.every((item) => item.sender === 'automatic'));

  const earlier = await listInbox(farmer._id, { view: 'earlier', limit: 1, now: new Date(NOW) });
  assert.equal(earlier.items.length, 1);
  assert.equal(earlier.hasMore, true);
  assert.equal(earlier.items[0].status === 'withdrawn' || earlier.items[0].status === 'expired', true);

  assert.equal((await markRead(other._id, critical._id, new Date(NOW))).updated, 0, 'not your alert');
  assert.equal((await markRead(farmer._id, critical._id, new Date(NOW))).unread, 2);
  assert.equal((await markRead(farmer._id, foreign._id, new Date(NOW))).updated, 0);
  assert.equal((await markAllRead(farmer._id, new Date(NOW))).unread, 0);
  assert.ok((await Notification.findById(advisory._id).lean()).readAt);
  assert.ok((await Notification.findById(warning._id).lean()).readAt);
  await assert.rejects(listInbox(farmer._id, { view: 'nonsense' }), /view must be/);
  await assert.rejects(markRead(farmer._id, 'not-an-id'), /Invalid alert id/);
});

dbTest('subscribers are looked up by hashed token, expire after inactivity, and the signup cap is enforced', async () => {
  const { findByToken } = await import('../src/services/alerts/subscribers.js');
  const { subscriber, token } = await createSubscriber(profile('farmer', FARMER), { now: new Date(NOW) });
  const stored = await Subscriber.findById(subscriber._id).lean();
  assert.notEqual(stored.tokenHash, token, 'the token itself is never stored');
  assert.equal(stored.tokenHash.length, 64);
  assert.ok(JSON.stringify(stored).indexOf(token) === -1);

  assert.ok(await findByToken(token, new Date(NOW + HOUR)));
  assert.equal(await findByToken('wrong-token', new Date(NOW)), null);
  assert.equal(await findByToken(token, new Date(NOW + 91 * 24 * HOUR)), null, 'expired by the application check, whether or not the TTL job has run');
  assert.equal(await findByToken(undefined), null);

  // lastSeenAt is written at most once an hour.
  const seen = (await Subscriber.findById(subscriber._id).lean()).lastSeenAt;
  await findByToken(token, new Date(NOW + 10 * 60_000));
  assert.equal(String((await Subscriber.findById(subscriber._id).lean()).lastSeenAt), String(seen));

  const original = env.alerts.maxSubscribers;
  env.alerts.maxSubscribers = 1;
  try {
    await assert.rejects(createSubscriber(profile('farmer', FARMER)), /sign-up is full/);
  } finally {
    env.alerts.maxSubscribers = original;
  }
});

// ---------- stale data, holds and late joiners (found by the plan-versus-code audit) ----------
dbTest('stale data only annotates an existing card: it cannot raise or rewrite it, even when the rule\'s own clock would', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  await markAllRead(farmer._id);
  const [created] = await notificationsOf(farmer);
  assert.equal(created.severity, 'ADVISORY');

  const event = await HazardEvent.findOne().lean();
  // FARM-01 turns ADVISORY into WARNING from the event level and the clock, not from the data: exactly what a stale source cannot back.
  const stale = await applyEvent({ ...event, level: 2, dataStatus: 'STALE' }, { nowMs: NOW + 60_000, settings: {} });
  const [annotated] = await notificationsOf(farmer);
  assert.equal(stale.escalated, 0);
  assert.equal(annotated.severity, 'ADVISORY', 'severity unchanged');
  assert.equal(annotated.message, created.message, 'text unchanged');
  assert.equal(annotated.dataStatus, 'STALE', 'but the card says its data is stale');
  assert.ok(annotated.readAt, 'and it is not re-flagged as new');

  // control: the same rise on fresh data does escalate
  const fresh = await applyEvent({ ...event, level: 2, dataStatus: 'FRESH' }, { nowMs: NOW + 120_000, settings: {} });
  const [raised] = await notificationsOf(farmer);
  assert.equal(fresh.escalated, 1);
  assert.equal(raised.severity, 'WARNING');
  assert.equal(raised.dataStatus, 'FRESH');
  assert.equal(raised.readAt, null);
});

dbTest('stale data cannot re-notify a lightning episode either', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  await markAllRead(farmer._id);
  const event = await HazardEvent.findOne().lean();
  const staged = { ...event, evidence: { ...event.evidence, renotifyStage: 1 } };

  await applyEvent({ ...staged, dataStatus: 'UNAVAILABLE' }, { nowMs: NOW + 60_000, settings: {} });
  const [held] = await notificationsOf(farmer);
  assert.equal(held.renotifications, 0);
  assert.ok(held.readAt);

  await applyEvent({ ...staged, dataStatus: 'FRESH' }, { nowMs: NOW + 120_000, settings: {} });
  const [renotified] = await notificationsOf(farmer);
  assert.equal(renotified.renotifications, 1);
  assert.equal(renotified.readAt, null);
});

dbTest('a hold also keeps a live card from being raised to the held severity, and releasing it applies the rise', async () => {
  const farmer = await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const [live] = await notificationsOf(farmer);
  assert.equal(live.status, 'active');

  const event = await HazardEvent.findOne().lean();
  const rising = { ...event, level: 2 };
  const settings = { hold: { WARNING: true } };
  const waiting = await applyEvent(rising, { nowMs: NOW + 60_000, settings });
  const [still] = await notificationsOf(farmer);
  assert.equal(waiting.escalated, 0);
  assert.equal(waiting.held, 1);
  assert.equal(still.severity, 'ADVISORY', 'the held severity does not reach the subscriber');

  const released = await applyEvent(rising, {
    nowMs: NOW + 120_000, settings, publishNow: true, publishedBy: 'admin', batchId: 'b_hold', bypassCap: true,
  });
  const [raised] = await notificationsOf(farmer);
  assert.equal(released.escalated, 1);
  assert.equal(raised.severity, 'WARNING');
});

dbTest('someone who joins during an episode that has already re-notified is not re-flagged on the next tick', async () => {
  await signUp('farmer', FARMER);
  await tick(makeSources({ rain: { 1: 9 }, pop: { 1: 80 } }));
  const event = await HazardEvent.findOne().lean();
  const episode = { ...event, evidence: { ...event.evidence, renotifyStage: 2 } };

  const late = await signUp('rickshaw_labourer', RICKSHAW);
  await applyEvent(episode, { nowMs: NOW + 60_000, settings: {} });
  const [joined] = await notificationsOf(late);
  assert.equal(joined.renotifications, 2, 'starts at the episode\'s current stage');

  await markAllRead(late._id);
  const again = await applyEvent(episode, { nowMs: NOW + 120_000, settings: {} });
  const [after] = await notificationsOf(late);
  assert.equal(again.escalated, 0);
  assert.ok(after.readAt, 'a later tick does not mark it new again');
});
