// Game library: Steam owned-games import.
//
//   GET /steam/owned?profile=<steamid64 | vanity name | profile URL>
//     -> { steamId, games: [{ appid, name, playtimeHours, lastPlayed, image }] }
//
// Needs STEAM_API_KEY (ISteamUser/ResolveVanityURL + IPlayerService/GetOwnedGames).
// The keyless XML games list (steamcommunity.com/.../games?xml=1) now redirects to the
// Steam login page (tested 2026-09), so without a key the route answers 503 { configured:false }.
// Errors: 400 invalid_profile, 404 not_found, 403 private (profile or "Game details" not public).

const CACHE_TTL = 30 * 60; // seconds
const STEAM_API = 'https://api.steampowered.com';
const MAX_GAMES = 5000;

const steamImage = appid => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;

function httpError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.extra = extra;
  return error;
}

/** Input -> { steamId } | { vanity } | null */
export function parseSteamProfile(input) {
  const text = String(input || '').trim().slice(0, 200);
  if (!text) return null;
  if (/^7656119\d{10}$/.test(text)) return { steamId: text };
  const url = /steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)/i.exec(text);
  if (url) {
    if (url[1].toLowerCase() === 'profiles') return /^7656119\d{10}$/.test(url[2]) ? { steamId: url[2] } : null;
    return /^[A-Za-z0-9_-]{2,64}$/.test(url[2]) ? { vanity: url[2] } : null;
  }
  if (/^[A-Za-z0-9_-]{2,64}$/.test(text)) return { vanity: text };
  return null;
}

export default function register(app, ctx) {
  const { cache, fetchAPI } = ctx;
  const inFlight = new Map();

  async function resolveSteamId(parsed, key) {
    if (parsed.steamId) return parsed.steamId;
    const data = await fetchAPI(
      `${STEAM_API}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(parsed.vanity)}`,
      {}, 12000,
    );
    const steamId = data?.response?.success === 1 ? data.response.steamid : null;
    if (!steamId) throw httpError(404, 'not_found', 'Steam profile not found');
    return steamId;
  }

  async function loadOwned(parsed, key) {
    const steamId = await resolveSteamId(parsed, key);
    const cacheKey = `library:steam:owned:${steamId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = await fetchAPI(
      `${STEAM_API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`,
      {}, 15000,
    );
    const response = data?.response || {};
    // A private profile / private "Game details" returns an empty response object
    if (response.game_count === undefined && !Array.isArray(response.games)) {
      throw httpError(403, 'private', 'Steam game details are private', { steamId });
    }
    const games = (response.games || [])
      .filter(game => game?.appid)
      .slice(0, MAX_GAMES)
      .map(game => ({
        appid: game.appid,
        name: String(game.name || `App ${game.appid}`).slice(0, 200),
        playtimeHours: Math.round(((game.playtime_forever || 0) / 60) * 10) / 10,
        lastPlayed: game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null,
        image: steamImage(game.appid),
      }))
      .sort((a, b) => b.playtimeHours - a.playtimeHours);

    const result = { steamId, gameCount: games.length, games };
    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  app.get('/steam/owned', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = parseSteamProfile(req.query.profile);
    if (!parsed) return res.status(400).json({ error: 'Invalid Steam profile', code: 'invalid_profile' });

    const key = process.env.STEAM_API_KEY;
    if (!key) {
      return res.status(503).json({ configured: false, code: 'not_configured', error: 'Steam import is not configured on the server' });
    }

    const inputKey = parsed.steamId || `vanity:${parsed.vanity.toLowerCase()}`;
    const cached = cache.get(`library:steam:input:${inputKey}`);
    if (cached) return res.json(cached);

    try {
      let promise = inFlight.get(inputKey);
      if (!promise) {
        promise = loadOwned(parsed, key).finally(() => inFlight.delete(inputKey));
        inFlight.set(inputKey, promise);
      }
      const result = await promise;
      cache.set(`library:steam:input:${inputKey}`, result, CACHE_TTL);
      res.json(result);
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
      }
      console.error('Steam owned games failed:', error.message);
      // Steam answers 401/403 for an invalid key, 429/5xx when it is overloaded
      res.status(502).json({ error: 'Steam is not responding, try again later', code: 'upstream' });
    }
  });
}
