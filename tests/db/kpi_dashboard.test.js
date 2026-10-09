// Section 3 of docs/backend-api-contract.md — kpi_forecast, dashboard_summary,
// productivity_stats, streaks (migration 20261009000500_kpi_dashboard.sql).
//
// Determinism: every test user gets a fixed-offset timezone chosen so that the
// user's local clock is ~12:00 right now. "Today", "yesterday", "-30 minutes"
// are then never near a midnight boundary, whatever hour the suite runs at.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon, q, categoryId } from './harness.js';

let db;
const OFF = 12 - new Date().getUTCHours(); // local = UTC + OFF hours, OFF in [-11, 12]
const TZ = OFF === 0 ? 'Etc/UTC' : `Etc/GMT${OFF > 0 ? '-' : '+'}${Math.abs(OFF)}`; // Etc/GMT sign is inverted
let T; // user's today, 'YYYY-MM-DD'

// ---- date helpers (pure JS, mirror the user's fixed-offset zone) ----
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const D = (n) => addDays(T, n); // T + n days
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
/** Instant (ISO, UTC) of local wall-clock `hh:mm` on `day` in TZ. */
const at = (day, hhmm = '10:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - OFF * 3600000).toISOString();
};

// ---- data helpers (superuser: bypasses RLS) ----
async function newUser(weekStartsOn = 1, tz = TZ) {
  const id = await createUser(db);
  await db.query('update public.profiles set timezone = $1, week_starts_on = $2 where id = $3', [tz, weekStartsOn, id]);
  return id;
}

/** Insert a task with full control over created_at / completed_at (trigger disabled). */
async function task(user, f = {}) {
  const status = f.status ?? (f.completed_at ? 'completed' : 'todo');
  const completedAt = status === 'completed' ? f.completed_at ?? new Date().toISOString() : null;
  await db.exec('alter table public.tasks disable trigger trg_tasks_completed_at');
  try {
    const { rows } = await db.query(
      `insert into public.tasks (user_id, title, status, due_date, category_id, created_at, completed_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7) returning id`,
      [user, f.title ?? 'task', status, f.due_date ?? null, f.category_id ?? null, f.created_at ?? null, completedAt],
    );
    return rows[0].id;
  } finally {
    await db.exec('alter table public.tasks enable trigger trg_tasks_completed_at');
  }
}

async function entry(user, startedAt, endedAt, taskId = null) {
  const { rows } = await db.query(
    `insert into public.time_entries (user_id, task_id, started_at, ended_at, source)
     values ($1, $2, $3, $4, 'manual') returning id`,
    [user, taskId, startedAt, endedAt],
  );
  return rows[0].id;
}
/** Finished entry of `minutes` starting at local hh:mm on `day`. */
const entryMin = (user, day, hhmm, minutes, taskId = null) => {
  const s = at(day, hhmm);
  return entry(user, s, new Date(new Date(s).getTime() + minutes * 60000).toISOString(), taskId);
};

async function kpi(user, f) {
  const { rows } = await db.query(
    `insert into public.kpis (user_id, name, target_value, start_date, end_date, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [user, f.name ?? 'kpi', f.target ?? 100, f.start, f.end ?? null, f.status ?? 'active'],
  );
  const id = rows[0].id;
  for (const r of f.records ?? []) {
    await db.query(
      `insert into public.kpi_records (user_id, kpi_id, recorded_on, value, created_at)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`,
      [user, id, r[0], r[1], r[2] ?? null],
    );
  }
  return id;
}

async function forecast(user, kpiId = null) {
  const rows = await q(db, user, 'select to_jsonb(k) as j from public.kpi_forecast($1) k', [kpiId]);
  return rows.map((r) => r.j);
}
const one = async (user, kpiId) => (await forecast(user, kpiId))[0];
const rpc = async (user, sql, params = []) => (await q(db, user, sql, params))[0].r;
const summary = (user) => rpc(user, 'select public.dashboard_summary() as r');
const stats = (user, from, to) => rpc(user, 'select public.productivity_stats($1, $2) as r', [from, to]);
const streaks = (user) => rpc(user, 'select public.streaks() as r');

beforeAll(async () => {
  db = await createDb();
  const u = await newUser();
  T = (await q(db, u, 'select public.user_today()::text as t'))[0].t;
});

// =====================================================================
describe('kpi_forecast', () => {
  let u;
  beforeAll(async () => {
    u = await newUser();
  });

  it('time-zone sanity: user clock is near noon (test determinism)', async () => {
    const [{ h }] = await q(db, u, `select extract(hour from now() at time zone public.user_tz())::int as h`);
    expect(h).toBeGreaterThanOrEqual(11);
    expect(h).toBeLessThanOrEqual(13);
  });

  it('on_track: exact slope, projected value at end_date, completion date, expected_pct', async () => {
    const id = await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(-5), 25], [D(0), 50]] });
    const k = await one(u, id);
    expect(k).toMatchObject({
      kpi_id: id, records: 3, slope_per_day: 5, current_value: 50, progress_pct: 50,
      expected_pct: 50, projected_value: 100, projected_completion: D(10), status: 'on_track',
      start_date: D(-10), end_date: D(10), target_value: 100, unit: '',
    });
  });

  it('at_risk: projected >= 80% target, progress behind schedule', async () => {
    const id = await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(-5), 20], [D(0), 40]] });
    const k = await one(u, id);
    expect(k).toMatchObject({ slope_per_day: 4, projected_value: 80, projected_completion: D(15), status: 'at_risk' });
  });

  it('off_track: projected < 80% target', async () => {
    const id = await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(-5), 10], [D(0), 20]] });
    const k = await one(u, id);
    expect(k).toMatchObject({ slope_per_day: 2, projected_value: 40, projected_completion: D(40), status: 'off_track' });
  });

  it('on_track via progress_pct >= expected_pct even with negative slope', async () => {
    const id = await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 60], [D(0), 55]] });
    const k = await one(u, id);
    expect(k).toMatchObject({ slope_per_day: -0.5, projected_value: 50, progress_pct: 55, expected_pct: 50,
      projected_completion: null, status: 'on_track' });
  });

  it('achieved when current >= target (no completion date), even with 1 record', async () => {
    const a = await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 50], [D(-5), 100]] });
    expect(await one(u, a)).toMatchObject({ status: 'achieved', progress_pct: 100, projected_completion: null });
    const b = await kpi(u, { start: D(-1), records: [[D(0), 150]] });
    expect(await one(u, b)).toMatchObject({ status: 'achieved', progress_pct: 150, records: 1, slope_per_day: null });
  });

  it('no_data: 0 or 1 record -> slope/projections null', async () => {
    const a = await kpi(u, { start: D(-3), end: D(3) });
    expect(await one(u, a)).toMatchObject({ status: 'no_data', records: 0, current_value: 0, slope_per_day: null,
      projected_value: null, projected_completion: null, expected_pct: 50 });
    const b = await kpi(u, { start: D(-3), end: D(3), records: [[D(-1), 10]] });
    expect(await one(u, b)).toMatchObject({ status: 'no_data', records: 1, current_value: 10, slope_per_day: null });
  });

  it('duplicate days: only the latest record of a day is a point', async () => {
    // naive regression over all 4 rows would give 85/11 = 7.727...
    const id = await kpi(u, {
      start: D(-4), end: D(10),
      records: [
        [D(-4), 30, at(D(-4), '11:00')],
        [D(-4), 10, at(D(-4), '09:00')], // older -> ignored
        [D(-2), 40],
        [D(0), 50],
      ],
    });
    const k = await one(u, id);
    expect(k).toMatchObject({ records: 3, slope_per_day: 5, current_value: 50, projected_completion: D(10) });
    const [{ cv }] = await db.query('select current_value::float8 as cv from public.kpis where id = $1', [id]).then((r) => r.rows);
    expect(cv).toBe(50); // agrees with the sync trigger
  });

  it('least-squares slope (not endpoint slope) on noisy data', async () => {
    // points (0,1) (1,3) (2,2) (3,5): slope = 5.5 / 5 = 1.1
    const id = await kpi(u, { start: D(-3), end: D(30), target: 1000,
      records: [[D(-3), 1], [D(-2), 3], [D(-1), 2], [D(0), 5]] });
    const k = await one(u, id);
    expect(k.slope_per_day).toBe(1.1);
    expect(k.projected_value).toBe(5 + 1.1 * 30); // anchored on latest point
    expect(k.projected_completion).toBe(D(Math.ceil((1000 - 5) / 1.1))); // 905 days
  });

  it('projected_completion rounds up partial days', async () => {
    const id = await kpi(u, { start: D(-2), records: [[D(-2), 44], [D(0), 50]] }); // slope 3, 50 left -> 16.67 -> 17
    expect(await one(u, id)).toMatchObject({ slope_per_day: 3, projected_completion: D(17) });
  });

  it('projected_completion null when absurdly far (> 100 years)', async () => {
    const id = await kpi(u, { start: D(-1), target: 1e9, records: [[D(-1), 0], [D(0), 1]] });
    expect(await one(u, id)).toMatchObject({ slope_per_day: 1, projected_completion: null });
  });

  it('no end_date: status by trend (up -> on_track, flat -> at_risk, down -> off_track)', async () => {
    const up = await kpi(u, { start: D(-5), records: [[D(-5), 10], [D(0), 20]] });
    const flat = await kpi(u, { start: D(-5), records: [[D(-5), 10], [D(0), 10]] });
    const down = await kpi(u, { start: D(-5), records: [[D(-5), 20], [D(0), 10]] });
    expect(await one(u, up)).toMatchObject({ status: 'on_track', projected_value: null, expected_pct: null, slope_per_day: 2 });
    expect(await one(u, flat)).toMatchObject({ status: 'at_risk', slope_per_day: 0, projected_completion: null });
    expect(await one(u, down)).toMatchObject({ status: 'off_track', slope_per_day: -2 });
  });

  it('deadline passed: projected_value = current (no extrapolation), expected 100', async () => {
    // extrapolating 85 + 8.5*5 would claim 127.5 / on_track — wrong after the deadline
    const id = await kpi(u, { start: D(-20), end: D(-5), records: [[D(-20), 0], [D(-10), 85]] });
    expect(await one(u, id)).toMatchObject({ projected_value: 85, expected_pct: 100, status: 'at_risk' });
  });

  it('expected_pct clamps to 0 before start; end = start edge case', async () => {
    const a = await kpi(u, { start: D(5), end: D(15) });
    expect((await one(u, a)).expected_pct).toBe(0);
    const b = await kpi(u, { start: D(0), end: D(0) });
    expect((await one(u, b)).expected_pct).toBe(100);
  });

  it('default lists only active KPIs; explicit id returns any status', async () => {
    const paused = await kpi(u, { start: D(-1), status: 'paused', name: 'paused one' });
    const all = await forecast(u);
    expect(all.find((k) => k.kpi_id === paused)).toBeUndefined();
    expect(all.length).toBeGreaterThan(5);
    expect((await one(u, paused)).name).toBe('paused one');
  });
});

// =====================================================================
describe('dashboard_summary', () => {
  it('fresh user: all zeros / nulls, exact shape', async () => {
    const u = await newUser();
    expect(await summary(u)).toEqual({
      today: T,
      tasks: { open: 0, overdue: 0, due_today: 0, completed_today: 0, completed_this_week: 0 },
      time: { today_minutes: 0, week_minutes: 0, running: null },
      money: { month_spent: 0, month_budget: null, month_remaining: null, month_projected: 0, today_spent: 0 },
      kpis: { active: 0, on_track: 0, at_risk: 0, off_track: 0 },
      shopping: { planned_count: 0, planned_total: 0 },
      streak: { current: 0, longest: 0 },
    });
  });

  describe('populated user', () => {
    let u, s, runTask, runEntry;
    const monthStart = () => `${T.slice(0, 7)}-01`;
    beforeAll(async () => {
      u = await newUser(1);
      // tasks
      await task(u, { title: 'open no due' });
      await task(u, { title: 'overdue', due_date: D(-2) });
      runTask = await task(u, { title: 'Viết báo cáo', status: 'in_progress', due_date: D(0) });
      await task(u, { title: 'future', due_date: D(3) });
      await task(u, { title: 'done today (late)', due_date: D(-5), completed_at: new Date().toISOString() });
      await task(u, { title: 'cancelled', status: 'cancelled', due_date: D(-1) });
      await task(u, { title: 'done 8 days ago', completed_at: at(D(-8)) });
      // time: 30 min today on runTask, midnight-spanning 60 min starting yesterday, running 15 min
      await entryMin(u, D(0), '08:00', 30, runTask);
      await entryMin(u, D(-1), '23:30', 60);
      runEntry = (await db.query(
        `insert into public.time_entries (user_id, task_id, started_at) values ($1, $2, now() - interval '15 minutes') returning id`,
        [u, runTask])).rows[0].id;
      // money
      const month = monthStart();
      const prevMonthLast = addDays(month, -1);
      const nextMonth = new Date(`${month}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const twoMonthsAgo = new Date(`${month}T00:00:00Z`); twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
      const food = await categoryId(db, u, 'expense', 'Ăn uống');
      await db.query(`insert into public.budgets (user_id, effective_month, amount) values ($1, $2, 1000000), ($1, $3, 5000000)`,
        [u, twoMonthsAgo.toISOString().slice(0, 10), nextMonth.toISOString().slice(0, 10)]);
      await db.query(`insert into public.budgets (user_id, effective_month, category_id, amount) values ($1, $2, $3, 200)`, [u, month, food]);
      await db.query(
        `insert into public.expenses (user_id, amount, spent_on) values ($1, 100000, $2), ($1, 200000, $3), ($1, 999, $4), ($1, 777, $5)`,
        [u, T, month, prevMonthLast, nextMonth.toISOString().slice(0, 10)]);
      // KPIs: on_track, at_risk, off_track, achieved, no_data, paused
      await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(0), 50]] });
      await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(0), 40]] });
      await kpi(u, { start: D(-10), end: D(10), records: [[D(-10), 0], [D(0), 20]] });
      await kpi(u, { start: D(-10), records: [[D(0), 100]] });
      await kpi(u, { start: D(-10) });
      await kpi(u, { start: D(-10), status: 'paused' });
      // shopping
      await db.query(
        `insert into public.shopping_items (user_id, name, unit_price, quantity, status) values
           ($1, 'a', 50000, 2, 'planned'), ($1, 'b', 30000, 1, 'planned'), ($1, 'c', 9, 1, 'wishlist'), ($1, 'd', 7, 1, 'purchased')`,
        [u]);
      s = await summary(u);
    });

    it('today', () => expect(s.today).toBe(T));

    it('tasks: open / overdue / due_today / completed_today exclude closed tasks', () => {
      expect(s.tasks.open).toBe(4);
      expect(s.tasks.overdue).toBe(1); // completed (due -5) and cancelled (due -1) are not overdue
      expect(s.tasks.due_today).toBe(1);
      expect(s.tasks.completed_today).toBe(1);
      expect(s.tasks.completed_this_week).toBe(1); // the -8 days one is never in this week
    });

    it('time: running elapsed counted today; midnight-spanning entry stays on its start day', () => {
      expect(s.time.today_minutes).toBe(45);
      const weekStart = D(-((dow(T) - 1 + 7) % 7));
      expect(s.time.week_minutes).toBe(45 + (D(-1) >= weekStart ? 60 : 0));
    });

    it('time.running has timer_current() shape', () => {
      const r = s.time.running;
      expect(r.task_title).toBe('Viết báo cáo');
      expect(r.entry.id).toBe(runEntry);
      expect(r.entry.ended_at).toBeNull();
      expect(r.elapsed_seconds).toBeGreaterThanOrEqual(900);
      expect(r.elapsed_seconds).toBeLessThan(1200);
      expect(r.task_total_seconds).toBe(1800 + r.elapsed_seconds);
    });

    it('money: month spend, carry-forward overall budget, projection', () => {
      const month = monthStart();
      const spent = 300000; // both rows fall in this month (they coincide when today is the 1st)
      const daysElapsed = daysBetween(month, T) + 1;
      const [y, m] = T.split('-').map(Number);
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      expect(s.money.month_spent).toBe(spent);
      expect(s.money.today_spent).toBe(month === T ? 300000 : 100000);
      expect(s.money.month_budget).toBe(1000000); // older row carried forward; next-month row ignored; category row ignored
      expect(s.money.month_remaining).toBe(700000);
      expect(s.money.month_projected).toBeCloseTo(Math.round((spent / daysElapsed) * dim * 100) / 100, 2);
    });

    it('kpis: active only; achieved counts as on_track; no_data in no bucket', () => {
      expect(s.kpis).toEqual({ active: 5, on_track: 2, at_risk: 1, off_track: 1 });
    });

    it('shopping: planned only', () => {
      expect(s.shopping).toEqual({ planned_count: 2, planned_total: 130000 });
    });

    it('streak mirrors streaks()', async () => {
      const st = await streaks(u);
      expect(s.streak).toEqual({ current: st.current, longest: st.longest });
      expect(s.streak).toEqual({ current: 2, longest: 2 }); // today: task done; yesterday: 60-min entry (start day)
    });
  });

  describe('week start', () => {
    // one completed task + 10 minutes on each of the last 7 days (T-6..T)
    let u;
    beforeAll(async () => {
      u = await newUser(1);
      for (let i = 0; i < 7; i++) {
        await task(u, { completed_at: at(D(-i), '09:00') });
        await entryMin(u, D(-i), '07:00', 10);
      }
    });
    for (const ws of [0, 1, 6]) {
      it(`week_starts_on = ${ws}`, async () => {
        await db.query('update public.profiles set week_starts_on = $1 where id = $2', [ws, u]);
        const s = await summary(u);
        const back = (dow(T) - ws + 7) % 7; // independent reference
        expect(dow(D(-back))).toBe(ws);
        expect(s.tasks.completed_this_week).toBe(back + 1);
        expect(s.time.week_minutes).toBe((back + 1) * 10);
        expect(s.time.today_minutes).toBe(10);
      });
    }
    it('Sunday vs Monday start always differ by exactly one day', async () => {
      await db.query('update public.profiles set week_starts_on = 0 where id = $1', [u]);
      const sun = (await summary(u)).tasks.completed_this_week;
      await db.query('update public.profiles set week_starts_on = 1 where id = $1', [u]);
      const mon = (await summary(u)).tasks.completed_this_week;
      expect(dow(T) === 0 ? mon - sun : sun - mon).toBe(dow(T) === 0 ? 6 : 1);
    });
  });
});

// =====================================================================
describe('productivity_stats', () => {
  let u, s, work, study;
  beforeAll(async () => {
    u = await newUser();
    work = await categoryId(db, u, 'task', 'Công việc');
    study = await categoryId(db, u, 'task', 'Học tập');
    const t1 = await task(u, { category_id: work, created_at: at(D(-6), '10:00'), completed_at: at(D(-5), '10:00'), due_date: D(-5) }); // 24h, on time
    const t2 = await task(u, { category_id: study, created_at: at(D(-5), '10:00'), completed_at: at(D(-3), '10:00'), due_date: D(-4) }); // 48h, late
    await task(u, { created_at: at(D(-4), '10:00') }); // open
    await task(u, { status: 'cancelled', created_at: at(D(-3), '10:00') }); // excluded from completion_rate
    await task(u, { created_at: at(D(-2), '08:00'), completed_at: at(D(-2), '14:00') }); // 6h, no due
    await task(u, { created_at: at(D(-20), '10:00'), completed_at: at(D(-1), '10:00'), due_date: D(0) }); // 456h, on time; created outside
    await task(u, { created_at: at(D(-9), '10:00'), completed_at: at(D(-8), '10:00') }); // outside range entirely
    await entryMin(u, D(-6), '09:00', 60, t1);
    await entryMin(u, D(-6), '23:30', 60); // spans midnight -> D(-6), no task
    await entryMin(u, D(-3), '09:00', 45, t2);
    await entryMin(u, D(-7), '09:00', 30, t1); // outside range
    await db.query(`insert into public.time_entries (user_id, started_at) values ($1, now() - interval '10 minutes')`, [u]); // running: excluded
    s = await stats(u, D(-6), D(0));
  });

  it('completed_by_day is zero-filled and ordered', () => {
    expect(s.completed_by_day).toEqual([0, 1, 0, 1, 1, 1, 0].map((count, i) => ({ day: D(i - 6), count })));
  });

  it('minutes_by_day: finished only, start-day attribution, zero-filled', () => {
    expect(s.minutes_by_day).toEqual([120, 0, 0, 45, 0, 0, 0].map((minutes, i) => ({ day: D(i - 6), minutes })));
  });

  it('minutes_by_category incl. uncategorized bucket', () => {
    expect(s.minutes_by_category).toHaveLength(3);
    expect(s.minutes_by_category.find((c) => c.category_id === work)).toMatchObject({ name: 'Công việc', minutes: 60, color: '#3B82C4' });
    expect(s.minutes_by_category.find((c) => c.category_id === null)).toEqual({ category_id: null, name: null, color: null, minutes: 60 });
    expect(s.minutes_by_category[2]).toMatchObject({ category_id: study, minutes: 45 });
  });

  it('rates and cycle time', () => {
    expect(s.completion_rate).toBe(0.75); // created in range (non-cancelled): 4, completed: 3
    expect(s.on_time_rate).toBe(0.6667); // 2 of 3 with due date
    expect(s.avg_cycle_hours).toBe(133.5); // (24 + 48 + 6 + 456) / 4
  });

  it('busiest_weekday: ties on count broken by minutes', () => {
    expect(s.busiest_weekday).toBe(dow(D(-3)));
  });

  it('empty range: zero-filled arrays, null rates', async () => {
    const e = await stats(u, D(-40), D(-38));
    expect(e).toEqual({
      completed_by_day: [-40, -39, -38].map((i) => ({ day: D(i), count: 0 })),
      minutes_by_day: [-40, -39, -38].map((i) => ({ day: D(i), minutes: 0 })),
      minutes_by_category: [], completion_rate: null, on_time_rate: null, avg_cycle_hours: null, busiest_weekday: null,
    });
  });

  it('single-day range and 366-day range accepted', async () => {
    expect((await stats(u, T, T)).completed_by_day).toHaveLength(1);
    expect((await stats(u, D(-365), D(0))).completed_by_day).toHaveLength(366);
  });

  it.each([
    ['from > to', 1, 0],
    ['367 days', -366, 0],
    ['null from', null, 0],
  ])('invalid range (%s) -> P0001 invalid_input', async (_, a, b) => {
    const err = await stats(u, a === null ? null : D(a), D(b)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('invalid_input');
    expect(err.code).toBe('P0001');
  });
});

// =====================================================================
describe('streaks', () => {
  it('no activity', async () => {
    const u = await newUser();
    expect(await streaks(u)).toEqual({ current: 0, longest: 0, last_active_day: null });
  });

  it('gaps break runs; time threshold sums entries of a day', async () => {
    const u = await newUser();
    await task(u, { completed_at: new Date().toISOString() }); // T
    await entryMin(u, D(-1), '09:00', 20); // T-1 active (20 min)
    await task(u, { completed_at: at(D(-2)) }); // T-2
    await entryMin(u, D(-3), '09:00', 7); // T-3: 7 + 7 = 14 min -> NOT active
    await entryMin(u, D(-3), '10:00', 7);
    for (const i of [4, 5, 6, 7]) await task(u, { completed_at: at(D(-i)) });
    await entryMin(u, D(-8), '09:00', 8); // T-8: 8 + 8 = 16 min -> active
    await entryMin(u, D(-8), '10:00', 8);
    expect(await streaks(u)).toEqual({ current: 3, longest: 5, last_active_day: T });
  });

  it('today not active yet: streak still counts from yesterday', async () => {
    const u = await newUser();
    await task(u, { completed_at: at(D(-1)) });
    await task(u, { completed_at: at(D(-2)) });
    await task(u, { status: 'cancelled' });
    expect(await streaks(u)).toEqual({ current: 2, longest: 2, last_active_day: D(-1) });
  });

  it('last active day before yesterday: current = 0', async () => {
    const u = await newUser();
    await task(u, { completed_at: at(D(-2)) });
    expect(await streaks(u)).toEqual({ current: 0, longest: 1, last_active_day: D(-2) });
  });

  it('15-minute threshold is inclusive (900 s); 899 s is not; running timer ignored', async () => {
    const u = await newUser();
    const s = at(D(-1), '09:00');
    await entry(u, s, new Date(new Date(s).getTime() + 900000).toISOString());
    const s2 = at(D(-2), '09:00');
    await entry(u, s2, new Date(new Date(s2).getTime() + 899000).toISOString());
    await db.query(`insert into public.time_entries (user_id, started_at) values ($1, now() - interval '2 hours')`, [u]);
    expect(await streaks(u)).toEqual({ current: 1, longest: 1, last_active_day: D(-1) });
  });

  it('day attribution uses the user timezone (Asia/Ho_Chi_Minh)', async () => {
    const u = await newUser(1, 'Asia/Ho_Chi_Minh');
    const today = (await q(db, u, 'select public.user_today()::text as t'))[0].t;
    // 2 days ago 00:30 local (+07) = previous UTC calendar day 17:30
    const day = addDays(today, -2);
    const [y, m, d] = day.split('-').map(Number);
    const instant = new Date(Date.UTC(y, m - 1, d, 0, 30) - 7 * 3600000).toISOString();
    await task(u, { completed_at: instant });
    expect((await streaks(u)).last_active_day).toBe(day);
  });
});

// =====================================================================
describe('security', () => {
  const FNS = [
    ['kpi_forecast', 'select * from public.kpi_forecast()'],
    ['dashboard_summary', 'select public.dashboard_summary()'],
    ['productivity_stats', `select public.productivity_stats(current_date - 1, current_date)`],
    ['streaks', 'select public.streaks()'],
  ];

  it('RLS: another user sees nothing of mine', async () => {
    const a = await newUser();
    const b = await newUser();
    const k = await kpi(a, { start: D(-5), end: D(5), records: [[D(-5), 1], [D(0), 2]] });
    await task(a, { completed_at: new Date().toISOString(), due_date: D(-1) });
    await task(a, { due_date: D(-1) });
    await entryMin(a, D(0), '08:00', 30);
    await db.query(`insert into public.expenses (user_id, amount, spent_on) values ($1, 5000, $2)`, [a, T]);
    await db.query(`insert into public.shopping_items (user_id, name, unit_price, status) values ($1, 'x', 10, 'planned')`, [a]);

    expect(await forecast(b)).toEqual([]);
    expect(await forecast(b, k)).toEqual([]);
    expect(await forecast(a, k)).toHaveLength(1);
    const sb = await summary(b);
    expect(sb.tasks).toEqual({ open: 0, overdue: 0, due_today: 0, completed_today: 0, completed_this_week: 0 });
    expect(sb.time.today_minutes).toBe(0);
    expect(sb.money.month_spent).toBe(0);
    expect(sb.kpis.active).toBe(0);
    expect(sb.shopping.planned_count).toBe(0);
    expect(await streaks(b)).toEqual({ current: 0, longest: 0, last_active_day: null });
    const pb = await stats(b, D(-1), D(0));
    expect(pb.completed_by_day.every((x) => x.count === 0)).toBe(true);
    expect(pb.minutes_by_day.every((x) => x.minutes === 0)).toBe(true);

    const sa = await summary(a);
    expect(sa.tasks).toMatchObject({ open: 1, overdue: 1, completed_today: 1 });
    expect(sa.time.today_minutes).toBe(30);
    expect(sa.money.month_spent).toBe(5000);
  });

  it.each(FNS)('anon cannot execute %s', async (_, sql) => {
    await expect(asAnon(db, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
  });

  it('privileges and function attributes', async () => {
    const { rows } = await db.query(`
      select p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('kpi_forecast', 'dashboard_summary', 'productivity_stats', 'streaks')`);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=""');
      expect(r.anon_x, r.proname).toBe(false);
      expect(r.public_x, r.proname).toBe(false);
      expect(r.auth_x, r.proname).toBe(true);
    }
  });

  it('authenticated call with no JWT sub is rejected', async () => {
    await expect(asUser(db, '', (tx) => tx.query('select public.dashboard_summary()'))).rejects.toThrow(/not_authenticated/);
  });
});
