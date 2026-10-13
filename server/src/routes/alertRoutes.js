import { Router } from 'express';
import {
  deleteMe, getCoverage, getInbox, getMe, getSchema, getSession, getStatus, readAll, readOne, subscribe, updateActivity, updateCurrentArea, updateMe, updateStatus,
} from '../controllers/alertController.js';
import {
  getChannels, linkTelegram, startVerification, unlinkChannel, verifyChannel,
} from '../controllers/channelController.js';
import { originGuard } from '../middleware/originGuard.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireSubscriber } from '../middleware/subscriber.js';

const HOUR = 3_600_000;

// `subscribeLimit` is injectable so tests can sign up many people; the default is 10 profiles per hour per address.
export function createAlertRoutes({ subscribeLimit = { windowMs: HOUR, max: 10 }, codeLimit = { windowMs: HOUR, max: 10 } } = {}) {
  const routes = Router();

  // Every state-changing request must come from this site's own pages (CSRF guard).
  routes.use(originGuard);

  routes.get('/schema', getSchema);
  routes.get('/status', getStatus);
  routes.get('/session', getSession);
  routes.post('/subscribe', rateLimit({ ...subscribeLimit, message: 'Too many profiles were created from this connection. Please try again later.' }), subscribe);

  // Everything below needs the subscriber's device cookie.
  routes.use(requireSubscriber);
  routes.get('/me', getMe);
  routes.put('/me', updateMe);
  routes.delete('/me', deleteMe);
  routes.put('/me/activity', updateActivity);
  routes.put('/me/status', updateStatus);
  routes.put('/me/current-area', rateLimit({ windowMs: HOUR, max: 120 }), updateCurrentArea);
  routes.get('/me/coverage', getCoverage);
  routes.get('/me/channels', getChannels);
  routes.post('/me/channels/telegram/link', rateLimit({ ...codeLimit, message: 'Too many Telegram links were requested. Please try again later.' }), linkTelegram);
  routes.post('/me/channels/:channel/start', rateLimit({ ...codeLimit, message: 'Too many verification codes were requested from this connection. Please try again later.' }), startVerification);
  routes.post('/me/channels/:channel/verify', verifyChannel);
  routes.delete('/me/channels/:channel', unlinkChannel);
  routes.get('/inbox', getInbox);
  routes.post('/inbox/read-all', readAll);
  routes.post('/inbox/:id/read', readOne);

  return routes;
}

export const alertRoutes = createAlertRoutes();
