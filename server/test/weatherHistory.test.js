import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { WeatherRun } from '../src/models/WeatherRun.js';
import {
  isDistrictCode, listRuns, recordRun, runIdFor, summarizeRun,
} from '../src/services/weatherHistory.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const DAY = 86_400_000;
const DHAKA = '3026';

// A district payload as aggregate.js builds it: means, *Max columns and the Open-Meteo extras, aligned to `steps`.
function forecast({ updatedAt = '2026-10-10T13:15:12.215', rain = [0, 1.5, 2, 0, 0, 0, 0, 0, 4, 0] } = {}) {
  const steps = rain.map((_, i) => `2026-10-10T${String(i * 3 % 24).padStart(2, '0')}:00:00+06:00`);
  return {
    sourceUpdatedAt: updatedAt,
    steps,
    districts: {
      [DHAKA]: {
        temp: rain.map(() => 30), tempMax: rain.map((_, i) => 31 + (i === 2 ? 3 : 0)),
        hi: rain.map(() => 36), hiMax: rain.map((_, i) => 38 + (i === 2 ? 4 : 0)),
        rh: rain.map(() => 80), rf: rain, rfMax: rain.map((value) => value * 2),
        ws: rain.map(() => 10), wsMax: rain.map(() => 15), wg: rain.map(() => 20), wgMax: rain.map((_, i) => 30 + (i === 1 ? 25 : 0)),
        pop: rain.map((value) => (value ? 70 : 10)), ts: rain.map((_, i) => (i === 1 ? 2 : 0)),
      },
    },
  };
}

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await WeatherRun.init();
});

beforeEach(async () => {
  if (testUri) await WeatherRun.deleteMany({});
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

test('a run is summarised per district for the next 24 hours and for the whole horizon', () => {
  const summary = summarizeRun(forecast());
  const { w24, all } = summary[DHAKA];

  // The first 8 steps are 24 hours; the 9th (rain 4) is only in the whole-run window.
  assert.equal(w24.rf, 3.5);
  assert.equal(all.rf, 7.5);
  assert.equal(w24.t, 34); // the hottest upazila, not the district mean
  assert.equal(w24.hi, 42);
  assert.equal(w24.wg, 55);
  assert.equal(w24.rh, 80);
  assert.equal(w24.pop, 70);
  assert.equal(w24.ts, 2);
  assert.equal(all.rfx, 8);
});

test('a missing value stays missing instead of becoming zero, and an empty run summarises to nothing', () => {
  const data = forecast();
  delete data.districts[DHAKA].pop;
  delete data.districts[DHAKA].ts;
  const { all } = summarizeRun(data)[DHAKA];
  assert.equal('pop' in all, false);
  assert.equal('ts' in all, false);

  assert.deepEqual(summarizeRun({ steps: [], districts: {} }), {});
  assert.deepEqual(summarizeRun(null), {});

  // Null-only columns are not written as 0.
  const hollow = { steps: ['a', 'b'], districts: { [DHAKA]: { rf: [null, null], tempMax: [null, null] } } };
  assert.deepEqual(summarizeRun(hollow), {});
});

test('BMD runs are identified by the provider run time, Open-Meteo by the fetch time', () => {
  assert.equal(runIdFor('bmd', { sourceUpdatedAt: '2026-10-10T13:15:12.215' }, new Date(0)), '2026-10-10T13:15:12.215');
  assert.equal(runIdFor('openMeteo', {}, new Date('2026-10-10T10:00:00Z')), '2026-10-10T10:00:00.000Z');
  assert.equal(isDistrictCode(DHAKA), true);
  assert.equal(isDistrictCode('999999'), false);
});

dbTest('recording the same run twice stores it once, and a new run adds a row', async () => {
  const at = new Date('2026-10-10T13:20:00Z');
  const first = await recordRun('bmd', forecast(), { fetchedAt: at, retentionDays: 30 });
  const again = await recordRun('bmd', forecast(), { fetchedAt: new Date(+at + 60_000), retentionDays: 30 });
  assert.equal(first.inserted, true);
  assert.equal(again.inserted, false);
  assert.equal(await WeatherRun.countDocuments(), 1);

  await recordRun('bmd', forecast({ updatedAt: '2026-10-10T19:15:00.000' }), { fetchedAt: new Date(+at + 6 * 3_600_000), retentionDays: 30 });
  assert.equal(await WeatherRun.countDocuments(), 2);

  const stored = await WeatherRun.findOne({ runId: '2026-10-10T13:15:12.215' }).lean();
  assert.equal(stored.steps, 10);
  assert.equal(+stored.expiresAt, +at + 30 * DAY);
  // ~20 KB per run, not the multi-MB full forecast
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 20_000);
});

dbTest('history can be switched off and never throws when the write fails', async () => {
  assert.equal(await recordRun('bmd', forecast(), { retentionDays: 0 }), null);
  assert.equal(await WeatherRun.countDocuments(), 0);
  assert.equal(await recordRun('bmd', { steps: [], districts: {} }, { retentionDays: 30 }), null);
});

dbTest('listRuns returns newest first inside the window, for one district or all', async () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  await recordRun('bmd', forecast({ updatedAt: 'old' }), { fetchedAt: new Date(now - 9 * DAY), retentionDays: 60 });
  await recordRun('bmd', forecast({ updatedAt: 'a' }), { fetchedAt: new Date(now - 2 * DAY), retentionDays: 60 });
  await recordRun('bmd', forecast({ updatedAt: 'b' }), { fetchedAt: new Date(now - DAY), retentionDays: 60 });
  await recordRun('openMeteo', forecast(), { fetchedAt: new Date(now - DAY), retentionDays: 60 });

  const runs = await listRuns({ source: 'bmd', district: DHAKA, days: 7, now });
  assert.deepEqual(runs.map((run) => run.runId), ['b', 'a']);
  assert.equal(runs[0].summary.w24.rf, 3.5);

  const all = await listRuns({ source: 'bmd', days: 7, now });
  assert.ok(all[0].districts[DHAKA]);
  assert.equal((await listRuns({ source: 'openMeteo', days: 7, now })).length, 1);
});

dbTest('GET /api/weather/history validates its input and reads only stored runs', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/weather/history`;

  try {
    await recordRun('bmd', forecast(), { fetchedAt: new Date(), retentionDays: 30 });

    const ok = await fetch(`${base}?district=${DHAKA}&days=3`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()).data;
    assert.equal(body.count, 1);
    assert.equal(body.runs[0].summary.all.rf, 7.5);

    assert.equal((await fetch(`${base}?source=nope`)).status, 400);
    assert.equal((await fetch(`${base}?district=000000`)).status, 400);
    assert.equal((await fetch(`${base}?days=0`)).status, 400);
    assert.equal((await fetch(`${base}?days=61`)).status, 400);
    assert.equal((await fetch(`${base}?days=abc`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
