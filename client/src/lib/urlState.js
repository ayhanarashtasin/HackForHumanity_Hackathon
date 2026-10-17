import { SIGN_ORDER } from './scales.js';
import { weatherLayerSelection } from './weatherLayers.js';

// Shareable view in the URL hash, like Zoom Earth: #view=23.64,90.51,8z&layer=temp&o=radar,lightning
export const DEFAULT_VIEW = { lat: 23.7, lon: 90.35, zoom: null };
const OVERLAY_KEYS = ['radar', 'satellite', 'lightning', 'storms'];

export function readHash(hash = window.location.hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const result = { view: null, layer: null, layers: null, overlays: null, stormReplay: false };

  const view = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z$/.exec(params.get('view') ?? '');
  if (view) {
    const [, lat, lon, zoom] = view.map(Number);
    if (lat >= 15 && lat <= 32 && lon >= 82 && lon <= 100 && zoom >= 4 && zoom <= 14) result.view = { lat, lon, zoom };
  }

  const layer = params.get('layer');
  if (SIGN_ORDER.includes(layer)) result.layer = layer;
  if (layer === 'none') result.layers = [];
  else if (params.has('layers')) {
    const selection = weatherLayerSelection(params.get('layers').split(','), result.layer);
    result.layers = selection.layers;
    result.layer = selection.colorLayer;
  }

  // A presentation link: #o=storms&storm=replay opens the storm movement replay directly.
  result.stormReplay = params.get('storm') === 'replay';

  if (params.has('o')) {
    result.overlays = Object.fromEntries(OVERLAY_KEYS.map((key) => [key, params.get('o').split(',').includes(key)]));
  }

  return result;
}

export function writeHash({ view, layer, layers, overlays }) {
  const params = new URLSearchParams();
  if (view) params.set('view', `${view.lat.toFixed(5)},${view.lon.toFixed(5)},${view.zoom.toFixed(2)}z`);
  if (layers?.length === 0) params.set('layer', 'none');
  else if (layer) params.set('layer', layer);
  if (layers?.length > 1) params.set('layers', weatherLayerSelection(layers, layer).layers.join(','));
  params.set('o', OVERLAY_KEYS.filter((key) => overlays?.[key]).join(','));

  const next = `#${params.toString().replace(/%2C/g, ',')}`;
  if (next !== window.location.hash) window.history.replaceState(null, '', next);
}
