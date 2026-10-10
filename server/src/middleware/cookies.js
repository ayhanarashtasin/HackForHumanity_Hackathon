// Express 5 has no cookie parser. The tokens this app sets are base64url, so no encoding or decoding is needed.
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(at + 1).trim();
  }
  return cookies;
}

export function serializeCookie(name, value, {
  maxAgeSeconds, httpOnly = true, sameSite = 'Lax', secure = false, path = '/',
} = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = (name, options = {}) => serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
