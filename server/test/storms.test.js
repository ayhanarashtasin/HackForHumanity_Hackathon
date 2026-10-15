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

// A fake ML service: a frame in `published` gets a snapshot of that frame, any other frame a 404 ("not published yet").
function fakeMl(published) {
  const asked = [];
  const fetchImpl = async (url) => {
    const time = new URL(url).searchParams.get('time');
    asked.push(time);
    return published.includes(time)
      ? { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, observedAt: time, frames: [time] }) }
      : { ok: false, status: 404, json: async () => ({ detail: 'frame not published yet' }) };
  };
  return { fetchImpl, asked };
}

const later = (minutes) => new Date(Date.parse(FRAME) + minutes * 60_000).toISOString().replace('.000Z', 'Z');

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

test('each frame is analysed once, and the next one is picked up without waiting for the satellite list', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const published = [FRAME];
  const { fetchImpl, asked } = fakeMl(published);
  const now = Date.parse(FRAME) + 60 * 60_000;
  await refreshStorms({ fetchImpl, frameTime: FRAME, now });
  await refreshStorms({ fetchImpl, frameTime: FRAME, now });
  assert.equal(asked.filter((time) => time === FRAME).length, 1, 'the same frame is not analysed twice');
  assert.equal(getStorms().live.observedAt, FRAME);

  // The list still names FRAME (it is refreshed only every 30 minutes), but the next frame is now published.
  published.push(later(10));
  await refreshStorms({ fetchImpl, frameTime: FRAME, now });
  assert.equal(getStorms().live.observedAt, later(10));
  assert.equal(getStorms().live.cells[0].id, 'c1');
  assert.equal(getStorms().error, null);
});

test('frames that cannot exist yet are not asked for', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const { fetchImpl, asked } = fakeMl([FRAME]);
  await refreshStorms({ fetchImpl, frameTime: FRAME, now: Date.parse(FRAME) + 15 * 60_000 });
  assert.deepEqual(asked, [FRAME, later(10)]);
});

test('without a satellite list the job starts 30 minutes ago', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const { fetchImpl, asked } = fakeMl([]);
  await refreshStorms({ fetchImpl, frameTime: undefined, now: Date.parse(FRAME) + 30 * 60_000 + 5_000 });
  assert.deepEqual(asked, [FRAME, later(10)]);
});

test('a frame the satellite skipped does not stop the job, and it catches up in one run', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const { fetchImpl } = fakeMl([FRAME, later(20), later(30), later(40)]);
  await refreshStorms({ fetchImpl, frameTime: FRAME, now: Date.parse(FRAME) + 3 * 3_600_000 });
  assert.equal(getStorms().live.observedAt, later(40));
});

test('the job jumps to the listed frame when it has fallen far behind', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  await refreshStorms({ fetchImpl: fakeMl([FRAME]).fetchImpl, frameTime: FRAME, now: Date.parse(FRAME) + 30 * 60_000 });
  const { fetchImpl, asked } = fakeMl([later(180)]);
  await refreshStorms({ fetchImpl, frameTime: later(180), now: Date.parse(FRAME) + 200 * 60_000 });
  assert.equal(asked[0], later(180), 'the hours in between are not walked through');
  assert.equal(getStorms().live.observedAt, later(180));
});

test('an older ML service that answers a missing frame with the one before it is not taken for the new frame', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  await refreshStorms({ fetchImpl: fakeFetch(SNAPSHOT).fetchImpl, frameTime: FRAME, now: Date.parse(FRAME) + 60 * 60_000 });
  assert.equal(getStorms().live.observedAt, FRAME);
  assert.equal(getStorms().error, null);
});

test('a failed analysis keeps the previous snapshot and records why', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  await refreshStorms({ fetchImpl: fakeFetch(SNAPSHOT).fetchImpl, frameTime: FRAME });
  await assert.rejects(refreshStorms({ fetchImpl: fakeFetch({}, { ok: false }).fetchImpl, frameTime: '2026-09-22T09:10:00Z' }));
  assert.equal(getStorms().live.observedAt, FRAME);
  assert.match(getStorms().error, /502/);
  await assert.rejects(refreshStorms({ fetchImpl: fakeFetch({ cells: 'nope' }).fetchImpl, frameTime: '2026-09-22T09:20:00Z' }), /unexpected/);
  // The job runs every few minutes: the same error again is recorded but not thrown (and logged) again.
  await refreshStorms({ fetchImpl: fakeFetch({ cells: 'nope' }).fetchImpl, frameTime: '2026-09-22T09:20:00Z' });
  assert.match(getStorms().error, /unexpected/);
  assert.equal(getStorms().live.observedAt, FRAME);
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

test('GET /api/storms gives the live picture through this API and the places a storm warning applies to, counted from now', async () => {
  env.alerts.mlServiceUrl = ML_URL;
  const frame = new Date(Math.floor(Date.now() / 600_000) * 600_000 - 10 * 60_000).toISOString().replace('.000Z', 'Z');
  const name = `${frame.replaceAll(':', '').slice(0, -1)}Z.png`; // 2026-10-15T18:20:00Z -> 2026-10-15T182000Z.png
  const snapshot = {
    source: 'live', observedAt: frame, frames: [frame], motionMinutes: 20,
    image: { name, bounds: { north: 28, south: 19, west: 86, east: 95 } },
    cells: [{ id: 'c1', intensity: 6, trend: 'growing', motion: { speedKmh: 25, towards: 'S' }, reaches: [{ pcode: '302604', etaMin: 40 }] }],
  };
  const fetchImpl = async (url) => (url.includes(`time=${encodeURIComponent(frame)}`)
    ? { ok: true, status: 200, json: async () => snapshot }
    : { ok: false, status: 404, json: async () => ({}) });
  await refreshStorms({ fetchImpl, frameTime: frame });

  const { data } = await (await fetch(`${baseUrl}/storms`)).json();
  assert.deepEqual(data.live.image, { url: `/api/storms/image/${name}`, bounds: snapshot.image.bounds });
  assert.deepEqual(data.live.arrivals.map((arrival) => arrival.pcode), ['302604']);
  assert.ok(data.live.arrivals[0].minutesFromNow > 0 && data.live.arrivals[0].minutesFromNow <= 40);
  assert.ok(Date.parse(data.live.arrivalsAt) <= Date.now());
});

test('the live picture route rejects names that are not frame names', async () => {
  for (const bad of ['..%2F..%2Fapp.py', 'latest.png', '2026-10-15T182000Z.jpg']) {
    assert.equal((await fetch(`${baseUrl}/storms/image/${bad}`)).status, 404, bad);
  }
});

test('the replay image route rejects names that are not demo frames', async () => {
  const response = await fetch(`${baseUrl}/storms/demo/image/..%2F..%2Fapp.py`);
  assert.equal(response.status, 404);
});
