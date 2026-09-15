// One-off: create/refresh publicProfiles/{uid} for every user (same as the daily "publicProfiles" job).
// Usage (from the backend folder): node scripts/backfill-public-profiles.js
import '../config.js';
import { getDb, FieldValue } from '../lib/firebaseAdmin.js';
import { syncAllPublicProfiles } from '../lib/publicProfiles.js';

const db = getDb();
if (!db) {
  console.error('Firebase Admin is not configured (FIREBASE_SERVICE_ACCOUNT)');
  process.exit(1);
}
const result = await syncAllPublicProfiles(db, FieldValue);
console.log('public profiles:', result);
process.exit(0);
