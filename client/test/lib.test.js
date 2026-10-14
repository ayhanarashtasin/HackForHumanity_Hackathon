import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circlePolygon, distanceKm, imageCoordinates } from '../src/lib/geometry.js';
import { PALETTE } from '../src/lib/palette.js';
import { SCALES, SIGN_LAYERS, SIGN_ORDER, colorAt, dim, textOn } from '../src/lib/scales.js';
import { meanSeries, resolveSelection, valueAt } from '../src/lib/series.js';
import { formatBst, formatRange, nearestIndex, relativeLabel, stepIndexAt } from '../src/lib/time.js';
import { readHash } from '../src/lib/urlState.js';

test('the UI palette is exactly the three design.md colors', () => {
  assert.deepEqual(PALETTE, { cream: '#E8E9DF', sage: '#A9BE87', olive: '#2E3D28' });
});

test('color ramps return the end colors outside the range and interpolate inside it', () => {
  assert.equal(colorAt('temp', -5), '#5B8DB8');
  assert.equal(colorAt('temp', 99), '#7F1D2B');
  assert.equal(colorAt('temp', 18), '#7FB5A3');

  const mid = colorAt('temp', 21);
  assert.match(mid, /^#[0-9A-F]{6}$/);
  assert.notEqual(mid, '#7FB5A3');
  assert.notEqual(mid, '#C9D77A');

  for (const key of Object.keys(SCALES)) assert.ok(SCALES[key].stops.length >= 3, `${key} has a usable ramp`);
});

test('stale colors are muted and text contrast flips between light and dark fills', () => {
  assert.notEqual(dim('#E0662F'), '#E0662F');
  assert.equal(textOn('#F2D253'), PALETTE.olive);
  assert.equal(textOn('#7F1D2B'), PALETTE.cream);
});

test('weather signs: calm is a dot, known values get a glyph and label, unknown is handled by the map', () => {
  assert.deepEqual(SIGN_ORDER, ['temp', 'heat', 'rain', 'wind', 'thunder']);

  assert.equal(SIGN_LAYERS.rain.mark(0).icon, 'dot');
  assert.equal(SIGN_LAYERS.rain.mark(0).value, null);
  const rain = SIGN_LAYERS.rain.mark(3.04);
  assert.equal(rain.icon, 'drop');
  assert.equal(rain.label, '3.0');
  assert.equal(SIGN_LAYERS.rain.mark(24.6).label, '25');

  assert.equal(SIGN_LAYERS.temp.mark(30.4).label, '30°');
  assert.equal(SIGN_LAYERS.heat.mark(25).icon, 'dot', 'no heat sign below the 27 C heat index floor');
  assert.equal(SIGN_LAYERS.heat.mark(33).icon, 'sun');
  assert.equal(SIGN_LAYERS.thunder.mark(0).icon, 'dot');
  assert.equal(SIGN_LAYERS.thunder.mark(2).icon, 'bolt');

  // The arrow points where the wind blows TOWARD (meteorological direction is where it comes FROM).
  assert.equal(SIGN_LAYERS.wind.mark(12, { dir: 90 }).rotate, 270);
  assert.equal(SIGN_LAYERS.wind.mark(12, { dir: 350 }).rotate, 170);
  assert.equal(SIGN_LAYERS.wind.mark(12, {}).rotate, 0);
  assert.ok(SIGN_LAYERS.wind.fillMin > 0, 'calm wind is not shaded');
});

test('time helpers use Bangladesh time and step lookup clamps to the available steps', () => {
  const steps = ['2026-10-10T06:00:00+06:00', '2026-10-10T09:00:00+06:00', '2026-10-10T12:00:00+06:00'];
  const at = (iso) => new Date(iso).getTime();

  assert.equal(stepIndexAt(steps, at('2026-10-10T05:00:00+06:00')), 0, 'before the first step clamps to it');
  assert.equal(stepIndexAt(steps, at('2026-10-10T09:00:00+06:00')), 1);
  assert.equal(stepIndexAt(steps, at('2026-10-10T11:59:00+06:00')), 1);
  assert.equal(stepIndexAt(steps, at('2026-10-11T00:00:00+06:00')), 2);
  assert.equal(nearestIndex([10, 20, 30], 26), 2);

  assert.match(formatBst(at('2026-10-10T15:00:00+06:00')), /3:00 pm BST$/);
  assert.match(formatBst(at('2026-10-10T09:00:00Z')), /3:00 pm BST$/, 'UTC input is shown in Bangladesh time');
  assert.match(formatRange(at('2026-10-10T15:00:00+06:00'), at('2026-10-10T18:00:00+06:00')), /3:00 pm – 6:00 pm BST$/);

  const now = Date.now();
  assert.equal(relativeLabel(now + 60_000, now), 'now');
  assert.equal(relativeLabel(now - 40 * 60_000, now), '40 min ago');
  assert.equal(relativeLabel(now + 5 * 3_600_000, now), 'in 5 h');
});

test('the URL hash parses a shareable view and ignores invalid values', () => {
  const full = readHash('#view=23.64059,90.51415,8z&layer=rain&o=radar,lightning');
  assert.deepEqual(full.view, { lat: 23.64059, lon: 90.51415, zoom: 8 });
  assert.equal(full.layer, 'rain');
  assert.deepEqual(full.overlays, { radar: true, satellite: false, lightning: true, storms: false });
  assert.equal(readHash('#o=storms').overlays.storms, true, 'the storm movement overlay survives a shared link');
  assert.equal(readHash('#o=storms&storm=replay').stormReplay, true, 'a presentation link opens the replay');
  assert.equal(full.stormReplay, false);

  const bad = readHash('#view=0,0,8z&layer=banana');
  assert.equal(bad.view, null, 'a view outside Bangladesh is ignored');
  assert.equal(bad.layer, null);
  assert.equal(bad.overlays, null);
  assert.deepEqual(readHash('').view, null);
});

test('circle polygons stay at the requested geodesic radius and image corners go clockwise from the top-left', () => {
  const ring = circlePolygon(23.8, 90.4, 100);
  assert.equal(ring.length, 1);
  assert.deepEqual(ring[0][0], ring[0].at(-1), 'the ring is closed');
  for (const [lon, lat] of ring[0]) {
    assert.ok(Math.abs(distanceKm(23.8, 90.4, lat, lon) - 100) < 0.5);
  }

  assert.deepEqual(imageCoordinates({ north: 28, west: 86, south: 20, east: 94 }), [[86, 28], [94, 28], [94, 20], [86, 20]]);
});

const catalogue = {
  districts: [{ pcode: '3026', name: 'Dhaka', nameBn: 'ঢাকা', division: 'Dhaka', lat: 23.8, lon: 90.2, upazilas: ['302604', '302602'] }],
  locations: [
    { pcode: '302604', name: 'Badda', nameBn: 'বাড্ডা', district: '3026', lat: 23.79, lon: 90.45, kind: 'thana', pid: null },
    { pcode: '302602', name: 'Adabor', district: '3026', lat: 23.77, lon: 90.35, kind: 'thana', pid: null },
    { pcode: '302672', name: 'Savar', district: '3026', lat: 23.85, lon: 90.26, kind: 'upazila', pid: '302672' },
  ],
  polygons: {
    302672: { name: 'Savar', kind: 'upazila', src: ['302672'], approx: false },
    X30260001: { name: 'Dhaka North City Corporation', kind: 'city-corporation', src: ['302604', '302602'], approx: false },
    X20030004: { name: 'Karnaphuli', kind: 'upazila', src: ['302672'], approx: true },
  },
};
const snapshot = {
  steps: ['2026-10-10T06:00:00+06:00', '2026-10-10T09:00:00+06:00'],
  locations: {
    302604: { temp: [30, 32], rf: [0, 4], ts: [0, 1] },
    302602: { temp: [32, 34], rf: [2, 0], ts: [1, 3] },
    302672: { temp: [28, 29], rf: [0, 0] },
  },
  districts: { 3026: { temp: [31, 33], rfMax: [2, 4], rf: [1, 2] } },
};

test('mean series averages members, keeps the highest thunder level and skips nulls', () => {
  const result = meanSeries([{ temp: [30, null], ts: [1, 0] }, { temp: [32, 34], ts: [3, 0] }], 2);
  assert.deepEqual(result.temp, [31, 34]);
  assert.deepEqual(result.ts, [3, 0]);
});

test('selections resolve to district, upazila, merged city corporation and approximate polygons', () => {
  const district = resolveSelection({ level: 'district', id: '3026' }, snapshot, catalogue);
  assert.equal(district.kind, 'District');
  assert.equal(district.nameBn, 'ঢাকা');
  assert.equal(valueAt(district, 'rf', 'rfMax', 1), 4, 'districts read their worst-upazila series');

  const thana = resolveSelection({ level: 'upazila', id: '302604' }, snapshot, catalogue);
  assert.equal(thana.kind, 'City thana');
  assert.equal(thana.dailyPcode, '302604');
  assert.equal(valueAt(thana, 'temp', 'temp', 1), 32);

  const corporation = resolveSelection({ level: 'polygon', id: 'X30260001' }, snapshot, catalogue);
  assert.match(corporation.note, /average of its 2 BMD thanas/);
  assert.deepEqual(corporation.series.temp, [31, 33]);
  assert.deepEqual(corporation.series.ts, [1, 3]);
  assert.equal(corporation.dailyPcode, null);

  const approximate = resolveSelection({ level: 'polygon', id: 'X20030004' }, snapshot, catalogue);
  assert.match(approximate.note, /no separate forecast for Karnaphuli.*nearest BMD location, Savar/);
  assert.equal(approximate.dailyPcode, '302672');

  assert.equal(resolveSelection({ level: 'upazila', id: 'nope' }, snapshot, catalogue), null);
  assert.equal(resolveSelection(null, snapshot, catalogue), null);
  assert.equal(valueAt(resolveSelection({ level: 'upazila', id: '302672' }, null, catalogue), 'temp', 'temp', 0), null, 'no snapshot means no value, never zero');
});
