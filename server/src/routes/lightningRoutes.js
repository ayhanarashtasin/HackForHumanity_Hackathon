import { Router } from 'express';
import {
  getLightningForUpazila,
  getLightningStatus,
  getLightningSummaries,
} from '../controllers/lightningController.js';

export const lightningRoutes = Router();

lightningRoutes.param('pcode', (req, res, next, pcode) => {
  if (!/^\d{6}$/.test(pcode)) {
    return res.status(400).json({ message: 'Invalid location code.' });
  }
  next();
});

lightningRoutes.get('/status', getLightningStatus);
lightningRoutes.get('/summaries', getLightningSummaries);
lightningRoutes.get('/upazila/:pcode', getLightningForUpazila);
