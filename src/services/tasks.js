// Tasks service. Bulk helpers + restore/duplicate at the bottom. Server-owned columns (user_id, actual_minutes, completed_at,
// created_at, updated_at) are never sent — DB triggers maintain them.
import { today } from '../utils/date.js';
import {
  db, run, rpc, invalid, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vDay, vUuidOrNull,
  numify, searchOr,
} from './errors.js';

export const TASK_STATUSES = ['todo', 'in_progress', 'completed', 'cancelled'];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
export const OPEN_STATUSES = ['todo', 'in_progress'];

export const TASK_COLS =
  'id, title, description, status, priority, category_id, tags, due_date, estimated_minutes, actual_minutes, ' +
  'completed_at, created_at, updated_at'; // base 000100 columns (recurrence* come via '*')
// '*' instead of TASK_COLS: works with or without migration 000300 (recurrence columns).
const SELECT = '*, category:categories(id, name, color)';

export const TASK_WRITABLE = ['title', 'description', 'status', 'priority', 'category_id', 'tags', 'due_date', 'estimated_minutes', 'recurrence'];
const MAX_TAGS = 20;

/** Trim, drop empties, case-insensitive dedupe (first spelling wins), ≤ 20. */
export function normalizeTags(tags) {
  if (tags == null || tags === '') return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (raw == null) continue;
    const t = String(raw).trim().replace(/^#/, '').trim();
    if (!t) continue;
    const key = t.toLocaleLowerCase('vi');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (out.length > MAX_TAGS) throw invalid('tags', `Tối đa ${MAX_TAGS} thẻ.`);
  return out;
}

/** Whitelist + validate. `partial` = update (only provided keys are checked). */
export function validateTask(input, { partial = false } = {}) {
  const p = pick(input, TASK_WRITABLE);
  if (!partial || 'title' in p) p.title = vText(p.title, 'title', { required: true, max: 200, label: 'Tiêu đề' });
  if ('description' in p) p.description = vText(p.description, 'description', { max: 5000, label: 'Mô tả' });
  if ('status' in p) p.status = vEnum(p.status, 'status', TASK_STATUSES, { required: true, label: 'Trạng thái' });
  if ('priority' in p) p.priority = vEnum(p.priority, 'priority', TASK_PRIORITIES, { required: true, label: 'Độ ưu tiên' });
  if ('category_id' in p) p.category_id = vUuidOrNull(p.category_id, 'category_id');
  if ('tags' in p) p.tags = normalizeTags(p.tags);
  if ('due_date' in p) p.due_date = vDay(p.due_date, 'due_date', { label: 'Hạn chót' });
  if ('estimated_minutes' in p) {
    p.estimated_minutes = vNumber(p.estimated_minutes, 'estimated_minutes', { min: 0, max: 2147483647, integer: true, label: 'Thời gian ước tính' });
  }
  if ('recurrence' in p) p.recurrence = vEnum(p.recurrence, 'recurrence', RECURRENCES, { label: 'Lặp lại' });
  return p;
}

const normalize = (rows) => numify(rows, ['estimated_minutes', 'actual_minutes']);

// supabase-js joins array values unquoted (`cs.{a,b}`), so a tag containing
// `, " { } \` or spelled NULL would be mis-parsed by Postgres (wrong matches or
// "malformed array literal"). Such tags are sent as a quoted array literal.
export function tagFilterValue(tag) {
  const t = String(tag).trim();
  if (/[,"{}\\]/.test(t) || /^null$/i.test(t)) return `{"${t.replace(/[\\"]/g, (c) => '\\' + c)}"}`;
  return [t];
}

const oneOrMany = (q, col, v) => {
  if (Array.isArray(v)) return v.length ? q.in(col, v) : q;
  return v ? q.eq(col, v) : q;
};

/**
 * @param {object} f
 * @param {string} [f.search]            title/description contains (LIKE-escaped)
 * @param {string|string[]} [f.status]
 * @param {string} [f.categoryId]        'none' = uncategorised
 * @param {string|string[]} [f.priority]
 * @param {string} [f.tag]
 * @param {string} [f.dueFrom] @param {string} [f.dueTo]   'YYYY-MM-DD'
 * @param {boolean} [f.overdue]          due before today and still open
 * @param {number} [f.limit=1000] @param {number} [f.offset=0]
 */
export async function listTasks(f = {}) {
  let q = db().from('tasks').select(SELECT);
  q = oneOrMany(q, 'status', f.status);
  q = oneOrMany(q, 'priority', f.priority);
  if (f.categoryId === 'none') q = q.is('category_id', null);
  else if (f.categoryId) q = q.eq('category_id', f.categoryId);
  if (f.tag) q = q.contains('tags', tagFilterValue(f.tag));
  if (f.dueFrom) q = q.gte('due_date', vDay(f.dueFrom, 'dueFrom'));
  if (f.dueTo) q = q.lte('due_date', vDay(f.dueTo, 'dueTo'));
  if (f.overdue) {
    q = q.lt('due_date', today());
    if (!f.status || (Array.isArray(f.status) && !f.status.length)) q = q.in('status', OPEN_STATUSES);
  }
  const s = typeof f.search === 'string' ? f.search.trim() : '';
  if (s) q = q.or(searchOr(s, ['title', 'description']));

  const limit = Math.min(Math.max(Number(f.limit) || 1000, 1), 5000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  q = q.order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  return normalize(await run(q));
}

/** Returns the task or null when it does not exist / is not visible. */
export async function getTask(id) {
  requireId(id);
  return normalize(await run(db().from('tasks').select(SELECT).eq('id', id).maybeSingle()));
}

export async function createTask(input) {
  const row = validateTask(input);
  return normalize(await run(db().from('tasks').insert(row).select(SELECT).single()));
}

export async function updateTask(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateTask(patch, { partial: true }));
  return normalize(await run(db().from('tasks').update(row).eq('id', id).select(SELECT).single()));
}

/** completed_at is maintained by a DB trigger — only status is sent. */
export async function setTaskStatus(id, status) {
  requireId(id);
  const s = vEnum(status, 'status', TASK_STATUSES, { required: true, label: 'Trạng thái' });
  return normalize(await run(db().from('tasks').update({ status: s }).eq('id', id).select(SELECT).single()));
}

export async function deleteTask(id) {
  requireId(id);
  await run(db().from('tasks').delete().eq('id', id));
  return true;
}

/** Ranked open tasks (RPC focus_tasks). */
export async function focusTasks(limit = 5) {
  const n = vNumber(limit, 'limit', { min: 1, max: 50, integer: true }) ?? 5;
  const rows = await rpc('focus_tasks', { p_limit: n });
  return numify(rows || [], ['score']).map((r) => ({ ...r, reasons: r.reasons || [] }));
}

/** {samples, accuracy_ratio, median_actual_minutes, suggested_multiplier} */
export async function estimateSuggestion(categoryId = null) {
  const d = await rpc('estimate_suggestion', { p_category_id: categoryId || null });
  if (!d) return { samples: 0, accuracy_ratio: null, median_actual_minutes: null, suggested_multiplier: null };
  return numify(d, ['samples', 'accuracy_ratio', 'median_actual_minutes', 'suggested_multiplier']);
}

/** Tasks completed in [fromIso, toIso) — for charts. */
export async function listCompletedBetween(fromIso, toIso) {
  const q = db().from('tasks').select('id, title, completed_at, category_id, actual_minutes')
    .gte('completed_at', fromIso).lt('completed_at', toIso).order('completed_at', { ascending: true });
  return normalize(await run(q));
}

// ---- Bulk operations (Tasks page multi-select) -------------------------------------

const MAX_BULK = 500;

function requireIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string' && x.trim()))];
  if (!list.length) throw invalid('ids', 'Chưa chọn công việc nào.');
  if (list.length > MAX_BULK) throw invalid('ids', `Tối đa ${MAX_BULK} công việc mỗi lần.`);
  return list;
}

/** Apply the same partial patch to many tasks. Returns the updated rows. */
export async function bulkUpdateTasks(ids, patch) {
  const list = requireIds(ids);
  const row = requireNonEmpty(validateTask(patch, { partial: true }));
  return normalize(await run(db().from('tasks').update(row).in('id', list).select(SELECT)));
}

/** Set status on many tasks (completed_at / recurrences are handled by DB triggers). */
export async function bulkSetTaskStatus(ids, status) {
  const list = requireIds(ids);
  const s = vEnum(status, 'status', TASK_STATUSES, { required: true, label: 'Trạng thái' });
  return normalize(await run(db().from('tasks').update({ status: s }).in('id', list).select(SELECT)));
}

export async function bulkDeleteTasks(ids) {
  const list = requireIds(ids);
  await run(db().from('tasks').delete().in('id', list));
  return list.length;
}

/** Writable snapshot of a task (drops server-owned columns and absent recurrence). */
export function taskSnapshot(task) {
  const snap = pick(task, TASK_WRITABLE);
  if (snap.recurrence == null) delete snap.recurrence;
  return snap;
}

/** Re-create a deleted task from a snapshot (undo). Gets a new id. */
export async function restoreTask(task) {
  return createTask(taskSnapshot(task));
}

/** Copy of a task as a fresh "todo". */
export async function duplicateTask(task, { title } = {}) {
  const snap = taskSnapshot(task);
  return createTask({ ...snap, status: 'todo', title: title || `${snap.title} (bản sao)`.slice(0, 200) });
}

// Short aliases (tasks.list / tasks.get …)
export { listTasks as list, getTask as get, createTask as create, updateTask as update, setTaskStatus as setStatus, deleteTask as remove, deleteTask as delete };
