// Achievements & trophies from Steam, Xbox (OpenXBL) and PlayStation, synced into Firestore.
//
//   GET  /platforms/config                          -> { steam, autoSync }  what the server can do
//   POST /platforms/connect     (auth) { platform: 'xbox'|'psn', credential, remember? }
//        validates the key, stores it encrypted (remember, default true) and starts a sync -> 202
//   POST /platforms/sync        (auth) { platform, credential? }   starts a sync -> 202 (409 running, 429 cooldown)
//   POST /platforms/disconnect  (auth) { platform, removeData? }   forgets the key, optionally deletes the data
//   GET  /steam/achievements/:appid                  public achievement list + global unlock rates (game page)
//
// Firestore (written here with the Admin SDK, clients only read):
//   users/{uid}/achievements/{gameKey}      per-game summary: counts, points, recent / rarest unlocks, nameKey
//   users/{uid}/achievementItems/{gameKey}  { items: [{ id, name, desc, icon, unlocked, at, rarity, hidden, type?, gs? }] }
//   users/{uid}.achievementStats             totals over every platform (+ recent / rarest lists)
//   users/{uid}.platformSync.{platform}      { status, done, total, lastSyncAt, error, autoSync, partial, ...account }
//   platformSecrets/{uid}                    encrypted keys (lib/secrets.js)
//
// Job "achievementSync" (hourly): re-syncs a few users whose last sync is older than 12 hours.
// Only titles whose counts changed since the last sync are fetched in detail, with a per-run budget
// (OpenXBL's free tier allows ~150 requests / hour), so big libraries fill in over a few runs.
import { steam, xbox, psn, summarize, steamAppAchievements } from '../lib/achievementSources.js';
import { saveSecret, readSecret, deleteSecret, secretsReady } from '../lib/secrets.js';
import { cleanXboxKey, cleanNpsso } from './platforms.js';

const PLATFORMS = ['steam', 'xbox', 'psn'];
const SOURCES = { steam, xbox, psn };
const DETAIL_BUDGET = { steam: 300, xbox: 60, psn: 150 };
const CONCURRENCY = { steam: 4, xbox: 2, psn: 3 };
const FLUSH_GAMES = 10;
const FLUSH_BYTES = 3_000_000;
const ITEMS_DOC_MAX = 900_000;
const MANUAL_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_EVERY_MS = 12 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;
const JOB_MAX_SYNCS = 4;
const JOB_BUDGET_MS = 15 * 60 * 1000;

const PLATFORM_NAMES = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation' };

const fail = (res, status, code, error) => res.status(status).json({ code, error });
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Same idea as the frontend normalizeTitle, minus PlayStation's "Trophies" / platform suffixes. */
export function titleKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(trophies|trophy set)\b/g, '')
    .replace(/\((ps3|ps4|ps5|ps vita|psvita)\)/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 120);
}

async function pool(list, size, worker) {
  let index = 0;
  let failure = null;
  const run = async () => {
    while (!failure && index < list.length) {
      const item = list[index++];
      try {
        await worker(item);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
  if (failure) throw failure;
}

/** Items array that fits in one Firestore document (drops descriptions, then trims, if needed). */
function fitItems(items) {
  if (JSON.stringify(items).length <= ITEMS_DOC_MAX) return items;
  const slim = items.map(({ desc, ...rest }) => rest);
  while (slim.length && JSON.stringify(slim).length > ITEMS_DOC_MAX) slim.length = Math.floor(slim.length * 0.8);
  return slim;
}

export default function register(app, ctx) {
  const { getDb, requireUser, registerJob, sendToUser, FieldValue, cache } = ctx;
  const running = new Map(); // `${uid}:${platform}` -> Promise
  const lastManual = new Map();

  const userRef = uid => getDb().collection('users').doc(uid);

  function setStatus(uid, platform, patch) {
    return userRef(uid).set({ platformSync: { [platform]: patch } }, { merge: true }).catch(error => {
      console.error('platformSync status write failed:', error.message);
    });
  }

  /* ───────── Totals over every platform ───────── */

  async function recomputeStats(uid) {
    const snap = await userRef(uid).collection('achievements')
      .select('gameKey', 'platform', 'name', 'image', 'unlocked', 'total', 'perfect', 'rare', 'ultraRare', 'hunterPoints', 'points', 'trophies', 'recent', 'rarest')
      .get();
    const empty = () => ({ unlocked: 0, total: 0, games: 0, perfect: 0, hunterPoints: 0 });
    const stats = {
      ...empty(),
      rare: 0,
      ultraRare: 0,
      gamerscore: 0,
      trophyPoints: 0,
      trophies: { platinum: 0, gold: 0, silver: 0, bronze: 0 },
      byPlatform: {},
      recent: [],
      rarest: [],
    };
    const recent = [];
    const rarest = [];
    for (const doc of snap.docs) {
      const g = doc.data();
      if (!g.total) continue;
      const platform = PLATFORMS.includes(g.platform) ? g.platform : 'steam';
      const bucket = stats.byPlatform[platform] || (stats.byPlatform[platform] = empty());
      for (const target of [stats, bucket]) {
        target.unlocked += g.unlocked || 0;
        target.total += g.total || 0;
        target.games += g.unlocked > 0 ? 1 : 0;
        target.perfect += g.perfect ? 1 : 0;
        target.hunterPoints += g.hunterPoints || 0;
      }
      stats.rare += g.rare || 0;
      stats.ultraRare += g.ultraRare || 0;
      if (platform === 'xbox') stats.gamerscore += g.points || 0;
      if (platform === 'psn') {
        stats.trophyPoints += g.points || 0;
        for (const type of Object.keys(stats.trophies)) stats.trophies[type] += g.trophies?.[type] || 0;
      }
      const game = { gameKey: doc.id, game: g.name || '', platform };
      for (const item of g.recent || []) recent.push({ ...item, ...game });
      for (const item of g.rarest || []) rarest.push({ ...item, ...game, image: g.image || null });
    }
    stats.recent = recent.filter(i => i.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24);
    stats.rarest = rarest.sort((a, b) => a.rarity - b.rarity).slice(0, 12);
    stats.updatedAt = new Date().toISOString();
    await userRef(uid).update({ achievementStats: stats });
    return stats;
  }

  /* ───────── One sync run ───────── */

  async function performSync(uid, platform, credential) {
    const db = getDb();
    const ref = userRef(uid);
    const startedAt = new Date().toISOString();
    await setStatus(uid, platform, { status: 'running', startedAt, done: 0, total: 0, error: null });

    let cred;
    if (platform === 'steam') {
      const key = process.env.STEAM_API_KEY;
      if (!key) throw httpError(503, 'not_configured', 'Steam API key missing on the server');
      const steamId = (await ref.get()).data()?.steamId;
      if (!/^7656119\d{10}$/.test(String(steamId || ''))) throw httpError(400, 'no_account', 'No Steam account linked');
      cred = { steamId, key };
    } else {
      const secret = credential || await readSecret(uid, platform);
      if (!secret) throw httpError(400, 'no_credentials', 'No stored key');
      cred = platform === 'psn' ? await psn.token(secret) : secret;
    }

    const source = SOURCES[platform];
    const { account, titles } = await source.titles(cred);
    const extra = {};
    let xuid = account?.xuid || null;
    if (platform === 'xbox') {
      const info = await xbox.account(cred).catch(() => null);
      if (info) {
        Object.assign(extra, { gamertag: info.gamertag, gamerscore: info.gamerscore, avatar: info.avatar });
        xuid = xuid || info.xuid;
      }
    }
    if (platform === 'psn') {
      const summary = await psn.summary(cred);
      if (summary) Object.assign(extra, { trophyLevel: summary.level, levelProgress: summary.levelProgress, tier: summary.tier });
    }
    if (platform === 'steam' && account) Object.assign(extra, { gameCount: account.gameCount, totalHours: account.totalHours });

    const achievementsCol = ref.collection('achievements');
    const itemsCol = ref.collection('achievementItems');
    const existingSnap = await achievementsCol.where('platform', '==', platform).select('fingerprint').get();
    const known = new Map(existingSnap.docs.map(d => [d.id, d.data().fingerprint]));
    const changed = titles
      .filter(t => known.get(t.gameKey) !== t.fingerprint)
      .sort((a, b) => (b.lastPlayed || '').localeCompare(a.lastPlayed || ''));

    let detailCalls = 0;
    let done = 0;
    let partial = false;
    let stop = false;
    let pending = [];
    let pendingBytes = 0;

    const flush = async () => {
      if (!pending.length) return;
      const chunk = pending;
      pending = [];
      pendingBytes = 0;
      const batch = db.batch();
      const now = FieldValue.serverTimestamp();
      for (const { title, items } of chunk) {
        batch.set(achievementsCol.doc(title.gameKey), {
          gameKey: title.gameKey,
          platform,
          sourceId: title.sourceId,
          name: title.name,
          nameKey: titleKey(title.name),
          image: title.image || null,
          device: title.device || null,
          playtimeHours: title.playtimeHours ?? null,
          lastPlayed: title.lastPlayed || null,
          fingerprint: title.fingerprint,
          points: platform === 'steam' ? null : title.points ?? null,
          pointsTotal: platform === 'steam' ? null : title.pointsTotal ?? null,
          trophies: title.trophies || null,
          ...summarize(title, items),
          updatedAt: now,
        });
        if (items && items.length) batch.set(itemsCol.doc(title.gameKey), { gameKey: title.gameKey, platform, items: fitItems(items), updatedAt: now });
      }
      await batch.commit();
    };

    await pool(changed, CONCURRENCY[platform], async title => {
      if (stop) return;
      let items = null;
      if (title.detailed) {
        if (detailCalls >= DETAIL_BUDGET[platform]) {
          partial = true; // fingerprint stays old, so the next run picks this title up
          return;
        }
        detailCalls++;
        try {
          items = platform === 'xbox' ? await xbox.details(cred, title, xuid) : await source.details(cred, title);
        } catch (error) {
          if (error.code === 'rate_limited') {
            partial = true;
            stop = true;
            return;
          }
          if (error.code === 'invalid_credentials' || error.code === 'private') throw error;
          console.error(`achievements ${platform} ${title.gameKey}:`, error.message);
          partial = true;
          return;
        }
      }
      pending.push({ title, items });
      pendingBytes += items ? JSON.stringify(items).length : 200;
      done++;
      if (done % 25 === 0) setStatus(uid, platform, { done, total: changed.length });
      if (pending.length >= FLUSH_GAMES || pendingBytes >= FLUSH_BYTES) await flush();
    });
    await flush();

    const stats = await recomputeStats(uid);
    const finishedAt = new Date().toISOString();
    await setStatus(uid, platform, {
      status: 'ok',
      done,
      total: changed.length,
      titles: titles.length,
      partial,
      error: null,
      lastSyncAt: finishedAt,
      ...extra,
    });
    return { titles: titles.length, updated: done, partial, unlocked: stats.unlocked };
  }

  /** Starts a sync unless one is already running for this user + platform. Never throws. */
  function startSync(uid, platform, credential, { auto = false } = {}) {
    const runKey = `${uid}:${platform}`;
    if (running.has(runKey)) return running.get(runKey);
    const promise = performSync(uid, platform, credential)
      .catch(async error => {
        const code = error.code || 'upstream';
        console.error(`achievement sync ${platform}:`, code, error.message);
        // errorDetail helps debugging from the Firestore console; it never contains credentials
        await setStatus(uid, platform, { status: 'error', error: code, errorDetail: String(error.message || '').slice(0, 200), lastErrorAt: new Date().toISOString() });
        // A stored key stopped working (PSN NPSSO expires after ~2 months): forget it and tell the user once
        if (code === 'invalid_credentials' && !credential && platform !== 'steam') {
          await deleteSecret(uid, platform);
          await setStatus(uid, platform, { autoSync: false });
          await sendToUser(uid, {
            type: 'system',
            title: `${PLATFORM_NAMES[platform]} connection expired`,
            body: 'Paste a new key on the Achievements page to keep your achievements in sync.',
            url: '/achievements',
            tag: `sync-${platform}`,
          }).catch(() => {});
        }
        if (auto && code === 'private' && platform === 'steam') await setStatus(uid, platform, { autoSync: false });
        return { error: code };
      })
      .finally(() => running.delete(runKey));
    running.set(runKey, promise);
    return promise;
  }

  /* ───────── Routes ───────── */

  app.get('/platforms/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ steam: Boolean(process.env.STEAM_API_KEY), autoSync: secretsReady() });
  });

  app.post('/platforms/connect', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    const platform = req.body?.platform;
    if (platform !== 'xbox' && platform !== 'psn') return fail(res, 400, 'invalid_input', 'Unknown platform');
    const credential = platform === 'xbox' ? cleanXboxKey(req.body?.credential) : cleanNpsso(req.body?.credential);
    if (!credential) return fail(res, 400, 'invalid_input', 'Missing or malformed key');

    let account = null;
    try {
      if (platform === 'xbox') account = await xbox.account(credential);
      else await psn.token(credential);
    } catch (error) {
      return fail(res, error.status || 502, error.code || 'upstream', error.name === 'AbortError' ? 'The platform did not answer in time' : error.message);
    }

    const remember = req.body?.remember !== false;
    let stored = false;
    if (remember) stored = await saveSecret(uid, platform, credential).catch(() => false);
    else await deleteSecret(uid, platform);
    await setStatus(uid, platform, { autoSync: stored, connectedAt: new Date().toISOString() });

    if (account?.gamertag) {
      const snap = await userRef(uid).get();
      if (!snap.data()?.gamingAccounts?.xbox) await userRef(uid).set({ gamingAccounts: { xbox: account.gamertag } }, { merge: true });
    }

    startSync(uid, platform, credential);
    lastManual.set(`${uid}:${platform}`, Date.now());
    res.status(202).json({ started: true, stored, account: account ? { gamertag: account.gamertag, gamerscore: account.gamerscore } : null });
  });

  app.post('/platforms/sync', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    const platform = req.body?.platform;
    if (!PLATFORMS.includes(platform)) return fail(res, 400, 'invalid_input', 'Unknown platform');
    const runKey = `${uid}:${platform}`;
    if (running.has(runKey)) return fail(res, 409, 'running', 'A sync is already running');
    if (Date.now() - (lastManual.get(runKey) || 0) < MANUAL_COOLDOWN_MS) return fail(res, 429, 'cooldown', 'Please wait a little before syncing again');

    let credential = null;
    if (platform === 'steam') {
      if (!process.env.STEAM_API_KEY) return fail(res, 503, 'not_configured', 'Steam API key missing on the server');
      const steamId = (await userRef(uid).get()).data()?.steamId;
      if (!/^7656119\d{10}$/.test(String(steamId || ''))) return fail(res, 400, 'no_account', 'Link your Steam profile first');
      await setStatus(uid, platform, { autoSync: true });
    } else if (req.body?.credential) {
      credential = platform === 'xbox' ? cleanXboxKey(req.body.credential) : cleanNpsso(req.body.credential);
      if (!credential) return fail(res, 400, 'invalid_input', 'Missing or malformed key');
    } else if (!(await readSecret(uid, platform))) {
      return fail(res, 400, 'no_credentials', 'No stored key, paste it again');
    }

    lastManual.set(runKey, Date.now());
    startSync(uid, platform, credential);
    res.status(202).json({ started: true });
  });

  app.post('/platforms/disconnect', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    const platform = req.body?.platform;
    if (!PLATFORMS.includes(platform)) return fail(res, 400, 'invalid_input', 'Unknown platform');
    try {
      if (platform !== 'steam') await deleteSecret(uid, platform);
      await userRef(uid).update({ [`platformSync.${platform}`]: FieldValue.delete() }).catch(() => {});
      if (req.body?.removeData) {
        const db = getDb();
        for (const name of ['achievements', 'achievementItems']) {
          const col = userRef(uid).collection(name);
          for (;;) {
            const snap = await col.where('platform', '==', platform).limit(400).select().get();
            if (snap.empty) break;
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            if (snap.size < 400) break;
          }
        }
        await recomputeStats(uid);
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('platform disconnect:', error.message);
      fail(res, 500, 'failed', 'Could not disconnect');
    }
  });

  app.get('/steam/achievements/:appid', async (req, res) => {
    const appid = String(req.params.appid || '');
    if (!/^\d{1,10}$/.test(appid)) return fail(res, 400, 'invalid_input', 'Invalid app id');
    const key = process.env.STEAM_API_KEY;
    if (!key) return fail(res, 503, 'not_configured', 'Steam API key missing on the server');
    try {
      const entry = await cache.swr(`steam:achievements:${appid}`, 12 * 60 * 60, async () => ({ appid: Number(appid), achievements: await steamAppAchievements(appid, key) }));
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' });
      res.send(entry.body);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      fail(res, 502, 'upstream', 'Steam is not responding');
    }
  });

  /* ───────── Auto-sync job ───────── */

  registerJob('achievementSync', 60 * 60 * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no db' };
    const now = Date.now();
    const due = sync => {
      if (!sync?.autoSync) return false;
      if (sync.status === 'running' && now - Date.parse(sync.startedAt || 0) < STALE_RUNNING_MS) return false;
      if (sync.status === 'error' && now - Date.parse(sync.lastErrorAt || 0) < ERROR_RETRY_MS) return false;
      return now - Date.parse(sync.lastSyncAt || 0) >= AUTO_EVERY_MS;
    };

    const candidates = [];
    for (const platform of PLATFORMS) {
      if (platform === 'steam' && !process.env.STEAM_API_KEY) continue;
      if (platform !== 'steam' && !secretsReady()) continue;
      const snap = await db.collection('users').where(`platformSync.${platform}.autoSync`, '==', true).select('platformSync').limit(500).get();
      for (const doc of snap.docs) {
        const sync = doc.data().platformSync?.[platform];
        if (due(sync)) candidates.push({ uid: doc.id, platform, last: Date.parse(sync.lastSyncAt || 0) || 0 });
      }
    }
    candidates.sort((a, b) => a.last - b.last);

    let synced = 0;
    const started = Date.now();
    for (const { uid, platform } of candidates.slice(0, JOB_MAX_SYNCS)) {
      if (Date.now() - started > JOB_BUDGET_MS) break;
      const result = await startSync(uid, platform, null, { auto: true });
      if (!result?.error) synced++;
    }
    return { due: candidates.length, synced };
  });
}
