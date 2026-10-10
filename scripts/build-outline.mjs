#!/usr/bin/env node
// Builds the landing-page outline and eight divisions from the boundaries the weather map already ships.
//   reads  client/public/data/bd-national.geojson and bd-district.geojson
//   writes client/src/lib/bdOutline.js (SVG paths, division labels, and their shared projection)
// Run: npm run build:outline
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'client', 'public', 'data', 'bd-national.geojson');
const DISTRICTS = path.join(ROOT, 'client', 'public', 'data', 'bd-district.geojson');
const TARGET = path.join(ROOT, 'client', 'src', 'lib', 'bdOutline.js');

const HEIGHT = 640; // SVG units; the width follows from the aspect ratio
const TOLERANCE_DEG = 0.012; // about 1.3 km, invisible at landing-page size
const MIN_ISLAND_DEG = 0.05; // specks smaller than this vanish at landing-page size

// Douglas-Peucker on an open polyline.
function simplifyLine(points, tolerance) {
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const length = Math.hypot(bx - ax, by - ay) || 1e-12;

    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      const distance = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / length;
      if (distance > worst) { worst = distance; index = i; }
    }
    if (worst > tolerance && index !== -1) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// A closed ring (first point == last point) has a zero-length first segment, so split it at the point farthest from the start.
function simplify(ring, tolerance) {
  const [sx, sy] = ring[0];
  let split = 1;
  let farthest = 0;
  ring.forEach(([x, y], i) => {
    const distance = Math.hypot(x - sx, y - sy);
    if (distance > farthest) { farthest = distance; split = i; }
  });
  return [...simplifyLine(ring.slice(0, split + 1), tolerance), ...simplifyLine(ring.slice(split), tolerance).slice(1)];
}

const geojson = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
const geometry = geojson.features[0].geometry;
const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

// Outer rings only: the silhouette has no holes worth drawing.
const rings = polygons
  .map((polygon) => polygon[0])
  .filter((ring) => {
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    return Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats)) >= MIN_ISLAND_DEG;
  })
  .map((ring) => simplify(ring, TOLERANCE_DEG))
  .filter((ring) => ring.length >= 4);

const all = rings.flat();
const lon0 = Math.min(...all.map((p) => p[0]));
const lon1 = Math.max(...all.map((p) => p[0]));
const lat0 = Math.min(...all.map((p) => p[1]));
const lat1 = Math.max(...all.map((p) => p[1]));

// Equirectangular, with longitude shrunk by cos(latitude) at the middle of the country so shapes are not stretched.
const midLat = (lat0 + lat1) / 2;
const ky = HEIGHT / (lat1 - lat0);
const kx = ky * Math.cos((midLat * Math.PI) / 180);
const width = Math.round((lon1 - lon0) * kx);

const project = ([lon, lat]) => [(lon - lon0) * kx, (lat1 - lat) * ky];
const round = (n) => Math.round(n * 10) / 10;
const d = rings
  .map((ring) => ring.map((point, i) => `${i === 0 ? 'M' : 'L'}${project(point).map(round).join(' ')}`).join('') + 'Z')
  .join('');

// Dissolving shared district edges produces actual division areas, rather than guessed lines on the silhouette.
const districts = JSON.parse(await fs.readFile(DISTRICTS, 'utf8'));
const output = await mapshaper.applyCommands(
  '-i districts.json -dissolve division -simplify 12% keep-shapes -each "label_lon=$.innerX,label_lat=$.innerY" -o divisions.json format=geojson precision=0.0001',
  { 'districts.json': JSON.stringify(districts) },
);
const divisions = JSON.parse(output['divisions.json']).features.map((feature) => {
  const { division: name, label_lon: lon, label_lat: lat } = feature.properties;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return {
    name,
    districts: districts.features.filter((district) => district.properties.division === name).length,
    lon,
    lat,
    label: project([lon, lat]).map(round),
    path: polygons.flatMap((polygon) => polygon.map((ring) =>
      ring.map((point, i) => `${i === 0 ? 'M' : 'L'}${project(point).map(round).join(' ')}`).join('') + 'Z',
    )).join(''),
  };
}).sort((a, b) => a.name.localeCompare(b.name));
if (divisions.length !== 8 || divisions.reduce((sum, division) => sum + division.districts, 0) !== 64) {
  throw new Error('The landing map must contain all eight divisions and 64 districts.');
}

const body = `// Generated by scripts/build-outline.mjs from the national and district GeoJSON. Do not edit by hand.
// x = (lon - lon0) * kx, y = (lat1 - lat) * ky, in SVG units.
export const BD_OUTLINE = {
  width: ${width},
  height: ${HEIGHT},
  lon0: ${lon0},
  lat1: ${lat1},
  kx: ${kx},
  ky: ${ky},
  path: '${d}',
};

export const BD_DIVISIONS = ${JSON.stringify(divisions, null, 2)};
`;

await fs.writeFile(TARGET, body, 'utf8');
console.log(`Wrote ${path.relative(ROOT, TARGET)}: ${divisions.length} divisions, ${width}x${HEIGHT}, ${(body.length / 1024).toFixed(1)} KB`);
console.table(divisions.map(({ name, districts, lat, lon }) => ({ name, districts, lat, lon })));
