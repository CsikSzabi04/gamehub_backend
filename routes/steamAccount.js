// Steam account extras for the linked Steam profile (users/{uid}.steamId) and wishlist price alerts.
//
//   GET  /steam/me                    (auth) profile, Steam level + XP, badges, recently played, friends, bans
//   GET  /steam/wishlist?cc=hu        (auth) wishlist with names, images, release info and live prices
//   POST /steam/wishlist/alerts       (auth) { enabled, minDiscount (1-95), cc } -> saves users/{uid}.wishlistAlerts and
//                                     creates / removes "sale" price alerts (source: 'wishlist') for the wishlist right away
//   job  wishlistAlerts (12h)         keeps those alerts in step with the wishlist (new games added, removed games dropped)
//
// Needs STEAM_API_KEY. A private profile / friends list / wishlist answers { private: true } instead of failing.
import { fetchWithTimeout } from './platforms.js';
import { normCc, steamPrices } from './prices.js';

const STEAM_API = 'https://api.steampowered.com';
const STEAM_CDN = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const MAX_WISHLIST = 1000;
const MAX_FRIENDS = 200;
const ME_TTL_MS = 10 * 60 * 1000;
const WISHLIST_TTL_MS = 20 * 60 * 1000;
const JOB_MAX_USERS = 60;

const fail = (res, status, code, error) => res.status(status).json({ code, error });
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hours = minutes => Math.round(((minutes || 0) / 60) * 10) / 10;
const headerImage = appid => `${STEAM_CDN}steam/apps/${appid}/header.jpg`;

async function steamJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw httpError(403, 'private', `Steam: HTTP ${res.status}`);
  if (res.status === 429) throw httpError(429, 'rate_limited', 'Steam rate limit');
  if (!res.ok) throw httpError(502, 'upstream', `Steam: HTTP ${res.status}`);
  return res.json();
}

/** Tiny LRU with TTL for per-user responses (the shared cache never evicts). */
function lru(max) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      map.delete(key);
      if (Date.now() > entry.expiresAt) return undefined;
      map.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs) {
      map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete: key => map.delete(key),
  };
}

const PERSONA_STATES = ['offline', 'online', 'busy', 'away', 'snooze', 'trade', 'play'];

function slimPlayer(p) {
  return {
    steamId: String(p.steamid),
    name: String(p.personaname || '').slice(0, 64),
    avatar: typeof p.avatarfull === 'string' ? p.avatarfull : p.avatarmedium || null,
    profileUrl: typeof p.profileurl === 'string' ? p.profileurl : `https://steamcommunity.com/profiles/${p.steamid}`,
    state: p.gameextrainfo ? 'ingame' : PERSONA_STATES[p.personastate] || 'offline',
    game: p.gameextrainfo ? String(p.gameextrainfo).slice(0, 120) : null,
    gameId: p.gameid ? String(p.gameid) : null,
    lastLogoff: p.lastlogoff ? new Date(p.lastlogoff * 1000).toISOString() : null,
  };
}

export default function register(app, ctx) {
  const { getDb, requireUser, registerJob, fetchAPI, FieldValue } = ctx;
  const meCache = lru(300);
  const wishlistCache = lru(300);
  const key = () => process.env.STEAM_API_KEY;

  async function linkedSteamId(uid) {
    const snap = await getDb().collection('users').doc(uid).get();
    const steamId = snap.data()?.steamId;
    if (!/^7656119\d{10}$/.test(String(steamId || ''))) throw httpError(400, 'no_account', 'Link your Steam profile first');
    return { steamId: String(steamId), data: snap.data() };
  }

  async function playerSummaries(ids) {
    const players = [];
    for (let i = 0; i < ids.length; i += 100) {
      const data = await steamJson(`${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key())}&steamids=${ids.slice(i, i + 100).join(',')}`);
      players.push(...(data?.response?.players || []));
    }
    return players;
  }

  /* ───────── /steam/me ───────── */

  async function loadMe(steamId) {
    const cached = meCache.get(steamId);
    if (cached) return cached;
    const k = encodeURIComponent(key());
    const optional = promise => promise.catch(error => (error.code === 'private' ? { private: true } : null));

    const [summaries, level, badges, recent, friends, bans] = await Promise.all([
      playerSummaries([steamId]),
      optional(steamJson(`${STEAM_API}/IPlayerService/GetSteamLevel/v1/?key=${k}&steamid=${steamId}`)),
      optional(steamJson(`${STEAM_API}/IPlayerService/GetBadges/v1/?key=${k}&steamid=${steamId}`)),
      optional(steamJson(`${STEAM_API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${k}&steamid=${steamId}&count=12`)),
      optional(steamJson(`${STEAM_API}/ISteamUser/GetFriendList/v1/?key=${k}&steamid=${steamId}&relationship=friend`)),
      optional(steamJson(`${STEAM_API}/ISteamUser/GetPlayerBans/v1/?key=${k}&steamids=${steamId}`)),
    ]);
    const player = summaries[0];
    if (!player) throw httpError(404, 'no_account', 'Steam profile not found');

    const badgeData = badges?.response || {};
    const badgeList = Array.isArray(badgeData.badges) ? badgeData.badges : [];

    let friendList = null;
    let friendCount = null;
    if (friends && !friends.private) {
      const all = friends?.friendslist?.friends || [];
      friendCount = all.length;
      const sinceById = new Map(all.map(f => [String(f.steamid), f.friend_since]));
      const ids = all.slice(0, MAX_FRIENDS).map(f => String(f.steamid));
      const rank = { ingame: 0, online: 1, busy: 1, away: 2, snooze: 2, trade: 1, play: 1, offline: 3 };
      friendList = (await playerSummaries(ids).catch(() => []))
        .map(p => ({ ...slimPlayer(p), friendSince: sinceById.get(String(p.steamid)) ? new Date(sinceById.get(String(p.steamid)) * 1000).toISOString() : null }))
        .sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.name.localeCompare(b.name));
    }

    const ban = bans?.players?.[0];
    const result = {
      steamId,
      profile: {
        ...slimPlayer(player),
        public: player.communityvisibilitystate === 3,
        country: player.loccountrycode || null,
        createdAt: player.timecreated ? new Date(player.timecreated * 1000).toISOString() : null,
      },
      level: level?.response?.player_level ?? badgeData.player_level ?? null,
      xp: badgeData.player_xp != null ? {
        total: badgeData.player_xp,
        toNext: badgeData.player_xp_needed_to_level_up ?? null,
        currentLevelStart: badgeData.player_xp_needed_current_level ?? null,
      } : null,
      badges: {
        count: badgeList.length,
        recent: [...badgeList]
          .sort((a, b) => (b.completion_time || 0) - (a.completion_time || 0))
          .slice(0, 8)
          .map(b => ({
            badgeId: b.badgeid,
            appid: b.appid || null,
            level: b.level || 1,
            xp: b.xp || 0,
            scarcity: b.scarcity ?? null,
            completedAt: b.completion_time ? new Date(b.completion_time * 1000).toISOString() : null,
            image: b.appid ? headerImage(b.appid) : null,
          })),
        private: Boolean(badges?.private),
      },
      recentlyPlayed: recent?.private ? null : (recent?.response?.games || []).map(g => ({
        appid: g.appid,
        name: String(g.name || `App ${g.appid}`).slice(0, 160),
        hours2Weeks: hours(g.playtime_2weeks),
        hoursTotal: hours(g.playtime_forever),
        image: headerImage(g.appid),
      })),
      friends: friendList,
      friendCount,
      friendsPrivate: Boolean(friends?.private),
      bans: ban ? {
        vac: ban.NumberOfVACBans || 0,
        game: ban.NumberOfGameBans || 0,
        community: Boolean(ban.CommunityBanned),
        economy: ban.EconomyBan && ban.EconomyBan !== 'none' ? ban.EconomyBan : null,
        daysSinceLast: ban.VACBanned || ban.NumberOfGameBans ? ban.DaysSinceLastBan : null,
      } : null,
      updatedAt: new Date().toISOString(),
    };
    meCache.set(steamId, result, ME_TTL_MS);
    return result;
  }

  /* ───────── Wishlist ───────── */

  async function wishlistIds(steamId) {
    // Public wishlists answer without a key too; the key is sent when available
    const k = key() ? `key=${encodeURIComponent(key())}&` : '';
    const data = await steamJson(`${STEAM_API}/IWishlistService/GetWishlist/v1/?${k}steamid=${steamId}`);
    const items = data?.response?.items;
    if (!Array.isArray(items)) return { private: true, items: [] };
    return {
      private: false,
      items: items
        .filter(i => i?.appid)
        .slice(0, MAX_WISHLIST)
        .map(i => ({ appid: Number(i.appid), priority: i.priority ?? null, addedAt: i.date_added ? new Date(i.date_added * 1000).toISOString() : null })),
    };
  }

  /** Names, images and release info (store region cc) for many appids. */
  async function storeItems(appids, cc) {
    const map = new Map();
    for (let i = 0; i < appids.length; i += 100) {
      const input = {
        ids: appids.slice(i, i + 100).map(appid => ({ appid })),
        context: { language: 'english', country_code: cc.toUpperCase() },
        data_request: { include_assets: true, include_release: true },
      };
      const data = await fetchAPI(`${STEAM_API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, {}, 20000).catch(() => null);
      for (const item of data?.response?.store_items || []) {
        if (!item?.success || !item.appid) continue;
        const assets = item.assets;
        const offer = item.best_purchase_option;
        map.set(Number(item.appid), {
          name: String(item.name || '').slice(0, 160),
          image: assets?.asset_url_format && assets.header ? STEAM_CDN + assets.asset_url_format.replace('${FILENAME}', assets.header) : headerImage(item.appid),
          isFree: Boolean(item.is_free),
          comingSoon: Boolean(item.release?.is_coming_soon || (item.release?.steam_release_date && item.release.steam_release_date * 1000 > Date.now())),
          releaseDate: item.release?.steam_release_date ? new Date(item.release.steam_release_date * 1000).toISOString() : null,
          comingSoonText: item.release?.custom_release_date_message || item.release?.coming_soon_display || null,
          formattedPrice: offer?.formatted_final_price || null,
          formattedOriginal: offer?.discount_pct ? offer.formatted_original_price || null : null,
          storeDiscount: offer?.discount_pct || 0,
        });
      }
    }
    return map;
  }

  async function loadWishlist(steamId, cc) {
    const cacheKey = `${steamId}:${cc}`;
    const cached = wishlistCache.get(cacheKey);
    if (cached) return cached;
    const list = await wishlistIds(steamId);
    if (list.private) return { steamId, cc, private: true, items: [], currency: null, updatedAt: new Date().toISOString() };

    const appids = list.items.map(i => i.appid);
    const info = await storeItems(appids, cc);
    const prices = new Map();
    for (let i = 0; i < appids.length; i += 50) {
      const chunk = appids.slice(i, i + 50);
      const result = await steamPrices(fetchAPI, chunk, cc).catch(() => null);
      if (result) for (const [appid, value] of result) prices.set(appid, value.price);
      if (i + 50 < appids.length) await sleep(300);
    }

    let currency = null;
    const items = list.items.map(item => {
      const meta = info.get(item.appid) || {};
      const price = prices.get(item.appid) || null;
      if (price?.currency) currency = currency || price.currency;
      return {
        ...item,
        name: meta.name || `App ${item.appid}`,
        image: meta.image || headerImage(item.appid),
        isFree: Boolean(meta.isFree),
        comingSoon: Boolean(meta.comingSoon),
        releaseDate: meta.releaseDate || null,
        comingSoonText: meta.comingSoonText || null,
        price: price ? { final: price.final, initial: price.initial, discount: price.discount, formatted: price.formatted, currency: price.currency } : null,
        formattedPrice: meta.formattedPrice || null,
      };
    });
    const result = { steamId, cc, private: false, currency, items, updatedAt: new Date().toISOString() };
    wishlistCache.set(cacheKey, result, WISHLIST_TTL_MS);
    return result;
  }

  /**
   * Makes users/{uid}/priceAlerts match the wishlist for alerts with source 'wishlist'.
   * Alerts the user created by hand are never touched.
   */
  async function syncWishlistAlerts(uid, settings, steamId) {
    const db = getDb();
    const alertsCol = db.collection('users').doc(uid).collection('priceAlerts');
    const existingSnap = await alertsCol.get();
    const existing = new Map(existingSnap.docs.map(d => [d.id, d.data()]));
    let created = 0;
    let removed = 0;
    let updated = 0;
    let batch = db.batch();
    let ops = 0;
    const commitIfFull = async () => {
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    };

    if (!settings.enabled) {
      for (const [id, data] of existing) {
        if (data.source !== 'wishlist') continue;
        batch.delete(alertsCol.doc(id));
        ops++;
        removed++;
        await commitIfFull();
      }
      if (ops) await batch.commit();
      return { created, removed, updated, wishlist: null };
    }

    const list = await wishlistIds(steamId);
    if (list.private) throw httpError(403, 'private', 'Steam wishlist is private');
    const wanted = new Set(list.items.map(i => `steam-${i.appid}`));
    const newIds = list.items.map(i => i.appid).filter(appid => !existing.has(`steam-${appid}`));
    const info = newIds.length ? await storeItems(newIds, settings.cc) : new Map();
    const now = FieldValue.serverTimestamp();

    for (const appid of newIds) {
      const meta = info.get(appid);
      if (meta?.isFree) continue;
      batch.set(alertsCol.doc(`steam-${appid}`), {
        gameKey: `steam-${appid}`,
        name: meta?.name || `Steam app ${appid}`,
        image: meta?.image || headerImage(appid),
        steamAppId: appid,
        cc: settings.cc,
        currency: null,
        mode: 'sale',
        minDiscount: settings.minDiscount,
        targetPrice: null,
        active: true,
        source: 'wishlist',
        lastPrice: null,
        lastNotifiedPrice: null,
        triggeredAt: null,
        createdAt: now,
        updatedAt: now,
      });
      ops++;
      created++;
      await commitIfFull();
    }
    for (const [id, data] of existing) {
      if (data.source !== 'wishlist') continue;
      if (!wanted.has(id)) {
        batch.delete(alertsCol.doc(id));
        ops++;
        removed++;
      } else if (data.minDiscount !== settings.minDiscount || data.cc !== settings.cc) {
        const patch = { minDiscount: settings.minDiscount, cc: settings.cc, updatedAt: now, lastNotifiedPrice: null };
        if (data.cc !== settings.cc) patch.currency = null;
        batch.update(alertsCol.doc(id), patch);
        ops++;
        updated++;
      }
      await commitIfFull();
    }
    if (ops) await batch.commit();
    return { created, removed, updated, wishlist: list.items.length };
  }

  /* ───────── Routes ───────── */

  const guard = (res, error, label) => {
    if (error.status) return fail(res, error.status, error.code, error.message);
    console.error(`${label}:`, error.message);
    return fail(res, 502, 'upstream', 'Steam is not responding, try again later');
  };

  app.get('/steam/me', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!key()) return fail(res, 503, 'not_configured', 'Steam API key missing on the server');
    try {
      const { steamId } = await linkedSteamId(req.user.uid);
      if (req.query.refresh === '1') meCache.delete(steamId);
      res.json(await loadMe(steamId));
    } catch (error) {
      guard(res, error, 'steam me');
    }
  });

  app.get('/steam/wishlist', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cc = normCc(req.query.cc) || 'hu';
    try {
      const { steamId, data } = await linkedSteamId(req.user.uid);
      if (req.query.refresh === '1') wishlistCache.delete(`${steamId}:${cc}`);
      res.json({ ...(await loadWishlist(steamId, cc)), alerts: data?.wishlistAlerts || null });
    } catch (error) {
      guard(res, error, 'steam wishlist');
    }
  });

  app.post('/steam/wishlist/alerts', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    const enabled = Boolean(req.body?.enabled);
    const minDiscount = Math.min(95, Math.max(1, Math.round(Number(req.body?.minDiscount) || 1)));
    const cc = normCc(req.body?.cc) || 'hu';
    try {
      const { steamId } = await linkedSteamId(uid);
      const settings = { enabled, minDiscount, cc };
      const result = await syncWishlistAlerts(uid, settings, steamId);
      await getDb().collection('users').doc(uid).set({
        wishlistAlerts: { ...settings, lastSyncAt: new Date().toISOString(), count: result.wishlist ?? 0 },
      }, { merge: true });
      res.json({ ok: true, settings, ...result });
    } catch (error) {
      guard(res, error, 'wishlist alerts');
    }
  });

  registerJob('wishlistAlerts', 12 * 60 * 60 * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no db' };
    const snap = await db.collection('users').where('wishlistAlerts.enabled', '==', true).select('steamId', 'wishlistAlerts').limit(JOB_MAX_USERS).get();
    let synced = 0;
    let created = 0;
    let removed = 0;
    let failed = 0;
    for (const doc of snap.docs) {
      const { steamId, wishlistAlerts: settings } = doc.data();
      if (!/^7656119\d{10}$/.test(String(steamId || ''))) continue;
      try {
        const result = await syncWishlistAlerts(doc.id, { enabled: true, minDiscount: Number(settings.minDiscount) || 1, cc: normCc(settings.cc) || 'hu' }, String(steamId));
        await doc.ref.set({ wishlistAlerts: { lastSyncAt: new Date().toISOString(), count: result.wishlist ?? 0 } }, { merge: true });
        synced++;
        created += result.created;
        removed += result.removed;
      } catch (error) {
        failed++;
        if (error.code !== 'private') console.error('wishlistAlerts:', error.message);
      }
      await sleep(1000);
    }
    return { users: snap.size, synced, created, removed, failed };
  });
}
