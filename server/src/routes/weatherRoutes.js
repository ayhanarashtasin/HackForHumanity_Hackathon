import { Router } from 'express';
import { getDaily, getHistory, getSnapshot } from '../controllers/weatherController.js';

export const weatherRoutes = Router();

weatherRoutes.get('/snapshot', getSnapshot);
weatherRoutes.get('/daily', getDaily);
weatherRoutes.get('/history', getHistory);
