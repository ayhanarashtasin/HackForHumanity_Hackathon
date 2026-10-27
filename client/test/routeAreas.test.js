import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { NEIGHBOURHOODS, placesFor } from '../src/lib/neighbourhoods.js';
import { areasAlongRoute, districtTown } from '../src/lib/routeAreas.js';
import { resolveSelection } from '../src/lib/series.js';

const square = (west, south, east, north) => ({
  type: 'Polygon',
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

test('district route endpoints use their towns, not the district boundary centres', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
  for (const district of catalogue.districts) {
    const town = districtTown(district.pcode, catalogue);
    assert.ok(town, district.name);
    assert.equal(town.district, district.pcode);
    assert.ok(Number.isFinite(town.lat) && Number.isFinite(town.lon));
  }
  for (const [code, name] of [['3026', 'Motijheel'], ['5081', 'Boalia'], ['2015', 'Kotwali'], ['2019', 'Comilla Adarsha Sadar'], ['2003', 'Bandarban Sadar'], ['3067', 'Narayanganj Sadar']]) {
    assert.equal(districtTown(code, catalogue).name, name);
  }
  assert.equal(districtTown('unknown', catalogue), null);
  assert.equal(catalogue.districts.find(item => item.pcode === '3026').lon, 90.2506, 'map label positions are unchanged');
});

test('route areas are reported in travel order with their existing parent upazila', () => {
  const catalogue = {
    areas: [
      { id: 'A', name: 'First Union', parentPid: 'P1', parentName: 'First Upazila' },
      { id: 'B', name: 'Second Union', parentPid: 'P2', parentName: 'Second Upazila' },
      { id: 'B-part', name: 'Second Union', parentPid: 'P2', parentName: 'Second Upazila' },
    ],
    polygons: {
      P1: { name: 'First Upazila', kind: 'upazila' },
      P2: { name: 'Second Upazila', kind: 'upazila' },
    },
  };
  const areas = {
    features: [
      { type: 'Feature', properties: { pid: 'A' }, geometry: square(90, 23, 90.01, 23.01) },
      { type: 'Feature', properties: { pid: 'B' }, geometry: square(90.01, 23, 90.015, 23.01) },
      { type: 'Feature', properties: { pid: 'B-part' }, geometry: square(90.015, 23, 90.02, 23.01) },
    ],
  };
  const upazilas = {
    features: [
      { type: 'Feature', properties: { pid: 'P1', name: 'First Upazila' }, geometry: square(89.99, 22.99, 90.01, 23.02) },
      { type: 'Feature', properties: { pid: 'P2', name: 'Second Upazila' }, geometry: square(90.01, 22.99, 90.03, 23.02) },
    ],
  };

  const result = areasAlongRoute([[90, 23.005], [90.02, 23.005]], areas, upazilas, catalogue, 0.1);
  assert.deepEqual(result.areas.map((area) => area.id), ['A', 'B', 'B-part']);
  assert.deepEqual(result.upazilas.map((area) => area.id), ['P1', 'P2']);
  assert.deepEqual(result.upazilas.map((area) => area.areas), [['A'], ['B']]);
  assert.ok(result.areas[0].progress < result.areas[1].progress);
});

test('neighbourhoods near the road are listed under the upazila the route is in, once, and far ones are not', () => {
  const catalogue = { areas: [], polygons: { P1: { name: 'First Upazila', kind: 'upazila' } } };
  const upazilas = { features: [{ type: 'Feature', properties: { pid: 'P1', name: 'First Upazila' }, geometry: square(89.99, 22.99, 90.03, 23.02) }] };
  const places = [
    { id: 'nb-near', name: 'Near', lat: 23.008, lon: 90.01 },
    { id: 'nb-far', name: 'Far', lat: 23.018, lon: 90.01 },
  ];
  const result = areasAlongRoute([[90, 23.005], [90.02, 23.005]], { features: [] }, upazilas, catalogue, 0.1, places);
  assert.deepEqual(result.upazilas[0].places.map((place) => place.id), ['nb-near']);
});

test('a neighbourhood the catalogue already names nearby is not added twice', () => {
  const catalogue = { locations: [{ name: 'Motijheel', lat: 23.73, lon: 90.42 }], areas: [{ name: 'Mugda', lat: 23.733, lon: 90.433 }] };
  const list = [
    { id: 'nb-motijheel', name: 'Motijheel', lat: 23.731, lon: 90.418 },
    { id: 'nb-mugda', name: 'Mugda', lat: 23.733, lon: 90.433 },
    { id: 'nb-banasree', name: 'Banasree', lat: 23.763, lon: 90.43 },
  ];
  assert.deepEqual(placesFor(catalogue, list).map((place) => place.id), ['nb-banasree']);
});

test('a city corporation on the route is split into its nearest thanas, each a card with its own forecast', () => {
  const catalogue = {
    areas: [],
    polygons: { CC: { name: 'Dhaka North City Corporation', kind: 'city-corporation', src: ['T1', 'T2'] } },
    locations: [
      { pcode: 'T1', name: 'Rampura', kind: 'thana', lat: 23.005, lon: 90.002 },
      { pcode: 'T2', name: 'Tejgaon', kind: 'thana', lat: 23.005, lon: 90.018 },
    ],
  };
  const upazilas = { features: [{ type: 'Feature', properties: { pid: 'CC' }, geometry: square(89.99, 22.99, 90.03, 23.02) }] };
  const result = areasAlongRoute([[90, 23.005], [90.02, 23.005]], { features: [] }, upazilas, catalogue);
  assert.deepEqual(result.upazilas.map((card) => [card.id, card.level, card.name]), [['T1', 'upazila', 'Rampura'], ['T2', 'upazila', 'Tejgaon']]);
});

test('every neighbourhood takes its weather from a forecast that exists in the catalogue, and shows it under its own name', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
  const pcodes = new Set(catalogue.locations.map((location) => location.pcode));
  for (const place of NEIGHBOURHOODS) {
    const known = place.weatherFrom.level === 'upazila' ? pcodes.has(place.weatherFrom.id) : Boolean(catalogue.polygons[place.weatherFrom.id]);
    assert.ok(known, `${place.name} → ${place.weatherFrom.id}`);
  }
  const banasree = NEIGHBOURHOODS.find((place) => place.name === 'Banasree');
  const snapshot = { steps: [0], locations: { [banasree.weatherFrom.id]: { temp: [31] } } };
  const resolved = resolveSelection({ level: 'neighbourhood', id: banasree.id }, snapshot, catalogue);
  assert.equal(resolved.name, 'Banasree');
  assert.deepEqual(resolved.series, { temp: [31] });
  assert.match(resolved.note, /Rampura/);
});

test('route area detection skips point-only locations and ignores an empty route', () => {
  const catalogue = { areas: [{ id: 'point', name: 'Mugda', parentPid: 'parent' }], polygons: {} };
  const pointArea = { features: [{ type: 'Feature', properties: { pid: 'point' }, geometry: { type: 'Point', coordinates: [90.01, 23] } }] };
  assert.deepEqual(areasAlongRoute([[90, 23], [90.02, 23]], pointArea, { features: [] }, catalogue), { areas: [], upazilas: [] });
  assert.deepEqual(areasAlongRoute([], pointArea, { features: [] }, catalogue), { areas: [], upazilas: [] });
});
