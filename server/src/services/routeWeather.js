import { locations } from './geo.js';
import { forecastFor, loadForecast, stepIndex } from './delivery/botReports/readings.js';
const BOUNDS = { minLat: 20.3, maxLat: 26.9, minLon: 87.5, maxLon: 93.2 };
const MAX_SAMPLES = 16;
const EARTH_KM = 6371;
const ROUTING_SERVICE_URL = 'https://router.project-osrm.org/route/v1/driving';

const radians = (value) => (value * Math.PI) / 180;

function distanceKm(a, b) {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const dLat = lat2 - lat1;
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
    && point.lat >= BOUNDS.minLat && point.lat <= BOUNDS.maxLat
    && point.lon >= BOUNDS.minLon && point.lon <= BOUNDS.maxLon;
}

function routeSamples(coordinates) {
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += distanceKm(coordinates[index - 1], coordinates[index]);
    lengths.push(total);
  }
  if (!total) return [];
  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(total / 30) + 1));
  const points = [];
  for (let sample = 0; sample < count; sample += 1) {
    const target = total * sample / (count - 1);
    let segment = lengths.findIndex((length) => length >= target);
    if (segment < 0) segment = lengths.length - 1;
    const startDistance = segment ? lengths[segment - 1] : 0;
    const segmentDistance = lengths[segment] - startDistance;
    const fraction = segmentDistance ? (target - startDistance) / segmentDistance : 0;
    const start = coordinates[segment];
    const end = coordinates[segment + 1];
    points.push({
      coordinates: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction],
      progress: target / total,
    });
  }
  return points;
}

function closestLocation(point, catalog) {
  let closest = null;
  let shortest = Infinity;
  for (const location of catalog) {
    const distance = distanceKm(point, [location.lon, location.lat]);
    if (distance < shortest) { closest = location; shortest = distance; }
  }
  if (!closest || shortest > 75) return null;
  return { location: closest, distanceKm: shortest };
}

function at(values, index) {
  return Number.isInteger(index) && index >= 0 && Number.isFinite(values?.[index]) ? values[index] : null;
}

function maxOf(samples, key) {
  const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

// Routes offered per search, and what counts as a real alternative rather than the same road again or a pointless detour.
const MAX_ROUTES = 2; // the shortest road and one alternative
const MAX_DETOUR = 1.5; // at most 50% longer than the shortest
const SAME_ROAD_KM = 0.2;
const MAX_SHARED = 0.8; // an alternative must leave the other routes for at least a fifth of its length
const VIA_OFFSET = 0.25; // via points sit this fraction of the straight-line distance to each side of the midpoint

async function requestRoutes(points, fetchImpl, { alternatives }) {
  const coordinates = points.map((point) => `${point.lon},${point.lat}`).join(';');
  const url = `${ROUTING_SERVICE_URL}/${coordinates}?overview=full&geometries=geojson&steps=false${alternatives ? '&alternatives=3' : ''}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Route service is unavailable. Please try again.');
  const payload = await response.json();
  return payload.code === 'Ok' ? (payload.routes ?? []).filter((candidate) => (
    candidate?.geometry?.coordinates?.length && Number.isFinite(candidate.distance) && Number.isFinite(candidate.duration)
  )) : [];
}

// Points every `stepKm` along a line, so long straight highway segments are compared along their whole length.
function densify(coordinates, stepKm) {
  const points = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const [a, b] = [coordinates[index - 1], coordinates[index]];
    const count = Math.max(1, Math.ceil(distanceKm(a, b) / stepKm));
    for (let step = 1; step <= count; step += 1) points.push([a[0] + (b[0] - a[0]) * step / count, a[1] + (b[1] - a[1]) * step / count]);
  }
  return points;
}

// Share of `route` that runs along `other` (within SAME_ROAD_KM).
function sharedFraction(route, other) {
  const coordinates = route.geometry.coordinates;
  const along = densify(coordinates, Math.max(0.05, route.distance / 1000 / 150));
  const road = densify(other.geometry.coordinates, 0.1);
  const shared = along.filter((point) => road.some((roadPoint) => distanceKm(point, roadPoint) <= SAME_ROAD_KM)).length;
  return shared / along.length;
}

// Two points to the left and right of the straight line's midpoint. Routing through them pulls OSRM onto other roads when it found no
// alternatives of its own (common for long trips across Bangladesh).
function viaPoints(start, end) {
  const midLat = (start.lat + end.lat) / 2;
  const scale = Math.cos(radians(midLat));
  const dx = (end.lon - start.lon) * scale;
  const dy = end.lat - start.lat;
  return [1, -1]
    .map((side) => ({ lon: (start.lon + end.lon) / 2 + (-dy * VIA_OFFSET * side) / scale, lat: midLat + dx * VIA_OFFSET * side }))
    .filter(validPoint);
}

async function fetchRoadRoutes(start, end, fetchImpl) {
  // Shortest first; the rest are offered as alternatives.
  const direct = (await requestRoutes([start, end], fetchImpl, { alternatives: true }))
    .sort((a, b) => a.distance - b.distance || a.duration - b.duration);
  if (!direct.length) throw new Error('No road route was found between those locations.');
  const kept = direct.slice(0, MAX_ROUTES);
  if (kept.length >= MAX_ROUTES) return kept;

  // A failed or empty via request only means fewer alternatives; the search itself has already succeeded.
  const viaRoutes = (await Promise.all(viaPoints(start, end).map((via) => (
    requestRoutes([start, via, end], fetchImpl, { alternatives: false }).catch(() => [])
  )))).flat().sort((a, b) => a.distance - b.distance);
  for (const candidate of viaRoutes) {
    if (kept.length >= MAX_ROUTES) break;
    if (candidate.distance > kept[0].distance * MAX_DETOUR) continue;
    if (kept.some((route) => sharedFraction(candidate, route) >= MAX_SHARED)) continue;
    kept.push(candidate);
  }
  return kept;
}

// One road route with weather sampled along it at the expected time of passing.
function routeOption(route, { nowMs, forecast, locationList }) {
  const points = routeSamples(route.geometry.coordinates);
  const samples = points.map(({ coordinates, progress }) => {
    const nearest = closestLocation(coordinates, locationList);
    if (!nearest) return { lat: coordinates[1], lon: coordinates[0], place: null, distanceKm: null, etaMs: null };

    const place = {
      id: nearest.location.pcode,
      level: 'location',
      kind: nearest.location.kind === 'thana' ? 'thana' : 'upazila',
      name: nearest.location.name,
      nameBn: nearest.location.nameBn ?? null,
      districtCode: nearest.location.district,
      members: [nearest.location.pcode],
      lat: nearest.location.lat,
      lon: nearest.location.lon,
    };
    const etaMs = nowMs + route.duration * 1000 * progress;
    const local = forecastFor(place, forecast);
    const index = local.available ? stepIndex(local.steps, etaMs) : -1;
    const sourceStatuses = [local.coreInfo?.status, local.rain?.info?.status, local.thunder?.info?.status].filter(Boolean);
    return {
      lat: coordinates[1], lon: coordinates[0], place, distanceKm: nearest.distanceKm, etaMs,
      dataStatus: local.available ? (sourceStatuses.every((status) => status === 'ok') ? 'ok' : 'partial') : 'unavailable',
      temperatureC: at(local.cols?.temp, index),
      heatIndexC: at(local.cols?.hi, index),
      rainMm: at(local.rain?.values, index),
      rainUnitUnverified: Boolean(local.rain?.unverified),
      rainChancePct: at(local.cols?.pop, index),
      windKph: at(local.cols?.wg, index),
      thunderPotential: at(local.thunder?.values, index),
    };
  });
  const available = samples.filter((sample) => sample.place && sample.temperatureC !== null);

  return {
    coordinates: route.geometry.coordinates,
    distanceKm: Math.round(route.distance / 100) / 10,
    durationMinutes: Math.round(route.duration / 60),
    samples,
    summary: {
      sampleCount: samples.length,
      coveredCount: available.length,
      maxTemperatureC: maxOf(available, 'temperatureC'),
      maxHeatIndexC: maxOf(available, 'heatIndexC'),
      maxRainMm: maxOf(available, 'rainMm'),
      rainUnitUnverified: available.some((sample) => sample.rainUnitUnverified),
      maxRainChancePct: maxOf(available, 'rainChancePct'),
      maxWindKph: maxOf(available, 'windKph'),
      maxThunderPotential: maxOf(available, 'thunderPotential'),
      forecastStatus: available.length ? (available.some((sample) => sample.dataStatus !== 'ok') ? 'partial' : 'ok') : 'unavailable',
    },
  };
}

export async function buildRouteWeather({
  start, end, nowMs = Date.now(), fetchImpl = fetch, forecast = loadForecast({ now: nowMs }), locationList = locations,
}) {
  if (!validPoint(start) || !validPoint(end)) throw new Error('Choose two locations in Bangladesh.');
  if (start.lat === end.lat && start.lon === end.lon) throw new Error('Start and end locations must be different.');

  const routes = await fetchRoadRoutes(start, end, fetchImpl);
  const [shortest, ...others] = routes.map((route) => routeOption(route, { nowMs, forecast, locationList }));

  // The shortest route stays at the top level (as before); the other OSRM candidates follow in `alternatives`, shortest first.
  return {
    start: { name: String(start.name ?? ''), lat: start.lat, lon: start.lon },
    end: { name: String(end.name ?? ''), lat: end.lat, lon: end.lon },
    ...shortest,
    routeCandidates: routes.length,
    routeChoice: 'shortest-distance-among-osrm-options',
    alternatives: others,
  };
}

export const routeWeatherInternals = { closestLocation, distanceKm, routeSamples, sharedFraction, validPoint, viaPoints };