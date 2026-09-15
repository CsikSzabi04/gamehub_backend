// Error monitoring and deep health checks, without a third-party service.
//
// Errors (server and browser) are grouped by signature in Firestore errorLogs/{signature}:
//   { source: 'server'|'client', name, message, stack, count, firstSeen, lastSeen, lastContext, alertedAt }
// A new signature (and every 10x more occurrences) pushes a notification to the admins in ADMIN_UIDS
// (comma separated Firebase uids), at most once per signature per 6 hours and 20 alerts a day.
//
//   POST /client-errors    browser error reports (rate limited, sanitized)
//   GET  /health/deep      Firestore, env and job checks: 200 ok / 503 when something critical fails.
//                          With header x-cron-key: $CRON_SECRET the answer also has the failure details.
//   GET  /admin/errors     x-cron-key: latest grouped errors
import crypto from 'node:crypto';
import { getDb, adminReady, FieldValue } from './firebaseAdmin.js';
import { sendToUser, pushConfig } from './push.js';

const COLLECTION = 'errorLogs';
const WRITE_EVERY_MS = 60 * 1000;
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_ALERTS_PER_DAY = 20;
const IGNORED_CLIENT = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /chrome-extension:|moz-extension:|safari-extension:/i,
  /Loading chunk \d+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i,
  /NetworkError when attempting to fetch|Failed to fetch|Load failed|The network connection was lost/i,
  /AbortError|The user aborted a request/i,
];

const pending = new Map(); // signature -> { data, count, lastWriteAt }
let alertsToday = { day: '', count: 0 };
const bootAt = Date.now();

const clip = (value, max) => String(value ?? '').slice(0, max);
const adminUids = () => String(process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const authorized = req => Boolean(process.env.CRON_SECRET) && req.headers['x-cron-key'] === process.env.CRON_SECRET;

/** Same error in different requests -> same signature (numbers, ids and quoted values are masked). */
function signatureOf(source, name, message, stack) {
  const normalized = clip(message, 300)
    .replace(/[0-9a-f]{16,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/(["'`]).*?\1/g, '"…"');
  const frame = String(stack || '').split('\n').find(line => /^\s+at\s|@/.test(line)) || '';
  const frameKey = frame.replace(/:\d+:\d+\)?\s*$/, '').replace(/\?[^)\s]*/, '').trim();
  return crypto.createHash('sha1').update(`${source}|${name}|${normalized}|${frameKey}`).digest('hex').slice(0, 24);
}

async function maybeAlert(ref, data, count, isNew) {
  const admins = adminUids();
  if (!admins.length) return;
  const day = new Date().toISOString().slice(0, 10);
  if (alertsToday.day !== day) alertsToday = { day, count: 0 };
  const milestone = count === 10 || count === 100 || count === 1000;
  if (!isNew && !milestone) return;
  if (alertsToday.count >= MAX_ALERTS_PER_DAY) return;
  const snap = await ref.get();
  const alertedAt = snap.data()?.alertedAt?.toMillis?.() || 0;
  if (!isNew && Date.now() - alertedAt < ALERT_EVERY_MS) return;
  alertsToday.count++;
  await ref.set({ alertedAt: FieldValue.serverTimestamp() }, { merge: true });
  for (const uid of admins) {
    await sendToUser(uid, {
      type: 'system',
      title: `${isNew ? 'New' : `${count}×`} ${data.source} error: ${clip(data.name, 40)}`,
      body: clip(data.message, 200),
      url: '/',
      tag: `error-${ref.id}`,
    }, { force: true }).catch(() => {});
  }
}

async function flush(signature) {
  const db = getDb();
  const entry = pending.get(signature);
  if (!db || !entry || !entry.count || process.env.MONITOR_STORE === 'false') return;
  const count = entry.count;
  entry.count = 0;
  entry.lastWriteAt = Date.now();
  const ref = db.collection(COLLECTION).doc(signature);
  try {
    const isNew = !(await ref.get()).exists;
    await ref.set({
      ...entry.data,
      count: FieldValue.increment(count),
      lastSeen: FieldValue.serverTimestamp(),
      ...(isNew ? { firstSeen: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });
    const total = (await ref.get()).data()?.count || count;
    await maybeAlert(ref, entry.data, total, isNew);
  } catch (error) {
    // Never let monitoring break the app (e.g. Firestore credentials are the problem)
    console.error('monitor: could not store error:', error.message);
  }
}

/**
 * Records an error. Writes are batched per signature (at most once a minute).
 * @param {unknown} error
 * @param {{ source?: 'server'|'client', path?: string, method?: string, status?: number, release?: string, userAgent?: string, url?: string }} context
 */
export function captureError(error, context = {}) {
  const source = context.source === 'client' ? 'client' : 'server';
  const name = clip(error?.name || 'Error', 80);
  const message = clip(error?.message || error, 500);
  const stack = clip(error?.stack, 3000);
  const signature = signatureOf(source, name, message, stack);
  const entry = pending.get(signature) || { data: null, count: 0, lastWriteAt: 0 };
  entry.data = {
    source,
    name,
    message,
    stack,
    lastContext: {
      path: clip(context.path, 200) || null,
      method: clip(context.method, 10) || null,
      status: Number(context.status) || null,
      release: clip(context.release, 40) || null,
      userAgent: clip(context.userAgent, 200) || null,
      url: clip(context.url, 300) || null,
    },
  };
  entry.count++;
  pending.set(signature, entry);
  if (pending.size > 500) pending.delete(pending.keys().next().value);
  if (Date.now() - entry.lastWriteAt >= WRITE_EVERY_MS) flush(signature);
  else if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      flush(signature);
    }, WRITE_EVERY_MS).unref();
  }
  return signature;
}

/** Logs and records crashes instead of letting an unhandled promise rejection kill the instance. */
export function installProcessHandlers() {
  process.on('unhandledRejection', reason => {
    console.error('Unhandled promise rejection:', reason?.stack || reason);
    captureError(reason instanceof Error ? reason : new Error(String(reason)), { path: 'unhandledRejection' });
  });
  process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error?.stack || error);
    captureError(error, { path: 'uncaughtException' });
    // State may be corrupt: give the write a moment, then let Render restart the instance
    const signature = [...pending.keys()].pop();
    Promise.race([flush(signature), new Promise(resolve => setTimeout(resolve, 1500))]).finally(() => process.exit(1));
  });
}

/** Express error middleware (register after all routes). */
export function errorMiddleware(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number(error?.status || error?.statusCode) || 500;
  if (status >= 500) {
    console.error(`Unhandled error on ${req.method} ${req.path}:`, error?.stack || error);
    captureError(error, { path: req.path, method: req.method, status });
  }
  res.status(status).json({ success: false, error: { message: status >= 500 ? 'Internal server error' : clip(error?.message, 200) } });
}

/** Wraps res.status so every 5xx response of a route is recorded, even when the route handled the error itself. */
export function capture5xx(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 500 && res.statusCode !== 503) {
      const message = typeof body?.error === 'string' ? body.error : body?.error?.message || `HTTP ${res.statusCode}`;
      const detail = typeof body?.detail === 'string' ? ` (${body.detail})` : '';
      captureError(Object.assign(new Error(`${message}${detail}`), { name: `HTTP ${res.statusCode}` }), {
        path: req.route?.path || req.path,
        method: req.method,
        status: res.statusCode,
      });
    }
    return originalJson(body);
  };
  next();
}

/* ───────── Deep health ───────── */

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms))]);

export async function deepHealth({ jobs = [] } = {}) {
  const checks = {};
  const details = {};
  let critical = false;

  if (!adminReady()) {
    checks.firestore = 'not_configured';
    critical = true;
  } else {
    try {
      const started = Date.now();
      const snap = await withTimeout(getDb().collection('meta').doc('jobs').get(), 8000);
      checks.firestore = 'ok';
      details.firestoreMs = Date.now() - started;
      const lastRuns = snap.exists ? snap.data() : {};
      const stale = jobs
        .filter(job => Date.now() - (lastRuns[job.name] || 0) > Math.max(job.everyMs * 3, 2 * 60 * 60 * 1000))
        .map(job => job.name);
      checks.jobs = stale.length ? 'stale' : 'ok';
      if (stale.length) details.staleJobs = stale;
    } catch (error) {
      checks.firestore = 'fail';
      details.firestoreError = clip(error.message, 300);
      critical = true;
    }
  }

  checks.push = pushConfig().push ? 'ok' : 'missing';
  checks.steamKey = process.env.STEAM_API_KEY ? 'ok' : 'missing';
  checks.platformTokenKey = process.env.PLATFORM_TOKEN_KEY ? 'ok' : 'missing';
  checks.cronSecret = process.env.CRON_SECRET ? 'ok' : 'missing';
  checks.adminAlerts = adminUids().length ? 'ok' : 'missing';

  return {
    ok: !critical,
    checks,
    details,
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    release: process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : null,
  };
}

/** Logs loudly at boot when Firestore credentials don't work (the app keeps running in limited mode). */
export async function startupSelfCheck() {
  if (!adminReady()) return;
  try {
    await withTimeout(getDb().collection('meta').doc('jobs').get(), 10000);
    console.log('✓ Firestore credentials verified');
  } catch (error) {
    console.error('✗ FIRESTORE CHECK FAILED: reviews, profiles, alerts and sync will not work. Check FIREBASE_SERVICE_ACCOUNT.', error.message);
  }
}

/* ───────── Routes ───────── */

const clientHits = new Map();
function clientRateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (clientHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  recent.push(now);
  clientHits.set(ip, recent);
  if (clientHits.size > 5000) clientHits.delete(clientHits.keys().next().value);
  return recent.length > 20;
}

export function registerMonitorRoutes(app, { listJobs, registerJob }) {
  // Privacy policy: error reports are kept for at most 90 days
  registerJob?.('errorLogCleanup', 24 * 60 * 60 * 1000, async () => {
    const db = getDb();
    if (!db) return { skipped: 'no db' };
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (;;) {
      const snap = await db.collection(COLLECTION).where('lastSeen', '<', cutoff).limit(300).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 300) break;
    }
    return { deleted };
  });

  app.post('/client-errors', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (clientRateLimited(req)) return res.status(429).json({ ok: false });
    const reports = (Array.isArray(req.body?.errors) ? req.body.errors : [req.body]).slice(0, 5);
    let stored = 0;
    for (const report of reports) {
      const message = clip(report?.message, 500).trim();
      if (!message || IGNORED_CLIENT.some(re => re.test(message) || re.test(String(report?.stack || '')))) continue;
      captureError({ name: clip(report?.name || 'Error', 80), message, stack: clip(report?.stack, 3000) }, {
        source: 'client',
        path: clip(report?.path, 200),
        release: clip(report?.release, 40),
        userAgent: clip(req.headers['user-agent'], 200),
        url: clip(report?.url, 300),
      });
      stored++;
    }
    res.status(202).json({ ok: true, stored });
  });

  app.get('/health/deep', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = await deepHealth({ jobs: listJobs() });
    const body = authorized(req) ? result : { ok: result.ok, checks: result.checks, uptimeSec: result.uptimeSec, release: result.release };
    res.status(result.ok ? 200 : 503).json(body);
  });

  app.get('/admin/errors', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authorized(req)) return res.status(401).json({ error: 'Invalid cron key' });
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'Firestore not configured' });
    const snap = await db.collection(COLLECTION).orderBy('lastSeen', 'desc').limit(50).get();
    res.json({
      errors: snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          source: data.source,
          name: data.name,
          message: data.message,
          count: data.count,
          firstSeen: data.firstSeen?.toDate?.().toISOString() || null,
          lastSeen: data.lastSeen?.toDate?.().toISOString() || null,
          lastContext: data.lastContext || null,
          stack: clip(data.stack, 800),
        };
      }),
    });
  });
}
