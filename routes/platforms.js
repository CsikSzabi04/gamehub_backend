// Game library import from Xbox and PlayStation (Steam lives in routes/library.js).
//
//   POST /xbox/titles  { apiKey }  -> OpenXBL personal API key (https://xbl.io, sign in with Xbox)
//   POST /psn/titles   { npsso }   -> PlayStation NPSSO token (https://ca.account.sony.com/api/v1/ssocookie)
//
// Credentials are only used for this one request: never stored or logged.
// Response: { account, games: [{ id, name, image, platform, playtimeHours, lastPlayed }] }

const TIMEOUT = 20000;

// 20 imports per IP per 10 minutes
const hits = new Map();
function rateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 20;
}

export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const fail = (res, status, code, error) => res.status(status).json({ code, error });

/* ---------------- Xbox (OpenXBL) ---------------- */

const XBOX_DEVICES = { XboxSeries: 'xbox-series', XboxOne: 'xbox-one', Xbox360: 'xbox-360', PC: 'pc', Win32: 'pc' };

async function xboxTitles(apiKey) {
  const res = await fetchWithTimeout('https://xbl.io/api/v2/player/titleHistory', {
    headers: { 'X-Authorization': apiKey, Accept: 'application/json', 'Accept-Language': 'en-US' },
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Invalid OpenXBL key'), { status: 401, code: 'invalid_credentials' });
  if (res.status === 429) throw Object.assign(new Error('OpenXBL rate limit'), { status: 429, code: 'rate_limited' });
  if (!res.ok) throw Object.assign(new Error(`OpenXBL error ${res.status}`), { status: 502, code: 'upstream' });
  const data = await res.json();
  const body = data?.content || data;
  const titles = Array.isArray(body?.titles) ? body.titles : [];
  const games = titles
    .filter(t => t?.name && (!t.type || t.type === 'Game'))
    .map(t => {
      const device = (t.devices || []).map(d => XBOX_DEVICES[d]).find(Boolean) || 'xbox';
      return {
        id: String(t.titleId || t.pfn || t.name).replace(/[^A-Za-z0-9_]/g, '').slice(0, 60),
        name: String(t.name).slice(0, 160),
        image: typeof t.displayImage === 'string' && t.displayImage.startsWith('http') ? t.displayImage.replace(/^http:/, 'https:') : null,
        platform: device,
        playtimeHours: null,
        lastPlayed: t.titleHistory?.lastTimePlayed || null,
        achievements: t.achievement?.currentAchievements ?? null,
      };
    })
    .filter(g => g.id);
  return { account: body?.xuid ? { xuid: String(body.xuid) } : null, games };
}

/* ---------------- PlayStation (NPSSO -> OAuth -> gamelist) ---------------- */

// Public client of the PlayStation App (same values the open-source psn-api library uses)
const PSN_CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const PSN_BASIC = 'MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const PSN_REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';

/** Raw input -> OpenXBL key, or '' when malformed. */
export function cleanXboxKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9-]{16,100}$/.test(apiKey) ? apiKey : '';
}

/** Raw input (token or Sony's whole {"npsso":"..."} JSON) -> NPSSO, or '' when malformed. */
export function cleanNpsso(value) {
  let npsso = typeof value === 'string' ? value.trim() : '';
  const fromJson = /"npsso"\s*:\s*"([^"]+)"/.exec(npsso);
  if (fromJson) npsso = fromJson[1];
  return /^[A-Za-z0-9]{40,100}$/.test(npsso) ? npsso : '';
}

export async function psnAccessToken(npsso) {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: PSN_CLIENT_ID,
    redirect_uri: PSN_REDIRECT,
    response_type: 'code',
    scope: 'psn:mobile.v2.core psn:clientapp',
  });
  const authorize = await fetchWithTimeout(`https://ca.account.sony.com/api/authz/v3/oauth/authorize?${params}`, {
    headers: { Cookie: `npsso=${npsso}` },
    redirect: 'manual',
  });
  const location = authorize.headers.get('location') || '';
  const code = /[?&]code=([^&]+)/.exec(location)?.[1];
  if (!code) throw Object.assign(new Error('Invalid NPSSO'), { status: 401, code: 'invalid_credentials' });

  const tokenRes = await fetchWithTimeout('https://ca.account.sony.com/api/authz/v3/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${PSN_BASIC}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: decodeURIComponent(code), redirect_uri: PSN_REDIRECT, grant_type: 'authorization_code', token_format: 'jwt' }),
  });
  if (!tokenRes.ok) throw Object.assign(new Error(`PSN token error ${tokenRes.status}`), { status: 401, code: 'invalid_credentials' });
  const token = await tokenRes.json();
  if (!token?.access_token) throw Object.assign(new Error('PSN token missing'), { status: 401, code: 'invalid_credentials' });
  return token.access_token;
}

/** "PT228H56M33S" -> 229.0 */
function isoDurationHours(value) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value || ''));
  if (!m) return null;
  const hours = Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60 + Number(m[4] || 0) / 3600;
  return Math.round(hours * 10) / 10;
}

async function psnTitles(npsso) {
  const token = await psnAccessToken(npsso);
  const games = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const res = await fetchWithTimeout(`https://m.np.playstation.com/api/gamelist/v2/users/me/titles?categories=ps4_game,ps5_native_game&limit=200&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw Object.assign(new Error(`PSN gamelist error ${res.status}`), { status: 502, code: 'upstream' });
    const data = await res.json();
    const titles = Array.isArray(data?.titles) ? data.titles : [];
    for (const t of titles) {
      if (!t?.name) continue;
      games.push({
        id: String(t.titleId || t.concept?.id || t.name).replace(/[^A-Za-z0-9_]/g, '').slice(0, 60),
        name: String(t.localizedName || t.name).slice(0, 160),
        image: typeof (t.localizedImageUrl || t.imageUrl) === 'string' ? (t.localizedImageUrl || t.imageUrl) : null,
        platform: t.category === 'ps5_native_game' ? 'ps5' : 'ps4',
        playtimeHours: isoDurationHours(t.playDuration),
        lastPlayed: t.lastPlayedDateTime || null,
      });
    }
    if (titles.length < 200 || (data?.totalItemCount != null && offset + 200 >= data.totalItemCount)) break;
  }
  return { account: null, games };
}

/* ---------------- Routes ---------------- */

export default function register(app) {
  app.post('/xbox/titles', async (req, res) => {
    if (rateLimited(req)) return fail(res, 429, 'rate_limited', 'Too many imports, try again later');
    const apiKey = cleanXboxKey(req.body?.apiKey);
    if (!apiKey) return fail(res, 400, 'invalid_input', 'Missing or malformed OpenXBL API key');
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await xboxTitles(apiKey));
    } catch (error) {
      if (!error.code) console.error('xbox import:', error.message);
      fail(res, error.status || 502, error.code || 'upstream', error.name === 'AbortError' ? 'Xbox did not answer in time' : error.message);
    }
  });

  app.post('/psn/titles', async (req, res) => {
    if (rateLimited(req)) return fail(res, 429, 'rate_limited', 'Too many imports, try again later');
    const npsso = cleanNpsso(req.body?.npsso);
    if (!npsso) return fail(res, 400, 'invalid_input', 'Missing or malformed NPSSO token');
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await psnTitles(npsso));
    } catch (error) {
      if (!error.code) console.error('psn import:', error.message);
      fail(res, error.status || 502, error.code || 'upstream', error.name === 'AbortError' ? 'PlayStation did not answer in time' : error.message);
    }
  });
}
