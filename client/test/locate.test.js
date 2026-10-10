import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { containsPoint, locateUpazila } from '../src/lib/locate.js';

const catalogue = JSON.parse(await readFile(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
const boundaries = JSON.parse(await readFile(new URL('../public/data/bd-upazila.geojson', import.meta.url), 'utf8'));

test('location containment respects holes, islands, edges and coordinate order', () => {
  const ring = [[90, 23], [91, 23], [91, 24], [90, 24], [90, 23]];
  const hole = [[90.4, 23.4], [90.6, 23.4], [90.6, 23.6], [90.4, 23.6], [90.4, 23.4]];
  const geometry = { type: 'Polygon', coordinates: [ring, hole] };
  assert.equal(containsPoint(geometry, 90.2, 23.5), true);
  assert.equal(containsPoint(geometry, 90.5, 23.5), false);
  assert.equal(containsPoint(geometry, 90, 23.5), true);
  assert.equal(containsPoint(geometry, 23.5, 90.2), false);
  assert.equal(containsPoint({ type: 'MultiPolygon', coordinates: [[[...ring]], [[[92, 25], [93, 25], [93, 26], [92, 26], [92, 25]]]] }, 92.5, 25.5), true);
});

test('real Bangladesh coordinates resolve their containing upazila, not the nearest centroid', () => {
  const match = locateUpazila({ lat: 23.85, lon: 90.26 }, boundaries, catalogue);
  assert.deepEqual(match.selection, { level: 'upazila', id: '302672' });
  assert.equal(match.area, 'Savar');
  assert.equal(match.note, null);
  for (const position of [{ lat: 0, lon: 0 }, { lat: 23.85, lon: NaN }, { lat: 91, lon: 90 }, { lat: 23.85, lon: '90.26' }]) {
    assert.equal(locateUpazila(position, boundaries, catalogue), null);
  }
});

test('city locations disclose nearest-thana estimates and unmapped areas retain their real area name', () => {
  const city = locateUpazila({ lat: 23.793, lon: 90.404 }, boundaries, catalogue);
  assert.match(city.area, /Dhaka North/);
  assert.match(city.note, /nearest forecast thana/);
  assert.equal(city.selection.level, 'upazila');
  const pid = Object.keys(catalogue.polygons).find((id) => catalogue.polygons[id].approx);
  const feature = boundaries.features.find((item) => item.properties.pid === pid);
  const point = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0][0] : feature.geometry.coordinates[0][0][0];
  const match = locateUpazila({ lon: point[0], lat: point[1] }, { features: [feature] }, catalogue);
  assert.deepEqual(match.selection, { level: 'polygon', id: pid });
  assert.equal(match.area, catalogue.polygons[pid].name);
  assert.match(match.note, /nearest available forecast/);
});
