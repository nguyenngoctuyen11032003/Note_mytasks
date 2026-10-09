import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import * as tasks from '../../src/services/tasks.js';
import * as timer from '../../src/services/timer.js';
import * as timeEntries from '../../src/services/timeEntries.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});
afterEach(() => vi.useRealTimers());

const FORBIDDEN = ['user_id', 'actual_minutes', 'completed_at', 'current_value', 'total_price', 'duration_seconds', 'id', 'created_at'];

describe('tasks.listTasks', () => {
  it('selects * with category embed (works without 000300 columns)', async () => {
    fake.respond('tasks', { data: [] });
    await tasks.listTasks();
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'select')[0][0]).toBe('*, category:categories(id, name, color)');
    expect(fake.argsOf(c, 'select')[0][0]).not.toMatch(/recurrence/);
  });

  it('orders due_date asc nulls last, then created_at desc, with range pagination', async () => {
    await tasks.listTasks({ limit: 50, offset: 100 });
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'order')).toEqual([
      ['due_date', { ascending: true, nullsFirst: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
    expect(fake.argsOf(c, 'range')).toEqual([[100, 149]]);
  });

  it('status string → eq, array → in; priority, category none, tag, due range', async () => {
    await tasks.listTasks({ status: 'todo', priority: ['high', 'urgent'], categoryId: 'none', tag: ' work ', dueFrom: '2026-10-01', dueTo: '2026-10-31' });
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'eq')).toContainEqual(['status', 'todo']);
    expect(fake.argsOf(c, 'in')).toContainEqual(['priority', ['high', 'urgent']]);
    expect(fake.argsOf(c, 'is')).toContainEqual(['category_id', null]);
    expect(fake.argsOf(c, 'contains')).toContainEqual(['tags', ['work']]);
    expect(fake.argsOf(c, 'gte')).toContainEqual(['due_date', '2026-10-01']);
    expect(fake.argsOf(c, 'lte')).toContainEqual(['due_date', '2026-10-31']);

    await tasks.listTasks({ status: ['todo', 'completed'] });
    expect(fake.argsOf(fake.last('from', 'tasks'), 'in')).toContainEqual(['status', ['todo', 'completed']]);
  });

  it('overdue adds due_date < today and open statuses', async () => {
    await tasks.listTasks({ overdue: true });
    const c = fake.last('from', 'tasks');
    const lt = fake.argsOf(c, 'lt')[0];
    expect(lt[0]).toBe('due_date');
    expect(lt[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fake.argsOf(c, 'in')).toContainEqual(['status', ['todo', 'in_progress']]);
  });

  it('search escapes LIKE wildcards and PostgREST reserved characters', async () => {
    await tasks.listTasks({ search: ' 100%_done, (a.b) "q" ' });
    const or = fake.argsOf(fake.last('from', 'tasks'), 'or')[0][0];
    expect(or).toBe('title.ilike."%100\\\\%\\\\_done, (a.b) \\"q\\"%",description.ilike."%100\\\\%\\\\_done, (a.b) \\"q\\"%"');
  });

  it('blank search adds no filter', async () => {
    await tasks.listTasks({ search: '   ' });
    expect(fake.argsOf(fake.last('from', 'tasks'), 'or')).toEqual([]);
  });

  it('normalises numeric strings', async () => {
    fake.respond('tasks', { data: [{ id: '1', estimated_minutes: '30', actual_minutes: '12' }] });
    const [t] = await tasks.listTasks();
    expect(t.estimated_minutes).toBe(30);
    expect(t.actual_minutes).toBe(12);
  });

  it('invalid dueFrom → invalid_input with field', async () => {
    await expect(tasks.listTasks({ dueFrom: '10/10/2026' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'dueFrom' } });
  });
});

describe('tasks writes', () => {
  it('createTask strips server-owned columns and normalises input', async () => {
    fake.respond('tasks', { data: { id: 't1' } });
    await tasks.createTask({
      title: '  Viết báo cáo  ', description: '', tags: [' a ', 'A', '#b', '', 'b'], estimated_minutes: '45', due_date: '',
      category_id: '', user_id: 'evil', actual_minutes: 999, completed_at: 'now', id: 'x', created_at: 'y', junk: 1,
    });
    const c = fake.last('from', 'tasks');
    const row = fake.argsOf(c, 'insert')[0][0];
    for (const f of FORBIDDEN) expect(row).not.toHaveProperty(f);
    expect(row).not.toHaveProperty('junk');
    expect(row).toEqual({ title: 'Viết báo cáo', description: null, tags: ['a', 'b'], estimated_minutes: 45, due_date: null, category_id: null });
    expect(fake.methods(c)).toEqual(['insert', 'select', 'single']);
  });

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(201) }, 'title'],
    [{ title: 'ok', description: 'x'.repeat(5001) }, 'description'],
    [{ title: 'ok', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'tags'],
    [{ title: 'ok', estimated_minutes: -1 }, 'estimated_minutes'],
    [{ title: 'ok', estimated_minutes: 1.5 }, 'estimated_minutes'],
    [{ title: 'ok', status: 'done' }, 'status'],
    [{ title: 'ok', priority: 'p1' }, 'priority'],
    [{ title: 'ok', due_date: '2026-13-01' }, 'due_date'],
    [{ title: 'ok', recurrence: 'hourly' }, 'recurrence'],
  ])('createTask(%o) → invalid_input on %s', async (input, field) => {
    await expect(tasks.createTask(input)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
    expect(fake.calls).toHaveLength(0);
  });

  it('recurrence is only sent when provided', async () => {
    await tasks.createTask({ title: 'a' });
    expect(fake.argsOf(fake.last('from', 'tasks'), 'insert')[0][0]).not.toHaveProperty('recurrence');
    await tasks.createTask({ title: 'a', recurrence: 'weekly' });
    expect(fake.argsOf(fake.last('from', 'tasks'), 'insert')[0][0].recurrence).toBe('weekly');
  });

  it('updateTask is partial, keyed by id, rejects empty patch', async () => {
    await tasks.updateTask('t1', { priority: 'high', actual_minutes: 5 });
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'update')[0][0]).toEqual({ priority: 'high' });
    expect(fake.argsOf(c, 'eq')).toContainEqual(['id', 't1']);
    await expect(tasks.updateTask('t1', { completed_at: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(tasks.updateTask('', { title: 'x' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'id' } });
  });

  it('setTaskStatus sends only status', async () => {
    await tasks.setTaskStatus('t1', 'completed');
    expect(fake.argsOf(fake.last('from', 'tasks'), 'update')[0][0]).toEqual({ status: 'completed' });
    await expect(tasks.setTaskStatus('t1', 'nope')).rejects.toMatchObject({ details: { field: 'status' } });
  });

  it('deleteTask / getTask', async () => {
    expect(await tasks.deleteTask('t1')).toBe(true);
    expect(fake.methods(fake.last('from', 'tasks'))).toEqual(['delete', 'eq']);
    fake.respond('tasks', { data: null });
    expect(await tasks.getTask('t2')).toBeNull();
    expect(fake.methods(fake.last('from', 'tasks'))).toContain('maybeSingle');
  });

  it('maps DB errors (FK to foreign category)', async () => {
    fake.respond('tasks', { error: { code: '23503', message: 'insert or update on table "tasks" violates foreign key constraint' } });
    await expect(tasks.createTask({ title: 'a', category_id: 'c-other' })).rejects.toMatchObject({ code: 'invalid_reference' });
  });

  it('listCompletedBetween (compat) filters completed_at', async () => {
    await tasks.listCompletedBetween('2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z');
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'gte')).toEqual([['completed_at', '2026-10-01T00:00:00Z']]);
    expect(fake.argsOf(c, 'lt')).toEqual([['completed_at', '2026-10-08T00:00:00Z']]);
  });

  it('not_configured when the client is missing', async () => {
    h.client = null;
    await expect(tasks.listTasks()).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('tasks RPCs', () => {
  it('focusTasks → focus_tasks(p_limit) with numeric score', async () => {
    fake.respond('rpc:focus_tasks', { data: [{ task_id: 't', score: '58.0', reasons: null }] });
    const r = await tasks.focusTasks(3);
    expect(fake.last('rpc', 'focus_tasks').args).toEqual([{ p_limit: 3 }]);
    expect(r).toEqual([{ task_id: 't', score: 58, reasons: [] }]);
  });
  it('estimateSuggestion → estimate_suggestion(p_category_id)', async () => {
    fake.respond('rpc:estimate_suggestion', { data: { samples: 4, accuracy_ratio: '1.25', median_actual_minutes: 40, suggested_multiplier: '1.25' } });
    const r = await tasks.estimateSuggestion('cat1');
    expect(fake.last('rpc', 'estimate_suggestion').args).toEqual([{ p_category_id: 'cat1' }]);
    expect(r.suggested_multiplier).toBe(1.25);
    await tasks.estimateSuggestion();
    expect(fake.last('rpc', 'estimate_suggestion').args).toEqual([{ p_category_id: null }]);
  });
  it('focus_tasks missing on server → feature_unavailable', async () => {
    fake.respond('rpc:focus_tasks', { error: { code: 'PGRST202', message: 'Could not find the function public.focus_tasks' } });
    await expect(tasks.focusTasks()).rejects.toMatchObject({ code: 'feature_unavailable' });
  });
});

describe('timer', () => {
  it('start → start_timer(p_task_id, p_description)', async () => {
    fake.respond('rpc:start_timer', { data: { id: 'e1', duration_seconds: null } });
    const e = await timer.start('t1', '  focus ');
    expect(fake.last('rpc', 'start_timer').args).toEqual([{ p_task_id: 't1', p_description: 'focus' }]);
    expect(e.id).toBe('e1');
    await timer.start();
    expect(fake.last('rpc', 'start_timer').args).toEqual([{ p_task_id: null, p_description: null }]);
  });
  it('start maps business errors', async () => {
    fake.respond('rpc:start_timer', { error: { code: 'P0001', message: 'task_closed' } });
    await expect(timer.start('t1')).rejects.toMatchObject({ code: 'task_closed' });
  });
  it('stop → stop_timer(); null composite → null', async () => {
    fake.respond('rpc:stop_timer', { data: { id: 'e1', duration_seconds: '61' } }, { data: { id: null, task_id: null } });
    expect((await timer.stop()).duration_seconds).toBe(61);
    expect(fake.last('rpc', 'stop_timer').args).toEqual([]);
    expect(await timer.stop()).toBeNull();
  });
  it('current → timer_current, with fallback to the table when missing', async () => {
    fake.respond('rpc:timer_current', { data: { entry: { id: 'e', duration_seconds: null }, task_title: 'T', elapsed_seconds: '10', task_total_seconds: '70' } });
    expect(await timer.current()).toMatchObject({ elapsed_seconds: 10, task_total_seconds: 70, task_title: 'T' });

    fake.respond('rpc:timer_current', { error: { code: 'PGRST202', message: 'nf' } });
    fake.respond('time_entries', { data: { id: 'e2', started_at: new Date(Date.now() - 5000).toISOString(), task: { title: 'X' } } });
    const cur = await timer.current();
    expect(cur.entry.id).toBe('e2');
    expect(cur.task_title).toBe('X');
    expect(cur.elapsed_seconds).toBeGreaterThanOrEqual(4);
    expect(fake.argsOf(fake.last('from', 'time_entries'), 'is')).toEqual([['ended_at', null]]);
  });
  it('logTime → log_time with exact p_* args and ISO instants', async () => {
    const s = new Date(Date.now() - 3600_000);
    const e = new Date(Date.now() - 1800_000);
    await timer.logTime({ taskId: 't1', startedAt: s, endedAt: e.toISOString(), description: '' });
    expect(fake.last('rpc', 'log_time').args).toEqual([{ p_task_id: 't1', p_started_at: s.toISOString(), p_ended_at: e.toISOString(), p_description: null }]);
  });
  it.each([
    [{ startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T09:00:00Z' }, 'endedAt'],
    [{ startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-02T01:00:00Z' }, 'endedAt'],
    [{ startedAt: 'garbage', endedAt: '2026-10-01T09:00:00Z' }, 'startedAt'],
    [{ endedAt: '2026-10-01T09:00:00Z' }, 'startedAt'],
  ])('logTime validation %o → %s', async (input, field) => {
    await expect(timer.logTime(input)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
  });
  it('logTime rejects future end', async () => {
    const s = new Date(Date.now() + 3600_000).toISOString();
    const e = new Date(Date.now() + 7200_000).toISOString();
    await expect(timer.logTime({ startedAt: s, endedAt: e })).rejects.toMatchObject({ details: { field: 'endedAt' } });
  });
  it('logTime falls back to a manual insert without 000300', async () => {
    fake.respond('rpc:log_time', { error: { code: '42883', message: 'function public.log_time does not exist' } });
    fake.respond('time_entries', { data: { id: 'm1' } });
    const s = new Date(Date.now() - 3600_000).toISOString();
    const e = new Date(Date.now() - 600_000).toISOString();
    expect((await timer.logTime({ startedAt: s, endedAt: e })).id).toBe('m1');
    const row = fake.argsOf(fake.last('from', 'time_entries'), 'insert')[0][0];
    expect(row).toEqual({ task_id: null, description: null, started_at: s, ended_at: e, source: 'manual' });
  });
  it('logTime overlap → time_overlap', async () => {
    fake.respond('rpc:log_time', { error: { code: 'P0001', message: 'time_overlap' } });
    const s = new Date(Date.now() - 3600_000).toISOString();
    await expect(timer.logTime({ startedAt: s, endedAt: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ code: 'time_overlap' });
  });
  it('listEntries converts days to timezone instants', async () => {
    await timer.listEntries({ from: '2026-10-01', to: '2026-10-01', taskId: 't1' });
    const c = fake.last('from', 'time_entries');
    expect(fake.argsOf(c, 'gte')).toEqual([['started_at', '2026-09-30T17:00:00.000Z']]); // Asia/Ho_Chi_Minh
    expect(fake.argsOf(c, 'lt')).toEqual([['started_at', '2026-10-01T17:00:00.000Z']]);
    expect(fake.argsOf(c, 'eq')).toEqual([['task_id', 't1']]);
  });
  it('updateEntry whitelists and never sends duration_seconds', async () => {
    await timer.updateEntry('e1', { description: 'x', duration_seconds: 9, user_id: 'u', source: 'timer' });
    expect(fake.argsOf(fake.last('from', 'time_entries'), 'update')[0][0]).toEqual({ description: 'x' });
    await expect(timer.updateEntry('e1', { started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-01T09:00:00Z' }))
      .rejects.toMatchObject({ details: { field: 'ended_at' } });
  });
});

describe('timeEntries compat facade', () => {
  it('startEntry/stopEntry delegate to the RPCs', async () => {
    fake.respond('rpc:start_timer', { data: { id: 'e1' } });
    expect((await timeEntries.startEntry({ task_id: 't1', description: 'd' })).id).toBe('e1');
    expect(fake.last('rpc', 'start_timer').args).toEqual([{ p_task_id: 't1', p_description: 'd' }]);
    fake.respond('rpc:stop_timer', { data: { id: 'e1', duration_seconds: 30 } });
    expect((await timeEntries.stopEntry({ id: 'e1' })).duration_seconds).toBe(30);
  });
  it('getRunningEntry / listEntries(fromIso, toIso, {taskId})', async () => {
    fake.respond('time_entries', { data: { id: 'r' } });
    expect((await timeEntries.getRunningEntry()).id).toBe('r');
    await timeEntries.listEntries('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', { taskId: 't' });
    const c = fake.last('from', 'time_entries');
    expect(fake.argsOf(c, 'gte')).toEqual([['started_at', '2026-10-01T00:00:00.000Z']]);
    expect(fake.argsOf(c, 'eq')).toEqual([['task_id', 't']]);
  });
  it('createManualEntry → log_time', async () => {
    const s = new Date(Date.now() - 7200_000).toISOString();
    const e = new Date(Date.now() - 3600_000).toISOString();
    await timeEntries.createManualEntry({ task_id: 't', started_at: s, ended_at: e });
    expect(fake.last('rpc', 'log_time').args[0]).toMatchObject({ p_task_id: 't', p_started_at: s, p_ended_at: e });
  });
  it('entrySeconds counts a running entry up to now', () => {
    expect(timeEntries.entrySeconds({ duration_seconds: '90' })).toBe(90);
    expect(timeEntries.entrySeconds({ started_at: new Date(1000).toISOString() }, 11_000)).toBe(10);
  });
});
