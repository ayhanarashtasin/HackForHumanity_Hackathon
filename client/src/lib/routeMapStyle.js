import { outsideMask } from './geometry.js';
import { LABELS_ANCHOR, buildBaseStyle } from './mapStyle.js';
import { BASEMAP, PALETTE } from './palette.js';

// The same real boundaries, outside-country mask and Bay restoration as the main weather map.
// Assemble the whole style before the first frame so neighbouring countries never flash into view.
export function buildRouteMapStyle(national) {
  const style = buildBaseStyle();
  Object.assign(style.sources, {
    national: { type: 'geojson', data: national },
    districts: { type: 'geojson', data: '/data/bd-district.geojson' },
    upazilas: { type: 'geojson', data: '/data/bd-upazila.geojson' },
    areas: { type: 'geojson', data: '/data/bd-admin4.geojson' },
    outside: { type: 'geojson', data: outsideMask(national) },
    'bay-of-bengal': { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [90.3, 21] } } },
  });
  style.layers.splice(1, 0, { id: 'national-fill', type: 'fill', source: 'national', paint: { 'fill-color': BASEMAP.country } });
  const details = [
    { id: 'route-buildings', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': PALETTE.sage, 'fill-opacity': .15 } },
    { id: 'route-local-roads', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12,
      filter: ['match', ['get', 'class'], ['minor', 'service', 'track', 'path'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': PALETTE.sage, 'line-opacity': .4, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, .5, 18, 3] } },
    ...[
      ['district', 'districts', 0, .4], ['upazila', 'upazilas', 8, .3], ['area', 'areas', 10, .3],
    ].map(([id, source, minzoom, opacity]) => ({
      id: `${id}-line`, type: 'line', source, minzoom,
      paint: { 'line-color': PALETTE.cream, 'line-opacity': opacity, 'line-width': id === 'district' ? 1 : .65 },
    })),
    ...[
      ['district', 'districts', 6, 8.6], ['upazila', 'upazilas', 8.6, 24], ['area', 'areas', 10, 24],
    ].map(([id, source, minzoom, maxzoom]) => ({
      id: `names-${id}`, type: 'symbol', source, minzoom, maxzoom,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': id === 'area' ? 10 : 12, 'text-optional': true },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.5 },
    })),
    { id: 'route-street-names', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 14,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 250, 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name'], ''], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.5 } },
  ];
  // River and city labels keep priority over the denser local-area names.
  style.layers.splice(style.layers.findIndex(layer => layer.id === LABELS_ANCHOR), 0, ...details);
  style.layers.push(
    { id: 'outside-mask', type: 'fill', source: 'outside', paint: { 'fill-color': BASEMAP.land, 'fill-antialias': false } },
    { id: 'bay-water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'], paint: { 'fill-color': BASEMAP.water } },
    { id: 'bay-of-bengal-label', type: 'symbol', source: 'bay-of-bengal', maxzoom: 9,
      layout: { 'text-field': 'Bay of Bengal', 'text-font': ['Noto Sans Italic'], 'text-size': 13, 'text-letter-spacing': .12 },
      paint: { 'text-color': BASEMAP.label, 'text-halo-color': BASEMAP.water, 'text-halo-width': 1.5 } },
    { id: 'national-line', type: 'line', source: 'national', paint: { 'line-color': PALETTE.cream, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 10, 2.2], 'line-opacity': .9 } },
  );
  return style;
}
