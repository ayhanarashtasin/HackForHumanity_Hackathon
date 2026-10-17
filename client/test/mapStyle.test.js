import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBaseStyle } from '../src/lib/mapStyle.js';

test('rivers use the existing geographic tiles, are visible at country zoom, and have names following their courses', () => {
  const style = buildBaseStyle();
  const layer = id => style.layers.find(item => item.id === id);
  for (const id of ['waterway-casing', 'waterway', 'label-river']) {
    assert.equal(layer(id).source, 'openmaptiles');
    assert.equal(layer(id)['source-layer'], 'waterway');
    assert.equal(layer(id).minzoom, 5);
  }
  assert.deepEqual(layer('waterway').filter, ['!=', ['get', 'brunnel'], 'tunnel']);
  assert.equal(layer('label-river').layout['symbol-placement'], 'line');
  assert.equal(layer('label-river').layout['text-allow-overlap'] ?? false, false, 'river names must not cover weather symbols');
  assert.deepEqual(layer('label-river').layout['text-field'].slice(2, 6), ['Brahmaputra', 'Jamuna', 'Ganges', 'Padma']);
  assert.ok(style.layers.indexOf(layer('waterway-casing')) < style.layers.indexOf(layer('waterway')));
  assert.deepEqual(Object.keys(style.sources), ['openmaptiles'], 'no guessed river geometry or additional tile service');
});
