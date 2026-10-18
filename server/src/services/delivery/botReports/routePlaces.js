import { NEIGHBOURHOODS } from '../../neighbourhoods.js';
import {
  areas, districts, divisions, locationByPcode, locations,
} from '../../geo.js';
import { haversineKm } from '../../time.js';
import {
  allPlaces, normalize, placeById, placeForPoint, placeInPolygon,
} from './places.js';

// Where a road trip can start or end. Everything the weather commands know (districts, upazilas, city thanas, city corporations) plus the
// 8 divisions, the unions, paurashavas and city wards of the boundary data (about 5,000), the route page's neighbourhoods and a few
// well-known places. None of the added places has a forecast of its own: each borrows the forecast of the upazila or thana it lies in.
// An id is what a route button carries (telegramBot.js): short, letters and digits only, and looked up again when the button comes back.
const MAX_MATCHES = 5;
const BD = { minLat: 20.3, maxLat: 26.9, minLon: 87.5, maxLon: 93.2 };

export const inBangladesh = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon)
  && lat >= BD.minLat && lat <= BD.maxLat && lon >= BD.minLon && lon <= BD.maxLon;

// ---------- district towns ----------
// A trip "to Bandarban" goes to the town, not to the middle of the district's map (45 km into the hills for Bandarban). The town is the
// "Sadar" upazila (the plain one where a district has a north/south pair), else "Kotwali" (Chattogram, Jashore); Dhaka and Rajshahi have
// neither, so they are named here.
const TOWN_OVERRIDES = new Map([['3026', '302654'], ['5081', '508122']]); // Dhaka: Motijheel; Rajshahi: Boalia

export function districtTown(districtCode) {
  const fixed = TOWN_OVERRIDES.get(String(districtCode));
  if (fixed) return locationByPcode.get(fixed) ?? null;
  const own = locations.filter((location) => location.district === String(districtCode));
  const sadar = own.filter((location) => /\bsadar\b/i.test(location.name));
  return sadar.find((location) => !/dakshin|uttar|south|north/i.test(location.name)) ?? sadar[0]
    ?? own.find((location) => /^kotwali$/i.test(location.name)) ?? null;
}

const DIVISION_BN = {
  Barishal: 'বরিশাল', Chattogram: 'চট্টগ্রাম', Dhaka: 'ঢাকা', Khulna: 'খুলনা', Mymensingh: 'ময়মনসিংহ', Rajshahi: 'রাজশাহী', Rangpur: 'রংপুর', Sylhet: 'সিলেট',
};

// Older and other common spellings, normalized (see places.js normalize: "St. Martin" becomes "st martin", "St.Martin Dwip" "stmartin dwip").
const ALIASES = new Map([
  ['chittagong', 'chattogram'], ['ctg', 'chattogram'], ['comilla', 'cumilla'], ['jessore', 'jashore'], ['barisal', 'barishal'], ['bogra', 'bogura'],
  ['dacca', 'dhaka'], ['coxsbazar', 'coxs bazar'], ['cox bazar', 'coxs bazar'], ['coxs bazaar', 'coxs bazar'], ['coxsbazaar', 'coxs bazar'],
  ['chapainawabganj', 'chapainababganj'], ['chapai nawabganj', 'chapainababganj'], ['chapai nababganj', 'chapainababganj'],
  ['netrokona', 'netrakona'], ['moulvi bazar', 'moulvibazar'], ['maulvibazar', 'moulvibazar'], ['maulvi bazar', 'moulvibazar'],
  ['khagrachari', 'khagrachhari'], ['laxmipur', 'lakshmipur'], ['jhalakathi', 'jhalokati'], ['jhalokathi', 'jhalokati'], ['narshingdi', 'narsingdi'],
  ['srimangal', 'sreemangal'],
  ...['st martin', 'st martins', 'saint martin', 'saint martins', 'st martin island', 'st martins island', 'saint martin island', 'saint martins island',
    'stmartin', 'stmartins', 'narikel jinjira'].map((key) => [key, 'stmartin dwip']),
  ['চিটাগাং', 'চট্টগ্রাম'],
]);
const alias = (text) => ALIASES.get(text) ?? text;

// Well-known places that are neither an admin area nor a neighbourhood above: [name, Bangla name, lat, lon, district code].
const LANDMARKS = [
  ['Kuakata', 'কুয়াকাটা', 21.8197, 90.1220, '1078'],
];

// A bigger kind of place is what a bare name usually means: "Faridpur" is the district, not the upazila of the same name in Pabna.
const RANK = {
  division: 0, district: 0, location: 1, polygon: 2, landmark: 3, neighbourhood: 3, area: 4, osm: 5,
};
const KIND_ORDER = {
  thana: 0, upazila: 1, 'city-corporation': 2, district: 3,
};

const districtByCode = new Map(districts.map((district) => [district.pcode, district]));
const districtKeys = (code) => {
  const district = districtByCode.get(String(code));
  return district ? [normalize(district.name), normalize(district.nameBn)].filter(Boolean) : [];
};
const slug = (text) => normalize(text).replace(/[^a-z0-9]/g, '');

function entry(fields) {
  return {
    approx: false,
    pointName: null,
    pointNameBn: null,
    parentName: null,
    weatherId: null,
    ...fields,
    keys: [...new Set([normalize(fields.name), normalize(fields.nameBn)].filter(Boolean))],
    parentKeys: fields.parentKeys ?? [],
  };
}

// "ADM4-29066614B44063678233613" -> "A44063678233613"; "OSM-node-9026037312" -> "O9026037312".
function areaId(raw) {
  const adm = /^ADM4-\d+B(\d{1,20})$/.exec(String(raw));
  if (adm) return `A${adm[1]}`;
  const osm = /^OSM-node-(\d{1,20})$/.exec(String(raw));
  return osm ? `O${osm[1]}` : null;
}

function build() {
  const out = [];
  for (const place of allPlaces()) {
    if (place.level === 'district') {
      const town = districtTown(place.id);
      if (!town) continue;
      out.push(entry({
        id: place.id, level: 'district', kind: 'district', name: place.name, nameBn: place.nameBn, districtCode: place.id,
        lat: town.lat, lon: town.lon, pointName: town.name, pointNameBn: town.nameBn ?? null, weatherId: town.pcode,
      }));
    } else if (inBangladesh(place.lat, place.lon)) {
      out.push(entry({
        id: place.id, level: place.level, kind: place.kind, name: place.name, nameBn: place.nameBn, districtCode: place.districtCode,
        lat: place.lat, lon: place.lon, weatherId: place.id, approx: place.level === 'polygon' && place.approx, parentKeys: place.parentKeys,
      }));
    }
  }

  for (const name of divisions) {
    const district = districts.find((item) => normalize(item.name) === normalize(name));
    const town = district ? districtTown(district.pcode) : null;
    if (!town) continue;
    out.push(entry({
      id: `V${slug(name)}`, level: 'division', kind: 'division', name, nameBn: DIVISION_BN[name] ?? null, districtCode: district.pcode,
      lat: town.lat, lon: town.lon, pointName: town.name, pointNameBn: town.nameBn ?? null, weatherId: town.pcode,
    }));
  }

  // Unions, paurashavas and city wards. 50 paurashavas are named only "Paurashava": they take their upazila's name. "(Part)" pieces of
  // one area are listed once.
  const seen = new Set();
  for (const area of areas) {
    const id = areaId(area.id);
    if (!id || !inBangladesh(area.lat, area.lon)) continue;
    const bare = String(area.name).replace(/\s*\(part\)\s*$/i, '').trim();
    const name = /^paurashava$/i.test(bare) ? `${area.parentName} Paurashava` : bare;
    const key = `${normalize(name)}|${area.parentPid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inCity = area.parentKind === 'city corporation';
    const kind = inCity ? (/^ward\b/i.test(name) ? 'ward' : 'city-area') : (/paurashava|pourashava/i.test(name) ? 'paurashava' : 'union');
    out.push(entry({
      id, level: 'area', kind, name, nameBn: area.nameBn ?? null, districtCode: area.district, parentName: area.parentName, parentPid: area.parentPid,
      lat: area.lat, lon: area.lon, approx: true, parentKeys: [...districtKeys(area.district), normalize(area.parentName)].filter(Boolean),
    }));
  }

  // The route page's rule: a neighbourhood that the boundary data already names within 3 km is that area, not a second entry.
  for (const item of NEIGHBOURHOODS) {
    const duplicate = [...locations, ...areas].some((known) => (
      String(known.name).toLowerCase() === item.name.toLowerCase() && haversineKm(known.lat, known.lon, item.lat, item.lon) < 3
    ));
    if (duplicate) continue;
    const weather = placeById(item.weatherFrom.id);
    out.push(entry({
      id: `N${slug(item.name)}`.slice(0, 24), level: 'neighbourhood', kind: 'neighbourhood', name: item.name, nameBn: item.nameBn,
      districtCode: weather?.districtCode ?? null, parentName: item.city, lat: item.lat, lon: item.lon, weatherId: item.weatherFrom.id, approx: true,
      parentKeys: [normalize(item.city), ...districtKeys(weather?.districtCode)],
    }));
  }

  for (const [name, nameBn, lat, lon, districtCode] of LANDMARKS) {
    out.push(entry({
      id: `L${slug(name)}`, level: 'landmark', kind: 'landmark', name, nameBn, districtCode, lat, lon, approx: true, parentKeys: districtKeys(districtCode),
    }));
  }
  return out;
}

let index = null;
let byId = null;
function ensure() {
  if (!index) {
    index = build();
    byId = new Map(index.map((item) => [item.id, item]));
  }
}

// ---------- points from outside the lists (OpenStreetMap search) ----------
// A found point's id is its own rounded position ("G" + 7 + 7 digits), so a button still works after a restart; the name is kept in
// memory only while it lasts, after which the point is named after the area it lies in.
const POINT_ID = /^G(\d{7})(\d{7})$/;
const points = new Map();
const MAX_POINTS = 2000;

export function pointEntry({ name, lat, lon }) {
  const latE5 = Math.round(lat * 1e5);
  const lonE5 = Math.round(lon * 1e5);
  const rounded = { lat: latE5 / 1e5, lon: lonE5 / 1e5 };
  if (!inBangladesh(rounded.lat, rounded.lon)) return null;
  const weather = placeForPoint(rounded.lat, rounded.lon);
  const id = `G${String(latE5).padStart(7, '0')}${String(lonE5).padStart(7, '0')}`;
  const found = entry({
    id, level: 'osm', kind: 'osm', name: String(name || weather?.name || '').slice(0, 80), nameBn: null, districtCode: weather?.districtCode ?? null,
    ...rounded, weatherId: weather?.id ?? null, approx: true,
  });
  if (!found.name) return null;
  points.delete(id);
  points.set(id, found);
  if (points.size > MAX_POINTS) points.delete(points.keys().next().value);
  return found;
}

// A shared GPS position as a route start. The exact point is used for this one road search only; the buttons and anything kept refer to
// the area it lies in (`id`), never to the coordinates.
export function hereEntry(lat, lon) {
  const weather = placeForPoint(lat, lon);
  if (!weather) return null;
  return {
    ...(routePlaceById(weather.id) ?? {}), level: 'here', kind: 'here', here: true, lat, lon, weatherId: weather.id,
    name: weather.name, nameBn: weather.nameBn, approx: false, pointName: null, pointNameBn: null,
  };
}

export function routePlaceById(id) {
  ensure();
  const key = String(id ?? '');
  if (byId.has(key)) return byId.get(key);
  if (points.has(key)) return points.get(key);
  const match = POINT_ID.exec(key);
  return match ? pointEntry({ name: null, lat: Number(match[1]) / 1e5, lon: Number(match[2]) / 1e5 }) : null;
}

// The place whose forecast stands in for a route place.
export function weatherPlaceOf(item) {
  if (!item) return null;
  if (item.weatherId) return placeById(item.weatherId);
  if (item.level === 'area') return placeInPolygon(item.parentPid, item.lat, item.lon) ?? placeForPoint(item.lat, item.lon);
  return placeForPoint(item.lat, item.lon);
}

// ---------- search ----------
const KIND_WORDS = new Map([
  ['district', 'district'], ['zila', 'district'], ['jela', 'district'], ['জেলা', 'district'],
  ['division', 'division'], ['bibhag', 'division'], ['বিভাগ', 'division'],
  ['upazila', 'upazila'], ['upazilla', 'upazila'], ['উপজেলা', 'upazila'],
  ['thana', 'thana'], ['থানা', 'thana'], ['city thana', 'thana'], ['সিটি থানা', 'thana'],
  ['city corporation', 'city-corporation'], ['সিটি কর্পোরেশন', 'city-corporation'],
  ['union', 'union'], ['ইউনিয়ন', 'union'],
  ['ward', 'ward'], ['ওয়ার্ড', 'ward'],
  ['paurashava', 'paurashava'], ['pourashava', 'paurashava'], ['municipality', 'paurashava'], ['পৌরসভা', 'paurashava'],
  ['city', 'town'], ['town', 'town'], ['shohor', 'town'], ['শহর', 'town'],
  ['neighbourhood', 'neighbourhood'], ['area', 'neighbourhood'], ['এলাকা', 'neighbourhood'],
]);

const HINT_TEST = {
  district: (item) => item.level === 'district',
  town: (item) => item.level === 'district',
  division: (item) => item.level === 'division',
  upazila: (item) => item.kind === 'upazila' || item.kind === 'city-corporation',
  thana: (item) => item.kind === 'thana',
  'city-corporation': (item) => item.kind === 'city-corporation',
  union: (item) => item.kind === 'union',
  ward: (item) => item.kind === 'ward' || item.kind === 'city-area',
  paurashava: (item) => item.kind === 'paurashava',
  neighbourhood: (item) => item.level === 'neighbourhood' || item.level === 'landmark' || item.kind === 'city-area',
};

// "Durgapur, Puthia, Rajshahi (union)" -> { name: "durgapur", hint: "union", qualifiers: ["puthia", "rajshahi"] }. A kind in brackets at the
// end, or a trailing kind word ("Rangpur division", "Dhaka city"), narrows the search; each part after a comma must name a parent.
function parseQuery(query) {
  let text = String(query ?? '');
  let hint = null;
  const bracket = /\(([^()]*)\)\s*$/.exec(text);
  if (bracket && KIND_WORDS.has(normalize(bracket[1]))) {
    hint = KIND_WORDS.get(normalize(bracket[1]));
    text = text.slice(0, bracket.index);
  }
  const [namePart, ...rest] = text.split(',');
  let words = normalize(namePart).split(' ').filter(Boolean);
  if (!hint && words.length > 2 && KIND_WORDS.has(words.slice(-2).join(' '))) {
    hint = KIND_WORDS.get(words.slice(-2).join(' '));
    words = words.slice(0, -2);
  } else if (!hint && words.length > 1 && KIND_WORDS.has(words.at(-1))) {
    hint = KIND_WORDS.get(words.at(-1));
    words = words.slice(0, -1);
  }
  return { name: alias(words.join(' ')), hint, qualifiers: rest.map((part) => alias(normalize(part))).filter(Boolean) };
}

const rankOf = (item) => RANK[item.level] ?? 9;
const wordsOf = (key) => key.split(' ');

function poolFor({ hint, qualifiers }) {
  let pool = index.filter((item) => item.level !== 'division' || hint === 'division');
  if (hint) pool = pool.filter(HINT_TEST[hint] ?? (() => true));
  if (qualifiers.length) {
    pool = pool.filter((item) => qualifiers.every((qualifier) => (
      item.parentKeys.some((key) => key === qualifier || key.startsWith(qualifier)) || (item.level === 'district' && item.keys.includes(qualifier))
    )));
  }
  return pool;
}

// Among equally good matches the bigger places win: a district name (whole, or its start) is the district; otherwise upazilas, thanas and
// city corporations hide unions and neighbourhoods of the same name (`hidden` counts them, so the reply can say how to reach them).
function preferBigger(hits, districtFirst) {
  let kept = hits;
  if (districtFirst && hits.some((item) => item.level === 'district')) kept = hits.filter((item) => item.level === 'district');
  else if (Math.min(...hits.map(rankOf)) <= RANK.polygon) kept = hits.filter((item) => rankOf(item) <= RANK.polygon);
  kept.sort((a, b) => (rankOf(a) - rankOf(b)) || ((KIND_ORDER[a.kind] ?? 4) - (KIND_ORDER[b.kind] ?? 4)) || a.name.localeCompare(b.name));
  return { kept, hidden: hits.length - kept.length };
}

function matchEntries(parts) {
  const { name } = parts;
  if (name.length < 2) return { matches: [], total: 0, tier: 0, hidden: 0 };
  const pool = poolFor(parts);
  const tiers = [
    (item) => item.keys.includes(name),
    (item) => item.keys.some((key) => key.startsWith(name) || wordsOf(key).some((word) => word.startsWith(name))),
    (item) => name.length >= 3 && item.keys.some((key) => key.includes(name)),
  ];
  for (let tier = 0; tier < tiers.length; tier += 1) {
    const hits = pool.filter(tiers[tier]);
    if (!hits.length) continue;
    const { kept, hidden } = preferBigger(hits, tier <= 1);
    return { matches: kept.slice(0, MAX_MATCHES), total: kept.length, tier: tier + 1, hidden };
  }
  return { matches: [], total: 0, tier: 0, hidden: 0 };
}

// Edit distance with an early exit once it must exceed `limit`.
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

// Names one or two typing mistakes away ("Bandarbn" -> Bandarban). Only offered as a suggestion, never used without asking.
function nearMatches(parts) {
  const limit = parts.name.length >= 8 ? 2 : parts.name.length >= 4 ? 1 : 0;
  if (!limit) return { matches: [], total: 0, tier: 0, hidden: 0 };
  let best = limit + 1;
  let hits = [];
  for (const item of poolFor(parts)) {
    const distance = Math.min(...item.keys.map((key) => editDistance(parts.name, key, limit)));
    if (distance > limit || distance > best) continue;
    if (distance < best) {
      best = distance;
      hits = [];
    }
    hits.push(item);
  }
  if (!hits.length) return { matches: [], total: 0, tier: 0, hidden: 0 };
  const { kept, hidden } = preferBigger(hits, false);
  return { matches: kept.slice(0, MAX_MATCHES), total: kept.length, tier: 4, hidden };
}

// -> { matches, total, tier (1 whole name, 2 start of a word, 3 inside, 4 near spelling; 0 none), hidden, retried }.
// "Savar Dhaka" without a comma is tried as "Savar, Dhaka" when the whole text names nothing (`retried`). `near` adds the spelling tier.
export function findRoutePlaces(query, { near = false } = {}) {
  ensure();
  const parts = parseQuery(query);
  const found = matchEntries(parts);
  if (found.matches.length) return { ...found, retried: false };
  if (!parts.qualifiers.length) {
    const words = parts.name.split(' ');
    for (let k = 1; k <= Math.min(2, words.length - 1); k += 1) {
      const retry = matchEntries({ ...parts, name: alias(words.slice(0, -k).join(' ')), qualifiers: [alias(words.slice(-k).join(' '))] });
      if (retry.matches.length) return { ...retry, retried: true };
    }
  }
  return { ...(near ? nearMatches(parts) : found), retried: false };
}

export const routePlaceInternals = { areaId, editDistance, parseQuery, entries: () => (ensure(), index) };
