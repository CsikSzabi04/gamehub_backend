// Notifications: an in-app notification document + a Web Push message to every device of the user.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
// Firestore:
//   users/{uid}                       notificationPrefs: { [type]: boolean }  (missing = on)
//   users/{uid}/push/{id}             { endpoint, keys: { p256dh, auth }, userAgent, createdAt }
//   users/{uid}/notifications/{id}    { type, title, body, url, image, read, createdAt }
import webpush from 'web-push';
import { getDb, adminReady, FieldValue } from './firebaseAdmin.js';

/** Notification types. Each can be switched off in users/{uid}.notificationPrefs. */
export const NOTIFICATION_TYPES = ['priceAlerts', 'freeGames', 'releases', 'social', 'lfg', 'reviews', 'challenges', 'status', 'system'];

const env = process.env;
const pushReady = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushReady) {
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:info@gamehub.hu', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  console.log('✓ Web Push enabled');
} else {
  console.log('ℹ Web Push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY): in-app notifications only');
}

export const pushConfig = () => ({
  push: pushReady,
  community: adminReady(),
  vapidPublicKey: pushReady ? env.VAPID_PUBLIC_KEY : null,
});

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/**
 * Sends one notification to a user.
 * @param {string} uid
 * @param {{ type: string, title: string, body?: string, url?: string, image?: string, tag?: string }} n
 * @param {{ force?: boolean }} [opts] force ignores the user's preferences (e.g. a test message)
 * @returns {Promise<{ stored: boolean, pushed: number, skipped?: string }>}
 */
export async function sendToUser(uid, n, { force = false } = {}) {
  const db = getDb();
  if (!db || !uid) return { stored: false, pushed: 0, skipped: 'not-configured' };

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const prefs = userSnap.exists ? userSnap.data().notificationPrefs || {} : {};
  if (!force && prefs[n.type] === false) return { stored: false, pushed: 0, skipped: 'disabled' };

  const doc = {
    type: n.type || 'system',
    title: clip(n.title, 140) || 'GameDataHub',
    body: clip(n.body, 400) || '',
    url: clip(n.url, 500) || '/notifications',
    image: clip(n.image, 500) || null,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await userRef.collection('notifications').add(doc);

  let pushed = 0;
  if (pushReady && prefs.push !== false) {
    const subs = await userRef.collection('push').get();
    const payload = JSON.stringify({
      id: ref.id,
      title: doc.title,
      body: doc.body,
      url: doc.url,
      image: doc.image,
      tag: n.tag || doc.type,
    });
    await Promise.all(subs.docs.map(async sub => {
      const { endpoint, keys } = sub.data();
      try {
        await webpush.sendNotification({ endpoint, keys }, payload, { TTL: 60 * 60 * 24 });
        pushed++;
      } catch (error) {
        // 404/410: the browser dropped the subscription
        if (error.statusCode === 404 || error.statusCode === 410) await sub.ref.delete().catch(() => {});
        else console.error('Push failed:', error.statusCode || error.message);
      }
    }));
  }
  return { stored: true, pushed };
}

/** Sends the same notification to many users (sequential batches of 20). */
export async function sendToUsers(uids, n) {
  const unique = [...new Set(uids.filter(Boolean))];
  let pushed = 0;
  for (let i = 0; i < unique.length; i += 20) {
    const results = await Promise.allSettled(unique.slice(i, i + 20).map(uid => sendToUser(uid, n)));
    for (const r of results) if (r.status === 'fulfilled') pushed += r.value.pushed;
  }
  return { users: unique.length, pushed };
}

/** Users whose notificationPrefs[type] is not false (the preference defaults to on). Paged over the users collection. */
export async function usersWantingType(type, { limit = 5000 } = {}) {
  const db = getDb();
  if (!db) return [];
  const uids = [];
  let last = null;
  while (uids.length < limit) {
    let query = db.collection('users').orderBy('__name__').limit(500).select('notificationPrefs');
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    for (const d of snap.docs) if ((d.data().notificationPrefs || {})[type] !== false) uids.push(d.id);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return uids;
}
