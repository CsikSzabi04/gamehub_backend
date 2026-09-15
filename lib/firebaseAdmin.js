// Firebase Admin: Firestore access and ID-token verification for community features.
//
// Configure with ONE of:
//   FIREBASE_SERVICE_ACCOUNT          -> the service account JSON (raw or base64 encoded)
//   GOOGLE_APPLICATION_CREDENTIALS    -> path to the service account JSON file
// Without credentials every community route still answers (503 / empty), nothing crashes.
import admin from 'firebase-admin';

let db = null;
let ready = false;

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

try {
  const serviceAccount = readServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    ready = true;
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    ready = true;
  }
  if (ready) {
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    console.log('✓ Firebase Admin connected');
  } else {
    console.log('ℹ Firebase Admin not configured (FIREBASE_SERVICE_ACCOUNT): community features run in limited mode');
  }
} catch (error) {
  console.error('Firebase Admin init failed:', error.message);
  ready = false;
  db = null;
}

export const adminReady = () => ready;
export const getDb = () => db;
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

/** Verifies "Authorization: Bearer <Firebase ID token>". Returns the decoded token or null. */
export async function verifyRequest(req) {
  if (!ready) return null;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch {
    return null;
  }
}

/** Express middleware: 503 without Firebase Admin, 401 without a valid token; sets req.user = { uid, email, ... }. */
export async function requireUser(req, res, next) {
  if (!ready) return res.status(503).json({ error: 'Community features are not configured on the server' });
  const decoded = await verifyRequest(req);
  if (!decoded) return res.status(401).json({ error: 'Sign in required' });
  req.user = decoded;
  next();
}

/** Express middleware: 503 without Firebase Admin. */
export function requireDb(req, res, next) {
  if (!ready) return res.status(503).json({ error: 'Community features are not configured on the server' });
  next();
}
