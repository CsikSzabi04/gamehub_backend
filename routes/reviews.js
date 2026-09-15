// Reviews + favorites (persistent in Firestore when Firebase Admin is configured, see lib/reviewsStore.js).
//
// Legacy endpoints (response shapes unchanged, used all over the frontend):
//   GET    /get-all-reviews                      -> [{ id, gameId, gameName, userId, email, username, review, rating, createdAt }]
//   POST   /submit-review   { gameId, userId, email, reviewText, rating, gameName, ...details }
//          With a valid "Authorization: Bearer <ID token>" the token uid is used and a second review of the
//          same game updates the first one (one review per user per game). Without a token: appended (old behaviour).
//   GET    /getFav?userId=                       -> [{ gameId, name }]
//   POST   /addfav          { name, userId, gameId }   (deduplicated)
//   DELETE /delfav/:gameId  { userId }            -> "OK" | { error: 'No avaible ID!' }
//
// New endpoints (never contain e-mails, hidden reviews excluded):
//   GET    /reviews?gameId=&sort=helpful|newest|rating_high|rating_low&limit=20&cursor=
//          -> { items, nextCursor, summary: { count, average, distribution, aspects, recommendedPct } }
//   GET    /reviews/mine/votes?gameId=           (signed in) -> { ids }
//   POST   /reviews/:id/vote                     (signed in) -> { voted, helpfulCount }
//   POST   /reviews/:id/report  { reason }       (signed in) -> { reportCount, hidden, alreadyReported }
//   DELETE /reviews/:id                          (signed in, own review) -> { ok: true }
import * as store from '../lib/reviewsStore.js';

const SORTS = ['helpful', 'newest', 'rating_high', 'rating_low'];

function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('reviews route error:', error.message);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : error.message });
}

export default function register(app, ctx) {
  const { verifyRequest, requireUser, sendToUser } = ctx;

  // Start loading the reviews right away so the first request is fast
  store.ensureLoaded();

  /** uid of a valid ID token, or null */
  async function tokenUid(req) {
    const decoded = await verifyRequest(req);
    return decoded?.uid || null;
  }

  // ━━━━━━━━━━━━━━━━ legacy: reviews ━━━━━━━━━━━━━━━━

  app.get('/get-all-reviews', async (req, res) => {
    try {
      await store.ensureLoaded();
      res.type('application/json').send(store.allReviewsJson());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/submit-review', async (req, res) => {
    try {
      const uid = await tokenUid(req);
      const result = await store.submitReview(req.body || {}, uid);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ...store.legacyShape(result.record), updated: result.updated });
    } catch (error) {
      fail(res, error);
    }
  });

  // ━━━━━━━━━━━━━━━━ legacy: favorites ━━━━━━━━━━━━━━━━

  app.get('/getFav', async (req, res) => {
    try {
      const uid = (await tokenUid(req)) || req.query.userId;
      res.json(await store.getFavorites(uid));
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/addfav', async (req, res) => {
    try {
      const { name, gameId } = req.body || {};
      const uid = (await tokenUid(req)) || req.body?.userId;
      if (!name || !uid || gameId === undefined || gameId === null || gameId === '') {
        return res.status(400).send({ error: 'Wrong parameters!' });
      }
      res.send(await store.addFavorite(uid, gameId, name));
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete('/delfav/:gameId', async (req, res) => {
    try {
      const uid = (await tokenUid(req)) || req.body?.userId;
      if (!req.params.gameId || !uid) return res.status(400).send({ error: 'Missing paramters!' });
      const removed = await store.removeFavorite(uid, req.params.gameId);
      if (removed) res.send('OK');
      else res.send({ error: 'No avaible ID!' });
    } catch (error) {
      fail(res, error);
    }
  });

  // ━━━━━━━━━━━━━━━━ new review API ━━━━━━━━━━━━━━━━

  app.get('/reviews', async (req, res) => {
    try {
      const gameId = String(req.query.gameId || '').trim().slice(0, 120);
      if (!gameId) return res.status(400).json({ error: 'gameId is required' });
      const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'helpful';
      res.json(await store.listForGame(gameId, { sort, limit: req.query.limit, cursor: req.query.cursor }));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/reviews/mine/votes', requireUser, async (req, res) => {
    try {
      const gameId = req.query.gameId ? String(req.query.gameId).slice(0, 120) : null;
      res.json({ ids: await store.votedIds(req.user.uid, gameId) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/reviews/:id/vote', requireUser, async (req, res) => {
    try {
      const result = await store.toggleVote(req.params.id, req.user.uid);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ voted: result.voted, helpfulCount: result.helpfulCount });

      const { milestone, record } = result;
      if (milestone && record.userId && record.userId !== 'anonymous') {
        // Only notify real accounts (old reviews carry an unverified userId)
        const notify = record.verified || (await store.userDocExists(record.userId));
        if (notify) {
          const game = record.gameName || 'a game';
          sendToUser(record.userId, {
            type: 'reviews',
            title: milestone === 1 ? 'Your review is helping players' : `${milestone} players found your review helpful`,
            body: `Your review of ${game} helped ${milestone} ${milestone === 1 ? 'player' : 'players'}`,
            url: gamePath(record.gameId),
            tag: `review-helpful-${record.id}`,
          }).catch(error => console.error('Review milestone notification failed:', error.message));
        }
      }
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/reviews/:id/report', requireUser, async (req, res) => {
    try {
      const result = await store.reportReview(req.params.id, req.user.uid, String(req.body?.reason || ''));
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete('/reviews/:id', requireUser, async (req, res) => {
    try {
      const result = await store.deleteReview(req.params.id, req.user.uid);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });
}

/** Frontend path of a game page for a review's gameId ("steam-730" -> /game/steam/730, RAWG id -> /reviews/<id>). */
function gamePath(gameId) {
  const match = /^(steam|gog)-(\d+)$/.exec(String(gameId));
  return match ? `/game/${match[1]}/${match[2]}` : `/reviews/${encodeURIComponent(gameId)}`;
}
