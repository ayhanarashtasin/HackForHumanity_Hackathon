import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weatherIconSize, weatherLayerSelection, weatherMarkerLayout, toggleWeatherLayer } from '../src/lib/weatherLayers.js';
import { readHash, writeHash } from '../src/lib/urlState.js';
import { describeIndicator, indicatorCandidates } from '../src/lib/mapIndicators.js';

test('weather layers can be combined and removed without losing the color-layer invariant', () => {
  let selection = weatherLayerSelection(['temp']);
  selection = toggleWeatherLayer(selection, 'rain');
  selection = toggleWeatherLayer(selection, 'wind');
  assert.deepEqual(selection, { layers: ['temp', 'rain', 'wind'], colorLayer: 'temp' });
  selection = weatherLayerSelection(selection.layers, 'rain');
  selection = toggleWeatherLayer(selection, 'rain');
  assert.deepEqual(selection, { layers: ['temp', 'wind'], colorLayer: 'temp' });
  selection = toggleWeatherLayer(selection, 'temp');
  assert.deepEqual(toggleWeatherLayer(selection, 'wind'), { layers: [], colorLayer: null }, 'the final weather layer can also be removed');
  assert.deepEqual(toggleWeatherLayer(weatherLayerSelection([]), 'rain'), { layers: ['rain'], colorLayer: 'rain' });
  assert.deepEqual(toggleWeatherLayer(selection, 'invalid'), selection);
  assert.deepEqual(weatherLayerSelection(['wind', 'bad', 'wind', 'temp'], 'bad'), { layers: ['temp', 'wind'], colorLayer: 'temp' });
});

test('multiple weather layers survive shared links while legacy single-layer links still work', () => {
  const selected = readHash('#layers=wind,rain,temp,rain,invalid&layer=rain&o=radar,satellite');
  assert.deepEqual(selected.layers, ['temp', 'rain', 'wind']);
  assert.equal(selected.layer, 'rain');
  assert.equal(readHash('#layer=wind').layer, 'wind');
  assert.equal(readHash('#layer=wind').layers, null);
  assert.deepEqual(readHash('#layers=invalid').layers, ['temp']);
  assert.equal(readHash('#layers=wind&layer=rain').layer, 'wind');
  assert.deepEqual(readHash('#layer=none').layers, []);
  assert.equal(readHash('#layer=none').layer, null);
  const previous = globalThis.window;
  globalThis.window = { location: { hash: '' }, history: { replaceState: (_state, _title, hash) => { globalThis.window.location.hash = hash; } } };
  try {
    writeHash({ layer: selected.layer, layers: selected.layers, overlays: selected.overlays });
    assert.deepEqual(readHash().layers, selected.layers);
    assert.equal(readHash().layer, 'rain');
    assert.equal(readHash().overlays.satellite, true);
    writeHash({ layer: 'wind', layers: ['wind'], overlays: {} });
    assert.doesNotMatch(globalThis.window.location.hash, /layers=/, 'single-layer links keep the old compact format');
    writeHash({ layer: null, layers: [], overlays: { radar: true } });
    assert.match(globalThis.window.location.hash, /layer=none/);
    assert.deepEqual(readHash().layers, [], 'None survives shared links instead of restoring the default temperature layer');
    assert.equal(readHash().overlays.radar, true, 'None leaves independent overlays selected');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('symbol offsets separate selected variables and remain horizontal when a wind arrow rotates', () => {
  assert.equal(weatherMarkerLayout(0, 1).markerShift, 0);
  assert.deepEqual(weatherMarkerLayout(0, 1, 0, true).textOffsetSmall, [0, 0]);
  const shifts = Array.from({ length: 5 }, (_, i) => weatherMarkerLayout(i, 5).markerShift);
  assert.deepEqual(shifts, [-88, -44, 0, 44, 88]);
  for (const rotation of [0, 45, 90, 180, 270]) {
    const layout = weatherMarkerLayout(2, 3, rotation);
    const angle = rotation * Math.PI / 180;
    const [x, y] = layout.iconOffset;
    assert.ok(Math.abs(x * Math.cos(angle) - y * Math.sin(angle) - layout.markerShift) < 1e-9);
    assert.ok(Math.abs(x * Math.sin(angle) + y * Math.cos(angle)) < 1e-9);
  }
  assert.equal(weatherIconSize(2), 0.58);
  assert.equal(weatherIconSize(8), 0.72);
  assert.equal(weatherIconSize(15), 0.9);
});

test('hover compares every selected metric, identifies the clicked symbol, and still omits Source', () => {
  const series = { temp: [32], hi: [39], rf: [1.2], ws: [20], ts: [3] };
  const context = {
    catalogue: { locations: [{ pcode: 'U1', name: 'Test', district: 'D1' }], districts: [], polygons: {} },
    signLayer: 'rain', signLayers: ['temp', 'heat', 'rain', 'wind', 'thunder'], stepIndex: 0, baseStatus: 'ok',
    snapshot: { steps: ['2026-10-17T06:00:00Z'], locations: { U1: series }, sources: { openMeteo: { status: 'stale' } } },
  };
  const card = describeIndicator({ type: 'weather', level: 'upazila', id: 'U1', signLayer: 'wind' }, context);
  const value = label => card.rows.find(row => row.label === label)?.value;
  assert.equal(card.rows[0].label, 'Wind');
  assert.equal(value('Temperature'), '32 °C');
  assert.equal(value('Heat index'), '39 °C');
  assert.equal(value('Rain'), '1.2 mm');
  assert.equal(value('Wind'), '20 km/h');
  assert.equal(value('Thunderstorm'), 'High');
  assert.equal(value('Map colors'), 'Rain');
  assert.equal(value('Thunderstorm status'), 'Forecast is stale');
  assert.equal(value('Source'), undefined);
  assert.match(card.eyebrow, /Wind/);
  const translated = describeIndicator({ level: 'upazila', id: 'U1' }, { ...context, lang: 'bn' });
  assert.ok(translated.rows.some(row => row.label === 'মানচিত্রের রং' && row.value === 'বৃষ্টি'));
});

test('nearby weather symbols use their drawn offsets for hit ranking and are not deduplicated by location alone', () => {
  const feature = (signLayer, markerShift) => ({
    layer: { id: 'markers-district' }, geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { id: 'D1', level: 'district', signLayer, markerShift },
  });
  const candidates = indicatorCandidates([feature('temp', -22), feature('wind', 22)], { x: 11, y: 0 }, ([x, y]) => ({ x, y }), 0.5);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].picked.signLayer, 'wind');
});

test('None leaves location and overlay hover information available without hidden weather values', () => {
  const context = {
    signLayer: null, signLayers: [], catalogue: { locations: [], districts: [{ pcode: 'D1', name: 'Test district' }], polygons: {} },
    satelliteSpec: { time: '2026-10-17T06:00:00Z' },
  };
  const card = describeIndicator({ level: 'district', id: 'D1' }, context);
  assert.equal(card.title, 'Test district');
  assert.equal(card.rows.length, 1);
  assert.equal(card.rows[0].label, 'Satellite image');
  assert.match(card.note, /Weather layers are hidden/);
  assert.equal(card.detail, null);
});
