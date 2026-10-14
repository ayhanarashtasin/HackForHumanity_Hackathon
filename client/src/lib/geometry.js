const EARTH_RADIUS_KM = 6371.0088;
const rad = Math.PI / 180;

// Geodesic circle as a GeoJSON polygon ring (lon, lat). Used to draw Xweather's 100 km search circles.
export function circlePolygon(lat, lon, radiusKm, steps = 96) {
  const ring = [];
  const angular = radiusKm / EARTH_RADIUS_KM;

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat * rad) * Math.cos(angular) + Math.cos(lat * rad) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon * rad + Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat * rad),
      Math.cos(angular) - Math.sin(lat * rad) * Math.sin(lat2),
    );
    ring.push([((lon2 / rad + 540) % 360) - 180, lat2 / rad]);
  }

  return [ring];
}

// The point `distanceKm` from (lat, lon) along a compass bearing, as [lon, lat].
export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearing = bearingDeg * rad;
  const lat2 = Math.asin(Math.sin(lat * rad) * Math.cos(angular) + Math.cos(lat * rad) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon * rad + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat * rad), Math.cos(angular) - Math.sin(lat * rad) * Math.sin(lat2));
  return [lon2 / rad, lat2 / rad];
}

// MapLibre image sources want corners clockwise from the top-left, as [lon, lat].
export function imageCoordinates({ north, west, south, east }) {
  return [[west, north], [east, north], [east, south], [west, south]];
}

// Everything outside Bangladesh: one world-sized polygon with the national boundary cut out of it, so the map can paint over
// the neighbouring countries and the sea. GeoJSON wants the outer ring counter-clockwise and holes clockwise.
const WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

export function outsideMask(national) {
  const holes = [];
  for (const feature of national?.features ?? []) {
    const { type, coordinates } = feature.geometry;
    const polygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : [];
    for (const [outer] of polygons) holes.push(ringArea(outer) > 0 ? [...outer].reverse() : outer);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [WORLD_RING, ...holes] } };
}

// Keeps a point inside [[west, south], [east, north]] widened by `margin` degrees.
export function clampToBounds(lng, lat, [[west, south], [east, north]], margin = 0) {
  return {
    lng: Math.min(Math.max(lng, west - margin), east + margin),
    lat: Math.min(Math.max(lat, south - margin), north + margin),
  };
}

// Position of a lon/lat on the landing-page silhouette (see scripts/build-outline.mjs), in the outline's own SVG units.
export function outlinePoint(outline, lon, lat) {
  return { x: (lon - outline.lon0) * outline.kx, y: (outline.lat1 - lat) * outline.ky };
}

export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
