import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BD_DIVISIONS, BD_OUTLINE } from '../src/lib/bdOutline.js';
import { clampToBounds, outlinePoint, outsideMask } from '../src/lib/geometry.js';
import { adminScreen, legacyMapUrl, resolveRoute } from '../src/lib/router.js';

const area = (ring) => ring.slice(0, -1).reduce((sum, [x, y], i) => sum + (x * ring[i + 1][1] - ring[i + 1][0] * y), 0) / 2;

test('"/" is the landing page, "/map" the map, "/alert" the alerts, "/flood" the river page, "/admin" the administrator, and anything unknown falls back to the landing page', () => {
  assert.equal(resolveRoute('/'), 'home');
  assert.equal(resolveRoute('/map'), 'map');
  assert.equal(resolveRoute('/map/'), 'map');
  assert.equal(resolveRoute('/alert'), 'alert');
  assert.equal(resolveRoute('/alert/'), 'alert');
  assert.equal(resolveRoute('/flood'), 'flood');
  assert.equal(resolveRoute('/flood/'), 'flood');
  assert.equal(resolveRoute('/admin'), 'admin');
  assert.equal(resolveRoute('/admin/login'), 'admin');
  assert.equal(resolveRoute('/admin/login/'), 'admin');
  assert.equal(resolveRoute('/administrator'), 'home', 'only the exact paths');
  assert.equal(resolveRoute('/nope'), 'home');
});

test('the admin area tells its sign-in screen from the dashboard by path', () => {
  assert.equal(adminScreen('/admin'), 'dashboard');
  assert.equal(adminScreen('/admin/'), 'dashboard');
  assert.equal(adminScreen('/admin/login'), 'login');
  assert.equal(adminScreen('/admin/login/'), 'login');
});

test('old shared map links ("/#view=...") are sent to /map and ordinary anchors are left alone', () => {
  assert.equal(legacyMapUrl('/', '#view=23.64,90.51,8z&layer=rain&o=radar'), '/map#view=23.64,90.51,8z&layer=rain&o=radar');
  assert.equal(legacyMapUrl('/', '#layer=wind'), '/map#layer=wind');
  assert.equal(legacyMapUrl('/', '#features'), null);
  assert.equal(legacyMapUrl('/', ''), null);
  assert.equal(legacyMapUrl('/map', '#view=23.64,90.51,8z'), null, 'already on the map');
});

test('the outside mask is a world polygon with one clockwise hole per Bangladesh ring', () => {
  const square = (x, y) => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]; // counter-clockwise
  const mask = outsideMask({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[square(88, 22)], [square(91, 24)]] } }] });

  const [world, ...holes] = mask.geometry.coordinates;
  assert.equal(mask.geometry.type, 'Polygon');
  assert.ok(area(world) > 0, 'the outer ring is counter-clockwise');
  assert.equal(holes.length, 2);
  for (const hole of holes) assert.ok(area(hole) < 0, 'holes are clockwise');
  assert.deepEqual(outsideMask(null).geometry.coordinates.length, 1, 'no boundary data means no hole, never a crash');
});

test('the real national boundary produces a hole for every polygon, all of them clockwise', () => {
  const national = JSON.parse(readFileSync(new URL('../public/data/bd-national.geojson', import.meta.url), 'utf8'));
  const polygons = national.features.flatMap((feature) => (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates));
  const [world, ...holes] = outsideMask(national).geometry.coordinates;

  assert.equal(holes.length, polygons.length);
  assert.ok(area(world) > 0);
  assert.ok(holes.every((hole) => area(hole) < 0));
});

test('the camera stays within a margin of the Bangladesh bounds', () => {
  const bounds = [[88, 20.5], [92.75, 26.7]];
  assert.deepEqual(clampToBounds(90, 23, bounds, 0.6), { lng: 90, lat: 23 });
  assert.deepEqual(clampToBounds(120, 40, bounds, 0.6), { lng: 93.35, lat: 27.3 });
  assert.deepEqual(clampToBounds(70, 5, bounds, 0.6), { lng: 87.4, lat: 19.9 });
});

test('landing-page outline: pins land inside it in the right order', () => {
  assert.match(BD_OUTLINE.path, /^M[\d.]+ [\d.]+L/);
  assert.deepEqual(outlinePoint(BD_OUTLINE, BD_OUTLINE.lon0, BD_OUTLINE.lat1), { x: 0, y: 0 });

  const dhaka = outlinePoint(BD_OUTLINE, 90.4125, 23.8103);
  const sylhet = outlinePoint(BD_OUTLINE, 91.8687, 24.8949);
  const chattogram = outlinePoint(BD_OUTLINE, 91.7832, 22.3569);
  for (const point of [dhaka, sylhet, chattogram]) {
    assert.ok(point.x > 0 && point.x < BD_OUTLINE.width && point.y > 0 && point.y < BD_OUTLINE.height);
  }
  assert.ok(sylhet.x > dhaka.x, 'Sylhet is east of Dhaka');
  assert.ok(sylhet.y < dhaka.y && dhaka.y < chattogram.y, 'north is up');
});

test('the division atlas covers all 64 districts and places each label inside its actual division', () => {
  const expected = { Barishal: 6, Chattogram: 11, Dhaka: 13, Khulna: 10, Mymensingh: 4, Rajshahi: 8, Rangpur: 8, Sylhet: 4 };
  const districts = JSON.parse(readFileSync(new URL('../public/data/bd-district.geojson', import.meta.url), 'utf8'));
  const insideRing = (ring, lon, lat) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  assert.deepEqual(Object.fromEntries(BD_DIVISIONS.map((division) => [division.name, division.districts])), expected);
  assert.equal(BD_DIVISIONS.reduce((sum, division) => sum + division.districts, 0), 64);
  for (const division of BD_DIVISIONS) {
    const label = outlinePoint(BD_OUTLINE, division.lon, division.lat);
    assert.ok(Math.abs(label.x - division.label[0]) <= 0.05 && Math.abs(label.y - division.label[1]) <= 0.05, `${division.name}: label uses the shared projection`);
    assert.match(division.path, /^M[\d.]+ [\d.]+L/);
    assert.ok(!division.path.includes('NaN'));
    const members = districts.features.filter((district) => district.properties.division === division.name);
    assert.ok(members.some(({ geometry }) => {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      return polygons.some(([outer, ...holes]) => insideRing(outer, division.lon, division.lat) && !holes.some((hole) => insideRing(hole, division.lon, division.lat)));
    }), `${division.name}: label is inside the source division`);
  }
});
