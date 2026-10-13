#!/usr/bin/env node
// One-time setup: builds the static geography used by the map and the lightning campaign.
//   - Downloads the OCHA/HDX COD-AB Bangladesh boundaries (CC BY-IGO) once and caches them.
//   - Downloads geoBoundaries Bangladesh ADM4 areas (BBS/OCHA ROAP, CC BY 3.0 IGO) once and caches them.
//   - Joins them with BMD's 544 forecast locations (BMD uses 6-digit BBS codes, HDX uses "BD" + 8 digits).
//   - Simplifies boundaries for the web and computes + verifies the Mode B lightning circle cover.
// Run: npm run build:geo   (add --refresh to ignore the download cache)
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts', '.cache');
const CLIENT_OUT = path.join(ROOT, 'client', 'public', 'data');
const SERVER_OUT = path.join(ROOT, 'server', 'data');
const REFRESH = process.argv.includes('--refresh');

const HDX_ZIP_URL =
  'https://data.humdata.org/dataset/401d3fae-4262-48c9-891f-461fd776d49b/resource/cec2abe3-d8b7-4025-9362-9f7e780f2a07/download/bgd_admin_boundaries.geojson.zip';
const ADM4_URL =
  'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09592ced973a3448cf66b6100b741b64c0d/releaseData/gbOpen/BGD/ADM4/geoBoundaries-BGD-ADM4_simplified.geojson';
const OSM_MUGDA = { id: 'OSM-node-9026037312', name: 'Mugda', nameBn: 'মুগদা', lat: 23.7291223, lon: 90.4335651 };
const BMD_API_PAGE = 'https://api.bdservers.site/';
const BMD_LOOKUP = 'https://usf.bmd.gov.bd';

const API_RADIUS_KM = 100;
const COVER_RADIUS_KM = 95; // 5 % safety margin under the API radius

async function cached(name, loader) {
  const file = path.join(CACHE, name);
  if (!REFRESH && existsSync(file)) return fs.readFile(file);
  const data = await loader();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, data);
  return data;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- geometry helpers ----------
const rad = Math.PI / 180;
function haversineKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(polygon, x, y) {
  if (!ringContains(polygon[0], x, y)) return false;
  return !polygon.slice(1).some((hole) => ringContains(hole, x, y));
}

function geometryPolygons(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function featureContains(feature, lon, lat) {
  return geometryPolygons(feature.geometry).some((polygon) => polygonContains(polygon, lon, lat));
}

function eachVertex(coordinates, visit) {
  if (typeof coordinates[0] === 'number') visit(coordinates[0], coordinates[1]);
  else coordinates.forEach((c) => eachVertex(c, visit));
}

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  eachVertex(geometry.coordinates, (lon, lat) => {
    bounds[0] = Math.min(bounds[0], lon);
    bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon);
    bounds[3] = Math.max(bounds[3], lat);
  });
  return bounds;
}

function representativePoint(feature) {
  const [west, south, east, north] = geometryBounds(feature.geometry);
  const candidates = [[(west + east) / 2, (south + north) / 2]];
  for (const polygon of geometryPolygons(feature.geometry)) {
    const ring = polygon[0].slice(0, -1);
    if (!ring.length) continue;
    const average = ring.reduce(([lon, lat], point) => [lon + point[0] / ring.length, lat + point[1] / ring.length], [0, 0]);
    candidates.push(average);
  }
  for (const point of candidates) if (featureContains(feature, point[0], point[1])) return point;

  for (let row = 1; row < 10; row++) {
    for (let column = 1; column < 10; column++) {
      const point = [west + ((east - west) * column) / 10, south + ((north - south) * row) / 10];
      if (featureContains(feature, point[0], point[1])) return point;
    }
  }
  throw new Error(`Could not find an interior point for ${feature.properties.shapeName ?? 'an ADM4 area'}.`);
}

// ---------- BMD location list (PCODEs) ----------
async function loadBmdLocations() {
  const html = (await cached('bmd_landing.html', () => download(BMD_API_PAGE))).toString('utf8');
  const lines = html.replace(/<[^>]*>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  const byCode = new Map();
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\d{6}$/.test(lines[i + 1]) && !/^\d+$/.test(lines[i])) byCode.set(lines[i + 1], lines[i]);
  }
  return byCode;
}

// Bangla names are optional: if BMD's lookup is unreachable the build still succeeds without them.
async function loadBanglaNames(districtCodes) {
  const upazilaBn = new Map();
  const districtBn = new Map();
  const options = (html) => [...html.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2].trim()]);
  try {
    const home = (await cached('bmd_home_bn.html', () => download(`${BMD_LOOKUP}/`))).toString('utf8');
    for (const [code, name] of options(home)) if (/^\d{4}$/.test(code)) districtBn.set(code, name);

    const queue = [...districtCodes];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const code = queue.shift();
        const html = (await cached(`bn_${code}.html`, () => download(`${BMD_LOOKUP}/Dashboard/getUpazilaBN?district=${code}`))).toString('utf8');
        for (const [pcode, name] of options(html)) if (/^\d{6}$/.test(pcode)) upazilaBn.set(pcode, name);
      }
    }));
  } catch (error) {
    console.warn(`! Bangla names skipped: ${error.message}`);
  }
  return { upazilaBn, districtBn };
}

// ---------- Mode B lightning cover ----------
function hexCover(sampleVertices, bounds, effectiveKm) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const kmPerDegLat = 111.19;
  const kmPerDegLon = 111.32 * Math.cos(((minLat + maxLat) / 2) * rad);
  const width = (maxLon - minLon) * kmPerDegLon;
  const height = (maxLat - minLat) * kmPerDegLat;
  const spacing = effectiveKm * Math.sqrt(3); // hex lattice that covers the whole plane at this radius

  const lattice = (rotated, offX, offY) => {
    const centers = [];
    for (let j = -3; j < height / (spacing * 0.866) + 3; j++) {
      for (let i = -3; i < width / spacing + 3; i++) {
        let x = (i + (j % 2 ? 0.5 : 0)) * spacing + offX * spacing;
        let y = j * spacing * 0.866 + offY * spacing;
        if (rotated) [x, y] = [y, x];
        centers.push([minLat + y / kmPerDegLat, minLon + x / kmPerDegLon]);
      }
    }
    return centers;
  };

  let best = null;
  for (const rotated of [false, true]) {
    for (let ox = 0; ox < 1; ox += 0.1) {
      for (let oy = 0; oy < 1; oy += 0.1) {
        const centers = lattice(rotated, ox, oy);
        const used = new Set();
        let covered = true;
        for (const [lat, lon] of sampleVertices) {
          let hit = false;
          for (let c = 0; c < centers.length; c++) {
            if (haversineKm(lat, lon, centers[c][0], centers[c][1]) <= effectiveKm) { used.add(c); hit = true; }
          }
          if (!hit) { covered = false; break; }
        }
        if (covered && (!best || used.size < best.length)) best = [...used].map((i) => centers[i]);
      }
    }
  }
  if (!best) throw new Error('Could not find a gap-free lightning circle cover.');
  return best;
}

// ---------- main ----------
console.log('Loading HDX boundaries (cached after the first download)...');
const zip = await cached('bgd_admin_boundaries.geojson.zip', () => download(HDX_ZIP_URL));
const files = unzipSync(new Uint8Array(zip), { filter: (f) => /bgd_admin(0|2|3|points)\.geojson$/.test(f.name) });
const readJson = (suffix) => {
  const key = Object.keys(files).find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`${suffix} missing from the HDX archive`);
  return JSON.parse(Buffer.from(files[key]).toString('utf8'));
};
const admin0 = readJson('bgd_admin0.geojson');
const admin2 = readJson('bgd_admin2.geojson');
const admin3 = readJson('bgd_admin3.geojson');
const adminPoints = readJson('bgd_adminpoints.geojson');
const admin4 = JSON.parse((await cached('geoboundaries_bgd_adm4.geojson', () => download(ADM4_URL))).toString('utf8'));
if (!Array.isArray(admin4.features) || !admin4.features.length) throw new Error('The Bangladesh ADM4 boundary data contains no areas.');

const bmdNames = await loadBmdLocations();
const districtCodes = new Set([...bmdNames.keys()].map((c) => c.slice(0, 4)));
const { upazilaBn, districtBn } = await loadBanglaNames(districtCodes);

// HDX adm3 code ("BD" + 6-digit BBS code in the points file; "BD" + 8 digits in the polygons) -> BMD 6-digit code.
const bmdFromPolygonCode = (code) => code.slice(2, 6) + code.slice(-2);
const points = new Map(
  adminPoints.features
    .filter((f) => f.properties.admin_level === 3)
    .map((f) => [f.properties.adm3_pcode.replace(/^BD/, ''), f]),
);

const isCityCorporation = (f) => /city corporation/i.test(f.properties.adm3_name || '');
const polygonFeatures = admin3.features;
const ccCount = polygonFeatures.filter(isCityCorporation).length;
const upazilaPolygonCount = polygonFeatures.length - ccCount;

// Polygons that carry a BMD code directly.
const directPolygon = new Map(); // bmd pcode -> polygon feature
for (const f of polygonFeatures) {
  if (isCityCorporation(f)) continue;
  const code = bmdFromPolygonCode(f.properties.adm3_pcode);
  if (bmdNames.has(code) && !directPolygon.has(code)) directPolygon.set(code, f);
}

// All 544 BMD locations, positioned with the HDX admin points.
const locations = [];
const missingPoints = [];
for (const [pcode, bmdName] of bmdNames) {
  const point = points.get(pcode);
  if (!point) { missingPoints.push(pcode); continue; }
  const p = point.properties;
  const [lon, lat] = point.geometry.coordinates;
  locations.push({
    pcode,
    name: p.adm3_name || bmdName,
    ...(upazilaBn.has(pcode) && { nameBn: upazilaBn.get(pcode) }),
    district: pcode.slice(0, 4),
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    kind: directPolygon.has(pcode) ? 'upazila' : 'thana',
    pid: directPolygon.has(pcode) ? pcode : null,
  });
}
if (missingPoints.length) throw new Error(`No HDX point for BMD codes: ${missingPoints.join(', ')}`);
locations.sort((a, b) => a.pcode.localeCompare(b.pcode));

// Polygons without a BMD code (city corporations + newer upazilas): take the BMD locations
// that have no polygon of their own and sit inside them; otherwise the nearest BMD location, flagged as approximate.
const pointOnly = locations.filter((l) => !l.pid);
const polygons = {};
const unmapped = [];
for (const f of polygonFeatures) {
  const code = isCityCorporation(f) ? null : bmdFromPolygonCode(f.properties.adm3_pcode);
  if (code && directPolygon.get(code) === f) {
    polygons[code] = { name: f.properties.adm3_name, kind: 'upazila', src: [code], approx: false };
    f.properties.pid = code;
    continue;
  }
  const pid = `X${f.properties.adm3_pcode.slice(2)}`;
  f.properties.pid = pid;
  const members = pointOnly.filter((l) => featureContains(f, l.lon, l.lat)).map((l) => l.pcode);
  let src = members;
  let approx = false;
  if (!src.length) {
    const lat = f.properties.center_lat;
    const lon = f.properties.center_lon;
    const nearest = locations.reduce((best, l) => {
      const d = haversineKm(lat, lon, l.lat, l.lon);
      return d < best.d ? { d, pcode: l.pcode } : best;
    }, { d: Infinity, pcode: null });
    src = [nearest.pcode];
    approx = true;
  }
  polygons[pid] = { name: f.properties.adm3_name, kind: isCityCorporation(f) ? 'city-corporation' : 'upazila', src, approx };
  unmapped.push(pid);
}

// Districts and divisions.
const districts = admin2.features.map((f) => {
  const code = f.properties.adm2_pcode.replace(/^BD/, '');
  const inDistrict = locations.filter((l) => l.district === code);
  return {
    pcode: code,
    name: f.properties.adm2_name,
    ...(districtBn.has(code) && { nameBn: districtBn.get(code) }),
    division: f.properties.adm1_name,
    lat: +(f.properties.center_lat ?? inDistrict.reduce((s, l) => s + l.lat, 0) / inDistrict.length).toFixed(4),
    lon: +(f.properties.center_lon ?? inDistrict.reduce((s, l) => s + l.lon, 0) / inDistrict.length).toFixed(4),
    upazilas: inDistrict.map((l) => l.pcode),
  };
}).sort((a, b) => a.pcode.localeCompare(b.pcode));
const divisions = [...new Set(districts.map((d) => d.division))].sort();

// ADM4 areas use the weather series of the ADM3 parent that contains their representative point.
const admin3WithBounds = polygonFeatures.map((feature) => ({ feature, bounds: geometryBounds(feature.geometry) }));
const areas = admin4.features.map((feature, index) => {
  const name = feature.properties.shapeName;
  const id = feature.properties.shapeID ?? `BGD-ADM4-${index + 1}`;
  if (!name) throw new Error(`ADM4 feature ${id} has no shapeName.`);
  const [lon, lat] = representativePoint(feature);
  const candidates = admin3WithBounds.filter(({ bounds }) => (
    lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]
  ));
  const exactParent = candidates.find(({ feature: candidate }) => featureContains(candidate, lon, lat))?.feature;
  const districtFeature = admin2.features.find((candidate) => featureContains(candidate, lon, lat));
  const districtCode = districtFeature?.properties.adm2_pcode.replace(/^BD/, '');
  const localParents = admin3WithBounds.filter(({ feature: candidate }) => (
    candidate.properties.adm2_pcode.replace(/^BD/, '') === districtCode
  ));
  const nearest = (features) => features
    .sort((a, b) => {
      const center = (entry) => [
        +(entry.feature.properties.center_lon ?? (entry.bounds[0] + entry.bounds[2]) / 2),
        +(entry.feature.properties.center_lat ?? (entry.bounds[1] + entry.bounds[3]) / 2),
      ];
      const [aLon, aLat] = center(a);
      const [bLon, bLat] = center(b);
      return haversineKm(lat, lon, aLat, aLon) - haversineKm(lat, lon, bLat, bLon);
    })[0]?.feature;
  const parent = exactParent ?? nearest(candidates) ?? nearest(localParents) ?? nearest(admin3WithBounds);
  if (!parent) throw new Error(`Could not match ADM4 area "${name}" to an upazila boundary.`);
  return {
    id: `ADM4-${id}`,
    name,
    parentPid: parent.properties.pid,
    parentName: parent.properties.adm3_name,
    parentKind: /city corporation/i.test(parent.properties.adm3_name) ? 'city corporation' : 'upazila',
    parentApprox: !exactParent,
    district: parent.properties.adm2_pcode.replace(/^BD/, ''),
    lat: +lat.toFixed(5),
    lon: +lon.toFixed(5),
  };
});
const mugdaParent = polygonFeatures.find((feature) => feature.properties.adm3_name === 'Dhaka South City Corporation');
if (!mugdaParent) throw new Error('Could not match Mugda to Dhaka South City Corporation.');
areas.push({
  id: OSM_MUGDA.id,
  name: OSM_MUGDA.name,
  nameBn: OSM_MUGDA.nameBn,
  parentPid: mugdaParent.properties.pid,
  parentName: mugdaParent.properties.adm3_name,
  parentKind: 'city corporation',
  parentApprox: false,
  boundaryApprox: true,
  district: '3026',
  lat: OSM_MUGDA.lat,
  lon: OSM_MUGDA.lon,
});

// ---------- simplified static boundaries ----------
async function simplify(featureCollection, percent) {
  const output = await mapshaper.applyCommands(
    `-i in.json -simplify ${percent}% keep-shapes -o out.json format=geojson precision=0.0001`,
    { 'in.json': JSON.stringify(featureCollection) },
  );
  return JSON.parse(output['out.json']);
}

const upazilaGeo = await simplify({
  type: 'FeatureCollection',
  features: polygonFeatures.map((f) => ({
    type: 'Feature',
    properties: { pid: f.properties.pid, name: f.properties.adm3_name, kind: polygons[f.properties.pid].kind, district: f.properties.adm2_pcode.replace(/^BD/, '') },
    geometry: f.geometry,
  })),
}, 3);
const districtGeo = await simplify({
  type: 'FeatureCollection',
  features: admin2.features.map((f) => ({
    type: 'Feature',
    properties: { pid: f.properties.adm2_pcode.replace(/^BD/, ''), name: f.properties.adm2_name, division: f.properties.adm1_name },
    geometry: f.geometry,
  })),
}, 3);
const nationalGeo = await simplify({
  type: 'FeatureCollection',
  features: admin0.features.map((f) => ({ type: 'Feature', properties: { name: 'Bangladesh' }, geometry: f.geometry })),
}, 3);
const areaGeo = await simplify({
  type: 'FeatureCollection',
  features: admin4.features.map((feature, index) => ({
    type: 'Feature',
    properties: { pid: areas[index].id, name: areas[index].name, parentPid: areas[index].parentPid, parentApprox: areas[index].parentApprox },
    geometry: feature.geometry,
  })),
}, 1);
areaGeo.features.push({
  type: 'Feature',
  properties: {
    pid: OSM_MUGDA.id,
    name: OSM_MUGDA.name,
    parentPid: mugdaParent.properties.pid,
    parentApprox: false,
    boundaryApprox: true,
  },
  geometry: { type: 'Point', coordinates: [OSM_MUGDA.lon, OSM_MUGDA.lat] },
});

// ---------- Mode B lightning circles ----------
const bounds = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
const allVertices = [];
const addVertices = (features) => features.forEach((f) => eachVertex(f.geometry.coordinates, (lon, lat) => {
  allVertices.push([lat, lon]);
  bounds.minLat = Math.min(bounds.minLat, lat); bounds.maxLat = Math.max(bounds.maxLat, lat);
  bounds.minLon = Math.min(bounds.minLon, lon); bounds.maxLon = Math.max(bounds.maxLon, lon);
}));
addVertices(admin0.features);
addVertices(polygonFeatures);

const seen = new Set();
const thinned = [];
for (const v of allVertices) {
  const key = `${Math.round(v[0] / 0.02)},${Math.round(v[1] / 0.02)}`;
  if (!seen.has(key)) { seen.add(key); thinned.push(v); }
}
const rawCenters = hexCover(thinned, bounds, COVER_RADIUS_KM);
const centers = rawCenters
  .map(([lat, lon]) => ({ lat: +lat.toFixed(4), lon: +lon.toFixed(4) }))
  .sort((a, b) => b.lat - a.lat || a.lon - b.lon)
  .map((c, i) => ({ id: `BD-C${String(i + 1).padStart(2, '0')}`, ...c }));

let worstKm = 0;
for (const [lat, lon] of allVertices) {
  let nearest = Infinity;
  for (const c of centers) nearest = Math.min(nearest, haversineKm(lat, lon, c.lat, c.lon));
  worstKm = Math.max(worstKm, nearest);
}
if (worstKm > API_RADIUS_KM) throw new Error(`Lightning cover has a gap: ${worstKm.toFixed(1)} km > ${API_RADIUS_KM} km`);

const upazilaCenters = polygonFeatures
  .filter((f) => !isCityCorporation(f))
  .map((f) => ({ id: f.properties.pid, name: f.properties.adm3_name, lat: +f.properties.center_lat.toFixed(4), lon: +f.properties.center_lon.toFixed(4) }));

// ---------- write ----------
const generated = new Date().toISOString();
const meta = {
  generated,
  boundaries: 'OCHA/HDX COD-AB Bangladesh (CC BY-IGO), BBS-sourced',
  areaBoundaries: {
    source: 'geoBoundaries BGD ADM4, BBS/OCHA ROAP',
    yearRepresented: 2020,
    license: 'CC BY 3.0 IGO',
    url: 'https://www.geoboundaries.org/api/current/gbOpen/BGD/ADM4/',
  },
  approximateAreaPoints: [{ name: OSM_MUGDA.name, source: 'OpenStreetMap', license: 'ODbL 1.0', url: 'https://www.openstreetmap.org/node/9026037312' }],
  counts: {
    upazilaPolygons: upazilaPolygonCount,
    cityCorporationPolygons: ccCount,
    admin4Areas: admin4.features.length,
    additionalAreaLocations: areas.length - admin4.features.length,
    admin4ParentMatchesApproximate: areas.filter((area) => area.parentApprox).length,
    areasWithoutBoundary: areas.filter((area) => area.boundaryApprox).length,
    districts: districts.length,
    divisions: divisions.length,
    bmdLocations: locations.length,
    bmdLocationsWithPolygon: directPolygon.size,
    bmdLocationsPointOnly: pointOnly.length,
    polygonsWithoutBmdCode: unmapped.length,
    polygonsApproximated: Object.values(polygons).filter((p) => p.approx).length,
  },
};

await fs.mkdir(CLIENT_OUT, { recursive: true });
await fs.mkdir(SERVER_OUT, { recursive: true });
const write = (dir, name, data) => fs.writeFile(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));

await write(CLIENT_OUT, 'bd-upazila.geojson', upazilaGeo);
await write(SERVER_OUT, 'bd-upazila.geojson', upazilaGeo);
await write(CLIENT_OUT, 'bd-district.geojson', districtGeo);
await write(CLIENT_OUT, 'bd-admin4.geojson', areaGeo);
await write(CLIENT_OUT, 'bd-national.geojson', nationalGeo);
const catalogue = { meta, divisions, districts, locations, polygons, areas };
await write(CLIENT_OUT, 'locations.json', catalogue);
await write(SERVER_OUT, 'locations.json', catalogue);
await write(SERVER_OUT, 'lightning-circles.json', {
  generated,
  apiRadiusKm: API_RADIUS_KM,
  designRadiusKm: COVER_RADIUS_KM,
  verifiedMaxDistanceKm: +worstKm.toFixed(1),
  verifiedAgainstVertices: allVertices.length,
  circles: centers,
});
await write(SERVER_OUT, 'lightning-upazilas.json', { generated, upazilas: upazilaCenters });

const kb = async (dir, name) => `${((await fs.stat(path.join(dir, name))).size / 1024).toFixed(0)} KB`;
console.log('\nBuild complete');
console.table(meta.counts);
console.log(`Lightning Mode B cover: ${centers.length} circles @ ${API_RADIUS_KM} km, farthest boundary vertex ${worstKm.toFixed(1)} km from a centre (${allVertices.length.toLocaleString()} vertices checked)`);
console.log(`Lightning Mode A locations: ${upazilaCenters.length} upazila centres`);
console.log(`Bangla names: ${upazilaBn.size} upazilas, ${districtBn.size} districts`);
console.log(`client/public/data: ADM4 ${await kb(CLIENT_OUT, 'bd-admin4.geojson')}, upazila ${await kb(CLIENT_OUT, 'bd-upazila.geojson')}, district ${await kb(CLIENT_OUT, 'bd-district.geojson')}, national ${await kb(CLIENT_OUT, 'bd-national.geojson')}, locations ${await kb(CLIENT_OUT, 'locations.json')}`);
