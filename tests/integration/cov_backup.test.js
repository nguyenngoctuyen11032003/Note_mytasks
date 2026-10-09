// Backup / restore (src/services/backup.js) end-to-end against the LOCAL Supabase stack.
// Mirrors src/pages/settings.js: downloadBackup → (file) → parseBackup → importAll(backup, {onProgress}),
// downloadTableCsv(table) and tableLabel(name).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import * as backup from '../../src/services/backup.js';

const TABLES = ['categories', 'tasks', 'time_entries', 'kpis', 'kpi_records', 'expenses', 'budgets', 'shopping_items', 'notes'];
const isAppError = (code) => expect.objectContaining({ name: 'AppError', code });

async function ins(table, rows) {
  const { data, error } = await admin.from(table).insert(rows, { defaultToNull: false }).select('*');
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

/** Every row of every backed-up table for `uid` (service_role), ordered by id. */
async function snapshot(uid) {
  const out = {};
  for (const t of TABLES) {
    const { data, error } = await admin.from(t).select('*').eq('user_id', uid).order('id');
    if (error) throw error;
    out[t] = data;
  }
  return out;
}

/**
 * Normalise a user's snapshot so two accounts can be compared: ids/user_id/updated_at
 * dropped, every FK replaced by the natural key of the row it points at.
 * `drop` lists documented columns that are not preserved.
 */
function normalise(snap, drop = {}) {
  const idx = (t, keyFn) => new Map(snap[t].map((r) => [r.id, keyFn(r)]));
  const cat = idx('categories', (r) => `${r.kind}|${r.name}`);
  const task = idx('tasks', (r) => r.title);
  const kpi = idx('kpis', (r) => r.name);
  const exp = idx('expenses', (r) => r.description);
  const FKS = { category_id: cat, task_id: task, recurrence_parent_id: task, kpi_id: kpi, expense_id: exp };
  const out = {};
  for (const t of TABLES) {
    out[t] = snap[t].map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (['id', 'user_id', 'updated_at'].includes(k) || (drop[t] || []).includes(k)) continue;
        if (FKS[k]) {
          if (v != null) expect(FKS[k].has(v), `${t}.${k} → row of the same account`).toBe(true);
          o[k] = v == null ? null : `→${FKS[k].get(v)}`;
        } else o[k] = v;
      }
      return o;
    }).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  return out;
}

/** Minimal browser stubs for downloadBackup / downloadTableCsv in Node. */
function stubDownload() {
  const cap = { anchors: [], blobs: [], revoked: [], appended: 0 };
  vi.stubGlobal('document', {
    createElement: (tag) => {
      const a = { tag, clicked: 0, removed: 0, click() { this.clicked++; }, remove() { this.removed++; } };
      cap.anchors.push(a);
      return a;
    },
    body: { append: () => { cap.appended++; } },
  });
  const c = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { cap.blobs.push(b); return `blob:test/${cap.blobs.length}`; });
  const r = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { cap.revoked.push(u); });
  cap.restore = () => { c.mockRestore(); r.mockRestore(); vi.unstubAllGlobals(); };
  return cap;
}
const blobText = async (b) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await b.arrayBuffer());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
describe('backup.js — tableLabel / constants', () => {
  it('tableLabel maps every backup table to its Vietnamese label and unknown names to themselves', () => {
    const expected = {
      categories: 'Danh mục', tasks: 'Công việc', time_entries: 'Phiên tính giờ', kpis: 'KPI', kpi_records: 'Bản ghi KPI',
      expenses: 'Khoản chi', budgets: 'Ngân sách', shopping_items: 'Mua sắm', notes: 'Ghi chú',
    };
    expect(backup.BACKUP_TABLES.map((t) => t.table)).toEqual(TABLES);
    for (const [k, v] of Object.entries(expected)) expect(backup.tableLabel(k)).toBe(v);
    expect(backup.tableLabel('profiles')).toBe('profiles');
    expect(backup.tableLabel(undefined)).toBe(undefined);
    expect(backup.backupFilename('2026-01-02')).toBe('note-mytasks-backup-2026-01-02.json');
    expect(backup.backupFilename()).toBe(`note-mytasks-backup-${todayVN()}.json`);
    expect(backup.backupAll).toBe(backup.exportAll);
    expect(backup.restoreAll).toBe(backup.importAll);
  });
});

// ---------------------------------------------------------------------------
describe('backup.js — parseBackup validation', () => {
  const ok = { app: 'note-mytasks', version: 1, exported_at: '2026-10-01T00:00:00.000Z', tables: { tasks: [{ id: 'x', title: 'a' }] } };
  const bad = async (input, re) => {
    const p = backup.parseBackup(input);
    await expect(p).rejects.toEqual(isAppError('invalid_input'));
    await expect(backup.parseBackup(input)).rejects.toThrow(re);
    const e = await backup.parseBackup(input).catch((x) => x);
    expect(e.details).toEqual({ field: 'file' });
  };

  it('accepts a valid file (File object, string and BOM-prefixed) and reports counts / unknown tables', async () => {
    const withExtras = { ...ok, tables: { ...ok.tables, expenses: [{ id: 'e' }, null, 5, 'x', [1], { id: 'f' }], profiles: [{ id: 1 }], hacker: 'nope' } };
    const file = new File([JSON.stringify(withExtras)], 'b.json', { type: 'application/json' });
    const r = await backup.parseBackup(file);
    expect(r.counts).toEqual({ categories: 0, tasks: 1, time_entries: 0, kpis: 0, kpi_records: 0, expenses: 2, budgets: 0, shopping_items: 0, notes: 0 });
    expect(r.total).toBe(3);
    expect(r.exported_at).toBe(ok.exported_at);
    expect(r.unknown.sort()).toEqual(['hacker', 'profiles']);
    expect(Object.keys(r.backup.tables).sort()).toEqual(['expenses', 'tasks']); // unknown tables never reach importAll
    expect(r.backup.tables.expenses).toEqual([{ id: 'e' }, { id: 'f' }]); // non-object rows dropped
    expect(r.backup.app).toBe('note-mytasks');

    const s = await backup.parseBackup('﻿' + JSON.stringify(ok));
    expect(s.total).toBe(1);
    // A file without app/version (hand-made) is accepted; exported_at missing → null.
    const n = await backup.parseBackup(JSON.stringify({ tables: { notes: [{ title: 'x' }] } }));
    expect(n).toMatchObject({ total: 1, exported_at: null, unknown: [] });
    // An older version is accepted.
    expect((await backup.parseBackup(JSON.stringify({ ...ok, version: 0 }))).total).toBe(1);
  });

  it('rejects missing, oversized, malformed, foreign, newer and empty files with a clear AppError', async () => {
    await bad(null, /Hãy chọn tệp sao lưu/);
    await bad(undefined, /Hãy chọn tệp sao lưu/);
    await bad({ size: 50 * 1024 * 1024 + 1, text: async () => JSON.stringify(ok) }, /Tệp quá lớn/);
    await bad('{not json', /không phải JSON hợp lệ/);
    await bad(new File(['\x00\x01garbage'], 'x.json'), /không phải JSON hợp lệ/);
    await bad('null', /không đúng định dạng/);
    await bad('42', /không đúng định dạng/);
    await bad('[]', /không đúng định dạng/);
    await bad(JSON.stringify({ app: 'note-mytasks', version: 1 }), /không đúng định dạng/);
    await bad(JSON.stringify({ ...ok, tables: 'x' }), /không đúng định dạng/);
    await bad(JSON.stringify({ ...ok, app: 'other-app' }), /không phải của Note_mytasks/);
    await bad(JSON.stringify({ ...ok, version: 2 }), /phiên bản mới hơn/);
    await bad(JSON.stringify({ ...ok, version: '99' }), /phiên bản mới hơn/);
    await bad(JSON.stringify({ ...ok, tables: { tasks: { id: 'x' } } }), /Bảng "tasks" trong tệp bị hỏng/);
    await bad(JSON.stringify({ ...ok, tables: { tasks: [], expenses: [] } }), /không có dữ liệu/);
    await bad(JSON.stringify({ ...ok, tables: { tasks: [null, 1, 'x'], hacker: [{ a: 1 }] } }), /không có dữ liệu/);
    await bad(JSON.stringify({ ...ok, tables: {} }), /không có dữ liệu/);
  });

  it('importAll refuses a payload without tables', async () => {
    await expect(backup.importAll(null)).rejects.toEqual(isAppError('invalid_input'));
    await expect(backup.importAll({})).rejects.toEqual(isAppError('invalid_input'));
  });
});

// ---------------------------------------------------------------------------
describe('backup.js — export → parse → import round trip (A → fresh B)', () => {
  let A, B, C, aCats, ids = {}, aSnapBefore, file, exported, report, progress = [];

  beforeAll(async () => {
    [A, B, C] = await Promise.all([newUser({ displayName: 'BK-A' }), newUser({ displayName: 'BK-B' }), newUser({ displayName: 'BK-C' })]);
    const uid = A.user.id;
    const { data: cats } = await admin.from('categories').select('*').eq('user_id', uid);
    aCats = cats;
    const def = (kind, name) => cats.find((c) => c.kind === kind && c.name === name).id;
    // A customised a default category's colour (documented: B keeps its own defaults).
    await admin.from('categories').update({ color: '#000000' }).eq('id', def('expense', 'Ăn uống'));
    const [cx, cg] = await ins('categories', [
      { user_id: uid, kind: 'task', name: 'Dự án X', color: '#112233', sort_order: 99, created_at: '2026-01-02T03:04:05+00:00' },
      { user_id: uid, kind: 'expense', name: 'Quà tặng', color: '#445566', sort_order: 98, created_at: '2026-01-03T03:04:05+00:00' },
    ]);
    ids.catX = cx.id; ids.catGift = cg.id;
    const tasks = await ins('tasks', [
      { user_id: uid, title: 'Viết báo cáo', description: 'mô tả', status: 'todo', priority: 'high', category_id: def('task', 'Công việc'), tags: ['a', 'b'], due_date: '2026-08-10', estimated_minutes: 90, created_at: '2026-07-01T03:00:00+00:00' },
      { user_id: uid, title: 'Dọn nhà', status: 'completed', priority: 'low', category_id: cx.id, tags: [], created_at: '2026-07-02T03:00:00+00:00' },
      { user_id: uid, title: 'Tập thể dục', status: 'completed', priority: 'medium', recurrence: 'weekly', due_date: '2026-10-01', category_id: def('task', 'Sức khỏe'), created_at: '2026-07-03T03:00:00+00:00' },
      { user_id: uid, title: 'Đọc sách', status: 'cancelled', priority: 'urgent', created_at: '2026-07-04T03:00:00+00:00' },
      { user_id: uid, title: 'Đang làm', status: 'in_progress', estimated_minutes: 0, created_at: '2026-07-05T03:00:00+00:00' },
    ]);
    for (const t of tasks) ids[t.title] = t.id;
    // The completed weekly task spawned its next occurrence (DB trigger) → the recurrence chain.
    const { data: child } = await admin.from('tasks').select('*').eq('recurrence_parent_id', ids['Tập thể dục']);
    expect(child).toHaveLength(1);
    ids.child = child[0].id;
    // Give the spawned child a distinct title so rows can be matched by title.
    await admin.from('tasks').update({ title: 'Tập thể dục (tiếp)' }).eq('id', ids.child);

    await ins('time_entries', [
      { user_id: uid, task_id: ids['Viết báo cáo'], description: 'viết', started_at: '2026-08-01T01:00:00+00:00', ended_at: '2026-08-01T02:30:00+00:00', source: 'manual', created_at: '2026-08-01T02:30:00+00:00' },
      { user_id: uid, task_id: ids['Dọn nhà'], started_at: '2026-08-02T01:00:00+00:00', ended_at: '2026-08-02T01:20:30+00:00', source: 'timer', created_at: '2026-08-02T01:20:30+00:00' },
      { user_id: uid, task_id: null, description: 'không gắn việc', started_at: '2026-08-03T01:00:00+00:00', ended_at: '2026-08-03T01:00:59+00:00', source: 'manual' },
      { user_id: uid, task_id: ids['Đang làm'], description: 'running', started_at: new Date(Date.now() - 3600e3).toISOString(), ended_at: null, source: 'timer' },
    ]);
    const kpis = await ins('kpis', [
      { user_id: uid, name: 'Đọc 20 cuốn', description: 'năm nay', unit: 'cuốn', target_value: 20, start_date: '2026-01-01', end_date: '2026-12-31', status: 'active', created_at: '2026-01-01T00:00:00+00:00' },
      { user_id: uid, name: 'Cân nặng', unit: 'kg', target_value: 65.5, start_date: '2026-02-01', status: 'paused' },
      { user_id: uid, name: 'Cũ', unit: '', target_value: 1, start_date: '2025-01-01', end_date: '2025-02-01', status: 'archived' },
    ]);
    for (const k of kpis) ids[k.name] = k.id;
    await ins('kpi_records', [
      { user_id: uid, kpi_id: ids['Đọc 20 cuốn'], recorded_on: '2026-03-01', value: 3, note: 'q1', created_at: '2026-03-01T10:00:00+00:00' },
      { user_id: uid, kpi_id: ids['Đọc 20 cuốn'], recorded_on: '2026-06-01', value: 9, created_at: '2026-06-01T10:00:00+00:00' },
      { user_id: uid, kpi_id: ids['Đọc 20 cuốn'], recorded_on: '2026-06-01', value: 8.25, created_at: '2026-06-01T09:00:00+00:00' },
      { user_id: uid, kpi_id: ids['Cân nặng'], recorded_on: '2026-04-01', value: 70.4, created_at: '2026-04-01T10:00:00+00:00' },
    ]);
    const exps = await ins('expenses', [
      { user_id: uid, amount: 120000.5, category_id: def('expense', 'Ăn uống'), description: 'Phở', spent_on: '2026-08-01', payment_method: 'bank', note: 'n1', created_at: '2026-08-01T05:00:00+00:00' },
      { user_id: uid, amount: 500000, category_id: cg.id, description: 'Quà sinh nhật', spent_on: '2026-08-02', payment_method: 'credit_card' },
      { user_id: uid, amount: 1, category_id: null, description: 'Lẻ', spent_on: '2026-08-03', payment_method: 'e_wallet' },
      { user_id: uid, amount: 500000, category_id: def('expense', 'Mua sắm'), description: 'Giày (mua sắm)', spent_on: '2026-08-05', payment_method: 'cash' },
    ]);
    for (const e of exps) ids[e.description] = e.id;
    await ins('budgets', [
      { user_id: uid, effective_month: '2026-08-01', category_id: null, amount: 5000000, created_at: '2026-08-01T00:00:00+00:00' },
      { user_id: uid, effective_month: '2026-08-01', category_id: def('expense', 'Ăn uống'), amount: 2000000 },
      { user_id: uid, effective_month: '2026-09-01', category_id: cg.id, amount: 0 },
    ]);
    await ins('shopping_items', [
      { user_id: uid, name: 'Giày', category_id: def('expense', 'Mua sắm'), unit_price: 250000, quantity: 2, priority: 'high', status: 'purchased', purchased_on: '2026-08-05', url: 'https://shop.example/giay', note: 'size 42', expense_id: ids['Giày (mua sắm)'] },
      { user_id: uid, name: 'Tai nghe', unit_price: 0, quantity: 1, priority: 'must_buy', status: 'wishlist' },
    ]);
    await ins('notes', [
      { user_id: uid, title: 'Ghi chú việc', content: 'liên kết', tags: ['x'], color: '#ABCDEF', pinned: true, task_id: ids['Viết báo cáo'], kind: 'note', created_at: '2026-08-01T00:00:00+00:00' },
      { user_id: uid, title: 'Danh sách', content: '- [ ] a', kind: 'checklist', archived: true, notebook: 'Nhà' },
      { user_id: uid, title: 'Nhật ký', content: 'đã xoá', kind: 'journal', trashed_at: '2026-09-01T00:00:00+00:00' },
    ]);
    aSnapBefore = await snapshot(uid);
  });

  afterAll(async () => { await Promise.all([deleteUser(A?.user), deleteUser(B?.user), deleteUser(C?.user)]); });

  it('downloadBackup (A) exports every table of A only, as a JSON download named by today', async () => {
    setClient(A.client);
    const cap = stubDownload();
    const steps = [];
    try {
      exported = await backup.downloadBackup({ onProgress: (p) => steps.push(p) });
      expect(cap.anchors).toHaveLength(1);
      const a = cap.anchors[0];
      expect(a).toMatchObject({ tag: 'a', href: 'blob:test/1', download: `note-mytasks-backup-${todayVN()}.json`, clicked: 1, removed: 1 });
      expect(cap.appended).toBe(1);
      expect(cap.blobs[0].type).toBe('application/json');
      const text = await blobText(cap.blobs[0]);
      expect(text).toBe(JSON.stringify(exported, null, 2));
      file = new File([text], a.download, { type: 'application/json' });
      await sleep(1700);
      expect(cap.revoked).toEqual(['blob:test/1']);
    } finally { cap.restore(); }

    expect(steps.map((s) => s.table)).toEqual(TABLES);
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps.every((s) => s.total === 9 && s.label === backup.tableLabel(s.table))).toBe(true);
    expect(exported).toMatchObject({ app: 'note-mytasks', version: 1, missing: [] });
    expect(Date.parse(exported.exported_at)).toBeGreaterThan(Date.now() - 120e3);
    for (const t of TABLES) {
      const own = aSnapBefore[t];
      expect(exported.counts[t], t).toBe(own.length);
      // Same rows (ids ordered), every column except user_id / generated search vector.
      expect(exported.tables[t].map((r) => r.id)).toEqual(own.map((r) => r.id));
      exported.tables[t].forEach((r, i) => {
        expect(r).not.toHaveProperty('user_id');
        expect(r).not.toHaveProperty('search');
        const { user_id, search, ...rest } = own[i]; // eslint-disable-line no-unused-vars
        expect(r).toEqual(rest);
      });
    }
    expect(exported.counts).toEqual({ categories: 16, tasks: 6, time_entries: 4, kpis: 3, kpi_records: 4, expenses: 4, budgets: 3, shopping_items: 2, notes: 3 });
  });

  it('parseBackup(file) previews the exported file exactly', async () => {
    const p = await backup.parseBackup(file);
    expect(p.counts).toEqual(exported.counts);
    expect(p.total).toBe(45);
    expect(p.unknown).toEqual([]);
    expect(p.exported_at).toBe(exported.exported_at);
    expect(p.backup.tables).toEqual(exported.tables);
  });

  it('importAll into fresh B copies everything with remapped keys and never writes to A', async () => {
    setClient(B.client);
    const { backup: data } = await backup.parseBackup(file);
    const t0 = Date.now();
    report = await backup.importAll(data, { onProgress: (p) => progress.push(p) });
    expect(report.errors).toEqual([]);
    expect(report.failed).toEqual({});
    // B's 14 default categories are reused by (kind, name); A's 2 custom ones are new.
    expect(report.inserted).toEqual({ categories: 2, tasks: 6, time_entries: 3, kpis: 3, kpi_records: 4, expenses: 4, budgets: 3, shopping_items: 2, notes: 3 });
    expect(report.skipped).toEqual({ categories: 14, time_entries: 1 });
    expect(report.warnings).toEqual(['Thời điểm hoàn thành của các công việc đã xong được đặt thành lúc nhập (do cơ sở dữ liệu tự ghi).']);
    expect(progress.map((p) => p.table)).toEqual(TABLES);
    expect(progress.every((p) => p.total === 9 && p.step === TABLES.indexOf(p.table) + 1)).toBe(true);

    // Nothing written to A.
    expect(await snapshot(A.user.id)).toEqual(aSnapBefore);

    const bSnap = await snapshot(B.user.id);
    // No id of A anywhere in B, every row is B's.
    const aIds = new Set(Object.values(aSnapBefore).flat().map((r) => r.id));
    for (const t of TABLES) {
      for (const r of bSnap[t]) {
        expect(r.user_id).toBe(B.user.id);
        for (const [k, v] of Object.entries(r)) if (k === 'id' || k.endsWith('_id')) expect(aIds.has(v), `${t}.${k}`).toBe(false);
      }
    }
    // Counts equal except the skipped running timer.
    for (const t of TABLES) expect(bSnap[t].length, t).toBe(aSnapBefore[t].length - (t === 'time_entries' ? 1 : 0));
    expect(bSnap.time_entries.every((e) => e.ended_at)).toBe(true);

    // Documented differences: completed_at = import time; reused default categories keep B's own
    // colour/sort/created_at (they are B's rows); imported categories are never is_default.
    for (const r of bSnap.tasks.filter((x) => x.status === 'completed')) {
      expect(Date.parse(r.completed_at)).toBeGreaterThanOrEqual(t0 - 5000);
      expect(Date.parse(r.completed_at)).toBeLessThanOrEqual(Date.now() + 5000);
    }
    const bFood = bSnap.categories.find((c) => c.kind === 'expense' && c.name === 'Ăn uống');
    expect(bFood.color).toBe('#E5793B');
    const aNoRunning = { ...aSnapBefore, time_entries: aSnapBefore.time_entries.filter((e) => e.ended_at) };
    const drop = { tasks: ['completed_at'] };
    const na = normalise(aNoRunning, drop);
    const nb = normalise(bSnap, drop);
    // categories: defaults compared on identity only, custom ones on every column.
    const catCmp = (s) => s.categories.map((c) => (c.is_default ? { kind: c.kind, name: c.name, is_default: true } : c));
    expect(catCmp(nb)).toEqual(catCmp(na));
    for (const t of TABLES.filter((x) => x !== 'categories')) expect(nb[t], t).toEqual(na[t]);

    // Spot-check the remapped links explicitly.
    const byTitle = (s, title) => s.tasks.find((r) => r.title === title);
    const bRoot = byTitle(bSnap, 'Tập thể dục');
    const bChild = byTitle(bSnap, 'Tập thể dục (tiếp)');
    expect(bChild.recurrence_parent_id).toBe(bRoot.id);
    expect(bRoot.recurrence).toBe('weekly');
    expect(bChild.recurrence).toBe('weekly');
    // Restoring recurrence on a completed task must not spawn another occurrence.
    expect(bSnap.tasks.filter((r) => r.recurrence_parent_id === bRoot.id)).toHaveLength(1);
    expect(byTitle(bSnap, 'Dọn nhà').category_id).toBe(bSnap.categories.find((c) => c.name === 'Dự án X').id);
    expect(byTitle(bSnap, 'Viết báo cáo').category_id).toBe(bSnap.categories.find((c) => c.kind === 'task' && c.name === 'Công việc').id);
    expect(byTitle(bSnap, 'Viết báo cáo').actual_minutes).toBe(90);
    expect(byTitle(bSnap, 'Dọn nhà').actual_minutes).toBe(21); // round(1230 s / 60)
    const note = bSnap.notes.find((n) => n.title === 'Ghi chú việc');
    expect(note.task_id).toBe(byTitle(bSnap, 'Viết báo cáo').id);
    const shoe = bSnap.shopping_items.find((s) => s.name === 'Giày');
    expect(shoe.expense_id).toBe(bSnap.expenses.find((e) => e.description === 'Giày (mua sắm)').id);
    expect(Number(shoe.total_price)).toBe(500000);
    const k1 = bSnap.kpis.find((k) => k.name === 'Đọc 20 cuốn');
    expect(Number(k1.current_value)).toBe(9); // latest record by (recorded_on, created_at)
    expect(bSnap.kpi_records.filter((r) => r.kpi_id === k1.id)).toHaveLength(3);
  });

  it('re-importing the same file: categories reused, budgets kept, overlapping time entries reported as failed', async () => {
    setClient(B.client);
    const before = await snapshot(B.user.id);
    const { backup: data } = await backup.parseBackup(file);
    const r = await backup.importAll(data);
    expect(r.inserted.categories || 0).toBe(0);
    expect(r.skipped.categories).toBe(16);
    expect(r.skipped.budgets).toBe(3);
    expect(r.inserted.budgets || 0).toBe(0);
    expect(r.inserted.tasks).toBe(6);
    // The DB rejects overlapping sessions — the import reports them instead of aborting.
    expect(r.failed.time_entries).toBe(3);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/^Phiên tính giờ: /);
    const after = await snapshot(B.user.id);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.categories).toEqual(before.categories);
    expect(after.tasks.length).toBe(before.tasks.length + 6);
    expect(await snapshot(A.user.id)).toEqual(aSnapBefore);
  });

  it('a file crafted with A\'s ids imported into C never touches or references A', async () => {
    setClient(C.client);
    const a = aSnapBefore;
    const aTask = a.tasks[0], aKpi = a.kpis[0], aExp = a.expenses[0], aCat = a.categories.find((c) => c.name === 'Quà tặng');
    const aTaskCat = a.categories.find((c) => c.kind === 'task');
    const crafted = {
      app: 'note-mytasks', version: 1,
      tables: {
        categories: [
          { id: aCat.id, kind: 'expense', name: 'Quà tặng', color: '#445566', user_id: A.user.id },
          { id: 'c-food', kind: 'expense', name: '  ĂN UỐNG ', color: '#123456' }, // matches C's default (trim + case)
          { id: 'c-bad', kind: 'weird', name: 'x' },
          { id: 'c-empty', kind: 'task', name: '   ' },
        ],
        tasks: [
          { id: aTask.id, title: 'Chiếm task của A', status: 'todo', user_id: A.user.id, category_id: aTaskCat.id, recurrence_parent_id: a.tasks[1].id },
          { id: 't2', title: 'Task lạ', status: 'todo', category_id: aTaskCat.id, tags: 'not-an-array' },
          { id: 't3', title: 'Task C', status: 'todo', category_id: 'c-food' }, // expense category on a task → the DB rejects that row
        ],
        time_entries: [{ id: 'te', task_id: aTask.id, started_at: '2026-05-01T01:00:00Z', ended_at: '2026-05-01T02:00:00Z', source: 'manual', user_id: A.user.id }],
        kpis: [{ id: 'k1', name: 'KPI C', target_value: 5, start_date: '2026-01-01', user_id: A.user.id }],
        kpi_records: [
          { id: 'r1', kpi_id: aKpi.id, recorded_on: '2026-02-01', value: 1 },
          { id: 'r2', kpi_id: 'k1', recorded_on: '2026-02-01', value: 2, user_id: A.user.id },
        ],
        expenses: [{ id: aExp.id, amount: 10, category_id: aCat.id, description: 'Chi C', spent_on: '2026-05-01', payment_method: 'cash', user_id: A.user.id }],
        budgets: [
          { id: 'b1', effective_month: '2026-05-01', category_id: aSnapBefore.categories.find((c) => c.kind === 'expense' && c.id !== aCat.id).id, amount: 1 },
          { id: 'b2', effective_month: '2026-05-01', category_id: aCat.id, amount: 7 },
        ],
        shopping_items: [{ id: 's1', name: 'Món C', expense_id: aSnapBefore.expenses[1].id, category_id: 'c-food', status: 'wishlist' }],
        notes: [
          { id: 'n1', title: 'Note C', task_id: aTask.id, user_id: A.user.id, search: 'x', updated_at: '2020-01-01T00:00:00Z' },
          // Unknown column (newer/tampered schema) → dropped on import, the row is kept.
          { id: 'n2', title: 'Note lạ', foreign_id: 'abc' },
        ],
      },
    };
    const parsed = await backup.parseBackup(JSON.stringify(crafted));
    const r = await backup.importAll(parsed.backup);
    expect(r.skipped).toEqual({ categories: 3, kpi_records: 1, budgets: 1 });
    expect(r.failed).toEqual({ tasks: 1 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Công việc: /);
    expect(r.inserted).toMatchObject({ categories: 1, tasks: 2, time_entries: 1, kpis: 1, kpi_records: 1, expenses: 1, budgets: 1, shopping_items: 1, notes: 2 });
    expect(await snapshot(A.user.id)).toEqual(aSnapBefore);

    const c = await snapshot(C.user.id);
    const aIds = new Set(Object.values(aSnapBefore).flat().map((x) => x.id));
    for (const t of TABLES) {
      for (const row of c[t]) {
        expect(row.user_id).toBe(C.user.id);
        for (const [k, v] of Object.entries(row)) if (k === 'id' || k.endsWith('_id')) expect(aIds.has(v), `${t}.${k}`).toBe(false);
      }
    }
    const gift = c.categories.find((x) => x.name === 'Quà tặng');
    const food = c.categories.find((x) => x.kind === 'expense' && x.name === 'Ăn uống');
    expect(c.categories).toHaveLength(15); // 14 defaults + Quà tặng
    const t1 = c.tasks.find((x) => x.title === 'Chiếm task của A');
    expect(t1.category_id).toBe(null); // A's task category is not in the file → never linked
    expect(t1.recurrence_parent_id).toBe(null);
    const t2 = c.tasks.find((x) => x.title === 'Task lạ');
    expect(t2.category_id).toBe(null);
    expect(t2.tags).toEqual([]);
    expect(c.tasks.find((x) => x.title === 'Task C')).toBeUndefined();
    expect(c.time_entries).toHaveLength(1);
    expect(c.time_entries[0].task_id).toBe(t1.id);
    expect(c.kpi_records).toHaveLength(1);
    expect(Number(c.kpi_records[0].value)).toBe(2);
    expect(c.expenses[0].category_id).toBe(gift.id);
    expect(c.budgets).toHaveLength(1);
    expect(c.budgets[0]).toMatchObject({ category_id: gift.id, effective_month: '2026-05-01' });
    expect(c.shopping_items[0]).toMatchObject({ expense_id: null, category_id: food.id });
    expect(c.notes).toHaveLength(2);
    const noteC = c.notes.find((x) => x.title === 'Note C');
    // aTask.id is also a task id inside the file → linked to C's copy of it, never to A's task.
    expect(noteC).toMatchObject({ task_id: t1.id });
    expect(noteC.updated_at).not.toBe('2020-01-01T00:00:00+00:00');
    // the row with an unknown column is kept; the unknown column is simply dropped
    expect(c.notes.find((x) => x.title === 'Note lạ')).toMatchObject({ task_id: null });
  });

  it('downloadTableCsv exports one table (BOM, every column but user_id) and rejects unknown tables', async () => {
    setClient(A.client);
    const cap = stubDownload();
    try {
      const n = await backup.downloadTableCsv('expenses');
      expect(n).toBe(4);
      expect(cap.anchors[0]).toMatchObject({ download: `expenses_${todayVN()}.csv`, clicked: 1, removed: 1 });
      expect(cap.blobs[0].type).toBe('text/csv;charset=utf-8');
      const bytes = new Uint8Array(await cap.blobs[0].arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = (await blobText(cap.blobs[0])).slice(1);
      const lines = text.split('\r\n');
      expect(lines).toHaveLength(5);
      const cols = lines[0].split(',');
      expect(cols).toEqual(['id', 'amount', 'category_id', 'description', 'spent_on', 'payment_method', 'note', 'created_at', 'updated_at']);
      const rows = aSnapBefore.expenses;
      rows.forEach((r, i) => {
        expect(lines[i + 1]).toBe(cols.map((k) => (r[k] == null ? '' : String(r[k]))).join(','));
      });

      // shopping_items in hyphenated filename; tasks: array column joined with '; ' (quoted).
      expect(await backup.downloadTableCsv('shopping_items')).toBe(2);
      expect(cap.anchors[1].download).toBe(`shopping-items_${todayVN()}.csv`);
      expect(await backup.downloadTableCsv('tasks')).toBe(6);
      const tcsv = await blobText(cap.blobs[2]);
      expect(tcsv).toContain('"a; b"');
      expect(tcsv).not.toContain('user_id');

      // Empty table → header only.
      setClient(C.client);
      expect(await backup.downloadTableCsv('time_entries')).toBe(1);
      setClient(B.client);
      const fresh = await newUser();
      try {
        setClient(fresh.client);
        expect(await backup.downloadTableCsv('budgets')).toBe(0);
        expect((await blobText(cap.blobs.at(-1))).slice(1)).toBe('id');
      } finally { await deleteUser(fresh.user); }

      await expect(backup.downloadTableCsv('profiles')).rejects.toEqual(isAppError('invalid_input'));
      await expect(backup.downloadTableCsv('profiles')).rejects.toThrow('Bảng dữ liệu không hợp lệ.');
    } finally { cap.restore(); }
  });
});
