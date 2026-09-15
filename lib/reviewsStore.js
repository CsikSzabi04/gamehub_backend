// Reviews + favorites storage.
//
// With Firebase Admin (getDb() != null):
//   reviews/{id}                    review documents, all loaded into memory at boot (writes keep memory in sync)
//   reviews/{id}/votes/{uid}        { value: 1, createdAt }  "helpful" votes
//   reports/review_{id}_{uid}       { type:'review', targetId, reason, uid, createdAt }
//   users/{uid}/favorites/{gameId}  { gameId, name, createdAt }  read-through with a small per-user cache
// Without Firestore everything lives in process memory (old behaviour, lost on restart).
import { getDb, FieldValue, Timestamp } from './firebaseAdmin.js';

export const ASPECTS = ['graphics', 'story', 'gameplay', 'performance', 'value'];
export const PLATFORMS = ['pc', 'playstation', 'xbox', 'switch', 'mobile', 'steamdeck', 'other'];
export const REPORT_REASONS = ['spam', 'spoiler', 'offensive', 'offtopic', 'other'];
export const HIDE_AT_REPORTS = 5;
export const HELPFUL_MILESTONES = [1, 5, 10, 25, 50];

const MAX_TEXT = 5000;
const FAV_TTL_MS = 10 * 60 * 1000;
const FAV_CACHE_MAX = 2000;
const USERNAME_TTL_MS = 10 * 60 * 1000;

// ━━━━━━━━━━━━━━━━ helpers ━━━━━━━━━━━━━━━━

const clipText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const iso = date => (date ? date.toISOString() : null);

function starValue(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

function tagList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => clipText(v, 80)).filter(Boolean).slice(0, 5);
}

/** Validates the optional "details" of a review body. */
export function sanitizeDetails(body = {}) {
  const hours = Number(body.playtimeHours);
  const aspects = {};
  for (const key of ASPECTS) aspects[key] = starValue(body.aspects?.[key]);
  return {
    playtimeHours: body.playtimeHours !== null && body.playtimeHours !== '' && Number.isFinite(hours) && hours >= 0
      ? Math.min(Math.round(hours * 10) / 10, 100000)
      : null,
    platform: PLATFORMS.includes(body.platform) ? body.platform : null,
    pros: tagList(body.pros),
    cons: tagList(body.cons),
    spoiler: body.spoiler === true,
    aspects,
  };
}

// Firestore document ids can't contain "/" and can't be "." or ".."
const favDocId = gameId => {
  const id = String(gameId).replace(/\//g, '_').slice(0, 300);
  return id === '.' || id === '..' ? `_${id}` : id;
};

// ━━━━━━━━━━━━━━━━ in-memory state ━━━━━━━━━━━━━━━━

/** @type {Map<string, object>} review id -> internal record (Dates, all fields) */
const reviews = new Map();
/** review id -> Set<uid> (helpful votes; authoritative only without Firestore) */
const memoryVotes = new Map();
/** review id -> Set<uid> (reports; only without Firestore) */
const memoryReports = new Map();
/** uid -> [{ gameId, name, createdAt }] favorites (the whole store without Firestore, a cache with it) */
const favorites = new Map();
const favoritesLoadedAt = new Map();
const usernames = new Map();

let nextMemoryId = 1;
let legacyJson = null; // cached /get-all-reviews body

let loadPromise = null;
let loaded = false;

function invalidate() {
  legacyJson = null;
}

function recordFromDoc(id, data) {
  return {
    id,
    gameId: String(data.gameId ?? ''),
    gameName: data.gameName ?? null,
    userId: data.userId ?? null,
    username: data.username ?? null,
    email: data.email ?? null,
    verified: data.verified === true,
    review: data.review ?? '',
    rating: data.rating ?? null,
    playtimeHours: data.playtimeHours ?? null,
    platform: data.platform ?? null,
    pros: Array.isArray(data.pros) ? data.pros : [],
    cons: Array.isArray(data.cons) ? data.cons : [],
    spoiler: data.spoiler === true,
    aspects: data.aspects || null,
    helpfulCount: Number(data.helpfulCount) || 0,
    reportCount: Number(data.reportCount) || 0,
    hidden: data.hidden === true,
    milestonesNotified: Array.isArray(data.milestonesNotified) ? data.milestonesNotified : [],
    createdAt: toDate(data.createdAt) || new Date(0),
    updatedAt: toDate(data.updatedAt),
  };
}

function docFromRecord(r) {
  return {
    id: r.id,
    gameId: r.gameId,
    gameName: r.gameName,
    userId: r.userId,
    username: r.username,
    email: r.email,
    verified: r.verified,
    review: r.review,
    rating: r.rating,
    playtimeHours: r.playtimeHours,
    platform: r.platform,
    pros: r.pros,
    cons: r.cons,
    spoiler: r.spoiler,
    aspects: r.aspects,
    helpfulCount: r.helpfulCount,
    reportCount: r.reportCount,
    hidden: r.hidden,
    milestonesNotified: r.milestonesNotified,
    createdAt: Timestamp.fromDate(r.createdAt),
    updatedAt: r.updatedAt ? Timestamp.fromDate(r.updatedAt) : null,
  };
}

/** Shape of the old /get-all-reviews + /submit-review responses (kept 100% compatible). */
export function legacyShape(r) {
  return {
    id: r.id,
    gameId: r.gameId,
    gameName: r.gameName,
    userId: r.userId,
    // Old consumers show `email` as the author label; reviews posted without an e-mail get the username instead
    email: r.email ?? (r.username || 'Player'),
    username: r.username,
    review: r.review,
    rating: r.rating,
    createdAt: iso(r.createdAt),
  };
}

/** Public shape for the new endpoints: never contains the e-mail. */
export function publicShape(r) {
  return {
    id: r.id,
    gameId: r.gameId,
    gameName: r.gameName,
    userId: r.userId,
    username: r.username,
    review: r.review,
    rating: r.rating,
    playtimeHours: r.playtimeHours,
    platform: r.platform,
    pros: r.pros,
    cons: r.cons,
    spoiler: r.spoiler,
    aspects: r.aspects,
    helpfulCount: r.helpfulCount,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

// ━━━━━━━━━━━━━━━━ boot ━━━━━━━━━━━━━━━━

async function loadFromFirestore() {
  const db = getDb();
  if (!db) {
    loaded = true;
    return;
  }
  try {
    const snap = await db.collection('reviews').get();
    for (const doc of snap.docs) {
      // A write that happened while loading is newer than the snapshot
      if (!reviews.has(doc.id)) reviews.set(doc.id, recordFromDoc(doc.id, doc.data()));
    }
    loaded = true;
    invalidate();
    console.log(`✓ Loaded ${snap.size} reviews from Firestore`);
  } catch (error) {
    console.error('Loading reviews from Firestore failed, retrying in 60 s:', error.message);
    loadPromise = null;
    setTimeout(() => ensureLoaded(), 60 * 1000).unref?.();
  }
}

/** Starts (once) and awaits the boot load. Never throws. */
export function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadFromFirestore();
  return loadPromise;
}

export const persistent = () => Boolean(getDb());

// ━━━━━━━━━━━━━━━━ reviews ━━━━━━━━━━━━━━━━

function visible(r) {
  return !r.hidden;
}

function sortedAll() {
  return [...reviews.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** JSON body of GET /get-all-reviews: grouped by game (first-seen order), oldest first, hidden excluded. */
export function allReviewsJson() {
  if (legacyJson) return legacyJson;
  const groups = new Map();
  for (const r of sortedAll()) {
    if (!visible(r)) continue;
    if (!groups.has(r.gameId)) groups.set(r.gameId, []);
    groups.get(r.gameId).push(legacyShape(r));
  }
  legacyJson = JSON.stringify([...groups.values()].flat());
  return legacyJson;
}

export function getReview(id) {
  return reviews.get(String(id)) || null;
}

async function lookupUsername(uid) {
  const db = getDb();
  if (!db || !uid) return null;
  const hit = usernames.get(uid);
  if (hit && Date.now() - hit.at < USERNAME_TTL_MS) return hit.value;
  try {
    const snap = await db.collection('users').doc(uid).get();
    const value = snap.exists ? clipText(snap.data().username, 40) || null : null;
    usernames.set(uid, { value, at: Date.now() });
    return value;
  } catch {
    return null;
  }
}

export async function userDocExists(uid) {
  const db = getDb();
  if (!db || !uid) return false;
  try {
    return (await db.collection('users').doc(uid).get()).exists;
  } catch {
    return false;
  }
}

async function persist(r) {
  const db = getDb();
  if (db) await db.collection('reviews').doc(r.id).set(docFromRecord(r));
}

/**
 * Creates a review, or updates the author's existing review of the same game when the request is signed in.
 * @param {object} body  { gameId, userId, email, reviewText, rating, gameName, ...details }
 * @param {string|null} verifiedUid  uid from a valid ID token
 * @returns {{ record: object, updated: boolean } | { error: string }}
 */
export async function submitReview(body = {}, verifiedUid = null) {
  await ensureLoaded();
  const gameId = body.gameId === undefined || body.gameId === null ? '' : String(body.gameId).trim().slice(0, 120);
  const text = clipText(body.reviewText ?? body.review, MAX_TEXT);
  const rating = starValue(body.rating);
  if (!gameId) return { error: 'gameId is required' };
  if (!text) return { error: 'reviewText is required' };
  if (!rating) return { error: 'rating must be 1-5' };

  const details = sanitizeDetails(body);
  const userId = verifiedUid || clipText(body.userId, 128) || 'anonymous';
  const username = verifiedUid ? await lookupUsername(verifiedUid) : null;
  const email = clipText(body.email, 120) || null;
  const gameName = clipText(body.gameName, 200) || null;
  const now = new Date();

  // One review per signed-in user per game: the second submit edits the first one
  const existing = verifiedUid
    ? [...reviews.values()].find(r => r.userId === verifiedUid && r.gameId === gameId)
    : null;

  let record;
  if (existing) {
    record = {
      ...existing,
      gameName: gameName || existing.gameName,
      username: username || existing.username,
      email: email || existing.email,
      verified: true,
      review: text,
      rating,
      ...details,
      updatedAt: now,
    };
  } else {
    const db = getDb();
    const id = db ? db.collection('reviews').doc().id : String(nextMemoryId++);
    record = {
      id,
      gameId,
      gameName,
      userId,
      username,
      email,
      verified: Boolean(verifiedUid),
      review: text,
      rating,
      ...details,
      helpfulCount: 0,
      reportCount: 0,
      hidden: false,
      milestonesNotified: [],
      createdAt: now,
      updatedAt: null,
    };
  }

  await persist(record);
  reviews.set(record.id, record);
  invalidate();
  return { record, updated: Boolean(existing) };
}

/** Summary over the visible reviews of one game. */
export function summarize(list) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const aspectSums = Object.fromEntries(ASPECTS.map(k => [k, { sum: 0, n: 0 }]));
  let sum = 0;
  let recommended = 0;
  for (const r of list) {
    const stars = starValue(r.rating);
    if (stars) {
      distribution[stars]++;
      sum += stars;
      if (stars >= 4) recommended++;
    }
    for (const key of ASPECTS) {
      const v = starValue(r.aspects?.[key]);
      if (v) {
        aspectSums[key].sum += v;
        aspectSums[key].n++;
      }
    }
  }
  const rated = Object.values(distribution).reduce((a, b) => a + b, 0);
  const aspects = {};
  for (const key of ASPECTS) {
    aspects[key] = aspectSums[key].n ? Math.round((aspectSums[key].sum / aspectSums[key].n) * 10) / 10 : null;
  }
  return {
    count: list.length,
    average: rated ? Math.round((sum / rated) * 10) / 10 : null,
    distribution,
    aspects,
    recommendedPct: rated ? Math.round((recommended / rated) * 100) : null,
  };
}

const SORTS = {
  helpful: (a, b) => b.helpfulCount - a.helpfulCount || b.createdAt - a.createdAt,
  newest: (a, b) => b.createdAt - a.createdAt,
  rating_high: (a, b) => (b.rating || 0) - (a.rating || 0) || b.createdAt - a.createdAt,
  rating_low: (a, b) => (a.rating || 0) - (b.rating || 0) || b.createdAt - a.createdAt,
};

/** GET /reviews page. cursor = offset (string). */
export async function listForGame(gameId, { sort = 'helpful', limit = 20, cursor = null } = {}) {
  await ensureLoaded();
  const key = String(gameId);
  const list = [...reviews.values()].filter(r => r.gameId === key && visible(r));
  list.sort(SORTS[sort] || SORTS.helpful);
  const size = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt(cursor, 10) || 0, 0);
  const page = list.slice(offset, offset + size);
  return {
    items: page.map(publicShape),
    nextCursor: offset + size < list.length ? String(offset + size) : null,
    summary: summarize(list),
  };
}

/**
 * Toggles the helpful vote of uid on a review.
 * @returns {{ voted: boolean, helpfulCount: number, milestone: number|null, record: object } | { error: string, status: number }}
 */
export async function toggleVote(id, uid) {
  await ensureLoaded();
  const record = getReview(id);
  if (!record || record.hidden) return { error: 'Review not found', status: 404 };
  if (record.userId === uid) return { error: "You can't vote on your own review", status: 400 };

  const db = getDb();
  let voted;
  let helpfulCount;
  if (db) {
    const reviewRef = db.collection('reviews').doc(record.id);
    const voteRef = reviewRef.collection('votes').doc(uid);
    ({ voted, helpfulCount } = await db.runTransaction(async tx => {
      const [reviewSnap, voteSnap] = await Promise.all([tx.get(reviewRef), tx.get(voteRef)]);
      if (!reviewSnap.exists) throw Object.assign(new Error('Review not found'), { status: 404 });
      const current = Number(reviewSnap.data().helpfulCount) || 0;
      if (voteSnap.exists) {
        tx.delete(voteRef);
        tx.update(reviewRef, { helpfulCount: FieldValue.increment(-1) });
        return { voted: false, helpfulCount: Math.max(current - 1, 0) };
      }
      tx.set(voteRef, { value: 1, createdAt: FieldValue.serverTimestamp() });
      tx.update(reviewRef, { helpfulCount: FieldValue.increment(1) });
      return { voted: true, helpfulCount: current + 1 };
    }));
  } else {
    if (!memoryVotes.has(record.id)) memoryVotes.set(record.id, new Set());
    const set = memoryVotes.get(record.id);
    voted = !set.has(uid);
    if (voted) set.add(uid);
    else set.delete(uid);
    helpfulCount = set.size;
  }

  record.helpfulCount = helpfulCount;
  let milestone = null;
  if (voted && HELPFUL_MILESTONES.includes(helpfulCount) && !record.milestonesNotified.includes(helpfulCount)) {
    milestone = helpfulCount;
    record.milestonesNotified = [...record.milestonesNotified, helpfulCount];
    if (db) {
      await db.collection('reviews').doc(record.id)
        .update({ milestonesNotified: FieldValue.arrayUnion(helpfulCount) })
        .catch(() => {});
    }
  }
  return { voted, helpfulCount, milestone, record };
}

/** Review ids of one game (or all games) the user marked helpful. */
export async function votedIds(uid, gameId = null) {
  await ensureLoaded();
  const candidates = [...reviews.values()].filter(r => visible(r) && (gameId == null || r.gameId === String(gameId)) && r.userId !== uid);
  const db = getDb();
  if (!db) return candidates.filter(r => memoryVotes.get(r.id)?.has(uid)).map(r => r.id);
  if (!candidates.length) return [];
  const ids = [];
  // getAll: one round trip per 300 documents
  for (let i = 0; i < candidates.length; i += 300) {
    const chunk = candidates.slice(i, i + 300);
    const refs = chunk.map(r => db.collection('reviews').doc(r.id).collection('votes').doc(uid));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, index) => { if (snap.exists) ids.push(chunk[index].id); });
  }
  return ids;
}

/**
 * Reports a review (once per user). Hides it at HIDE_AT_REPORTS reports.
 * @returns {{ reportCount: number, hidden: boolean, alreadyReported: boolean } | { error: string, status: number }}
 */
export async function reportReview(id, uid, reason) {
  await ensureLoaded();
  const record = getReview(id);
  if (!record) return { error: 'Review not found', status: 404 };
  const cleanReason = REPORT_REASONS.includes(reason) ? reason : 'other';

  const db = getDb();
  let alreadyReported = false;
  let reportCount;
  if (db) {
    const reviewRef = db.collection('reviews').doc(record.id);
    const reportRef = db.collection('reports').doc(`review_${record.id}_${uid}`);
    ({ alreadyReported, reportCount } = await db.runTransaction(async tx => {
      const [reviewSnap, reportSnap] = await Promise.all([tx.get(reviewRef), tx.get(reportRef)]);
      if (!reviewSnap.exists) throw Object.assign(new Error('Review not found'), { status: 404 });
      const current = Number(reviewSnap.data().reportCount) || 0;
      if (reportSnap.exists) return { alreadyReported: true, reportCount: current };
      tx.set(reportRef, { type: 'review', targetId: record.id, reason: cleanReason, uid, createdAt: FieldValue.serverTimestamp() });
      const next = current + 1;
      tx.update(reviewRef, { reportCount: next, ...(next >= HIDE_AT_REPORTS ? { hidden: true } : {}) });
      return { alreadyReported: false, reportCount: next };
    }));
  } else {
    if (!memoryReports.has(record.id)) memoryReports.set(record.id, new Set());
    const set = memoryReports.get(record.id);
    alreadyReported = set.has(uid);
    set.add(uid);
    reportCount = set.size;
  }

  record.reportCount = reportCount;
  if (reportCount >= HIDE_AT_REPORTS && !record.hidden) {
    record.hidden = true;
    invalidate();
  }
  return { reportCount, hidden: record.hidden, alreadyReported };
}

/** Deletes the user's own review (with its votes). */
export async function deleteReview(id, uid) {
  await ensureLoaded();
  const record = getReview(id);
  if (!record) return { error: 'Review not found', status: 404 };
  if (record.userId !== uid) return { error: 'You can only delete your own review', status: 403 };
  const db = getDb();
  if (db) await db.recursiveDelete(db.collection('reviews').doc(record.id));
  reviews.delete(record.id);
  memoryVotes.delete(record.id);
  memoryReports.delete(record.id);
  invalidate();
  return { ok: true };
}

// ━━━━━━━━━━━━━━━━ favorites ━━━━━━━━━━━━━━━━

const favShape = f => ({ gameId: f.gameId, name: f.name });

function rememberFavorites(uid, list) {
  favorites.delete(uid); // re-insert = most recently used
  favorites.set(uid, list);
  favoritesLoadedAt.set(uid, Date.now());
  if (getDb() && favorites.size > FAV_CACHE_MAX) {
    const oldest = favorites.keys().next().value;
    favorites.delete(oldest);
    favoritesLoadedAt.delete(oldest);
  }
}

async function loadFavorites(uid) {
  const db = getDb();
  if (!db) return favorites.get(uid) || [];
  const cached = favorites.get(uid);
  if (cached && Date.now() - (favoritesLoadedAt.get(uid) || 0) < FAV_TTL_MS) return cached;
  const snap = await db.collection('users').doc(uid).collection('favorites').get();
  const list = snap.docs
    .map(doc => {
      const data = doc.data();
      return { gameId: data.gameId ?? doc.id, name: data.name ?? null, createdAt: toDate(data.createdAt) || new Date(0) };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  rememberFavorites(uid, list);
  return list;
}

export async function getFavorites(uid) {
  if (!uid) return [];
  return (await loadFavorites(String(uid))).map(favShape);
}

/** Adds a favorite (deduplicated by gameId). Returns { gameId, name }. */
export async function addFavorite(uid, gameId, name) {
  const key = String(uid);
  const list = [...(await loadFavorites(key))];
  const found = list.find(f => String(f.gameId) === String(gameId));
  if (found) return favShape(found);
  const fave = { gameId, name: typeof name === 'string' ? name.slice(0, 200) : name, createdAt: new Date() };
  const db = getDb();
  if (db) {
    await db.collection('users').doc(key).collection('favorites').doc(favDocId(gameId))
      .set({ gameId: fave.gameId, name: fave.name, createdAt: Timestamp.fromDate(fave.createdAt) });
  }
  list.push(fave);
  rememberFavorites(key, list);
  return favShape(fave);
}

/** Removes a favorite. Returns false when it wasn't in the list. */
export async function removeFavorite(uid, gameId) {
  const key = String(uid);
  const list = [...(await loadFavorites(key))];
  const index = list.findIndex(f => String(f.gameId) === String(gameId));
  if (index === -1) return false;
  const [removed] = list.splice(index, 1);
  const db = getDb();
  if (db) await db.collection('users').doc(key).collection('favorites').doc(favDocId(removed.gameId)).delete();
  rememberFavorites(key, list);
  return true;
}
