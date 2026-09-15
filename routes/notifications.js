// Notification endpoints: push configuration, a test message, and social events that the client
// reports after writing to Firestore (the server re-checks the documents before notifying anyone).
import { getDb, requireUser } from '../lib/firebaseAdmin.js';
import { pushConfig, sendToUser } from '../lib/push.js';

// At most 40 social notifications per user per hour (in memory, per instance)
const RATE = { windowMs: 60 * 60 * 1000, max: 40 };
const sent = new Map();
function rateLimited(uid) {
  const now = Date.now();
  const recent = (sent.get(uid) || []).filter(t => now - t < RATE.windowMs);
  recent.push(now);
  sent.set(uid, recent);
  return recent.length > RATE.max;
}

const nameOf = user => user?.username || 'Someone';

export default function register(app) {
  app.get('/notify/config', (req, res) => {
    res.json(pushConfig());
  });

  app.post('/notify/test', requireUser, async (req, res) => {
    const result = await sendToUser(req.user.uid, {
      type: 'system',
      title: 'Notifications are working 🎮',
      body: 'You will get alerts from GameDataHub on this device.',
      url: '/notifications',
    }, { force: true });
    res.json(result);
  });

  /**
   * body: { type: 'follow', targetUid }
   *     | { type: 'lfg-request', postId }
   *     | { type: 'lfg-accepted' | 'lfg-declined', postId, requesterUid }
   */
  app.post('/notify/social', requireUser, async (req, res) => {
    const db = getDb();
    const me = req.user.uid;
    const { type, targetUid, postId, requesterUid } = req.body || {};
    if (rateLimited(me)) return res.status(429).json({ error: 'Too many notifications' });

    try {
      const meSnap = await db.collection('users').doc(me).get();
      const myName = nameOf(meSnap.data());

      if (type === 'follow') {
        if (typeof targetUid !== 'string' || targetUid === me) return res.status(400).json({ error: 'Invalid target' });
        const follow = await db.collection('follows').doc(`${me}_${targetUid}`).get();
        if (!follow.exists) return res.status(404).json({ error: 'Follow not found' });
        const username = meSnap.data()?.username;
        return res.json(await sendToUser(targetUid, {
          type: 'social',
          title: `${myName} started following you`,
          body: 'Check out their profile and follow back.',
          url: username ? `/u/${encodeURIComponent(username)}` : '/feed',
          tag: `follow-${me}`,
        }));
      }

      if (type === 'lfg-request' || type === 'lfg-accepted' || type === 'lfg-declined') {
        if (typeof postId !== 'string') return res.status(400).json({ error: 'Invalid post' });
        const post = await db.collection('lfgPosts').doc(postId).get();
        if (!post.exists) return res.status(404).json({ error: 'Post not found' });
        const p = post.data();

        if (type === 'lfg-request') {
          const request = await post.ref.collection('requests').doc(me).get();
          if (!request.exists || p.uid === me) return res.status(404).json({ error: 'Request not found' });
          return res.json(await sendToUser(p.uid, {
            type: 'lfg',
            title: `${myName} wants to join your group`,
            body: `${p.gameName || 'LFG'}${request.data().message ? ` – "${String(request.data().message).slice(0, 120)}"` : ''}`,
            url: `/lfg?post=${postId}`,
            tag: `lfg-${postId}`,
          }));
        }

        if (p.uid !== me || typeof requesterUid !== 'string') return res.status(403).json({ error: 'Not your post' });
        const request = await post.ref.collection('requests').doc(requesterUid).get();
        const status = request.data()?.status;
        const expected = type === 'lfg-accepted' ? 'accepted' : 'declined';
        if (status !== expected) return res.status(409).json({ error: 'Request status mismatch' });
        return res.json(await sendToUser(requesterUid, {
          type: 'lfg',
          title: expected === 'accepted' ? `${myName} accepted you into the group` : `${myName} declined your request`,
          body: expected === 'accepted' ? `${p.gameName || 'LFG'} – open the post to see how to connect.` : `${p.gameName || 'LFG'} – there are more groups looking for players.`,
          url: `/lfg?post=${postId}`,
          tag: `lfg-${postId}`,
        }));
      }

      res.status(400).json({ error: 'Unknown notification type' });
    } catch (error) {
      console.error('notify/social:', error.message);
      res.status(500).json({ error: 'Could not send notification' });
    }
  });
}
