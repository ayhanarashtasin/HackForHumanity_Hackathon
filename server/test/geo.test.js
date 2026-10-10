import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { districts, locationByPcode, locations, pcodes, polygons } from '../src/services/geo.js';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

test('the generated catalogue has every BMD location, district and polygon, each exactly once', () => {
  assert.equal(locations.length, 544);
  assert.equal(new Set(pcodes).size, 544, 'PCODEs are unique');
  assert.equal(districts.length, 64);
  assert.equal(new Set(districts.map((district) => district.division)).size, 8);
  assert.equal(Object.keys(polygons).length, 507, 'HDX has 495 upazilas plus 12 city corporations');
  assert.equal(Object.values(polygons).filter((polygon) => polygon.kind === 'city-corporation').length, 12);
  assert.equal(Object.values(polygons).filter((polygon) => polygon.kind === 'upazila').length, 495);
});

test('locations, districts and polygons reference each other consistently', () => {
  const districtCodes = new Set(districts.map((district) => district.pcode));

  for (const location of locations) {
    assert.match(location.pcode, /^\d{6}$/);
    assert.equal(location.district, location.pcode.slice(0, 4), 'the BMD district is the first four digits');
    assert.ok(districtCodes.has(location.district), `${location.pcode} has a known district`);
    assert.ok(location.lat > 20 && location.lat < 27 && location.lon > 87 && location.lon < 93, `${location.pcode} lies in Bangladesh`);
    assert.equal(location.kind === 'upazila', location.pid !== null, 'only locations with their own polygon are upazilas');
  }

  const listed = districts.flatMap((district) => district.upazilas);
  assert.equal(listed.length, 544);
  assert.equal(new Set(listed).size, 544, 'every location belongs to exactly one district');

  for (const [pid, polygon] of Object.entries(polygons)) {
    assert.ok(polygon.src.length > 0, `${pid} has a forecast source`);
    for (const pcode of polygon.src) assert.ok(locationByPcode.has(pcode), `${pid} -> ${pcode} exists`);
    // Directly joined polygons (id = BMD code) forecast from themselves; X-ids take their members or the nearest location.
    if (!pid.startsWith('X')) assert.deepEqual(polygon.src, [pid]);
  }
});

test('the lightning geography matches the plan: 14 gap-free circles and 495 upazila centres', () => {
  const circles = read('lightning-circles.json');
  assert.equal(circles.apiRadiusKm, 100);
  assert.equal(circles.circles.length, 14);
  assert.ok(circles.verifiedMaxDistanceKm <= 100, `farthest boundary vertex is ${circles.verifiedMaxDistanceKm} km from a centre`);
  assert.ok(circles.verifiedAgainstVertices > 1_000_000);
  assert.equal(new Set(circles.circles.map((circle) => circle.id)).size, 14);

  const upazilas = read('lightning-upazilas.json').upazilas;
  assert.equal(upazilas.length, 495);
  assert.equal(new Set(upazilas.map((upazila) => upazila.id)).size, 495);
});
