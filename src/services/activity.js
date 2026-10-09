// Activity feed. Rows are written by SECURITY DEFINER triggers only; the user
// may read and clear their own feed.
import { db, run, vNumber } from './errors.js';

export const ACTIVITY_COLS = 'id, entity_type, entity_id, action, title, metadata, created_at';

export async function recent(limit = 20) {
  const n = vNumber(limit, 'limit', { min: 1, max: 200, integer: true }) ?? 20;
  const rows = await run(db().from('activity_logs').select(ACTIVITY_COLS).order('created_at', { ascending: false }).limit(n));
  return (rows || []).map((r) => ({ ...r, metadata: r.metadata || {} }));
}

/** Delete every row of the user's feed (RLS limits it to their own rows). */
export async function clear() {
  // PostgREST refuses an unfiltered DELETE; this filter matches every row.
  await run(db().from('activity_logs').delete().gte('created_at', '1970-01-01T00:00:00Z'));
  return true;
}

export { recent as recentActivity, clear as clearActivity };
