// Tasks + timer/time entries against the REAL local Supabase stack, via the real services.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import { AppError } from '../../src/services/errors.js';
import * as tasks from '../../src/services/tasks.js';
import * as timer from '../../src/services/timer.js';
import * as legacy from '../../src/services/timeEntries.js';
import * as categories from '../../src/services/categories.js';
import { addDays } from '../../src/utils/date.js';

const users = [];
async function user(opts) {
  const u = await newUser(opts);
  users.push(u);
  setClient(u.client);
  return u;
}
afterEach(async () => {
  while (users.length) await deleteUser(users.pop().user);
});

async function expectAppError(p, code, field) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect(err.code).toBe(code);
  if (field !== undefined) expect(err.details.field).toBe(field);
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const TODAY = todayVN();

// ---------------------------------------------------------------------------
describe('tasks service', () => {
  it('create / get / update round-trip with normalisation', async () => {
    await user();
    const t = await tasks.createTask({
      title: '  Viết báo cáo  ', description: '', priority: 'high', tags: ['#Work', 'work', ' home '],
      due_date: TODAY, estimated_minutes: '45',
    });
    expect(t.title).toBe('Viết báo cáo');
    expect(t.description).toBeNull();
    expect(t.status).toBe('todo');
    expect(t.tags).toEqual(['Work', 'home']);
    expect(t.estimated_minutes).toBe(45);
    expect(t.actual_minutes).toBe(0);
    expect(t.recurrence).toBeNull();
    expect(t.category).toBeNull();

    const got = await tasks.getTask(t.id);
    expect(got.id).toBe(t.id);

    const cats = await categories.listCategories('task');
    const up = await tasks.updateTask(t.id, { priority: 'urgent', category_id: cats[1].id, description: 'chi tiết' });
    expect(up.priority).toBe('urgent');
    expect(up.category).toMatchObject({ id: cats[1].id, name: cats[1].name });
    expect(up.title).toBe('Viết báo cáo');

    // aliases
    expect((await tasks.get(t.id)).priority).toBe('urgent');
    expect(await tasks.getTask('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('validation errors carry AppError invalid_input + field', async () => {
    await user();
    await expectAppError(tasks.createTask({ title: '   ' }), 'invalid_input', 'title');
    await expectAppError(tasks.createTask({ title: 'x'.repeat(201) }), 'invalid_input', 'title');
    await expectAppError(tasks.createTask({ title: 'ok', status: 'done' }), 'invalid_input', 'status');
    await expectAppError(tasks.createTask({ title: 'ok', priority: 'meh' }), 'invalid_input', 'priority');
    await expectAppError(tasks.createTask({ title: 'ok', due_date: '2026-02-30' }), 'invalid_input', 'due_date');
    await expectAppError(tasks.createTask({ title: 'ok', estimated_minutes: -1 }), 'invalid_input', 'estimated_minutes');
    await expectAppError(tasks.createTask({ title: 'ok', estimated_minutes: 1.5 }), 'invalid_input', 'estimated_minutes');
    await expectAppError(tasks.createTask({ title: 'ok', recurrence: 'yearly' }), 'invalid_input', 'recurrence');
    await expectAppError(tasks.createTask({ title: 'ok', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), 'invalid_input', 'tags');
    await expectAppError(tasks.updateTask('', { title: 'x' }), 'invalid_input', 'id');
    const t = await tasks.createTask({ title: 'ok' });
    await expectAppError(tasks.updateTask(t.id, { user_id: 'x', actual_minutes: 5 }), 'invalid_input', null);
    await expectAppError(tasks.listTasks({ dueFrom: 'nope' }), 'invalid_input', 'dueFrom');
    // malformed uuid reaches the DB → 22P02 → invalid_input
    await expectAppError(tasks.createTask({ title: 'ok', category_id: 'not-a-uuid' }), 'invalid_input');
  });

  it('server-owned fields are stripped (user_id of another user ignored)', async () => {
    const B = await user();
    const A = await user();
    const t = await tasks.createTask({
      title: 'Mine', user_id: B.user.id, actual_minutes: 999, completed_at: '2020-01-01T00:00:00Z', id: '11111111-1111-1111-1111-111111111111',
    });
    expect(t.user_id).toBe(A.user.id);
    expect(t.actual_minutes).toBe(0);
    expect(t.completed_at).toBeNull();
    expect(t.id).not.toBe('11111111-1111-1111-1111-111111111111');
    const up = await tasks.updateTask(t.id, { title: 'Mine 2', user_id: B.user.id });
    expect(up.user_id).toBe(A.user.id);
    const { data } = await admin.from('tasks').select('user_id').eq('id', t.id).single();
    expect(data.user_id).toBe(A.user.id);
  });

  it('category of another user / of wrong kind → mapped AppError', async () => {
    await user();
    const bCat = (await categories.listCategories('task'))[0];
    await user();
    await expectAppError(tasks.createTask({ title: 'x', category_id: bCat.id }), 'invalid_reference');
    const expCat = (await categories.listCategories('expense'))[0];
    await expectAppError(tasks.createTask({ title: 'x', category_id: expCat.id }), 'invalid_input');
    const t = await tasks.createTask({ title: 'x' });
    await expectAppError(tasks.updateTask(t.id, { category_id: bCat.id }), 'invalid_reference');
  });

  it('listTasks: every filter, ordering, paging', async () => {
    await user();
    const [c1, c2] = await categories.listCategories('task');
    const yday = addDays(TODAY, -1);
    const mk = (o) => tasks.createTask(o);
    const special = await mk({ title: 'Họp a,b (c) "q" khách', priority: 'high', category_id: c1.id, tags: ['meet'], due_date: addDays(TODAY, 3) });
    const pct = await mk({ title: 'Giảm 50%_off', description: 'back\\slash', priority: 'low', category_id: c2.id, due_date: addDays(TODAY, 10) });
    const plain = await mk({ title: 'Mua sữa', priority: 'medium', tags: ['home', 'meet'] });
    const overdue = await mk({ title: 'Trễ hạn', priority: 'urgent', due_date: yday });
    const overdueDone = await mk({ title: 'Trễ nhưng xong', priority: 'urgent', due_date: yday });
    await tasks.setTaskStatus(overdueDone.id, 'completed');
    const inProg = await mk({ title: 'Đang làm', status: 'in_progress', due_date: TODAY, description: 'percent 100%' });

    const ids = (rows) => rows.map((r) => r.id);
    const all = await tasks.listTasks();
    expect(all).toHaveLength(6);
    // due_date asc, nulls last
    expect(all[all.length - 1].id).toBe(plain.id);
    expect(ids(all).slice(0, 2).sort()).toEqual([overdue.id, overdueDone.id].sort());
    expect(all[2].id).toBe(inProg.id);

    // search: special characters are literal
    expect(ids(await tasks.listTasks({ search: 'a,b (c)' }))).toEqual([special.id]);
    expect(ids(await tasks.listTasks({ search: '"q"' }))).toEqual([special.id]);
    expect(ids(await tasks.listTasks({ search: '%_' }))).toEqual([pct.id]);
    expect(ids(await tasks.listTasks({ search: '%' })).sort()).toEqual([pct.id, inProg.id].sort());
    expect(ids(await tasks.listTasks({ search: '_' }))).toEqual([pct.id]);
    expect(ids(await tasks.listTasks({ search: 'back\\slash' }))).toEqual([pct.id]);
    expect(ids(await tasks.listTasks({ search: 'SỮA' }))).toEqual([plain.id]); // ilike, case-insensitive
    expect(await tasks.listTasks({ search: 'không-có' })).toEqual([]);
    expect(ids(await tasks.listTasks({ search: 'percent' }))).toEqual([inProg.id]); // description

    // status
    expect(ids(await tasks.listTasks({ status: 'completed' }))).toEqual([overdueDone.id]);
    expect(ids(await tasks.listTasks({ status: ['in_progress', 'completed'] })).sort()).toEqual([inProg.id, overdueDone.id].sort());
    expect(await tasks.listTasks({ status: [] })).toHaveLength(6);

    // category
    expect(ids(await tasks.listTasks({ categoryId: c1.id }))).toEqual([special.id]);
    expect(await tasks.listTasks({ categoryId: 'none' })).toHaveLength(4);

    // priority
    expect(ids(await tasks.listTasks({ priority: 'low' }))).toEqual([pct.id]);
    expect(await tasks.listTasks({ priority: ['urgent', 'high'] })).toHaveLength(3);

    // tag
    expect(ids(await tasks.listTasks({ tag: 'meet' })).sort()).toEqual([special.id, plain.id].sort());
    expect(ids(await tasks.listTasks({ tag: ' home ' }))).toEqual([plain.id]);

    // due range
    expect(ids(await tasks.listTasks({ dueFrom: TODAY, dueTo: addDays(TODAY, 3) }))).toEqual([inProg.id, special.id]);
    expect(await tasks.listTasks({ dueFrom: addDays(TODAY, 4) })).toHaveLength(1);
    expect(await tasks.listTasks({ dueTo: yday })).toHaveLength(2);

    // overdue (open only unless a status is given)
    expect(ids(await tasks.listTasks({ overdue: true }))).toEqual([overdue.id]);
    expect(ids(await tasks.listTasks({ overdue: true, status: 'completed' }))).toEqual([overdueDone.id]);

    // paging
    const p1 = await tasks.listTasks({ limit: 2 });
    const p2 = await tasks.listTasks({ limit: 2, offset: 2 });
    const p4 = await tasks.listTasks({ limit: 2, offset: 6 });
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(2);
    expect(p4).toHaveLength(0);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all).slice(0, 4));

    // combined
    expect(ids(await tasks.listTasks({ search: 'trễ', status: ['todo'], priority: 'urgent' }))).toEqual([overdue.id]);
  });

  it('tag filter is literal for tags with , " {} \\ NULL', async () => {
    await user();
    const weird = ['a,b', 'x"y', 'br{ace}', 'back\\sl', 'NULL', 'sp ace', 'c++'];
    const p = await tasks.createTask({ title: 'weird', tags: weird });
    await tasks.createTask({ title: 'ab', tags: ['a', 'b'] });
    expect(p.tags).toEqual(weird);
    for (const tag of weird) {
      expect((await tasks.listTasks({ tag })).map((r) => r.title), tag).toEqual(['weird']);
    }
    expect((await tasks.listTasks({ tag: 'a' })).map((r) => r.title)).toEqual(['ab']);
  });

  it('setTaskStatus sets / clears completed_at; deleteTask', async () => {
    await user();
    const t = await tasks.createTask({ title: 'Đóng' });
    const done = await tasks.setTaskStatus(t.id, 'completed');
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
    const again = await tasks.updateTask(t.id, { title: 'Đóng 2' });
    expect(again.completed_at).toBe(done.completed_at);
    const reopened = await tasks.setTaskStatus(t.id, 'todo');
    expect(reopened.completed_at).toBeNull();
    const cancelled = await tasks.setStatus(t.id, 'cancelled');
    expect(cancelled.completed_at).toBeNull();
    await expectAppError(tasks.setTaskStatus(t.id, 'nope'), 'invalid_input', 'status');
    await expectAppError(tasks.setTaskStatus('00000000-0000-0000-0000-000000000000', 'todo'), 'not_found');

    expect(await tasks.deleteTask(t.id)).toBe(true);
    expect(await tasks.getTask(t.id)).toBeNull();
    await expectAppError(tasks.updateTask(t.id, { title: 'gone' }), 'not_found');
  });

  it('bulk helpers, duplicate and restore', async () => {
    await user();
    const a = await tasks.createTask({ title: 'A', tags: ['x'], recurrence: 'weekly', due_date: TODAY });
    const b = await tasks.createTask({ title: 'B' });
    const upd = await tasks.bulkUpdateTasks([a.id, b.id], { priority: 'low' });
    expect(upd.map((r) => r.priority)).toEqual(['low', 'low']);
    const st = await tasks.bulkSetTaskStatus([b.id], 'in_progress');
    expect(st[0].status).toBe('in_progress');
    const dup = await tasks.duplicateTask(a);
    expect(dup.title).toBe('A (bản sao)');
    expect(dup.recurrence).toBe('weekly');
    expect(await tasks.bulkDeleteTasks([a.id, b.id])).toBe(2);
    const restored = await tasks.restoreTask(b);
    expect(restored.id).not.toBe(b.id);
    expect(restored.title).toBe('B');
    await expectAppError(tasks.bulkDeleteTasks([]), 'invalid_input', 'ids');
  });

  it('recurrence: completing a recurring task spawns the next one (real trigger)', async () => {
    await user();
    const [cat] = await categories.listCategories('task');
    const t = await tasks.createTask({
      title: 'Tập thể dục', recurrence: 'daily', due_date: TODAY, category_id: cat.id, tags: ['health'], estimated_minutes: 20, priority: 'high',
    });
    expect(t.recurrence).toBe('daily');
    await tasks.setTaskStatus(t.id, 'completed');
    const open = await tasks.listTasks({ status: 'todo' });
    expect(open).toHaveLength(1);
    const next = open[0];
    expect(next.id).not.toBe(t.id);
    expect(next).toMatchObject({
      title: 'Tập thể dục', recurrence: 'daily', recurrence_parent_id: t.id, due_date: addDays(TODAY, 1),
      category_id: cat.id, tags: ['health'], estimated_minutes: 20, priority: 'high', actual_minutes: 0,
    });
    // reopen + re-complete is idempotent
    await tasks.setTaskStatus(t.id, 'todo');
    await tasks.setTaskStatus(t.id, 'completed');
    expect(await tasks.listTasks({ status: 'todo' })).toHaveLength(1);
    // completing the spawned one continues the series
    await tasks.setTaskStatus(next.id, 'completed');
    const n2 = await tasks.listTasks({ status: 'todo' });
    expect(n2).toHaveLength(1);
    expect(n2[0]).toMatchObject({ recurrence_parent_id: t.id, due_date: addDays(TODAY, 2) });
    // a non-recurring task does not spawn
    const plain = await tasks.createTask({ title: 'once' });
    await tasks.setTaskStatus(plain.id, 'completed');
    expect(await tasks.listTasks({ search: 'once' })).toHaveLength(1);
  });

  it('focusTasks ranks open tasks with reasons', async () => {
    await user();
    const od = await tasks.createTask({ title: 'Quá hạn', priority: 'urgent', due_date: addDays(TODAY, -2), estimated_minutes: 15 });
    const tm = await tasks.createTask({ title: 'Mai', priority: 'high', due_date: addDays(TODAY, 1), status: 'in_progress' });
    await tasks.createTask({ title: 'Thấp', priority: 'low' });
    const closed = await tasks.createTask({ title: 'Xong', priority: 'urgent', due_date: TODAY });
    await tasks.setTaskStatus(closed.id, 'completed');

    const f = await tasks.focusTasks(5);
    expect(f.map((r) => r.task_id)).not.toContain(closed.id);
    expect(f).toHaveLength(3);
    expect(f[0]).toMatchObject({ task_id: od.id, reasons: ['overdue', 'priority_urgent', 'quick_win'] });
    expect(f[0].score).toBe(40 + 30 + 4 + 5);
    expect(typeof f[0].score).toBe('number');
    expect(f[1]).toMatchObject({ task_id: tm.id, reasons: ['due_tomorrow', 'priority_high', 'in_progress'], score: 28 + 22 + 10 });
    expect(f[2].reasons).toEqual([]);
    expect(await tasks.focusTasks(1)).toHaveLength(1);
    await expectAppError(tasks.focusTasks(0), 'invalid_input', 'limit');
  });

  it('estimateSuggestion uses completed tasks with tracked time', async () => {
    await user();
    const empty = await tasks.estimateSuggestion();
    expect(empty).toMatchObject({ samples: 0, accuracy_ratio: null, suggested_multiplier: null });
    const [cat] = await categories.listCategories('task');
    for (let i = 0; i < 3; i++) {
      const t = await tasks.createTask({ title: `E${i}`, estimated_minutes: 30, category_id: cat.id });
      await timer.logTime({ taskId: t.id, startedAt: minsAgo(200 + i * 100), endedAt: minsAgo(140 + i * 100) });
      await tasks.setTaskStatus(t.id, 'completed');
    }
    const s = await tasks.estimateSuggestion();
    expect(s).toEqual({ samples: 3, accuracy_ratio: 2, median_actual_minutes: 60, suggested_multiplier: 2 });
    expect((await tasks.estimateSuggestion(cat.id)).samples).toBe(3);
    const other = (await categories.listCategories('task'))[1];
    expect((await tasks.estimateSuggestion(other.id)).samples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('timer / time entries service', () => {
  it('start (todo→in_progress), auto-stop on restart, current, stop', async () => {
    await user();
    const t1 = await tasks.createTask({ title: 'T1' });
    const t2 = await tasks.createTask({ title: 'T2' });
    expect(await timer.current()).toBeNull();
    expect(await timer.stop()).toBeNull();

    const e1 = await timer.start(t1.id, '  phiên 1 ');
    expect(e1).toMatchObject({ task_id: t1.id, description: 'phiên 1', ended_at: null, source: 'timer', duration_seconds: null });
    expect((await tasks.getTask(t1.id)).status).toBe('in_progress');

    await sleep(1300);
    const cur = await timer.current();
    expect(cur.entry.id).toBe(e1.id);
    expect(cur.task_title).toBe('T1');
    expect(cur.elapsed_seconds).toBeGreaterThanOrEqual(1);
    expect(typeof cur.task_total_seconds).toBe('number');

    const e2 = await timer.start(t2.id);
    expect(e2.id).not.toBe(e1.id);
    const all = await timer.listEntries({});
    expect(all).toHaveLength(2);
    const closed = all.find((e) => e.id === e1.id);
    expect(closed.ended_at).toBeTruthy();
    expect(closed.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(all.filter((e) => e.ended_at == null).map((e) => e.id)).toEqual([e2.id]);
    expect((await timer.current()).entry.id).toBe(e2.id);

    const stopped = await timer.stop();
    expect(stopped.id).toBe(e2.id);
    expect(stopped.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(await timer.current()).toBeNull();

    // timer without a task
    const free = await timer.start();
    expect(free.task_id).toBeNull();
    expect((await timer.current()).task_total_seconds).toBeNull();
    await timer.stop();
  });

  it('start rejects closed / unknown tasks and over-long description', async () => {
    await user();
    const t = await tasks.createTask({ title: 'done' });
    await tasks.setTaskStatus(t.id, 'completed');
    await expectAppError(timer.start(t.id), 'task_closed');
    await expectAppError(timer.start('00000000-0000-0000-0000-000000000000'), 'not_found');
    await expectAppError(timer.start(null, 'x'.repeat(501)), 'invalid_input', 'description');
    expect(await timer.current()).toBeNull();
  });

  it('logTime: ok, overlap, future, validation; actual_minutes synced', async () => {
    await user();
    const t = await tasks.createTask({ title: 'Log', status: 'in_progress' });
    const e = await timer.logTime({ taskId: t.id, startedAt: minsAgo(120), endedAt: minsAgo(90), description: 'thủ công' });
    expect(e).toMatchObject({ task_id: t.id, source: 'manual', description: 'thủ công', duration_seconds: 1800 });
    expect((await tasks.getTask(t.id)).actual_minutes).toBe(30);

    await expectAppError(timer.logTime({ taskId: t.id, startedAt: minsAgo(100), endedAt: minsAgo(80) }), 'time_overlap');
    // back-to-back is fine (half-open ranges)
    const e2 = await timer.logTime({ taskId: t.id, startedAt: minsAgo(90), endedAt: minsAgo(80) });
    expect((await tasks.getTask(t.id)).actual_minutes).toBe(40);

    await expectAppError(timer.logTime({ startedAt: minsAgo(10), endedAt: new Date(Date.now() + 3600_000) }), 'invalid_input', 'endedAt');
    await expectAppError(timer.logTime({ startedAt: minsAgo(10), endedAt: minsAgo(20) }), 'invalid_input', 'endedAt');
    await expectAppError(timer.logTime({ startedAt: minsAgo(60 * 30), endedAt: minsAgo(60) }), 'invalid_input', 'endedAt');
    await expectAppError(timer.logTime({ endedAt: minsAgo(20) }), 'invalid_input', 'startedAt');
    await expectAppError(timer.logTime({ startedAt: 'garbage', endedAt: minsAgo(20) }), 'invalid_input', 'startedAt');
    await expectAppError(timer.logTime({ taskId: '00000000-0000-0000-0000-000000000000', startedAt: minsAgo(30), endedAt: minsAgo(25) }), 'not_found');

    // running timer counts as [start, ∞)
    await timer.start(t.id);
    await expectAppError(timer.logTime({ startedAt: minsAgo(5), endedAt: new Date() }), 'time_overlap');
    await timer.stop();

    // update / delete entry keep actual_minutes in sync
    const up = await timer.updateEntry(e2.id, { started_at: minsAgo(89), ended_at: minsAgo(69), description: 'sửa' });
    expect(up.duration_seconds).toBe(1200);
    expect(up.description).toBe('sửa');
    expect(up.task).toMatchObject({ id: t.id, title: 'Log' });
    const t3 = await tasks.getTask(t.id);
    expect(t3.actual_minutes).toBeGreaterThanOrEqual(50);
    await expectAppError(timer.updateEntry(e2.id, { started_at: minsAgo(10), ended_at: minsAgo(20) }), 'invalid_input', 'ended_at');
    await expectAppError(timer.updateEntry(e2.id, { source: 'timer' }), 'invalid_input', null);
    // ended <= started via DB CHECK (only ended_at sent)
    await expectAppError(timer.updateEntry(e2.id, { ended_at: minsAgo(200) }), 'invalid_input');
    // detach from task
    await timer.updateEntry(e.id, { task_id: null });
    expect(await timer.deleteEntry(e2.id)).toBe(true);
    const after = await tasks.getTask(t.id);
    expect(after.actual_minutes).toBe(Math.round((await timer.listEntries({ taskId: t.id })).reduce((s, x) => s + x.duration_seconds, 0) / 60));
    await expectAppError(timer.updateEntry('00000000-0000-0000-0000-000000000000', { description: 'x' }), 'not_found');
  });

  it('listEntries: day and instant ranges, taskId filter, ordering', async () => {
    await user();
    const t = await tasks.createTask({ title: 'R' });
    const a = await timer.logTime({ taskId: t.id, startedAt: minsAgo(60 * 49), endedAt: minsAgo(60 * 48) });
    const b = await timer.logTime({ startedAt: minsAgo(30), endedAt: minsAgo(20) });
    const all = await timer.listEntries();
    expect(all.map((x) => x.id)).toEqual([b.id, a.id]); // started_at desc
    expect((await timer.listEntries({ taskId: t.id })).map((x) => x.id)).toEqual([a.id]);
    expect((await timer.listEntries({ from: minsAgo(60) })).map((x) => x.id)).toEqual([b.id]);
    expect((await timer.listEntries({ to: minsAgo(60) })).map((x) => x.id)).toEqual([a.id]);
    // day form: entries that started today (user tz). b started 30 min ago → today unless just past midnight.
    const dayOfB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(b.started_at));
    expect((await timer.listEntries({ from: dayOfB, to: dayOfB })).map((x) => x.id)).toContain(b.id);
    expect((await timer.listEntries({ from: '2000-01-01', to: '2000-01-02' }))).toEqual([]);
    expect(await timer.listEntries({ limit: 1 })).toHaveLength(1);
    await expectAppError(timer.listEntries({ from: 'not a date' }), 'invalid_input', 'from');
  });

  it('legacy timeEntries.js API', async () => {
    await user();
    const t = await tasks.createTask({ title: 'Legacy' });
    expect(await legacy.getRunningEntry()).toBeNull();
    const run = await legacy.startEntry({ task_id: t.id, description: 'cũ' });
    expect(run.task_id).toBe(t.id);
    const r = await legacy.getRunningEntry();
    expect(r.id).toBe(run.id);
    await sleep(1100);
    const stopped = await legacy.stopEntry(r);
    expect(stopped.id).toBe(run.id);
    expect(stopped.ended_at).toBeTruthy();
    expect(await legacy.getRunningEntry()).toBeNull();

    const m = await legacy.createManualEntry({ task_id: t.id, started_at: minsAgo(300), ended_at: minsAgo(240), description: 'tay' });
    expect(m).toMatchObject({ source: 'manual', duration_seconds: 3600 });
    const list = await legacy.listEntries(minsAgo(400), new Date(Date.now() + 60_000).toISOString());
    expect(list.map((x) => x.id)).toEqual([run.id, m.id]);
    expect((await legacy.listEntriesForTask(t.id))).toHaveLength(2);
    await expectAppError(legacy.listEntries(null, minsAgo(1)), 'invalid_input', 'from');
    const up = await legacy.updateEntry(m.id, { description: 'đổi' });
    expect(up.description).toBe('đổi');
    expect(await legacy.deleteEntry(m.id)).toBe(true);
    expect(legacy.entrySeconds({ duration_seconds: 5 })).toBe(5);
    expect((await tasks.getTask(t.id)).actual_minutes).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('RLS through the services (tasks / time)', () => {
  it('user B cannot read, update, delete A\'s tasks or time entries, nor time A\'s task', async () => {
    const A = await user();
    const t = await tasks.createTask({ title: 'Bí mật A', tags: ['a'] });
    const e = await timer.logTime({ taskId: t.id, startedAt: minsAgo(50), endedAt: minsAgo(40) });

    await user();
    expect(await tasks.listTasks()).toEqual([]);
    expect(await tasks.listTasks({ search: 'Bí mật' })).toEqual([]);
    expect(await tasks.getTask(t.id)).toBeNull();
    await expectAppError(tasks.updateTask(t.id, { title: 'hacked' }), 'not_found');
    await expectAppError(tasks.setTaskStatus(t.id, 'completed'), 'not_found');
    expect(await tasks.bulkUpdateTasks([t.id], { title: 'hacked' })).toEqual([]);
    await tasks.deleteTask(t.id); // silently affects 0 rows
    await expectAppError(timer.start(t.id), 'not_found');
    await expectAppError(timer.logTime({ taskId: t.id, startedAt: minsAgo(30), endedAt: minsAgo(20) }), 'not_found');
    expect(await timer.listEntries()).toEqual([]);
    expect(await legacy.listEntriesForTask(t.id)).toEqual([]);
    await expectAppError(timer.updateEntry(e.id, { description: 'x' }), 'not_found');
    await timer.deleteEntry(e.id);
    expect(await tasks.focusTasks()).toEqual([]);
    // B's own task cannot be pointed at A's... and B's entry cannot reference A's task
    const bt = await tasks.createTask({ title: 'B task' });
    const be = await timer.logTime({ taskId: bt.id, startedAt: minsAgo(30), endedAt: minsAgo(20) });
    await expectAppError(timer.updateEntry(be.id, { task_id: t.id }), 'invalid_reference');

    // A's data is intact
    setClient(A.client);
    const still = await tasks.getTask(t.id);
    expect(still).toMatchObject({ title: 'Bí mật A', status: 'todo', actual_minutes: 10 });
    expect((await timer.listEntries()).map((x) => x.id)).toEqual([e.id]);
  });
});
