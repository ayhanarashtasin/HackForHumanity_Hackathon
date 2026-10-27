import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { JobState } from '../src/models/JobState.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import {
  acquireLease, dueForecastAreas, recordJob, releaseLease, runAlertCycle, topForecastAreas,
} from '../src/services/alerts/cycle.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { sourceRows } from '../src/services/alerts/status.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { BADDA, SAVAR } from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const HOUR = 3_600_000;
const COXS = '202224';

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([JobState, Subscriber, WeatherSnapshot, HazardEvent].map((model) => model.init()));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([JobState, Subscriber, WeatherSnapshot, HazardEvent].map((model) => model.deleteMany({})));
  resetSettingsCache();
  env.alerts.xweatherEnabled = true;
  env.alerts.bulletinsEnabled = false; // Bulletin ingestion has its own mocked tests; cycles never call live providers.
  env.flood.enabled = false; // FFWC has its own mocked unit tests; cycles never call live providers.
  env.alerts.maxForecastAreas = 10;
  env.alerts.maxMarinePoints = 4;
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

const farmerIn = (home) => createSubscriber({
  occupation: 'farmer', language: 'en', homeAreaPcode: home, consent: true,
  occupationData: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
});
const fisherman = (home, waterBody) => createSubscriber({
  occupation: 'fisherman', language: 'en', homeAreaPcode: home, consent: true, occupationData: { waterBody, status: 'ashore' },
});

const headers = { cost: 1, remainingPeriod: 14000, remainingMinute: 90, limitMinute: 100, limitPeriod: 15000, retryAfterSeconds: null };
const periods = (n) => Array.from({ length: n }, (_, i) => ({
  dateTimeISO: new Date(Date.now() + i * HOUR).toISOString(), tempC: 28, wetBulbGlobeTempC: 24, pop: 5, precipMM: 0, windGustKPH: 12, significantWaveHeightM: 0.8, humidity: 70, weatherPrimaryCoded: '::CL',
}));

function client() {
  const calls = [];
  return {
    calls,
    hasCredentials: () => true,
    async fetchSummary() { calls.push('summary'); return { class: 'no-data', httpStatus: 200, headers, summary: null }; },
    async fetchJson({ path }) {
      calls.push(path.split('/')[1]);
      return { class: 'ok', httpStatus: 200, headers, json: { success: true, response: [{ periods: periods(24) }] } };
    },
  };
}
const budget = () => ({ async reserve() { return { ok: true }; }, async settle() {}, async markExhausted() {}, async pace() {} });

dbTest('a cycle refreshes what is due, records each task, and does not refetch anything that is not due yet', async () => {
  await farmerIn(BADDA);
  await farmerIn(SAVAR);
  const api = client();
  const now = Date.now();

  const first = await runAlertCycle({ nowMs: now, client: api, budget: budget(), log: { error() {} } });
  assert.equal(first.fetched.forecast.fetched, 2);
  assert.equal(api.calls.filter((call) => call === 'forecasts').length, 2, 'one request per due upazila');
  assert.equal(first.engine.status, 'ok');
  assert.equal(first.engine.stats.areas, 2);

  const rows = Object.fromEntries((await JobState.find({}).lean()).map((row) => [row.key, row]));
  assert.ok(rows['xweather-forecast'].lastCompletedAt, 'the last completed fetch is recorded in MongoDB');
  assert.equal(rows['xweather-forecast'].lastStatus, 'ok');
  assert.ok(rows['alert-engine'].lastCompletedAt);
  assert.ok(rows['lightning-gate']);

  const again = await runAlertCycle({ nowMs: now + 30 * 60_000, client: api, budget: budget(), log: { error() {} } });
  assert.equal(again.fetched.forecast, undefined, 'nothing is due thirty minutes later');
  assert.equal(api.calls.filter((call) => call === 'forecasts').length, 2);

  const later = await runAlertCycle({ nowMs: now + 3 * HOUR + 60_000, client: api, budget: budget(), log: { error() {} } });
  assert.equal(later.fetched.forecast.fetched, 2, 'every three hours');
});

dbTest('only the busiest areas get an Xweather forecast, up to the cap', async () => {
  await farmerIn(BADDA);
  await farmerIn(BADDA);
  await farmerIn(SAVAR);
  assert.deepEqual(await topForecastAreas(10), [BADDA, SAVAR]);
  env.alerts.maxForecastAreas = 1;
  assert.deepEqual(await topForecastAreas(), [BADDA], 'the area with the most subscribers wins');
  assert.deepEqual(await topForecastAreas(0), []);

  const api = client();
  await runAlertCycle({ nowMs: Date.now(), client: api, budget: budget(), log: { error() {} } });
  assert.equal(api.calls.filter((call) => call === 'forecasts').length, 1);
});

dbTest('the area that has waited longest is refreshed first, and a failed area is retried after thirty minutes, not three hours', async () => {
  await farmerIn(BADDA);
  await farmerIn(SAVAR);
  const now = Date.now();
  await WeatherSnapshot.create({ provider: 'xweather', product: 'forecast-1hr', queryKey: `u:${BADDA}`, fetchedAt: new Date(now - 4 * HOUR), attemptedAt: new Date(now - 4 * HOUR), status: 'FRESH', data: { periods: [] }, expiresAt: new Date(now + HOUR) });
  await WeatherSnapshot.create({ provider: 'xweather', product: 'forecast-1hr', queryKey: `u:${SAVAR}`, fetchedAt: new Date(now - 5 * HOUR), attemptedAt: new Date(now - 5 * HOUR), status: 'FRESH', data: { periods: [] }, expiresAt: new Date(now + HOUR) });
  assert.deepEqual(await dueForecastAreas(now, [BADDA, SAVAR]), [SAVAR, BADDA], 'oldest first');

  await WeatherSnapshot.updateOne({ queryKey: `u:${BADDA}` }, { $set: { status: 'UNAVAILABLE', attemptedAt: new Date(now - 20 * 60_000) } });
  assert.deepEqual(await dueForecastAreas(now, [BADDA]), [], 'a failure 20 minutes ago is not retried yet');
  await WeatherSnapshot.updateOne({ queryKey: `u:${BADDA}` }, { $set: { attemptedAt: new Date(now - 31 * 60_000) } });
  assert.deepEqual(await dueForecastAreas(now, [BADDA]), [BADDA], 'but after thirty minutes it is');
});

dbTest('marine data is fetched for coastal and open-sea fishermen only, once per six hours', async () => {
  await fisherman(BADDA, 'river');
  const none = client();
  await runAlertCycle({ nowMs: Date.now(), client: none, budget: budget(), log: { error() {} } });
  assert.equal(none.calls.includes('maritime'), false, 'river fishermen need no sea data');

  await fisherman(COXS, 'coastal');
  const api = client();
  const now = Date.now();
  const first = await runAlertCycle({ nowMs: now, client: api, budget: budget(), log: { error() {} } });
  assert.equal(first.fetched.maritime.fetched, 1);
  assert.equal(api.calls.filter((call) => call === 'maritime').length, 1);
  const again = await runAlertCycle({ nowMs: now + 2 * HOUR, client: api, budget: budget(), log: { error() {} } });
  assert.equal(again.fetched.maritime, undefined, 'not due for six hours');
});

dbTest('with Xweather switched off, or no credentials, the cycle makes no request and the engine still runs', async () => {
  await farmerIn(BADDA);
  env.alerts.xweatherEnabled = false;
  const api = client();
  const off = await runAlertCycle({ nowMs: Date.now(), client: api, budget: budget(), log: { error() {} } });
  assert.equal(off.fetched, null);
  assert.equal(api.calls.length, 0);
  assert.equal(off.engine.status, 'ok');

  env.alerts.xweatherEnabled = true;
  const keyless = { ...client(), hasCredentials: () => false };
  const noKey = await runAlertCycle({ nowMs: Date.now(), client: keyless, budget: budget(), log: { error() {} } });
  assert.equal(noKey.fetched, null);
  assert.equal(keyless.calls.length, 0);
});

dbTest('a failing task is recorded, never thrown, and never moves the last-completed time', async () => {
  const outcome = await recordJob('demo-task', async () => ({ status: 'ok', n: 1 }));
  assert.equal(outcome.n, 1);
  const done = await JobState.findOne({ key: 'demo-task' }).lean();
  assert.equal(done.lastStatus, 'ok');
  assert.ok(done.lastCompletedAt);

  const original = console.error;
  console.error = () => {};
  try {
    const failed = await recordJob('demo-task', async () => { throw new Error('upstream exploded'); });
    assert.equal(failed.status, 'error');
  } finally {
    console.error = original;
  }
  const after = await JobState.findOne({ key: 'demo-task' }).lean();
  assert.equal(after.lastStatus, 'error');
  assert.equal(after.lastError, 'upstream exploded');
  assert.equal(String(after.lastCompletedAt), String(done.lastCompletedAt), 'a failure does not look like a fresh success');
});

dbTest('a lease lets only one worker run a cycle, and an expired lease can be taken over', async () => {
  const now = Date.now();
  assert.equal(await acquireLease('lease-demo', 60_000, now), true);
  assert.equal(await acquireLease('lease-demo', 60_000, now + 1000), false, 'held');
  assert.equal(await acquireLease('lease-demo', 60_000, now + 61_000), true, 'expired, so it can be taken over');
  await releaseLease('lease-demo');
  assert.equal(await acquireLease('lease-demo', 60_000, now + 62_000), true, 'released');
});

dbTest('source rows follow the recorded jobs: fresh after a run, stale when it is overdue, unavailable without credentials', async () => {
  const now = Date.now();
  await JobState.create({ key: 'xweather-forecast', lastCompletedAt: new Date(now - 60_000), lastStatus: 'ok' });
  await JobState.create({ key: 'xweather-maritime', lastCompletedAt: new Date(now - 20 * HOUR), lastStatus: 'ok' });
  await JobState.create({ key: 'lightning-gate', lastCompletedAt: new Date(now - 60_000), lastStatus: 'partial' });
  const original = { ...env.xweather };
  env.xweather.clientId = 'id';
  env.xweather.clientSecret = 'secret';
  try {
    const rows = Object.fromEntries((await sourceRows(now)).map((row) => [row.key, row]));
    assert.equal(rows['xweather-forecast'].status, 'FRESH');
    assert.equal(rows['xweather-maritime'].status, 'STALE', 'older than 18 hours');
    assert.equal(rows['lightning-gate'].status, 'PARTIAL');
    assert.equal(rows.bulletins.status, 'UNAVAILABLE', 'never checked');

    env.xweather.clientId = '';
    const offline = Object.fromEntries((await sourceRows(now)).map((row) => [row.key, row]));
    assert.equal(offline['xweather-forecast'].status, 'UNAVAILABLE');
    assert.equal(offline['xweather-forecast'].note, 'not-configured');
  } finally {
    Object.assign(env.xweather, original);
  }
});
