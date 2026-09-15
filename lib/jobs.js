// Background jobs (price alerts, free games, release reminders ...).
//
// They run on a timer while the instance is awake (the keep-alive ping keeps a Render instance
// up), and can also be triggered from outside, e.g. a free cron-job.org / GitHub Actions schedule:
//   POST /cron/run            header  x-cron-key: $CRON_SECRET   (all jobs that are due)
//   POST /cron/run?job=name   header  x-cron-key: $CRON_SECRET   (one job, even if not due)
// Last run times are stored in Firestore meta/jobs so a restart does not re-run everything.
import { getDb, adminReady } from './firebaseAdmin.js';

const jobs = new Map();

/**
 * @param {string} name
 * @param {number} everyMs minimum time between two runs
 * @param {() => Promise<object|void>} run returns a short summary for logs / the cron response
 */
export function registerJob(name, everyMs, run) {
  jobs.set(name, { name, everyMs, run, running: false });
}

/** [{ name, everyMs }] for health checks. */
export const listJobs = () => [...jobs.values()].map(({ name, everyMs }) => ({ name, everyMs }));

async function lastRuns() {
  const db = getDb();
  if (!db) return {};
  const snap = await db.collection('meta').doc('jobs').get().catch(() => null);
  return snap?.exists ? snap.data() : {};
}

async function runJob(job) {
  if (job.running) return { job: job.name, skipped: 'already running' };
  job.running = true;
  const started = Date.now();
  try {
    const summary = await job.run();
    await getDb()?.collection('meta').doc('jobs').set({ [job.name]: started }, { merge: true });
    const result = { job: job.name, ok: true, ms: Date.now() - started, ...(summary || {}) };
    console.log('✓ job', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error(`✗ job ${job.name}:`, error.message);
    return { job: job.name, ok: false, error: error.message };
  } finally {
    job.running = false;
  }
}

export async function runDueJobs({ only, force = false } = {}) {
  if (!adminReady()) return [{ skipped: 'Firebase Admin not configured' }];
  const last = await lastRuns();
  const results = [];
  for (const job of jobs.values()) {
    if (only && job.name !== only) continue;
    const due = force || Date.now() - (last[job.name] || 0) >= job.everyMs;
    if (due) results.push(await runJob(job));
  }
  return results;
}

export function registerJobRoutes(app) {
  const authorized = req => process.env.CRON_SECRET && req.headers['x-cron-key'] === process.env.CRON_SECRET;

  app.post('/cron/run', async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Invalid cron key' });
    const only = typeof req.query.job === 'string' ? req.query.job : undefined;
    res.json({ results: await runDueJobs({ only, force: Boolean(only) }) });
  });

  app.get('/cron/jobs', (req, res) => {
    res.json({ jobs: [...jobs.values()].map(j => ({ name: j.name, everyMinutes: Math.round(j.everyMs / 60000) })) });
  });
}

/** Checks for due jobs every 15 minutes (first check 1 minute after boot). */
export function startJobTimer() {
  if (process.env.JOBS_TIMER === 'false') return;
  const tick = () => runDueJobs().catch(error => console.error('job timer:', error.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 15 * 60 * 1000).unref();
}
