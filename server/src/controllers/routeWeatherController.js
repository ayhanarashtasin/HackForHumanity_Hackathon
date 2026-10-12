import { buildRouteWeather } from '../services/routeWeather.js';

export async function postRouteWeather(req, res) {
  try {
    const result = await buildRouteWeather({ start: req.body?.start, end: req.body?.end });
    res.set('Cache-Control', 'no-store');
    res.json({ data: result });
  } catch (error) {
    const message = error?.message || 'Route weather is unavailable. Please try again.';
    const status = /Choose two locations|must be different/.test(message) ? 400
      : /No road route/.test(message) ? 404 : 503;
    res.status(status).json({ message });
  }
}