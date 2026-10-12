import { distanceKm } from './geometry.js';
import { containsPoint, forecastSelectionIn } from './locate.js';

const GRID_DEGREES = 0.05;

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates[0] === 'number') {
      bounds[0] = Math.min(bounds[0], coordinates[0]);
      bounds[1] = Math.min(bounds[1], coordinates[1]);
      bounds[2] = Math.max(bounds[2], coordinates[0]);
      bounds[3] = Math.max(bounds[3], coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return bounds;
}

function polygonIndex(collection) {
  const features = (collection?.features ?? [])
    .filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))
    .map((feature) => ({ feature, bounds: geometryBounds(feature.geometry) }));
  const cells = new Map();
  for (const entry of features) {
    const [west, south, east, north] = entry.bounds;
    for (let lat = Math.floor(south / GRID_DEGREES); lat <= Math.floor(north / GRID_DEGREES); lat += 1) {
      for (let lon = Math.floor(west / GRID_DEGREES); lon <= Math.floor(east / GRID_DEGREES); lon += 1) {
        const key = `${lon}:${lat}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(entry);
      }
    }
  }
  return { cells };
}

function routeSamples(coordinates, maxStepKm) {
  const segments = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = distanceKm(coordinates[index - 1][1], coordinates[index - 1][0], coordinates[index][1], coordinates[index][0]);
    segments.push({ start: coordinates[index - 1], end: coordinates[index], distance, before: total });
    total += distance;
  }
  if (!total) return coordinates.length ? [{ point: coordinates[0], progress: 0 }] : [];

  const samples = [{ point: coordinates[0], progress: 0 }];
  for (const segment of segments) {
    const count = Math.max(1, Math.ceil(segment.distance / maxStepKm));
    for (let index = 1; index <= count; index += 1) {
      const fraction = index / count;
      samples.push({
        point: [
          segment.start[0] + (segment.end[0] - segment.start[0]) * fraction,
          segment.start[1] + (segment.end[1] - segment.start[1]) * fraction,
        ],
        progress: (segment.before + segment.distance * fraction) / total,
      });
    }
  }
  return samples;
}

function containing(index, [lon, lat]) {
  const candidates = index.cells.get(`${Math.floor(lon / GRID_DEGREES)}:${Math.floor(lat / GRID_DEGREES)}`) ?? [];
  return candidates.find(({ bounds, feature }) => (
    lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]
      && containsPoint(feature.geometry, lon, lat)
  ))?.feature ?? null;
}

// Neighbourhoods are points, not boundaries: a route passes one when it comes within this distance of its centre.
const NEAR_PLACE_KM = 0.6;

function pointIndex(places) {
  const cells = new Map();
  for (const place of places) {
    const key = `${Math.floor(place.lon / GRID_DEGREES)}:${Math.floor(place.lat / GRID_DEGREES)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(place);
  }
  return cells;
}

function nearbyPlaces(cells, [lon, lat]) {
  const column = Math.floor(lon / GRID_DEGREES);
  const row = Math.floor(lat / GRID_DEGREES);
  const found = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const place of cells.get(`${column + dx}:${row + dy}`) ?? []) {
        if (distanceKm(lat, lon, place.lat, place.lon) <= NEAR_PLACE_KM) found.push(place);
      }
    }
  }
  return found;
}

export function areasAlongRoute(coordinates, areaGeo, upazilaGeo, catalogue, maxStepKm = 0.1, places = []) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !catalogue) return { areas: [], upazilas: [] };
  const areasById = new Map((catalogue.areas ?? []).map((area) => [area.id, area]));
  const areaBoundaries = polygonIndex(areaGeo);
  const upazilaBoundaries = polygonIndex(upazilaGeo);
  const placeCells = pointIndex(places);
  const areas = [];
  const upazilas = [];
  const seenAreas = new Set();
  const seenPlaces = new Set();
  const passedPlaces = [];
  const parentById = new Map();

  for (const { point, progress } of routeSamples(coordinates, maxStepKm)) {
    const areaFeature = containing(areaBoundaries, point);
    const area = areaFeature ? areasById.get(areaFeature.properties.pid) : null;
    const upazilaFeature = area ? null : containing(upazilaBoundaries, point);
    const parentPid = area?.parentPid ?? upazilaFeature?.properties.pid;
    if (!parentPid) continue;

    if (area && !seenAreas.has(area.id)) {
      seenAreas.add(area.id);
      areas.push({ ...area, progress, point });
    }
    const passed = nearbyPlaces(placeCells, point).filter((place) => !seenPlaces.has(place.id));
    passed.forEach((place) => seenPlaces.add(place.id));

    const parent = ensureParent(parentById, upazilas, catalogue, parentPid, point, progress, area?.parentName ?? upazilaFeature?.properties.name);
    if (area && !parent.areas.some((id) => areasById.get(id)?.name.toLowerCase() === area.name.toLowerCase())) {
      parent.areas.push(area.id);
    }
    passed.forEach((place) => passedPlaces.push({ place, parent }));
  }

  // A neighbourhood is listed under the thana/upazila its weather comes from when the route passes that one too, else where it was passed.
  for (const { place, parent } of passedPlaces) (parentById.get(place.weatherFrom?.id) ?? parent).places.push(place);
  return { areas, upazilas };
}

// One route card per forecast: upazilas by their location, city corporations split into their nearest thanas.
export function routeParent(polygonPid, [lon, lat], catalogue, progress, fallbackName) {
  const found = forecastSelectionIn(polygonPid, { lon, lat }, catalogue);
  const polygon = catalogue.polygons[polygonPid];
  const location = found?.selection.level === 'upazila' ? catalogue.locations.find((item) => item.pcode === found.selection.id) : null;
  const level = location ? 'upazila' : 'polygon';
  return {
    id: location ? location.pcode : polygonPid,
    level,
    name: location?.name ?? polygon?.name ?? fallbackName ?? polygonPid,
    nameBn: location?.nameBn ?? polygon?.nameBn ?? null,
    kind: location?.kind === 'thana' ? 'city thana' : polygon?.kind === 'city-corporation' ? 'city corporation' : 'upazila',
    // The boundary it lies in (a city corporation for a thana) and where the route enters it, for drawing it on the map.
    polygonPid,
    point: [lon, lat],
    progress,
    areas: [],
    places: [],
  };
}

function ensureParent(parentById, list, catalogue, polygonPid, point, progress, fallbackName) {
  const candidate = routeParent(polygonPid, point, catalogue, progress, fallbackName);
  const existing = parentById.get(candidate.id);
  if (existing) return existing;
  parentById.set(candidate.id, candidate);
  list.push(candidate);
  return candidate;
}

export const routeAreaInternals = { geometryBounds, routeSamples };