import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Subscriber and admin sessions are opaque random tokens. Only a SHA-256 of the token is ever stored.
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// Constant-time comparison that also hides the length of the secret (both sides are hashed first).
export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}
