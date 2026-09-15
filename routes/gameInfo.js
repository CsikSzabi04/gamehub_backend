// Game info for the game page: Steam Deck / ProtonDB compatibility and "what to expect" facts.
//
//   GET /hub/steam/deck/:appid    Steam Deck compatibility (Valve's report) + ProtonDB summary      (cache 12h)
//   GET /hub/steam/facts/:appid   accessibility, controller, IAP, anti-cheat, DRM, accounts, ratings (cache 24h)
//
// Keyless: only public Steam store and ProtonDB endpoints are used.

const HOUR = 3600;
const validAppid = req => (/^\d{1,9}$/.test(req.params.appid) ? req.params.appid : null);

/* ━━━━━━━━━━━━━━━━ STEAM DECK ━━━━━━━━━━━━━━━━ */

const DECK_CATEGORY = { 3: 'verified', 2: 'playable', 1: 'unsupported', 0: 'unknown' };
// display_type in Valve's report: 4 = passed, 3 = warning, 2 = failed, 1 = note
const DECK_KIND = { 4: 'ok', 3: 'warn', 2: 'fail', 1: 'info' };

const DECK_NOTES = {
  DefaultControllerConfigFullyFunctional: 'Full controller support with the default configuration',
  DefaultControllerConfigNotFullyFunctional: 'Some functionality needs the touchscreen or virtual keyboard, or a community controller layout',
  ControllerGlyphsMatchDeckDevice: 'On-screen button prompts match the Steam Deck',
  ControllerGlyphsDoNotMatchDeckDevice: 'Button prompts may show keyboard/mouse or other controller icons',
  InterfaceTextIsLegible: 'In-game text is legible on the Steam Deck screen',
  InterfaceTextIsNotLegible: 'Some in-game text is small and may be hard to read',
  DefaultConfigurationIsPerformant: 'Runs well with the default graphics settings',
  DefaultConfigurationIsNotPerformant: 'Graphics settings may need tweaking for good performance',
  TextInputDoesNotAutomaticallyInvokesKeyboard: 'Text input needs the on-screen keyboard to be opened manually',
  LauncherInteractionIssues: 'The game launcher may need the touchscreen or virtual keyboard',
  ExternalControllersNotSupportedPrimaryPlayer: 'External controllers are not supported for the primary player',
  ExternalControllersNotSupportedLocalMultiplayer: 'External controllers are not supported in local multiplayer',
  FirstTimeSetupRequiresActiveInternetConnection: 'The first launch requires an internet connection',
  SingleplayerGameplayRequiresActiveInternetConnection: 'Single-player requires an internet connection',
  MultiplayerGameplayRequiresActiveInternetConnection: 'Multiplayer requires an internet connection',
  UnsupportedAntiCheat_Other: 'Its anti-cheat is not supported on SteamOS',
  UnsupportedAntiCheatConfiguration: 'Its anti-cheat is not configured to work on SteamOS',
  SteamOSDoesNotSupport: 'Valve reports that SteamOS does not support this game',
  VideoPlaybackUnsupported: 'Some in-game videos may not play',
  NativeResolutionNotSupported: 'The Steam Deck native resolution is not supported',
  NativeResolutionNotDefault: 'The Steam Deck native resolution is not the default',
  SimultaneousInputGlyphsIssues: 'Button prompts may flicker when mixing controller and touch input',
  GameStartupFunctional: 'The game starts up correctly',
};

const humanize = token => token
  .replace(/_/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^./, c => c.toUpperCase());

const deckTokenName = locToken => String(locToken || '').replace(/^#?[A-Za-z]+_TestResult_/, '').replace(/^#/, '');

async function steamDeckReport(appid, fetchAPI) {
  const url = `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}&l=english`;
  const data = await fetchAPI(url, {}, 12000);
  const results = data?.results || {};
  const items = (results.resolved_items || [])
    .map(item => {
      const token = deckTokenName(item.loc_token);
      return { token, kind: DECK_KIND[item.display_type] || 'info', text: DECK_NOTES[token] || humanize(token) };
    })
    .filter(item => item.token);
  return { deck: DECK_CATEGORY[results.resolved_category] || 'unknown', items };
}

const PROTON_TIERS = ['platinum', 'gold', 'silver', 'bronze', 'borked', 'native', 'pending'];
const protonTier = value => {
  const tier = String(value || '').toLowerCase();
  return PROTON_TIERS.includes(tier) ? tier : null;
};

async function protonDbSummary(appid, fetchAPI) {
  try {
    const data = await fetchAPI(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`, {}, 12000);
    if (!data || !protonTier(data.tier)) return null;
    return {
      tier: protonTier(data.tier),
      trendingTier: protonTier(data.trendingTier),
      bestReportedTier: protonTier(data.bestReportedTier),
      total: Number(data.total) || 0,
      confidence: data.confidence || null,
    };
  } catch {
    return null; // 404 = no reports yet
  }
}

/* ━━━━━━━━━━━━━━━━ FACTS ━━━━━━━━━━━━━━━━ */

// Steam category id -> [stable key, English label]
const ACCESSIBILITY = {
  13: ['captions', 'Captions available'],
  65: ['subtitles', 'Subtitle options'],
  64: ['textSize', 'Adjustable text size'],
  66: ['colorAlternatives', 'Color alternatives'],
  67: ['cameraComfort', 'Camera comfort'],
  68: ['customVolume', 'Custom volume controls'],
  69: ['stereo', 'Stereo sound'],
  70: ['surround', 'Surround sound'],
  71: ['narratedMenus', 'Narrated game menus'],
  72: ['speechToText', 'Chat speech-to-text'],
  73: ['textToSpeech', 'Chat text-to-speech'],
  74: ['noTimedInput', 'Playable without timed input'],
  75: ['keyboardOnly', 'Keyboard only option'],
  76: ['mouseOnly', 'Mouse only option'],
  77: ['touchOnly', 'Touch only option'],
  78: ['adjustableDifficulty', 'Adjustable difficulty'],
  79: ['saveAnytime', 'Save anytime'],
};

// Array (not object) so the display order is kept
const MULTIPLAYER = [
  [2, 'singlePlayer', 'Single-player'],
  [1, 'multiPlayer', 'Multi-player'],
  [20, 'mmo', 'MMO'],
  [49, 'pvp', 'PvP'],
  [36, 'onlinePvp', 'Online PvP'],
  [47, 'lanPvp', 'LAN PvP'],
  [37, 'splitScreenPvp', 'Shared/Split screen PvP'],
  [9, 'coop', 'Co-op'],
  [38, 'onlineCoop', 'Online co-op'],
  [48, 'lanCoop', 'LAN co-op'],
  [39, 'splitScreenCoop', 'Shared/Split screen co-op'],
  [24, 'splitScreen', 'Shared/Split screen'],
  [27, 'crossPlatform', 'Cross-platform multiplayer'],
  [44, 'remotePlayTogether', 'Remote Play Together'],
];

const CONTENT_DESCRIPTORS = {
  1: ['nudity', 'Some nudity or sexual content'],
  2: ['violence', 'Frequent violence or gore'],
  3: ['adultSexual', 'Adult only sexual content'],
  4: ['frequentNudity', 'Frequent nudity or sexual content'],
  5: ['matureContent', 'General mature content'],
};

const ANTI_CHEATS = [
  [/easy\s*-?\s*anti\s*-?\s*cheat/i, 'Easy Anti-Cheat'],
  [/battle\s*-?\s*eye/i, 'BattlEye'],
  [/ricochet anti/i, 'Ricochet'],
  [/riot vanguard|vanguard anti/i, 'Vanguard'],
  [/punk\s*buster/i, 'PunkBuster'],
  [/game\s*guard|nprotect/i, 'nProtect GameGuard'],
  [/xigncode/i, 'XIGNCODE3'],
  [/javelin anti|ea\s*anti\s*-?\s*cheat/i, 'EA Javelin'],
  [/denuvo\s*anti\s*-?\s*cheat/i, 'Denuvo Anti-Cheat'],
  [/anti\s*-?\s*cheat\s*expert/i, 'Anti-Cheat Expert (ACE)'],
  [/faceit anti/i, 'FACEIT Anti-Cheat'],
  [/mhyprot/i, 'mhyprot'],
  [/equ8/i, 'EQU8'],
];

const RATING_BOARDS = ['pegi', 'esrb', 'usk', 'oflc', 'nzoflc', 'bbfc', 'cero', 'kgrb', 'dejus', 'csrr', 'crl', 'agcom', 'fpb', 'cadpa'];

const decode = text => String(text || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

const cleanLine = text => decode(text).replace(/\s+/g, ' ').trim();

function formatRating(board, rating) {
  const value = String(rating || '').trim();
  if (!value) return null;
  if (board === 'esrb') {
    const map = { e: 'E', e10: 'E10+', t: 'T', m: 'M', ao: 'AO', rp: 'RP', ec: 'EC' };
    return map[value.toLowerCase()] || value.toUpperCase();
  }
  return value.toUpperCase();
}

function ratingsOf(raw) {
  const ratings = {};
  for (const board of RATING_BOARDS) {
    const r = raw?.[board];
    const rating = formatRating(board, r?.rating);
    if (!rating) continue;
    const descriptors = decode(r.descriptors)
      .split(/\r?\n|;|,\s+/)
      .map(cleanLine)
      .filter(line => line && line.length <= 80)
      .slice(0, 8);
    const interactive = String(r.interactive_elements || '')
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean)
      .slice(0, 5);
    const age = Number(r.required_age);
    ratings[board] = {
      rating,
      descriptors,
      ...(interactive.length ? { interactive } : {}),
      ...(Number.isFinite(age) && age > 0 && age < 100 ? { age } : {}),
    };
  }
  return ratings;
}

function detectAntiCheat(details, categoryIds) {
  const found = [];
  if (categoryIds.has(8)) found.push('Valve Anti-Cheat (VAC)');
  const text = [
    details.drm_notice,
    details.legal_notice,
    details.pc_requirements?.minimum,
    details.pc_requirements?.recommended,
    details.detailed_description,
  ].map(decode).join(' \n ');
  for (const [pattern, name] of ANTI_CHEATS) {
    if (pattern.test(text) && !found.includes(name)) found.push(name);
  }
  return found;
}

async function steamFacts(appid, fetchAPI) {
  const [raw, deck] = await Promise.all([
    fetchAPI(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, {}, 15000),
    steamDeckReport(appid, fetchAPI).catch(() => null),
  ]);
  const entry = raw?.[appid];
  if (!entry?.success || !entry.data) {
    const error = new Error('Steam app not found');
    error.status = 404;
    throw error;
  }
  const d = entry.data;
  const categories = Array.isArray(d.categories) ? d.categories : [];
  const categoryIds = new Set(categories.map(c => Number(c.id)));
  const pick = table => (Array.isArray(table) ? table : Object.entries(table).map(([id, rest]) => [id, ...rest]))
    .filter(([id]) => categoryIds.has(Number(id)))
    .map(([, key, label]) => ({ key, label }));

  const ratingText = Object.values(d.ratings || {})
    .map(r => `${r?.descriptors || ''}\n${r?.interactive_elements || ''}`)
    .join('\n');
  // Category 35 = microtransactions; rating boards also count DLC as "In-Game Purchases", so that is only a hint
  const inAppPurchases = categoryIds.has(35);
  const randomItems = /random items|zufällige|chance-based|loot box/i.test(ratingText);

  const controller = d.controller_support === 'full' || categoryIds.has(28)
    ? 'full'
    : d.controller_support === 'partial' || categoryIds.has(18) ? 'partial' : null;

  const antiCheats = detectAntiCheat(d, categoryIds);
  const deckTokens = new Set((deck?.items || []).map(i => i.token));
  const antiCheatDeckIssue = [...deckTokens].some(token => /UnsupportedAntiCheat/i.test(token));
  const antiCheat = antiCheats.length ? antiCheats.join(', ') : antiCheatDeckIssue ? 'Anti-cheat (type not disclosed)' : null;

  const drmNotice = cleanLine(d.drm_notice) || (/denuvo/i.test(decode(d.legal_notice)) ? 'Denuvo Anti-Tamper' : null);
  const accountNotice = cleanLine(d.ext_user_account_notice) || null;

  // Online requirement: heuristics from Valve's Deck testing, store categories and notices
  const noticeText = `${decode(d.pc_requirements?.minimum)} ${decode(d.drm_notice)}`;
  const singlePlayer = categoryIds.has(2);
  const onlineCategories = [1, 20, 36, 38, 49].some(id => categoryIds.has(id));
  const localOnly = [24, 37, 39, 47, 48].some(id => categoryIds.has(id));
  let onlineRequired = null;
  let onlineReason = null;
  if (deckTokens.has('SingleplayerGameplayRequiresActiveInternetConnection')) {
    onlineRequired = true; onlineReason = 'singleplayerRequiresInternet';
  } else if (/(always|persistent|permanent)[\s-]+(online|internet)|internet connection (is )?required to play/i.test(noticeText)) {
    onlineRequired = true; onlineReason = 'notice';
  } else if (!singlePlayer && onlineCategories && !localOnly) {
    onlineRequired = true; onlineReason = 'onlineOnly';
  } else if (deckTokens.has('FirstTimeSetupRequiresActiveInternetConnection')) {
    onlineRequired = false; onlineReason = 'firstLaunch';
  } else if (singlePlayer && (deck?.deck === 'verified' || deck?.deck === 'playable')) {
    onlineRequired = false; onlineReason = 'offlineSingleplayer';
  }

  const descriptorIds = Array.isArray(d.content_descriptors?.ids) ? d.content_descriptors.ids : [];
  const contentDescriptors = descriptorIds
    .map(id => CONTENT_DESCRIPTORS[id])
    .filter(Boolean)
    .map(([key, label]) => ({ key, label }));

  const requiredAge = Number.parseInt(d.required_age, 10);

  return {
    appid: Number(appid),
    accessibility: pick(ACCESSIBILITY),
    controller,
    inAppPurchases,
    randomItems,
    antiCheat,
    antiCheatDeckIssue,
    drmNotice,
    accountNotice,
    onlineRequired,
    onlineReason,
    contentDescriptors,
    contentNotes: cleanLine(d.content_descriptors?.notes).slice(0, 300) || null,
    ratings: ratingsOf(d.ratings),
    requiredAge: Number.isFinite(requiredAge) && requiredAge > 0 && requiredAge < 100 ? requiredAge : 0,
    multiplayer: pick(MULTIPLAYER),
    familySharing: categoryIds.has(62),
  };
}

export default function register(app, ctx) {
  const { paramRoute, fetchAPI } = ctx;

  paramRoute('/hub/steam/deck/:appid', 12 * HOUR, validAppid, async req => {
    const appid = req.params.appid;
    const [report, protondb] = await Promise.all([
      steamDeckReport(appid, fetchAPI).catch(() => null),
      protonDbSummary(appid, fetchAPI),
    ]);
    if (!report && !protondb) {
      const error = new Error('Compatibility data unavailable');
      error.status = 502;
      throw error;
    }
    return {
      appid: Number(appid),
      deck: report?.deck || 'unknown',
      deckNotes: (report?.items || []).map(i => i.text),
      deckItems: report?.items || [],
      protondb,
    };
  });

  paramRoute('/hub/steam/facts/:appid', 24 * HOUR, validAppid, req => steamFacts(req.params.appid, fetchAPI));
}
