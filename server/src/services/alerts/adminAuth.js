import { env } from '../../config/env.js';
import { AdminSession } from '../../models/AdminSession.js';
import { hashToken, newToken, safeEqual } from './tokens.js';

// One shared admin passcode (a prototype: no admin accounts, roles or password reset). Admin is disabled until the passcode is set.
const HOUR_MS = 3_600_000;

// ADMIN_AUTH=off only counts outside production (see middleware/admin.js for the per-request loopback check).
export const devBypassEnabled = () => env.admin.authOff && env.nodeEnv !== 'production';

export const adminConfigured = () => Boolean(env.admin.passcode) || devBypassEnabled();

export function passcodeMatches(candidate) {
  return Boolean(env.admin.passcode) && typeof candidate === 'string' && candidate.length <= 200 && safeEqual(candidate, env.admin.passcode);
}

// The session lives for ADMIN_SESSION_HOURS from sign-in (absolute, not sliding).
export async function createAdminSession(now = new Date()) {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + env.admin.sessionHours * HOUR_MS);
  await AdminSession.create({ tokenHash: hashToken(token), createdAt: now, expiresAt });
  return { token, expiresAt, maxAgeSeconds: env.admin.sessionHours * 3600 };
}

// TTL deletion is not instantaneous, so expiry is checked here on every request.
export async function findAdminSession(token, now = new Date()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = await AdminSession.findOne({ tokenHash: hashToken(token) }).lean();
  return session && session.expiresAt > now ? session : null;
}

export async function endAdminSession(token) {
  if (token) await AdminSession.deleteOne({ tokenHash: hashToken(token) });
}
