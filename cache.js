// In-memory stale-while-revalidate cache.
// Once a key has been loaded, requests are always answered from memory
// (fresh or stale) and expired entries are refreshed in the background,
// so no visitor ever waits for a slow upstream API again.
class Cache {
  constructor() {
    this.data = new Map();
    this.inFlight = new Map();
  }

  set(key, value, ttl = 600) {
    this.data.set(key, { value, body: JSON.stringify(value), expiresAt: Date.now() + ttl * 1000 });
  }

  getEntry(key) {
    return this.data.get(key) || null;
  }

  get(key) {
    const entry = this.data.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.value;
  }

  clear() {
    this.data.clear();
  }

  delete(key) {
    this.data.delete(key);
  }

  /**
   * Returns the cached entry, loading it if missing. Stale entries are
   * returned immediately and refreshed in the background.
   */
  async swr(key, ttl, loader) {
    const entry = this.data.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) this.refresh(key, ttl, loader).catch(() => {});
      return entry;
    }
    await this.refresh(key, ttl, loader);
    return this.data.get(key);
  }

  refresh(key, ttl, loader) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = Promise.resolve()
      .then(loader)
      .then(value => {
        this.set(key, value, ttl);
        return value;
      })
      .catch(error => {
        // Keep serving the stale copy, retry again in a minute
        const entry = this.data.get(key);
        if (entry) entry.expiresAt = Date.now() + 60 * 1000;
        console.error(`Cache refresh failed for ${key}:`, error.message);
        throw error;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}

export const cache = new Cache();

// Express middleware for API response caching (kept for simple routes)
export function cacheMiddleware(ttl = 600) {
  return (req, res, next) => {
    const key = `${req.method}:${req.originalUrl}`;
    const cachedResponse = cache.get(key);

    if (cachedResponse && req.method === 'GET') {
      res.set('X-Cache', 'HIT');
      return res.json(cachedResponse);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = function (data) {
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
