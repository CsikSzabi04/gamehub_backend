// Encrypted storage of platform credentials (OpenXBL API key, PlayStation NPSSO) for auto-sync.
//
// Env: PLATFORM_TOKEN_KEY  -> any long random string (e.g. `openssl rand -base64 48`).
//      The AES-256 key is its SHA-256, so rotating the env var makes every stored secret unreadable
//      (users simply have to paste their key again).
// Firestore: platformSecrets/{uid} = { xbox?: { v, iv, tag, data, savedAt }, psn?: {...} }
//      Backend only (rules deny all client access). Values are never logged or returned to clients.
import crypto from 'node:crypto';
import { getDb, FieldValue } from './firebaseAdmin.js';

const COLLECTION = 'platformSecrets';

function key() {
  const raw = process.env.PLATFORM_TOKEN_KEY;
  if (!raw || raw.length < 16) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

export const secretsReady = () => Boolean(key() && getDb());

export function encrypt(plain) {
  const k = key();
  if (!k) throw new Error('PLATFORM_TOKEN_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decrypt(box) {
  const k = key();
  if (!k || !box?.iv || !box?.tag || !box?.data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key (rotated) or tampered value
  }
}

export async function saveSecret(uid, platform, plain) {
  const db = getDb();
  if (!db || !secretsReady()) return false;
  await db.collection(COLLECTION).doc(uid).set(
    { [platform]: { ...encrypt(plain), savedAt: new Date().toISOString() } },
    { merge: true },
  );
  return true;
}

export async function readSecret(uid, platform) {
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection(COLLECTION).doc(uid).get();
  return snap.exists ? decrypt(snap.data()?.[platform]) : null;
}

export async function deleteSecret(uid, platform) {
  const db = getDb();
  if (!db) return;
  await db.collection(COLLECTION).doc(uid).set({ [platform]: FieldValue.delete() }, { merge: true }).catch(() => {});
}
