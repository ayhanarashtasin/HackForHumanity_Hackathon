import { translate } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { digits } from '../alert/format.js';
import { PALETTE, STATUS_COLORS } from './palette.js';
import { SIGN_LAYERS, colorAt } from './scales.js';
import { resolveSelection, valueAt } from './series.js';
import { STORM_COLORS, STORM_INTENSITY, STORM_WARNING_COLOR } from './stormMap.js';
import { formatBst, toMs } from './time.js';

export const LIGHTNING_COLORS = {
  reported: '#FFB800', none: PALETTE.sage, stale: STATUS_COLORS.stale,
  unavailable: STATUS_COLORS.unavailable, 'not-checked': STATUS_COLORS.unavailable,
};

// Small symbols and thin outlines beat broad fills. Ring interiors deliberately do not intercept the weather underneath.
export const INDICATOR_HIT_LAYERS = [
  'user-position-dot', 'storm-step', 'lightning-points', 'lightning-labels', 'storm-arrival-label',
  'markers-district', 'markers-upazila', 'storm-label', 'storm-arrow', 'storm-track', 'storm-ring',
  'storm-cell-line', 'lightning-line-reported', 'lightning-line-none', 'lightning-line-stale',
  'lightning-line-unavailable', 'lightning-line-not-checked',
];
export const INDICATOR_FILL_LAYERS = ['storm-cell', 'lightning-fill'];

export function indicatorFromFeature(feature) {
  const p = feature.properties;
  const layer = feature.layer?.id ?? '';
  if (layer === 'user-position-dot') return { type: 'position', id: 'you' };
  if (layer.startsWith('markers-')) return { type: 'weather', level: p.level, id: p.id, ...(p.signLayer ? { signLayer: p.signLayer } : {}) };
  if (layer.startsWith('storm-') && p.kind) return { type: 'storm', id: p.id, kind: p.kind, ...(p.minutes ? { minutes: p.minutes } : {}) };
  if (layer.startsWith('lightning-')) return { type: 'lightning', id: p.id };
  return null;
}

export const indicatorKey = (picked) => picked ? [picked.type ?? 'weather', picked.level, picked.id, picked.kind, picked.minutes, picked.signLayer].join(':') : '';

export function indicatorCandidates(features, point, project, iconSize = 1) {
  const layers = [...INDICATOR_HIT_LAYERS, ...INDICATOR_FILL_LAYERS];
  const ranked = features.map(feature => {
    const picked = indicatorFromFeature(feature);
    const priority = layers.indexOf(feature.layer?.id);
    const center = feature.geometry.type === 'Point' ? project(feature.geometry.coordinates) : null;
    if (center) center.x += (feature.properties.markerShift ?? 0) * iconSize;
    const distance = center ? Math.hypot(center.x - point.x, center.y - point.y) : 0;
    return { feature, picked, priority, distance };
  }).filter(item => item.picked && item.priority >= 0);
  ranked.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
  const seen = new Set();
  return ranked.filter(({ picked }) => {
    const key = indicatorKey(picked);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tooltipPosition(point, size, bounds) {
  const gap = 14;
  const place = (coordinate, length, limit) => Math.max(8, Math.min(
    coordinate + gap + length <= limit - 8 ? coordinate + gap : coordinate - gap - length,
    limit - length - 8,
  ));
  return { left: place(point.x, size.width, bounds.width), top: place(point.y, size.height, bounds.height) };
}

export function describeIndicator(picked, context) {
  const { lang = 'en', snapshot, catalogue, signLayer, signLayers = [signLayer], stepIndex, baseStatus, storms, stormMode, lightning, satelliteSpec, radarItems } = context;
  const tr = (text, params) => translate(lang, text, params, MAP);
  const number = value => digits(value, lang);
  const when = iso => iso && Number.isFinite(toMs(iso)) ? formatBst(toMs(iso), lang) : tr('Not available');
  const storm = storms?.visible ? storms.snapshot : null;
  const rows = [];
  const row = (label, value) => rows.push({ label: tr(label), value });
  if (picked.type === 'position') return {
    title: tr('Your location'), eyebrow: tr('Device location'), color: PALETTE.sage, rows,
    note: tr('The dot is your position. The surrounding halo shows location accuracy, not weather risk.'),
  };

  if (picked.type === 'storm') {
    if (!storm) return null;
    const arrival = picked.kind === 'arrival' ? storm.arrivals?.find(item => item.pcode === picked.id) : null;
    const cell = storm.cells?.find(item => item.id === picked.id);
    if (!arrival && !cell) return null;
    const forecast = picked.kind === 'ring' || picked.kind === 'step';
    const title = arrival ? 'Storm arrival estimate' : forecast ? 'Predicted storm position'
      : picked.kind === 'track' || picked.kind === 'arrow' ? 'Storm movement forecast' : 'Storm cell';
    if (arrival) {
      const place = catalogue?.locations.find(item => item.pcode === arrival.pcode);
      row('Location', (lang === 'bn' ? place?.nameBn || place?.name : place?.name) ?? arrival.pcode);
      row('Estimated arrival', when(arrival.arrivalAt));
    } else {
      row('Cloud-top intensity', tr(STORM_INTENSITY[cell.intensity] ?? 'Not available'));
      if (forecast) {
        row('Forecast offset', tr('{n} min after the satellite image', { n: number(picked.minutes) }));
        row('Estimated time', Number.isFinite(toMs(storm.observedAt)) ? when(new Date(toMs(storm.observedAt) + picked.minutes * 60_000).toISOString()) : tr('Not available'));
      }
      row('Movement', cell.motion ? tr('Moving {dir} at {speed} km/h', { dir: tr(cell.motion.towards), speed: number(Math.round(cell.motion.speedKmh)) }) : tr('Movement not measured yet'));
    }
    row('Satellite image', when(storm.observedAt));
    return {
      title: tr(title), eyebrow: tr(stormMode === 'demo' ? 'Saved replay · not live' : 'Satellite analysis · experimental'),
      color: STORM_COLORS[cell?.intensity] ?? STORM_WARNING_COLOR, rows,
      note: tr(forecast ? 'Dashed circle = estimated future storm area, not a confirmed impact zone. Experimental forecast, not confirmed lightning.' : 'Cloud-top intensity is an experimental satellite estimate, not an official warning or confirmed lightning.'),
    };
  }

  if (picked.type === 'lightning') {
    const item = lightning?.visible && lightning.items.find(item => item.id === picked.id);
    if (!item) return null;
    const state = { reported: 'Lightning reported', none: 'No records in window', stale: 'Stale sample', unavailable: 'Data unavailable', 'not-checked': 'Not checked yet' };
    row('Status', tr(state[item.state] ?? 'Unknown state'));
    row('Recorded events', Number.isFinite(item.count) ? number(item.count) : tr('Count not available'));
    if (Number.isFinite(item.radiusKm)) row('Search radius', `${number(item.radiusKm)} ${tr('km')}`);
    if (item.window) row('Sample window', `${when(item.window.from)} – ${when(item.window.to)}`);
    row('Sampled at', when(item.sampledAt));
    return {
      title: item.kind === 'circle' ? tr('Lightning search circle') : tr('Lightning search location'),
      eyebrow: item.kind === 'circle' ? tr('Circle {id}', { id: item.id }) : (lang === 'bn' ? item.nameBn || item.name : item.name),
      color: LIGHTNING_COLORS[item.state], rows,
      note: tr('Sampled lightning records, not live monitoring. No records does not mean the area is safe.'),
    };
  }

  const resolved = resolveSelection(picked, snapshot, catalogue, lang);
  if (!resolved) return null;
  const inspectedLayer = signLayers.includes(picked.signLayer) ? picked.signLayer : signLayer;
  const layer = SIGN_LAYERS[inspectedLayer];
  const value = layer ? valueAt(resolved, layer.series, layer.districtSeries, stepIndex) : null;
  const mark = value === null ? null : layer.mark(value, {});
  for (const id of layer ? [inspectedLayer, ...signLayers.filter(id => id !== inspectedLayer)] : []) {
    const cfg = SIGN_LAYERS[id];
    const ownValue = valueAt(resolved, cfg.series, cfg.districtSeries, stepIndex);
    row(cfg.label, ownValue === null ? tr('No data') : id === 'thunder'
      ? tr(['None', 'Low', 'Moderate', 'High'][Math.round(ownValue)] ?? 'Not available')
      : `${number(Number(ownValue).toFixed(id === 'rain' ? 1 : 0))} ${tr(cfg.unit)}`);
    const status = id === 'thunder' ? snapshot?.sources?.openMeteo?.status ?? baseStatus : baseStatus;
    if (status !== 'ok') row(signLayers.length === 1 ? 'Status' : tr('{layer} status', { layer: tr(cfg.label) }), tr(status === 'stale' ? 'Forecast is stale' : status === 'not-checked' ? 'Loading forecast…' : 'Forecast data unavailable'));
  }
  if (layer) row('Forecast time', when(snapshot?.steps?.[stepIndex]));
  if (signLayers.length > 1) row('Map colors', tr(SIGN_LAYERS[signLayer].label));
  const pcodes = resolved.level === 'district' ? catalogue.locations.filter(item => item.district === resolved.id).map(item => item.pcode)
    : resolved.members?.map(item => item.pcode) ?? [resolved.dailyPcode];
  const arrivals = storm?.arrivals?.filter(item => pcodes.includes(item.pcode)) ?? [];
  const earliest = arrivals.sort((a, b) => toMs(a.arrivalAt) - toMs(b.arrivalAt))[0];
  if (earliest) row(stormMode === 'demo' ? 'Storm arrival in saved replay' : 'Earliest storm arrival in this area', when(earliest.arrivalAt));
  if (storms?.image && storm) row(stormMode === 'demo' ? 'Saved storm image' : 'Storm satellite image', when(storm.observedAt));
  if (satelliteSpec) row('Satellite image', when(satelliteSpec.time));
  if (radarItems?.length) row('Radar image', when(radarItems[0].time));
  return {
    title: resolved.name, eyebrow: signLayers.length > 1 ? `${tr(resolved.kind)} · ${tr(layer.label)}` : tr(resolved.kind), rows,
    color: !layer ? PALETTE.sage : mark ? mark.value === null ? PALETTE.sage : colorAt(layer.scale, mark.value) : STATUS_COLORS.unavailable,
    note: tr(!signLayers.length ? 'Weather layers are hidden. Active overlays are unchanged.' : storms?.image || satelliteSpec || radarItems?.length
      ? 'Weather colors and image colors are different layers. Green does not automatically mean safe; image pixels have no exact reading here.'
      : 'Colors follow the selected weather scale, not a general safe-to-danger rating.'),
    detail: layer ? resolved.note : null,
  };
}
