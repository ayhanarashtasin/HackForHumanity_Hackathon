import { env } from '../config/env.js';
import { adminConfigured, devBypassEnabled, findAdminSession } from '../services/alerts/adminAuth.js';
import { clearCookie, parseCookies, serializeCookie } from './cookies.js';

// The admin session cookie. SameSite=Strict: it is never sent on a cross-site request.
export const ADMIN_COOKIE = 'as_admin';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'Strict', secure: env.nodeEnv === 'production' });

export function setAdminCookie(res, token, maxAgeSeconds) {
  res.append('Set-Cookie', serializeCookie(ADMIN_COOKIE, token, { ...cookieOptions(), maxAgeSeconds }));
}

export function clearAdminCookie(res) {
  res.append('Set-Cookie', clearCookie(ADMIN_COOKIE, cookieOptions()));
}

// ADMIN_AUTH=off is for local demos only: honoured outside production AND only for a request that really comes from this machine.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function devBypassAllowed(req) {
  return devBypassEnabled() && LOOPBACK.has(req.socket?.remoteAddress) && !req.get('x-forwarded-for');
}

// The admin area is never indexed and never cached.
export function adminHeaders(req, res, next) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
}

export async function requireAdmin(req, res, next) {
  if (!adminConfigured()) return res.status(503).json({ message: 'Admin is not configured. Set ADMIN_PASSCODE in server/.env to enable it.' });
  if (devBypassAllowed(req)) {
    req.adminSession = { devBypass: true };
    return next();
  }
  const session = await findAdminSession(parseCookies(req.get('cookie'))[ADMIN_COOKIE]);
  if (!session) return res.status(401).json({ message: 'Admin sign-in required.' });
  req.adminSession = session;
  return next();
}
