// Server-side mirror users/{uid} -> publicProfiles/{uid} (+ publicBanners/{uid}).
// The browser keeps its own profile in sync (src/social/publicProfile.js); this covers users who
// have not signed in since the mirror was introduced, so every public profile can be found and followed.

const FIELDS = ['username', 'accent', 'bannerPreset', 'bio', 'playing', 'platforms', 'genres', 'xp', 'level', 'bestStreak', 'streak', 'lastActiveDate', 'libraryStats', 'challengeBadges', 'socials', 'gamingAccounts'];
const MAX_AVATAR_CHARS = 40000; // small avatars are copied as the list thumbnail; larger ones wait for the browser sync

const pick = data => Object.fromEntries(FIELDS.filter(key => data[key] !== undefined).map(key => [key, data[key]]));

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {typeof import('firebase-admin').firestore.FieldValue} FieldValue
 */
export async function syncAllPublicProfiles(db, FieldValue) {
  let written = 0;
  let removed = 0;
  let skipped = 0;
  let last = null;

  for (;;) {
    let query = db.collection('users').orderBy('__name__').limit(200);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;

    const mirrors = await db.getAll(...snap.docs.map(d => db.collection('publicProfiles').doc(d.id)));
    const batch = db.batch();

    snap.docs.forEach((userDoc, i) => {
      const data = userDoc.data();
      const mirrorRef = db.collection('publicProfiles').doc(userDoc.id);
      const bannerRef = db.collection('publicBanners').doc(userDoc.id);
      const username = typeof data.username === 'string' ? data.username.trim() : '';

      if (data.isPublic === false) {
        if (mirrors[i].exists) {
          batch.delete(mirrorRef);
          batch.delete(bannerRef);
          removed++;
        }
        return;
      }
      if (!username) {
        skipped++;
        return;
      }

      const mirror = {
        ...pick(data),
        username,
        usernameLower: username.toLowerCase(),
        hasBanner: Boolean(data.banner),
        bannerPosY: data.bannerPosY ?? 50,
        updatedAt: FieldValue.serverTimestamp(),
      };
      // Keep the browser-made thumbnail; only fill one in when there is none yet
      if (!mirrors[i].exists || !mirrors[i].data()?.avatarThumb) {
        mirror.avatarThumb = typeof data.avatar === 'string' && data.avatar.length <= MAX_AVATAR_CHARS ? data.avatar : null;
      }
      batch.set(mirrorRef, mirror, { merge: true });
      if (data.banner) batch.set(bannerRef, { banner: data.banner, bannerPosY: data.bannerPosY ?? 50 });
      written++;
    });

    await batch.commit();
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 200) break;
  }

  return { written, removed, skipped };
}
