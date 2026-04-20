const windows = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.resetAt > 0) windows.delete(key);
  }
}

setInterval(cleanup, 60000);

export function rateLimit({ windowMs = 60000, maxRequests = 60 } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let entry = windows.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    entry.count++;
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));

    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    next();
  };
}
