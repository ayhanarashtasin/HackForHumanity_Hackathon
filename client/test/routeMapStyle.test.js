import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildRouteMapStyle } from '../src/lib/routeMapStyle.js';

test('route map masks neighbours above every basemap label while keeping Bangladesh, the Bay and local detail', async () => {
  const national = JSON.parse(await readFile(new URL('../public/data/bd-national.geojson', import.meta.url), 'utf8'));
  const style = buildRouteMapStyle(national);
  const layer = id => style.layers.find(item => item.id === id);
  const index = id => style.layers.indexOf(layer(id));
  const polygons = national.features.flatMap(feature => feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [feature.geometry.coordinates]);
  assert.equal(style.sources.outside.data.geometry.coordinates.length, polygons.length + 1);
  assert.ok(index('national-fill') < index('water'), 'real rivers must remain above the country fill');
  for (const id of ['label-country', 'label-state', 'label-city', 'label-river', 'route-local-roads', 'route-street-names', 'route-buildings']) {
    assert.ok(index(id) < index('outside-mask'), `${id} cannot appear over neighbouring countries`);
  }
  assert.ok(index('outside-mask') < index('bay-water'));
  assert.ok(index('outside-mask') < index('national-line'));
  assert.equal(layer('bay-water').filter[2], 'ocean');
  for (const source of ['districts', 'upazilas', 'areas']) assert.match(style.sources[source].data, /^\/data\/bd-.*\.geojson$/);
  for (const id of ['district', 'upazila', 'area']) assert.ok(layer(`names-${id}`));
  assert.equal(layer('route-local-roads')['source-layer'], 'transportation');
  assert.equal(layer('route-street-names')['source-layer'], 'transportation_name');
});
