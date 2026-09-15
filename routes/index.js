// Community / notification feature routes. Each module exports `default function register(app, ctx)`.
import { cache } from '../cache.js';
import { fetchAPI } from '../utils.js';
import { config } from '../config.js';
import { getDb, adminReady, requireUser, requireDb, verifyRequest, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import { sendToUser, sendToUsers, usersWantingType } from '../lib/push.js';
import { registerJob, registerJobRoutes, startJobTimer } from '../lib/jobs.js';

import notifications from './notifications.js';
import prices from './prices.js';
import gameInfo from './gameInfo.js';
import library from './library.js';
import releases from './releases.js';
import subscriptions from './subscriptions.js';
import serviceStatus from './serviceStatus.js';
import reviews from './reviews.js';
import social from './social.js';
import platforms from './platforms.js';

const MODULES = { notifications, prices, gameInfo, library, releases, subscriptions, serviceStatus, reviews, social, platforms };

/**
 * @param {import('express').Express} app
 * @param {{ cachedRoute: Function }} base cachedRoute from index.js
 */
export function registerCommunityRoutes(app, { cachedRoute }) {
  // GET route cached per parameter set (stale-while-revalidate), like hubRoutes' paramRoute
  function paramRoute(routePath, ttl, keyOf, loader) {
    app.get(routePath, async (req, res) => {
      const key = keyOf(req);
      if (!key) return res.status(400).json({ error: 'Invalid parameters' });
      try {
        const entry = await cache.swr(`community:${routePath}:${key}`, ttl, () => loader(req));
        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${Math.min(ttl, 300)}, stale-while-revalidate=86400` });
        res.send(entry.body);
      } catch (error) {
        res.set('Cache-Control', 'no-store');
        res.status(error.status || 502).json({ error: error.message });
      }
    });
  }

  const ctx = {
    cache, fetchAPI, config, cachedRoute, paramRoute,
    getDb, adminReady, requireUser, requireDb, verifyRequest, FieldValue, Timestamp,
    sendToUser, sendToUsers, usersWantingType, registerJob,
  };

  for (const [name, register] of Object.entries(MODULES)) {
    try {
      register(app, ctx);
    } catch (error) {
      console.error(`✗ route module ${name} failed to register:`, error.message);
    }
  }
  registerJobRoutes(app);
}

export { startJobTimer };
