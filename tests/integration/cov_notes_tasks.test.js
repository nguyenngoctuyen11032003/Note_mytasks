// Coverage: notes service, tasks.listTaskNotes / listCompletedBetween, activity feed,
// and public.notes_search_document — real services → real PostgREST → real SQL
// (LOCAL Supabase stack only). Every service is called with the argument shapes the
// UI uses (src/pages/notes.js, dashboard.js, settings.js, components/taskDrawer.js,
// components/commandPalette.js); DB state is verified with the service_role client.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import pg from 'pg';
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import * as N from '../../src/services/notes.js';
import * as tasks from '../../src/services/tasks.js';
import * as activity from '../../src/services/activity.js';
import * as expenses from '../../src/services/expenses.js';
import { dayStartInstant, dayEndInstant, dayOf, addDays } from '../../src/utils/date.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const DB_URL = process.env.IT_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const T = todayVN();
const MISSING = '00000000-0000-4000-8000-000000000000';

async function sql(text, params = [], { replica = false } = {}) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query('begin');
    if (replica) await c.query('set local session_replication_role = replica');
    const r = await c.query(text, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

async function dbNote(id) {
  const { data, error } = await admin.from('notes').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function dbNotesOf(userId) {
  const { data, error } = await admin.from('notes').select('*').eq('user_id', userId).order('created_at');
  if (error) throw error;
  return data;
}
async function dbActivityOf(userId) {
  const { data, error } = await admin.from('activity_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
const appError = (code) => expect.objectContaining({ name: 'AppError', code });
const ids = (rows) => rows.map((r) => r.id);
const sortIds = (rows) => ids(rows).sort();
const tick = () => new Promise((r) => setTimeout(r, 15));

// Exactly the row src/pages/notes.js createFrom() sends (blank template, "all" view).
const uiNewNote = (over = {}) => ({
  title: '', content: '', kind: 'note', notebook: null, tags: [], task_id: null, pinned: false, ...over,
});

let A; let B;
beforeAll(async () => {
  [A, B] = await Promise.all([newUser({ displayName: 'Notes A' }), newUser({ displayName: 'Notes B' })]);
});
afterAll(async () => {
  await Promise.all([deleteUser(A?.user), deleteUser(B?.user)]);
});

// ---------------------------------------------------------------------------
// createNote / getNote / updateNote
// ---------------------------------------------------------------------------
describe('notes: create / get / update (real DB)', () => {
  it('createNote with the UI blank-note row stores defaults owned by the caller', async () => {
    setClient(A.client);
    const n = await N.createNote(uiNewNote());
    expect(n).toMatchObject({ title: '', content: '', kind: 'note', notebook: null, tags: [], task_id: null, pinned: false, archived: false, trashed_at: null, color: null });
    expect(Object.keys(n).sort()).toEqual(N.NOTE_COLS.split(', ').sort());
    const row = await dbNote(n.id);
    expect(row.user_id).toBe(A.user.id);
    expect(row.search).toBe('');
    expect(row.created_at).toBe(row.updated_at);
  });

  it('createNote normalises tags / notebook and keeps markdown whitespace verbatim', async () => {
    setClient(A.client);
    const content = '  # Tiêu đề\n\n- [ ] việc 1  \n\t- [x] việc 2\n';
    const n = await N.createNote(uiNewNote({
      title: '  Họp giao ban  ', content, kind: 'meeting', notebook: '  Công việc ', tags: ['#Dự-án', 'dự-án', '  khẩn ', ''], pinned: true,
    }));
    const row = await dbNote(n.id);
    expect(row).toMatchObject({ title: 'Họp giao ban', content, kind: 'meeting', notebook: 'Công việc', tags: ['Dự-án', 'khẩn'], pinned: true });
    // generated search vector covers title + tags + content (lower-cased, 'simple')
    expect(row.search).toContain("'họp'");
    expect(row.search).toContain("'khẩn'");
    expect(row.search).toContain("'việc'");
  });

  it('createNote rejects invalid input before hitting the DB', async () => {
    setClient(A.client);
    const before = (await dbNotesOf(A.user.id)).length;
    await expect(N.createNote(uiNewNote({ kind: 'diary' }))).rejects.toEqual(appError('invalid_input'));
    await expect(N.createNote(uiNewNote({ title: 'x'.repeat(201) }))).rejects.toEqual(appError('invalid_input'));
    await expect(N.createNote(uiNewNote({ color: 'red' }))).rejects.toEqual(appError('invalid_input'));
    await expect(N.createNote(uiNewNote({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).rejects.toEqual(appError('invalid_input'));
    expect((await dbNotesOf(A.user.id)).length).toBe(before);
  });

  it('createNote ignores server-owned columns (user_id, search, timestamps)', async () => {
    setClient(B.client);
    const n = await N.createNote({ ...uiNewNote({ title: 'spoof' }), user_id: A.user.id, created_at: '2000-01-01T00:00:00Z', search: 'x' });
    const row = await dbNote(n.id);
    expect(row.user_id).toBe(B.user.id);
    expect(row.created_at.startsWith('2000')).toBe(false);
    await admin.from('notes').delete().eq('id', n.id);
  });

  it('getNote returns the note, null for a missing id, and rejects an empty id', async () => {
    setClient(A.client);
    const n = await N.createNote(uiNewNote({ title: 'đọc' }));
    expect(await N.getNote(n.id)).toEqual(n);
    expect(await N.getNote(MISSING)).toBeNull();
    await expect(N.getNote('')).rejects.toEqual(appError('invalid_input'));
  });

  it('updateNote applies each autosave patch shape and bumps updated_at', async () => {
    setClient(A.client);
    const n = await N.createNote(uiNewNote());
    let prev = (await dbNote(n.id)).updated_at;
    const patches = [
      [{ title: 'Kế hoạch quý' }, { title: 'Kế hoạch quý' }],
      [{ content: 'Nội dung **mới**\n' }, { content: 'Nội dung **mới**\n' }],
      [{ tags: ['quý', 'Quý', 'okr'] }, { tags: ['quý', 'okr'] }],
      [{ notebook: 'Chiến lược' }, { notebook: 'Chiến lược' }],
      [{ pinned: true }, { pinned: true }],
      [{ kind: 'checklist' }, { kind: 'checklist' }],
      [{ color: '#AABBCC' }, { color: '#AABBCC' }],
      [{ archived: true }, { archived: true }],
      [{ archived: false }, { archived: false }],
      [{ notebook: '' }, { notebook: null }],
      [{ title: '' }, { title: '' }],
    ];
    for (const [patch, expected] of patches) {
      await tick();
      const saved = await N.updateNote(n.id, patch);
      expect(saved).toMatchObject(expected);
      const row = await dbNote(n.id);
      expect(row).toMatchObject(expected);
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(prev).getTime());
      expect(saved.updated_at).toBe(row.updated_at);
      prev = row.updated_at;
    }
    // search vector follows title/tags/content edits
    const row = await dbNote(n.id);
    expect(row.search).toContain("'okr'");
    expect(row.search).toContain("'mới'");
    expect(row.search).not.toContain("'kế'");
  });

  it('updateNote refuses an empty / server-only patch and leaves the row unchanged', async () => {
    setClient(A.client);
    const n = await N.createNote(uiNewNote({ title: 'giữ nguyên' }));
    const before = await dbNote(n.id);
    await expect(N.updateNote(n.id, {})).rejects.toEqual(appError('invalid_input'));
    await expect(N.updateNote(n.id, { user_id: B.user.id, search: 'x', updated_at: '2000-01-01' })).rejects.toEqual(appError('invalid_input'));
    await expect(N.updateNote(MISSING, { title: 'x' })).rejects.toEqual(appError('not_found'));
    expect(await dbNote(n.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Task link
// ---------------------------------------------------------------------------
describe('notes ↔ tasks link (real DB)', () => {
  let taskA; let taskA2; let taskB;
  beforeAll(async () => {
    setClient(A.client);
    taskA = await tasks.createTask({ title: 'Task của A' });
    taskA2 = await tasks.createTask({ title: 'Task khác của A' });
    setClient(B.client);
    taskB = await tasks.createTask({ title: 'Task của B' });
  });

  it('createNote / updateNote link a note to my own task', async () => {
    setClient(A.client);
    const n = await N.createNote(uiNewNote({ title: 'Ghi chú cho task', task_id: taskA.id }));
    expect((await dbNote(n.id)).task_id).toBe(taskA.id);
    await N.updateNote(n.id, { task_id: taskA2.id });
    expect((await dbNote(n.id)).task_id).toBe(taskA2.id);
    await N.updateNote(n.id, { task_id: '' });
    expect((await dbNote(n.id)).task_id).toBeNull();
  });

  it("linking to another user's task is rejected (composite FK), DB unchanged", async () => {
    setClient(A.client);
    const before = (await dbNotesOf(A.user.id)).length;
    await expect(N.createNote(uiNewNote({ title: 'trộm link', task_id: taskB.id }))).rejects.toEqual(appError('invalid_reference'));
    expect((await dbNotesOf(A.user.id)).length).toBe(before);

    const n = await N.createNote(uiNewNote({ title: 'link hợp lệ', task_id: taskA.id }));
    await expect(N.updateNote(n.id, { task_id: taskB.id })).rejects.toEqual(appError('invalid_reference'));
    await expect(N.updateNote(n.id, { task_id: MISSING })).rejects.toEqual(appError('invalid_reference'));
    expect((await dbNote(n.id)).task_id).toBe(taskA.id);
  });

  it('duplicate (UI shape) keeps the task link; deleting the task keeps the note and clears task_id', async () => {
    setClient(A.client);
    const t = await tasks.createTask({ title: 'Sắp xoá' });
    const n = await N.createNote(uiNewNote({ title: 'Gốc', content: 'abc', notebook: 'Sổ', tags: ['x'], task_id: t.id }));
    const copy = await N.createNote({
      title: `${n.title} (bản sao)`.slice(0, 200), content: n.content, notebook: n.notebook, tags: n.tags, color: n.color, kind: n.kind, task_id: n.task_id,
    });
    expect(await dbNote(copy.id)).toMatchObject({ title: 'Gốc (bản sao)', content: 'abc', notebook: 'Sổ', tags: ['x'], task_id: t.id, user_id: A.user.id });
    await tasks.deleteTask(t.id);
    expect((await dbNote(n.id)).task_id).toBeNull();
    expect((await dbNote(copy.id)).task_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTaskNotes (taskDrawer: listTaskNotes(t.id, { limit: 6 }))
// ---------------------------------------------------------------------------
describe('tasks.listTaskNotes (real DB)', () => {
  it('returns live notes of the task, newest edit first, honouring limit; trashed / other-task / other-user excluded', async () => {
    setClient(A.client);
    const t = await tasks.createTask({ title: 'Task có ghi chú' });
    const other = await tasks.createTask({ title: 'Task khác' });
    const made = [];
    for (let i = 0; i < 8; i++) {
      made.push(await N.createNote(uiNewNote({ title: `n${i}`, kind: i % 2 ? 'checklist' : 'note', task_id: t.id })));
      await tick();
    }
    await N.createNote(uiNewNote({ title: 'khác task', task_id: other.id }));
    await N.trashNote(made[7].id); // newest one trashed → excluded
    await tick();
    await N.updateNote(made[0].id, { content: 'vừa sửa' }); // oldest becomes most recent edit

    const six = await tasks.listTaskNotes(t.id, { limit: 6 });
    expect(six.map((r) => r.title)).toEqual(['n0', 'n6', 'n5', 'n4', 'n3', 'n2']);
    expect(Object.keys(six[0]).sort()).toEqual(['id', 'kind', 'title', 'updated_at']);
    expect(six[1].kind).toBe('note');
    expect(six[2].kind).toBe('checklist');

    const all = await tasks.listTaskNotes(t.id);
    expect(all.map((r) => r.title)).toEqual(['n0', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1']);
    const { data: live } = await admin.from('notes').select('id').eq('task_id', t.id).is('trashed_at', null);
    expect(sortIds(all)).toEqual(sortIds(live));

    await N.restoreNote(made[7].id);
    expect((await tasks.listTaskNotes(t.id, { limit: 6 }))[0].title).toBe('n7');

    setClient(B.client);
    expect(await tasks.listTaskNotes(t.id, { limit: 6 })).toEqual([]);
    setClient(A.client);
    await expect(tasks.listTaskNotes('')).rejects.toEqual(appError('invalid_input'));
  });
});

// ---------------------------------------------------------------------------
// listNotes filters (notes page filters(), command palette, dashboard, reports)
// ---------------------------------------------------------------------------
describe('notes: listNotes filters + search (real DB)', () => {
  let U; const n = {};
  beforeAll(async () => {
    U = await newUser({ displayName: 'Search' });
    setClient(U.client);
    const mk = async (key, row, patch) => {
      n[key] = await N.createNote(uiNewNote(row));
      if (patch) n[key] = await N.updateNote(n[key].id, patch);
      await tick();
    };
    await mk('report', { title: 'Báo cáo tuần 41', content: 'Doanh thu tăng trưởng tốt', notebook: 'Công việc', tags: ['khẩn'] });
    await mk('plain', { title: 'bao cao khong dau', content: 'viet khong dau', notebook: 'Công việc' });
    await mk('shop', { title: 'Đi chợ', content: 'Mua rau muống, cá kho', notebook: 'Gia đình', tags: ['nhà'], kind: 'checklist' });
    await mk('pin', { title: 'Mật khẩu wifi', content: 'xem trong sổ', pinned: true, tags: ['nhà'] });
    await mk('meet', { title: 'Họp (dự án) A, B', content: 'Nói về báo giá 100% trả trước', kind: 'meeting', notebook: 'Công việc' });
    await mk('arch', { title: 'Báo cáo cũ', content: 'lưu trữ' }, { archived: true });
    await mk('trash1', { title: 'Báo cáo nháp', content: 'bỏ' });
    await N.trashNote(n.trash1.id); await tick();
    await mk('trash2', { title: 'Rác 2', content: '' });
    await N.trashNote(n.trash2.id);
    // other user's matching note must never leak
    setClient(B.client);
    n.foreign = await N.createNote(uiNewNote({ title: 'Báo cáo của B', notebook: 'Công việc', tags: ['khẩn'], pinned: true }));
  });
  afterAll(async () => { await deleteUser(U?.user); await admin.from('notes').delete().eq('id', n.foreign.id); });

  const list = (f) => { setClient(U.client); return N.listNotes(f); };

  it('default ("all" view) = live, non-archived notes; pinned first then most recently edited', async () => {
    const rows = await list({ search: undefined });
    expect(ids(rows)).toEqual([n.pin.id, n.meet.id, n.shop.id, n.plain.id, n.report.id]);
    expect(Object.keys(rows[0]).sort()).toEqual(N.NOTE_COLS.split(', ').sort());
  });

  it('notebook / tag / pinned / kind / archived / trashed views', async () => {
    expect(sortIds(await list({ notebook: 'Công việc' }))).toEqual([n.report.id, n.plain.id, n.meet.id].sort());
    expect(await list({ notebook: 'công việc' })).toEqual([]); // exact match
    expect(sortIds(await list({ tag: 'nhà' }))).toEqual([n.shop.id, n.pin.id].sort());
    expect(ids(await list({ tag: 'khẩn' }))).toEqual([n.report.id]);
    expect(ids(await list({ pinned: true }))).toEqual([n.pin.id]);
    expect(ids(await list({ kind: 'meeting' }))).toEqual([n.meet.id]);
    expect(ids(await list({ archived: true }))).toEqual([n.arch.id]);
    // trash view: newest trashed first, archived flag ignored
    expect(ids(await list({ trashed: true }))).toEqual([n.trash2.id, n.trash1.id]);
    // reports.js: archived: null → archived + live (not trashed)
    expect(sortIds(await list({ limit: 2000, archived: null })))
      .toEqual([n.report.id, n.plain.id, n.shop.id, n.pin.id, n.meet.id, n.arch.id].sort());
    await expect(list({ kind: 'diary' })).rejects.toEqual(appError('invalid_input'));
  });

  it('limit (dashboard limit:40, command palette limit:8)', async () => {
    expect(ids(await list({ limit: 2 }))).toEqual([n.pin.id, n.meet.id]);
    expect((await list({ limit: 40 })).length).toBe(5);
  });

  it('search (Vietnamese, with diacritics): substring, case-insensitive, word prefixes in any order, tags', async () => {
    expect(sortIds(await list({ search: 'báo cáo' }))).toEqual(sortIds([n.report, n.plain])); // folded both ways (001100)
    expect(sortIds(await list({ search: 'BÁO CÁO' }))).toEqual(sortIds([n.report, n.plain]));
    expect(sortIds(await list({ search: 'cáo báo' }))).toEqual(sortIds([n.report, n.plain])); // FTS: any order
    expect(sortIds(await list({ search: 'bá' }))).toEqual(sortIds([n.report, n.meet, n.plain])); // prefix "báo"/"bao"
    expect(sortIds(await list({ search: 'tăng trưở' }))).toEqual([n.report.id]);
    expect(sortIds(await list({ search: 'muống' }))).toEqual([n.shop.id]);
    // tag-only match (title/content do not contain it): only the FTS branch finds it
    expect(sortIds(await list({ search: 'khẩn' }))).toEqual([n.report.id]);
    // combined with a view filter
    expect(sortIds(await list({ search: 'báo', notebook: 'Công việc' }))).toEqual(sortIds([n.report, n.meet, n.plain]));
    expect(sortIds(await list({ search: 'báo cáo', trashed: true }))).toEqual([n.trash1.id]);
    expect(sortIds(await list({ search: 'báo cáo', archived: true }))).toEqual([n.arch.id]);
  });

  it('search without diacritics also finds accented text (accent-insensitive, migration 001100)', async () => {
    // Accent-insensitive since migration 001100: "bao cao" also finds "Báo cáo tuần 41".
    expect(sortIds(await list({ search: 'bao cao' }))).toEqual(sortIds([n.plain, n.report]));
    expect(sortIds(await list({ search: 'khong dau' }))).toEqual([n.plain.id]);
  });

  it('search typed as decomposed Unicode (NFD, e.g. Unikey "Unicode tổ hợp") finds the same notes as NFC', async () => {
    const nfd = 'báo cáo'.normalize('NFD');
    expect(nfd).not.toBe('báo cáo');
    expect(sortIds(await list({ search: nfd }))).toEqual(sortIds([n.report, n.plain]));
    expect(N.toPrefixQuery(nfd)).toBe('(báo:* | bao:*) & (cáo:* | cao:*)');
  });

  it('search with PostgREST/LIKE metacharacters is treated literally and never errors', async () => {
    expect(ids(await list({ search: 'Họp (dự án) A, B' }))).toEqual([n.meet.id]);
    expect(ids(await list({ search: '100%' }))).toEqual([n.meet.id]);
    expect(await list({ search: '"; drop table notes; --' })).toEqual([]);
    expect(await list({ search: '%%%' })).toEqual([]);
    expect((await list({ search: '***' })).length).toBe(5); // '*' is a one-char wildcard (likePattern)
    expect((await list({ search: '   ' })).length).toBe(5); // blank = no search
  });

  it("never returns another user's notes", async () => {
    const all = [
      ...(await list({ search: 'báo cáo' })), ...(await list({ notebook: 'Công việc' })),
      ...(await list({ tag: 'khẩn' })), ...(await list({ pinned: true })), ...(await list({ archived: null })),
    ];
    expect(ids(all)).not.toContain(n.foreign.id);
  });
});

// ---------------------------------------------------------------------------
// trash / restore / delete / emptyTrash / renameNotebook / noteOverview
// ---------------------------------------------------------------------------
describe('notes: lifecycle + noteOverview consistency (real DB)', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Lifecycle' }); });
  afterAll(async () => { await deleteUser(U?.user); });

  const zero = { all: 0, pinned: 0, note: 0, checklist: 0, journal: 0, meeting: 0, archived: 0, trash: 0 };
  const ov = async () => { setClient(U.client); return N.noteOverview(); };

  it('counts / notebooks / tags follow every operation', async () => {
    setClient(U.client);
    expect(await ov()).toEqual({ counts: zero, notebooks: [], tags: [] });

    const a = await N.createNote(uiNewNote({ title: 'A', notebook: 'Sổ 1', tags: ['x', 'y'] }));
    const b = await N.createNote(uiNewNote({ title: 'B', notebook: 'Sổ 1', tags: ['x'], kind: 'checklist', pinned: true }));
    const c = await N.createNote(uiNewNote({ title: 'C', notebook: 'Ấp', kind: 'journal' }));
    expect(await ov()).toEqual({
      counts: { ...zero, all: 3, pinned: 1, note: 1, checklist: 1, journal: 1 },
      notebooks: [{ name: 'Ấp', count: 1 }, { name: 'Sổ 1', count: 2 }],
      tags: [{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }],
    });

    // archive (notes.js toggles { archived })
    await N.updateNote(a.id, { archived: true });
    expect(await ov()).toEqual({
      counts: { ...zero, all: 2, pinned: 1, checklist: 1, journal: 1, archived: 1 },
      notebooks: [{ name: 'Ấp', count: 1 }, { name: 'Sổ 1', count: 1 }],
      tags: [{ tag: 'x', count: 1 }],
    });

    // trash: soft delete + unpin
    const tb = await N.trashNote(b.id);
    expect(tb.pinned).toBe(false);
    const rb = await dbNote(b.id);
    expect(rb.trashed_at).not.toBeNull();
    expect(rb.pinned).toBe(false);
    expect(Math.abs(new Date(rb.trashed_at) - Date.now())).toBeLessThan(60_000);
    expect(await ov()).toEqual({
      counts: { ...zero, all: 1, journal: 1, archived: 1, trash: 1 },
      notebooks: [{ name: 'Ấp', count: 1 }],
      tags: [],
    });
    expect(ids(await N.listNotes({ trashed: true }))).toEqual([b.id]);
    expect(ids(await N.listNotes({}))).toEqual([c.id]);

    // restore: back to live (pin is not restored)
    const rs = await N.restoreNote(b.id);
    expect(rs).toMatchObject({ trashed_at: null, pinned: false });
    expect(await dbNote(b.id)).toMatchObject({ trashed_at: null, pinned: false });
    expect((await ov()).counts).toEqual({ ...zero, all: 2, checklist: 1, journal: 1, archived: 1 });

    // trash an archived note → counted as trash only
    await N.trashNote(a.id);
    expect((await ov()).counts).toEqual({ ...zero, all: 2, checklist: 1, journal: 1, trash: 1 });
    expect(ids(await N.listNotes({ trashed: true }))).toEqual([a.id]);

    // permanent delete
    expect(await N.deleteNote(c.id)).toBe(true);
    expect(await dbNote(c.id)).toBeNull();
    expect(await ov()).toEqual({
      counts: { ...zero, all: 1, checklist: 1, trash: 1 },
      notebooks: [{ name: 'Sổ 1', count: 1 }],
      tags: [{ tag: 'x', count: 1 }],
    });

    // empty trash
    expect(await N.emptyTrash()).toBe(1);
    expect(await dbNote(a.id)).toBeNull();
    expect((await ov()).counts).toEqual({ ...zero, all: 1, checklist: 1 });
    expect(await N.emptyTrash()).toBe(0);

    // rename notebook
    expect(await N.renameNotebook('Sổ 1', 'Sổ mới')).toBe(1);
    expect((await ov()).notebooks).toEqual([{ name: 'Sổ mới', count: 1 }]);
    expect(await N.renameNotebook('Sổ mới', null)).toBe(1);
    expect(await ov()).toEqual({ counts: { ...zero, all: 1, checklist: 1 }, notebooks: [], tags: [{ tag: 'x', count: 1 }] });

    // overview = DB truth
    const rows = await dbNotesOf(U.user.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: b.id, notebook: null, trashed_at: null, archived: false });
  });

  it('deleteNote / restoreNote / trashNote on a missing id', async () => {
    setClient(U.client);
    expect(await N.deleteNote(MISSING)).toBe(true); // DELETE of 0 rows is not an error
    await expect(N.trashNote(MISSING)).rejects.toEqual(appError('not_found'));
    await expect(N.restoreNote(MISSING)).rejects.toEqual(appError('not_found'));
    await expect(N.deleteNote('')).rejects.toEqual(appError('invalid_input'));
  });
});

describe('notes: emptyTrash + renameNotebook are per-user (real DB)', () => {
  let U; let V;
  beforeAll(async () => { [U, V] = await Promise.all([newUser(), newUser()]); });
  afterAll(async () => { await Promise.all([deleteUser(U?.user), deleteUser(V?.user)]); });

  it('emptyTrash removes only my trashed notes', async () => {
    setClient(U.client);
    const u1 = await N.createNote(uiNewNote({ title: 'u rác 1' }));
    const u2 = await N.createNote(uiNewNote({ title: 'u rác 2' }));
    const uLive = await N.createNote(uiNewNote({ title: 'u sống' }));
    await N.trashNote(u1.id); await N.trashNote(u2.id);
    setClient(V.client);
    const v1 = await N.createNote(uiNewNote({ title: 'v rác' }));
    await N.trashNote(v1.id);

    setClient(U.client);
    expect(await N.emptyTrash()).toBe(2);
    expect(ids(await dbNotesOf(U.user.id))).toEqual([uLive.id]);
    const vRows = await dbNotesOf(V.user.id);
    expect(ids(vRows)).toEqual([v1.id]);
    expect(vRows[0].trashed_at).not.toBeNull();
  });

  it('renameNotebook moves all my notes (live, archived, trashed) and leaves other users untouched', async () => {
    setClient(U.client);
    const a = await N.createNote(uiNewNote({ title: 'a', notebook: 'Cũ' }));
    const b = await N.createNote(uiNewNote({ title: 'b', notebook: 'Cũ' }));
    const c = await N.createNote(uiNewNote({ title: 'c', notebook: 'Cũ' }));
    const d = await N.createNote(uiNewNote({ title: 'd', notebook: 'Khác' }));
    await N.updateNote(b.id, { archived: true });
    await N.trashNote(c.id);
    setClient(V.client);
    const v = await N.createNote(uiNewNote({ title: 'v', notebook: 'Cũ' }));

    setClient(U.client);
    expect(await N.renameNotebook('Cũ', '  Mới  ')).toBe(3);
    for (const x of [a, b, c]) expect((await dbNote(x.id)).notebook).toBe('Mới');
    expect((await dbNote(d.id)).notebook).toBe('Khác');
    expect((await dbNote(v.id)).notebook).toBe('Cũ');
    expect(await N.renameNotebook('Không tồn tại', 'X')).toBe(0);

    // validation
    await expect(N.renameNotebook('', 'X')).rejects.toEqual(appError('invalid_input'));
    await expect(N.renameNotebook('Mới', 'x'.repeat(61))).rejects.toEqual(appError('invalid_input'));
    expect((await dbNote(a.id)).notebook).toBe('Mới');

    // V renaming "Cũ" only touches V's note
    setClient(V.client);
    expect(await N.renameNotebook('Mới', 'Hack')).toBe(0);
    expect(await N.renameNotebook('Cũ', null)).toBe(1);
    expect((await dbNote(v.id)).notebook).toBeNull();
    expect((await dbNote(a.id)).notebook).toBe('Mới');
  });
});

// ---------------------------------------------------------------------------
// RLS isolation
// ---------------------------------------------------------------------------
describe('notes: RLS isolation A ↔ B (real DB)', () => {
  it("B cannot read, update, trash, restore, delete, empty or rename A's notes", async () => {
    setClient(A.client);
    const live = await N.createNote(uiNewNote({ title: 'Bí mật của A', notebook: 'RLS', tags: ['rls'] }));
    const trashed = await N.createNote(uiNewNote({ title: 'Rác của A', notebook: 'RLS' }));
    await N.trashNote(trashed.id);
    const liveBefore = await dbNote(live.id);
    const trashedBefore = await dbNote(trashed.id);

    setClient(B.client);
    expect(await N.getNote(live.id)).toBeNull();
    expect(ids(await N.listNotes({ notebook: 'RLS' }))).toEqual([]);
    expect(ids(await N.listNotes({ trashed: true, notebook: 'RLS' }))).toEqual([]);
    expect(ids(await N.listNotes({ search: 'Bí mật' }))).toEqual([]);
    const ovB = await N.noteOverview();
    expect(ovB.notebooks.map((x) => x.name)).not.toContain('RLS');
    expect(ovB.tags.map((x) => x.tag)).not.toContain('rls');

    await expect(N.updateNote(live.id, { title: 'bị sửa' })).rejects.toEqual(appError('not_found'));
    await expect(N.trashNote(live.id)).rejects.toEqual(appError('not_found'));
    await expect(N.restoreNote(trashed.id)).rejects.toEqual(appError('not_found'));
    expect(await N.deleteNote(live.id)).toBe(true); // silently 0 rows
    await N.emptyTrash();
    expect(await N.renameNotebook('RLS', 'B owns it')).toBe(0);

    // raw client attempts that bypass the service validation
    const ins = await B.client.from('notes').insert({ title: 'x', user_id: A.user.id }).select();
    expect(ins.error?.code).toBe('42501');
    const del = await B.client.from('notes').delete().eq('id', live.id).select();
    expect(del.data).toEqual([]);

    expect(await dbNote(live.id)).toEqual(liveBefore);
    expect(await dbNote(trashed.id)).toEqual(trashedBefore);
    setClient(A.client);
    expect(await N.getNote(live.id)).toMatchObject({ title: 'Bí mật của A' });
  });
});

// ---------------------------------------------------------------------------
// listCompletedBetween — Asia/Ho_Chi_Minh day boundaries (dashboard load())
// ---------------------------------------------------------------------------
describe('tasks.listCompletedBetween (real DB, VN day boundaries)', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Done' }); });
  afterAll(async () => { await deleteUser(U?.user); });

  it('a task completed at 23:30 local belongs to that VN day; [dayStart, dayEnd) is half-open', async () => {
    const D = addDays(T, -3);
    const rows = [
      ['late 23:30', `${D}T23:30:00+07:00`],      // = D 16:30Z — UTC day is the same, VN day D
      ['start 00:00', `${D}T00:00:00+07:00`],     // = D-1 17:00Z — inclusive start
      ['early 06:00', `${D}T06:00:00+07:00`],     // = D-1 23:00Z — UTC day D-1, VN day D
      ['prev 23:59', `${addDays(D, -1)}T23:59:59+07:00`],
      ['next 00:00', `${addDays(D, 1)}T00:00:00+07:00`], // exclusive end
    ];
    for (const [title, at] of rows) {
      await sql(
        `insert into public.tasks (user_id, title, status, priority, completed_at, created_at, actual_minutes)
         values ($1, $2, 'completed', 'medium', $3, $3, 25)`,
        [U.user.id, title, at], { replica: true },
      );
    }
    // open task + other user's completed task in range must not appear
    await sql(`insert into public.tasks (user_id, title, status, priority) values ($1, 'open', 'todo', 'low')`, [U.user.id], { replica: true });
    await sql(
      `insert into public.tasks (user_id, title, status, priority, completed_at) values ($1, 'foreign', 'completed', 'low', $2)`,
      [B.user.id, `${D}T12:00:00+07:00`], { replica: true },
    );

    setClient(U.client);
    const fromIso = dayStartInstant(D).toISOString();
    const toIso = dayEndInstant(D).toISOString();
    expect(fromIso).toBe(`${addDays(D, -1)}T17:00:00.000Z`);
    expect(toIso).toBe(`${D}T17:00:00.000Z`);

    const got = await tasks.listCompletedBetween(fromIso, toIso);
    expect(got.map((r) => r.title)).toEqual(['start 00:00', 'early 06:00', 'late 23:30']); // ascending
    expect(Object.keys(got[0]).sort()).toEqual(['actual_minutes', 'category_id', 'completed_at', 'id', 'title']);
    expect(typeof got[0].actual_minutes).toBe('number');
    for (const r of got) expect(dayOf(r.completed_at)).toBe(D);

    // dashboard range: (prev week start | 13 days ago) .. end of today
    const wide = await tasks.listCompletedBetween(dayStartInstant(addDays(T, -13)).toISOString(), dayEndInstant(T).toISOString());
    expect(wide.map((r) => r.title)).toEqual(['prev 23:59', 'start 00:00', 'early 06:00', 'late 23:30', 'next 00:00']);
    expect(wide.map((r) => r.title)).not.toContain('foreign');

    // next day holds only the 00:00 one
    expect((await tasks.listCompletedBetween(dayStartInstant(addDays(D, 1)).toISOString(), dayEndInstant(addDays(D, 1)).toISOString())).map((r) => r.title))
      .toEqual(['next 00:00']);
  });

  it('completing a task via setTaskStatus shows up in today; reopening removes it', async () => {
    setClient(U.client);
    const t = await tasks.createTask({ title: 'Hoàn thành hôm nay' });
    const range = [dayStartInstant(T).toISOString(), dayEndInstant(T).toISOString()];
    expect((await tasks.listCompletedBetween(...range)).map((r) => r.id)).not.toContain(t.id);
    await tasks.setTaskStatus(t.id, 'completed');
    const { data: row } = await admin.from('tasks').select('completed_at').eq('id', t.id).single();
    expect(dayOf(row.completed_at)).toBe(T);
    expect((await tasks.listCompletedBetween(...range)).map((r) => r.id)).toContain(t.id);
    await tasks.setTaskStatus(t.id, 'todo');
    expect((await tasks.listCompletedBetween(...range)).map((r) => r.id)).not.toContain(t.id);
  });
});

// ---------------------------------------------------------------------------
// activity feed (dashboard: recentActivity(10); settings: clearActivity())
// ---------------------------------------------------------------------------
describe('activity: recentActivity + clearActivity (real DB)', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Feed' }); });
  afterAll(async () => { await deleteUser(U?.user); });

  it('feed holds task/expense events newest first (notes are not logged), honours the limit', async () => {
    setClient(U.client);
    await activity.clearActivity();
    expect(await activity.recentActivity(10)).toEqual([]);

    const t = await tasks.createTask({ title: 'Việc A' }); await tick();
    await N.createNote(uiNewNote({ title: 'note không vào feed' })); await tick();
    const x = await expenses.createExpense({ amount: 45000, spent_on: T, description: 'Cà phê', category_id: null, payment_method: 'cash', note: null }); await tick();
    await tasks.updateTask(t.id, { title: 'Việc A (sửa)' }); await tick(); // plain edit: not logged
    await tasks.setTaskStatus(t.id, 'completed'); await tick();
    const n2 = await N.createNote(uiNewNote({ title: 'note 2' }));
    await N.trashNote(n2.id);

    const feed = await activity.recentActivity(10);
    expect(feed.map((r) => [r.entity_type, r.action, r.title])).toEqual([
      ['task', 'completed', 'Việc A (sửa)'],
      ['expense', 'created', 'Cà phê'],
      ['task', 'created', 'Việc A'],
    ]);
    expect(feed[1]).toMatchObject({ entity_id: x.id });
    expect(Number(feed[1].metadata.amount)).toBe(45000);
    expect(feed[0].metadata).toEqual({});
    expect(Object.keys(feed[0]).sort()).toEqual(activity.ACTIVITY_COLS.split(', ').sort());
    for (let i = 1; i < feed.length; i++) expect(feed[i - 1].created_at >= feed[i].created_at).toBe(true);
    expect(ids(feed)).toEqual(ids(await dbActivityOf(U.user.id)));

    expect((await activity.recentActivity(2)).map((r) => r.action)).toEqual(['completed', 'created']);
    expect((await activity.recentActivity()).length).toBe(3);
    await expect(activity.recentActivity(0)).rejects.toEqual(appError('invalid_input'));
    await expect(activity.recentActivity(201)).rejects.toEqual(appError('invalid_input'));
    await expect(activity.recentActivity(2.5)).rejects.toEqual(appError('invalid_input'));
  });

  it('clearActivity deletes only my feed', async () => {
    setClient(B.client);
    await tasks.createTask({ title: 'B task cho feed' });
    const bBefore = await dbActivityOf(B.user.id);
    expect(bBefore.length).toBeGreaterThan(0);

    setClient(U.client);
    expect((await dbActivityOf(U.user.id)).length).toBeGreaterThan(0);
    expect(await activity.clearActivity()).toBe(true);
    expect(await dbActivityOf(U.user.id)).toEqual([]);
    expect(await activity.recentActivity(10)).toEqual([]);
    expect(await dbActivityOf(B.user.id)).toEqual(bBefore);

    // feed resumes after clearing
    await tasks.createTask({ title: 'Sau khi xoá' });
    expect((await activity.recentActivity(10)).map((r) => r.title)).toEqual(['Sau khi xoá']);
  });
});

// ---------------------------------------------------------------------------
// public.notes_search_document (SQL)
// ---------------------------------------------------------------------------
describe('public.notes_search_document (SQL)', () => {
  it('is IMMUTABLE, deterministic and equals the stored notes.search column', async () => {
    const [p] = await sql(`select provolatile, proparallel from pg_proc where oid = 'public.notes_search_document(text, text[], text)'::regprocedure`);
    expect(p).toEqual({ provolatile: 'i', proparallel: 's' });

    const args = ['Báo cáo Tuần', ['Khẩn', 'dự-án'], 'Nội dung **markdown** 100%'];
    const [r] = await sql(
      `select public.notes_search_document($1, $2, $3)::text a, public.notes_search_document($1, $2, $3)::text b,
              public.notes_search_document($1, $2, $3) = public.notes_search_document($1, $2, $3) same`, args,
    );
    expect(r.a).toBe(r.b);
    expect(r.same).toBe(true);
    for (const lex of ["'báo'", "'cáo'", "'tuần'", "'khẩn'", "'nội'", "'markdown'", "'100'"]) expect(r.a).toContain(lex);

    setClient(A.client);
    const n = await N.createNote(uiNewNote({ title: args[0], tags: args[1], content: args[2] }));
    const tags = (await dbNote(n.id)).tags;
    const [s] = await sql(
      `select search::text = public.notes_search_document(title, tags, content)::text eq,
              public.notes_search_document($2, $3, $4)::text = search::text eq2
         from public.notes where id = $1`, [n.id, args[0], tags, args[2]],
    );
    expect(s).toEqual({ eq: true, eq2: true });
  });

  it('is case-insensitive and NULL-safe', async () => {
    const [r] = await sql(
      `select public.notes_search_document('BÁO CÁO', null, null)::text up,
              public.notes_search_document('báo cáo', '{}', '')::text low,
              public.notes_search_document(null, null, null)::text empty,
              public.notes_search_document('Báo', null, null) @@ to_tsquery('simple', 'báo:*') hit`,
    );
    expect(r.up).toBe(r.low);
    expect(r.empty).toBe('');
    expect(r.hit).toBe(true);
  });

  it('is accent-INsensitive since 001100 ("bao" matches "Báo"), also for NFD-stored text', async () => {
    const [r] = await sql(
      `select public.notes_search_document('Báo cáo', null, null) @@ to_tsquery('simple', 'bao:* & cao:*') unaccented,
              public.notes_search_document($1, null, null) @@ to_tsquery('simple', 'bao:* & cao:*') nfd_found`, ['Báo cáo'.normalize('NFD')],
    );
    expect(r.unaccented).toBe(true);
    expect(r.nfd_found).toBe(true);
  });
});
