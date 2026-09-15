import { cache } from './cache.js';
import { fetchAPI } from './utils.js';
import { config } from './config.js';

/**
 * "Hub" routes: always-fresh store data and per-game "universes" from ~30 public game APIs.
 *
 * Every list is normalized to the same small item shape the frontend renders:
 *   { id, name, image, subtitle?, tag?, url?, price?, originalPrice?, discount?, currency?, players? }
 *
 * Optional API keys (sections that need them answer 503 { configured: false } until set):
 *   TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET  -> IGDB + Twitch
 *   STEAMGRIDDB_API_KEY                      -> SteamGridDB artwork
 *   ITAD_API_KEY                             -> IsThereAnyDeal deals
 *   RETROACHIEVEMENTS_API_KEY                -> RetroAchievements
 *   OPENCRITIC_ENABLED=true                  -> OpenCritic via the existing RapidAPI key (needs a RapidAPI subscription)
 */

const env = process.env;
const HOUR = 3600;

const providers = {
  igdb: Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
  twitch: Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
  steamgriddb: Boolean(env.STEAMGRIDDB_API_KEY),
  itad: Boolean(env.ITAD_API_KEY),
  retroachievements: Boolean(env.RETROACHIEVEMENTS_API_KEY),
  opencritic: env.OPENCRITIC_ENABLED === 'true' && Boolean(config.apis.rapid.key),
};

const clean = items => items.filter(item => item && item.name && item.image);
const dedupe = items => [...new Map(items.map(item => [item.id, item])).values()];

async function fetchText(url, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'GameDataHub/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ━━━━━━━━━━━━━━━━ STEAM ━━━━━━━━━━━━━━━━ */

const STEAM_CDN = 'https://shared.akamai.steamstatic.com/store_item_assets/';

const formatCents = (cents, currency = 'USD') =>
  cents || cents === 0 ? (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency }) : undefined;

const steamFeaturedItem = item => ({
  id: item.id,
  name: item.name,
  image: item.header_image || item.large_capsule_image,
  url: `https://store.steampowered.com/app/${item.id}`,
  price: item.final_price === 0 ? 'Free' : formatCents(item.final_price, item.currency),
  originalPrice: item.discount_percent ? formatCents(item.original_price, item.currency) : undefined,
  discount: item.discount_percent || 0,
  source: 'steam',
});

// Names, header images and prices for many appids in one request
async function steamItemsInfo(appids) {
  if (!appids.length) return new Map();
  const input = {
    ids: appids.map(appid => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true, include_basic_info: true, include_all_purchase_options: true },
  };
  const data = await fetchAPI(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
  const map = new Map();
  for (const item of data.response?.store_items || []) {
    if (!item.success) continue;
    const assets = item.assets;
    const image = assets?.asset_url_format && assets.header
      ? STEAM_CDN + assets.asset_url_format.replace('${FILENAME}', assets.header)
      : `${STEAM_CDN}steam/apps/${item.appid}/header.jpg`;
    const offer = item.best_purchase_option;
    map.set(item.appid, {
      name: item.name,
      image,
      description: item.basic_info?.short_description,
      price: item.is_free ? 'Free' : offer?.formatted_final_price,
      originalPrice: offer?.discount_pct ? offer.formatted_original_price : undefined,
      discount: offer?.discount_pct || 0,
    });
  }
  return map;
}

const steamInfoItem = (appid, info) => ({
  id: appid,
  name: info?.name,
  image: info?.image,
  url: `https://store.steampowered.com/app/${appid}`,
  price: info?.price,
  originalPrice: info?.originalPrice,
  discount: info?.discount || 0,
  source: 'steam',
});

async function steamPlayers(appid) {
  try {
    const data = await fetchAPI(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`, {}, 8000);
    return data.response?.player_count ?? null;
  } catch {
    return null;
  }
}

async function steamAppDetails(appid) {
  const [detailsRes, players, reviewsRes, newsRes] = await Promise.allSettled([
    fetchAPI(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`),
    steamPlayers(appid),
    fetchAPI(`https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=0&purchase_type=all&language=all`),
    fetchAPI(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=4&maxlength=240&feeds=steam_community_announcements`),
  ]);

  const d = detailsRes.status === 'fulfilled' ? detailsRes.value?.[appid]?.data : null;
  if (!d) throw new Error('Steam app not found');
  const summary = reviewsRes.status === 'fulfilled' ? reviewsRes.value?.query_summary : null;
  // Steam sends [] instead of an object when there are no requirements
  const pcReq = Array.isArray(d.pc_requirements) ? {} : d.pc_requirements || {};
  const trimReq = html => (typeof html === 'string' && html.trim() ? html.slice(0, 4000) : null);

  return {
    id: d.steam_appid,
    name: d.name,
    type: d.type,
    description: d.short_description,
    image: d.header_image,
    background: d.background_raw || d.background,
    url: `https://store.steampowered.com/app/${d.steam_appid}`,
    website: d.website,
    isFree: d.is_free,
    price: d.price_overview
      ? { final: d.price_overview.final_formatted, initial: d.price_overview.initial_formatted, discount: d.price_overview.discount_percent }
      : null,
    developers: d.developers || [],
    publishers: d.publishers || [],
    genres: (d.genres || []).map(g => g.description),
    releaseDate: d.release_date?.date,
    comingSoon: d.release_date?.coming_soon,
    metacritic: d.metacritic?.score ?? null,
    platforms: d.platforms,
    achievements: d.achievements?.total ?? null,
    requiredAge: Number(d.required_age) || 0,
    categories: (d.categories || []).map(c => c.description).slice(0, 12),
    requirements: trimReq(pcReq.minimum) || trimReq(pcReq.recommended)
      ? { minimum: trimReq(pcReq.minimum), recommended: trimReq(pcReq.recommended) }
      : null,
    screenshots: (d.screenshots || []).slice(0, 8).map(s => ({ thumb: s.path_thumbnail, full: s.path_full })),
    players: players.status === 'fulfilled' ? players.value : null,
    reviews: summary?.total_reviews
      ? { label: summary.review_score_desc, positive: summary.total_positive, total: summary.total_reviews, percent: Math.round((summary.total_positive / summary.total_reviews) * 100) }
      : null,
    news: newsRes.status === 'fulfilled'
      ? (newsRes.value?.appnews?.newsitems || []).map(n => ({ id: n.gid, title: n.title, url: n.url, date: n.date * 1000 }))
      : [],
  };
}

// The store's live "Top Sellers" search (the featured endpoint only returns a handful)
async function steamTopSellers() {
  const data = await fetchAPI('https://store.steampowered.com/search/results/?filter=topsellers&json=1&cc=us&l=english&count=30');
  const appids = [...new Set((data.items || []).map(i => Number(i.logo?.match(/\/apps\/(\d+)\//)?.[1])).filter(Boolean))];
  const info = await steamItemsInfo(appids);
  return clean(appids.map(appid => steamInfoItem(appid, info.get(appid))));
}

const normalizeTitle = s =>s.toLowerCase().replace(/[^a-z0-9]/g, '');

/* ━━━━━━━━━━━━━━━━ GOG ━━━━━━━━━━━━━━━━ */

async function gogList(order, extra = '') {
  const data = await fetchAPI(
    `https://catalog.gog.com/v1/catalog?limit=24&order=${order}&productType=in:game,pack&locale=en-US&countryCode=US&currencyCode=USD${extra}`
  );
  return clean((data.products || []).map(p => ({
    id: p.id,
    name: p.title,
    image: p.coverHorizontal,
    url: p.storeLink,
    price: p.price?.final,
    originalPrice: p.price?.base,
    discount: p.price?.discount ? Math.abs(parseInt(p.price.discount, 10)) || 0 : 0,
    subtitle: p.developers?.[0],
    tag: p.genres?.[0]?.name,
    source: 'gog',
  })));
}

const stripHtml = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|h\d)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// Same "Label: value" lines Steam uses, so the frontend requirement parser understands both
const GOG_REQ_LABELS = { system: 'OS', processor: 'Processor', memory: 'Memory', graphics: 'Graphics', directx: 'DirectX', storage: 'Storage', sound: 'Sound Card', network: 'Network', other: 'Additional Notes' };

function gogRequirements(operatingSystems = []) {
  const windows = operatingSystems.find(o => o.operatingSystem?.name === 'windows') || operatingSystems[0];
  const byType = type => {
    const entry = windows?.systemRequirements?.find(r => r.type === type);
    if (!entry) return null;
    const lines = (entry.requirements || [])
      .filter(r => r.description)
      .map(r => `${GOG_REQ_LABELS[r.id] || String(r.name || '').replace(/:$/, '')}: ${r.description}`);
    return (lines.length ? lines.join('<br>') : entry.description || '').slice(0, 4000) || null;
  };
  const minimum = byType('minimum');
  const recommended = byType('recommended');
  return minimum || recommended ? { minimum, recommended } : null;
}

async function gogGameDetails(id) {
  const d = await fetchAPI(`https://api.gog.com/v2/games/${id}?locale=en-US`);
  const e = d._embedded || {};
  if (!e.product) throw Object.assign(new Error('GOG game not found'), { status: 404 });
  const screenshot = (s, size) => s._links?.self?.href?.replace('{formatter}', size);
  return {
    id: String(e.product.id),
    name: e.product.title,
    description: stripHtml(d.description || d.overview).slice(0, 3000),
    image: d._links?.backgroundImage?.href || d._links?.boxArtImage?.href,
    url: d._links?.store?.href,
    releaseDate: e.product.globalReleaseDate || e.product.gogReleaseDate,
    developers: (e.developers || []).map(x => x.name),
    publishers: (e.publishers || (e.publisher ? [e.publisher] : [])).map(x => x.name),
    genres: (e.tags || []).filter(t => t.level <= 2).map(t => t.name).slice(0, 4),
    tags: (e.properties || []).map(p => p.name).slice(0, 12),
    features: (e.features || []).map(f => f.name),
    ageRating: e.esrbRating?.category?.name || (e.pegiRating?.ageRating ? `PEGI ${e.pegiRating.ageRating}` : null),
    platforms: (e.supportedOperatingSystems || []).map(o => o.operatingSystem?.versions || o.operatingSystem?.name).filter(Boolean),
    screenshots: (e.screenshots || []).slice(0, 8).map(s => ({ thumb: screenshot(s, 'product_card_screenshot_748'), full: screenshot(s, '1600') })).filter(s => s.thumb),
    requirements: gogRequirements(e.supportedOperatingSystems),
  };
}

/* ━━━━━━━━━━━━━━━━ SPEEDRUN ━━━━━━━━━━━━━━━━ */

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(seconds < 60 ? 2 : 0).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* ━━━━━━━━━━━━━━━━ TWITCH / IGDB ━━━━━━━━━━━━━━━━ */

let twitchToken = null;

async function getTwitchToken() {
  if (twitchToken && twitchToken.expiresAt > Date.now() + 60000) return twitchToken.value;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${env.TWITCH_CLIENT_ID}&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`Twitch auth failed: ${res.status}`);
  const data = await res.json();
  twitchToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return twitchToken.value;
}

async function igdbQuery(body) {
  const token = await getTwitchToken();
  return fetchAPI('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: { 'Client-ID': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body,
  });
}

const igdbItem = g => ({
  id: g.id,
  name: g.name,
  image: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : null,
  url: g.url,
  subtitle: g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : 'TBA',
  tag: g.genres?.[0]?.name,
  platforms: (g.platforms || []).map(p => p.abbreviation).filter(Boolean).slice(0, 4),
  score: g.total_rating ? Math.round(g.total_rating) : null,
  source: 'igdb',
});

/* ━━━━━━━━━━━━━━━━ UNIVERSES (per-game APIs) ━━━━━━━━━━━━━━━━ */

const section = (id, title, items) => ({ id, title, items: clean(items) });

export const UNIVERSES = {
  valorant: {
    name: 'Valorant', source: 'valorant-api.com', sourceUrl: 'https://valorant-api.com',
    cover: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png',
    async load() {
      const [agents, maps, bundles] = await Promise.all([
        fetchAPI('https://valorant-api.com/v1/agents?isPlayableCharacter=true'),
        fetchAPI('https://valorant-api.com/v1/maps'),
        fetchAPI('https://valorant-api.com/v1/bundles'),
      ]);
      return [
        section('agents', 'Agents', agents.data.map(a => ({ id: a.uuid, name: a.displayName, image: a.fullPortrait || a.displayIcon, subtitle: a.role?.displayName, description: a.description }))),
        section('maps', 'Maps', maps.data.filter(m => m.tacticalDescription).map(m => ({ id: m.uuid, name: m.displayName, image: m.splash, subtitle: m.tacticalDescription }))),
        section('bundles', 'Skin bundles', bundles.data.slice(-40).reverse().map(b => ({ id: b.uuid, name: b.displayName, image: b.displayIcon }))),
      ];
    },
  },
  fortnite: {
    name: 'Fortnite', source: 'fortnite-api.com', sourceUrl: 'https://fortnite-api.com',
    cover: 'https://fortnite-api.com/images/cosmetics/br/cid_028_athena_commando_f/featured.png',
    async load() {
      const [shop, news] = await Promise.all([
        fetchAPI('https://fortnite-api.com/v2/shop'),
        fetchAPI('https://fortnite-api.com/v2/news/br').catch(() => null),
      ]);
      const shopItems = (shop.data?.entries || []).map(e => {
        const br = e.brItems?.[0];
        return {
          id: e.offerId,
          name: br?.name || e.bundle?.name,
          image: e.newDisplayAsset?.renderImages?.[0]?.image || br?.images?.featured || br?.images?.icon,
          subtitle: br?.type?.displayValue,
          tag: `${e.finalPrice} V-Bucks`,
        };
      });
      return [
        section('shop', "Today's item shop", dedupe(shopItems.filter(i => i.name)).slice(0, 80)),
        section('news', 'News', (news?.data?.motds || []).map(n => ({ id: n.id, name: n.title, image: n.tileImage || n.image, subtitle: n.body }))),
      ];
    },
  },
  lol: {
    name: 'League of Legends', source: 'Riot Data Dragon', sourceUrl: 'https://developer.riotgames.com/docs/lol#data-dragon',
    cover: 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_0.jpg',
    async load() {
      const [version] = await fetchAPI('https://ddragon.leagueoflegends.com/api/versions.json');
      const [champions, items] = await Promise.all([
        fetchAPI(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`),
        fetchAPI(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`),
      ]);
      return [
        section('champions', `Champions (patch ${version})`, Object.values(champions.data).map(c => ({
          id: c.id, name: c.name, image: `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${c.id}_0.jpg`, subtitle: c.title, tag: c.tags?.[0], description: c.blurb,
        }))),
        section('items', 'Legendary items', Object.entries(items.data)
          .filter(([, i]) => i.gold?.total >= 2500 && i.maps?.['11'] && i.gold.purchasable)
          .map(([id, i]) => ({ id, name: i.name, image: `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${i.image.full}`, tag: `${i.gold.total} gold`, subtitle: i.plaintext }))),
      ];
    },
  },
  dota2: {
    name: 'Dota 2', source: 'OpenDota', sourceUrl: 'https://www.opendota.com',
    cover: `${STEAM_CDN}steam/apps/570/header.jpg`,
    async load() {
      const heroes = await fetchAPI('https://api.opendota.com/api/heroStats');
      const attr = { str: 'Strength', agi: 'Agility', int: 'Intelligence', all: 'Universal' };
      return [
        section('heroes', 'Heroes by pro pick rate', [...heroes].sort((a, b) => (b.pro_pick || 0) - (a.pro_pick || 0)).map(h => ({
          id: h.id, name: h.localized_name, image: `https://cdn.cloudflare.steamstatic.com${h.img}`, subtitle: attr[h.primary_attr] || h.primary_attr, tag: h.pro_pick ? `${h.pro_pick} pro picks` : h.roles?.[0],
        }))),
      ];
    },
  },
  overwatch: {
    name: 'Overwatch 2', source: 'OverFast API', sourceUrl: 'https://overfast-api.tekrop.fr',
    cover: `${STEAM_CDN}steam/apps/2357570/header.jpg`,
    async load() {
      const heroes = await fetchAPI('https://overfast-api.tekrop.fr/heroes');
      const roles = ['tank', 'damage', 'support'];
      return roles.map(role => section(role, role[0].toUpperCase() + role.slice(1), heroes.filter(h => h.role === role).map(h => ({
        id: h.key, name: h.name, image: h.portrait, subtitle: h.subrole?.replace(/_/g, ' '),
      }))));
    },
  },
  brawlstars: {
    name: 'Brawl Stars', source: 'Brawlify', sourceUrl: 'https://brawlify.com',
    cover: 'https://cdn.brawlify.com/brawlers/borderless/16000000.png',
    async load() {
      const data = await fetchAPI('https://api.brawlapi.com/v1/brawlers');
      return [
        section('brawlers', 'Brawlers', [...data.list].reverse().map(b => ({
          id: b.id, name: b.name, image: b.imageUrl2, subtitle: b.class?.name, tag: b.rarity?.name, tagColor: b.rarity?.color, url: b.link, description: b.description,
        }))),
      ];
    },
  },
  genshin: {
    name: 'Genshin Impact', source: 'genshin.dev API', sourceUrl: 'https://genshin.jmp.blue',
    cover: 'https://genshin.jmp.blue/characters/albedo/card',
    async load() {
      const characters = await fetchAPI('https://genshin.jmp.blue/characters/all');
      return [
        section('characters', 'Characters', [...characters].sort((a, b) => (b.release || '').localeCompare(a.release || '')).map(c => ({
          id: c.id, name: c.name, image: `https://genshin.jmp.blue/characters/${c.id}/card`, subtitle: `${c.vision} · ${c.weapon}`, tag: `${c.rarity}★`, description: c.description,
        }))),
      ];
    },
  },
  hearthstone: {
    name: 'Hearthstone', source: 'HearthstoneJSON', sourceUrl: 'https://hearthstonejson.com',
    cover: 'https://art.hearthstonejson.com/v1/render/latest/enUS/512x/AT_009.png',
    async load() {
      const cards = await fetchAPI('https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json', {}, 30000);
      const art = id => `https://art.hearthstonejson.com/v1/render/latest/enUS/256x/${id}.png`;
      const newest = [...cards].sort((a, b) => b.dbfId - a.dbfId);
      const card = c => ({ id: c.id, name: c.name, image: art(c.id), subtitle: c.cardClass?.toLowerCase(), tag: `${c.cost} mana` });
      return [
        section('legendary', 'Newest legendaries', newest.filter(c => c.rarity === 'LEGENDARY' && c.type !== 'HERO').slice(0, 60).map(card)),
        section('newest', 'Newest cards', newest.filter(c => c.type !== 'HERO').slice(0, 60).map(card)),
      ];
    },
  },
  gw2: {
    name: 'Guild Wars 2', source: 'Guild Wars 2 API', sourceUrl: 'https://wiki.guildwars2.com/wiki/API:Main',
    cover: `${STEAM_CDN}steam/apps/1284210/header.jpg`,
    async load() {
      const ids = await fetchAPI('https://api.guildwars2.com/v2/legendaryarmory');
      const items = await fetchAPI(`https://api.guildwars2.com/v2/items?ids=${ids.slice(0, 150).join(',')}`);
      return [
        section('legendary', 'Legendary armory', items.map(i => ({ id: i.id, name: i.name, image: i.icon, subtitle: i.details?.type || i.type, tag: i.rarity }))),
      ];
    },
  },
  ffxiv: {
    name: 'Final Fantasy XIV', source: 'XIVAPI', sourceUrl: 'https://v2.xivapi.com',
    cover: `${STEAM_CDN}steam/apps/39210/header.jpg`,
    async load() {
      const data = await fetchAPI('https://v2.xivapi.com/api/sheet/Mount?fields=Singular,Icon&limit=500');
      const mounts = data.rows
        .filter(r => r.fields.Singular && r.fields.Icon?.id)
        .map(r => ({
          id: r.row_id,
          name: r.fields.Singular.replace(/\b\w/g, c => c.toUpperCase()),
          image: `https://v2.xivapi.com/api/asset?path=${encodeURIComponent(r.fields.Icon.path_hr1 || r.fields.Icon.path)}&format=png`,
        }));
      return [section('mounts', 'Mounts', mounts.reverse().slice(0, 120))];
    },
  },
  warframe: {
    name: 'Warframe', source: 'warframestat.us', sourceUrl: 'https://docs.warframestat.us',
    cover: `${STEAM_CDN}steam/apps/230410/header.jpg`,
    async load() {
      const news = await fetchAPI('https://api.warframestat.us/pc/news');
      return [
        section('news', 'Latest news', [...news].filter(n => n.imageLink && !n.imageLink.includes('placeholder')).reverse().map(n => ({
          id: n.id, name: n.message, image: n.imageLink, url: n.link, subtitle: n.date ? new Date(n.date).toISOString().slice(0, 10) : '',
          tag: n.primeAccess ? 'Prime Access' : n.update ? 'Update' : n.stream ? 'Stream' : 'News',
        }))),
      ];
    },
  },
  cs2: {
    name: 'Counter-Strike 2', source: 'ByMykel CSGO-API', sourceUrl: 'https://github.com/ByMykel/CSGO-API',
    cover: `${STEAM_CDN}steam/apps/730/header.jpg`,
    async load() {
      const [crates, agents] = await Promise.all([
        fetchAPI('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json', {}, 45000),
        fetchAPI('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json', {}, 30000),
      ]);
      const cases = crates.filter(c => c.type === 'Case').sort((a, b) => (b.first_sale_date || '').localeCompare(a.first_sale_date || ''));
      return [
        section('cases', 'Cases', cases.map(c => ({ id: c.id, name: c.name, image: c.image, subtitle: c.first_sale_date, tag: `${c.contains?.length || 0} skins` }))),
        section('agents', 'Agents', agents.map(a => ({ id: a.id, name: a.name, image: a.image, subtitle: a.team?.name, tag: a.rarity?.name, tagColor: a.rarity?.color }))),
      ];
    },
  },
  splatoon: {
    name: 'Splatoon 3', source: 'splatoon3.ink', sourceUrl: 'https://splatoon3.ink',
    cover: 'https://assets.splatoon3.ink/splatnet/v3/stage_img/icon/low_resolution/8dc2f16d39c630bab40cead5b2485ca3559e829d0d3de0c2232c7a62fefb5fa9_1.png',
    ttl: 15 * 60,
    async load() {
      const { data } = await fetchAPI('https://splatoon3.ink/data/schedules.json');
      const time = n => `${n.startTime.slice(11, 16)}-${n.endTime.slice(11, 16)} UTC`;
      const stages = (nodes, pick, mode) => nodes.slice(0, 4).flatMap(n => {
        const setting = pick(n);
        return (setting?.vsStages || []).map(s => ({ id: `${n.startTime}-${mode}-${s.vsStageId}`, name: s.name, image: s.image?.url, subtitle: time(n), tag: setting.vsRule?.name }));
      });
      return [
        section('regular', 'Regular battle rotation', stages(data.regularSchedules.nodes, n => n.regularMatchSetting, 'regular')),
        section('ranked', 'Anarchy battle rotation', stages(data.bankaraSchedules.nodes, n => n.bankaraMatchSettings?.[0], 'ranked')),
        section('x', 'X battle rotation', stages(data.xSchedules.nodes, n => n.xMatchSetting, 'x')),
      ];
    },
  },
  pokemon: {
    name: 'Pokémon', source: 'PokeAPI', sourceUrl: 'https://pokeapi.co',
    cover: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png',
    async load() {
      const data = await fetchAPI('https://pokeapi.co/api/v2/pokemon?limit=1025');
      const art = id => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
      const all = data.results.map(p => {
        const id = Number(p.url.split('/').filter(Boolean).pop());
        return { id, name: p.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), image: art(id), tag: `#${String(id).padStart(4, '0')}` };
      });
      // A different set every day
      const day = Math.floor(Date.now() / 86400000);
      const daily = Array.from({ length: 24 }, (_, i) => all[(day * 97 + i * 131) % all.length]);
      return [section('daily', 'Pokémon of the day', dedupe(daily)), section('newest', 'Newest generation', all.slice(-60).reverse())];
    },
  },
  mtg: {
    name: 'Magic: The Gathering', source: 'Scryfall', sourceUrl: 'https://scryfall.com/docs/api',
    cover: 'https://cards.scryfall.io/art_crop/front/b/d/bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd.jpg',
    async load() {
      const data = await fetchAPI('https://api.scryfall.com/cards/search?order=released&dir=desc&q=game%3Apaper+-type%3Abasic+(rarity%3Amythic+or+rarity%3Arare)&unique=cards');
      return [
        section('newest', 'Newest rares & mythics', data.data.slice(0, 80).map(c => ({
          id: c.id, name: c.name, image: c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal, subtitle: c.set_name, tag: c.prices?.usd ? `$${c.prices.usd}` : c.rarity, url: c.scryfall_uri,
        }))),
      ];
    },
  },
  yugioh: {
    name: 'Yu-Gi-Oh!', source: 'YGOPRODeck', sourceUrl: 'https://ygoprodeck.com/api-guide/',
    cover: 'https://images.ygoprodeck.com/images/cards_cropped/46986414.jpg',
    async load() {
      const [newest, staples] = await Promise.all([
        fetchAPI('https://db.ygoprodeck.com/api/v7/cardinfo.php?sort=new&num=60&offset=0'),
        fetchAPI('https://db.ygoprodeck.com/api/v7/cardinfo.php?staple=yes'),
      ]);
      const card = c => ({ id: c.id, name: c.name, image: c.card_images?.[0]?.image_url_small, subtitle: c.humanReadableCardType || c.type, tag: c.attribute || c.race, url: c.ygoprodeck_url });
      return [section('newest', 'Newest cards', newest.data.map(card)), section('staples', 'Meta staples', staples.data.slice(0, 80).map(card))];
    },
  },
  amiibo: {
    name: 'Nintendo Amiibo', source: 'AmiiboAPI', sourceUrl: 'https://www.amiiboapi.org',
    cover: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/6.png',
    async load() {
      const { amiibo } = await fetchAPI('https://www.amiiboapi.org/api/amiibo/');
      const released = a => a.release?.na || a.release?.eu || a.release?.jp || '';
      return [
        section('newest', 'Latest releases', [...amiibo].sort((a, b) => released(b).localeCompare(released(a))).slice(0, 80).map(a => ({
          id: a.head + a.tail, name: a.name, image: a.image, subtitle: a.gameSeries, tag: released(a) || a.type,
        }))),
      ];
    },
  },
  eldenring: {
    name: 'Elden Ring', source: 'Elden Ring Fan API', sourceUrl: 'https://docs.eldenring.fanapis.com',
    cover: `${STEAM_CDN}steam/apps/1245620/header.jpg`,
    async load() {
      const [bosses, weapons] = await Promise.all([
        fetchAPI('https://eldenring.fanapis.com/api/bosses?limit=100'),
        fetchAPI('https://eldenring.fanapis.com/api/weapons?limit=100'),
      ]);
      return [
        section('bosses', 'Bosses', bosses.data.map(b => ({ id: b.id, name: b.name, image: b.image, subtitle: b.location || b.region, description: b.description }))),
        section('weapons', 'Weapons', weapons.data.map(w => ({ id: w.id, name: w.name, image: w.image, subtitle: w.category, tag: w.weight ? `${w.weight} wt` : undefined }))),
      ];
    },
  },
};

/* ━━━━━━━━━━━━━━━━ ROUTES ━━━━━━━━━━━━━━━━ */

/**
 * @param {import('express').Express} app
 * @param {(path: string, ttl: number, loader: Function, opts?: { warm?: boolean }) => void} cachedRoute
 */
export function registerHubRoutes(app, cachedRoute) {
  // Cached route whose cache key depends on a param; answered stale-while-revalidate like cachedRoute
  function paramRoute(routePath, ttl, keyOf, loader) {
    app.get(routePath, async (req, res) => {
      const key = keyOf(req);
      if (!key) return res.status(400).json({ error: 'Invalid parameters' });
      try {
        const entry = await cache.swr(`hub:${routePath}:${key}`, ttl, () => loader(req));
        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${Math.min(ttl, 300)}, stale-while-revalidate=86400` });
        res.send(entry.body);
      } catch (error) {
        res.set('Cache-Control', 'no-store');
        res.status(error.status || 502).json({ error: error.message });
      }
    });
  }

  // Routes that need an API key: 503 until configured, then a normal cached route
  function keyedRoute(provider, routePath, ttl, loader) {
    if (!providers[provider]) {
      app.get(routePath, (req, res) => res.status(503).json({ configured: false, provider }));
      return;
    }
    cachedRoute(routePath, ttl, loader, { warm: false });
  }

  app.get('/hub/status', (req, res) => {
    res.json({ providers, universes: Object.keys(UNIVERSES) });
  });

  /* ----- Steam (keyless, always fresh) ----- */

  cachedRoute('/hub/steam/featured', 15 * 60, async () => {
    const [data, topSellers] = await Promise.all([
      fetchAPI('https://store.steampowered.com/api/featuredcategories?cc=us&l=english'),
      steamTopSellers().catch(() => []),
    ]);
    const list = key => clean(dedupe((data[key]?.items || []).filter(i => i.type === 0).map(steamFeaturedItem)));
    return {
      updatedAt: Date.now(),
      topSellers: topSellers.length >= 8 ? topSellers : list('top_sellers'),
      newReleases: list('new_releases'),
      specials: list('specials'),
      comingSoon: list('coming_soon'),
    };
  });

  cachedRoute('/hub/steam/most-played', 10 * 60, async () => {
    const data = await fetchAPI('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/');
    const ranks = (data.response?.ranks || []).slice(0, 24);
    const appids = ranks.map(r => r.appid);
    const [info, players] = await Promise.all([steamItemsInfo(appids), Promise.all(appids.map(steamPlayers))]);
    return {
      updatedAt: Date.now(),
      items: clean(ranks.map((r, i) => ({
        ...steamInfoItem(r.appid, info.get(r.appid)),
        rank: r.rank,
        lastWeekRank: r.last_week_rank,
        players: players[i],
        peak: r.peak_in_game,
      }))),
    };
  });

  cachedRoute('/hub/steamspy/trending', 3 * HOUR, async () => {
    const data = await fetchAPI('https://steamspy.com/api.php?request=top100in2weeks', {}, 25000);
    const apps = Object.values(data).slice(0, 30);
    const info = await steamItemsInfo(apps.map(a => a.appid));
    return {
      updatedAt: Date.now(),
      items: clean(apps.map(a => {
        const total = a.positive + a.negative;
        return {
          ...steamInfoItem(a.appid, info.get(a.appid)),
          name: info.get(a.appid)?.name || a.name,
          subtitle: `${a.owners.replace(' .. ', '–')} owners`,
          tag: total ? `${Math.round((a.positive / total) * 100)}% positive` : undefined,
        };
      })),
    };
  });

  paramRoute('/hub/steam/app/:appid', 3 * HOUR, req => (/^\d{1,9}$/.test(req.params.appid) ? req.params.appid : null), req => steamAppDetails(req.params.appid));

  // Attach Steam data to a game known only by name (e.g. a RAWG game)
  paramRoute('/hub/steam/lookup', 6 * HOUR, req => {
    const name = String(req.query.name || '').trim().slice(0, 100);
    return name ? normalizeTitle(name) || null : null;
  }, async req => {
    const name = String(req.query.name).trim().slice(0, 100);
    const search = await fetchAPI(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=english`);
    const items = search.items || [];
    const wanted = normalizeTitle(name);
    // A prefix match only counts when the titles are nearly the same length ("Nox" must not match "Nox Archaist")
    const closeEnough = got => got.startsWith(wanted) && wanted.length >= 4 && wanted.length / got.length >= 0.7;
    const match = items.find(i => normalizeTitle(i.name) === wanted) || items.find(i => closeEnough(normalizeTitle(i.name)));
    if (!match) return { found: false };
    return { found: true, ...(await steamAppDetails(match.id)) };
  });

  /* ----- GOG ----- */

  cachedRoute('/hub/gog', HOUR, async () => {
    const [trending, newest, deals] = await Promise.all([
      gogList('desc:trending'),
      gogList('desc:storeReleaseDate'),
      gogList('desc:discount', '&discounted=eq:true'),
    ]);
    const noDemos = items => items.filter(i => !/\bdemo\b/i.test(i.name));
    return { updatedAt: Date.now(), trending, newest: noDemos(newest), deals };
  });

  // Full details for one GOG product (api.gog.com blocks browser requests with CORS)
  paramRoute('/hub/gog/game/:id', 6 * HOUR, req => (/^\d{1,12}$/.test(req.params.id) ? req.params.id : null), req => gogGameDetails(req.params.id));

  /* ----- Speedrun.com ----- */

  cachedRoute('/hub/speedrun/latest', 10 * 60, async () => {
    const data = await fetchAPI('https://www.speedrun.com/api/v1/runs?status=verified&orderby=verify-date&direction=desc&embed=game,category,players&max=40');
    return {
      updatedAt: Date.now(),
      items: clean(dedupe((data.data || []).map(run => {
        const game = run.game?.data;
        const player = run.players?.data?.[0];
        return {
          id: run.id,
          name: game?.names?.international,
          image: game?.assets?.['cover-large']?.uri,
          url: run.weblink,
          subtitle: run.category?.data?.name,
          tag: formatDuration(run.times?.primary_t),
          player: player?.names?.international || player?.name || 'Guest',
          date: run.status?.['verify-date'],
          source: 'speedrun',
        };
      }))).slice(0, 24),
    };
  });

  /* ----- Universes ----- */

  app.get('/hub/universes', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(Object.entries(UNIVERSES).map(([id, u]) => ({ id, name: u.name, source: u.source, sourceUrl: u.sourceUrl, cover: u.cover })));
  });

  paramRoute('/hub/universe/:id', 6 * HOUR, req => (Object.hasOwn(UNIVERSES, req.params.id) ? req.params.id : null), async req => {
    const id = req.params.id;
    const universe = UNIVERSES[id];
    const sections = (await universe.load()).filter(s => s.items.length);
    return { id, name: universe.name, source: universe.source, sourceUrl: universe.sourceUrl, cover: universe.cover, updatedAt: Date.now(), sections };
  });

  /* ----- Keyed providers ----- */

  keyedRoute('igdb', '/hub/igdb/upcoming', 6 * HOUR, async () => {
    const now = Math.floor(Date.now() / 1000);
    const games = await igdbQuery(
      `fields name,url,cover.image_id,first_release_date,genres.name,platforms.abbreviation,hypes; where first_release_date > ${now} & cover != null & hypes > 3; sort hypes desc; limit 30;`
    );
    return { updatedAt: Date.now(), items: clean(games.map(igdbItem)) };
  });

  keyedRoute('igdb', '/hub/igdb/top-new', 6 * HOUR, async () => {
    const now = Math.floor(Date.now() / 1000);
    const games = await igdbQuery(
      `fields name,url,cover.image_id,first_release_date,genres.name,platforms.abbreviation,total_rating; where first_release_date > ${now - 120 * 86400} & first_release_date < ${now} & cover != null & total_rating_count > 4; sort total_rating desc; limit 30;`
    );
    return { updatedAt: Date.now(), items: clean(games.map(igdbItem)) };
  });

  keyedRoute('twitch', '/hub/twitch/top-games', 10 * 60, async () => {
    const token = await getTwitchToken();
    const data = await fetchAPI('https://api.twitch.tv/helix/games/top?first=30', {
      headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    });
    return {
      updatedAt: Date.now(),
      items: clean((data.data || []).map((g, i) => ({
        id: g.id,
        rank: i + 1,
        name: g.name,
        image: g.box_art_url?.replace('{width}', '285').replace('{height}', '380'),
        url: `https://www.twitch.tv/directory/category/${encodeURIComponent(g.name.toLowerCase().replace(/\s+/g, '-'))}`,
        source: 'twitch',
      }))),
    };
  });

  keyedRoute('itad', '/hub/itad/deals', HOUR, async () => {
    const data = await fetchAPI(`https://api.isthereanydeal.com/deals/v2?key=${env.ITAD_API_KEY}&country=US&limit=40&sort=-cut&mature=false`);
    return {
      updatedAt: Date.now(),
      items: clean((data.list || []).map(d => ({
        id: d.id,
        name: d.title,
        image: d.assets?.banner400 || d.assets?.banner300 || d.assets?.boxart,
        url: d.deal?.url,
        price: d.deal?.price?.amount != null ? `$${d.deal.price.amount.toFixed(2)}` : undefined,
        originalPrice: d.deal?.regular?.amount != null ? `$${d.deal.regular.amount.toFixed(2)}` : undefined,
        discount: d.deal?.cut || 0,
        subtitle: d.deal?.shop?.name,
        tag: d.deal?.storeLow?.amount === d.deal?.price?.amount ? 'Store low' : undefined,
        source: 'itad',
      }))),
    };
  });

  if (providers.steamgriddb) {
    paramRoute('/hub/artwork', 24 * HOUR, req => {
      const name = String(req.query.name || '').trim().slice(0, 100);
      return name ? normalizeTitle(name) || null : null;
    }, async req => {
      const headers = { Authorization: `Bearer ${env.STEAMGRIDDB_API_KEY}` };
      const base = 'https://www.steamgriddb.com/api/v2';
      const name = String(req.query.name).trim().slice(0, 100);
      const search = await fetchAPI(`${base}/search/autocomplete/${encodeURIComponent(name)}`, { headers });
      const game = search.data?.[0];
      if (!game) return { found: false };
      const [heroes, logos, grids] = await Promise.all(
        ['heroes', 'logos', 'grids'].map(kind => fetchAPI(`${base}/${kind}/game/${game.id}?nsfw=false&humor=false`, { headers }).catch(() => ({ data: [] })))
      );
      return { found: true, name: game.name, hero: heroes.data?.[0]?.url || null, logo: logos.data?.[0]?.url || null, grids: (grids.data || []).slice(0, 6).map(g => g.thumb) };
    });
  } else {
    app.get('/hub/artwork', (req, res) => res.status(503).json({ configured: false, provider: 'steamgriddb' }));
  }

  keyedRoute('retroachievements', '/hub/retro/claims', HOUR, async () => {
    const data = await fetchText(`https://retroachievements.org/API/API_GetActiveClaims.php?y=${env.RETROACHIEVEMENTS_API_KEY}`);
    const list = Array.isArray(data) ? data : [];
    return {
      updatedAt: Date.now(),
      items: clean(dedupe(list.map(c => ({
        id: c.GameID,
        name: c.GameTitle,
        image: c.GameIcon ? `https://media.retroachievements.org${c.GameIcon}` : null,
        url: `https://retroachievements.org/game/${c.GameID}`,
        subtitle: c.ConsoleName,
        tag: c.User ? `by ${c.User}` : undefined,
        source: 'retroachievements',
      })))).slice(0, 30),
    };
  });

  keyedRoute('opencritic', '/hub/opencritic/week', 6 * HOUR, async () => {
    const host = env.OPENCRITIC_RAPIDAPI_HOST || 'opencritic-api.p.rapidapi.com';
    const data = await fetchAPI(`https://${host}/game/reviewed-this-week`, {
      headers: { 'x-rapidapi-key': config.apis.rapid.key, 'x-rapidapi-host': host },
    });
    const img = path => (path ? `https://img.opencritic.com/${path}` : null);
    return {
      updatedAt: Date.now(),
      items: clean((Array.isArray(data) ? data : []).map(g => ({
        id: g.id,
        name: g.name,
        image: img(g.images?.banner?.og || g.images?.box?.og),
        url: `https://opencritic.com/game/${g.id}/${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        score: g.topCriticScore > 0 ? Math.round(g.topCriticScore) : null,
        tag: g.tier,
        source: 'opencritic',
      }))),
    };
  });
}
