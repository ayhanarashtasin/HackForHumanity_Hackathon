import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeIndicator, indicatorCandidates, indicatorFromFeature, tooltipPosition } from '../src/lib/mapIndicators.js';

const observedAt = '2026-09-22T10:00:00Z';
const cell = { id: 'c1', intensity: 6, motion: { towards: 'SW', speedKmh: 20 } };
const catalogue = {
  locations: [{ pcode: 'U1', name: 'Test upazila', nameBn: 'পরীক্ষার উপজেলা', district: 'D1' }],
  districts: [{ pcode: 'D1', name: 'Test district' }], polygons: {},
};
const context = {
  catalogue, signLayer: 'temp', stepIndex: 0, baseStatus: 'ok', stormMode: 'demo',
  snapshot: { steps: [observedAt], baseLabel: 'BMD', locations: { U1: { temp: [32] } }, districts: { D1: { temp: [31] } } },
  storms: { visible: true, snapshot: { observedAt, cells: [cell], arrivals: [{ pcode: 'U1', arrivalAt: '2026-09-22T10:40:00Z' }] } },
};
const row = (card, label) => card.rows.find(row => row.label === label)?.value;
const feature = (layer, properties, type = 'Point', coordinates = [10, 10]) => ({ layer: { id: layer }, properties, geometry: { type, coordinates } });

test('indicator hits prioritize small symbols over fills, preserve forecast offsets, and deduplicate tile hits', () => {
  const step = feature('storm-step', { id: 'c1', kind: 'step', minutes: 30 });
  const features = [
    feature('storm-cell', { id: 'c1', kind: 'cell' }, 'Polygon', []),
    feature('storm-ring', { id: 'c1', kind: 'ring', minutes: 60 }, 'Polygon', []),
    step, step,
    feature('markers-district', { id: 'D1', level: 'district' }),
  ];
  const candidates = indicatorCandidates(features, { x: 10, y: 10 }, ([x, y]) => ({ x, y }));
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates[0].picked, { type: 'storm', id: 'c1', kind: 'step', minutes: 30 });
  assert.equal(candidates[1].picked.type, 'weather');
  assert.equal(candidates.at(-1).picked.kind, 'cell');
  assert.equal(indicatorFromFeature(feature('unrelated', {})), null);
});

test('equally ranked dots choose the nearest, not the first rendered tile', () => {
  const candidates = indicatorCandidates([
    feature('storm-step', { id: 'far', kind: 'step' }, 'Point', [30, 30]),
    feature('storm-step', { id: 'near', kind: 'step' }, 'Point', [11, 11]),
  ], { x: 10, y: 10 }, ([x, y]) => ({ x, y }));
  assert.equal(candidates[0].picked.id, 'near');
});

test('storm circles use image-relative forecast times and explicitly identify saved replay', () => {
  const card = describeIndicator({ type: 'storm', id: 'c1', kind: 'ring', minutes: 30 }, context);
  assert.equal(card.title, 'Predicted storm position');
  assert.equal(card.eyebrow, 'Saved replay · not live');
  assert.equal(row(card, 'Forecast offset'), '30 min after the satellite image');
  assert.match(row(card, 'Estimated time'), /4:30.*pm.*BST/);
  assert.match(row(card, 'Movement'), /SW at 20 km\/h/);
  assert.match(card.note, /not a confirmed impact zone/);
  assert.equal(row(card, 'Cloud-top intensity'), 'Extreme');
});

test('storm cells without motion do not invent speed; hidden and missing cells cannot produce stale cards', () => {
  const still = { ...context, storms: { visible: true, snapshot: { observedAt, cells: [{ ...cell, motion: null }] } } };
  assert.equal(row(describeIndicator({ type: 'storm', id: 'c1', kind: 'cell' }, still), 'Movement'), 'Movement not measured yet');
  assert.equal(describeIndicator({ type: 'storm', id: 'missing', kind: 'cell' }, context), null);
  assert.equal(describeIndicator({ type: 'storm', id: 'c1', kind: 'cell' }, { ...context, storms: { visible: false } }), null);
});

test('weather cards show units, forecast time, area arrival and accurate image-layer caveat', () => {
  const card = describeIndicator({ type: 'weather', level: 'upazila', id: 'U1' }, { ...context, satelliteSpec: { time: observedAt } });
  assert.equal(row(card, 'Temperature'), '32 °C');
  assert.match(row(card, 'Forecast time'), /BST/);
  assert.equal(row(card, 'Source'), undefined, 'hover cards omit the source row');
  assert.match(row(card, 'Storm arrival in saved replay'), /4:40/);
  assert.match(card.note, /Green does not automatically mean safe/);
  assert.match(card.note, /no exact reading/);
  const district = describeIndicator({ level: 'district', id: 'D1' }, context);
  assert.equal(row(district, 'Temperature'), '31 °C');
  assert.match(row(district, 'Storm arrival in saved replay'), /4:40/);
  const live = describeIndicator({ level: 'district', id: 'D1' }, { ...context, stormMode: 'live' });
  assert.match(row(live, 'Earliest storm arrival in this area'), /4:40/);
  assert.equal(row(describeIndicator({ level: 'upazila', id: 'U1' }, { ...context, snapshot: null }), 'Temperature'), 'No data');
});

test('lightning distinguishes zero records from unknown counts and includes the sampled window', () => {
  const picked = { type: 'lightning', id: 'L1' };
  const item = { id: 'L1', kind: 'circle', state: 'none', count: 0, sampledAt: observedAt, window: { from: observedAt, to: '2026-09-22T10:05:00Z' } };
  const card = describeIndicator(picked, { lightning: { visible: true, items: [item] } });
  assert.equal(row(card, 'Recorded events'), '0');
  assert.equal(row(card, 'Status'), 'No records in window');
  assert.match(row(card, 'Sample window'), /4:05/);
  assert.match(card.note, /does not mean the area is safe/);
  const missing = describeIndicator(picked, { lightning: { visible: true, items: [{ ...item, count: null, state: 'stale' }] } });
  assert.equal(row(missing, 'Recorded events'), 'Count not available');
  assert.equal(row(missing, 'Status'), 'Stale sample');
  assert.equal(describeIndicator(picked, { lightning: { visible: false, items: [item] } }), null);
});

test('indicator explanations, intensities and numbers are translated into Bangla', () => {
  const card = describeIndicator({ type: 'storm', id: 'c1', kind: 'ring', minutes: 60 }, { ...context, lang: 'bn' });
  assert.equal(card.title, 'ঝড়ের আনুমানিক ভবিষ্যৎ অবস্থান');
  assert.match(card.eyebrow, /বর্তমান পর্যবেক্ষণ নয়/);
  assert.equal(row(card, 'মেঘচূড়ার তীব্রতা'), 'অতি তীব্র');
  assert.match(row(card, 'ছবির পরের সময়'), /৬০/);
});

test('tooltip flips at edges and clamps off-screen keyboard targets within small map bounds', () => {
  const size = { width: 280, height: 200 };
  const bounds = { width: 375, height: 360 };
  for (const point of [{ x: 370, y: 355 }, { x: -500, y: 2000 }, { x: 5, y: 5 }]) {
    const placed = tooltipPosition(point, size, bounds);
    assert.ok(placed.left >= 8 && placed.left + size.width <= bounds.width - 8);
    assert.ok(placed.top >= 8 && placed.top + size.height <= bounds.height - 8);
  }
});
