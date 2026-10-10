import { Router } from 'express';
import {
  availability, demoCreate, demoDelete, demoInbox, demoList, discardHeld, getAdminSettings, getHistory, getOptions, getOverview, getRules, login, logout, me,
  previewSend, putAdminSettings, sendAlerts, withdrawAlerts,
} from '../controllers/adminController.js';
import { adminHeaders, requireAdmin } from '../middleware/admin.js';
import { originGuard } from '../middleware/originGuard.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const FIFTEEN_MINUTES = 15 * 60_000;

// Sign-in attempts: 5 per 15 minutes per address; a correct passcode clears them.
export function createAdminRoutes({ loginLimit = { windowMs: FIFTEEN_MINUTES, max: 5 } } = {}) {
  const routes = Router();
  const limiter = createRateLimiter(loginLimit);

  // Exposed for tests: the sign-in limiter of this router.
  routes.loginLimiter = limiter;

  routes.use(adminHeaders);
  routes.use(originGuard);

  routes.get('/availability', availability);
  routes.post('/login', (req, res, next) => {
    const attempt = limiter.attempt(req.ip);
    if (!attempt.allowed) {
      res.set('Retry-After', String(attempt.retryAfterSeconds));
      return res.status(429).json({ message: 'Too many sign-in attempts. Please wait before trying again.' });
    }
    req.loginLimiter = limiter;
    return next();
  }, login);

  // Everything below needs an admin session.
  routes.use(requireAdmin);
  routes.post('/logout', logout);
  routes.get('/me', me);
  routes.get('/options', getOptions);
  routes.get('/overview', getOverview);
  routes.post('/preview', previewSend);
  routes.post('/send', sendAlerts);
  routes.post('/alerts/:id/withdraw', withdrawAlerts);
  routes.post('/held/discard', discardHeld);
  routes.get('/history', getHistory);
  routes.get('/rules', getRules);
  routes.get('/settings', getAdminSettings);
  routes.put('/settings', putAdminSettings);
  routes.get('/demo/subscribers', demoList);
  routes.post('/demo/subscribers', demoCreate);
  routes.delete('/demo/subscribers', demoDelete);
  routes.get('/demo/subscribers/:id/inbox', demoInbox);

  return routes;
}

export const adminRoutes = createAdminRoutes();
