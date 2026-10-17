import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
const originalFetch = globalThis.fetch;
const catalogue = {
  locations: [{ pcode: '302672', name: 'Savar', district: '3026', lat: 23.85, lon: 90.26 }],
  polygons: { savar: { name: 'Savar', src: ['302672'] } },
};
const boundaries = { features: [{ properties: { pid: 'savar' }, geometry: {
  type: 'Polygon', coordinates: [[[90, 23], [91, 23], [91, 24], [90, 24], [90, 23]]],
} }] };
const coords = { latitude: 23.85, longitude: 90.26, accuracy: 30 };
let moduleId = 0;

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  if (originalSecure) Object.defineProperty(globalThis, 'isSecureContext', originalSecure);
  else delete globalThis.isSecureContext;
  globalThis.fetch = originalFetch;
});

function browser(getCurrentPosition = (found) => found({ coords, timestamp: Date.now() })) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: { getCurrentPosition } } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  const paths = [];
  globalThis.fetch = async (path) => {
    paths.push(path);
    assert.ok(['/data/locations.json', '/data/bd-upazila.geojson'].includes(path), 'only local geography is fetched, never coordinates');
    return Response.json(path === '/data/locations.json' ? catalogue : boundaries);
  };
  return paths;
}

const freshModule = () => import(`../src/lib/userLocation.js?test=${++moduleId}`);

test('location starts idle without requesting permission; concurrent consumers and navigation reuse one capture', async () => {
  let deliver;
  let requests = 0;
  const paths = browser((found, failed, options) => {
    requests++;
    assert.equal(options.timeout, 15_000);
    deliver = found;
  });
  const location = await freshModule();
  assert.equal(location.getUserLocation().status, 'idle');
  assert.equal(requests, 0);
  const changes = [];
  const unsubscribe = location.subscribeUserLocation(() => changes.push(location.getUserLocation().status));
  const map = location.requestUserLocation();
  const alert = location.requestUserLocation();
  assert.equal(map, alert);
  assert.equal(requests, 1);
  deliver({ coords, timestamp: Date.now() });
  const ready = await map;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.pcode, '302672');
  assert.deepEqual(ready.match.selection, { level: 'upazila', id: '302672' });
  assert.equal(ready.alertsEnabled, true);
  assert.deepEqual(changes, ['locating', 'resolving', 'ready']);
  unsubscribe();
  assert.equal(await location.requestUserLocation(), ready);
  assert.equal(requests, 1);
  assert.deepEqual(paths.sort(), ['/data/bd-upazila.geojson', '/data/locations.json']);
});

test('denial and timeout never retry automatically, and an explicit retry can recover', async () => {
  let requests = 0;
  browser((found, failed) => {
    requests++;
    if (requests < 3) failed({ code: requests === 1 ? 1 : 3 });
    else found({ coords });
  });
  const location = await freshModule();
  assert.equal((await location.requestUserLocation()).status, 'denied');
  assert.equal(requests, 1);
  assert.match((await location.requestUserLocation()).message, /too long/);
  assert.equal(requests, 2);
  assert.equal((await location.requestUserLocation()).status, 'ready');
});

test('unsupported and insecure browsers leave manual selection available without a GPS request', async () => {
  browser(() => assert.fail('GPS must not be requested'));
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
  const location = await freshModule();
  assert.equal((await location.requestUserLocation()).status, 'unsupported');
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  assert.equal((await location.requestUserLocation()).status, 'unsupported');
});

test('outside, imprecise and invalid positions cannot become current alert areas', async () => {
  for (const [position, status] of [
    [{ latitude: 0, longitude: 0, accuracy: 10 }, 'outside'],
    [{ ...coords, accuracy: 10_001 }, 'inaccurate'],
    [{ ...coords, latitude: NaN }, 'error'],
    [{ ...coords, accuracy: -1 }, 'error'],
  ]) {
    browser((found) => found({ coords: position }));
    const location = await freshModule();
    const result = await location.requestUserLocation();
    assert.equal(result.status, status);
    assert.equal(result.pcode, null);
    assert.equal(location.locationIsFresh(), false);
  }
});

test('failed geography loads can be retried and old or future positions are never fresh', async () => {
  browser();
  globalThis.fetch = async () => new Response('', { status: 503 });
  const location = await freshModule();
  assert.equal((await location.requestUserLocation()).status, 'error');
  browser();
  const ready = await location.requestUserLocation();
  assert.equal(ready.status, 'ready');
  assert.equal(location.locationIsFresh({ ...ready, locatedAt: Date.now() - location.LOCATION_MAX_AGE_MS }), false);
  assert.equal(location.locationIsFresh({ ...ready, locatedAt: Date.now() + 60_000 }), false);
  assert.equal(location.locationIsFresh(ready), true);
});

test('a late one-time lookup cannot overwrite a newer live position, and stopping keeps coordinates local', async () => {
  let deliver;
  browser((found) => { deliver = found; });
  const location = await freshModule();
  const request = location.requestUserLocation();
  const live = location.rememberUserPosition({ position: { lat: 23.8, lon: 90.3, accuracy: 10 }, match: { selection: { level: 'upazila', id: '302672' } }, pcode: '302672' });
  deliver({ coords });
  assert.equal(await request, live);
  location.pauseLocationAlerts();
  assert.equal(location.getUserLocation().alertsEnabled, false);
  assert.equal(location.getUserLocation().position, live.position, 'stopping alert use does not discard the map position');
});

test('fresh location survives across session storage and restores without a new capture', async () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = { sessionStorage: mockStorage };
  try {
    browser();
    const loc1 = await freshModule();
    const ready = await loc1.requestUserLocation();
    assert.equal(ready.status, 'ready');
    assert.ok(store.has('akashsathi:user-location'));

    // Next page load in same session restores location without asking geolocation again
    browser(() => assert.fail('GPS must not be called when session location is fresh'));
    const loc2 = await freshModule();
    assert.equal(loc2.getUserLocation().status, 'ready');
    assert.equal(loc2.getUserLocation().pcode, '302672');
    assert.equal(await loc2.requestUserLocation(), loc2.getUserLocation());
  } finally {
    delete globalThis.window;
  }
});
