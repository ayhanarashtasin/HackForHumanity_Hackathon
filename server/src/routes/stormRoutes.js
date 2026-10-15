import { Router } from 'express';
import {
  listStorms, stormDemo, stormDemoImage, stormImage,
} from '../controllers/stormController.js';

export const stormRoutes = Router();

stormRoutes.get('/', listStorms);
stormRoutes.get('/image/:name', stormImage);
stormRoutes.get('/demo', stormDemo);
stormRoutes.get('/demo/image/:name', stormDemoImage);
