import { Router } from 'express';
import { postRouteHospitals, postRouteWeather } from '../controllers/routeWeatherController.js';
import { getDaily, getHistory, getSnapshot } from '../controllers/weatherController.js';

export const weatherRoutes = Router();

weatherRoutes.get('/snapshot', getSnapshot);
weatherRoutes.get('/daily', getDaily);
weatherRoutes.get('/history', getHistory);
weatherRoutes.post('/route', postRouteWeather);
weatherRoutes.post('/route/hospitals', postRouteHospitals);
