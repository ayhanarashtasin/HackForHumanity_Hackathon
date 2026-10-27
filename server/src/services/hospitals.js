import fs from 'node:fs';
import { env } from '../config/env.js';
import { routeWeatherInternals } from './routeWeather.js';

// Hospitals along a road route, searched in server/data/hospitals-bd.json: every hospital in Bangladesh on OpenStreetMap, with the phone
// numbers OSM has (built by scripts/build-hospitals.mjs). No network call per route, so the list appears at once, offline too, and an
// outage of a public map server cannot empty it. Nothing is invented: a name, address or phone OSM does not have stays null.
const { distanceKm } = routeWeatherInternals;

const DATA_URL = new URL('../../data/hospitals-bd.json', import.meta.url);
const DISTANCE_STEP_KM = 0.5;
const MAX_ROAD_POINTS = 2000;
const CELL_DEG = 0.1; // ~11 km grid cells for the index

let loaded = null;

const unavailableError = () => Object.assign(new Error('Hospital search is unavailable.'), { code: 'HOSPITALS_UNAVAILABLE' });

// Digits and a leading "+" only; fewer than 6 digits is not trusted as a phone number. Of several numbers ("a; b") the first is used.
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const first = text.split(/[,;/]/)[0].trim();
  const digits = first.replace(/[^\d]/g, '');
  if (digits.length < 6) return null;
  return { display: first, dial: `${first.startsWith('+') ? '+' : ''}${digits}` };
}

const cellOf = (lat, lon) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
const SAME_PLACE_KM = 1;
const nameKey = (text) => String(text ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
const FIELDS = ['name', 'nameEn', 'nameBn', 'address', 'area', 'areaBn', 'phone', 'phoneDial', 'phoneSource', 'website', 'email'];
// phoneEmergency travels with the phone: a twin's number is only taken together with what kind of number it is.
const emailOf = (value) => (typeof value === 'string' && /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(value) ? value : null);
const httpUrl = (value) => (typeof value === 'string' && /^https?:\/\/[^\s"<>]+$/i.test(value) ? value : null);

// Google Maps URLs (https://developers.google.com/maps/documentation/urls): a documented search link that needs no key and opens the
// Google Maps app on phones. English name and place when OSM has them, as Google matches those best. null without a name to search.
// A name that is only a kind of hospital ("Eye Hospital", "Upazila Health Complex", "চক্ষু হাসপাতাল") cannot find one place by search:
// Google lists every one nearby. Those get no search link (the directions link still goes to the exact spot).
const GENERIC_NAME = /^\s*(the\s+)?((eye|general|sadar|district|children'?s?|child|mother\s*(and|&)\s*child|maternity|chest|tb|mental|dental|private|govt\.?|government|community|union|upazila)\s+)*(hospital|clinic|medical\s+cent(er|re)|health\s+(complex|cent(er|re))|diagnostic\s+cent(er|re))\s*$/i;
const GENERIC_NAME_BN = /^\s*((চক্ষু|সদর|জেলা|শিশু|মা\s*ও\s*শিশু|জেনারেল|সরকারি|কমিউনিটি|ইউনিয়ন|উপজেলা)\s+)*(হাসপাতাল|হসপিটাল|ক্লিনিক|স্বাস্থ্য\s*কমপ্লেক্স|স্বাস্থ্য\s*কেন্দ্র)\s*$/u;
const isGenericName = (name) => GENERIC_NAME.test(name) || GENERIC_NAME_BN.test(name);

function googleSearchUrl(hospital) {
  const name = hospital.nameEn || hospital.name || hospital.nameBn;
  if (!name || isGenericName(name)) return null;
  const query = [name, hospital.area].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// The dataset plus a grid index over it. `rows` is the parsed file's `hospitals` array. One hospital mapped twice on OpenStreetMap (as
// a point and as a building outline, usually metres apart) has the same name: entries whose names match within 1 km are merged into one,
// each missing field filled from the other, so a phone number on either copy is kept.
export function indexHospitals(rows) {
  const grid = new Map();
  const hospitals = [];
  const near = (lat, lon) => {
    const row = Math.floor(lat / CELL_DEG);
    const col = Math.floor(lon / CELL_DEG);
    return [-1, 0, 1].flatMap((dr) => [-1, 0, 1].flatMap((dc) => grid.get(`${row + dr}:${col + dc}`) ?? []));
  };
  for (const row of rows ?? []) {
    if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon) || !row.id) continue;
    const phone = normalizePhone(row.phone);
    const hospital = {
      id: row.id,
      name: row.name || null,
      nameEn: row.nameEn || null,
      nameBn: row.nameBn || null,
      lat: row.lat,
      lon: row.lon,
      address: row.address || null,
      area: row.area || null,
      areaBn: row.areaBn || null,
      phone: phone?.display ?? null,
      phoneDial: phone?.dial ?? null,
      // Where the number was found (an OpenStreetMap object, or the official gov.bd contact page), so anyone can check it.
      phoneSource: phone ? httpUrl(row.phoneSource) : null,
      phoneEmergency: Boolean(phone && row.phoneEmergency), // the official page lists it as the emergency department's number
      website: httpUrl(row.website),
      email: emailOf(row.email),
      mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${row.lat.toFixed(6)},${row.lon.toFixed(6)}`,
      searchUrl: null,
    };
    const keys = new Set([hospital.name, hospital.nameEn, hospital.nameBn].map(nameKey).filter(Boolean));
    const twin = keys.size ? near(hospital.lat, hospital.lon).find((other) => (
      [other.name, other.nameEn, other.nameBn].some((value) => keys.has(nameKey(value)))
      && distanceKm([other.lon, other.lat], [hospital.lon, hospital.lat]) <= SAME_PLACE_KM
    )) : null;
    if (twin) {
      if (!twin.phoneDial && hospital.phoneDial) twin.phoneEmergency = hospital.phoneEmergency;
      for (const field of FIELDS) twin[field] ??= hospital[field];
      continue;
    }
    hospitals.push(hospital);
    const key = cellOf(row.lat, row.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(hospital);
  }
  // A link, not a lookup: Google Maps' own search for this name in this upazila, where Google shows the place's phone number if it has
  // one. Nothing is fetched or stored from Google. Set after merging, so a twin's name or area can complete it.
  for (const hospital of hospitals) hospital.searchUrl = googleSearchUrl(hospital);
  return { hospitals, grid };
}

// The hospital's name and place line in the reader's language when OpenStreetMap has it in that language; otherwise the name as mapped
// (never translated). Shared by the website and the Telegram reply.
export function hospitalLabels(hospital, lang) {
  const name = lang === 'bn' ? hospital.nameBn || hospital.nameEn || hospital.name : hospital.nameEn || hospital.nameBn || hospital.name;
  const area = lang === 'bn' ? hospital.areaBn || hospital.area : hospital.area || hospital.areaBn;
  return { name: name || null, area: area || null };
}

function loadDataset() {
  if (!loaded) {
    try {
      loaded = indexHospitals(JSON.parse(fs.readFileSync(DATA_URL, 'utf8')).hospitals);
    } catch {
      throw unavailableError(); // a missing or broken file is "unavailable", never "no hospitals"
    }
  }
  return loaded;
}

// Points every `stepKm` along the road, always including both ends.
function pointsEvery(coordinates, stepKm) {
  const points = [coordinates[0]];
  let carried = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [a, b] = [coordinates[index - 1], coordinates[index]];
    const length = distanceKm(a, b);
    let along = stepKm - carried;
    while (along <= length) {
      const t = along / length;
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along += stepKm;
    }
    carried = length - (along - stepKm);
  }
  const last = coordinates.at(-1);
  if (points.at(-1)[0] !== last[0] || points.at(-1)[1] !== last[1]) points.push(last);
  return points;
}

function routeLengthKm(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += distanceKm(coordinates[index - 1], coordinates[index]);
  return total;
}

// The road as the website sends it to the hospital search (client/src/lib/routeWeather.js compactRoute): ~1 m rounding and no point
// closer than `minKm` to the last one kept, both ends always kept. The Telegram bot searches this same copy, so it lists the same hospitals.
export function compactRoute(coordinates, minKm = 0.1) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return coordinates ?? [];
  const round = ([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
  const kept = [round(coordinates[0])];
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    if (distanceKm(kept.at(-1), coordinates[index]) >= minKm) kept.push(round(coordinates[index]));
  }
  kept.push(round(coordinates.at(-1)));
  return kept;
}

// Points along the road at most every half kilometre (spread out on very long trips), so a distance is within ~0.25 km of the true value.
function roadPoints(coordinates) {
  return pointsEvery(coordinates, Math.max(DISTANCE_STEP_KM, routeLengthKm(coordinates) / (MAX_ROAD_POINTS - 1)));
}

// Which of two hospitals near the same stretch of road is more useful to someone who needs one: a name, then a phone, then nearer.
const usefulness = (a, b) => (Boolean(b.name) - Boolean(a.name)) || (Boolean(b.phoneDial) - Boolean(a.phoneDial))
  || (a.distanceFromRouteKm - b.distanceFromRouteKm) || String(a.name ?? '').localeCompare(String(b.name ?? ''));

// -> [{ id, name, nameBn, lat, lon, address, area, phone, phoneDial, mapsUrl, distanceFromRouteKm, alongKm }] in travel order (alongKm:
// where on the trip it is passed), each hospital once, at most `maxResults`, spread over the whole road: the road is cut into
// `maxResults` stretches and each stretch contributes its most useful hospital before any stretch gets a second. [] when none is within
// `radiusKm`; null when the feature is switched off. Throws HOSPITALS_UNAVAILABLE when the hospital file cannot be read.
export async function hospitalsAlongRoute(coordinates, { config = env.hospitals, dataset = null } = {}) {
  if (!config.enabled) return null;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !(routeLengthKm(coordinates) > 0)) return [];
  const { grid } = dataset ?? loadDataset();

  const points = roadPoints(coordinates);
  const along = [0];
  for (let index = 1; index < points.length; index += 1) along.push(along[index - 1] + distanceKm(points[index - 1], points[index]));
  const totalKm = along.at(-1);

  const reach = Math.ceil(config.radiusKm / (111 * CELL_DEG * 0.9)) + 1; // cells to look at on each side (a degree of longitude is ~0.9 of one of latitude here)
  const nearest = new Map(); // hospital -> { distance, index of the nearest road point }
  points.forEach(([lon, lat], pointIndex) => {
    const row = Math.floor(lat / CELL_DEG);
    const col = Math.floor(lon / CELL_DEG);
    for (let dr = -reach; dr <= reach; dr += 1) {
      for (let dc = -reach; dc <= reach; dc += 1) {
        for (const hospital of grid.get(`${row + dr}:${col + dc}`) ?? []) {
          const distance = distanceKm([lon, lat], [hospital.lon, hospital.lat]);
          if (distance <= config.radiusKm && distance < (nearest.get(hospital)?.distance ?? Infinity)) nearest.set(hospital, { distance, pointIndex });
        }
      }
    }
  });

  const found = [...nearest].map(([hospital, { distance, pointIndex }]) => ({
    ...hospital, distanceFromRouteKm: Math.round(distance * 10) / 10, alongKm: Math.round(along[pointIndex] * 10) / 10,
  }));
  const stretches = new Map();
  for (const hospital of found) {
    const stretch = totalKm ? Math.min(config.maxResults - 1, Math.floor((hospital.alongKm / totalKm) * config.maxResults)) : 0;
    if (!stretches.has(stretch)) stretches.set(stretch, []);
    stretches.get(stretch).push(hospital);
  }
  for (const list of stretches.values()) list.sort(usefulness);

  // Round-robin over the stretches: every stretch with a hospital gets one before a busy city stretch gets a second.
  const chosen = [];
  for (let round = 0; chosen.length < config.maxResults; round += 1) {
    const picks = [...stretches.values()].map((list) => list[round]).filter(Boolean);
    if (!picks.length) break;
    chosen.push(...picks.sort(usefulness).slice(0, config.maxResults - chosen.length));
  }
  return chosen.sort((a, b) => a.alongKm - b.alongKm || a.distanceFromRouteKm - b.distanceFromRouteKm);
}

export function resetHospitalsForTests() {
  loaded = null;
}

export const hospitalsInternals = { pointsEvery, roadPoints, routeLengthKm, loadDataset };
