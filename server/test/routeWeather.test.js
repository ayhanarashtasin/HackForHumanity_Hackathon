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
    distance: 45_000,
    duration: 2_700,
    geometry: { coordinates: [[90.25, 23.85], [90.32, 23.83], [90.41, 23.78]] },
  }, {
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

test('route weather chooses the shortest OSRM candidate and returns route and weather coverage', async () => {
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
  assert.match(calls[0].url, /alternatives=3/);
  assert.equal(result.distanceKm, 31.2);
  assert.equal(result.durationMinutes, 60);
  assert.equal(result.routeCandidates, 2);
  assert.equal(result.routeChoice, 'shortest-distance-among-osrm-options');
  assert.equal(result.summary.coveredCount, result.samples.length);
  assert.equal(result.summary.maxHeatIndexC, 36);
  assert.equal(result.summary.maxRainMm, 8);
  assert.equal(result.summary.rainUnitUnverified, true);
  assert.equal(result.summary.maxThunderPotential, 2);

  // The longer candidate is offered as an alternative with its own weather along it.
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0].distanceKm, 45);
  assert.equal(result.alternatives[0].durationMinutes, 45);
  assert.deepEqual(result.alternatives[0].coordinates, routePayload.routes[0].geometry.coordinates);
  assert.equal(result.alternatives[0].summary.maxHeatIndexC, 36);
});

test('when OSRM finds one road, routes through side points are added if they are different roads and not a long detour', async () => {
  const route = (km, coordinates) => ({ distance: km * 1000, duration: km * 90, geometry: { coordinates } });
  const direct = route(30, [[90.25, 23.85], [90.33, 23.815], [90.41, 23.78]]);
  const north = route(36, [[90.25, 23.85], [90.33, 23.9], [90.41, 23.78]]); // a different road
  const sameRoad = route(31, direct.geometry.coordinates); // the direct road again
  const longWay = route(60, [[90.25, 23.85], [90.33, 23.7], [90.41, 23.78]]); // over 50% longer
  const calls = [];
  const result = await buildRouteWeather({
    start: { name: 'Savar', lat: 23.85, lon: 90.25 },
    end: { name: 'Dhaka', lat: 23.78, lon: 90.41 },
    nowMs: 0,
    forecast: { nowMs: 0, base: null, stepsMs: [] },
    locationList: locations,
    fetchImpl: async (url) => {
      calls.push(url);
      const viaCall = url.split('/driving/')[1].split('?')[0].split(';').length === 3;
      const routes = !viaCall ? [direct] : calls.length === 2 ? [north, sameRoad] : [longWay];
      return { ok: true, json: async () => ({ code: 'Ok', routes }) };
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((url) => !url.includes('alternatives')));
  assert.equal(result.distanceKm, 30);
  assert.deepEqual(result.alternatives.map((option) => option.distanceKm), [36]);
  assert.equal(result.routeCandidates, 2);
});

test('side points for extra routes lie either side of the straight line and inside Bangladesh', () => {
  const vias = routeWeatherInternals.viaPoints({ lat: 23.81, lon: 90.41 }, { lat: 22.36, lon: 91.83 });
  assert.equal(vias.length, 2);
  assert.ok(vias.every(routeWeatherInternals.validPoint));
  assert.notDeepEqual(vias[0], vias[1]);
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