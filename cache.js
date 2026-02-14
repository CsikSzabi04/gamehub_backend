// Simple in-memory cache with TTL
class Cache {
  constructor() {
    this.data = new Map();
  }

  set(key, value, ttl = 600) {
    const expiresAt = Date.now() + (ttl * 1000);
    this.data.set(key, { value, expiresAt });
  }

  get(key) {
    if (!this.data.has(key)) return null;
    
    const { value, expiresAt } = this.data.get(key);
    if (Date.now() > expiresAt) {
      this.data.delete(key);
      return null;
    }
    return value;
  }

  clear() {
    this.data.clear();
  }

  delete(key) {
    this.data.delete(key);
  }
}

export const cache = new Cache();

// Express middleware for API response caching
export function cacheMiddleware(ttl = 600) {
  return (req, res, next) => {
    const key = `${req.method}:${req.originalUrl}`;
    const cachedResponse = cache.get(key);

    if (cachedResponse && req.method === 'GET') {
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-TTL', ttl);
      return res.json(cachedResponse);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (res.statusCode === 200 && req.method === 'GET') {
        cache.set(key, data, ttl);
      }
      return originalJson(data);
    };

    next();
  };
}

// Clear cache on specific operations
export function clearCache(pattern) {
  if (pattern) {
    for (const key of cache.data.keys()) {
      if (key.includes(pattern)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
}
