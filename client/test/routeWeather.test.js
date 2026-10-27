import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactRoute, refreshRouteWeather, routeForecastIndex, routeForecastStatus, routeMapPoint, stopWeather,
} from '../src/lib/routeWeather.js';

test('the road sent to the hospital search is thinned and rounded but keeps its ends and shape', () => {
  // 2,000 points about 11 m apart along ~22 km.
  const road = Array.from({ length: 2000 }, (_, i) => [90.4 + i * 0.0001 + 1e-9, 23.7 + i * 0.00005]);
  const compact = compactRoute(road);
  assert.ok(compact.length < 300, `${compact.length} points`);
  assert.deepEqual(compact[0], [90.4, 23.7]);
  assert.deepEqual(compact.at(-1), [Math.round(road.at(-1)[0] * 1e5) / 1e5, Math.round(road.at(-1)[1] * 1e5) / 1e5]);
  assert.ok(compact.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(road).length / 5);
  assert.deepEqual(compactRoute([[90, 23], [91, 24]]), [[90, 23], [91, 24]]);
  assert.deepEqual(compactRoute([]), []);
});

const steps = ['2026-10-17T00:00:00Z', '2026-10-17T03:00:00Z'];
const snapshot = {
  steps, base: 'bmd', thunderSource: 'open-meteo',
  sources: { bmd: { status: 'ok' }, openMeteo: { status: 'ok' }, radar: { status: 'unavailable' } },
  locations: { U1: { temp: [25, 30], hi: [27, 33], rf: [0, 2], pop: [10, 70], wg: [8, 20], ts: [0, 2] } },
};
const catalogue = { locations: [{ pcode: 'U1', name: 'Town' }], districts: [], polygons: {} };

test('arrival forecasts use the containing forecast step, but never extrapolate outside its window', () => {
  assert.equal(routeForecastIndex(steps, Date.parse('2026-10-17T02:59:00Z')), 0);
  assert.equal(routeForecastIndex(steps, Date.parse('2026-10-17T03:00:00Z')), 1);
  for (const time of ['2026-10-16T23:59:00Z', '2026-10-17T06:00:00Z']) assert.equal(routeForecastIndex(steps, Date.parse(time)), -1);
  assert.equal(routeForecastIndex([], Date.now()), -1);
  assert.equal(routeForecastIndex(['invalid'], Date.now()), -1);
  const parent = { level: 'upazila', id: 'U1', progress: 1 };
  const route = { places: { checkedAt: Date.parse(steps[0]) }, result: { durationMinutes: 200 } };
  assert.equal(stopWeather(parent, route, snapshot, catalogue, 'en').temp, 30);
  assert.equal(stopWeather(parent, { ...route, result: { durationMinutes: 400 } }, snapshot, catalogue, 'en').temp, null);
});

test('forecast refresh updates route samples/summary without changing geometry or inventing missing weather', () => {
  const route = { coordinates: [[90, 23], [91, 24]], samples: [
    { place: { id: 'U1' }, etaMs: Date.parse(steps[0]), temperatureC: 99 },
    { place: { id: 'U1' }, etaMs: Date.parse(steps[1]), temperatureC: 99 },
    { place: null, etaMs: null },
  ], summary: {} };
  const refreshed = refreshRouteWeather(route, snapshot);
  assert.equal(refreshed.coordinates, route.coordinates);
  assert.equal(refreshed.summary.maxTemperatureC, 30);
  assert.equal(refreshed.summary.maxRainMm, 2);
  assert.equal(refreshed.summary.maxRainChancePct, 70);
  assert.equal(refreshed.summary.coveredCount, 2);
  assert.equal(refreshed.summary.forecastStatus, 'partial');
  assert.equal(refreshed.samples[2].rainMm, null);
  assert.equal(route.samples[0].temperatureC, 99);
  assert.equal(refreshRouteWeather(route, null), route);
  assert.equal(refreshRouteWeather(route, { ...snapshot, locations: {} }).summary.maxTemperatureC, null);
  assert.equal(refreshRouteWeather(route, { ...snapshot, thunderSource: null }).summary.maxThunderPotential, null);
});

test('only route forecast sources affect freshness, not unavailable radar or satellite', () => {
  assert.equal(routeForecastStatus(snapshot), 'ok');
  assert.equal(routeForecastStatus({ ...snapshot, sources: { ...snapshot.sources, bmd: { status: 'stale' } } }), 'partial');
  assert.equal(routeForecastStatus({ steps: [] }), 'unavailable');
  assert.equal(routeForecastStatus({ ...snapshot, base: 'open-meteo', sources: { openMeteo: { status: 'ok' } } }), 'ok');
});

test('map points stay on the road, regional markers at entry and local endpoints at A/B', () => {
  const coordinates = [[90, 23], [91, 24]];
  assert.deepEqual(routeMapPoint({ point: [0, 0] }, 0, 2, coordinates), coordinates[0]);
  assert.deepEqual(routeMapPoint({ point: [0, 0] }, 1, 2, coordinates), coordinates[1]);
  assert.deepEqual(routeMapPoint({ point: [90.5, 23.5] }, 1, 3, coordinates), [90.5, 23.5]);
  assert.deepEqual(routeMapPoint({ stops: [{ point: [90.5, 23.5] }] }, 1, 2, coordinates), [90.5, 23.5]);
  assert.deepEqual(routeMapPoint({ stops: [{ point: [90.5, 23.5] }] }, 0, 2, coordinates), coordinates[0], 'the first district or division is marked on the road start');
});
