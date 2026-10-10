// A small in-memory sliding-window limiter (one process, prototype scale). Registration and admin login use it to blunt abuse.
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();

  function prune(at) {
    for (const [key, times] of hits) {
      const kept = times.filter((time) => at - time < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  return {
    // Records one attempt and tells whether it is allowed.
    attempt(key) {
      const at = now();
      if (hits.size > 5000) prune(at);
      const times = (hits.get(key) ?? []).filter((time) => at - time < windowMs);
      if (times.length >= max) {
        hits.set(key, times);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (at - times[0])) / 1000)) };
      }
      times.push(at);
      hits.set(key, times);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    // A successful login clears the failures for that key.
    reset(key) {
      hits.delete(key);
    },
    clear() {
      hits.clear();
    },
  };
}

export function rateLimit({ windowMs, max, message = 'Too many requests. Please try again later.', key = (req) => req.ip, limiter = createRateLimiter({ windowMs, max }) }) {
  const middleware = (req, res, next) => {
    const result = limiter.attempt(key(req));
    if (result.allowed) return next();
    res.set('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({ message });
  };
  middleware.limiter = limiter;
  return middleware;
}
