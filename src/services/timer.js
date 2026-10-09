// Timer & time entries. Timer segments are opened/closed by RPCs so the
// "one running timer per user" rule and the todo→in_progress move are atomic.
// duration_seconds is a generated column and is never sent.
import { dayStartInstant, dayEndInstant } from '../utils/date.js';
import {
  AppError, db, run, rpc, rpcOr, invalid, pick, requireId, requireNonEmpty, vText, vInstant, vUuidOrNull, isDay, numify, single,
  fetchPaged,
} from './errors.js';

export const ENTRY_COLS = 'id, task_id, description, started_at, ended_at, duration_seconds, source, created_at, updated_at';
const SELECT = `${ENTRY_COLS}, task:tasks(id, title, category_id)`;
export const ENTRY_WRITABLE = ['task_id', 'description', 'started_at', 'ended_at'];
const MAX_MANUAL_MS = 24 * 3600 * 1000;

const normalize = (rows) => numify(rows, ['duration_seconds']);

/** Start a segment (auto-stops any running one). RPC start_timer. */
export async function start(taskId = null, description = null) {
  const desc = vText(description, 'description', { max: 500, label: 'Mô tả' });
  const row = await rpc('start_timer', { p_task_id: taskId || null, p_description: desc });
  return normalize(single(row));
}

/** Close the running segment. Returns the closed entry or null. RPC stop_timer. */
export async function stop() {
  const row = single(await rpc('stop_timer'));
  // A composite NULL can arrive as an object whose fields are all null.
  if (!row || row.id == null) return null;
  return normalize(row);
}

/** {entry, task_title, elapsed_seconds, task_total_seconds} or null. */
export async function current() {
  const d = await rpcOr('timer_current', undefined, legacyCurrent);
  if (!d) return null;
  return { ...numify(d, ['elapsed_seconds', 'task_total_seconds']), entry: d.entry ? normalize(d.entry) : null };
}

/** Fallback without migration 000300: read the running segment directly. */
async function legacyCurrent() {
  const e = await run(db().from('time_entries').select(SELECT).is('ended_at', null).maybeSingle());
  if (!e) return null;
  const { task, ...entry } = e;
  return {
    entry,
    task_title: task?.title ?? null,
    elapsed_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(entry.started_at)) / 1000)),
    task_total_seconds: null,
  };
}

/** Manual entry (RPC log_time). Rejects end ≤ start, > 24h, future. */
export async function logTime(input = {}) {
  const { taskId = null, startedAt, endedAt, description = null } = input || {};
  const s = vInstant(startedAt, 'startedAt', { required: true, label: 'Thời điểm bắt đầu' });
  const e = vInstant(endedAt, 'endedAt', { required: true, label: 'Thời điểm kết thúc' });
  const ms = Date.parse(e) - Date.parse(s);
  if (ms <= 0) throw invalid('endedAt', 'Thời điểm kết thúc phải sau thời điểm bắt đầu.');
  if (ms > MAX_MANUAL_MS) throw invalid('endedAt', 'Một phiên không được dài quá 24 giờ.');
  if (Date.parse(e) > Date.now() + 60_000) throw invalid('endedAt', 'Không thể ghi giờ trong tương lai.');
  const desc = vText(description, 'description', { max: 500, label: 'Mô tả' });
  const args = { p_task_id: taskId || null, p_started_at: s, p_ended_at: e, p_description: desc };
  // Without 000300: plain insert (no server-side overlap check).
  const row = await rpcOr('log_time', args, () => run(db().from('time_entries')
    .insert({ task_id: args.p_task_id, description: desc, started_at: s, ended_at: e, source: 'manual' }).select(ENTRY_COLS).single()));
  return normalize(single(row));
}

const toFrom = (v) => (isDay(v) ? dayStartInstant(v).toISOString() : vInstant(v, 'from'));
const toTo = (v) => (isDay(v) ? dayEndInstant(v).toISOString() : vInstant(v, 'to'));

/**
 * Entries that started in [from, to). `from`/`to` accept a day ('YYYY-MM-DD',
 * user timezone; `to` inclusive) or an instant.
 */
export async function listEntries(filters = {}) {
  const { from, to, taskId, limit = 2000 } = filters || {};
  let q = db().from('time_entries').select(SELECT);
  if (from) q = q.gte('started_at', toFrom(from));
  if (to) q = q.lt('started_at', toTo(to));
  if (taskId) q = q.eq('task_id', taskId);
  q = q.order('started_at', { ascending: false }).order('id', { ascending: true });
  // PostgREST returns at most max_rows (1000) per request: page up to the limit.
  return normalize(await fetchPaged(q, Math.min(Math.max(Number(limit) || 2000, 1), 5000)));
}

/** Same rules as log_time: end > start, ≤ 24h, not in the future. */
function checkSpan(startIso, endIso) {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (ms <= 0) throw invalid('ended_at', 'Thời điểm kết thúc phải sau thời điểm bắt đầu.');
  if (ms > MAX_MANUAL_MS) throw invalid('ended_at', 'Một phiên không được dài quá 24 giờ.');
}
function checkNotFuture(endIso) {
  if (Date.parse(endIso) > Date.now() + 60_000) throw invalid('ended_at', 'Không thể ghi giờ trong tương lai.');
}

/**
 * Client-side equivalent of update_time_entry for databases without migration
 * 20261009001000: validate against the stored row, reject overlaps with the
 * user's other entries (a running one counts as open-ended), then update.
 * Not atomic — the RPC is preferred whenever it exists.
 */
async function legacyUpdateEntry(id, p) {
  if ('started_at' in p || 'ended_at' in p) {
    const cur = await run(db().from('time_entries').select('id, started_at, ended_at').eq('id', id).maybeSingle());
    if (!cur) throw new AppError('not_found');
    const s = p.started_at ?? vInstant(cur.started_at, 'started_at');
    const e = 'ended_at' in p ? p.ended_at : vInstant(cur.ended_at, 'ended_at');
    if (e) checkSpan(s, e);
    let q = db().from('time_entries').select('id').neq('id', id);
    if (e) q = q.lt('started_at', e);
    q = q.or(`ended_at.is.null,ended_at.gt.${s}`).limit(1);
    const clash = await run(q);
    if (clash?.length) throw new AppError('time_overlap');
  }
  return run(db().from('time_entries').update(p).eq('id', id).select(SELECT).single());
}

/**
 * Edit an entry. Tries RPC update_time_entry (atomic: ownership, span and
 * overlap checks under a lock) and falls back to client-side checks + plain
 * update when the RPC is missing. ended_at cannot be cleared (an entry cannot
 * be re-opened); a future end, end ≤ start, > 24h or an overlap with another
 * entry (running ones count as open-ended) are rejected.
 *
 * RPC null parameters mean "unchanged", so explicit clears (task_id: null,
 * description: null) are applied with a plain update right after the RPC.
 */
export async function updateEntry(id, patch) {
  requireId(id);
  const p = pick(patch, ENTRY_WRITABLE);
  if ('task_id' in p) p.task_id = vUuidOrNull(p.task_id, 'task_id');
  if ('description' in p) p.description = vText(p.description, 'description', { max: 500, label: 'Mô tả' });
  if ('started_at' in p) p.started_at = vInstant(p.started_at, 'started_at', { required: true, label: 'Thời điểm bắt đầu' });
  if ('ended_at' in p) {
    if (patch.ended_at === null || patch.ended_at === '') throw invalid('ended_at', 'Không thể bỏ thời điểm kết thúc của một phiên đã ghi.');
    p.ended_at = vInstant(p.ended_at, 'ended_at', { required: true, label: 'Thời điểm kết thúc' });
    checkNotFuture(p.ended_at);
  }
  if (p.started_at && p.ended_at) checkSpan(p.started_at, p.ended_at);
  requireNonEmpty(p);

  // Only task/description change: no span/overlap to check → plain update.
  if (!('started_at' in p) && !('ended_at' in p)) {
    return normalize(await run(db().from('time_entries').update(p).eq('id', id).select(SELECT).single()));
  }
  const clears = Object.fromEntries(Object.entries(p).filter(([, v]) => v === null));
  const sets = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));
  const args = {
    p_id: id,
    p_task_id: sets.task_id ?? null,
    p_started_at: sets.started_at ?? null,
    p_ended_at: sets.ended_at ?? null,
    p_description: sets.description ?? null,
  };
  let viaRpc = true;
  const row = await rpcOr('update_time_entry', args, async () => {
    viaRpc = false;
    return legacyUpdateEntry(id, p);
  });
  if (!viaRpc) return normalize(row);
  const r = single(row);
  if (!r || r.id == null) throw new AppError('not_found');
  // Re-read with the task embed (and apply explicit clears) so callers get the usual shape.
  const q = Object.keys(clears).length
    ? db().from('time_entries').update(clears).eq('id', id).select(SELECT).single()
    : db().from('time_entries').select(SELECT).eq('id', id).single();
  return normalize(await run(q));
}

export async function deleteEntry(id) {
  requireId(id);
  await run(db().from('time_entries').delete().eq('id', id));
  return true;
}

/** Seconds of an entry, counting a running one up to now. */
export function entrySeconds(e, now = Date.now()) {
  if (e.duration_seconds != null) return Number(e.duration_seconds);
  return Math.max(0, Math.floor((now - new Date(e.started_at).getTime()) / 1000));
}
