// Full backup / restore of the signed-in user's data.
//
// exportAll()  → JSON object of every user table (rows without user_id).
// parseBackup(file) → validated backup + per-table counts (for a preview).
// importAll(backup) → inserts COPIES of the rows into the current account:
//   * every row gets a fresh UUID; foreign keys are remapped through the
//     old→new id map (categories → tasks → time entries → KPIs → …),
//   * user_id is never sent (column default auth.uid(), RLS + composite FKs
//     make it impossible to touch another account),
//   * categories are matched by (kind, name) with existing ones instead of
//     being duplicated; budgets already set for the same month/category are
//     skipped; running timers are skipped.
// Nothing is ever deleted or updated in existing data.
import { toCSV, downloadText } from '../utils/csv.js';
import { today } from '../utils/date.js';
import { db, run, invalid } from './errors.js';
import { fetchAll } from './reports.js';
import { NOTE_WRITABLE } from './notes.js';

// Note columns a backup may restore. Unknown columns (e.g. from a newer schema) are
// dropped instead of failing every row.
const NOTE_RESTORABLE = new Set([...NOTE_WRITABLE, 'created_at']);

export const BACKUP_APP = 'note-mytasks';
export const BACKUP_VERSION = 1;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK = 500;

/**
 * Tables in dependency order. `cols` = columns copied on import (never id,
 * user_id or DB-owned columns such as completed_at, current_value,
 * actual_minutes, duration_seconds, total_price). `optional` tables may be
 * missing on the server.
 */
export const BACKUP_TABLES = [
  { table: 'categories', label: 'Danh mục', cols: ['kind', 'name', 'color', 'sort_order', 'created_at'] },
  { table: 'tasks', label: 'Công việc', cols: ['title', 'description', 'status', 'priority', 'category_id', 'tags', 'due_date', 'estimated_minutes', 'created_at'] },
  { table: 'time_entries', label: 'Phiên tính giờ', cols: ['task_id', 'description', 'started_at', 'ended_at', 'source', 'created_at'] },
  { table: 'kpis', label: 'KPI', cols: ['name', 'description', 'unit', 'target_value', 'start_date', 'end_date', 'status', 'created_at'] },
  { table: 'kpi_records', label: 'Bản ghi KPI', cols: ['kpi_id', 'recorded_on', 'value', 'note', 'created_at'] },
  { table: 'expenses', label: 'Khoản chi', cols: ['amount', 'category_id', 'description', 'spent_on', 'payment_method', 'note', 'created_at'] },
  { table: 'budgets', label: 'Ngân sách', cols: ['effective_month', 'category_id', 'amount', 'created_at'] },
  { table: 'shopping_items', label: 'Mua sắm', cols: ['name', 'category_id', 'unit_price', 'quantity', 'priority', 'status', 'purchased_on', 'url', 'note', 'expense_id', 'created_at'] },
  { table: 'notes', label: 'Ghi chú', cols: null, optional: true },
];
const TABLE_NAMES = BACKUP_TABLES.map((t) => t.table);
export const tableLabel = (name) => BACKUP_TABLES.find((t) => t.table === name)?.label || name;

/** Columns a generic (unknown-schema) table never receives on import. */
const GENERIC_SKIP = new Set(['id', 'user_id', 'updated_at', 'search', 'search_vector', 'fts', 'tsv']);
/** Foreign key column → table whose id map remaps it. */
const FK = { category_id: 'categories', task_id: 'tasks', kpi_id: 'kpis', expense_id: 'expenses', note_id: 'notes', parent_id: 'notes', recurrence_parent_id: 'tasks' };

const isMissingTable = (e) => ['schema_missing', 'feature_unavailable', 'forbidden'].includes(e?.code)
  || /PGRST205|42P01/.test(String(e?.cause?.code || '')) || /does not exist|could not find the table/i.test(String(e?.cause?.message || ''));

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

async function readTable(table) {
  const c = db();
  const rows = await fetchAll(() => c.from(table).select('*').order('id', { ascending: true }));
  // user_id never leaves the account; generated search vectors are rebuilt by the DB.
  return rows.map(({ user_id, search, ...rest }) => rest); // eslint-disable-line no-unused-vars
}

/**
 * exportAll() → { app, version, exported_at, tables: {name: rows[]}, counts, missing[] }
 * Optional tables that do not exist on the server are listed in `missing`.
 */
export async function exportAll(opts = {}) {
  const { onProgress } = opts || {};
  const tables = {};
  const missing = [];
  for (const [i, t] of BACKUP_TABLES.entries()) {
    onProgress?.({ table: t.table, label: t.label, step: i + 1, total: BACKUP_TABLES.length });
    try {
      tables[t.table] = await readTable(t.table);
    } catch (e) {
      // Optional tables (notes) may not exist yet on the server; any other
      // failure (network, 5xx, expired session) must abort the export.
      if (t.optional && isMissingTable(e)) { missing.push(t.table); continue; }
      throw e;
    }
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { app: BACKUP_APP, version: BACKUP_VERSION, exported_at: new Date().toISOString(), tables, counts, missing };
}

export const backupFilename = (d = today()) => `note-mytasks-backup-${d}.json`;

/** Export and download as note-mytasks-backup-YYYY-MM-DD.json. Returns the backup. */
export async function downloadBackup(opts) {
  const data = await exportAll(opts);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: backupFilename() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return data;
}

/** CSV of one table, every column except user_id. Returns the row count. */
export async function downloadTableCsv(table) {
  if (!TABLE_NAMES.includes(table)) throw invalid('table', 'Bảng dữ liệu không hợp lệ.');
  const rows = await readTable(table);
  const keys = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  const columns = keys.map((k) => ({ label: k, value: (r) => (r[k] != null && typeof r[k] === 'object' && !Array.isArray(r[k]) ? JSON.stringify(r[k]) : r[k]) }));
  downloadText(`${table.replace(/_/g, '-')}_${today()}.csv`, toCSV(rows, columns.length ? columns : [{ label: 'id', key: 'id' }]));
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Parse / validate                                                    */
/* ------------------------------------------------------------------ */

/**
 * Read a File (or JSON text) → { backup, counts, total, exported_at, unknown[] }.
 * Throws AppError('invalid_input') with a Vietnamese message when invalid.
 */
export async function parseBackup(file) {
  let text = file;
  if (typeof file !== 'string') {
    if (!file) throw invalid('file', 'Hãy chọn tệp sao lưu (.json).');
    if (file.size > MAX_FILE_BYTES) throw invalid('file', 'Tệp quá lớn (tối đa 50 MB).');
    text = await file.text();
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw invalid('file', 'Tệp không phải JSON hợp lệ.');
  }
  if (!data || typeof data !== 'object' || !data.tables || typeof data.tables !== 'object') {
    throw invalid('file', 'Tệp không đúng định dạng sao lưu của Note_mytasks.');
  }
  if (data.app && data.app !== BACKUP_APP) throw invalid('file', 'Tệp sao lưu không phải của Note_mytasks.');
  if (Number(data.version) > BACKUP_VERSION) throw invalid('file', 'Tệp được tạo bởi phiên bản mới hơn — hãy cập nhật ứng dụng.');
  const tables = {};
  const unknown = [];
  for (const [name, rows] of Object.entries(data.tables)) {
    if (!TABLE_NAMES.includes(name)) { unknown.push(name); continue; }
    if (!Array.isArray(rows)) throw invalid('file', `Bảng "${name}" trong tệp bị hỏng.`);
    tables[name] = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  }
  const counts = Object.fromEntries(BACKUP_TABLES.map((t) => [t.table, tables[t.table]?.length || 0]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (!total) throw invalid('file', 'Tệp sao lưu không có dữ liệu nào.');
  return { backup: { ...data, tables }, counts, total, exported_at: data.exported_at || null, unknown };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const keyOf = (kind, name) => `${kind}|${String(name || '').trim().toLowerCase()}`;

async function insertChunked(table, rows, report) {
  const c = db();
  let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    try {
      // defaultToNull:false — a column missing from some rows of the batch gets its DB
      // default instead of NULL (NULL broke NOT NULL columns such as tasks.tags).
      await run(c.from(table).insert(part, { defaultToNull: false }));
      ok += part.length;
    } catch (e) {
      if (e?.code === 'session_expired' || e?.code === 'network') throw e;
      // Salvage: retry row by row so one bad row does not drop the whole chunk.
      for (const row of part) {
        try {
          await run(c.from(table).insert(row));
          ok += 1;
        } catch (err) {
          if (err?.code === 'session_expired' || err?.code === 'network') throw err;
          report.failed[table] = (report.failed[table] || 0) + 1;
          if (report.errors.length < 8) report.errors.push(`${tableLabel(table)}: ${err.message}`);
          row.__failed = true;
        }
      }
    }
  }
  report.inserted[table] = (report.inserted[table] || 0) + ok;
  return ok;
}

/**
 * importAll(backup, { onProgress }) → { inserted, skipped, failed, errors[], warnings[] }
 * `backup` is parseBackup(...).backup.
 */
export async function importAll(backup, { onProgress } = {}) {
  if (!backup?.tables) throw invalid('file', 'Dữ liệu sao lưu không hợp lệ.');
  const T = backup.tables;
  const c = db();
  const maps = Object.fromEntries(TABLE_NAMES.map((t) => [t, new Map()]));
  const report = { inserted: {}, skipped: {}, failed: {}, errors: [], warnings: [] };
  const skip = (t, n = 1) => { report.skipped[t] = (report.skipped[t] || 0) + n; };
  const step = (table) => onProgress?.({ table, label: tableLabel(table), step: TABLE_NAMES.indexOf(table) + 1, total: TABLE_NAMES.length });
  const pickCols = (row, cols) => {
    const out = {};
    for (const k of cols) if (row[k] !== undefined) out[k] = row[k];
    return out;
  };
  const mapFk = (table, oldId) => (oldId == null ? null : maps[table].get(oldId) ?? null);
  const def = (name) => BACKUP_TABLES.find((t) => t.table === name);

  // 1. categories — reuse existing (kind, name), insert the rest.
  step('categories');
  const existing = (await run(c.from('categories').select('id, kind, name'))) || [];
  const byKey = new Map(existing.map((x) => [keyOf(x.kind, x.name), x.id]));
  const newCats = [];
  for (const r of T.categories || []) {
    if (!['task', 'expense'].includes(r.kind) || !String(r.name || '').trim()) { skip('categories'); continue; }
    const k = keyOf(r.kind, r.name);
    if (byKey.has(k)) { maps.categories.set(r.id, byKey.get(k)); skip('categories'); continue; }
    const id = uuid();
    byKey.set(k, id);
    maps.categories.set(r.id, id);
    newCats.push({ id, ...pickCols(r, def('categories').cols) });
  }
  await insertChunked('categories', newCats, report);
  newCats.filter((r) => r.__failed).forEach((r) => { for (const [o, n] of maps.categories) if (n === r.id) maps.categories.delete(o); });

  // 2. tasks — parents before children; recurrence is restored afterwards with
  //    an UPDATE so the "spawn next occurrence" trigger does not fire on import.
  step('tasks');
  const tasks = T.tasks || [];
  const ids = new Set(tasks.map((r) => r.id));
  tasks.forEach((r) => maps.tasks.set(r.id, uuid()));
  const build = (r) => {
    const row = { id: maps.tasks.get(r.id), ...pickCols(r, def('tasks').cols) };
    row.category_id = mapFk('categories', r.category_id);
    if (r.recurrence_parent_id && ids.has(r.recurrence_parent_id)) row.recurrence_parent_id = maps.tasks.get(r.recurrence_parent_id);
    if (!Array.isArray(row.tags)) delete row.tags;
    return row;
  };
  const roots = tasks.filter((r) => !(r.recurrence_parent_id && ids.has(r.recurrence_parent_id))).map(build);
  const children = tasks.filter((r) => r.recurrence_parent_id && ids.has(r.recurrence_parent_id)).map(build);
  await insertChunked('tasks', roots, report);
  await insertChunked('tasks', children, report);
  [...roots, ...children].filter((r) => r.__failed).forEach((r) => {
    for (const [o, n] of maps.tasks) if (n === r.id) maps.tasks.delete(o);
  });
  const recurring = new Map();
  tasks.forEach((r) => {
    if (!r.recurrence || !maps.tasks.has(r.id)) return;
    if (!recurring.has(r.recurrence)) recurring.set(r.recurrence, []);
    recurring.get(r.recurrence).push(maps.tasks.get(r.id));
  });
  for (const [rec, list] of recurring) {
    for (let i = 0; i < list.length; i += 200) {
      try {
        await run(c.from('tasks').update({ recurrence: rec }).in('id', list.slice(i, i + 200)));
      } catch {
        report.warnings.push('Không khôi phục được thiết lập lặp lại của một số công việc.');
        break;
      }
    }
  }
  if (tasks.some((r) => r.status === 'completed')) {
    report.warnings.push('Thời điểm hoàn thành của các công việc đã xong được đặt thành lúc nhập (do cơ sở dữ liệu tự ghi).');
  }

  // 3. time entries — running timers (ended_at null) are skipped.
  step('time_entries');
  const entries = [];
  for (const r of T.time_entries || []) {
    if (!r.ended_at || !r.started_at) { skip('time_entries'); continue; }
    const row = { id: uuid(), ...pickCols(r, def('time_entries').cols) };
    row.task_id = mapFk('tasks', r.task_id);
    entries.push(row);
  }
  await insertChunked('time_entries', entries, report);

  // 4. KPIs then their records (current_value is recomputed by the DB).
  step('kpis');
  const kpis = (T.kpis || []).map((r) => {
    const id = uuid();
    maps.kpis.set(r.id, id);
    return { id, ...pickCols(r, def('kpis').cols) };
  });
  await insertChunked('kpis', kpis, report);
  kpis.filter((r) => r.__failed).forEach((r) => { for (const [o, n] of maps.kpis) if (n === r.id) maps.kpis.delete(o); });

  step('kpi_records');
  const recs = [];
  for (const r of T.kpi_records || []) {
    const kpiId = mapFk('kpis', r.kpi_id);
    if (!kpiId) { skip('kpi_records'); continue; }
    recs.push({ id: uuid(), ...pickCols(r, def('kpi_records').cols), kpi_id: kpiId });
  }
  await insertChunked('kpi_records', recs, report);

  // 5. expenses
  step('expenses');
  const exps = (T.expenses || []).map((r) => {
    const id = uuid();
    maps.expenses.set(r.id, id);
    return { id, ...pickCols(r, def('expenses').cols), category_id: mapFk('categories', r.category_id) };
  });
  await insertChunked('expenses', exps, report);
  exps.filter((r) => r.__failed).forEach((r) => { for (const [o, n] of maps.expenses) if (n === r.id) maps.expenses.delete(o); });

  // 6. budgets — never overwrite a budget already set for the same month/category.
  step('budgets');
  const have = new Set(((await run(c.from('budgets').select('effective_month, category_id'))) || []).map((b) => `${b.effective_month}|${b.category_id ?? ''}`));
  const buds = [];
  for (const r of T.budgets || []) {
    const cat = r.category_id == null ? null : mapFk('categories', r.category_id);
    if (r.category_id != null && !cat) { skip('budgets'); continue; }
    const k = `${r.effective_month}|${cat ?? ''}`;
    if (have.has(k)) { skip('budgets'); continue; }
    have.add(k);
    buds.push({ id: uuid(), ...pickCols(r, def('budgets').cols), category_id: cat });
  }
  await insertChunked('budgets', buds, report);

  // 7. shopping items
  step('shopping_items');
  const shop = (T.shopping_items || []).map((r) => ({
    id: uuid(),
    ...pickCols(r, def('shopping_items').cols),
    category_id: mapFk('categories', r.category_id),
    expense_id: mapFk('expenses', r.expense_id),
  }));
  await insertChunked('shopping_items', shop, report);

  // 8. notes (optional table, schema owned by another feature) — generic copy.
  if ((T.notes || []).length) {
    step('notes');
    (T.notes || []).forEach((r) => maps.notes.set(r.id, uuid()));
    const notes = T.notes.map((r) => {
      const row = { id: maps.notes.get(r.id) };
      for (const [k, v] of Object.entries(r)) {
        if (GENERIC_SKIP.has(k) || v === undefined || !NOTE_RESTORABLE.has(k)) continue;
        if (k in FK || (k.endsWith('_id') && k !== 'id')) row[k] = FK[k] ? mapFk(FK[k], v) : null;
        else row[k] = v;
      }
      return row;
    });
    try {
      await run(c.from('notes').select('id').limit(1));
      await insertChunked('notes', notes, report);
    } catch (e) {
      if (e?.code === 'session_expired' || e?.code === 'network') throw e;
      skip('notes', notes.length);
      report.warnings.push('Máy chủ chưa có bảng Ghi chú — bỏ qua phần ghi chú.');
    }
  }

  report.warnings = [...new Set(report.warnings)];
  return report;
}

export { exportAll as backupAll, importAll as restoreAll };
