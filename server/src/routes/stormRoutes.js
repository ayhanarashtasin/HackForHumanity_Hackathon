import { Router } from 'express';
import { listStorms, stormDemo, stormDemoImage } from '../controllers/stormController.js';

export const stormRoutes = Router();

stormRoutes.get('/', listStorms);
stormRoutes.get('/demo', stormDemo);
stormRoutes.get('/demo/image/:name', stormDemoImage);
