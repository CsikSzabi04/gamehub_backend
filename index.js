import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config.js';
import { cache, cacheMiddleware } from './cache.js';
import { fetchAPI, errorResponse, successResponse, validateInput, safeJsonParse, findIndex } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();

// ━━━━━━━━━━━━━━━━ MIDDLEWARE ━━━━━━━━━━━━━━━━

// Performance middleware - order matters!
app.use(compression());
app.use(express.json());
app.use(cors(config.cors));

// Cache middleware for GET requests
app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', 'public, max-age=3600');
  }
  next();
});

// ━━━━━━━━━━━━━━━━ DATA STORAGE ━━━━━━━━━━━━━━━━

const dataStore = {
  survivors: [],
  killers: [],
  survivorPerks: [],
  killerPerks: [],
  userFavorites: {},
  reviews: {}
};

let nextId = {
  survivor: 0,
  killer: 0,
  survivorPerk: 0,
  killerPerk: 0,
  review: 1
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
app.get('/fetch-games', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const data = await fetchAPI(`${config.apis.rawg.url}?key=${config.apis.rawg.key}`);
    res.json({ games: data.results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get digital stores
 */
app.get('/stores', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const data = await fetchAPI(`${config.apis.cheapshark.url}/stores`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
app.get('/news', cacheMiddleware(config.cache.news), async (req, res) => {
  try {
    const options = {
      headers: {
        'x-rapidapi-key': config.apis.rapid.key,
        'x-rapidapi-host': config.apis.rapid.hosts.mmo
      }
    };
    const url = 'https://mmo-games.p.rapidapi.com/games';
    const data = await fetchAPI(url, options, config.cache.news);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get free-to-play games
 */
app.get('/free', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const options = {
      headers: {
        'x-rapidapi-key': config.apis.rapid.key,
        'x-rapidapi-host': config.apis.rapid.hosts.games
      }
    };
    const url = 'https://free-to-play-games-database.p.rapidapi.com/api/games';
    const data = await fetchAPI(url, options, config.cache.externalApi);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get loot offers
 */
app.get('/loot', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const options = {
      headers: {
        'x-rapidapi-key': config.apis.rapid.key,
        'x-rapidapi-host': config.apis.rapid.hosts.loot
      }
    };
    const url = 'https://gamerpower.p.rapidapi.com/api/filter?platform=epic-games-store.steam.android&type=game.loot';
    const data = await fetchAPI(url, options, config.cache.externalApi);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get live esports matches
 */
app.get('/getlive', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const options = {
      headers: {
        'x-rapidapi-key': config.apis.rapid.key,
        'x-rapidapi-host': config.apis.rapid.hosts.sports
      }
    };
    const url = 'https://allsportsapi2.p.rapidapi.com/api/esport/matches/live';
    const data = await fetchAPI(url, options, config.cache.externalApi);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Epic Games discounted games
 */
app.get('/discounted', cacheMiddleware(config.cache.externalApi), async (req, res) => {
  try {
    const data = await fetchAPI(config.apis.epicgames.url);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get gaming news
 */
app.get('/getgamingnews', cacheMiddleware(config.cache.news), async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/everything?q=Gaming&apiKey=${config.apis.newsapi.key}`;
    const data = await fetchAPI(url, {}, config.cache.news);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━ FAVORITES ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Get user favorites
 */
app.get('/getFav', (req, res) => {
  try {
    const { userId } = req.query;
    const favorites = dataStore.userFavorites[userId] || [];
    res.send(favorites);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Add favorite game
 */
app.post('/addfav', (req, res) => {
  try {
    const { name, userId, gameId } = req.body;
    if (name && userId && gameId) {
      const fave = { gameId: gameId, name: name };
      if (!dataStore.userFavorites[userId]) {
        dataStore.userFavorites[userId] = [];
      }
      dataStore.userFavorites[userId].push(fave);
      res.send(fave);
    } else {
      res.status(400).send({ error: 'Wrong parameters!' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete favorite
 */
app.delete('/delfav/:gameId', (req, res) => {
  try {
    if (req.params.gameId && req.body.userId) {
      let i = findIndex(dataStore.userFavorites[req.body.userId] || [], fav => fav.gameId == req.params.gameId);
      if (i != -1) {
        dataStore.userFavorites[req.body.userId].splice(i, 1);
        res.send('OK');
      } else {
        res.send({ error: 'No avaible ID!' });
      }
    } else {
      res.status(400).send({ error: 'Missing paramters!' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━ REVIEWS ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Get all reviews
 */
app.get('/get-all-reviews', (req, res) => {
  try {
    let allReviews = [];
    for (let gameId in dataStore.reviews) {
      allReviews = allReviews.concat(dataStore.reviews[gameId]);
    }
    res.json(allReviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit review
 */
app.post('/submit-review', (req, res) => {
  try {
    const { gameId, userId, email, reviewText, rating, gameName } = req.body;
    const newReview = {
      id: nextId.review,
      gameId,
      gameName,
      userId,
      email,
      review: reviewText,
      rating,
      createdAt: new Date()
    };
    if (!dataStore.reviews[gameId]) {
      dataStore.reviews[gameId] = [];
    }
    dataStore.reviews[gameId].push(newReview);
    nextId.review++;
    res.send(newReview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━ MOVIE ENDPOINTS ━━━━━━━━━━━━━━━━

/**
 * Helper function for TMDB requests
 */
async function fetchTMDBData(endpoint, cacheTime = config.cache.movies) {
  const options = {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${config.apis.tmdb.token}`
    }
  };
  const url = `${config.apis.tmdb.baseUrl}${endpoint}`;
  return fetchAPI(url, options, cacheTime);
}

/**
 * Get trending movies
 */
app.get('/movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const data = await fetchTMDBData('/trending/all/day?language=en-US');
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Search movies
 */
app.get('/search/:movies', cacheMiddleware(config.cache.movies), async (req, res) => {
  try {
    const { movies } = req.params;
    const data = await fetchTMDBData(`/search/movie?query=${movies}&include_adult=false&language=en-US&page=1`);
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
app.get('/characters', (req, res) => {
  res.json(dataStore.survivors);
});

/**
 * Get all killers
 */
app.get('/charactersK', (req, res) => {
  res.json(dataStore.killers);
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
 * Global error handler
 */
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json(errorResponse(error, 'Internal server error'));
});

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
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
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
