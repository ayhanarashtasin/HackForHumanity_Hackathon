import { distanceKm } from './geometry.js';
import { translate } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

// Boundary edges count as inside; holes and disconnected islands are respected.
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i];
    const [px, py] = ring[j];
    const cross = (lon - x) * (py - y) - (lat - y) * (px - x);
    if (Math.abs(cross) < 1e-10 && lon >= Math.min(x, px) && lon <= Math.max(x, px)
      && lat >= Math.min(y, py) && lat <= Math.max(y, py)) return true;
    if ((y > lat) !== (py > lat) && lon < ((px - x) * (lat - y)) / (py - y) + x) inside = !inside;
  }
  return inside;
}

export function containsPoint(geometry, lon, lat) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
}

export function locateUpazila({ lon, lat }, boundaries, catalogue) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  const feature = boundaries.features.find((item) => containsPoint(item.geometry, lon, lat));
  if (!feature) return null;
  const pid = feature.properties.pid;
  const polygon = catalogue.polygons[pid];
  if (!polygon?.src?.length) return null;

  const members = catalogue.locations.filter((item) => polygon.src.includes(item.pcode));
  if (!members.length) return null;
  if (polygon.approx) {
    return { selection: { level: 'polygon', id: pid }, area: polygon.name, note: 'Your area is identified by its boundary. Weather comes from the nearest available forecast location.' };
  }
  if (members.length === 1 && polygon.kind !== 'city-corporation') {
    return { selection: { level: 'upazila', id: members[0].pcode }, area: polygon.name, note: null };
  }

  // City corporations contain point-only thanas; do not claim their nearest point is an exact thana boundary.
  const nearest = members.reduce((best, item) => (
    distanceKm(lat, lon, item.lat, item.lon) < distanceKm(lat, lon, best.lat, best.lon) ? item : best
  ));
  return {
    selection: { level: 'upazila', id: nearest.pcode },
    area: polygon.name,
    noteBn: translate('bn', 'You are in {area}. {nearest} is the nearest forecast thana; separate thana boundaries are not available.', {
      area: polygon.nameBn || translate('bn', polygon.name, {}, MAP), nearest: nearest.nameBn || nearest.name,
    }, MAP),
    note: `You are in ${polygon.name}. ${nearest.name} is the nearest forecast thana; separate thana boundaries are not available.`,
  };
}
