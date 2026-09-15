// Release calendar (RAWG), currently free-to-keep games (Epic + GamerPower) and the two jobs
// that notify users: new free games (freeGames) and reminded game releases (releaseReminders).
//
//   GET /releases?month=YYYY-MM&platform=pc|playstation|xbox|switch|all
//   GET /free/active
//
// Firestore (Admin): meta/freeGames { seenIds, updatedAt }, users/{uid}/reminders/{gameKey}

const RELEASES_TTL = 6 * 60 * 60; // 6h
const FREE_TTL = 60 * 60; // 1h
const TIME_ZONE = 'Europe/Budapest';

// RAWG parent platform ids
const PLATFORM_FILTER = { pc: 1, playstation: 2, xbox: 3, switch: 7 };
const PLATFORM_SLUG = { 1: 'pc', 2: 'playstation', 3: 'xbox', 4: 'ios', 5: 'mac', 6: 'linux', 7: 'switch', 8: 'android', 14: 'web' };

const EPIC_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
const GAMERPOWER_URL = 'https://www.gamerpower.com/api/giveaways?type=game';

const normalizeTitle = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** YYYY-MM-DD of a date in Budapest time. */
function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Smaller RAWG image (crop endpoint) for calendar thumbnails. */
function rawgThumb(url) {
  if (typeof url !== 'string') return null;
  return url.replace('/media/games/', '/media/crop/600/400/games/').replace('/media/screenshots/', '/media/crop/600/400/screenshots/');
}

// ━━━━━━━━━━━━━━━━ RELEASES ━━━━━━━━━━━━━━━━

async function loadReleases(ctx, month, platform) {
  const { url, key } = ctx.config.apis.rawg;
  if (!url || !key) throw httpError(503, 'RAWG is not configured');

  const [year, mon] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = `${month}-${String(new Date(Date.UTC(year, mon, 0)).getUTCDate()).padStart(2, '0')}`;
  const params = new URLSearchParams({ key, dates: `${first},${last}`, ordering: 'released', page_size: '40' });
  if (PLATFORM_FILTER[platform]) params.set('parent_platforms', String(PLATFORM_FILTER[platform]));
  const pageUrl = page => `${url}?${params.toString()}&page=${page}`;

  const firstPage = await ctx.fetchAPI(pageUrl(1), {}, 15000);
  const pages = Math.min(3, Math.ceil((firstPage.count || 0) / 40));
  const rest = await Promise.allSettled(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => ctx.fetchAPI(pageUrl(i + 2), {}, 15000)));
  const results = [firstPage, ...rest.filter(r => r.status === 'fulfilled').map(r => r.value)].flatMap(p => p.results || []);

  const seen = new Set();
  const items = results
    .filter(g => g && g.id && g.name && g.released && !seen.has(g.id) && seen.add(g.id))
    .filter(g => (g.added || 0) >= 10 || g.background_image)
    .map(g => ({
      id: g.id,
      gameKey: `rawg-${g.id}`,
      name: g.name,
      released: g.released,
      tba: Boolean(g.tba),
      image: rawgThumb(g.background_image),
      platforms: [...new Set((g.parent_platforms || []).map(p => PLATFORM_SLUG[p.platform?.id]).filter(Boolean))],
      genres: (g.genres || []).map(x => x.name).filter(Boolean).slice(0, 4),
      added: g.added || 0,
    }))
    .sort((a, b) => a.released.localeCompare(b.released) || b.added - a.added);

  return { month, platform, items, updatedAt: new Date().toISOString() };
}

// ━━━━━━━━━━━━━━━━ FREE GAMES ━━━━━━━━━━━━━━━━

function epicImage(el) {
  const images = el.keyImages || [];
  const pick = type => images.find(i => i.type === type)?.url;
  return pick('OfferImageWide') || pick('DieselStoreFrontWide') || pick('featuredMedia') || pick('Thumbnail') || pick('OfferImageTall') || null;
}

function epicSlug(el) {
  const mapping = [...(el.offerMappings || []), ...(el.catalogNs?.mappings || [])].find(m => m.pageType === 'productHome' && m.pageSlug);
  const slug = mapping?.pageSlug || (el.productSlug ? el.productSlug.replace(/\/home$/, '') : null) || el.urlSlug;
  return slug && slug !== '[]' ? slug : null;
}

function freePromos(groups, now, current) {
  return (groups || [])
    .flatMap(g => g.promotionalOffers || [])
    .filter(p => p.discountSetting?.discountPercentage === 0)
    .filter(p => {
      const start = Date.parse(p.startDate);
      const end = Date.parse(p.endDate);
      return current ? start <= now && (!end || end > now) : start > now;
    });
}

async function loadEpicFree(ctx) {
  const data = await ctx.fetchAPI(EPIC_URL, {}, 15000);
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = Date.now();
  const items = [];
  for (const el of elements) {
    if (!el?.title || !el.promotions) continue;
    const slug = epicSlug(el);
    const current = freePromos(el.promotions.promotionalOffers, now, true)[0];
    const upcoming = current ? null : freePromos(el.promotions.upcomingPromotionalOffers, now, false).sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))[0];
    const promo = current || upcoming;
    if (!promo) continue;
    const price = el.price?.totalPrice;
    // A "current" free promo must really cost 0 right now
    if (current && price && price.discountPrice !== 0) continue;
    const decimals = price?.currencyInfo?.decimals ?? 2;
    items.push({
      id: `epic-${slug || el.id}`,
      title: el.title.trim(),
      store: 'Epic Games Store',
      storeId: 'epic',
      image: epicImage(el),
      url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games',
      worth: price?.originalPrice > 0 ? price.originalPrice / 10 ** decimals : null,
      currency: price?.currencyCode || 'USD',
      startDate: promo.startDate || null,
      endDate: promo.endDate || null,
      upcoming: !current,
      type: el.offerType === 'ADD_ON' || el.offerType === 'DLC' ? 'dlc' : 'game',
      platforms: ['pc'],
    });
  }
  return items;
}

const GP_STORES = [
  [/epic games/i, 'Epic Games Store', 'epic'],
  [/steam/i, 'Steam', 'steam'],
  [/\bgog\b/i, 'GOG', 'gog'],
  [/itch\.io/i, 'itch.io', 'itch'],
  [/ubisoft/i, 'Ubisoft Connect', 'ubisoft'],
  [/origin|ea app/i, 'EA app', 'ea'],
  [/battle\.net/i, 'Battle.net', 'battlenet'],
  [/prime gaming|amazon/i, 'Prime Gaming', 'prime'],
  [/xbox/i, 'Xbox', 'xbox'],
  [/playstation|ps4|ps5/i, 'PlayStation', 'playstation'],
  [/switch/i, 'Nintendo Switch', 'switch'],
  [/android|ios/i, 'Mobile', 'mobile'],
  [/drm-free/i, 'DRM-Free', 'drmfree'],
];

/** "2026-09-22 23:59:00" -> ISO (GamerPower gives no zone; treat as UTC). */
function gpDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// "Dire Echo (itchio)", "Battle Ram (IndieGala)" -> label in trailing parentheses
const GP_SUFFIX = /\s*\(([^()]{1,30})\)\s*$/;

async function loadGamerPowerFree(ctx) {
  const data = await ctx.fetchAPI(GAMERPOWER_URL, {}, 15000);
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  return data
    .filter(g => g && g.id && g.title && /game/i.test(g.type || '') && (g.status || 'Active') === 'Active')
    .map(g => {
      const platforms = String(g.platforms || '');
      const [, store, storeId] = GP_STORES.find(([re]) => re.test(platforms)) || [null, 'Other', 'other'];
      const raw = String(g.title).replace(/(\s+(giveaway|key))+\s*$/i, '').trim();
      const label = GP_SUFFIX.exec(raw)?.[1]?.trim();
      const shop = (storeId === 'other' || storeId === 'drmfree') && label && !/\b(pc|mobile|android|ios)\b/i.test(label) ? label : store;
      const worth = parseFloat(String(g.worth || '').replace(/[^0-9.]/g, ''));
      return {
        id: `gp-${g.id}`,
        title: raw.replace(GP_SUFFIX, '').trim() || raw,
        store: shop,
        storeId,
        image: g.image || g.thumbnail || null,
        url: g.open_giveaway_url || g.open_giveaway || g.gamerpower_url || null,
        worth: Number.isFinite(worth) && worth > 0 ? worth : null,
        currency: 'USD',
        startDate: gpDate(g.published_date),
        endDate: gpDate(g.end_date),
        upcoming: false,
        type: 'game',
        platforms: platforms.split(',').map(p => p.trim().toLowerCase()).filter(Boolean),
      };
    })
    .filter(g => g.url && (!g.endDate || Date.parse(g.endDate) > now));
}

async function loadFreeActive(ctx) {
  const [epic, gp] = await Promise.allSettled([loadEpicFree(ctx), loadGamerPowerFree(ctx)]);
  if (epic.status === 'rejected' && gp.status === 'rejected') {
    throw httpError(502, `Free games sources failed: ${epic.reason?.message}; ${gp.reason?.message}`);
  }

  const epicItems = epic.status === 'fulfilled' ? epic.value : [];
  const epicTitles = new Set(epicItems.map(i => normalizeTitle(i.title)));
  // GamerPower lists Epic freebies too: keep Epic's own entry (it has exact dates)
  const gpItems = (gp.status === 'fulfilled' ? gp.value : []).filter(i => !(i.storeId === 'epic' && epicTitles.has(normalizeTitle(i.title))));

  const time = value => (value ? Date.parse(value) : Infinity);
  const items = [...epicItems, ...gpItems].sort((a, b) =>
    Number(a.upcoming) - Number(b.upcoming)
    || (a.upcoming ? time(a.startDate) - time(b.startDate) : time(a.endDate) - time(b.endDate))
    || (b.worth || 0) - (a.worth || 0));

  return {
    items,
    sources: { epic: epic.status === 'fulfilled', gamerpower: gp.status === 'fulfilled' },
    updatedAt: new Date().toISOString(),
  };
}

// ━━━━━━━━━━━━━━━━ JOBS ━━━━━━━━━━━━━━━━

const FREE_CACHE_KEY = 'community:free-active';
const seenKey = item => `${item.id}|${(item.endDate || '').slice(0, 10)}`;
const shortDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TIME_ZONE });

async function freeGamesJob(ctx) {
  const db = ctx.getDb();
  if (!db) return { skipped: 'no-db' };

  const data = await loadFreeActive(ctx);
  ctx.cache.set(FREE_CACHE_KEY, data, FREE_TTL);
  const allKeys = data.items.filter(i => !i.upcoming).map(seenKey);
  // Mobile-only giveaways and DLCs are listed on the page but don't trigger a push
  const notifiable = data.items.filter(i => !i.upcoming && i.type === 'game' && i.storeId !== 'mobile');

  const ref = db.collection('meta').doc('freeGames');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ seenIds: allKeys.slice(0, 300), updatedAt: ctx.FieldValue.serverTimestamp() });
    return { seeded: allKeys.length };
  }

  const previous = snap.data().seenIds || [];
  const seen = new Set(previous);
  const fresh = notifiable.filter(i => !seen.has(seenKey(i)));
  let result = { users: 0, pushed: 0 };

  if (fresh.length) {
    const first = fresh[0];
    const base = { type: 'freeGames', url: '/free-games', image: first.image || undefined, tag: 'free-games' };
    const notification = fresh.length === 1
      ? { ...base, title: `Free to keep: ${first.title}`, body: first.endDate ? `${first.store} · until ${shortDate(first.endDate)}` : first.store }
      : {
        ...base,
        title: `${fresh.length} new games free to keep`,
        body: fresh.slice(0, 5).map(i => `${i.title} (${i.store})`).join(', ') + (fresh.length > 5 ? ` +${fresh.length - 5} more` : ''),
      };
    result = await ctx.sendToUsers(await ctx.usersWantingType('freeGames'), notification);
  }

  const seenIds = [...new Set([...allKeys, ...previous])].slice(0, 300);
  await ref.set({ seenIds, updatedAt: ctx.FieldValue.serverTimestamp() });
  return { active: allKeys.length, new: fresh.length, ...result };
}

async function releaseRemindersJob(ctx) {
  const db = ctx.getDb();
  if (!db) return { skipped: 'no-db' };

  const today = localDay();
  const snap = await db.collectionGroup('reminders').get();
  let released = 0;
  let headsUp = 0;
  let pushed = 0;

  for (const doc of snap.docs) {
    // Only users/{uid}/reminders/{gameKey}
    const userRef = doc.ref.parent.parent;
    if (!userRef || userRef.parent.id !== 'users') continue;
    const r = doc.data();
    if (r.notified || typeof r.releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.releaseDate)) continue;

    const name = String(r.name || 'A game you follow').slice(0, 100);
    const url = typeof r.url === 'string' && r.url.startsWith('/') ? r.url : '/calendar';
    const image = typeof r.image === 'string' && r.image.startsWith('http') ? r.image : undefined;

    try {
      if (r.releaseDate <= today) {
        const late = daysBetween(r.releaseDate, today);
        // Reminders of games released long ago are closed silently
        if (late <= 7) {
          const res = await ctx.sendToUser(userRef.id, {
            type: 'releases',
            title: late === 0 ? `${name} is out today!` : `${name} is out now!`,
            body: 'The game you asked us to remind you about has been released.',
            url,
            image,
            tag: `release-${doc.id}`,
          });
          pushed += res.pushed || 0;
          released++;
        }
        await doc.ref.update({ notified: true, notifiedAt: ctx.FieldValue.serverTimestamp() });
      } else if (!r.headsUp && r.releaseDate <= addDays(today, 3)) {
        const days = daysBetween(today, r.releaseDate);
        const res = await ctx.sendToUser(userRef.id, {
          type: 'releases',
          title: `${name} releases in ${days} day${days === 1 ? '' : 's'}`,
          body: 'Get ready - we will remind you again on release day.',
          url,
          image,
          tag: `release-soon-${doc.id}`,
        });
        pushed += res.pushed || 0;
        headsUp++;
        await doc.ref.update({ headsUp: true });
      }
    } catch (error) {
      console.error('releaseReminders:', doc.ref.path, error.message);
    }
  }
  return { reminders: snap.size, released, headsUp, pushed };
}

// ━━━━━━━━━━━━━━━━ REGISTER ━━━━━━━━━━━━━━━━

const releaseParams = req => ({
  month: String(req.query.month || ''),
  platform: String(req.query.platform || 'all').toLowerCase(),
});

export default function register(app, ctx) {
  ctx.paramRoute(
    '/releases',
    RELEASES_TTL,
    req => {
      const { month, platform } = releaseParams(req);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
      if (platform !== 'all' && !PLATFORM_FILTER[platform]) return null;
      return `${month}:${platform}`;
    },
    req => {
      const { month, platform } = releaseParams(req);
      return loadReleases(ctx, month, platform);
    },
  );

  app.get('/free/active', async (req, res) => {
    try {
      const entry = await ctx.cache.swr(FREE_CACHE_KEY, FREE_TTL, () => loadFreeActive(ctx));
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.send(entry.body);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  ctx.registerJob('freeGames', 3 * 60 * 60 * 1000, () => freeGamesJob(ctx));
  ctx.registerJob('releaseReminders', 6 * 60 * 60 * 1000, () => releaseRemindersJob(ctx));
}
