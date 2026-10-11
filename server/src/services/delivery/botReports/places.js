import {
  districts, locationByPcode, locations, polygons,
} from '../../geo.js';

// The places the bot can talk about: the 64 districts, the 544 BMD locations (upazilas and city thanas) and the 25 boundary areas that BMD
// has no code for (new upazilas and city corporations, forecast from their nearest or member locations). Ids never collide: a district is
// 4 digits, a BMD location 6 digits, a boundary area starts with "X". An id is what the buttons carry, so it is validated on the way back in.
const MAX_MATCHES = 5;

const districtByCode = new Map(districts.map((district) => [district.pcode, district]));

// Lower-case, no punctuation, single spaces. Combining marks are kept: Bangla vowel signs are marks, not letters.
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function build() {
  const places = [];
  for (const district of districts) {
    places.push({
      id: district.pcode, level: 'district', kind: 'district', name: district.name, nameBn: district.nameBn,
      districtCode: district.pcode, members: district.upazilas, approx: false, lat: district.lat, lon: district.lon,
    });
  }
  for (const location of locations) {
    places.push({
      id: location.pcode, level: 'location', kind: location.kind === 'thana' ? 'thana' : 'upazila', name: location.name, nameBn: location.nameBn ?? null,
      districtCode: location.district, members: [location.pcode], approx: false, lat: location.lat, lon: location.lon,
    });
  }
  for (const [id, polygon] of Object.entries(polygons)) {
    if (locationByPcode.has(id)) continue;
    const first = locationByPcode.get(polygon.src?.[0]);
    places.push({
      id, level: 'polygon', kind: polygon.kind === 'city-corporation' ? 'city-corporation' : 'upazila', name: polygon.name, nameBn: null,
      districtCode: first?.district ?? null, members: polygon.src ?? [], approx: Boolean(polygon.approx), lat: first?.lat ?? null, lon: first?.lon ?? null,
    });
  }
  for (const place of places) {
    place.keys = [normalize(place.name), normalize(place.nameBn)].filter(Boolean);
    const parent = districtByCode.get(place.districtCode);
    place.parentKeys = parent ? [normalize(parent.name), normalize(parent.nameBn)].filter(Boolean) : [];
  }
  return places;
}

let index = null;
let byId = null;
function ensure() {
  if (!index) {
    index = build();
    byId = new Map(index.map((place) => [place.id, place]));
  }
}

export function placeById(id) {
  ensure();
  return byId.get(String(id)) ?? null;
}

export function parentOf(place) {
  return districtByCode.get(place?.districtCode) ?? null;
}

// "Badda", "Badda, Dhaka", "Dhaka district", "বাড্ডা". A trailing kind word ("thana", "upazila", "district", "জেলা") narrows the match.
const KIND_WORDS = new Map([
  ['district', 'district'], ['zila', 'district'], ['জেলা', 'district'],
  ['upazila', 'upazila'], ['upazilla', 'upazila'], ['উপজেলা', 'upazila'],
  ['thana', 'thana'], ['থানা', 'thana'],
]);

function splitQuery(query) {
  const [namePart, ...rest] = String(query ?? '').split(',');
  const words = normalize(namePart).split(' ').filter(Boolean);
  let hint = null;
  if (words.length > 1 && KIND_WORDS.has(words.at(-1))) hint = KIND_WORDS.get(words.pop());
  return { name: words.join(' '), hint, qualifier: normalize(rest.join(' ')) };
}

const wordsOf = (key) => key.split(' ');

// -> { matches: [place], total } where matches holds at most 5 places of the best-matching tier:
// 1 the whole name, 2 the start of the name or of a word in it, 3 anywhere in the name.
export function findPlaces(query) {
  ensure();
  const { name, hint, qualifier } = splitQuery(query);
  if (name.length < 2) return { matches: [], total: 0 };

  let pool = index;
  if (qualifier) pool = pool.filter((place) => place.parentKeys.some((key) => key === qualifier || key.startsWith(qualifier)) || (place.level === 'district' && place.keys.some((key) => key === qualifier)));
  if (hint) pool = pool.filter((place) => (hint === 'upazila' ? place.kind === 'upazila' || place.kind === 'city-corporation' : place.kind === hint));

  const tiers = [
    (place) => place.keys.includes(name),
    (place) => place.keys.some((key) => key.startsWith(name) || wordsOf(key).some((word) => word.startsWith(name))),
    (place) => name.length >= 3 && place.keys.some((key) => key.includes(name)),
  ];
  for (const test of tiers) {
    const hits = pool.filter(test);
    if (hits.length) {
      // Within a tier the more specific place comes first, then alphabetical order, so the list is stable.
      const order = { thana: 0, upazila: 1, 'city-corporation': 2, district: 3 };
      hits.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
      return { matches: hits.slice(0, MAX_MATCHES), total: hits.length };
    }
  }
  return { matches: [], total: 0 };
}

// A saved profile's areas as places: the order of the profile, each place once, at most `limit`.
export function placesForAreas(areas = [], limit = 2) {
  ensure();
  const seen = new Set();
  const out = [];
  for (const area of areas) {
    const place = byId.get(String(area?.upazilaPcode));
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    out.push(place);
    if (out.length >= limit) break;
  }
  return out;
}

// The BMD location that stands in for the place when something exists only per location (the lightning summaries).
export function representativePcode(place) {
  if (place?.level === 'location') return place.id;
  if (place?.level === 'polygon' && place.approx) return place.members?.[0] ?? null;
  return null;
}
