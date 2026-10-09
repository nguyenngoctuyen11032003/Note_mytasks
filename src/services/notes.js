// Notes service (table public.notes, migration 000700).
// Server-owned columns (user_id, search, created_at, updated_at) are never sent.
import {
  db, run, invalid, pick, requireId, requireNonEmpty, vText, vEnum, vColor, vUuidOrNull, vInstant,
  searchOr, orValue, fetchPaged,
} from './errors.js';
import { normalizeTags, tagFilterValue } from './tasks.js';

export const NOTE_KINDS = ['note', 'checklist', 'journal', 'meeting'];
export const NOTE_COLS = 'id, title, content, notebook, tags, color, pinned, archived, trashed_at, task_id, kind, created_at, updated_at';
export const NOTE_WRITABLE = ['title', 'content', 'notebook', 'tags', 'color', 'pinned', 'archived', 'trashed_at', 'task_id', 'kind'];
export const NOTE_LIMITS = { title: 200, content: 100000, notebook: 60, tags: 20 };

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Whitelist + validate. `partial` = update (only provided keys are checked). */
export function validateNote(input, { partial = false } = {}) {
  const p = pick(input, NOTE_WRITABLE);
  if (!partial || 'title' in p) p.title = vText(p.title, 'title', { max: NOTE_LIMITS.title, label: 'Tiêu đề', keepEmpty: true });
  if (!partial || 'content' in p) {
    // Markdown: keep whitespace exactly as typed (no trim).
    const c = p.content == null ? '' : String(p.content);
    if (c.length > NOTE_LIMITS.content) throw invalid('content', `Nội dung tối đa ${NOTE_LIMITS.content.toLocaleString('vi-VN')} ký tự.`);
    p.content = c;
  }
  if ('notebook' in p) p.notebook = vText(p.notebook, 'notebook', { max: NOTE_LIMITS.notebook, label: 'Sổ ghi chú' });
  if ('tags' in p) p.tags = normalizeTags(p.tags);
  if ('color' in p) p.color = vColor(p.color, 'color');
  if ('pinned' in p) p.pinned = bool(p.pinned);
  if ('archived' in p) p.archived = bool(p.archived);
  if ('trashed_at' in p) p.trashed_at = vInstant(p.trashed_at, 'trashed_at');
  if ('task_id' in p) p.task_id = vUuidOrNull(p.task_id, 'task_id');
  if (!partial || 'kind' in p) p.kind = vEnum(p.kind ?? 'note', 'kind', NOTE_KINDS, { required: true, label: 'Loại ghi chú' });
  return p;
}

/** Text → prefix tsquery for the 'simple' config: "báo cáo" → "báo:* & cáo:*". Only letters/digits survive. */
export function toPrefixQuery(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map((w) => `${w}:*`).join(' & ');
}

/**
 * @param {object} f
 * @param {string} [f.search]    title/content contains, or any word-prefix in title/tags/content
 * @param {string} [f.notebook]  exact notebook name
 * @param {string} [f.tag]
 * @param {string} [f.kind]      note | checklist | journal | meeting
 * @param {boolean} [f.pinned]
 * @param {boolean} [f.archived=false]  ignored when trashed = true
 * @param {boolean} [f.trashed=false]
 * @param {number} [f.limit=500]
 */
export async function listNotes(filters = {}) {
  const { search, notebook, tag, kind, pinned, archived = false, trashed = false, limit } = filters || {};
  let q = db().from('notes').select(NOTE_COLS);
  if (trashed) q = q.not('trashed_at', 'is', null);
  else {
    q = q.is('trashed_at', null);
    if (archived != null) q = q.eq('archived', Boolean(archived));
  }
  if (notebook) q = q.eq('notebook', String(notebook));
  if (tag) q = q.contains('tags', tagFilterValue(tag));
  if (kind) q = q.eq('kind', vEnum(kind, 'kind', NOTE_KINDS, { label: 'Loại ghi chú' }));
  if (pinned != null) q = q.eq('pinned', Boolean(pinned));

  const s = typeof search === 'string' ? search.trim() : '';
  if (s) {
    const tsq = toPrefixQuery(s);
    const parts = [searchOr(s, ['title', 'content'])];
    if (tsq) parts.push(`search.fts(simple).${orValue(tsq)}`);
    q = q.or(parts.join(','));
  }

  const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  q = trashed
    ? q.order('trashed_at', { ascending: false })
    : q.order('pinned', { ascending: false }).order('updated_at', { ascending: false });
  // Stable tiebreak + paging: PostgREST returns at most max_rows (1000) per request.
  return fetchPaged(q.order('id', { ascending: true }), n);
}

/** The note, or null when it does not exist / is not visible. */
export async function getNote(id) {
  requireId(id);
  return run(db().from('notes').select(NOTE_COLS).eq('id', id).maybeSingle());
}

export async function createNote(input = {}) {
  const row = validateNote(input);
  return run(db().from('notes').insert(row).select(NOTE_COLS).single());
}

export async function updateNote(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateNote(patch, { partial: true }));
  return run(db().from('notes').update(row).eq('id', id).select(NOTE_COLS).single());
}

/** Soft delete → Thùng rác. */
export async function trashNote(id) {
  requireId(id);
  return run(db().from('notes').update({ trashed_at: new Date().toISOString(), pinned: false }).eq('id', id).select(NOTE_COLS).single());
}

export async function restoreNote(id) {
  requireId(id);
  return run(db().from('notes').update({ trashed_at: null }).eq('id', id).select(NOTE_COLS).single());
}

/** Permanent delete. */
export async function deleteNote(id) {
  requireId(id);
  await run(db().from('notes').delete().eq('id', id));
  return true;
}

/** Permanently delete every trashed note. Returns how many were removed. */
export async function emptyTrash() {
  const rows = await run(db().from('notes').delete().not('trashed_at', 'is', null).select('id'));
  return rows?.length || 0;
}

/** Notebooks of live (not trashed, not archived) notes → [{name, count}] sorted by name. */
export async function listNotebooks() {
  const rows = await fetchPaged(db().from('notes').select('id, notebook').is('trashed_at', null).eq('archived', false)
    .not('notebook', 'is', null).order('id', { ascending: true }));
  const m = new Map();
  for (const r of rows || []) m.set(r.notebook, (m.get(r.notebook) || 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Tags of live notes → [{tag, count}] most used first. */
export async function listNoteTags() {
  const rows = await fetchPaged(db().from('notes').select('id, tags').is('trashed_at', null).eq('archived', false)
    .order('id', { ascending: true }));
  const m = new Map();
  for (const r of rows || []) for (const t of r.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi'));
}

/**
 * One lightweight query for the notes sidebar:
 * { counts: {all, pinned, note, checklist, journal, meeting, archived, trash}, notebooks: [{name,count}], tags: [{tag,count}] }
 * (live = not trashed and not archived; notebooks/tags count live notes only).
 */
export async function noteOverview() {
  // Every note, paged past max_rows (1000), so the counts are exact.
  const rows = await fetchPaged(db().from('notes').select('id, notebook, tags, pinned, archived, kind, trashed_at').order('id', { ascending: true }));
  const counts = { all: 0, pinned: 0, note: 0, checklist: 0, journal: 0, meeting: 0, archived: 0, trash: 0 };
  const nb = new Map();
  const tg = new Map();
  for (const r of rows) {
    if (r.trashed_at) { counts.trash++; continue; }
    if (r.archived) { counts.archived++; continue; }
    counts.all++;
    if (r.pinned) counts.pinned++;
    if (r.kind in counts) counts[r.kind]++;
    if (r.notebook) nb.set(r.notebook, (nb.get(r.notebook) || 0) + 1);
    for (const t of r.tags || []) tg.set(t, (tg.get(t) || 0) + 1);
  }
  return {
    counts,
    notebooks: [...nb].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    tags: [...tg].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi')),
  };
}

/** Rename a notebook on every note that uses it (null = remove notebook). Returns rows changed. */
export async function renameNotebook(from, to) {
  const src = vText(from, 'notebook', { required: true, max: NOTE_LIMITS.notebook, label: 'Sổ ghi chú' });
  const dst = vText(to, 'notebook', { max: NOTE_LIMITS.notebook, label: 'Sổ ghi chú' });
  const rows = await run(db().from('notes').update({ notebook: dst }).eq('notebook', src).select('id'));
  return rows?.length || 0;
}

// Short aliases (notes.list / notes.get …)
export { listNotes as list, getNote as get, createNote as create, updateNote as update, deleteNote as remove, deleteNote as delete };
