import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { EngineSettings } from '../src/models/EngineSettings.js';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { runTick } from '../src/services/alerts/engine.js';
import { resetSettingsCache, updateSettings } from '../src/services/alerts/settings.js';
import { stormStage } from '../src/services/alerts/stormEpisodes.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { BADDA, NOW, SAVAR } from './support/alertFixtures.js';

// The whole path for satellite storm warnings: a storm-tracker snapshot -> one STORM_APPROACH episode per area -> one PUBLIC-06 card per person.
const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MIN = 60_000;

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([HazardEvent, Notification, Subscriber, EngineSettings].map((model) => model.init()));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([HazardEvent, Notification, Subscriber, EngineSettings].map((model) => model.deleteMany({})));
  resetSettingsCache();
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

async function subscribe(occupation, homeAreaPcode, occupationData) {
  const { subscriber } = await createSubscriber({ occupation, language: 'en', homeAreaPcode, consent: true, occupationData }, { now: new Date(NOW) });
  return subscriber;
}
const farmer = () => subscribe('farmer', BADDA, { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' });

// A snapshot as stormOutlook.latestStormSnapshot returns it: the image `age` minutes before `nowMs`, one cell reaching `pcode` after `eta`.
function snapshotAt(nowMs, { age = 15, eta = 60, pcode = BADDA, cell = {} } = {}) {
  return {
    observedAtMs: nowMs - age * MIN,
    cells: [{
      id: 'c1', intensity: 6, trend: 'growing', minTempC: -78.2, areaKm2: 8062, motion: { speedKmh: 24.9, towards: 'S', bearingDeg: 180 },
      reaches: [{ pcode, etaMin: eta }], ...cell,
    }],
  };
}

const flatSources = (nowMs) => {
  const empty = { name: 'x', status: 'FRESH', dataTime: new Date(nowMs).toISOString(), checkedAt: new Date(nowMs).toISOString(), message: null, data: null };
  return { bmd: { ...empty, name: 'bmd' }, openMeteo: { ...empty, name: 'openMeteo' } };
};
const tickAt = (nowMs, snapshot) => runTick({ nowMs, sources: flatSources(nowMs), extraStages: [(context) => stormStage({ ...context, snapshot })] });
const storms = () => HazardEvent.find({ hazardType: 'STORM_APPROACH' }).lean();

dbTest('a storm heading for an area: one episode, one WARNING card, updated as it nears, never repeated, ending quietly', async () => {
  const person = await farmer();
  const t0 = NOW;

  // 1. 60 minutes on a 15-minute-old image = 45 minutes from now
  await tickAt(t0, snapshotAt(t0, { eta: 60 }));
  let [event] = await storms();
  assert.equal(event.level, 2);
  assert.match(event.eventKey, new RegExp(`^stm:${BADDA}:`));
  assert.equal(event.source.provider, 'himawari');
  assert.equal(+event.validUntil, t0 + 105 * MIN, 'an hour after the expected arrival');
  let note = await Notification.findOne({ subscriberId: person._id }).lean();
  assert.equal(note.scenarioId, 'PUBLIC-06');
  assert.equal(note.severity, 'WARNING');
  assert.equal(note.title, 'Storm may reach Badda within the hour');
  assert.match(note.message, /may reach Badda, Dhaka around today 10:45/);
  assert.match(note.message, /finish now and get into a substantial building/);

  // 2. the next frame, nearer: the same episode and card, now level 3, not a second message
  const t1 = t0 + 10 * MIN;
  await tickAt(t1, snapshotAt(t1, { eta: 35 }));
  assert.equal((await storms()).length, 1);
  [event] = await storms();
  assert.equal(event.level, 3);
  assert.equal(await Notification.countDocuments({ subscriberId: person._id }), 1);
  note = await Notification.findOne({ subscriberId: person._id }).lean();
  assert.equal(note.title, 'Storm may reach Badda within 30 minutes');
  assert.equal(note.renotifications ?? 0, 0, 'the card is updated, not sent again');

  // 3. the cell turns away: the open warning is left as it is (no all-clear)
  const t2 = t1 + 10 * MIN;
  await tickAt(t2, snapshotAt(t2, { pcode: SAVAR }));
  [event] = await storms();
  assert.equal(event.lifecycle, 'active');

  // 4. it ends by time, quietly
  const t3 = t0 + 106 * MIN;
  await tickAt(t3, snapshotAt(t3, { pcode: SAVAR }));
  note = await Notification.findOne({ subscriberId: person._id }).lean();
  assert.equal(note.status, 'expired');
  assert.match(note.lifecycle.at(-1).note, /not an all-clear/);

  // 5. another cell within three hours of the first warning: no second warning for the same area
  const t4 = t3 + 30 * MIN;
  await tickAt(t4, snapshotAt(t4, { eta: 50 }));
  assert.equal((await storms()).length, 1, 'cooldown');

  // 6. after the cooldown a new storm is a new warning
  const t5 = t0 + 3 * 60 * MIN + MIN;
  await tickAt(t5, snapshotAt(t5, { eta: 50 }));
  assert.equal((await storms()).length, 2);
  assert.equal(await Notification.countDocuments({ subscriberId: person._id, status: 'active' }), 1);
});

dbTest('no warning from an old image, a weak or weakening cell, a place already under the cell, or with the hazard switched off', async () => {
  await farmer();
  await tickAt(NOW, snapshotAt(NOW, { age: 70 }));
  await tickAt(NOW, snapshotAt(NOW, { cell: { intensity: 4 } }));
  await tickAt(NOW, snapshotAt(NOW, { cell: { trend: 'weakening' } }));
  await tickAt(NOW, snapshotAt(NOW, { eta: 0 }));
  await tickAt(NOW, snapshotAt(NOW, { eta: 90 })); // 75 minutes from now: beyond the hour
  await tickAt(NOW, null);
  assert.equal((await storms()).length, 0);

  await updateSettings({ hazardEnabled: { STORM_APPROACH: false } });
  resetSettingsCache();
  await tickAt(NOW, snapshotAt(NOW));
  assert.equal((await storms()).length, 0, 'the administrator switch');
});

dbTest('an open warning says when its image went stale, and is not changed by it', async () => {
  await farmer();
  await tickAt(NOW, snapshotAt(NOW, { eta: 60 }));
  const later = NOW + 50 * MIN;
  await tickAt(later, { observedAtMs: NOW - 15 * MIN, cells: [] });
  const [event] = await storms();
  assert.equal(event.dataStatus, 'STALE');
  assert.equal(event.level, 2);
});
