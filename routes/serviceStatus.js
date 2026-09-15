// Gaming service status + Steam patch notes.
//
//   GET /status/services
//     -> { services: [{ id, name, category: 'platform'|'game'|'chat', status, description, incidents: [{ name, status,
//          updatedAt, url, detail }], components: [{ name, status, latencyMs? }], url, checkedAt }], checkedAt }
//        status: operational | degraded | partial_outage | major_outage | maintenance | unknown      (cached 3 min)
//   GET /status/patchnotes?appids=730,570   (≤ 20 Steam app ids)
//     -> { items: [{ appid, gameName, title, url, date, excerpt, isPatch }] }                        (cached 30 min)
//
// Keyless sources (tested 2026-09):
//   Atlassian Statuspage summary.json: discordstatus.com, status.twitch.com, status.geforcenow.com,
//     status.epicgames.com (split into Epic Games Store / Fortnite / Rocket League / Fall Guys by component group)
//   PlayStation Network: status.playstation.com/data/statuses/region/SCEE.json (country HU)
//   Xbox: xnotify.xboxlive.com/servicestatusv6/US/en-US (XML)
//   Nintendo: www.nintendo.co.jp/netinfo/en_US/status.json
//   Riot: VALORANT (eu) / League of Legends (eun1 + euw1) channels/public/x/status/*.json
//   Steam: reachability + latency of store / community / Web API
// Not available keyless (skipped): EA, Ubisoft, Battle.net, Roblox, Minecraft.
//
// Job statusAlerts (15 min): a followed service turns major_outage (or recovers) -> notify users whose
// users/{uid}.followedServices contains the id. State: meta/serviceStatus { statuses: {id: status}, alertedAt: {id: ms} }

const SERVICES_TTL = 180;
const PATCH_TTL = 30 * 60;
const TIMEOUT = 9000;
const SEVERITY = { operational: 0, unknown: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };

const worst = statuses => statuses.reduce((acc, s) => ((SEVERITY[s] ?? 0) > (SEVERITY[acc] ?? 0) ? s : acc), 'operational');
const clip = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};
const decodeXml = text => String(text || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function fetchText(url, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'GameDataHub/1.0 (+https://gamedatahub.netlify.app)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Atlassian Statuspage ─────────────────────────────────────────────────────────────
const STATUSPAGE_COMPONENT = {
  operational: 'operational',
  degraded_performance: 'degraded',
  partial_outage: 'partial_outage',
  major_outage: 'major_outage',
  under_maintenance: 'maintenance',
};
const STATUSPAGE_INDICATOR = { none: 'operational', minor: 'degraded', major: 'partial_outage', critical: 'major_outage', maintenance: 'maintenance' };

/** summary.json -> service fields. groupId limits it to one component group; `orphans` keeps incidents without components. */
function fromStatuspage(summary, { groupId = null, orphans = true } = {}) {
  const all = summary.components || [];
  const components = groupId ? all.filter(c => c.group_id === groupId || c.id === groupId) : all.filter(c => !c.group);
  const ids = new Set(components.map(c => c.id));
  const relevant = entry => {
    const touched = (entry.components || []).map(c => c.id);
    return touched.length ? touched.some(id => ids.has(id)) : orphans;
  };
  const toIncident = entry => ({
    name: clip(entry.name, 140),
    status: entry.status,
    updatedAt: entry.updated_at || entry.created_at || null,
    url: entry.shortlink || summary.page?.url || null,
    detail: clip(entry.incident_updates?.[0]?.body, 300) || null,
  });

  const incidents = (summary.incidents || []).filter(relevant).map(toIncident);
  const maintenances = (summary.scheduled_maintenances || []).filter(relevant).map(toIncident);
  let status = worst(components.map(c => STATUSPAGE_COMPONENT[c.status] || 'operational'));
  if (!groupId && status === 'operational') status = STATUSPAGE_INDICATOR[summary.status?.indicator] || 'operational';
  if (status === 'operational' && incidents.some(i => i.status !== 'resolved' && i.status !== 'postmortem')) status = 'degraded';
  if (status === 'operational' && maintenances.some(m => m.status === 'in_progress')) status = 'maintenance';

  return {
    status,
    description: groupId ? null : summary.status?.description || null,
    incidents: [...incidents, ...maintenances].slice(0, 8),
    components: components.filter(c => !c.group).slice(0, 24).map(c => ({ name: c.name, status: STATUSPAGE_COMPONENT[c.status] || 'operational' })),
  };
}

// ── PlayStation Network ──────────────────────────────────────────────────────────────
function psnMessage(entry) {
  const messages = entry?.message?.messages || {};
  return messages['en-US'] || messages['en-GB'] || Object.values(messages)[0] || '';
}

function fromPsn(data, country = 'HU') {
  const place = (data.countries || []).find(c => c.countryCode === country) || (data.countries || []).find(c => c.countryCode === 'GB');
  if (!place) throw new Error('PSN country not found');
  const found = [];
  const collect = (node, label) => {
    for (const entry of node?.status || []) found.push({ entry, label });
  };
  collect(place, 'PlayStation Network');
  const components = (place.services || []).map(service => {
    const label = service.i18n?.['en-US'] || service.serviceName;
    const before = found.length;
    collect(service, label);
    for (const resource of service.resources || []) collect(resource, `${label} – ${resource.i18n?.['en-US'] || resource.resourceName}`);
    const own = found.slice(before);
    const status = worst(own.map(({ entry }) => (/maint/i.test(entry.statusType) ? 'maintenance' : 'partial_outage')));
    return { name: label, status };
  });

  const outages = found.filter(({ entry }) => !/maint/i.test(entry.statusType));
  const affected = components.filter(c => c.status === 'partial_outage').length;
  let status = 'operational';
  if (found.length && !outages.length) status = 'maintenance';
  if (outages.length) status = affected >= 3 ? 'major_outage' : 'partial_outage';

  return {
    status,
    description: null,
    incidents: found.slice(0, 8).map(({ entry, label }) => ({
      name: `${label}${entry.statusType ? ` (${entry.statusType})` : ''}`,
      status: /maint/i.test(entry.statusType) ? 'maintenance' : 'investigating',
      updatedAt: entry.modifiedDate || entry.startDate || null,
      url: 'https://status.playstation.com/',
      detail: clip(psnMessage(entry), 300) || null,
    })),
    components,
  };
}

// ── Xbox (XML) ───────────────────────────────────────────────────────────────────────
function xboxState(name) {
  const value = String(name || '').toLowerCase();
  if (!value || value === 'none' || value === 'ok' || value === 'active') return 'operational';
  if (value.includes('maint') || value.includes('schedul')) return 'maintenance';
  if (value.includes('major') || value.includes('outage') || value.includes('down')) return 'major_outage';
  if (value.includes('impact') || value.includes('partial')) return 'partial_outage';
  return 'degraded'; // "Limited" and anything new
}

function fromXbox(xml) {
  if (!xml.includes('<ServiceStatus')) throw new Error('Unexpected Xbox status response');
  const overall = xboxState(/<Overall><State>([^<]*)<\/State>/.exec(xml)?.[1]);
  const components = [];
  const incidents = [];
  for (const block of xml.split('<Category>').slice(1)) {
    const category = decodeXml(/^<Id>\d+<\/Id><Name>([^<]*)<\/Name>/.exec(block)?.[1] || '');
    const categoryState = xboxState(/^<Id>\d+<\/Id><Name>[^<]*<\/Name><Status><Name>([^<]*)<\/Name>/.exec(block)?.[1]);
    const scenarioStates = [];
    for (const scenario of block.split('<Scenario>').slice(1)) {
      const state = xboxState(/<Status><Name>([^<]*)<\/Name>/.exec(scenario)?.[1]);
      scenarioStates.push(state);
      if (state === 'operational') continue;
      const name = decodeXml(/<\/Status><Name>([^<]*)<\/Name>/.exec(scenario)?.[1] || '');
      const updated = /<LastUpdated>([^<]*)<\/LastUpdated>/.exec(scenario)?.[1] || null;
      const description = decodeXml(/<Description>([^<]*)<\/Description>/.exec(scenario)?.[1] || '');
      incidents.push({
        name: clip(`${category} – ${name}`, 140),
        status: state,
        updatedAt: updated,
        url: 'https://support.xbox.com/xbox-live-status',
        detail: clip(description, 300) || null,
      });
    }
    if (category) components.push({ name: category, status: worst([categoryState, ...scenarioStates]) });
  }
  return {
    status: worst([overall, ...components.map(c => c.status)]),
    description: null,
    incidents: incidents.slice(0, 8),
    components,
  };
}

// ── Nintendo ─────────────────────────────────────────────────────────────────────────
function fromNintendo(data) {
  const cleanTime = text => String(text || '').replace(/\s+:/g, ':').replace(/\s+/g, ' ').replace(/^\w+day, /, '').trim();
  const map = (entry, kind) => {
    const ongoing = String(entry.event_status) === '1';
    const status = kind === 'maintenance' ? (ongoing ? 'maintenance' : 'scheduled') : ongoing ? 'investigating' : 'resolved';
    const platforms = (entry.platform || []).join(', ');
    return {
      ongoing,
      kind,
      incident: {
        name: clip(`${entry.software_title}${platforms ? ` (${platforms})` : ''}`, 140),
        status,
        updatedAt: null,
        period: `${cleanTime(entry.begin)} – ${cleanTime(entry.end)} PT`,
        url: 'https://www.nintendo.co.uk/Support/Network-Status/Network-Status-652969.html',
        detail: clip(entry.message, 300) || null,
      },
    };
  };
  const events = [
    ...(data.operational_statuses || []).map(e => map(e, 'outage')),
    ...(data.temporary_maintenances || []).map(e => map(e, 'maintenance')),
  ];
  let status = 'operational';
  if (events.some(e => e.ongoing && e.kind === 'maintenance')) status = 'maintenance';
  if (events.some(e => e.ongoing && e.kind === 'outage')) status = 'partial_outage';
  const order = e => (e.ongoing ? 0 : e.incident.status === 'scheduled' ? 1 : 2);
  return {
    status,
    description: null,
    incidents: events.sort((a, b) => order(a) - order(b)).slice(0, 8).map(e => e.incident),
    components: [],
  };
}

// ── Riot ─────────────────────────────────────────────────────────────────────────────
const enUS = list => (list || []).find(t => t.locale === 'en_US')?.content || list?.[0]?.content || '';

function fromRiot(regions, statusUrl) {
  const incidents = [];
  const statuses = [];
  for (const region of regions) {
    for (const entry of region.incidents || []) {
      const severity = entry.incident_severity;
      statuses.push(severity === 'critical' ? 'major_outage' : severity === 'warning' ? 'partial_outage' : 'operational');
      incidents.push({ entry, region: region.name, status: severity === 'info' ? 'info' : 'investigating' });
    }
    for (const entry of region.maintenances || []) {
      const active = entry.maintenance_status === 'in_progress';
      if (active) statuses.push('maintenance');
      incidents.push({ entry, region: region.name, status: active ? 'maintenance' : entry.maintenance_status || 'scheduled' });
    }
  }
  const rank = s => ({ investigating: 0, maintenance: 1, scheduled: 2, info: 3 }[s] ?? 4);
  return {
    status: worst(statuses),
    description: null,
    incidents: incidents
      .sort((a, b) => rank(a.status) - rank(b.status) || String(b.entry.updated_at).localeCompare(String(a.entry.updated_at)))
      .slice(0, 8)
      .map(({ entry, region, status }) => ({
        name: clip(`${enUS(entry.titles)} (${region})`, 140),
        status,
        updatedAt: entry.updated_at || entry.created_at || null,
        url: statusUrl,
        detail: clip(enUS(entry.updates?.[0]?.translations), 300) || null,
      })),
    components: regions.map(r => ({ name: r.name, status: worst([...(r.incidents || []).map(e => (e.incident_severity === 'critical' ? 'major_outage' : e.incident_severity === 'warning' ? 'partial_outage' : 'operational')), ...(r.maintenances || []).map(m => (m.maintenance_status === 'in_progress' ? 'maintenance' : 'operational'))]) })),
  };
}

// ── Steam (reachability) ─────────────────────────────────────────────────────────────
async function probe(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'GameDataHub/1.0 status probe' } });
    await res.arrayBuffer().catch(() => null);
    return { ok: res.status < 500, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

async function steamStatus() {
  const targets = [
    { name: 'Store', url: 'https://store.steampowered.com/api/appdetails?appids=10&filters=basic' },
    { name: 'Community', url: 'https://steamcommunity.com/market/' },
    { name: 'Web API', url: 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/' },
  ];
  const results = await Promise.all(targets.map(t => probe(t.url)));
  const components = targets.map((t, i) => ({
    name: t.name,
    status: !results[i].ok ? 'major_outage' : results[i].latencyMs > 5000 ? 'degraded' : 'operational',
    latencyMs: results[i].latencyMs,
  }));
  const failed = components.filter(c => c.status === 'major_outage').length;
  let status = worst(components.map(c => (c.status === 'major_outage' ? 'partial_outage' : c.status)));
  if (failed === components.length) status = 'major_outage';
  return { status, description: null, incidents: [], components };
}

// ── Service list ─────────────────────────────────────────────────────────────────────
function buildServices(fetchAPI) {
  let epicPromise = null;
  const epic = () => (epicPromise ||= fetchAPI('https://status.epicgames.com/api/v2/summary.json', {}, TIMEOUT));
  const statuspage = host => async () => fromStatuspage(await fetchAPI(`https://${host}/api/v2/summary.json`, {}, TIMEOUT));
  const riot = (paths, statusUrl) => async () => fromRiot(await Promise.all(paths.map(p => fetchAPI(p, {}, TIMEOUT))), statusUrl);

  return [
    { id: 'steam', name: 'Steam', category: 'platform', url: 'https://store.steampowered.com/', load: steamStatus },
    { id: 'playstation', name: 'PlayStation Network', category: 'platform', url: 'https://status.playstation.com/', load: async () => fromPsn(await fetchAPI('https://status.playstation.com/data/statuses/region/SCEE.json', {}, TIMEOUT)) },
    { id: 'xbox', name: 'Xbox network', category: 'platform', url: 'https://support.xbox.com/xbox-live-status', load: async () => fromXbox(await fetchText('https://xnotify.xboxlive.com/servicestatusv6/US/en-US')) },
    { id: 'nintendo', name: 'Nintendo Online', category: 'platform', url: 'https://www.nintendo.co.uk/Support/Network-Status/Network-Status-652969.html', load: async () => fromNintendo(JSON.parse(await fetchText('https://www.nintendo.co.jp/netinfo/en_US/status.json'))) },
    { id: 'epic', name: 'Epic Games Store', category: 'platform', url: 'https://status.epicgames.com/', load: async () => fromStatuspage(await epic(), { groupId: 'khtrdkxhxjd9', orphans: true }) },
    { id: 'geforcenow', name: 'GeForce NOW', category: 'platform', url: 'https://status.geforcenow.com/', load: statuspage('status.geforcenow.com') },
    { id: 'fortnite', name: 'Fortnite', category: 'game', url: 'https://status.epicgames.com/', load: async () => fromStatuspage(await epic(), { groupId: 'wf1ys2kx4pxc', orphans: false }) },
    { id: 'rocketleague', name: 'Rocket League', category: 'game', url: 'https://status.epicgames.com/', load: async () => fromStatuspage(await epic(), { groupId: 'd4t23tydt16z', orphans: false }) },
    { id: 'fallguys', name: 'Fall Guys', category: 'game', url: 'https://status.epicgames.com/', load: async () => fromStatuspage(await epic(), { groupId: 'dht2phs32530', orphans: false }) },
    { id: 'valorant', name: 'VALORANT', category: 'game', url: 'https://status.riotgames.com/valorant?region=eu&locale=en_US', load: riot(['https://valorant.secure.dyn.riotcdn.net/channels/public/x/status/eu.json'], 'https://status.riotgames.com/valorant?region=eu&locale=en_US') },
    { id: 'lol', name: 'League of Legends', category: 'game', url: 'https://status.riotgames.com/lol?region=eun1&locale=en_US', load: riot(['https://lol.secure.dyn.riotcdn.net/channels/public/x/status/eun1.json', 'https://lol.secure.dyn.riotcdn.net/channels/public/x/status/euw1.json'], 'https://status.riotgames.com/lol?region=eun1&locale=en_US') },
    { id: 'discord', name: 'Discord', category: 'chat', url: 'https://discordstatus.com/', load: statuspage('discordstatus.com') },
    { id: 'twitch', name: 'Twitch', category: 'chat', url: 'https://status.twitch.com/', load: statuspage('status.twitch.com') },
  ];
}

export const SERVICE_IDS = ['steam', 'playstation', 'xbox', 'nintendo', 'epic', 'geforcenow', 'fortnite', 'rocketleague', 'fallguys', 'valorant', 'lol', 'discord', 'twitch'];

// ── Steam patch notes ────────────────────────────────────────────────────────────────
const PATCH_RE = /patch|hotfix|hot fix|update|release notes|changelog|change log|bug ?fix|fixes|\bv?\d+\.\d+(\.\d+)?\b/i;

function cleanExcerpt(text) {
  return clip(String(text || '')
    .replace(/\{STEAM_CLAN[A-Z_]*\}\S*/g, ' ')
    .replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\\/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'), 220);
}

export default function register(app, ctx) {
  const { cache, fetchAPI, cachedRoute, paramRoute, getDb, registerJob, sendToUsers } = ctx;
  async function loadServices() {
    const checkedAt = new Date().toISOString();
    // A fresh Epic summary for each round (shared by the 4 Epic services)
    const round = buildServices(fetchAPI);
    const results = await Promise.all(round.map(async service => {
      try {
        const data = await service.load();
        return { id: service.id, name: service.name, category: service.category, url: service.url, checkedAt, ...data };
      } catch (error) {
        return {
          id: service.id, name: service.name, category: service.category, url: service.url, checkedAt,
          status: 'unknown', description: null, incidents: [], components: [], error: clip(error.message, 120),
        };
      }
    }));
    return { services: results, checkedAt };
  }

  const SERVICES_KEY = 'route:/status/services';
  cachedRoute('/status/services', SERVICES_TTL, loadServices);

  // Steam app names for patch notes (appdetails basic, cached 7 days)
  async function appName(appid) {
    const key = `status:appname:${appid}`;
    const hit = cache.getEntry(key);
    if (hit) return hit.value.name;
    try {
      const data = await fetchAPI(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`, {}, 8000);
      const name = data?.[appid]?.success ? data[appid].data?.name || null : null;
      cache.set(key, { name }, name ? 7 * 86400 : 3600);
      return name;
    } catch {
      return null;
    }
  }

  async function appPatchNotes(appid) {
    const data = await fetchAPI(
      `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=15&maxlength=600&feeds=steam_community_announcements`,
      {}, 12000,
    ).catch(() => null);
    const news = data?.appnews?.newsitems || [];
    const isPatch = item => PATCH_RE.test(item.title || '') || (item.tags || []).includes('patchnotes');
    const patches = news.filter(isPatch);
    const chosen = (patches.length ? patches.slice(0, 2) : news.slice(0, 1));
    if (!chosen.length) return [];
    const gameName = await appName(appid);
    return chosen.map(item => ({
      appid,
      gameName,
      title: clip(item.title, 160),
      url: item.gid ? `https://store.steampowered.com/news/app/${appid}/view/${item.gid}` : item.url,
      date: item.date ? new Date(item.date * 1000).toISOString() : null,
      excerpt: cleanExcerpt(item.contents),
      isPatch: isPatch(item),
    }));
  }

  const parseAppids = req => {
    const ids = [...new Set(String(req.query.appids || '').split(',').map(s => s.trim()).filter(s => /^\d{1,8}$/.test(s)))];
    return ids.length && ids.length <= 20 ? ids.map(Number).sort((a, b) => a - b) : null;
  };

  paramRoute('/status/patchnotes', PATCH_TTL, req => parseAppids(req)?.join(','), async req => {
    const ids = parseAppids(req);
    const results = [];
    // Limited concurrency: 4 apps at a time
    for (let i = 0; i < ids.length; i += 4) {
      results.push(...(await Promise.all(ids.slice(i, i + 4).map(appPatchNotes))).flat());
    }
    results.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { items: results.slice(0, 40) };
  });

  // Outage alerts for followers
  registerJob('statusAlerts', 15 * 60 * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no db' };
    const { services: current } = await cache.refresh(SERVICES_KEY, SERVICES_TTL, loadServices);
    const metaRef = db.collection('meta').doc('serviceStatus');
    const snap = await metaRef.get();
    const prev = snap.exists ? snap.data() : null;
    const statuses = Object.fromEntries(current.map(s => [s.id, s.status]));
    const alertedAt = { ...(prev?.alertedAt || {}) };

    const alerts = [];
    if (prev?.statuses) {
      for (const service of current) {
        const before = prev.statuses[service.id];
        if (!before || before === 'unknown' || service.status === 'unknown') continue;
        const down = service.status === 'major_outage' && before !== 'major_outage';
        const recovered = service.status === 'operational' && before === 'major_outage' && alertedAt[service.id];
        if (down && Date.now() - (alertedAt[service.id] || 0) < 2 * 60 * 60 * 1000) continue;
        if (down || recovered) alerts.push({ service, down });
      }
    }

    let notified = 0;
    for (const { service, down } of alerts) {
      const users = await db.collection('users').where('followedServices', 'array-contains', service.id).select().get();
      const uids = users.docs.map(d => d.id);
      if (down) alertedAt[service.id] = Date.now();
      else delete alertedAt[service.id];
      if (!uids.length) continue;
      const incident = service.incidents?.[0]?.name;
      await sendToUsers(uids, {
        type: 'status',
        title: down ? `${service.name} is having a major outage` : `${service.name} is back online`,
        body: down ? (incident ? `Reported: ${incident}` : 'Services may be unavailable right now.') : 'The outage appears to be resolved.',
        url: '/status',
        tag: `status-${service.id}`,
      }).catch(() => null);
      notified += uids.length;
    }

    await metaRef.set({ statuses, alertedAt, updatedAt: new Date().toISOString() });
    return { seeded: !prev?.statuses, alerts: alerts.length, notified };
  });
}
