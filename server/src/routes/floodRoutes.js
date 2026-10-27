import { Router } from 'express';
import {
  getFloodDemo, getFloodShelters, getFloodStations, getFloodStatus,
} from '../controllers/floodController.js';

// Public, read-only flood views. They read MongoDB snapshots only, exactly like /api/alerts; the provider is called by the job.
const routes = Router();
routes.get('/status', getFloodStatus);
routes.get('/stations', getFloodStations);
routes.get('/shelters', getFloodShelters);
routes.get('/demo', getFloodDemo);

export const floodRoutes = routes;
