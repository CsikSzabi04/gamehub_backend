// Achievement / trophy fetchers for Steam, Xbox (OpenXBL) and PlayStation.
//
// Every source has:
//   titles(credential)            -> { account, titles: [Title] }     one cheap call, used to find what changed
//   details(credential, title)    -> [Item]                           per-game achievement list (the expensive part)
// Title = { gameKey, platform, sourceId, name, image, playtimeHours, lastPlayed, fingerprint, detailed,
//           unlocked, total, points, pointsTotal, trophies }
// Item  = { id, name, desc, icon, unlocked, at, rarity, hidden, type?, gs? }
// Errors carry .status and .code ('invalid_credentials' | 'private' | 'rate_limited' | 'upstream').
import { fetchWithTimeout, psnAccessToken } from '../routes/platforms.js';

const STEAM_API = 'https://api.steampowered.com';
const XBL_API = 'https://xbl.io/api/v2';
const PSN_API = 'https://m.np.playstation.com/api/trophy/v1';
const MAX_ITEMS = 1500;
const DAY = 24 * 60 * 60;

export const PSN_TROPHY_POINTS = { bronze: 15, silver: 30, gold: 90, platinum: 300 };

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const httpsUrl = value => (typeof value === 'string' && /^https?:\/\//i.test(value) && value.length <= 500 ? value.replace(/^http:/i, 'https:') : null);
const safeId = value => String(value ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);

/** Date-ish -> ISO string, null for missing / placeholder dates (Xbox uses 0001-01-01 for locked). */
export function isoDate(value) {
  if (value == null || value === '' || value === 0) return null;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1990 ? null : date.toISOString();
}

function percent(value) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function getJson(url, options = {}, label = 'request') {
  const res = await fetchWithTimeout(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if (res.status === 429) throw httpError(429, 'rate_limited', `${label}: rate limited`);
  if (!res.ok) {
    const error = httpError(res.status === 401 ? 401 : 502, res.status === 401 ? 'invalid_credentials' : 'upstream', `${label}: HTTP ${res.status}`);
    error.upstreamStatus = res.status;
    throw error;
  }
  return res.json();
}

/* ───────── Shared: turn an item list into the per-game summary ───────── */

/** Points for one unlocked achievement by global unlock rate (unknown rarity counts as common). */
export function rarityWeight(rarity) {
  if (rarity == null) return 1;
  if (rarity < 1) return 15;
  if (rarity < 5) return 8;
  if (rarity < 10) return 5;
  if (rarity < 20) return 3;
  if (rarity < 50) return 2;
  return 1;
}

const slimItem = item => ({ id: item.id, name: item.name, icon: item.icon, at: item.at, rarity: item.rarity, ...(item.type ? { type: item.type } : {}) });

/**
 * Summary fields for users/{uid}/achievements/{gameKey}. `items` may be null (details not fetched,
 * e.g. Xbox 360 titles): then the counts from the title list are used.
 */
export function summarize(title, items) {
  // No list (not fetched) or an empty one where the title list says there are achievements: trust the counts
  if (!items || (!items.length && title.total > 0)) {
    const perfect = title.total > 0 && title.unlocked >= title.total;
    return {
      unlocked: title.unlocked || 0,
      total: title.total || 0,
      perfect,
      rare: 0,
      ultraRare: 0,
      hunterPoints: (title.unlocked || 0) + (perfect ? 25 : 0) + (title.trophies?.platinum ? 20 : 0),
      recent: [],
      rarest: [],
      lastUnlockAt: null,
    };
  }
  const unlockedItems = items.filter(item => item.unlocked);
  const total = items.length;
  const perfect = total > 0 && unlockedItems.length === total;
  const platinum = unlockedItems.some(item => item.type === 'platinum');
  const byDate = unlockedItems.filter(item => item.at).sort((a, b) => b.at.localeCompare(a.at));
  return {
    unlocked: unlockedItems.length,
    total,
    perfect,
    rare: unlockedItems.filter(item => item.rarity != null && item.rarity < 10).length,
    ultraRare: unlockedItems.filter(item => item.rarity != null && item.rarity < 1).length,
    hunterPoints: unlockedItems.reduce((sum, item) => sum + rarityWeight(item.rarity), 0) + (perfect ? 25 : 0) + (platinum ? 20 : 0),
    recent: byDate.slice(0, 5).map(slimItem),
    rarest: unlockedItems.filter(item => item.rarity != null).sort((a, b) => a.rarity - b.rarity).slice(0, 3).map(slimItem),
    lastUnlockAt: byDate[0]?.at || null,
  };
}

/* ───────── Steam ───────── */

// Per-app lookups (schemas, unlock rates, trophy lists) can be large and there are thousands of apps:
// keep them in a small LRU instead of the global cache, which never evicts.
const LRU_MAX = 400;
const lru = new Map(); // key -> { value, expiresAt }
const lruInFlight = new Map();

function lruGet(key) {
  const entry = lru.get(key);
  if (!entry) return undefined;
  lru.delete(key);
  if (Date.now() > entry.expiresAt) return undefined;
  lru.set(key, entry);
  return entry.value;
}

function lruSet(key, value, ttlSeconds) {
  lru.delete(key);
  lru.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  while (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
}

/** Cached per-app lookup: 4xx (e.g. app has no stats) is cached as empty, network / 5xx / 429 errors are not cached. */
async function cachedAppLookup(cacheKey, ttl, load) {
  const hit = lruGet(cacheKey);
  if (hit !== undefined) return hit;
  if (lruInFlight.has(cacheKey)) return lruInFlight.get(cacheKey);
  const promise = load()
    .then(value => { lruSet(cacheKey, value, ttl); return value; })
    .catch(error => {
      if (error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 429) {
        lruSet(cacheKey, {}, ttl);
        return {};
      }
      if (error.code === 'rate_limited' || error.code === 'invalid_credentials') throw error;
      return {};
    })
    .finally(() => lruInFlight.delete(cacheKey));
  lruInFlight.set(cacheKey, promise);
  return promise;
}

function steamSchema(appid, key) {
  return cachedAppLookup(`steam:schema:${appid}`, 7 * DAY, async () => {
    const data = await getJson(`${STEAM_API}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${appid}&l=english`, {}, 'steam schema');
    const list = data?.game?.availableGameStats?.achievements || [];
    return Object.fromEntries(list.slice(0, MAX_ITEMS).map(a => [a.name, {
      displayName: clip(a.displayName, 120),
      description: clip(a.description, 240),
      icon: httpsUrl(a.icon),
      icongray: httpsUrl(a.icongray),
      hidden: a.hidden,
    }]));
  });
}

function steamPercentages(appid) {
  return cachedAppLookup(`steam:pct:${appid}`, DAY, async () => {
    const data = await getJson(`${STEAM_API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`, {}, 'steam percentages');
    const list = data?.achievementpercentages?.achievements || [];
    return Object.fromEntries(list.map(a => [a.name, percent(a.percent)]));
  });
}

/** Public achievement list of a Steam app (schema + global unlock rates), for the game page. */
export async function steamAppAchievements(appid, key) {
  const [schema, pct] = await Promise.all([steamSchema(appid, key), steamPercentages(appid)]);
  return Object.entries(schema).map(([id, a]) => ({
    id: clip(id, 120),
    name: a.displayName || clip(id, 120),
    desc: a.description,
    icon: a.icon,
    iconLocked: a.icongray,
    hidden: a.hidden === 1,
    rarity: pct[id] ?? null,
  }));
}

export const steam = {
  platform: 'steam',

  async titles({ steamId, key }) {
    const data = await getJson(
      `${STEAM_API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`,
      {}, 'steam owned games',
    ).catch(error => {
      if (error.upstreamStatus === 401 || error.upstreamStatus === 403) throw httpError(503, 'not_configured', 'Steam API key rejected');
      throw error;
    });
    const response = data?.response || {};
    if (response.game_count === undefined && !Array.isArray(response.games)) throw httpError(403, 'private', 'Steam game details are private');
    const titles = (response.games || [])
      // Only games with stats can have achievements, and an unplayed game has nothing unlocked
      .filter(game => game?.appid && game.has_community_visible_stats && game.playtime_forever > 0)
      .map(game => ({
        gameKey: `steam-${game.appid}`,
        platform: 'steam',
        sourceId: String(game.appid),
        name: clip(game.name, 160) || `App ${game.appid}`,
        image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`,
        playtimeHours: Math.round((game.playtime_forever / 60) * 10) / 10,
        lastPlayed: isoDate(game.rtime_last_played),
        fingerprint: `${game.playtime_forever}:${game.rtime_last_played || 0}`,
        detailed: true,
      }));
    const totalHours = Math.round((response.games || []).reduce((sum, g) => sum + (g.playtime_forever || 0), 0) / 6) / 10;
    return { account: { steamId, gameCount: response.game_count ?? titles.length, totalHours }, titles };
  },

  async details({ steamId, key }, title) {
    const appid = title.sourceId;
    let data;
    try {
      data = await getJson(`${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}&appid=${appid}&l=english`, {}, 'steam player achievements');
    } catch (error) {
      // 400 "Requested app has no stats", 403 private profile
      if (error.upstreamStatus === 400) return [];
      if (error.upstreamStatus === 403) throw httpError(403, 'private', 'Steam game details are private');
      throw error;
    }
    const list = data?.playerstats?.success ? data.playerstats.achievements || [] : [];
    if (!list.length) return [];
    const [schema, pct] = await Promise.all([steamSchema(appid, key), steamPercentages(appid)]);
    return list.slice(0, MAX_ITEMS).map(a => {
      const meta = schema[a.apiname] || {};
      const unlocked = a.achieved === 1;
      return {
        id: clip(a.apiname, 120),
        name: clip(a.name || meta.displayName, 120) || clip(a.apiname, 120),
        desc: clip(a.description || meta.description, 240),
        icon: httpsUrl(unlocked ? meta.icon : meta.icongray || meta.icon),
        unlocked,
        at: unlocked ? isoDate(a.unlocktime) : null,
        rarity: pct[a.apiname] ?? null,
        hidden: meta.hidden === 1,
      };
    });
  },
};

/* ───────── Xbox (OpenXBL) ───────── */

const xblHeaders = apiKey => ({ 'X-Authorization': apiKey, 'Accept-Language': 'en-US' });

export const xbox = {
  platform: 'xbox',

  async account(apiKey) {
    const data = await getJson(`${XBL_API}/account`, { headers: xblHeaders(apiKey) }, 'xbox account');
    const settings = data?.profileUsers?.[0]?.settings || [];
    const setting = id => settings.find(s => s.id === id)?.value;
    return {
      xuid: data?.profileUsers?.[0]?.id ? String(data.profileUsers[0].id) : null,
      gamertag: clip(setting('Gamertag') || setting('ModernGamertag'), 40) || null,
      gamerscore: Number(setting('Gamerscore')) || 0,
      avatar: httpsUrl(setting('GameDisplayPicRaw')),
    };
  },

  async titles(apiKey) {
    const data = await getJson(`${XBL_API}/achievements`, { headers: xblHeaders(apiKey) }, 'xbox achievements');
    const body = data?.content || data;
    const titles = (Array.isArray(body?.titles) ? body.titles : [])
      .filter(t => t?.name && t.achievement?.totalAchievements > 0)
      .map(t => {
        const a = t.achievement;
        return {
          gameKey: `xbox-${safeId(t.titleId)}`,
          platform: 'xbox',
          sourceId: safeId(t.titleId),
          name: clip(t.name, 160),
          image: httpsUrl(t.displayImage),
          playtimeHours: null,
          lastPlayed: isoDate(t.titleHistory?.lastTimePlayed),
          fingerprint: `${a.currentAchievements}:${a.currentGamerscore}:${a.totalAchievements}`,
          // Xbox 360 titles (sourceVersion 1) only have the counts through this API
          detailed: a.sourceVersion !== 1 && a.currentAchievements > 0,
          unlocked: a.currentAchievements || 0,
          total: a.totalAchievements || 0,
          points: a.currentGamerscore || 0,
          pointsTotal: a.totalGamerscore || 0,
        };
      })
      .filter(t => t.sourceId);
    return { account: { xuid: body?.xuid ? String(body.xuid) : null }, titles };
  },

  async details(apiKey, title, xuid) {
    if (!xuid) return null;
    const data = await getJson(`${XBL_API}/achievements/player/${encodeURIComponent(xuid)}/${encodeURIComponent(title.sourceId)}`, { headers: xblHeaders(apiKey) }, 'xbox title achievements');
    const body = data?.content || data;
    const list = Array.isArray(body?.achievements) ? body.achievements : [];
    return list.slice(0, MAX_ITEMS).map(a => {
      const unlocked = a.progressState === 'Achieved';
      const gs = Number((a.rewards || []).find(r => r.type === 'Gamerscore')?.value) || 0;
      return {
        id: clip(String(a.id ?? a.name), 120),
        name: clip(a.name, 120),
        desc: clip(unlocked ? a.description : a.lockedDescription || a.description, 240),
        icon: httpsUrl((a.mediaAssets || []).find(m => m.type === 'Icon')?.url || a.mediaAssets?.[0]?.url),
        unlocked,
        at: unlocked ? isoDate(a.progression?.timeUnlocked) : null,
        rarity: percent(a.rarity?.currentPercentage),
        hidden: Boolean(a.isSecret),
        gs,
      };
    });
  },
};

/* ───────── PlayStation ───────── */

const psnHeaders = token => ({ Authorization: `Bearer ${token}`, 'Accept-Language': 'en-US' });
const sumTrophies = t => (t?.bronze || 0) + (t?.silver || 0) + (t?.gold || 0) + (t?.platinum || 0);
const trophyPoints = t => Object.entries(PSN_TROPHY_POINTS).reduce((sum, [type, points]) => sum + (t?.[type] || 0) * points, 0);

function psnDefinitions(token, id, svc) {
  return cachedAppLookup(`psn:defs:${id}:${svc}`, 7 * DAY, async () => {
    const data = await getJson(`${PSN_API}/npCommunicationIds/${encodeURIComponent(id)}/trophyGroups/all/trophies?npServiceName=${svc}`, { headers: psnHeaders(token) }, 'psn trophy list');
    return Object.fromEntries((data?.trophies || []).slice(0, MAX_ITEMS).map(t => [t.trophyId, {
      trophyName: clip(t.trophyName, 120),
      trophyDetail: clip(t.trophyDetail, 240),
      trophyIconUrl: httpsUrl(t.trophyIconUrl),
      trophyHidden: t.trophyHidden,
    }]));
  });
}

export const psn = {
  platform: 'psn',
  token: psnAccessToken,

  async summary(token) {
    const data = await getJson(`${PSN_API}/users/me/trophySummary`, { headers: psnHeaders(token) }, 'psn trophy summary').catch(() => null);
    return data ? { level: Number(data.trophyLevel) || null, levelProgress: Number(data.progress) || 0, tier: Number(data.tier) || null } : null;
  },

  async titles(token) {
    const titles = [];
    for (let offset = 0; offset < 4000;) {
      const data = await getJson(`${PSN_API}/users/me/trophyTitles?limit=800&offset=${offset}`, { headers: psnHeaders(token) }, 'psn trophy titles');
      const list = Array.isArray(data?.trophyTitles) ? data.trophyTitles : [];
      for (const t of list) {
        if (!t?.npCommunicationId || !t.trophyTitleName) continue;
        const unlocked = sumTrophies(t.earnedTrophies);
        titles.push({
          gameKey: `psn-${safeId(t.npCommunicationId)}`,
          platform: 'psn',
          sourceId: safeId(t.npCommunicationId),
          svc: t.npServiceName === 'trophy2' ? 'trophy2' : 'trophy',
          name: clip(t.trophyTitleName, 160),
          image: httpsUrl(t.trophyTitleIconUrl),
          device: clip(t.trophyTitlePlatform, 30) || null,
          playtimeHours: null,
          lastPlayed: isoDate(t.lastUpdatedDateTime),
          fingerprint: `${t.progress}:${unlocked}:${t.lastUpdatedDateTime || ''}`,
          detailed: unlocked > 0,
          unlocked,
          total: sumTrophies(t.definedTrophies),
          points: trophyPoints(t.earnedTrophies),
          pointsTotal: trophyPoints(t.definedTrophies),
          trophies: {
            platinum: t.earnedTrophies?.platinum || 0,
            gold: t.earnedTrophies?.gold || 0,
            silver: t.earnedTrophies?.silver || 0,
            bronze: t.earnedTrophies?.bronze || 0,
          },
        });
      }
      if (data?.nextOffset == null || !list.length) break;
      offset = data.nextOffset;
    }
    return { account: null, titles };
  },

  async details(token, title) {
    const [earned, defs] = await Promise.all([
      getJson(`${PSN_API}/users/me/npCommunicationIds/${encodeURIComponent(title.sourceId)}/trophyGroups/all/trophies?npServiceName=${title.svc}`, { headers: psnHeaders(token) }, 'psn earned trophies'),
      psnDefinitions(token, title.sourceId, title.svc),
    ]);
    return (earned?.trophies || []).slice(0, MAX_ITEMS).map(t => {
      const def = defs[t.trophyId] || {};
      const unlocked = Boolean(t.earned);
      return {
        id: String(t.trophyId),
        name: clip(def.trophyName, 120) || `#${t.trophyId}`,
        desc: clip(def.trophyDetail, 240),
        icon: httpsUrl(def.trophyIconUrl),
        unlocked,
        at: unlocked ? isoDate(t.earnedDateTime) : null,
        rarity: percent(t.trophyEarnedRate),
        hidden: Boolean(def.trophyHidden ?? t.trophyHidden),
        type: ['platinum', 'gold', 'silver', 'bronze'].includes(t.trophyType) ? t.trophyType : 'bronze',
      };
    });
  },
};
