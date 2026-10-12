import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postRouteWeather } from '../src/controllers/routeWeatherController.js';
import { buildRouteWeather, routeWeatherInternals } from '../src/services/routeWeather.js';

const locations = [
  { pcode: '100001', name: 'Savar', kind: 'upazila', district: '1000', lat: 23.85, lon: 90.25 },
  { pcode: '100002', name: 'Dhaka', kind: 'thana', district: '1000', lat: 23.78, lon: 90.41 },
];

const routePayload = {
  code: 'Ok',
  routes: [{
    distance: 31_200,
    duration: 3_600,
    geometry: { coordinates: [[90.25, 23.85], [90.33, 23.82], [90.41, 23.78]] },
  }],
};

test('route sample points cover both ends and stay within the route', () => {
  const points = routeWeatherInternals.routeSamples(routePayload.routes[0].geometry.coordinates);
  assert.ok(points.length >= 2);
  assert.deepEqual(points[0].coordinates, [90.25, 23.85]);
  assert.deepEqual(points.at(-1).coordinates, [90.41, 23.78]);
  assert.ok(points.every((point) => point.progress >= 0 && point.progress <= 1));
});

test('route weather calls fastest driving route and returns route and weather coverage', async () => {
  const calls = [];
  const forecast = {
    nowMs: 0,
    base: 'bmd',
    baseRaw: { steps: [new Date(0).toISOString()], locations: Object.fromEntries(locations.map((item) => [item.pcode, {
      temp: [31], hi: [36], rf: [8], wg: [22],
    }])) },
    stepsMs: [0],
    bmd: { info: { status: 'ok' } },
    openMeteo: {
      raw: { steps: [new Date(0).toISOString()], locations: Object.fromEntries(locations.map((item) => [item.pcode, { pop: [75], ts: [2] }])) },
      info: { status: 'ok' },
    },
  };
  const result = await buildRouteWeather({
    start: { name: 'Savar', lat: 23.85, lon: 90.25 },
    end: { name: 'Dhaka', lat: 23.78, lon: 90.41 },
    nowMs: 0,
    forecast,
    locationList: locations,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => routePayload };
    },
  });

  assert.match(calls[0].url, /route\/v1\/driving/);
  assert.equal(result.distanceKm, 31.2);
  assert.equal(result.durationMinutes, 60);
  assert.equal(result.summary.coveredCount, result.samples.length);
  assert.equal(result.summary.maxHeatIndexC, 36);
  assert.equal(result.summary.maxRainMm, 8);
  assert.equal(result.summary.rainUnitUnverified, true);
  assert.equal(result.summary.maxThunderPotential, 2);
});

test('route weather rejects same, out-of-country and missing-road routes', async () => {
  const start = { lat: 23.85, lon: 90.25 };
  await assert.rejects(buildRouteWeather({ start, end: start, fetchImpl: async () => assert.fail('must not fetch') }), /different/);
  await assert.rejects(buildRouteWeather({ start: { lat: 40, lon: -73 }, end: start, fetchImpl: async () => assert.fail('must not fetch') }), /Bangladesh/);
  await assert.rejects(buildRouteWeather({ start, end: { lat: 23.78, lon: 90.41 }, fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'NoRoute', routes: [] }) }) }), /No road route/);
});

test('route API returns a client error for missing or identical places without contacting routing', async () => {
  const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const missing = response();
  await postRouteWeather({ body: {} }, missing);
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.message, /Bangladesh/);

  const same = response();
  const start = { lat: 23.85, lon: 90.25 };
  await postRouteWeather({ body: { start, end: start } }, same);
  assert.equal(same.statusCode, 400);
  assert.match(same.body.message, /different/);
});