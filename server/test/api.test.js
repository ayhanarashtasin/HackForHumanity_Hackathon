import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { resetRadarForTests } from '../src/services/bmdRadar.js';
import { resetForTests, setSnapshot } from '../src/services/weatherStore.js';

const testUri = process.env.TEST_MONGODB_URI;
let server;
let baseUrl;

before(async () => {
  if (testUri) {
    await mongoose.connect(testUri, {
      dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      serverSelectionTimeoutMS: 5000,
    });
  }

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  try {
    if (testUri && mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
  } finally {
    await mongoose.disconnect();
  }
});

function request(path, method = 'GET', body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('health reports database readiness and per-source freshness, and unknown routes return JSON', async () => {
  const response = await request('/health');
  assert.equal(response.status, testUri ? 200 : 503);

  const health = await response.json();
  assert.equal(health.database, testUri ? 'connected' : 'disconnected');
  assert.deepEqual(Object.keys(health.sources).sort(), ['bmd', 'openMeteo', 'radar', 'satellite']);

  const missing = await request('/missing');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).message, 'API route not found.');
});

test('the weather snapshot is empty, not calm, before any source has loaded', async () => {
  resetForTests();

  const response = await request('/weather/snapshot');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);

  const { data } = await response.json();
  assert.equal(data.base, null);
  assert.deepEqual(data.steps, []);
  assert.equal(data.sources.bmd.status, 'not-checked');
});

test('the weather snapshot and daily endpoints serve the shared cached data', async () => {
  resetForTests();
  await setSnapshot('bmd', {
    sourceUpdatedAt: new Date().toISOString(),
    steps: ['2026-10-10T06:00:00+06:00'],
    locations: { 302604: { temp: [26.1] } },
    districts: { 3026: { temp: [26.2] } },
    daily: { days: ['2026-10-10T00:00:00Z'], locations: { 302604: { tmax: [31.3] } } },
  }, { dataTime: new Date().toISOString(), persistToDb: false });

  const snapshot = (await (await request('/weather/snapshot')).json()).data;
  assert.equal(snapshot.base, 'bmd');
  assert.equal(snapshot.locations['302604'].temp[0], 26.1);
  assert.equal(snapshot.sources.bmd.status, 'ok');

  const daily = (await (await request('/weather/daily')).json()).data;
  assert.equal(daily.source, 'bmd');
  assert.equal(daily.locations['302604'].tmax[0], 31.3);

  resetForTests();
});

test('radar frames report an empty, not-checked state and the image proxy rejects unknown or unsafe files', async () => {
  resetRadarForTests();

  const frames = (await (await request('/radar/frames')).json()).data;
  assert.deepEqual(frames.sites, []);
  assert.equal(frames.status.status, 'not-checked');

  assert.equal((await request('/radar/image/dhaka/nope.png')).status, 404);
  assert.equal((await request('/radar/image/dh4ka/nope.png')).status, 400);
  assert.equal((await request('/radar/image/dhaka/nope.jpg')).status, 400);
});

test('satellite frames respond even before the first refresh', async () => {
  const response = await request('/satellite/frames');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.layers, {});
});

test('malformed and oversized JSON return readable client errors', async () => {
  const malformed = await fetch(`${baseUrl}/missing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).message, 'Request body must contain valid JSON.');

  const oversized = await request('/missing', 'POST', { title: 'x'.repeat(11_000) });
  assert.equal(oversized.status, 413);
});
