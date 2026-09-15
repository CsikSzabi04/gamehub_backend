// GDPR: data export (Art. 15 / 20) and account deletion (Art. 17) for the signed-in user.
//
//   GET  /account/export   (auth)  JSON download of everything stored about the user
//   POST /account/delete   (auth)  { confirm: true }  deletes all data and the Firebase Auth user.
//                          The ID token must be fresh (signed in within the last 10 minutes), otherwise
//                          403 { code: 'reauth_required' } and the client re-authenticates first.
import admin from 'firebase-admin';
import { deleteReview } from '../lib/reviewsStore.js';

const REAUTH_WINDOW_SEC = 10 * 60;
const EXPORT_COOLDOWN_MS = 2 * 60 * 1000;

const fail = (res, status, code, error) => res.status(status).json({ code, error });

/** Firestore values -> plain JSON (Timestamps as ISO strings, secrets redacted by the caller). */
function plain(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && !(value instanceof Buffer)) {
    if (typeof value.path === 'string' && typeof value.id === 'string' && value.firestore) return value.path;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export default function register(app, ctx) {
  const { getDb, requireUser } = ctx;
  const lastExport = new Map();

  const docsOf = async query => (await query.get()).docs;

  /** Documents whose id is the uid inside collection groups (votes, likes), found by scanning refs only. */
  async function docsNamed(group, uid) {
    const snap = await getDb().collectionGroup(group).select().get();
    return snap.docs.filter(d => d.id === uid);
  }

  /** Query by a uid field; falls back to a scan when a collection-group index is missing. */
  async function groupDocsWhere(group, field, uid) {
    const db = getDb();
    try {
      return await docsOf(db.collectionGroup(group).where(field, '==', uid));
    } catch {
      const snap = await db.collectionGroup(group).get();
      return snap.docs.filter(d => d.data()?.[field] === uid);
    }
  }

  async function deleteDocs(docs) {
    const db = getDb();
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return docs.length;
  }

  /* ───────── Export ───────── */

  app.get('/account/export', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    if (Date.now() - (lastExport.get(uid) || 0) < EXPORT_COOLDOWN_MS) return fail(res, 429, 'cooldown', 'Please wait a little before exporting again');
    lastExport.set(uid, Date.now());
    const db = getDb();
    try {
      const userRef = db.collection('users').doc(uid);
      const [userSnap, subcollections, publicProfile, publicBanner, secrets] = await Promise.all([
        userRef.get(),
        userRef.listCollections(),
        db.collection('publicProfiles').doc(uid).get(),
        db.collection('publicBanners').doc(uid).get(),
        db.collection('platformSecrets').doc(uid).get(),
      ]);

      const account = {};
      for (const col of subcollections) {
        const docs = await docsOf(col);
        account[col.id] = docs.map(d => {
          const data = plain(d.data());
          if (col.id === 'push' && data?.keys) data.keys = '[redacted]';
          return { id: d.id, ...data };
        });
      }

      const byUid = async (collection, field = 'uid') => (await docsOf(db.collection(collection).where(field, '==', uid))).map(d => ({ id: d.id, ...plain(d.data()) }));
      const [reviews, activity, following, followers, lfgPosts, builds, outageReports, reports, lfgRequests, votes, likes] = await Promise.all([
        byUid('reviews', 'userId'),
        byUid('activity'),
        byUid('follows', 'follower'),
        byUid('follows', 'followed'),
        byUid('lfgPosts'),
        byUid('builds'),
        byUid('outageReports'),
        byUid('reports'),
        groupDocsWhere('requests', 'uid', uid).then(docs => docs.map(d => ({ path: d.ref.path, ...plain(d.data()) }))),
        docsNamed('votes', uid).then(docs => Promise.all(docs.map(async d => ({ path: d.ref.path, ...plain((await d.ref.get()).data()) })))),
        docsNamed('likes', uid).then(docs => docs.map(d => ({ path: d.ref.path }))),
      ]);

      const firebaseUser = await admin.auth().getUser(uid).catch(() => null);
      const secretData = secrets.exists ? secrets.data() : {};

      const body = {
        exportedAt: new Date().toISOString(),
        service: 'GameDataHub',
        auth: firebaseUser ? {
          uid,
          email: firebaseUser.email || null,
          emailVerified: firebaseUser.emailVerified,
          createdAt: firebaseUser.metadata.creationTime,
          lastSignInAt: firebaseUser.metadata.lastSignInTime,
          providers: firebaseUser.providerData.map(p => p.providerId),
        } : { uid },
        profile: userSnap.exists ? plain(userSnap.data()) : null,
        account,
        publicProfile: publicProfile.exists ? plain(publicProfile.data()) : null,
        publicBanner: publicBanner.exists ? plain(publicBanner.data()) : null,
        storedPlatformKeys: Object.fromEntries(['xbox', 'psn'].filter(p => secretData[p]).map(p => [p, `stored encrypted since ${secretData[p].savedAt || 'unknown'}`])),
        reviews,
        activity,
        follows: { following, followers },
        lfg: { posts: lfgPosts, requests: lfgRequests },
        builds,
        buildLikes: likes,
        votes,
        outageReports,
        reports,
      };

      res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="gamedatahub-export-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      res.send(JSON.stringify(body, null, 2));
    } catch (error) {
      console.error('account export:', error.message);
      fail(res, 500, 'failed', 'Could not export your data');
    }
  });

  /* ───────── Delete ───────── */

  app.post('/account/delete', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.user.uid;
    if (req.body?.confirm !== true) return fail(res, 400, 'confirm_required', 'Confirmation missing');
    const authAge = Math.floor(Date.now() / 1000) - Number(req.user.auth_time || 0);
    if (!req.user.auth_time || authAge > REAUTH_WINDOW_SEC) return fail(res, 403, 'reauth_required', 'Please sign in again to delete your account');

    const db = getDb();
    const counts = {};
    try {
      // Reviews go through the store so its in-memory copy stays in step
      const reviewDocs = await docsOf(db.collection('reviews').where('userId', '==', uid));
      for (const doc of reviewDocs) await deleteReview(doc.id, uid);
      counts.reviews = reviewDocs.length;

      for (const collection of ['lfgPosts', 'builds']) {
        const docs = await docsOf(db.collection(collection).where('uid', '==', uid));
        for (const doc of docs) await db.recursiveDelete(doc.ref);
        counts[collection] = docs.length;
      }

      counts.lfgRequests = await deleteDocs(await groupDocsWhere('requests', 'uid', uid));

      const likes = await docsNamed('likes', uid);
      for (const like of likes) {
        const build = like.ref.parent.parent;
        await db.runTransaction(async tx => {
          const snap = await tx.get(build);
          tx.delete(like.ref);
          if (snap.exists && (snap.data().likeCount || 0) > 0) tx.update(build, { likeCount: admin.firestore.FieldValue.increment(-1) });
        }).catch(() => like.ref.delete());
      }
      counts.buildLikes = likes.length;
      counts.votes = await deleteDocs(await docsNamed('votes', uid));

      counts.activity = await deleteDocs(await docsOf(db.collection('activity').where('uid', '==', uid)));
      counts.follows = await deleteDocs([
        ...await docsOf(db.collection('follows').where('follower', '==', uid)),
        ...await docsOf(db.collection('follows').where('followed', '==', uid)),
      ]);
      counts.outageReports = await deleteDocs(await docsOf(db.collection('outageReports').where('uid', '==', uid)));
      counts.reports = await deleteDocs(await docsOf(db.collection('reports').where('uid', '==', uid)));

      await Promise.all(['publicProfiles', 'publicBanners', 'platformSecrets'].map(name => db.collection(name).doc(uid).delete().catch(() => {})));
      await db.recursiveDelete(db.collection('users').doc(uid));
      await admin.auth().deleteUser(uid);

      console.log(`✓ account deleted (${uid.slice(0, 6)}…)`, JSON.stringify(counts));
      res.json({ ok: true, deleted: counts });
    } catch (error) {
      console.error('account delete:', error.message);
      fail(res, 500, 'failed', 'Could not delete everything, please try again or contact support');
    }
  });
}
