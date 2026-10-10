// Point-in-polygon for GeoJSON geometry ([longitude, latitude] pairs). Boundary points count as inside; holes and multi-part shapes are respected.
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i];
    const [px, py] = ring[j];
    const cross = (lon - x) * (py - y) - (lat - y) * (px - x);
    if (Math.abs(cross) < 1e-10 && lon >= Math.min(x, px) && lon <= Math.max(x, px) && lat >= Math.min(y, py) && lat <= Math.max(y, py)) return true;
    if ((y > lat) !== (py > lat) && lon < ((px - x) * (lat - y)) / (py - y) + x) inside = !inside;
  }
  return inside;
}

export function containsPoint(geometry, lon, lat) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(([outer, ...holes]) => Array.isArray(outer) && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
}
