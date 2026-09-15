// Last good copy of cached route data in Firestore (cacheSnapshots/{key}), so a freshly restarted
// instance can still answer when an upstream API is down. Saved at most every 6 hours per key.
import { getDb, FieldValue } from './firebaseAdmin.js';

const COLLECTION = 'cacheSnapshots';
const SAVE_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 900_000;
const lastSaved = new Map();

const docId = key => key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);

export function saveSnapshot(key, value) {
  const db = getDb();
  if (!db || process.env.CACHE_SNAPSHOTS === 'false' || Date.now() - (lastSaved.get(key) || 0) < SAVE_EVERY_MS) return;
  lastSaved.set(key, Date.now());
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    return;
  }
  if (!body || body.length > MAX_BYTES) return;
  db.collection(COLLECTION).doc(docId(key)).set({ key, body, savedAt: FieldValue.serverTimestamp() })
    .catch(error => console.error(`cache snapshot save failed (${key}):`, error.message));
}

export async function loadSnapshot(key) {
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(docId(key)).get();
    if (!snap.exists) return null;
    const value = JSON.parse(snap.data().body);
    console.log(`↺ served ${key} from the Firestore snapshot (upstream failed)`);
    return value;
  } catch {
    return null;
  }
}

/** loader -> loader that saves good results and falls back to the snapshot when it throws. */
export function withSnapshot(key, loader) {
  return async () => {
    try {
      const value = await loader();
      saveSnapshot(key, value);
      return value;
    } catch (error) {
      const snapshot = await loadSnapshot(key);
      if (snapshot != null) return snapshot;
      throw error;
    }
  };
}
