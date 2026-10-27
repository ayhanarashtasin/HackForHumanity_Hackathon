import { hospitalsAlongRoute } from '../services/hospitals.js';
import { buildRouteWeather } from '../services/routeWeather.js';

const STATUS = {
  ROUTE_POINTS: 400, ROUTE_SAME: 400, ROUTE_NO_ROAD: 404, ROUTE_SERVICE: 503,
};

export async function postRouteWeather(req, res) {
  try {
    const result = await buildRouteWeather({ start: req.body?.start, end: req.body?.end });
    res.set('Cache-Control', 'no-store');
    res.json({ data: result });
  } catch (error) {
    const status = STATUS[error?.code] ?? 503;
    res.status(status).json({ message: status === 503 && !error?.code ? 'Route weather is unavailable. Please try again.' : error.message });
  }
}

const MAX_ROUTE_POINTS = 20_000;

// Separate from /route on purpose: the client asks for hospitals after it already has the route, so a slow or failed hospital search
// never blocks or retries route planning. `disabled` (feature off) and a 503 (search failed) are never worded as "no hospitals here".
export function routeHospitalsHandler(search) {
  return async function postRouteHospitals(req, res) {
    const coordinates = Array.isArray(req.body?.coordinates) ? req.body.coordinates : null;
    if (!coordinates || coordinates.length < 2 || coordinates.length > MAX_ROUTE_POINTS
      || !coordinates.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
      res.status(400).json({ message: 'coordinates must be an array of [lon, lat] pairs.' });
      return;
    }
    try {
      const hospitals = await search(coordinates);
      res.set('Cache-Control', 'no-store');
      res.json({ data: hospitals === null ? { hospitals: null, disabled: true } : { hospitals } });
    } catch {
      res.status(503).json({ message: 'Hospital search is unavailable right now.' });
    }
  };
}

export const postRouteHospitals = routeHospitalsHandler(hospitalsAlongRoute);
