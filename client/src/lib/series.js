import { translate } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
const MEAN_KEYS = ['temp', 'rh', 'cc', 'hi', 'rf', 'ws', 'wg'];
const MAX_KEYS = ['ts', 'pop', 'wmo'];

function column(members, key, reducer, length) {
  if (!members.some((member) => member[key])) return undefined;
  return Array.from({ length }, (_, i) => {
    const values = members.map((member) => member[key]?.[i]).filter((value) => value !== null && value !== undefined);
    return values.length ? reducer(values) : null;
  });
}

export function meanSeries(members, length) {
  const out = {};
  for (const key of MEAN_KEYS) {
    const col = column(members, key, (values) => values.reduce((a, b) => a + b, 0) / values.length, length);
    if (col) out[key] = col.map((v) => (v === null ? null : Math.round(v * 100) / 100));
  }
  for (const key of MAX_KEYS) {
    const col = column(members, key, (values) => Math.max(...values), length);
    if (col) out[key] = col;
  }
  return out;
}

// Resolves a map selection into one displayable set of series plus descriptive text.
export function resolveSelection(selection, snapshot, catalogue, lang = 'en') {
  if (!selection || !catalogue) return null;
  const length = snapshot?.steps?.length ?? 0;
  const byPcode = new Map(catalogue.locations.map((location) => [location.pcode, location]));
  const districtOf = (code) => catalogue.districts.find((district) => district.pcode === code);
  const tr = (text, params) => translate(lang, text, params, MAP);
  const name = (item) => lang === 'bn' ? item?.nameBn || tr(item?.name ?? '') : item?.name;

  if (selection.level === 'district') {
    const district = districtOf(selection.id);
    if (!district) return null;
    return {
      level: 'district',
      id: district.pcode,
      name: name(district),
      nameBn: district.nameBn,
      kind: 'District',
      parent: tr('{name} division', { name: tr(district.division) }),
      series: snapshot?.districts?.[district.pcode] ?? null,
      note: tr('District values summarize its upazila forecasts: temperature is the average, rain, heat and wind show the highest upazila. BMD publishes no district-level forecast.'),
      dailyPcode: null,
      lat: district.lat,
      lon: district.lon,
    };
  }

  if (selection.level === 'upazila') {
    const location = byPcode.get(selection.id);
    if (!location) return null;
    const district = districtOf(location.district);
    return {
      level: 'upazila',
      id: location.pcode,
      name: name(location),
      nameBn: location.nameBn,
      kind: location.kind === 'thana' ? 'City thana' : 'Upazila',
      parent: tr('{name} district', { name: name(district) ?? '' }),
      series: snapshot?.locations?.[location.pcode] ?? null,
      note: null,
      dailyPcode: location.pcode,
      lat: location.lat,
      lon: location.lon,
    };
  }

  const polygon = catalogue.polygons[selection.id];
  if (!polygon) return null;
  const members = polygon.src.map((pcode) => byPcode.get(pcode)).filter(Boolean);
  const first = members[0];
  const polygonName = name({ ...polygon, nameBn: polygon.nameBn || (!polygon.approx && polygon.kind !== 'city-corporation' ? first?.nameBn : null) });
  const district = first ? districtOf(first.district) : null;
  const memberSeries = members.map((member) => snapshot?.locations?.[member.pcode]).filter(Boolean);

  let note;
  let series;
  if (polygon.approx) {
    note = tr('BMD has no separate forecast for {area}. This shows the forecast of the nearest BMD location, {nearest}.', { area: polygonName, nearest: name(first) });
    series = memberSeries[0] ?? null;
  } else {
    note = tr('{area} is shown as the average of its {n} BMD thanas.', { area: polygonName, n: members.length });
    series = memberSeries.length ? meanSeries(memberSeries, length) : null;
  }

  return {
    level: 'polygon',
    id: selection.id,
    name: polygonName,
    nameBn: polygon.nameBn,
    kind: polygon.kind === 'city-corporation' ? 'City corporation' : 'Upazila',
    parent: district ? tr('{name} district', { name: name(district) }) : '',
    series,
    note,
    dailyPcode: polygon.approx && first ? first.pcode : null,
    members,
    lat: first?.lat,
    lon: first?.lon,
  };
}

// The single number a layer shows for a selection at one step (used by tooltips).
export function valueAt(resolved, key, districtKey, stepIndex) {
  if (!resolved?.series) return null;
  const column = resolved.level === 'district' ? resolved.series[districtKey] : resolved.series[key];
  return column?.[stepIndex] ?? null;
}
