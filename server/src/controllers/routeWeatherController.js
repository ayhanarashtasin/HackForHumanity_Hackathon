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
