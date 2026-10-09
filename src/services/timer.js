// Timer & time entries. Timer segments are opened/closed by RPCs so the
// "one running timer per user" rule and the todo→in_progress move are atomic.
// duration_seconds is a generated column and is never sent.
import { dayStartInstant, dayEndInstant } from '../utils/date.js';
import {
  db, run, rpc, rpcOr, invalid, pick, requireId, requireNonEmpty, vText, vInstant, vUuidOrNull, isDay, numify, single,
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
export async function logTime({ taskId = null, startedAt, endedAt, description = null } = {}) {
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
export async function listEntries({ from, to, taskId, limit = 2000 } = {}) {
  let q = db().from('time_entries').select(SELECT);
  if (from) q = q.gte('started_at', toFrom(from));
  if (to) q = q.lt('started_at', toTo(to));
  if (taskId) q = q.eq('task_id', taskId);
  q = q.order('started_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 2000, 1), 5000));
  return normalize(await run(q));
}

export async function updateEntry(id, patch) {
  requireId(id);
  const p = pick(patch, ENTRY_WRITABLE);
  if ('task_id' in p) p.task_id = vUuidOrNull(p.task_id, 'task_id');
  if ('description' in p) p.description = vText(p.description, 'description', { max: 500, label: 'Mô tả' });
  if ('started_at' in p) p.started_at = vInstant(p.started_at, 'started_at', { required: true, label: 'Thời điểm bắt đầu' });
  if ('ended_at' in p) p.ended_at = vInstant(p.ended_at, 'ended_at', { label: 'Thời điểm kết thúc' });
  if (p.started_at && p.ended_at && Date.parse(p.ended_at) <= Date.parse(p.started_at)) {
    throw invalid('ended_at', 'Thời điểm kết thúc phải sau thời điểm bắt đầu.');
  }
  requireNonEmpty(p);
  return normalize(await run(db().from('time_entries').update(p).eq('id', id).select(SELECT).single()));
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
