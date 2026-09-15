import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config.js';
import { cache, cacheMiddleware } from './cache.js';
import { fetchAPI, errorResponse, successResponse, validateInput, safeJsonParse, findIndex } from './utils.js';
import { registerHubRoutes } from './hubRoutes.js';
import { registerCommunityRoutes, startJobTimer } from './routes/index.js';
import { capture5xx, errorMiddleware, installProcessHandlers, registerMonitorRoutes, startupSelfCheck } from './lib/monitor.js';
import { listJobs, registerJob } from './lib/jobs.js';
import { withSnapshot } from './lib/persistentCache.js';

installProcessHandlers();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();

// ━━━━━━━━━━━━━━━━ MIDDLEWARE ━━━━━━━━━━━━━━━━

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits in front: req.ip is the visitor

// Performance middleware - order matters!
app.use(compression());
app.use(express.json({ limit: '200kb' }));
app.use(cors(config.cors));

// Security headers (an API: nothing may frame it or sniff content types)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  });
  next();
});

// Writes (POST/PUT/PATCH/DELETE): at most 90 per minute per IP. Reads stay unlimited (cached).
const writeHits = new Map();
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path === '/cron/run') return next();
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const recent = (writeHits.get(ip) || []).filter(t => now - t < 60 * 1000);
  recent.push(now);
  writeHits.set(ip, recent);
  if (writeHits.size > 10000) writeHits.delete(writeHits.keys().next().value);
  if (recent.length > 90) return res.status(429).json({ code: 'rate_limited', error: 'Too many requests, slow down' });
  next();
});

// Every 5xx answer is recorded in errorLogs (lib/monitor.js)
app.use(capture5xx);

// Default: user-specific data (favorites, reviews) must never be cached by browsers/CDNs.
// Cached external-data routes override this below.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ━━━━━━━━━━━━━━━━ CACHED EXTERNAL ROUTES ━━━━━━━━━━━━━━━━

const cachedRoutes = [];

/**
 * Registers a GET route whose response comes from the stale-while-revalidate cache.
 * The loader is only called on first use or in the background once the TTL expires.
 */
function cachedRoute(routePath, ttl, rawLoader, { warm = true } = {}) {
  const key = `route:${routePath}`;
  // A restarted instance can still answer from the last good copy when the upstream API is down
  const loader = withSnapshot(key, rawLoader);
  if (warm) cachedRoutes.push({ key, ttl, loader, routePath });

  app.get(routePath, async (req, res) => {
    try {
      const entry = await cache.swr(key, ttl, loader);
      const etag = `W/"${entry.expiresAt.toString(36)}-${entry.body.length.toString(36)}"`;
      res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${Math.min(ttl, 300)}, stale-while-revalidate=86400`,
        'X-Cache': Date.now() > entry.expiresAt ? 'STALE' : 'HIT',
        ETag: etag
      });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.send(entry.body);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      res.status(502).json({ error: error.message });
    }
  });
}

const rapidOptions = host => ({
  headers: { 'x-rapidapi-key': config.apis.rapid.key, 'x-rapidapi-host': host }
});

// ━━━━━━━━━━━━━━━━ DATA STORAGE ━━━━━━━━━━━━━━━━

const dataStore = {
  survivors: [],
  killers: [],
  survivorPerks: [],
  killerPerks: []
};

let nextId = {
  survivor: 0,
  killer: 0,
  survivorPerk: 0,
  killerPerk: 0
};

// ━━━━━━━━━━━━━━━━ DATA LOADING ━━━━━━━━━━━━━━━━

/**
 * Load all JSON files in parallel
 */
async function loadAllData() {
  try {
    console.log('Loading game data...');

    const [survivorsData, killersData, survivorPerksData, killerPerksData] = await Promise.all([
      fs.readFile(path.join(__dirname, 'survivors.json'), 'utf-8'),
      fs.readFile(path.join(__dirname, 'killers.json'), 'utf-8'),
      fs.readFile(path.join(__dirname, 'survivorperks.json'), 'utf-8'),
      fs.readFile(path.join(__dirname, 'killerperks.json'), 'utf-8')
    ]);

    // Process survivors
    const survivors = safeJsonParse(survivorsData, {});
    dataStore.survivors = Object.values(survivors).map(char => {
      const id = char.id || ++nextId.survivor;
      if (id > nextId.survivor) nextId.survivor = id;
      return {
        id,
        name: char.name || '',
        role: char.role || 'survivor',
        difficulty: char.difficulty || '',
        nationality: char.nationality || '',
        dlc: char.dlc || '',
        perks: char.perks_names || [],
        overview: char.overview || '',
        backstory: char.backstory || '',
        gender: char.gender || '',
        imgs: char.imgs?.portrait || ''
      };
    });

    // Process killers
    const killers = safeJsonParse(killersData, {});
    dataStore.killers = Object.values(killers).map(char => {
      const id = char.id || ++nextId.killer;
      if (id > nextId.killer) nextId.killer = id;
      return {
        id,
        name: char.name || '',
        fullname: char.fullName || '',
        difficulty: char.difficulty || '',
        nationality: char.nationality || '',
        realm: char.realm || '',
        powerAttackType: char.powerAttackType || '',
        weapon: char.weapon || '',
        moveSpeed: char.moveSpeed || '',
        terrorRadius: char.terrorRadius || '',
        height: char.height || '',
        power: char.power?.powerName || '',
        dlc: char.dlc || '',
        perks: char.perks_names || [],
        overview: char.overview || '',
        backstory: char.backstory || '',
        gender: char.gender || '',
        imgs: char.imgs?.portrait || ''
      };
    });

    // Process survivor perks
    const survivorPerks = safeJsonParse(survivorPerksData, []);
    dataStore.survivorPerks = survivorPerks.map(perk => {
      const id = perk.id || ++nextId.survivorPerk;
      if (id > nextId.survivorPerk) nextId.survivorPerk = id;
      return {
        id,
        name: perk.name || '',
        code: perk.code || '',
        survivorCode: perk.survivorCode || '',
        survivorName: perk.survivorName || '',
        description: perk.description || '',
        icon: perk.icon || ''
      };
    });

    // Process killer perks
    const killerPerks = safeJsonParse(killerPerksData, []);
    dataStore.killerPerks = killerPerks.map(perk => {
      const id = perk.id || ++nextId.killerPerk;
      if (id > nextId.killerPerk) nextId.killerPerk = id;
      return {
        id,
        name: perk.name || '',
        code: perk.code || '',
        killerCode: perk.killerCode || '',
        killerName: perk.killerName || '',
        description: perk.description || '',
        icon: perk.icon || ''
      };
    });

    // Serialize once instead of on every request
    staticJson.survivors = JSON.stringify(dataStore.survivors);
    staticJson.killers = JSON.stringify(dataStore.killers);

    console.log(`✓ Loaded ${dataStore.survivors.length} survivors`);
    console.log(`✓ Loaded ${dataStore.killers.length} killers`);
    console.log(`✓ Loaded ${dataStore.survivorPerks.length} survivor perks`);
    console.log(`✓ Loaded ${dataStore.killerPerks.length} killer perks`);

  } catch (error) {
    console.error('Error loading data:', error);
    process.exit(1);
  }
}

// ━━━━━━━━━━━━━━━━ GAME HUB ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Fetch popular games from RAWG API
 */
cachedRoute('/fetch-games', config.cache.externalApi, async () => {
  const data = await fetchAPI(`${config.apis.rawg.url}?key=${config.apis.rawg.key}`);
  return { games: data.results };
});

/**
 * Get digital stores
 */
cachedRoute('/stores', 86400, async () => {
  const data = await fetchAPI(`${config.apis.cheapshark.url}/stores`);
  if (!Array.isArray(data)) throw new Error('Unexpected stores response');
  return data;
});

/**
 * Search games by title
 */
app.get('/game', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'Title parameter is required' });

    const data = await fetchAPI(`${config.apis.cheapshark.url}/games?title=${encodeURIComponent(title)}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get MMO games news
 */
cachedRoute('/news', config.cache.news, async () => {
  const data = await fetchAPI('https://mmo-games.p.rapidapi.com/games', rapidOptions(config.apis.rapid.hosts.mmo));
  // The home page carousel only needs the first few dozen entries (full list is ~220 kB)
  return Array.isArray(data) ? data.slice(0, 50) : data;
});

/**
 * Get free-to-play games
 */
cachedRoute('/free', config.cache.externalApi, () =>
  fetchAPI('https://free-to-play-games-database.p.rapidapi.com/api/games', rapidOptions(config.apis.rapid.hosts.games))
);

/**
 * Get loot offers
 */
cachedRoute('/loot', config.cache.externalApi, () =>
  fetchAPI(
    'https://gamerpower.p.rapidapi.com/api/filter?platform=epic-games-store.steam.android&type=game.loot',
    rapidOptions(config.apis.rapid.hosts.loot)
  )
);

/**
 * Get live esports matches (short TTL: live data, not pre-warmed)
 */
cachedRoute('/getlive', 60, () =>
  fetchAPI('https://allsportsapi2.p.rapidapi.com/api/esport/matches/live', rapidOptions(config.apis.rapid.hosts.sports)),
  { warm: false }
);

/**
 * Get Epic Games discounted games
 */
cachedRoute('/discounted', config.cache.externalApi, () => fetchAPI(config.apis.epicgames.url));

/**
 * Get gaming news
 */
cachedRoute('/getgamingnews', config.cache.news, async () => {
  const data = await fetchAPI(`https://newsapi.org/v2/everything?q=Gaming&apiKey=${config.apis.newsapi.key}`);
  // Only the fields the frontend renders; the raw payload includes full article content
  return {
    status: data.status,
    totalResults: data.totalResults,
    articles: (data.articles || []).slice(0, 40).map(a => ({
      url: a.url,
      title: a.title,
      description: a.description,
      urlToImage: a.urlToImage,
      author: a.author,
      publishedAt: a.publishedAt,
      source: a.source
    }))
  };
});

// Fresh store data (Steam, GOG, Speedrun, ...) and per-game universes, see hubRoutes.js
registerHubRoutes(app, cachedRoute);

// Notifications, price alerts, library, LFG helpers, reviews ... see routes/index.js
registerCommunityRoutes(app, { cachedRoute });

// ━━━━━━━━━━━━━━━━ FAVORITES & REVIEWS ENDPOINTS ━━━━━━━━━━━━━━━━

// /getFav, /addfav, /delfav/:gameId, /get-all-reviews, /submit-review and the /reviews API live in
// routes/reviews.js (Firestore-backed via lib/reviewsStore.js, in-memory without Firebase Admin).

// ━━━━━━━━━━━━━━━━ MOVIE ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Helper function for TMDB requests
 */
async function fetchTMDBData(endpoint) {
  const options = {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${config.apis.tmdb.token}`
    }
  };
  const url = `${config.apis.tmdb.baseUrl}${endpoint}`;
  return fetchAPI(url, options);
}

/**
 * Get trending movies
 */
cachedRoute('/movies', config.cache.movies, () => fetchTMDBData('/trending/all/day?language=en-US'));

/**
 * Search movies
 */
app.get('/search/:movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const { movies } = req.params;
    const data = await fetchTMDBData(`/search/movie?query=${encodeURIComponent(movies)}&include_adult=false&language=en-US&page=1`);
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get trending movies
 */
app.get('/trending-movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const data = await fetchTMDBData('/trending/movie/day?language=en-US');
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get now playing movies
 */
app.get('/movies/now-playing', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const data = await fetchTMDBData('/movie/now_playing?language=en-US&page=1');
    if (data && !data.success) {
      res.status(200).json({
        success: true,
        data: data
      });
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching now playing movies:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch now playing movies'
    });
  }
});

/**
 * Get upcoming movies
 */
app.get('/upcoming-movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const data = await fetchTMDBData('/movie/upcoming?language=en-US&page=1');
    if (data && !data.success) {
      res.status(200).json({
        success: true,
        data: data
      });
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching upcoming movies:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch upcoming movies'
    });
  }
});

/**
 * Get top rated movies
 */
app.get('/top-rated-movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const data = await fetchTMDBData('/movie/top_rated?language=en-US&page=1');
    if (data && !data.success) {
      res.status(200).json({
        success: true,
        data: data
      });
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching top rated movies:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch top rated movies'
    });
  }
});

// ━━━━━━━━━━━━━━━━ DEAD BY DAYLIGHT ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Get all survivors
 */
const staticJson = { survivors: '[]', killers: '[]' };
const STATIC_CACHE = 'public, max-age=3600, stale-while-revalidate=604800';

app.get('/characters', (req, res) => {
  res.set({ 'Cache-Control': STATIC_CACHE, 'Content-Type': 'application/json; charset=utf-8' });
  res.send(staticJson.survivors);
});

/**
 * Get all killers
 */
app.get('/charactersK', (req, res) => {
  res.set({ 'Cache-Control': STATIC_CACHE, 'Content-Type': 'application/json; charset=utf-8' });
  res.send(staticJson.killers);
});

/**
 * Get survivor perks by name
 */
app.get('/perksS/:name', (req, res) => {
  try {
    const perkName = req.params.name.toLowerCase();
    const perk = dataStore.survivorPerks.find(p => p.name.toLowerCase() == perkName);
    
    if (perk) {
      res.json(perk);
    } else {
      res.status(404).json({ error: "Survivor perk not found" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get killer perks by name
 */
app.get('/perksK/:name', (req, res) => {
  try {
    const perkName = req.params.name.toLowerCase();
    const perk = dataStore.killerPerks.find(p => p.name.toLowerCase() == perkName);
    
    if (perk) {
      res.json(perk);
    } else {
      res.status(404).json({ error: "Killer perk not found" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get DBD events
 */
app.get('/events', cacheMiddleware(config.cache.dbd), async (req, res) => {
  try {
    const data = await fetchAPI(`${config.apis.dbd.url}/events`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get DBD addons
 */
app.get('/addons', cacheMiddleware(config.cache.dbd), async (req, res) => {
  try {
    const data = await fetchAPI(`${config.apis.dbd.url}/addons`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get DBD DLC
 */
app.get('/dlc', cacheMiddleware(config.cache.dbd), async (req, res) => {
  try {
    const data = await fetchAPI(`${config.apis.dbd.url}/dlc`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get perk info from external API
 */
app.get('/perks/:name', cacheMiddleware(config.cache.dbd), async (req, res) => {
  try {
    const response = await fetchAPI(`${config.apis.dbd.url}/perkinfo?perk=` + req.params.name);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━ HEALTH & STATUS ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.status(200).send('Alive');
});

// /health/deep, /client-errors, /admin/errors
registerMonitorRoutes(app, { listJobs, registerJob });

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.send('<h1>Welcome to GameHub Backend</h1><p>API is running. Visit <a href="/health">/health</a> for status.</p>');
});

// ━━━━━━━━━━━━━━━━ ERROR HANDLING ━━━━━━━━━━━━━━━━

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json(errorResponse(new Error('Route not found'), 'Endpoint not found'));
});

/**
 * Global error handler (logs + records in errorLogs)
 */
app.use(errorMiddleware);

// ━━━━━━━━━━━━━━━━ SERVER INITIALIZATION ━━━━━━━━━━━━━━━━

/**
 * Start the server
 */
async function startServer() {
  try {
    // Load all data before starting server
    await loadAllData();

    app.listen(config.port, () => {
      console.log(`\n✓ Server is running on port ${config.port}`);
      console.log(`✓ Mode: ${config.nodeEnv}`);
      console.log(`✓ Cache enabled for external APIs (TTL: ${config.cache.externalApi}s)`);
      console.log(`✓ Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`);
      warmCaches();
      startJobTimer();
      startupSelfCheck();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Preload every cached route right after boot, so visitors always get an
 * in-memory answer. After that, stale entries are refreshed in the background
 * when they are requested (no timer, to protect the RapidAPI/NewsAPI quotas).
 */
function warmCaches() {
  Promise.allSettled(cachedRoutes.map(r => cache.refresh(r.key, r.ttl, r.loader))).then(results => {
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? cachedRoutes[i].routePath : null))
      .filter(Boolean);
    console.log(`✓ Warmed ${results.length - failed.length}/${results.length} caches${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
  });

  // Render free instances sleep after 15 min without traffic (30-60 s cold start).
  // Render sets RENDER_EXTERNAL_URL automatically; pinging ourselves keeps the instance awake.
  const selfUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && process.env.KEEP_ALIVE !== 'false') {
    setInterval(() => fetch(`${selfUrl}/health`).catch(() => {}), 10 * 60 * 1000).unref();
    console.log(`✓ Keep-alive ping enabled for ${selfUrl}`);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nGraceful shutdown initiated...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nServer stopped');
  process.exit(0);
});

// Start the server
startServer();
