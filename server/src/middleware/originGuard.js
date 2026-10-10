import { env } from '../config/env.js';

// CSRF guard for the cookie-authenticated endpoints. SameSite cookies already block most cross-site requests; on top of that,
// every state-changing request must come from this site's own pages and, when it has a body, must be JSON.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

export function originAllowed(origin, host, nodeEnv = env.nodeEnv, clientOrigin = env.clientOrigin) {
  if (!origin) return true; // not a browser fetch (or a same-origin navigation); cookies are SameSite=Lax/Strict anyway
  if (origin === clientOrigin) return true;
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return nodeEnv !== 'production' && DEV_ORIGINS.includes(origin);
}

export function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!originAllowed(req.get('origin'), req.get('host'))) return res.status(403).json({ message: 'This request did not come from the AkashSathi site.' });
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !req.is('application/json')) return res.status(415).json({ message: 'Requests with a body must be JSON.' });
  return next();
}
