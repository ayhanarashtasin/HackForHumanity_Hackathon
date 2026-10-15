import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, afterEach, before, test } from 'node:test';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { getStormDemo, getStorms, refreshStorms, resetStormsForTests } from '../src/services/stormTracking.js';

const ML_URL = 'http://ml.test';
const FRAME = '2026-09-22T09:00:00Z';
const SNAPSHOT = { source: 'live', observedAt: FRAME, frames: [FRAME], motionMinutes: 20, cells: [{ id: 'c1', intensity: 6, reaches: [] }] };
const savedUrl = env.alerts.mlServiceUrl;
let server;
let baseUrl;

function fakeFetch(body, { ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok, status: ok ? 200 : 502, json: async () => body };
  };
  return { fetchImpl, calls };
}

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => new Promise((resolve) => server.close(resolve)));

afterEach(() => {
  env.alerts.mlServiceUrl = savedUrl;
  resetStormsForTests();
});

test('without the ML service the storm job does nothing', async () => {
  env.alerts.mlServiceUrl = '';
  const { fetchImpl, calls } = fakeFetch(SNAPSHOT);
  assert.equal(await refreshStorms({ fetchImpl, frameTime: FRAME }), null);
  assert.equal(calls.length, 0);
  assert.equal(getStorms().enabled, false);
});

test('the newest frame is analysed once and kept', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const { fetchImpl, calls } = fakeFetch(SNAPSHOT);
  await refreshStorms({ fetchImpl, frameTime: FRAME });
  await refreshStorms({ fetchImpl, frameTime: FRAME });
  assert.deepEqual(calls, [`${ML_URL}/storms/snapshot?time=${encodeURIComponent(FRAME)}`], 'the same frame is not analysed twice');
  assert.equal(getStorms().live.cells[0].id, 'c1');
  assert.equal(getStorms().error, null);
});

test('a failed analysis keeps the previous snapshot and records why', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  await refreshStorms({ fetchImpl: fakeFetch(SNAPSHOT).fetchImpl, frameTime: FRAME });
  await assert.rejects(refreshStorms({ fetchImpl: fakeFetch({}, { ok: false }).fetchImpl, frameTime: '2026-09-22T09:10:00Z' }));
  assert.equal(getStorms().live.observedAt, FRAME);
  assert.match(getStorms().error, /502/);
  await assert.rejects(refreshStorms({ fetchImpl: fakeFetch({ cells: 'nope' }).fetchImpl, frameTime: '2026-09-22T09:20:00Z' }), /unexpected/);
});

test('the replay points its images at this API and drops unexpected names', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const demo = { day: '2026-09-22', bounds: { north: 28, south: 19, west: 86, east: 95 }, snapshots: [
    { ...SNAPSHOT, image: '2026-09-22T090000Z.png' },
    { ...SNAPSHOT, image: '../../app.py' },
  ] };
  const result = await getStormDemo({ fetchImpl: fakeFetch(demo).fetchImpl });
  assert.equal(result.snapshots[0].image, '/api/storms/demo/image/2026-09-22T090000Z.png');
  assert.equal(result.snapshots[1].image, null);
});

test('GET /api/storms answers even before the first analysis', async () => {
  const response = await fetch(`${baseUrl}/storms`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['checkedAt', 'enabled', 'error', 'live']);
  assert.equal(data.live, null);
});

test('the replay image route rejects names that are not demo frames', async () => {
  const response = await fetch(`${baseUrl}/storms/demo/image/..%2F..%2Fapp.py`);
  assert.equal(response.status, 404);
});
