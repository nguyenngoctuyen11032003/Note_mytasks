// §1 Tasks & Time (migration 20261009000300_tasks_time.sql) against real Postgres (PGlite).
// Time is controlled by backdating rows as superuser (db.query bypasses RLS) relative to
// the user's today, never by hard-coding "today".
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon, q, categoryId } from './harness.js';

let db, a, b;

const one = async (user, sql, params) => (await q(db, user, sql, params))[0];
const today = async (user = a) => (await one(user, 'select public.user_today()::text as d')).d;
const addDays = async (user, n) =>
  (await one(user, 'select (public.user_today() + $1::int)::text as d', [n])).d;

/** Expect a business error `code` (P0001). */
async function expectCode(promise, code, sqlstate = 'P0001') {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err, `expected error ${code}`).toBeTruthy();
  expect(err.message).toBe(code);
  expect(err.code).toBe(sqlstate);
}

async function newTask(user, fields = {}) {
  const cols = Object.keys(fields);
  const sql = cols.length
    ? `insert into public.tasks (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`
    : `insert into public.tasks (title) values ('t') returning *`;
  return one(user, sql, Object.values(fields));
}

const task = (id) => db.query('select * from public.tasks where id = $1', [id]).then((r) => r.rows[0]);
const running = (user) =>
  db.query('select * from public.time_entries where user_id = $1 and ended_at is null', [user]).then((r) => r.rows);
const entries = (user) =>
  db.query('select * from public.time_entries where user_id = $1 order by started_at', [user]).then((r) => r.rows);
/** Make the user's running segment look like it started `secs` seconds ago. */
const backdateRunning = (user, secs) =>
  db.query(
    `update public.time_entries set started_at = now() - make_interval(secs => $2) where user_id = $1 and ended_at is null`,
    [user, secs],
  );
const clearTime = (user) => db.query('delete from public.time_entries where user_id = $1', [user]);
const clearTasks = (user) => db.query('delete from public.tasks where user_id = $1', [user]);

beforeAll(async () => {
  db = await createDb();
  a = await createUser(db, { displayName: 'An' });
  b = await createUser(db, { displayName: 'Bình' });
});

// ---------------------------------------------------------------------------
describe('schema: recurrence columns', () => {
  it('accepts the 4 rules and rejects others', async () => {
    for (const r of ['daily', 'weekdays', 'weekly', 'monthly']) {
      expect((await newTask(a, { title: r, recurrence: r })).recurrence).toBe(r);
    }
    await expect(newTask(a, { title: 'x', recurrence: 'yearly' })).rejects.toThrow(/check constraint/);
  });

  it('recurrence_parent_id composite FK blocks another user\'s task', async () => {
    const bt = await newTask(b, { title: 'B root' });
    await expect(newTask(a, { title: 'x', recurrence_parent_id: bt.id })).rejects.toThrow(/foreign key/);
  });

  it('deleting the root sets children recurrence_parent_id to null (task kept)', async () => {
    const root = await newTask(a, { title: 'root', recurrence: 'daily' });
    const child = await newTask(a, { title: 'child', recurrence: 'daily', recurrence_parent_id: root.id });
    await q(db, a, 'delete from public.tasks where id = $1', [root.id]);
    const c = await task(child.id);
    expect(c).toBeTruthy();
    expect(c.recurrence_parent_id).toBeNull();
    expect(c.user_id).toBe(a);
  });
});

// ---------------------------------------------------------------------------
describe('recurrence_next_date (pure)', () => {
  const next = async (rule, from, todayD = null, anchor = null) =>
    (await one(a, 'select public.recurrence_next_date($1, $2::date, $3::date, $4)::text as d', [rule, from, todayD, anchor])).d;

  it('daily / weekly', async () => {
    expect(await next('daily', '2030-01-31')).toBe('2030-02-01');
    expect(await next('weekly', '2030-01-31')).toBe('2030-02-07');
  });

  it('weekdays skips Sat/Sun', async () => {
    expect(await next('weekdays', '2030-01-03')).toBe('2030-01-04'); // Thu -> Fri
    expect(await next('weekdays', '2030-01-04')).toBe('2030-01-07'); // Fri -> Mon
    expect(await next('weekdays', '2030-01-05')).toBe('2030-01-07'); // Sat -> Mon
  });

  it('monthly clamps to month end and keeps the anchor (no drift to the 28th)', async () => {
    expect(await next('monthly', '2031-01-31')).toBe('2031-02-28');
    expect(await next('monthly', '2032-01-31')).toBe('2032-02-29'); // leap year
    expect(await next('monthly', '2031-02-28', null, 31)).toBe('2031-03-31');
    expect(await next('monthly', '2031-03-31', null, 31)).toBe('2031-04-30');
    expect(await next('monthly', '2031-12-15')).toBe('2032-01-15');
  });

  it('rolls forward until >= today, keeping the rhythm', async () => {
    expect(await next('daily', '2020-01-01', '2030-06-15')).toBe('2030-06-15');
    expect(await next('daily', '2030-06-14', '2030-06-15')).toBe('2030-06-15');
    expect(await next('daily', '2030-06-15', '2030-06-15')).toBe('2030-06-16'); // strictly after
    // 2030-06-03 is Monday; today Sat 2030-06-15 -> Mon 2030-06-17
    expect(await next('weekly', '2030-06-03', '2030-06-15')).toBe('2030-06-17');
    expect(await next('weekly', '2020-06-01', '2030-06-15')).toBe('2030-06-17'); // far past, still Monday
    expect(await next('weekdays', '2030-06-03', '2030-06-15')).toBe('2030-06-17'); // Sat today -> Mon
    expect(await next('monthly', '2030-01-31', '2030-06-15', 31)).toBe('2030-06-30');
    expect(await next('monthly', '2030-01-10', '2030-06-15')).toBe('2030-07-10');
  });

  it('null input -> null; unknown rule -> invalid_input', async () => {
    expect(await next('daily', null)).toBeNull();
    expect(await next(null, '2030-01-01')).toBeNull();
    await expectCode(next('yearly', '2030-01-01'), 'invalid_input');
  });
});

// ---------------------------------------------------------------------------
describe('recurring tasks: spawn on completion', () => {
  const series = (root) =>
    db
      .query(
        `select id, title, status, due_date::text as due, recurrence, recurrence_parent_id, priority, tags,
                estimated_minutes, description, category_id
           from public.tasks where id = $1 or recurrence_parent_id = $1 order by due_date nulls first, created_at`,
        [root],
      )
      .then((r) => r.rows);
  const complete = (user, id) => q(db, user, `update public.tasks set status = 'completed' where id = $1`, [id]);

  it('daily: spawns a copy due the next day with all fields copied', async () => {
    const cat = await categoryId(db, a, 'task', 'Công việc');
    const due = await addDays(a, 2);
    const t = await newTask(a, {
      title: 'Uống thuốc', description: 'sáng', priority: 'high', category_id: cat,
      tags: ['health'], estimated_minutes: 5, recurrence: 'daily', due_date: due,
    });
    await complete(a, t.id);
    const rows = await series(t.id);
    expect(rows).toHaveLength(2);
    const n = rows[1];
    expect(n).toMatchObject({
      title: 'Uống thuốc', description: 'sáng', status: 'todo', priority: 'high', category_id: cat,
      tags: ['health'], estimated_minutes: 5, recurrence: 'daily', recurrence_parent_id: t.id,
      due: await addDays(a, 3),
    });
    // activity feed logs the spawned task
    const logs = await q(db, a, `select action from public.activity_logs where entity_id = $1`, [n.id]);
    expect(logs.map((l) => l.action)).toEqual(['created']);
  });

  it('chain keeps pointing at the root; completing the spawned task continues the series', async () => {
    const t = await newTask(a, { title: 'chain', recurrence: 'weekly', due_date: await addDays(a, 1) });
    await complete(a, t.id);
    let rows = await series(t.id);
    await complete(a, rows[1].id);
    rows = await series(t.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.due)).toEqual([await addDays(a, 1), await addDays(a, 8), await addDays(a, 15)]);
    expect(rows[2].recurrence_parent_id).toBe(t.id);
  });

  it('reopen -> re-complete does not duplicate (also after the copy itself was completed)', async () => {
    const t = await newTask(a, { title: 'reopen', recurrence: 'daily', due_date: await addDays(a, 1) });
    await complete(a, t.id);
    await q(db, a, `update public.tasks set status = 'todo' where id = $1`, [t.id]);
    await complete(a, t.id);
    expect(await series(t.id)).toHaveLength(2);
    // complete the copy (spawns 3rd), then reopen/recomplete the original again
    const copy = (await series(t.id))[1];
    await complete(a, copy.id);
    await q(db, a, `update public.tasks set status = 'in_progress' where id = $1`, [t.id]);
    await complete(a, t.id);
    expect(await series(t.id)).toHaveLength(3);
  });

  it('updating a completed task (other columns) does not spawn again', async () => {
    const t = await newTask(a, { title: 'edit', recurrence: 'daily', due_date: await addDays(a, 1) });
    await complete(a, t.id);
    await q(db, a, `update public.tasks set status = 'completed', title = 'edit2' where id = $1`, [t.id]);
    expect(await series(t.id)).toHaveLength(2);
  });

  it('no recurrence -> nothing spawned; cancelled recurring -> nothing spawned', async () => {
    const t = await newTask(a, { title: 'plain', due_date: await addDays(a, 1) });
    await complete(a, t.id);
    expect(await series(t.id)).toHaveLength(1);
    const c = await newTask(a, { title: 'cancel', recurrence: 'daily', due_date: await addDays(a, 1) });
    await q(db, a, `update public.tasks set status = 'cancelled' where id = $1`, [c.id]);
    expect(await series(c.id)).toHaveLength(1);
  });

  it('inserting an already-completed recurring task spawns the next one', async () => {
    const t = await newTask(a, { title: 'ins', recurrence: 'daily', status: 'completed', due_date: await addDays(a, 4) });
    const rows = await series(t.id);
    expect(rows.map((r) => r.due)).toEqual([await addDays(a, 4), await addDays(a, 5)]);
  });

  it('no due date -> next is computed from today', async () => {
    const t = await newTask(a, { title: 'nodue', recurrence: 'daily' });
    await complete(a, t.id);
    const rows = await series(t.id);
    expect(rows[1].due).toBe(await addDays(a, 1));
  });

  it('overdue daily completed late -> due today (not a past date)', async () => {
    const t = await newTask(a, { title: 'late', recurrence: 'daily', due_date: await addDays(a, -10) });
    await complete(a, t.id);
    expect((await series(t.id))[1].due).toBe(await today());
  });

  it('overdue weekly -> rolls forward by whole weeks to >= today', async () => {
    const t = await newTask(a, { title: 'lateweek', recurrence: 'weekly', due_date: await addDays(a, -10) });
    await complete(a, t.id);
    expect((await series(t.id))[1].due).toBe(await addDays(a, 4)); // -10 +7 = -3 (past) +7 = +4
  });

  it('weekdays: Friday -> Monday', async () => {
    const t = await newTask(a, { title: 'wd', recurrence: 'weekdays', due_date: '2030-01-04' });
    await complete(a, t.id);
    expect((await series(t.id))[1].due).toBe('2030-01-07');
  });

  it('monthly on the 31st: clamps to Feb end, then returns to the 31st', async () => {
    const t = await newTask(a, { title: 'rent', recurrence: 'monthly', due_date: '2031-01-31' });
    await complete(a, t.id);
    let rows = await series(t.id);
    expect(rows[1].due).toBe('2031-02-28');
    await complete(a, rows[1].id);
    rows = await series(t.id);
    expect(rows[2].due).toBe('2031-03-31');
    await complete(a, rows[2].id);
    expect((await series(t.id))[3].due).toBe('2031-04-30');
  });

  it('monthly: a task moved by the user to another day anchors on its own day', async () => {
    const t = await newTask(a, { title: 'moved', recurrence: 'monthly', due_date: '2031-01-31' });
    await complete(a, t.id);
    const copy = (await series(t.id))[1];
    await q(db, a, `update public.tasks set due_date = '2031-02-15' where id = $1`, [copy.id]);
    await complete(a, copy.id);
    expect((await series(t.id))[2].due).toBe('2031-03-15');
  });

  it('completion by another user is impossible (RLS) and spawns nothing', async () => {
    const t = await newTask(a, { title: 'mine', recurrence: 'daily', due_date: await addDays(a, 1) });
    await complete(b, t.id);
    expect((await task(t.id)).status).toBe('todo');
    expect(await series(t.id)).toHaveLength(1);
  });

  it('trigger function is not executable via RPC', async () => {
    await expect(q(db, a, 'select public.tasks_spawn_next_recurrence()')).rejects.toThrow(/permission denied|trigger functions/);
  });
});

// ---------------------------------------------------------------------------
describe('start_timer / stop_timer (contract timer_start / timer_stop)', () => {
  it('starts a timer without a task; description trimmed', async () => {
    await clearTime(a);
    const e = await one(a, `select * from public.start_timer(null, '  focus  ')`);
    expect(e).toMatchObject({ user_id: a, task_id: null, description: 'focus', source: 'timer', ended_at: null });
    expect(await running(a)).toHaveLength(1);
  });

  it('moves a todo task to in_progress; in_progress stays', async () => {
    await clearTime(a);
    const t = await newTask(a, { title: 'timed' });
    const e = await one(a, 'select * from public.start_timer($1)', [t.id]);
    expect(e.task_id).toBe(t.id);
    expect((await task(t.id)).status).toBe('in_progress');
    await backdateRunning(a, 5);
    await one(a, 'select * from public.start_timer($1)', [t.id]);
    expect((await task(t.id)).status).toBe('in_progress');
  });

  it('starting while running auto-stops the previous segment (one running row)', async () => {
    await clearTime(a);
    const t1 = await newTask(a, { title: 't1' });
    const t2 = await newTask(a, { title: 't2' });
    const e1 = await one(a, 'select * from public.start_timer($1)', [t1.id]);
    await backdateRunning(a, 600); // 10 min
    const e2 = await one(a, 'select * from public.start_timer($1)', [t2.id]);
    const all = await entries(a);
    expect(all).toHaveLength(2);
    const closed = all.find((x) => x.id === e1.id);
    expect(closed.ended_at).toBeTruthy();
    expect(closed.duration_seconds).toBeGreaterThanOrEqual(599);
    expect(all.find((x) => x.id === e2.id).ended_at).toBeNull();
    expect(await running(a)).toHaveLength(1);
    expect((await task(t1.id)).actual_minutes).toBe(10);
  });

  it('a previous segment shorter than 1 s is discarded, not stored', async () => {
    await clearTime(a);
    // both starts in ONE transaction -> identical now(): would violate ended_at > started_at
    await asUser(db, a, async (tx) => {
      await tx.query('select public.start_timer()');
      await tx.query('select public.start_timer()');
    });
    expect(await entries(a)).toHaveLength(1);
  });

  it('errors: not_found (missing / other user\'s task), task_closed (completed / cancelled)', async () => {
    await expectCode(q(db, a, 'select public.start_timer($1)', ['00000000-0000-0000-0000-000000000001']), 'not_found', 'P0002');
    const bt = await newTask(b, { title: 'B task' });
    await expectCode(q(db, a, 'select public.start_timer($1)', [bt.id]), 'not_found', 'P0002');
    const done = await newTask(a, { title: 'done', status: 'completed' });
    await expectCode(q(db, a, 'select public.start_timer($1)', [done.id]), 'task_closed', '22023');
    const canc = await newTask(a, { title: 'canc', status: 'cancelled' });
    await expectCode(q(db, a, 'select public.start_timer($1)', [canc.id]), 'task_closed', '22023');
    expect((await task(bt.id)).status).toBe('todo');
  });

  it('a failed start leaves the running timer untouched (atomic)', async () => {
    await clearTime(a);
    await one(a, 'select * from public.start_timer()');
    await backdateRunning(a, 120);
    const done = await newTask(a, { title: 'done2', status: 'completed' });
    await expectCode(q(db, a, 'select public.start_timer($1)', [done.id]), 'task_closed', '22023');
    const r = await running(a);
    expect(r).toHaveLength(1);
  });

  it('description longer than 500 chars -> invalid_input', async () => {
    await expectCode(q(db, a, 'select public.start_timer(null, $1)', ['x'.repeat(501)]), 'invalid_input');
  });

  it('timers are per user: B starting does not stop A', async () => {
    await clearTime(a);
    await clearTime(b);
    await one(a, 'select * from public.start_timer()');
    await one(b, 'select * from public.start_timer()');
    expect(await running(a)).toHaveLength(1);
    expect(await running(b)).toHaveLength(1);
    await backdateRunning(b, 30);
    await one(b, 'select * from public.stop_timer()');
    expect(await running(a)).toHaveLength(1);
    expect(await running(b)).toHaveLength(0);
  });

  it('stop_timer closes the running segment and updates actual_minutes', async () => {
    await clearTime(a);
    const t = await newTask(a, { title: 'stop me' });
    await one(a, 'select * from public.start_timer($1)', [t.id]);
    await backdateRunning(a, 1800);
    const e = await one(a, 'select * from public.stop_timer()');
    expect(e.ended_at).toBeTruthy();
    expect(e.duration_seconds).toBeGreaterThanOrEqual(1800);
    expect(await running(a)).toHaveLength(0);
    expect((await task(t.id)).actual_minutes).toBe(30);
  });

  it('stop_timer with nothing running returns null', async () => {
    await clearTime(a);
    const r = await one(a, 'select (public.stop_timer()).id as id');
    expect(r.id).toBeNull();
  });

  it('stop_timer on a sub-second segment deletes it and returns null', async () => {
    await clearTime(a);
    await one(a, 'select * from public.start_timer()');
    await db.query(`update public.time_entries set started_at = now() - interval '300 milliseconds' where user_id = $1`, [a]);
    const r = await one(a, 'select (public.stop_timer()).id as id');
    expect(r.id).toBeNull();
    expect(await entries(a)).toHaveLength(0);
  });

  it('keeps sub-second precision for segments >= 1 s', async () => {
    await clearTime(a);
    await one(a, 'select * from public.start_timer()');
    await db.query(`update public.time_entries set started_at = now() - interval '1500 milliseconds' where user_id = $1`, [a]);
    const e = await one(a, 'select * from public.stop_timer()');
    expect(e.ended_at).toBeTruthy();
    expect(await entries(a)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('timer_current', () => {
  it('null when no timer', async () => {
    await clearTime(a);
    expect((await one(a, 'select public.timer_current() as c')).c).toBeNull();
  });

  it('returns entry, task title, elapsed and task total (incl. finished segments)', async () => {
    await clearTime(a);
    const t = await newTask(a, { title: 'Viết báo cáo' });
    await q(db, a, `select public.log_time($1, now() - interval '3 hours', now() - interval '2 hours')`, [t.id]); // 3600 s
    await one(a, 'select * from public.start_timer($1)', [t.id]);
    await backdateRunning(a, 90);
    const { c } = await one(a, 'select public.timer_current() as c');
    expect(c.task_title).toBe('Viết báo cáo');
    expect(c.entry.task_id).toBe(t.id);
    expect(c.entry.ended_at).toBeNull();
    expect(c.elapsed_seconds).toBeGreaterThanOrEqual(90);
    expect(c.elapsed_seconds).toBeLessThan(100);
    expect(c.task_total_seconds).toBe(3600 + c.elapsed_seconds);
  });

  it('timer without task: task_title and task_total_seconds null', async () => {
    await clearTime(a);
    await one(a, 'select * from public.start_timer()');
    const { c } = await one(a, 'select public.timer_current() as c');
    expect(c.task_title).toBeNull();
    expect(c.task_total_seconds).toBeNull();
    expect(c.elapsed_seconds).toBeGreaterThanOrEqual(0);
  });

  it('B never sees A\'s running timer', async () => {
    await clearTime(b);
    expect((await one(b, 'select public.timer_current() as c')).c).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('log_time', () => {
  const log = (user, taskId, from, to, desc = null) =>
    one(user, `select * from public.log_time($1, now() - $2::interval, now() - $3::interval, $4)`, [taskId, from, to, desc]);

  it('inserts a manual segment and updates actual_minutes', async () => {
    await clearTime(a);
    const t = await newTask(a, { title: 'manual' });
    const e = await log(a, t.id, '5 hours', '4 hours', ' meeting ');
    expect(e).toMatchObject({ source: 'manual', task_id: t.id, description: 'meeting', duration_seconds: 3600 });
    expect((await task(t.id)).actual_minutes).toBe(60);
  });

  it('allows a segment without task and on a completed task', async () => {
    await clearTime(a);
    expect((await log(a, null, '3 hours', '2 hours')).task_id).toBeNull();
    const done = await newTask(a, { title: 'done', status: 'completed' });
    expect((await log(a, done.id, '2 hours', '1 hour')).task_id).toBe(done.id);
  });

  it('time_overlap: intersecting finished segment; back-to-back is fine', async () => {
    await clearTime(a);
    await log(a, null, '10 hours', '9 hours');
    await expectCode(log(a, null, '9 hours 30 minutes', '8 hours'), 'time_overlap');
    await expectCode(log(a, null, '11 hours', '8 hours'), 'time_overlap'); // contains
    await expectCode(log(a, null, '9 hours 50 minutes', '9 hours 10 minutes'), 'time_overlap'); // inside
    // adjacent on both sides: same instants -> needs same now(); do it in one transaction
    await asUser(db, a, async (tx) => {
      await tx.query(`select public.log_time(null, now() - interval '9 hours', now() - interval '8 hours')`);
      await tx.query(`select public.log_time(null, now() - interval '11 hours', now() - interval '10 hours')`);
    });
    expect(await entries(a)).toHaveLength(3);
  });

  it('time_overlap: a running timer counts as open-ended', async () => {
    await clearTime(a);
    await one(a, 'select * from public.start_timer()');
    await backdateRunning(a, 3600);
    await expectCode(log(a, null, '30 minutes', '10 minutes'), 'time_overlap');
    // before the running segment is fine
    await log(a, null, '3 hours', '2 hours');
  });

  it('overlap check is per user (B\'s segments do not block A)', async () => {
    await clearTime(a);
    await clearTime(b);
    await log(b, null, '6 hours', '5 hours');
    await log(a, null, '6 hours', '5 hours');
  });

  it('invalid_input: future, > 24 h, end <= start, null bounds, long description', async () => {
    await expectCode(q(db, a, `select public.log_time(null, now() - interval '1 hour', now() + interval '1 hour')`), 'invalid_input');
    await expectCode(q(db, a, `select public.log_time(null, now() + interval '1 hour', now() + interval '2 hours')`), 'invalid_input');
    await expectCode(q(db, a, `select public.log_time(null, now() - interval '30 hours', now() - interval '5 hours')`), 'invalid_input');
    await expectCode(q(db, a, `select public.log_time(null, now() - interval '1 hour', now() - interval '2 hours')`), 'invalid_input');
    await expectCode(q(db, a, `select public.log_time(null, now() - interval '1 hour', now() - interval '1 hour')`), 'invalid_input');
    await expectCode(q(db, a, `select public.log_time(null, null, now())`), 'invalid_input');
    await expectCode(
      q(db, a, `select public.log_time(null, now() - interval '50 hours', now() - interval '49 hours', $1)`, ['x'.repeat(501)]),
      'invalid_input',
    );
  });

  it('exactly 24 h is accepted', async () => {
    await clearTime(a);
    const e = await log(a, null, '30 hours', '6 hours');
    expect(e.duration_seconds).toBe(86400);
  });

  it('not_found for a missing task or another user\'s task', async () => {
    const bt = await newTask(b, { title: 'B' });
    await expectCode(log(a, bt.id, '100 hours', '99 hours'), 'not_found');
    await expectCode(log(a, '00000000-0000-0000-0000-000000000002', '100 hours', '99 hours'), 'not_found');
  });
});

// ---------------------------------------------------------------------------
describe('focus_tasks', () => {
  const focus = (user, limit) =>
    limit === undefined
      ? q(db, user, 'select * from public.focus_tasks()')
      : q(db, user, 'select * from public.focus_tasks($1)', [limit]);

  it('scores, reasons and ordering follow the contract formula', async () => {
    await clearTasks(a);
    const mk = async (title, fields) => newTask(a, { title, ...fields });
    const t = {
      overdue5: await mk('overdue5', { priority: 'medium', due_date: await addDays(a, -5) }), // 16+40
      overdue20: await mk('overdue20', { priority: 'low', due_date: await addDays(a, -20) }), // 6+50
      todayUrg: await mk('todayUrg', { priority: 'urgent', due_date: await addDays(a, 0) }), // 40+30
      tomorrowHigh: await mk('tomorrowHigh', { priority: 'high', due_date: await addDays(a, 1), status: 'in_progress' }), // 28+22+10
      in3: await mk('in3', { priority: 'medium', due_date: await addDays(a, 3), estimated_minutes: 30 }), // 16+15+5
      in7: await mk('in7', { priority: 'medium', due_date: await addDays(a, 7) }), // 16+8
      in8: await mk('in8', { priority: 'medium', due_date: await addDays(a, 8) }), // 16
      nodue: await mk('nodue', { priority: 'low' }), // 6
      stale: await mk('stale', { priority: 'low', estimated_minutes: 0 }), // 6+5 (stale), no quick win at 0
      done: await mk('done', { priority: 'urgent', status: 'completed', due_date: await addDays(a, -1) }),
      cancelled: await mk('cancelled', { priority: 'urgent', status: 'cancelled' }),
    };
    await db.query(`update public.tasks set created_at = now() - interval '20 days' where id = $1`, [t.stale.id]);
    const rows = await focus(a, 50);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle.done).toBeUndefined();
    expect(byTitle.cancelled).toBeUndefined();
    const score = (k) => Number(byTitle[k].score);
    expect(score('overdue5')).toBe(56);
    expect(score('overdue20')).toBe(56);
    expect(score('todayUrg')).toBe(70);
    expect(score('tomorrowHigh')).toBe(60);
    expect(score('in3')).toBe(36);
    expect(score('in7')).toBe(24);
    expect(score('in8')).toBe(16);
    expect(score('nodue')).toBe(6);
    expect(score('stale')).toBe(11);
    expect(byTitle.todayUrg.reasons).toEqual(['due_today', 'priority_urgent']);
    expect(byTitle.tomorrowHigh.reasons).toEqual(['due_tomorrow', 'priority_high', 'in_progress']);
    expect(byTitle.overdue5.reasons).toEqual(['overdue']);
    expect(byTitle.in3.reasons).toEqual(['due_soon', 'quick_win']);
    expect(byTitle.in7.reasons).toEqual(['due_soon']);
    expect(byTitle.in8.reasons).toEqual([]);
    expect(byTitle.stale.reasons).toEqual(['stale']);
    // order: score desc, then due_date asc (overdue20 is older than overdue5 at equal score)
    expect(rows.map((r) => r.title)).toEqual([
      'todayUrg', 'tomorrowHigh', 'overdue20', 'overdue5', 'in3', 'in7', 'in8', 'stale', 'nodue',
    ]);
    expect(byTitle.todayUrg.status).toBe('todo');
    expect(byTitle.tomorrowHigh.status).toBe('in_progress');
    expect(byTitle.todayUrg.due_date).toBeTruthy();
  });

  it('default limit is 5; p_limit respected; null -> 5', async () => {
    expect(await focus(a)).toHaveLength(5);
    expect(await focus(a, 2)).toHaveLength(2);
    expect(await focus(a, null)).toHaveLength(5);
  });

  it('p_limit < 1 -> invalid_input', async () => {
    await expectCode(focus(a, 0), 'invalid_input');
    await expectCode(focus(a, -3), 'invalid_input');
  });

  it('RLS: B does not see A\'s tasks', async () => {
    await clearTasks(b);
    expect(await focus(b, 50)).toHaveLength(0);
    await newTask(b, { title: 'B only' });
    const rows = await focus(b, 50);
    expect(rows.map((r) => r.title)).toEqual(['B only']);
  });
});

// ---------------------------------------------------------------------------
describe('estimate_suggestion', () => {
  const est = async (user, cat = null) => (await one(user, 'select public.estimate_suggestion($1) as e', [cat])).e;
  const doneTask = async (user, est_, actual, fields = {}) => {
    const t = await newTask(user, { title: 'e', estimated_minutes: est_, status: 'completed', ...fields });
    await db.query('update public.tasks set actual_minutes = $2 where id = $1', [t.id, actual]);
    return t;
  };

  it('no samples', async () => {
    await clearTasks(a);
    expect(await est(a)).toEqual({ samples: 0, accuracy_ratio: null, median_actual_minutes: null, suggested_multiplier: null });
  });

  it('< 3 samples: ratio reported, no multiplier', async () => {
    await doneTask(a, 60, 90); // 1.5
    await doneTask(a, 30, 30); // 1.0
    const e = await est(a);
    expect(e.samples).toBe(2);
    expect(e.accuracy_ratio).toBeCloseTo(1.25, 4);
    expect(e.median_actual_minutes).toBeCloseTo(60, 1);
    expect(e.suggested_multiplier).toBeNull();
  });

  it('>= 3 samples: median ratio + multiplier; ignores unusable tasks', async () => {
    await doneTask(a, 10, 23); // 2.3
    // ignored: no estimate, zero actual, not completed
    await doneTask(a, null, 50);
    await doneTask(a, 0, 50);
    await doneTask(a, 20, 0);
    const open = await newTask(a, { title: 'open', estimated_minutes: 10 });
    await db.query('update public.tasks set actual_minutes = 100 where id = $1', [open.id]);
    const e = await est(a);
    expect(e.samples).toBe(3);
    expect(e.accuracy_ratio).toBeCloseTo(1.5, 4); // median(1.0, 1.5, 2.3)
    expect(e.median_actual_minutes).toBeCloseTo(30, 1); // median(30, 90, 23)
    expect(e.suggested_multiplier).toBe(1.5);
  });

  it('filters by category', async () => {
    const cat = await categoryId(db, a, 'task', 'Học tập');
    await doneTask(a, 10, 10, { category_id: cat });
    const e = await est(a, cat);
    expect(e.samples).toBe(1);
    expect(e.accuracy_ratio).toBeCloseTo(1, 4);
  });

  it('uses only the 50 most recent completed tasks', async () => {
    await clearTasks(b);
    // 10 old tasks with ratio 5, then 50 newer ones with ratio 1
    for (let i = 0; i < 10; i++) {
      const t = await doneTask(b, 10, 50);
      await db.query(`update public.tasks set completed_at = now() - interval '30 days' where id = $1`, [t.id]);
    }
    await asUser(db, b, (tx) =>
      tx.query(`insert into public.tasks (title, estimated_minutes, status)
                select 'n' || g, 20, 'completed' from generate_series(1, 50) g`),
    );
    await db.query(`update public.tasks set actual_minutes = 20 where user_id = $1 and estimated_minutes = 20`, [b]);
    const e = await est(b);
    expect(e.samples).toBe(50);
    expect(e.accuracy_ratio).toBeCloseTo(1, 4);
    expect(e.suggested_multiplier).toBe(1);
  });

  it('RLS: A\'s data is invisible to B and vice versa', async () => {
    await clearTasks(b);
    expect((await est(b)).samples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('privileges', () => {
  const rpcs = [
    'public.start_timer()',
    'public.stop_timer()',
    'public.timer_current()',
    `public.log_time(null, now() - interval '2 hours', now() - interval '1 hour')`,
    'public.focus_tasks()',
    'public.estimate_suggestion()',
    `public.recurrence_next_date('daily', current_date)`,
  ];

  it('anon cannot execute any RPC', async () => {
    for (const call of rpcs) {
      await expect(asAnon(db, (tx) => tx.query(`select ${call}`)), call).rejects.toThrow(/permission denied/);
    }
  });

  it('functions are SECURITY INVOKER with search_path = \'\'', async () => {
    const { rows } = await db.query(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('start_timer','stop_timer','timer_current','log_time','focus_tasks','estimate_suggestion',
                           'recurrence_next_date','tasks_spawn_next_recurrence','lock_user_time')`);
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=""');
    }
  });

  it('public/anon have no EXECUTE; trigger function not executable by authenticated', async () => {
    const { rows } = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('start_timer','stop_timer','timer_current','log_time','focus_tasks','estimate_suggestion',
                           'tasks_spawn_next_recurrence')`);
    for (const r of rows) {
      expect(r.anon_x, r.proname).toBe(false);
      expect(r.auth_x, r.proname).toBe(r.proname !== 'tasks_spawn_next_recurrence');
    }
  });
});
