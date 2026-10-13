import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regionWeather, routeLightning, routeRegions } from '../src/lib/routeHierarchy.js';

const catalogue = {
  districts: [
    { pcode: 'D1', name: 'First', division: 'West' },
    { pcode: 'D2', name: 'Second', division: 'West' },
    { pcode: 'D3', name: 'Third', division: 'East' },
  ],
  locations: [
    { pcode: 'U1', name: 'One', district: 'D1' },
    { pcode: 'U2', name: 'Two', district: 'D1' },
    { pcode: 'U3', name: 'Three', district: 'D2' },
    { pcode: 'U4', name: 'Four', district: 'D3' },
  ],
  polygons: { P2: { src: ['U2'] } },
};

test('division and district views preserve road order and separate a later return to a region', () => {
  const stops = [
    { id: 'U1', name: 'One', progress: 0 }, { id: 'P2', name: 'Two', polygonPid: 'P2', progress: .2 },
    { id: 'U3', name: 'Three', progress: .4 }, { id: 'U4', name: 'Four', progress: .7 }, { id: 'U1', name: 'One', progress: 1 },
  ];
  const divisions = routeRegions(stops, catalogue, 'division');
  assert.deepEqual(divisions.map(({ name, progress }) => [name, progress]), [['West', 0], ['East', .7], ['West', 1]]);
  assert.deepEqual(divisions[0].children.map((item) => item.name), ['First', 'Second']);
  const districts = routeRegions(stops, catalogue, 'district');
  assert.deepEqual(districts.map((group) => group.name), ['First', 'Second', 'Third', 'First']);
  assert.deepEqual(districts[0].children.map((item) => item.name), ['One', 'Two']);
});

test('unmatched forecast stops are not assigned to a made-up district', () => {
  assert.deepEqual(routeRegions([{ id: 'unknown' }], catalogue, 'division'), []);
});

test('division weather combines all available districts at entry time, not just districts on the road', () => {
  const snapshot = {
    steps: ['2026-10-14T00:00:00Z', '2026-10-14T03:00:00Z'],
    districts: {
      D1: { temp: [20, 22], hiMax: [25, 27], rfMax: [0, 2], wgMax: [6, 9], ts: [0, 1] },
      D2: { temp: [30, 32], hiMax: [35, 37], rfMax: [1, 5], wgMax: [12, 15], ts: [1, 3] },
      D3: { temp: [40, 42], hiMax: [45, 47], rfMax: [7, 8], wgMax: [18, 20], ts: [2, 2] },
    },
    thunderSource: 'open-meteo',
  };
  const at = Date.parse('2026-10-14T04:00:00Z');
  assert.deepEqual(regionWeather({ id: 'West' }, 'division', snapshot, catalogue, at), { temp: 27, hi: 37, rf: 5, wg: 15, ts: 3 });
  assert.deepEqual(regionWeather({ id: 'D1' }, 'district', snapshot, catalogue, at), { temp: 22, hi: 27, rf: 2, wg: 9, ts: 1 });
  assert.deepEqual(regionWeather({ id: 'West' }, 'division', null, catalogue, at), { temp: null, hi: null, rf: null, wg: null, ts: null });
});

test('missing district readings stay unavailable rather than becoming zero or NaN', () => {
  const snapshot = { steps: ['2026-10-14T00:00:00Z'], districts: { D1: { temp: [null], rfMax: [0] } } };
  assert.deepEqual(regionWeather({ id: 'West' }, 'division', snapshot, catalogue, Date.parse(snapshot.steps[0])), { temp: null, hi: null, rf: 0, wg: null, ts: null });
});

test('lightning samples match route stops by mode without claiming missing coverage means no events', () => {
  const stops = [{ polygonPid: 'U1', point: [90, 23] }, { polygonPid: 'U2', point: [90.1, 23] }];
  const samples = [
    { id: 'U1', kind: 'upazila', state: 'reported' },
    { id: 'U2', kind: 'upazila', state: 'none' },
    { id: 'U3', kind: 'upazila', state: 'reported' },
  ];
  assert.equal(routeLightning(stops, { mode: 'A', items: samples }).reported, 1);
  assert.equal(routeLightning([stops[1]], { mode: 'A', items: samples }).state, 'none');
  assert.equal(routeLightning([{ polygonPid: 'city', point: [90, 23] }], { mode: 'A', items: samples }).state, 'no-coverage');
  assert.equal(routeLightning([...stops, { polygonPid: 'city', point: [90, 23] }], { mode: 'A', items: [samples[1]] }).state, 'incomplete');
  const circles = [
    { id: 'near', kind: 'circle', lat: 23, lon: 90, radiusKm: 20, state: 'none' },
    { id: 'far', kind: 'circle', lat: 24, lon: 90, radiusKm: 20, state: 'reported' },
    { id: 'unknown', kind: 'circle', lat: 23, lon: 90.05, radiusKm: 20, state: 'not-checked' },
  ];
  assert.equal(routeLightning(stops, { mode: 'B', items: circles }).state, 'incomplete');
  assert.equal(routeLightning(stops, { mode: 'B', items: circles }).items.length, 2);
  assert.equal(routeLightning([...stops, { point: [91, 23] }], { mode: 'B', items: [circles[0]] }).state, 'incomplete');
  assert.equal(routeLightning(stops, null), null);
});
