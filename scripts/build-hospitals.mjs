// Builds server/data/hospitals-bd.json: every hospital in Bangladesh on OpenStreetMap, with the phone numbers OSM has for them.
//
//   node scripts/build-hospitals.mjs
//
// 1. Downloads HOT's OpenStreetMap health-facilities export for Bangladesh (HDX, ODbL), keeps the hospitals.
// 2. Asks the main OpenStreetMap API for each hospital's current tags (the export leaves out phone numbers), about 15 requests a second
//    apart. If that step fails the file is still written, without phone numbers.
// The route planner then searches this file locally: no network call per route, so it works offline and during an Overpass outage.
// Run it again to refresh; commit the result. Nothing here is invented: missing names, addresses and phones stay null.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'server', 'data', 'hospitals-bd.json');
const EXPORT_URL = 'https://production-raw-data-api.s3.amazonaws.com/ISO3/BGD/health_facilities/hotosm_bgd_health_facilities_osm_geojson.zip';
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const USER_AGENT = 'AkashSathi/1.0 (hospital list build for the route planner)';
const BATCH = { node: 200, way: 100, relation: 50 };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The one file we need from a ZIP archive (stored or deflated), read from its central directory.
function unzipEntry(buffer, wanted) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Not a ZIP file.');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    if (name.endsWith(wanted)) {
      const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP method ${method}.`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} not found in the ZIP.`);
}

function centre(geometry) {
  if (geometry?.type === 'Point') return geometry.coordinates;
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates[0] : geometry?.type === 'MultiPolygon' ? geometry.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const sum = ring.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

const round = (value) => Math.round(value * 1e6) / 1e6;
// Trims, and drops stray punctuation mappers left at the edges ("_ চক্ষু হাসপাতাল", "Hospital,").
const clean = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^[\s_\-.,;:*]+|[\s_\-,;:*]+$/gu, '').replace(/\s+/g, ' ');
  return text || null;
};
const isBangla = (text) => /[ঀ-৿]/u.test(text ?? '');

// About 500 names were mapped as one "name, type, address" string ("Mother and Child Hospital, Hospital, Ramgor Road, Hathazari"). When one
// comma-separated part is only a facility type, the parts before it are the name and the parts after it an address. The mapper's words are
// kept, only sorted into the right fields; a name without such a part is left as it is.
const TYPE_PART = /^(?:(?:government|govt\.?|private|general|specialized|specialised)\s+)?hospital$/i;
function splitName(raw) {
  if (!raw) return { name: raw, address: null };
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const at = parts.findIndex((part, index) => index > 0 && TYPE_PART.test(part));
  if (at < 0) return { name: raw, address: null };
  const rest = parts.slice(at + 1).filter((part, index, list) => list.indexOf(part) === index);
  return { name: parts.slice(0, at).join(', '), address: rest.length ? rest.join(', ') : null };
}

// Upazila and district names in both languages from the site's own catalogue (matched by official code), so the place line follows the
// page language and is spelled the way the rest of AkashSathi spells it.
const catalogue = JSON.parse(readFileSync(join(ROOT, 'server', 'data', 'locations.json'), 'utf8'));
const upazilaByCode = new Map(catalogue.locations.map((item) => [item.pcode, item]));
const districtByCode = new Map(catalogue.districts.map((item) => [item.pcode, item]));
function areaOf(p) {
  const code = (value) => String(value ?? '').replace(/^BD/, '');
  const upazila = upazilaByCode.get(code(p.adm3_pcode));
  const district = districtByCode.get(code(p.adm2_pcode));
  const en = [upazila?.name ?? clean(p.adm3_name), district?.name ?? clean(p.adm2_name)].filter(Boolean);
  const bn = upazila?.nameBn && district?.nameBn ? [upazila.nameBn, district.nameBn] : null;
  return { area: en.length ? [...new Set(en)].join(', ') : null, areaBn: bn ? [...new Set(bn)].join(', ') : null, upazilaCode: upazila?.pcode ?? null };
}

// Official contacts from scripts/build-hospital-contacts.mjs, by upazila code. Only an upazila health complex gets its upazila's official
// numbers: other hospitals in the same upazila are different places.
const CONTACTS_PATH = join(ROOT, 'server', 'data', 'hospital-contacts-bd.json');
const officialContacts = existsSync(CONTACTS_PATH) ? JSON.parse(readFileSync(CONTACTS_PATH, 'utf8')).upazilas ?? {} : {};
// Named as the upazila's government health complex: "Upazila Health Complex", "UHC", "উপজেলা স্বাস্থ্য কমপ্লেক্স", or "<this upazila>
// Health Complex". A private place that merely has "Health Complex" in its name ("L. Harun Health Complex") does not qualify.
const UPAZILA_HEALTH_COMPLEX = /(upa?[zj]il+a|upozila|thana)[\s,.-]*(health|sastho|shastho|shasthya|swasthya|swastho)|\bu\.?\s?h\.?\s?c\b|উপজেলা\s*স্বাস্থ্য/i;
const isUpazilaComplex = (names, upazilaName) => UPAZILA_HEALTH_COMPLEX.test(names)
  || (upazilaName && new RegExp(`^\\s*${upazilaName.replace(/\s*\(.*\)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(health|sastho|shastho|shasthya|swasthya|swastho)\\s+complex`, 'i').test(names));
const NOT_UPAZILA = /union|ইউনিয়ন|community|কমিউনিটি|family welfare|পরিবার কল্যাণ/i;
const dialFormat = (digits) => (/^01\d{9}$/.test(digits) ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits);

async function osmTags(ids) {
  const tags = new Map();
  for (const type of ['node', 'way', 'relation']) {
    const list = ids.filter((id) => id.startsWith(`${type}/`)).map((id) => id.split('/')[1]);
    for (let index = 0; index < list.length; index += BATCH[type]) {
      const batch = list.slice(index, index + BATCH[type]);
      const response = await fetch(`${OSM_API}/${type}s.json?${type}s=${batch.join(',')}`, {
        headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000),
      });
      // 404/410: one id in the batch was deleted since the export; look the batch up one by one instead of losing all of it.
      if (response.status === 404 || response.status === 410) {
        for (const id of batch) {
          const single = await fetch(`${OSM_API}/${type}/${id}.json`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
          if (single.ok) for (const element of (await single.json()).elements ?? []) tags.set(`${type}/${element.id}`, element.tags ?? {});
          await sleep(500);
        }
      } else {
        if (!response.ok) throw new Error(`OSM API ${response.status} for ${type}s`);
        for (const element of (await response.json()).elements ?? []) tags.set(`${type}/${element.id}`, element.tags ?? {});
      }
      process.stdout.write(`  ${type}s ${Math.min(index + BATCH[type], list.length)}/${list.length}\r`);
      await sleep(1000);
    }
    if (list.length) process.stdout.write('\n');
  }
  return tags;
}

const zipPath = join(CACHE, 'bgd_health_facilities.zip');
mkdirSync(CACHE, { recursive: true });
let zip;
try {
  console.log('Downloading the HOT/OSM Bangladesh health-facilities export…');
  const response = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  zip = Buffer.from(await response.arrayBuffer());
  writeFileSync(zipPath, zip);
} catch (error) {
  console.log(`Download failed (${error.message}); using the cached copy.`);
  zip = readFileSync(zipPath);
}
const geojson = JSON.parse(unzipEntry(zip, 'health_facilities.geojson').toString('utf8'));
const readme = (() => { try { return unzipEntry(zip, 'README.txt').toString('utf8'); } catch { return ''; } })();
const snapshot = /Snapshot:\s*(\S+)/.exec(readme)?.[1] ?? null;

const hospitals = geojson.features
  .filter((feature) => feature.properties?.amenity === 'hospital' || feature.properties?.healthcare === 'hospital')
  .map((feature) => {
    const point = centre(feature.geometry);
    const p = feature.properties;
    if (!point) return null;
    return {
      id: p.id,
      name: clean(p.name) ?? clean(p.name_en) ?? clean(p.name_bn),
      nameEn: clean(p.name_en),
      nameBn: clean(p.name_bn),
      lat: round(point[1]),
      lon: round(point[0]),
      address: clean(p.addr_full),
      ...areaOf(p),
      phone: null,
      phoneSource: null,
      website: null,
      email: null,
    };
  })
  .filter(Boolean);
console.log(`${hospitals.length} hospitals in the export (snapshot ${snapshot ?? 'unknown'}).`);

let phonesFrom = null;
try {
  console.log('Looking up current tags on the OpenStreetMap API…');
  const tags = await osmTags(hospitals.map((hospital) => hospital.id));
  for (const hospital of hospitals) {
    const t = tags.get(hospital.id);
    if (!t) continue;
    hospital.phone = clean(t.phone) ?? clean(t['contact:phone']) ?? clean(t['phone:mobile']) ?? clean(t['contact:mobile']);
    if (hospital.phone) hospital.phoneSource = `https://www.openstreetmap.org/${hospital.id}`;
    const site = clean(t.website) ?? clean(t['contact:website']) ?? clean(t.url);
    if (site && /^https?:\/\//i.test(site)) hospital.website = site;
    hospital.name ??= clean(t.name);
    hospital.nameBn ??= clean(t['name:bn']);
    hospital.nameEn ??= clean(t['name:en']);
    hospital.address ??= clean(t['addr:full']) ?? ([clean(t['addr:housenumber']), clean(t['addr:street'])].filter(Boolean).join(' ') || null);
  }
  phonesFrom = new Date().toISOString().slice(0, 10);
} catch (error) {
  console.log(`OSM API lookup failed (${error.message}); writing the list without phone numbers.`);
}

let split = 0;
for (const hospital of hospitals) {
  for (const field of ['name', 'nameEn']) {
    const parts = splitName(hospital[field]);
    if (parts.name === hospital[field]) continue;
    if (field === 'name') split += 1;
    hospital[field] = parts.name;
    hospital.address ??= parts.address;
  }
}
console.log(`${split} names split into name and address.`);

// The name in each script: an explicit name:en / name:bn tag, else the main name if it is written in that script. A name that exists in
// only one script stays in that script; nothing is translated or transliterated.
for (const hospital of hospitals) {
  if (!hospital.nameBn && isBangla(hospital.name)) hospital.nameBn = hospital.name;
  if (!hospital.nameEn && hospital.name && !isBangla(hospital.name)) hospital.nameEn = hospital.name;
}

let official = 0;
let officialSites = 0;
for (const hospital of hospitals) {
  const contact = officialContacts[hospital.upazilaCode];
  if (!contact) continue;
  const names = [hospital.name, hospital.nameEn, hospital.nameBn].filter(Boolean);
  const upazilaName = upazilaByCode.get(hospital.upazilaCode)?.name;
  if (!names.some((name) => isUpazilaComplex(name, upazilaName)) || names.some((name) => NOT_UPAZILA.test(name))) continue;
  hospital.website ??= contact.site;
  hospital.email ??= contact.email ?? null;
  officialSites += 1;
  const number = contact.mobile ?? contact.landline;
  if (!hospital.phone && number) {
    hospital.phone = dialFormat(number);
    hospital.phoneSource = contact.contactPage ?? contact.site;
    if (contact.emergency && number === contact.mobile) hospital.phoneEmergency = true;
    official += 1;
  }
}
console.log(`${officialSites} upazila health complexes linked to their official website, ${official} given their official number.`);

hospitals.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, `${JSON.stringify({
  source: 'OpenStreetMap contributors, via the HOT export on HDX (hotosm_bgd_health_facilities); upazila health complex contacts from their official gov.bd pages',
  license: 'ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)',
  snapshot,
  phonesFrom,
  count: hospitals.length,
  hospitals,
})}\n`);
console.log(`Wrote ${OUT}: ${hospitals.length} hospitals, ${hospitals.filter((h) => h.name).length} named, ${hospitals.filter((h) => h.phone).length} with a phone number.`);
console.log(`  English name ${hospitals.filter((h) => h.nameEn).length}, Bangla name ${hospitals.filter((h) => h.nameBn).length}, both ${hospitals.filter((h) => h.nameEn && h.nameBn).length}; Bangla place line ${hospitals.filter((h) => h.areaBn).length}.`);
