import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 88,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // API Keys and URLs
  apis: {
    rawg: {
      url: process.env.RAWG_API_URL,
      key: process.env.RAWG_API_KEY
    },
    rapid: {
      key: process.env.RAPIDAPI_KEY,
      hosts: {
        mmo: process.env.RAPIDAPI_MMO_HOST,
        games: process.env.RAPIDAPI_GAMES_HOST,
        sports: process.env.RAPIDAPI_SPORTS_HOST,
        loot: process.env.RAPIDAPI_LOOT_HOST
      }
    },
    newsapi: {
      key: process.env.NEWSAPI_KEY
    },
    tmdb: {
      token: process.env.TMDB_API_TOKEN,
      baseUrl: 'https://api.themoviedb.org/3'
    },
    dbd: {
      url: process.env.DBD_API_URL
    },
    cheapshark: {
      url: 'https://www.cheapshark.com/api/1.0'
    },
    epicgames: {
      url: 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions'
    }
  },

  // Cache Configuration (in seconds)
  cache: {
    externalApi: parseInt(process.env.CACHE_DURATION_EXTERNAL_API || '600'),
    movies: parseInt(process.env.CACHE_DURATION_MOVIES || '1800'),
    news: parseInt(process.env.CACHE_DURATION_NEWS || '900'),
    dbd: parseInt(process.env.CACHE_DURATION_EXTERNAL_API || '600')
  },

  // CORS Configuration
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true
  }
};
