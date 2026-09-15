// Subscription catalogs (Xbox Game Pass / EA Play) and "is this game on Game Pass?" checks.
//
//   GET /subscriptions/gamepass?list=console|pc|recent|leaving|coming|eaplay|essential
//     -> { list, title, market, count, items: [{ id, name, image, url }], updatedAt }
//   GET /subscriptions/check?title=<game name>
//     -> { title, matches: [{ list, title }], partial? }
//
// Sources (keyless, tested 2026-09):
//   list ids:  https://catalog.gamepass.com/sigls/v2?id=<siglId>&language=en-us&market=<MARKET>
//              -> [{ siglId, title, ... }, { id: "9N..." }, ...]
//   details:   https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<≤20 ids>&market=<MARKET>&languages=en-us
// PS Plus / Ubisoft+ have no keyless catalog API (only HTML pages), so the frontend links to them.
// Env (optional): GAMEPASS_MARKET (default HU; availability differs slightly per market, titles stay en-us)
//
// Job subscriptionChanges (12 h): new ids in the "recently added" list -> notify users that have the
// game (matched by normalized title) in users/{uid}/library with status wishlist or backlog.
// State: meta/subscriptions { recentIds: string[], updatedAt }

const MARKET = (process.env.GAMEPASS_MARKET || 'HU').toUpperCase();
const LIST_TTL = 12 * 60 * 60; // seconds
const PRODUCT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 20;
const CONCURRENCY = 3;

export const GAMEPASS_LISTS = {
  console: { title: 'Game Pass – Console', sigls: ['f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e'] },
  pc: { title: 'PC Game Pass', sigls: ['fdd9e2a7-0fee-49f6-ad69-4354098401ff'] },
  recent: { title: 'Recently added', sigls: ['f13cf6b4-57e6-4459-89df-6aec18cf0538'] },
  leaving: { title: 'Leaving soon', sigls: ['393f05bf-e596-4ef6-9487-6d4fa0eab987'] },
  coming: { title: 'Coming to Game Pass', sigls: ['095bda36-f5cd-43f2-9ee1-0a72f371fb96'] },
  eaplay: { title: 'EA Play', sigls: ['b8900d09-a491-44cc-916e-32b5acae621b', '1d33fbb9-b895-4732-a8ca-a55c8b99fa2c'] },
  essential: { title: 'Game Pass Essential', sigls: ['34031711-5a70-4196-bab7-45757dc2294e'] },
};

// Order used by /subscriptions/check (leaving first so the badge can warn)
const CHECK_ORDER = ['leaving', 'console', 'pc', 'coming', 'eaplay', 'essential', 'recent'];
const WARM_ORDER = ['recent', 'leaving', 'coming', 'console', 'pc', 'eaplay', 'essential'];

const EDITION_WORDS = [
  'standard', 'deluxe', 'digital deluxe', 'super deluxe', 'ultimate', 'premium', 'game of the year', 'goty',
  'definitive', 'complete', 'enhanced', 'anniversary', 'legendary', 'gold', 'special', 'collectors', "collector's",
  'digital', 'digital standard', 'launch', 'standard pc', 'windows 10', 'windows', 'pc', 'xbox', 'console',
  'xbox one', 'xbox series x\\|s',
];
const EDITION_RE = new RegExp(`[\\s:\\-–—]*\\b(${EDITION_WORDS.join('|')})\\s+edition\\s*$`, 'i');

/** "HALO: The Master Chief Collection™ (PC) – Standard Edition" -> "halothemasterchiefcollection" */
export function normalizeGameTitle(value) {
  let text = String(value || '').toLowerCase().replace(/[™®©]/g, '').replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = text
      .replace(/\s*[([](pc|windows( 10| 11)?|xbox( one| series x\|?s| series x and s)?|game preview|early access|preview)[)\]]\s*$/i, '')
      .replace(/[\s:\-–—]*\b(for|on)\s+(windows( 10| 11)?|pc|xbox( one| series x\|?s| series x and s)?)\s*$/i, '')
      .replace(/[\s:\-–—]+(windows( 10| 11)?|xbox series x\|?s|xbox one|game preview|cross-gen bundle|cross gen bundle)\s*$/i, '')
      .replace(EDITION_RE, '')
      .trim();
    if (text === before) break;
  }
  return text.replace(/[^a-z0-9]/g, '');
}

const imageUrl = (uri, width = 480) => (uri ? `${uri.startsWith('//') ? 'https:' : ''}${uri}?w=${width}` : null);

function pickImage(images = []) {
  const find = purpose => images.find(img => img.ImagePurpose === purpose)?.Uri;
  return imageUrl(find('TitledHeroArt') || find('SuperHeroArt') || find('BoxArt') || find('Poster') || images[0]?.Uri);
}

/** Runs async fn over items with limited concurrency. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export default function register(app, ctx) {
  const { cache, fetchAPI, getDb, registerJob, sendToUser } = ctx;
  const products = new Map(); // productId -> { item, ts }
  const indexes = new WeakMap(); // list value -> Set<normalized title>

  async function siglIds(siglId) {
    const data = await fetchAPI(`https://catalog.gamepass.com/sigls/v2?id=${siglId}&language=en-us&market=${MARKET}`, {}, 20000);
    if (!Array.isArray(data)) throw new Error('Unexpected Game Pass list response');
    return data.filter(entry => typeof entry?.id === 'string' && /^[0-9A-Z]{12}$/.test(entry.id)).map(entry => entry.id);
  }

  async function productDetails(ids) {
    const now = Date.now();
    const missing = ids.filter(id => !(products.get(id)?.ts > now - PRODUCT_TTL_MS));
    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
    await mapLimit(batches, CONCURRENCY, async batch => {
      try {
        const data = await fetchAPI(
          `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${batch.join(',')}&market=${MARKET}&languages=en-us`,
          {}, 25000,
        );
        for (const product of data?.Products || []) {
          const props = product.LocalizedProperties?.[0];
          if (!product.ProductId || !props?.ProductTitle) continue;
          products.set(product.ProductId, {
            ts: now,
            item: {
              id: product.ProductId,
              name: props.ProductTitle.trim(),
              image: pickImage(props.Images),
              url: `https://www.xbox.com/games/store/_/${product.ProductId}`,
            },
          });
        }
      } catch (error) {
        console.error('Game Pass details batch failed:', error.message);
      }
    });
    return ids.map(id => products.get(id)?.item).filter(Boolean);
  }

  async function loadList(list) {
    const def = GAMEPASS_LISTS[list];
    const idLists = await Promise.all(def.sigls.map(siglIds));
    const ids = [...new Set(idLists.flat())];
    const items = await productDetails(ids);
    if (ids.length && !items.length) throw new Error('Game Pass product details unavailable');
    return { list, title: def.title, market: MARKET, count: items.length, items, updatedAt: new Date().toISOString() };
  }

  const cacheKey = list => `subscriptions:gamepass:${list}`;
  const getList = list => cache.swr(cacheKey(list), LIST_TTL, () => loadList(list));

  function titleIndex(value) {
    let index = indexes.get(value);
    if (!index) {
      index = new Set(value.items.map(item => normalizeGameTitle(item.name)).filter(Boolean));
      indexes.set(value, index);
    }
    return index;
  }

  app.get('/subscriptions/gamepass', async (req, res) => {
    const list = String(req.query.list || 'console');
    if (!Object.hasOwn(GAMEPASS_LISTS, list)) return res.status(400).json({ error: 'Invalid list', lists: Object.keys(GAMEPASS_LISTS) });
    try {
      const entry = await getList(list);
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400' });
      res.send(entry.body);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      res.status(502).json({ error: error.message });
    }
  });

  app.get('/subscriptions/check', async (req, res) => {
    const title = String(req.query.title || '').trim().slice(0, 200);
    const normalized = normalizeGameTitle(title);
    if (!normalized) return res.status(400).json({ error: 'title is required' });

    // Loaded lists answer at once; lists that are not loaded yet get a short chance to finish
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, 8000, null); });
    const entries = await Promise.all(CHECK_ORDER.map(list => {
      const entry = cache.getEntry(cacheKey(list));
      if (entry) {
        if (Date.now() > entry.expiresAt) getList(list).catch(() => {});
        return entry;
      }
      return Promise.race([getList(list).catch(() => null), timeout]);
    }));
    clearTimeout(timer);

    const matches = [];
    let partial = false;
    entries.forEach((entry, i) => {
      if (!entry?.value) { partial = true; return; }
      const list = CHECK_ORDER[i];
      if (titleIndex(entry.value).has(normalized)) matches.push({ list, title: GAMEPASS_LISTS[list].title });
    });
    res.set('Cache-Control', partial ? 'no-store' : 'public, max-age=3600');
    res.json({ title, matches, ...(partial ? { partial: true } : {}) });
  });

  // Warm the lists one after another shortly after boot (the shared product cache keeps it light)
  setTimeout(async () => {
    for (const list of WARM_ORDER) {
      await cache.refresh(cacheKey(list), LIST_TTL, () => loadList(list)).catch(() => {});
    }
    console.log(`✓ Game Pass lists warmed (${products.size} products, market ${MARKET})`);
  }, 15000).unref();

  registerJob('subscriptionChanges', 12 * 60 * 60 * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no db' };
    const value = await cache.refresh(cacheKey('recent'), LIST_TTL, () => loadList('recent'));
    const currentIds = value.items.map(item => item.id);

    const metaRef = db.collection('meta').doc('subscriptions');
    const metaSnap = await metaRef.get();
    const known = metaSnap.exists ? metaSnap.data().recentIds : null;
    // Remember everything seen so far (bounded) so items re-entering the list don't notify twice
    const remembered = [...new Set([...currentIds, ...(Array.isArray(known) ? known : [])])].slice(0, 400);
    await metaRef.set({ recentIds: remembered, updatedAt: new Date().toISOString() }, { merge: true });
    if (!Array.isArray(known)) return { seeded: currentIds.length };

    const knownSet = new Set(known);
    const added = value.items.filter(item => !knownSet.has(item.id));
    if (!added.length) return { added: 0 };

    const byTitle = new Map(added.map(item => [normalizeGameTitle(item.name), item]));
    const libSnap = await db.collectionGroup('library').get();
    const targets = new Map(); // `${uid}:${productId}` -> { uid, item }
    for (const doc of libSnap.docs) {
      const data = doc.data();
      if (data.status !== 'wishlist' && data.status !== 'backlog') continue;
      const item = byTitle.get(normalizeGameTitle(data.name));
      const uid = doc.ref.parent.parent?.id;
      if (item && uid) targets.set(`${uid}:${item.id}`, { uid, item });
    }

    let sent = 0;
    for (const { uid, item } of targets.values()) {
      const result = await sendToUser(uid, {
        type: 'releases',
        title: `${item.name} is now on Game Pass`,
        body: 'A game from your wishlist/backlog was just added to Xbox Game Pass.',
        url: '/subscriptions',
        image: item.image,
        tag: `gamepass-${item.id}`,
      }).catch(() => null);
      if (result?.stored) sent++;
    }
    return { added: added.length, notified: sent };
  });
}
