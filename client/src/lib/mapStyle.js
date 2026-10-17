import { BASEMAP } from './palette.js';

// Basemap = OpenFreeMap vector tiles (free, no key) restyled with the design.md palette on a Deep Olive canvas.
// Canvas labels use English names only: the hosted fonts have no Bengali glyphs and WebGL text cannot shape Bengali conjuncts,
// so Bangla names are shown in regular HTML (search, tooltips, panel).
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const SOURCE = 'openmaptiles';
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];

// Weather layers are inserted below this layer so city names stay readable above the data fills.
export const LABELS_ANCHOR = 'labels-first';

const englishName = ['coalesce', ['get', 'name_en'], ['get', 'name:latin']];
const riverName = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ''];
const surfaceWaterway = ['!=', ['get', 'brunnel'], 'tunnel'];

function label(id, sourceLayer, filter, layout, paint, extra = {}) {
  return {
    id,
    type: 'symbol',
    source: SOURCE,
    'source-layer': sourceLayer,
    filter,
    layout: { 'text-field': englishName, 'text-font': FONT, ...layout },
    paint: { 'text-color': BASEMAP.label, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.4, ...paint },
    ...extra,
  };
}

export function buildBaseStyle() {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { [SOURCE]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': BASEMAP.land } },
      { id: 'water', type: 'fill', source: SOURCE, 'source-layer': 'water', paint: { 'fill-color': BASEMAP.water } },
      {
        id: 'waterway-casing', type: 'line', source: SOURCE, 'source-layer': 'waterway', minzoom: 5,
        filter: surfaceWaterway, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': BASEMAP.labelDim, 'line-opacity': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 8, 3.5, 12, 6.5, 16, 10] },
      },
      {
        id: 'waterway', type: 'line', source: SOURCE, 'source-layer': 'waterway', minzoom: 5,
        filter: surfaceWaterway, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': BASEMAP.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 8, 2, 12, 4.5, 16, 8] },
      },
      {
        id: 'roads-minor', type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 10,
        filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false],
        paint: { 'line-color': BASEMAP.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1.4] },
      },
      {
        id: 'roads-major', type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 6,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
        paint: { 'line-color': BASEMAP.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 2] },
      },

      // Labels (the weather layers are inserted below 'labels-first').
      label('labels-first', 'water_name', ['match', ['get', 'class'], ['ocean', 'sea', 'bay'], true, false], {
        'text-font': FONT_ITALIC, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 15], 'text-letter-spacing': 0.15,
      }, { 'text-color': BASEMAP.labelDim, 'text-opacity': 0.7 }),
      label('label-river', 'waterway', ['all', surfaceWaterway, ['!=', riverName, '']], {
        // Natural Earth calls the main channel Brahmaputra at low zoom; use its Bangladesh name too.
        'text-field': ['match', riverName, 'Brahmaputra', 'Jamuna', 'Ganges', 'Padma', riverName],
        'text-font': FONT_ITALIC, 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 9, 12, 12, 13],
        'symbol-placement': 'line', 'symbol-spacing': 350, 'text-max-angle': 35, 'text-letter-spacing': 0.05,
      }, { 'text-color': BASEMAP.label, 'text-halo-color': BASEMAP.water, 'text-halo-width': 1.6 }, { minzoom: 5 }),
      label('label-country', 'place', ['==', ['get', 'class'], 'country'], {
        'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 7, 16],
        'text-transform': 'uppercase', 'text-letter-spacing': 0.12,
      }, { 'text-color': BASEMAP.labelDim, 'text-opacity': 0.55 }, { maxzoom: 9 }),
      label('label-state', 'place', ['==', ['get', 'class'], 'state'], {
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 13], 'text-transform': 'uppercase', 'text-letter-spacing': 0.08,
      }, { 'text-color': BASEMAP.labelDim, 'text-opacity': 0.5 }, { minzoom: 5, maxzoom: 9 }),
      label('label-city', 'place', ['==', ['get', 'class'], 'city'], {
        'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 16],
      }, { 'text-opacity': 0.85 }, { minzoom: 4 }),
      label('label-town', 'place', ['==', ['get', 'class'], 'town'], {
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 14],
      }, { 'text-opacity': 0.75 }, { minzoom: 8.5 }),
      label('label-village', 'place', ['==', ['get', 'class'], 'village'], {
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13],
      }, { 'text-color': BASEMAP.labelDim, 'text-opacity': 0.8 }, { minzoom: 12 }),
    ],
  };
}
