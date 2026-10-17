import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getUserLocation, LOCATION_MAX_AGE_MS, pauseLocationAlerts, rememberUserPosition, requestUserLocation } from '../src/lib/userLocation.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
const originalFetch = globalThis.fetch;
const profile = { createdAt: '2026-10-17T00:00:00Z', areas: [{ role: 'home', upazilaPcode: '302604' }], currentArea: null };
const catalogue = { locations: [{ pcode: '302672', name: 'Savar' }], polygons: { savar: { name: 'Savar', src: ['302672'] } } };
const boundaries = { features: [{ properties: { pid: 'savar' }, geometry: { type: 'Polygon', coordinates: [[[90, 23], [91, 23], [91, 24], [90, 24], [90, 23]]] } }] };
let moduleId = 0;

afterEach(() => {
  pauseLocationAlerts();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  if (originalSecure) Object.defineProperty(globalThis, 'isSecureContext', originalSecure);
  else delete globalThis.isSecureContext;
  globalThis.fetch = originalFetch;
});

async function setup({ mine = profile, put, session } = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: {
    getCurrentPosition: (found) => found({ coords: { latitude: 23.85, longitude: 90.26, accuracy: 20 }, timestamp: Date.now() }),
  } } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/data/locations.json') return Response.json(catalogue);
    if (path === '/data/bd-upazila.geojson') return Response.json(boundaries);
    calls.push({ path, body: options.body && JSON.parse(options.body) });
    if (path === '/api/alerts/session') return session ? session() : Response.json({ data: { profile: mine } });
    assert.equal(path, '/api/alerts/me/current-area');
    assert.equal(options.method, 'PUT');
    assert.deepEqual(Object.keys(JSON.parse(options.body)), ['upazilaPcode'], 'precise coordinates never enter the API body');
    if (put) return put(JSON.parse(options.body));
    return Response.json({ data: { profile: { ...profile, currentArea: { upazilaPcode: JSON.parse(options.body).upazilaPcode } } } });
  };
  await requestUserLocation({ refresh: true });
  const sync = await import(`../src/alert/locationSync.js?test=${++moduleId}`);
  return { calls, ...sync };
}

test('entry capture and the alert page share one current-area write without replacing saved areas', async () => {
  const { calls, syncLocationArea } = await setup();
  const [entry, page] = await Promise.all([syncLocationArea(), syncLocationArea(profile)]);
  assert.equal(entry, page);
  assert.equal(entry.profile.currentArea.upazilaPcode, '302672');
  assert.deepEqual(profile.areas, [{ role: 'home', upazilaPcode: '302604' }]);
  await syncLocationArea(profile);
  assert.equal(calls.filter((call) => call.body).length, 1, 'navigation or effect replay cannot duplicate a save');
  assert.equal(getUserLocation().alertStatus, 'saved');
});

test('a visitor without a profile is not subscribed automatically; registration can reuse the capture', async () => {
  const { calls, syncLocationArea } = await setup({ mine: null });
  assert.equal(await syncLocationArea(), null);
  assert.equal(calls.some((call) => call.body), false);
  assert.ok(await syncLocationArea(profile));
  assert.equal(calls.filter((call) => call.body).length, 1);
});

test('active Telegram following is preserved, including a server-side race', async () => {
  const { calls, syncLocationArea } = await setup();
  const telegram = { ...profile, currentArea: { source: 'telegram', expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  assert.equal(await syncLocationArea(telegram), null);
  assert.equal(calls.length, 0);
  assert.equal(getUserLocation().alertStatus, 'telegram');
  const raced = await setup({ put: () => Response.json({ message: 'Telegram is following.' }, { status: 409 }) });
  assert.equal(await raced.syncLocationArea(profile), null);
  assert.equal(getUserLocation().alertStatus, 'telegram');
});

test('stopped, expired and live-followed positions never trigger an automatic one-time save', async () => {
  const { calls, syncLocationArea } = await setup();
  const captured = getUserLocation();
  rememberUserPosition(captured, Date.now() - LOCATION_MAX_AGE_MS, 'capture');
  assert.equal(await syncLocationArea(profile), null);
  rememberUserPosition(captured, Date.now(), 'live');
  assert.equal(await syncLocationArea(profile), null);
  pauseLocationAlerts();
  assert.equal(await syncLocationArea(profile), null);
  assert.equal(calls.length, 0);
});

test('a failed save reports an error and explicit retry succeeds without another GPS capture', async () => {
  let attempts = 0;
  const { syncLocationArea } = await setup({ put: () => ++attempts === 1
    ? Response.json({ message: 'unavailable' }, { status: 503 })
    : Response.json({ data: { profile } }) });
  const revision = getUserLocation().revision;
  await assert.rejects(syncLocationArea(profile), /unavailable/);
  assert.equal(getUserLocation().alertStatus, 'error');
  await syncLocationArea(profile);
  assert.equal(attempts, 2);
  assert.equal(getUserLocation().revision, revision);
  assert.equal(getUserLocation().alertStatus, 'saved');
});

test('retrying a profile-check failure clears the error without repeating an already successful save', async () => {
  let checks = 0;
  const { calls, syncLocationArea } = await setup({ session: () => ++checks === 1
    ? Response.json({ message: 'offline' }, { status: 503 })
    : Response.json({ data: { profile } }) });
  await syncLocationArea(profile);
  await assert.rejects(syncLocationArea(), /offline/);
  assert.equal(getUserLocation().alertStatus, 'error');
  await syncLocationArea();
  assert.equal(getUserLocation().alertStatus, 'saved');
  assert.equal(calls.filter((call) => call.body).length, 1);
});

test('stop is ordered after in-flight saves and cannot be undone by navigation or delayed responses', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { calls, syncLocationArea, stopLocationArea } = await setup({ put: async ({ upazilaPcode }) => {
    if (upazilaPcode) { started.resolve(); await release.promise; }
    return Response.json({ data: { profile: { ...profile, currentArea: upazilaPcode ? { upazilaPcode } : null } } });
  } });
  const saving = syncLocationArea(profile);
  await started.promise;
  const stopped = stopLocationArea();
  assert.equal(await syncLocationArea(profile), null);
  release.resolve();
  await saving;
  assert.equal((await stopped).profile.currentArea, null);
  assert.deepEqual(calls.map((call) => call.body), [{ upazilaPcode: '302672' }, { upazilaPcode: null }]);
  assert.equal(getUserLocation().alertStatus, 'idle');
});

test('stopping while the profile lookup is pending prevents a later automatic write', async () => {
  const response = Promise.withResolvers();
  const { calls, syncLocationArea } = await setup({ session: () => response.promise });
  const saving = syncLocationArea();
  pauseLocationAlerts();
  response.resolve(Response.json({ data: { profile } }));
  assert.equal(await saving, null);
  assert.deepEqual(calls.map((call) => call.path), ['/api/alerts/session']);
});
