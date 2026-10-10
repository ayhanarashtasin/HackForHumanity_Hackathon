import { env } from '../config/env.js';
import { findByToken } from '../services/alerts/subscribers.js';
import { clearCookie, parseCookies, serializeCookie } from './cookies.js';

// The anonymous device cookie that identifies a subscriber's browser. HttpOnly, so scripts cannot read it.
export const SUBSCRIBER_COOKIE = 'as_sub';
const YEAR_SECONDS = 365 * 24 * 3600;
const cookieOptions = () => ({ httpOnly: true, sameSite: 'Lax', secure: env.nodeEnv === 'production' });

export function setSubscriberCookie(res, token) {
  res.append('Set-Cookie', serializeCookie(SUBSCRIBER_COOKIE, token, { ...cookieOptions(), maxAgeSeconds: YEAR_SECONDS }));
}

export function clearSubscriberCookie(res) {
  res.append('Set-Cookie', clearCookie(SUBSCRIBER_COOKIE, cookieOptions()));
}

export async function requireSubscriber(req, res, next) {
  const token = parseCookies(req.get('cookie'))[SUBSCRIBER_COOKIE];
  const subscriber = await findByToken(token);
  if (!subscriber) {
    if (token) clearSubscriberCookie(res); // a stale or deleted profile: stop sending the dead cookie
    return res.status(401).json({ message: 'No alert profile found for this browser.' });
  }
  req.subscriber = subscriber;
  return next();
}
