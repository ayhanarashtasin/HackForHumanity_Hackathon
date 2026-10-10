import { Router } from 'express';
import { getHealth } from '../controllers/healthController.js';
import { adminRoutes } from './adminRoutes.js';
import { alertRoutes } from './alertRoutes.js';
import { lightningRoutes } from './lightningRoutes.js';
import { radarRoutes, satelliteRoutes } from './radarRoutes.js';
import { weatherRoutes } from './weatherRoutes.js';

export const apiRoutes = Router();

apiRoutes.get('/health', getHealth);
apiRoutes.use('/weather', weatherRoutes);
apiRoutes.use('/radar', radarRoutes);
apiRoutes.use('/satellite', satelliteRoutes);
apiRoutes.use('/lightning', lightningRoutes);
apiRoutes.use('/alerts', alertRoutes);
apiRoutes.use('/admin', adminRoutes);
