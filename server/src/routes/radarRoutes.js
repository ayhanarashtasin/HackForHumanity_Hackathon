import { Router } from 'express';
import { listRadarFrames, listSatelliteFrames, sendRadarImage } from '../controllers/radarController.js';

export const radarRoutes = Router();
export const satelliteRoutes = Router();

radarRoutes.get('/frames', listRadarFrames);
radarRoutes.get('/image/:site/:file', sendRadarImage);

satelliteRoutes.get('/frames', listSatelliteFrames);
