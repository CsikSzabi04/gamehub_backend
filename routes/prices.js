// Price tracking & price alerts.
//
//   GET /price/steam/:appid?cc=hu   Steam price in a region (+ IsThereAnyDeal history/lows when ITAD_API_KEY is set)
//   GET /price/search?title=&cc=    IsThereAnyDeal only: best current deal + historical low for non-Steam games
//   job priceAlerts (every 6h)      checks users/{uid}/priceAlerts/{gameKey} and notifies when the target is reached
//
// Env: ITAD_API_KEY (optional). Firestore via Firebase Admin (optional, the job skips without it).

const env = process.env;
const HOUR = 3600;
const ITAD = 'https://api.isthereanydeal.com';
const ITAD_STEAM_SHOP = 61;

export const PRICE_REGIONS = ['hu', 'us', 'gb', 'de', 'at', 'fr', 'it', 'es', 'nl', 'pl', 'ro', 'cz', 'sk', 'se', 'dk', 'fi', 'no', 'ch', 'ca', 'au', 'br', 'tr', 'jp'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const itadReady = () => Boolean(env.ITAD_API_KEY);
const normCc = value => {
  const cc = String(value || 'hu').toLowerCase();
  return PRICE_REGIONS.includes(cc) ? cc : null;
};
const round2 = n => Math.round(Number(n) * 100) / 100;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/* ━━━━━━━━━━━━━━━━ STEAM ━━━━━━━━━━━━━━━━ */

const toCurrent = p => (p ? {
  final: round2(p.final / 100),
  initial: round2(p.initial / 100),
  discount: p.discount_percent || 0,
  formatted: p.final_formatted || null,
  currency: p.currency,
} : null);

/**
 * Steam prices for many appids in one request (appdetails accepts a list of appids with filters=price_overview).
 * @returns {Promise<Map<number, { success: boolean, price: object|null }>>}
 */
async function steamPrices(fetchAPI, appids, cc) {
  const data = await fetchAPI(`https://store.steampowered.com/api/appdetails?appids=${appids.join(',')}&cc=${cc}&filters=price_overview`, {}, 20000);
  const map = new Map();
  for (const appid of appids) {
    const entry = data?.[appid];
    map.set(Number(appid), { success: Boolean(entry?.success), price: toCurrent(entry?.data?.price_overview) });
  }
  return map;
}

/* ━━━━━━━━━━━━━━━━ ISTHEREANYDEAL ━━━━━━━━━━━━━━━━ */

const itadUrl = (path, params = {}) => `${ITAD}${path}?${new URLSearchParams({ key: env.ITAD_API_KEY, ...params })}`;

const itadPrice = (p, extra = {}) => (p?.price?.amount != null ? {
  amount: p.price.amount,
  currency: p.price.currency,
  shop: p.shop?.name || null,
  ...extra,
} : null);

async function itadOverview(fetchAPI, id, cc) {
  const data = await fetchAPI(itadUrl('/games/overview/v2', { country: cc.toUpperCase() }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([id]),
  });
  const entry = (data?.prices || []).find(p => p.id === id) || data?.prices?.[0];
  if (!entry) return { lowest: null, bestCurrent: null, page: null };
  return {
    lowest: itadPrice(entry.lowest, { date: entry.lowest?.timestamp || null }),
    bestCurrent: itadPrice(entry.current, { url: entry.current?.url || null, cut: entry.current?.cut || 0 }),
    page: entry.urls?.game || null,
  };
}

/** Price changes of the last year (Steam shop only when steamOnly), downsampled to <= 60 points. */
async function itadHistory(fetchAPI, id, cc, steamOnly) {
  const since = new Date(Date.now() - 365 * 24 * HOUR * 1000).toISOString();
  const params = { id, country: cc.toUpperCase(), since };
  if (steamOnly) params.shops = String(ITAD_STEAM_SHOP);
  const data = await fetchAPI(itadUrl('/games/history/v2', params));
  const points = (Array.isArray(data) ? data : [])
    .map(item => ({ t: Date.parse(item.timestamp), price: item.deal?.price?.amount }))
    .filter(p => Number.isFinite(p.t) && typeof p.price === 'number')
    .sort((a, b) => a.t - b.t);
  if (points.length <= 60) return points;
  const step = (points.length - 1) / 59;
  return Array.from({ length: 60 }, (_, i) => points[Math.round(i * step)]);
}

async function itadForSteam(fetchAPI, appid, cc) {
  const lookup = await fetchAPI(itadUrl('/games/lookup/v1', { appid: String(appid) }));
  const id = lookup?.found ? lookup.game?.id : null;
  if (!id) return null;
  const [overview, history] = await Promise.all([
    itadOverview(fetchAPI, id, cc).catch(() => ({ lowest: null, bestCurrent: null, page: null })),
    itadHistory(fetchAPI, id, cc, true).catch(() => []),
  ]);
  return { lowest: overview.lowest, bestCurrent: overview.bestCurrent, page: overview.page, history };
}

/* ━━━━━━━━━━━━━━━━ ROUTES ━━━━━━━━━━━━━━━━ */

export default function register(app, ctx) {
  const { fetchAPI, paramRoute, registerJob, getDb, sendToUser, Timestamp } = ctx;

  paramRoute('/price/steam/:appid', HOUR, req => {
    const appid = String(req.params.appid);
    const cc = normCc(req.query.cc);
    return /^\d{1,10}$/.test(appid) && cc ? `${appid}:${cc}` : null;
  }, async req => {
    const appid = Number(req.params.appid);
    const cc = normCc(req.query.cc);

    const [steam, itad] = await Promise.all([
      steamPrices(fetchAPI, [appid], cc),
      itadReady()
        ? itadForSteam(fetchAPI, appid, cc).catch(error => {
          console.error('ITAD price lookup failed:', error.message);
          return null;
        })
        : Promise.resolve(null),
    ]);
    const entry = steam.get(appid);
    if (!entry?.success) throw httpError(404, 'Game not available in this region');

    let isFree = false;
    if (!entry.price) {
      // No price_overview: free to play, or not purchasable yet
      const basic = await fetchAPI(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&filters=basic`).catch(() => null);
      isFree = Boolean(basic?.[appid]?.data?.is_free);
    }

    const { currency = null, ...current } = entry.price || {};
    return {
      appid,
      cc,
      currency: currency || itad?.lowest?.currency || null,
      isFree,
      current: entry.price ? current : null,
      itad,
      updatedAt: Date.now(),
    };
  });

  if (itadReady()) {
    paramRoute('/price/search', 3 * HOUR, req => {
      const title = String(req.query.title || '').trim().slice(0, 120);
      const cc = normCc(req.query.cc);
      return title && cc ? `${title.toLowerCase()}:${cc}` : null;
    }, async req => {
      const title = String(req.query.title).trim().slice(0, 120);
      const cc = normCc(req.query.cc);
      const results = await fetchAPI(itadUrl('/games/search/v1', { title, results: '5' }));
      const wanted = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const list = Array.isArray(results) ? results.filter(g => !g.type || g.type === 'game') : [];
      const game = list.find(g => String(g.title).toLowerCase().replace(/[^a-z0-9]/g, '') === wanted) || list[0];
      if (!game) return { found: false, cc, currency: null, itad: null, updatedAt: Date.now() };
      const overview = await itadOverview(fetchAPI, game.id, cc);
      return {
        found: true,
        cc,
        title: game.title,
        currency: overview.bestCurrent?.currency || overview.lowest?.currency || null,
        itad: { ...overview, history: [] },
        updatedAt: Date.now(),
      };
    });
  } else {
    app.get('/price/search', (req, res) => res.status(503).json({ configured: false, provider: 'itad' }));
  }

  /* ━━━━━━━━━━━━━━━━ JOB ━━━━━━━━━━━━━━━━ */

  registerJob('priceAlerts', 6 * HOUR * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no-db' };

    // collectionGroup without filters (no index needed), filtered in memory
    const snap = await db.collectionGroup('priceAlerts').get();
    const alerts = snap.docs
      .map(doc => ({ doc, uid: doc.ref.parent.parent?.id, data: doc.data() }))
      .filter(a => a.uid && a.data.active !== false && Number(a.data.steamAppId) > 0 && Number(a.data.targetPrice) > 0);

    const byCc = new Map();
    for (const alert of alerts) {
      const cc = normCc(alert.data.cc) || 'hu';
      if (!byCc.has(cc)) byCc.set(cc, []);
      byCc.get(cc).push(alert);
    }

    let checked = 0;
    let notified = 0;
    let failed = 0;
    for (const [cc, list] of byCc) {
      const appids = [...new Set(list.map(a => Number(a.data.steamAppId)))];
      const prices = new Map();
      for (let i = 0; i < appids.length; i += 50) {
        const chunk = appids.slice(i, i + 50);
        try {
          for (const [appid, value] of await steamPrices(fetchAPI, chunk, cc)) prices.set(appid, value);
        } catch (error) {
          failed += chunk.length;
          console.error(`priceAlerts: Steam lookup failed (${cc}):`, error.message);
        }
        await sleep(1500); // be polite to the store API
      }

      for (const { doc, uid, data } of list) {
        const price = prices.get(Number(data.steamAppId))?.price;
        if (!price) continue;
        checked++;
        const target = Number(data.targetPrice);
        const lastNotified = typeof data.lastNotifiedPrice === 'number' ? data.lastNotifiedPrice : null;
        const currencyOk = !data.currency || data.currency === price.currency;
        const update = { lastPrice: price.final, lastCheckedAt: Timestamp.now() };
        if (!data.currency) update.currency = price.currency;

        if (currencyOk && price.final <= target && (lastNotified == null || price.final < lastNotified)) {
          const name = String(data.name || `Steam app ${data.steamAppId}`).slice(0, 80);
          const priceText = price.formatted || `${price.final} ${price.currency}`;
          try {
            await sendToUser(uid, {
              type: 'priceAlerts',
              title: `Price drop: ${name}`,
              body: `Now ${priceText}${price.discount ? ` (-${price.discount}%)` : ''}, your target was ${target} ${price.currency}.`,
              url: `/game/steam/${data.steamAppId}`,
              image: typeof data.image === 'string' && /^https?:\/\//.test(data.image)
                ? data.image
                : `https://cdn.cloudflare.steamstatic.com/steam/apps/${data.steamAppId}/header.jpg`,
              tag: `price-${data.steamAppId}`,
            });
            notified++;
          } catch (error) {
            console.error('priceAlerts: notify failed:', error.message);
          }
          update.lastNotifiedPrice = price.final;
          update.triggeredAt = Timestamp.now();
        } else if (lastNotified != null && price.final > target) {
          // back above the target: the next drop notifies again
          update.lastNotifiedPrice = null;
        }
        await doc.ref.update(update).catch(error => console.error('priceAlerts: update failed:', error.message));
      }
    }
    return { alerts: alerts.length, checked, notified, failed };
  });
}
