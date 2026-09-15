// Social helpers: keeps every public profile findable/followable (publicProfiles mirror).
import { syncAllPublicProfiles } from '../lib/publicProfiles.js';

export default function register(app, ctx) {
  ctx.registerJob('publicProfiles', 24 * 60 * 60 * 1000, async () => {
    const db = ctx.getDb();
    if (!db) return { skipped: 'no database' };
    return syncAllPublicProfiles(db, ctx.FieldValue);
  });
}
