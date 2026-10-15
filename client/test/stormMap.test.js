import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORM_LABEL_CELLS, STORM_WARNING_COLOR, arrivalTiers, stormFeatures } from '../src/lib/stormMap.js';

// A moving cell on an image taken at 16:00 Bangladesh time (10:00 UTC), with its 30/60/90-minute steps as the tracker sends them.
const OBSERVED = '2026-09-22T10:00:00Z';
const cell = (id, extra = {}) => ({
  id,
  intensity: 6,
  center: { lat: 22.1, lon: 92.33 },
  polygon: [[92.2, 22.0], [92.4, 22.0], [92.4, 22.2], [92.2, 22.2], [92.2, 22.0]],
  motion: { speedKmh: 24.9, towards: 'S', bearingDeg: 180 },
  forecast: [30, 60, 90].map((minutes) => ({ minutes, lat: 22.1 - minutes * 0.004, lon: 92.33, radiusKm: 50 + minutes / 10 })),
  ...extra,
});
const kinds = (features, kind) => features.filter((feature) => feature.properties.kind === kind);

test('storm map: the warning shading is the alert WARNING amber', () => {
  assert.equal(STORM_WARNING_COLOR, '#F2A03D');
});

test('storm map: a polygon is shaded by the soonest of its locations; places without a warning are left out', () => {
  const polygons = { P1: { src: ['202224'] }, P2: { src: ['200395', '200310'] }, P3: { src: ['100409'] } };
  const tiers = arrivalTiers([
    { pcode: '202224', soon: false },
    { pcode: '200310', soon: false },
    { pcode: '200395', soon: true },
  ], polygons);
  assert.deepEqual([...tiers], [['P1', 2], ['P2', 1]]);
  assert.equal(arrivalTiers([], polygons).size, 0);
  assert.equal(arrivalTiers(undefined, undefined).size, 0);
});

test('storm map: a moving cell gets its outline, three dashed circles with clock times, a track ending in an arrow, and a speed label', () => {
  const features = stormFeatures({ observedAt: OBSERVED, cells: [cell('c1')] });
  assert.equal(kinds(features, 'cell').length, 1);
  assert.deepEqual(kinds(features, 'ring').map((ring) => ring.properties.minutes), [30, 60, 90]);
  assert.deepEqual(kinds(features, 'step').map((step) => step.properties.label), ['4:30pm', '5:00pm', '5:30pm']);
  const [track] = kinds(features, 'track');
  assert.equal(track.geometry.coordinates.length, 4, 'centre, then 30, 60 and 90 minutes');
  assert.equal(kinds(features, 'arrow').length, 1);
  assert.equal(kinds(features, 'label')[0].properties.label, '25 km/h S');
});

test('storm map: a cell without motion is only an outline; clock times only on the biggest cells', () => {
  const still = stormFeatures({ observedAt: OBSERVED, cells: [cell('c1', { motion: null })] });
  assert.deepEqual(still.map((feature) => feature.properties.kind), ['cell']);

  const many = Array.from({ length: STORM_LABEL_CELLS + 2 }, (_, index) => cell(`c${index + 1}`));
  const steps = kinds(stormFeatures({ observedAt: OBSERVED, cells: many }), 'step');
  assert.equal(steps.length, many.length * 3, 'every moving cell has its three dots');
  assert.equal(steps.filter((step) => step.properties.label).length, STORM_LABEL_CELLS * 3, 'times only on the biggest cells');
});

test('storm map: every warned upazila gets its expected arrival time at its location', () => {
  const locations = new Map([['202224', { name: "Cox's Bazar Sadar", lat: 21.45, lon: 92.01 }]]);
  const features = stormFeatures({
    observedAt: OBSERVED,
    cells: [],
    arrivals: [{ pcode: '202224', arrivalAt: '2026-09-22T10:40:00Z', minutesFromNow: 25, soon: true }, { pcode: 'unknown', arrivalAt: OBSERVED }],
  }, locations);
  const [arrival] = kinds(features, 'arrival');
  assert.deepEqual(arrival.geometry.coordinates, [92.01, 21.45]);
  assert.deepEqual(arrival.properties, { kind: 'arrival', soon: true, label: "Cox's Bazar Sadar 4:40pm" });
  assert.equal(kinds(features, 'arrival').length, 1, 'a place the map does not know is skipped');
  assert.deepEqual(stormFeatures(null), []);
});
