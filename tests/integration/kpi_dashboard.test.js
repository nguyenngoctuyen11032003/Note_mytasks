// KPI + dashboard services end-to-end against the LOCAL Supabase stack:
// real services (src/services/kpis.js, dashboard.js, …) → real PostgREST → real SQL.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import pg from 'pg';
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import * as kpis from '../../src/services/kpis.js';
import * as dashboard from '../../src/services/dashboard.js';
import * as activity from '../../src/services/activity.js';
import * as tasks from '../../src/services/tasks.js';
import * as categories from '../../src/services/categories.js';
import * as expenses from '../../src/services/expenses.js';
import * as budgets from '../../src/services/budgets.js';
import * as shopping from '../../src/services/shopping.js';
import * as timer from '../../src/services/timer.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const T = todayVN();
const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const startOfMonth = (d) => d.slice(0, 8) + '01';
const daysInMonth = (d) => {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const vnNoon = (day, hh = 12) => `${day}T${String(hh).padStart(2, '0')}:00:00+07:00`;

const DB_URL = process.env.IT_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * Insert already-completed tasks with an arbitrary completed_at/created_at.
 * trg_tasks_completed_at (000100) always stamps now() on completion and keeps
 * the old value on later updates, so backdating needs triggers off (local DB only).
 */
async function insertCompletedTasks(userId, rows) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const r of rows) {
      await c.query(
        `insert into public.tasks (user_id, title, status, priority, category_id, due_date, completed_at, created_at)
         values ($1, $2, 'completed', $3, $4, $5, $6, $7)`,
        [userId, r.title, r.priority || 'medium', r.category_id || null, r.due_date || null, r.completed_at, r.created_at || r.completed_at],
      );
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

/** Every leaf of `obj` (except the listed keys) must be a JS number. */
function expectNumbers(obj, path = '', skip = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (skip.has(p)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) expectNumbers(v, p, skip);
    else expect(typeof v, p).toBe('number');
  }
}

const isAppError = (code) => expect.objectContaining({ name: 'AppError', code });

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------
describe('kpis service (real DB)', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'KPI' }); setClient(U.client); });
  afterAll(async () => { await deleteUser(U?.user); });

  it('validates input client-side (target > 0, end >= start, name required)', async () => {
    await expect(kpis.createKpi({ name: 'X', target_value: 0, start_date: T })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.createKpi({ name: 'X', target_value: -5, start_date: T })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.createKpi({ name: 'X', target_value: 'abc', start_date: T })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.createKpi({ name: '  ', target_value: 10, start_date: T })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.createKpi({ name: 'X', target_value: 10, start_date: T, end_date: addDays(T, -1) }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'end_date' } });
    await expect(kpis.createKpi({ name: 'X', target_value: 10, start_date: '2026-02-30' })).rejects.toEqual(isAppError('invalid_input'));
    const { count } = await admin.from('kpis').select('id', { count: 'exact', head: true }).eq('user_id', U.user.id);
    expect(count).toBe(0);
  });

  it('server CHECKs back the same rules (bypassing the client validation)', async () => {
    const r1 = await U.client.from('kpis').insert({ name: 'raw', target_value: 0 }).select().single();
    expect(r1.error?.code).toBe('23514');
    const r2 = await U.client.from('kpis').insert({ name: 'raw', target_value: 5, start_date: T, end_date: addDays(T, -1) }).select().single();
    expect(r2.error?.code).toBe('23514');
  });

  it('CRUD + records (both call forms) + current_value sync + kpi_progress view', async () => {
    const k = await kpis.createKpi({ name: '  Doanh số  ', unit: 'tr', target_value: '200', start_date: addDays(T, -10), end_date: addDays(T, 20) });
    expect(k).toMatchObject({ name: 'Doanh số', unit: 'tr', target_value: 200, current_value: 0, status: 'active' });
    expect(typeof k.target_value).toBe('number');

    // form 1: addRecord(kpiId, {...}); form 2: addRecord({kpi_id, ...})
    const r1 = await kpis.addRecord(k.id, { recorded_on: addDays(T, -5), value: 50, note: 'tuần 1' });
    expect(r1).toMatchObject({ kpi_id: k.id, recorded_on: addDays(T, -5), value: 50, note: 'tuần 1' });
    const r2 = await kpis.addRecord({ kpi_id: k.id, recorded_on: T, value: '80.5' });
    expect(r2.value).toBe(80.5);
    // an OLDER snapshot inserted later must not overwrite current_value
    const r3 = await kpis.addRecord(k.id, { recorded_on: addDays(T, -8), value: 10 });

    await expect(kpis.addRecord(k.id, { recorded_on: T })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.addRecord({ recorded_on: T, value: 1 })).rejects.toEqual(isAppError('invalid_input'));

    const recs = await kpis.listRecords(k.id);
    expect(recs.map((r) => r.recorded_on)).toEqual([addDays(T, -8), addDays(T, -5), T]);
    expect(recs.every((r) => typeof r.value === 'number')).toBe(true);

    const [row] = (await kpis.listKpis()).filter((x) => x.id === k.id);
    expect(row).toMatchObject({
      current_value: 80.5, target_value: 200, progress_percent: 40.3, days_left: 20,
      last_recorded_on: T, record_count: 3, status: 'active',
    });
    for (const f of ['target_value', 'current_value', 'progress_percent', 'days_left', 'record_count']) expect(typeof row[f]).toBe('number');

    // listAllRecords (+ since filter)
    const all = await kpis.listAllRecords();
    expect(all.map((r) => r.id).sort()).toEqual([r1.id, r2.id, r3.id].sort());
    const since = await kpis.listAllRecords(addDays(T, -6));
    expect(since.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    await expect(kpis.listAllRecords('09/10/2026')).rejects.toEqual(isAppError('invalid_input'));

    // update record / delete record → current_value follows the latest snapshot
    await kpis.updateRecord(r2.id, { value: 120 });
    expect((await kpis.listKpis()).find((x) => x.id === k.id).current_value).toBe(120);
    await kpis.deleteRecord(r2.id);
    expect((await kpis.listKpis()).find((x) => x.id === k.id).current_value).toBe(50);

    // update KPI; current_value is never writable from the client
    const up = await kpis.updateKpi(k.id, { name: 'Doanh số Q4', target_value: 100, current_value: 999 });
    expect(up).toMatchObject({ name: 'Doanh số Q4', target_value: 100, current_value: 50 });
    await expect(kpis.updateKpi(k.id, { current_value: 1 })).rejects.toEqual(isAppError('invalid_input'));
    await expect(kpis.updateKpi(k.id, { end_date: addDays(T, -30), start_date: addDays(T, -10) }))
      .rejects.toEqual(isAppError('invalid_input'));
    // only end_date sent, earlier than the stored start_date → server CHECK → invalid_input
    await expect(kpis.updateKpi(k.id, { end_date: addDays(T, -30) })).rejects.toEqual(isAppError('invalid_input'));

    // status filter on the view
    await kpis.updateKpi(k.id, { status: 'paused' });
    expect((await kpis.listKpis({ status: 'active' })).some((x) => x.id === k.id)).toBe(false);
    expect((await kpis.listKpis({ status: ['paused', 'archived'] })).some((x) => x.id === k.id)).toBe(true);

    // delete cascades to kpi_records
    expect(await kpis.deleteKpi(k.id)).toBe(true);
    const { count } = await admin.from('kpi_records').select('id', { count: 'exact', head: true }).eq('kpi_id', k.id);
    expect(count).toBe(0);
    expect((await kpis.listKpis()).some((x) => x.id === k.id)).toBe(false);
    expect(await kpis.listRecords(k.id)).toEqual([]);
  });

  it('activity feed records KPI snapshots and can be cleared', async () => {
    const k = await kpis.createKpi({ name: 'Feed KPI', target_value: 10, start_date: T });
    await kpis.addRecord(k.id, { recorded_on: T, value: 3 });
    const feed = await activity.recent(50);
    expect(feed.some((a) => a.entity_type === 'kpi' && a.entity_id === k.id && a.metadata.value === 3)).toBe(true);
    expect(feed.every((a) => a.metadata && typeof a.metadata === 'object')).toBe(true);
    await expect(activity.recent(0)).rejects.toEqual(isAppError('invalid_input'));
    expect(await activity.clear()).toBe(true);
    expect(await activity.recent()).toEqual([]);
    await kpis.deleteKpi(k.id);
  });

  it('progress()/kpiForecast: linear series → on_track / at_risk / off_track / achieved / no_data; matches forecastLocal', async () => {
    const start = addDays(T, -10), end = addDays(T, 10);
    const mk = async (name, values, extra = {}) => {
      const k = await kpis.createKpi({ name, target_value: 100, start_date: start, end_date: end, ...extra });
      const days = [-10, -5, 0];
      for (let i = 0; i < values.length; i++) await kpis.addRecord(k.id, { recorded_on: addDays(T, days[i]), value: values[i] });
      return k;
    };
    const onTrack = await mk('On', [0, 25, 50]);     // 5/day → 50 + 5*10 = 100 at end
    const atRisk = await mk('Risk', [0, 20, 40]);    // 4/day → 80 (= 80 %)
    const offTrack = await mk('Off', [0, 1, 2]);     // 0.2/day → 4
    const achieved = await mk('Done', [30, 100]);
    const noData = await mk('Empty', [5]);
    const noEnd = await mk('Trend', [1, 2, 3], { end_date: null });
    const paused = await mk('Paused', [0, 1, 2], { status: 'paused' });

    const rows = await kpis.progress();
    const by = new Map(rows.map((r) => [r.kpi_id, r]));
    expect(by.has(paused.id)).toBe(false); // null = active only
    expect(by.get(onTrack.id)).toMatchObject({
      status: 'on_track', slope_per_day: 5, projected_value: 100, expected_pct: 50, progress_pct: 50,
      records: 3, current_value: 50, projected_completion: end,
    });
    expect(by.get(atRisk.id)).toMatchObject({ status: 'at_risk', slope_per_day: 4, projected_value: 80 });
    expect(by.get(offTrack.id)).toMatchObject({ status: 'off_track', slope_per_day: 0.2, projected_value: 4 });
    expect(by.get(achieved.id)).toMatchObject({ status: 'achieved', projected_completion: null });
    expect(by.get(noData.id)).toMatchObject({ status: 'no_data', records: 1, slope_per_day: null, projected_value: null });
    expect(by.get(noEnd.id)).toMatchObject({ status: 'on_track', expected_pct: null, projected_value: null });
    for (const r of rows) {
      for (const f of ['target_value', 'current_value', 'progress_pct', 'records']) expect(typeof r[f]).toBe('number');
    }

    // single KPI (even non-active) via the alias
    const [p] = await kpis.kpiForecast(paused.id);
    expect(p).toMatchObject({ kpi_id: paused.id, status: 'off_track' });

    // client mirror gives the same numbers for every KPI
    const all = await kpis.listAllRecords();
    const list = await kpis.listKpis();
    const fc = await kpis.forecastAll(list, all, T);
    const FIELDS = ['status', 'records', 'slope_per_day', 'projected_value', 'projected_completion', 'expected_pct', 'progress_pct', 'current_value'];
    for (const k of list) {
      const local = kpis.forecastLocal(k, all.filter((r) => r.kpi_id === k.id), T);
      const server = by.get(k.id) || p;
      if (server.kpi_id !== k.id) continue;
      for (const f of FIELDS) expect(local[f], `${k.name}.${f}`).toEqual(server[f]);
      expect(fc.get(k.id).status).toBe(server.status);
    }
  });
});

// ---------------------------------------------------------------------------
// dashboard.summary
// ---------------------------------------------------------------------------
describe('dashboard.summary (real DB)', () => {
  let U, cats;
  beforeAll(async () => {
    U = await newUser({ displayName: 'Dash' });
    setClient(U.client);
    cats = await categories.listCategories();
  });
  afterAll(async () => { await deleteUser(U?.user); });

  it('empty account → contract shape with zeros/nulls, all numbers', async () => {
    setClient(U.client);
    const s = await dashboard.summary();
    expect(s.today).toBe(T);
    expect(s.time.running).toBeNull();
    expect(s.money.month_budget).toBeNull();
    expect(s.money.month_remaining).toBeNull();
    expect(s.tasks).toEqual({ open: 0, overdue: 0, due_today: 0, completed_today: 0, completed_this_week: 0 });
    expect(s.kpis).toEqual({ active: 0, on_track: 0, at_risk: 0, off_track: 0 });
    expect(s.shopping).toEqual({ planned_count: 0, planned_total: 0 });
    expect(s.streak).toEqual({ current: 0, longest: 0 });
    expectNumbers(s, '', new Set(['today', 'time.running', 'money.month_budget', 'money.month_remaining']));
  });

  it('every field reflects seeded tasks, timer, expenses, budget, KPIs and shopping', async () => {
    setClient(U.client);
    const workCat = cats.find((c) => c.kind === 'task' && c.name === 'Công việc');
    const food = cats.find((c) => c.kind === 'expense' && c.name === 'Ăn uống');

    // --- tasks
    await tasks.createTask({ title: 'Quá hạn 1', due_date: addDays(T, -1) });
    await tasks.createTask({ title: 'Quá hạn 5', due_date: addDays(T, -5), priority: 'high' });
    const dueToday = await tasks.createTask({ title: 'Hôm nay A', due_date: T, category_id: workCat.id });
    const timed = await tasks.createTask({ title: 'Hôm nay B (timer)', due_date: T });
    await tasks.createTask({ title: 'Ngày mai', due_date: addDays(T, 1) });
    await tasks.createTask({ title: 'Không hạn' });
    const done = await tasks.createTask({ title: 'Xong hôm nay', due_date: T });
    await tasks.setTaskStatus(done.id, 'completed');
    const cancelled = await tasks.createTask({ title: 'Hủy', due_date: addDays(T, -3) });
    await tasks.setTaskStatus(cancelled.id, 'cancelled');

    // backdated completions: yesterday + the day before the week start (never this week)
    const weekStart = addDays(T, -((dow(T) - 1 + 7) % 7)); // profiles.week_starts_on default 1 (Mon)
    const yesterday = addDays(T, -1);
    const lastWeek = addDays(weekStart, -1);
    await insertCompletedTasks(U.user.id, [
      { title: 'Xong hôm qua', completed_at: vnNoon(yesterday) },
      { title: 'Xong tuần trước', completed_at: vnNoon(lastWeek) },
    ]);
    const completedThisWeek = 1 + (yesterday >= weekStart ? 1 : 0);

    // --- time: 30 min finished today + 60 min yesterday + a running timer
    const now = Date.now();
    await timer.logTime({ taskId: dueToday.id, startedAt: new Date(now - 40 * 60000), endedAt: new Date(now - 10 * 60000) });
    const { error: teErr } = await admin.from('time_entries').insert({
      user_id: U.user.id, task_id: dueToday.id, started_at: vnNoon(yesterday, 9), ended_at: vnNoon(yesterday, 10), source: 'manual',
    });
    expect(teErr).toBeNull();
    await timer.start(timed.id, 'đang làm');

    // --- money: today + earlier this month + last month (excluded) + overall budget
    const firstDay = startOfMonth(T);
    await expenses.createExpense({ amount: 100000, category_id: food.id, description: 'cơm', spent_on: T });
    await expenses.createExpense({ amount: 200000, category_id: food.id, description: 'đi chợ', spent_on: firstDay });
    await expenses.createExpense({ amount: 999000, category_id: food.id, description: 'tháng trước', spent_on: addDays(firstDay, -1) });
    await budgets.setBudget({ amount: 1000000, month: startOfMonth(addDays(firstDay, -1)) }); // older carry-forward row
    await budgets.setBudget({ amount: 3000000 });

    // --- KPIs: 2 on_track (one achieved), 1 at_risk, 1 off_track, 1 no_data, 1 paused (ignored)
    const start = addDays(T, -10), end = addDays(T, 10);
    const mk = async (name, values, extra = {}) => {
      const k = await kpis.createKpi({ name, target_value: 100, start_date: start, end_date: end, ...extra });
      const days = [-10, -5, 0];
      for (let i = 0; i < values.length; i++) await kpis.addRecord(k.id, { recorded_on: addDays(T, days[i]), value: values[i] });
    };
    await mk('On', [0, 25, 50]);
    await mk('Done', [50, 100]);
    await mk('Risk', [0, 20, 40]);
    await mk('Off', [0, 1, 2]);
    await mk('Empty', [1]);
    await mk('Paused', [0, 1, 2], { status: 'paused' });

    // --- shopping: planned counted, wishlist not
    await shopping.createItem({ name: 'Sữa', unit_price: 50000, quantity: 2, status: 'planned' });
    await shopping.createItem({ name: 'Tai nghe', unit_price: 900000 });

    const s = await dashboard.summary();
    expect(s.today).toBe(T);
    expect(s.tasks).toEqual({ open: 6, overdue: 2, due_today: 2, completed_today: 1, completed_this_week: completedThisWeek });

    // running timer = timer_current() shape
    expect(s.time.running).toMatchObject({ task_title: 'Hôm nay B (timer)', entry: expect.objectContaining({ task_id: timed.id, ended_at: null }) });
    expect(typeof s.time.running.elapsed_seconds).toBe('number');
    expect(typeof s.time.running.task_total_seconds).toBe('number');
    expect(s.time.today_minutes).toBeGreaterThanOrEqual(30);
    expect(s.time.today_minutes).toBeLessThanOrEqual(31);
    expect(s.time.week_minutes).toBe(s.time.today_minutes + (yesterday >= weekStart ? 60 : 0));
    // start_timer moved the task to in_progress — still open
    expect((await tasks.getTask(timed.id)).status).toBe('in_progress');

    const spent = 300000;
    const dom = Number(T.slice(8, 10));
    expect(s.money).toEqual({
      month_spent: spent,
      month_budget: 3000000,
      month_remaining: 3000000 - spent,
      month_projected: Math.round((spent / dom) * daysInMonth(T) * 100) / 100,
      today_spent: firstDay === T ? spent : 100000,
    });
    expect(s.kpis).toEqual({ active: 5, on_track: 2, at_risk: 1, off_track: 1 });
    expect(s.shopping).toEqual({ planned_count: 1, planned_total: 100000 });

    // streak = streaks() = JS mirror over the same active days
    const st = await dashboard.streaks();
    expect(s.streak).toEqual({ current: st.current, longest: st.longest });
    const active = new Set([T, yesterday, lastWeek]);
    const js = dashboard.streakFrom(active, T, addDays(T, -60));
    expect(st.current).toBe(js.current);
    expect(st.longest).toBe(js.longest);
    expect(st.last_active_day).toBe(T);

    expectNumbers(s, '', new Set(['today', 'time.running']));

    await timer.stop();
    const after = await dashboard.summary();
    expect(after.time.running).toBeNull();
    expect((await tasks.getTask(timed.id)).status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// dashboard.productivity + streaks
// ---------------------------------------------------------------------------
describe('dashboard.productivity / streaks (real DB)', () => {
  let U, workCat;
  const from = addDays(T, -6);
  beforeAll(async () => {
    U = await newUser({ displayName: 'Prod' });
    setClient(U.client);
    workCat = (await categories.listCategories('task')).find((c) => c.name === 'Công việc');

    // completions on -1, -2, -3 (run of 3), -6, and an older run -20..-15 (6 days)
    const rows = [
      { title: 'd-1 trễ', day: -1, due: -2 },
      { title: 'd-2 đúng hạn', day: -2, due: -2 },
      { title: 'd-3 sớm', day: -3, due: -1, category_id: workCat.id },
      { title: 'd-6 không hạn', day: -6 },
    ].map((r) => ({
      title: r.title,
      category_id: r.category_id,
      due_date: r.due == null ? null : addDays(T, r.due),
      completed_at: vnNoon(addDays(T, r.day), 12),
      created_at: vnNoon(addDays(T, r.day), 10), // cycle = 2 h
    }));
    for (let d = -20; d <= -15; d++) rows.push({ title: `old ${d}`, completed_at: vnNoon(addDays(T, d)), created_at: vnNoon(addDays(T, d), 8) });
    await insertCompletedTasks(U.user.id, rows);

    // 20 finished minutes on -4 (task in "Công việc") joins the -1..-3 run → current 4;
    // 10 minutes on -5 is below the 15-minute threshold → not an active day.
    const t = await tasks.createTask({ title: 'Có giờ', category_id: workCat.id });
    const { error } = await admin.from('time_entries').insert([
      { user_id: U.user.id, task_id: t.id, started_at: vnNoon(addDays(T, -4), 9), ended_at: `${addDays(T, -4)}T09:20:00+07:00`, source: 'manual' },
      { user_id: U.user.id, task_id: null, started_at: vnNoon(addDays(T, -5), 9), ended_at: `${addDays(T, -5)}T09:10:00+07:00`, source: 'manual' },
    ]);
    expect(error).toBeNull();
    // created today in range: 'Có giờ' (open) + one cancelled (excluded from the denominator)
    const c = await tasks.createTask({ title: 'Bỏ' });
    await tasks.setTaskStatus(c.id, 'cancelled');
  });
  afterAll(async () => { await deleteUser(U?.user); });

  it('streaks(): consecutive days, yesterday keeps the streak alive, longest older run', async () => {
    setClient(U.client);
    const st = await dashboard.streaks();
    expect(st).toEqual({ current: 4, longest: 6, last_active_day: addDays(T, -1) });
    expect((await dashboard.summary()).streak).toEqual({ current: 4, longest: 6 });
  });

  it('productivity(from, to): 0-filled days, minutes, categories, rates — all numbers', async () => {
    setClient(U.client);
    const p = await dashboard.productivity(from, T);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    expect(p.completed_by_day.map((x) => x.day)).toEqual(days);
    const cnt = Object.fromEntries(p.completed_by_day.map((x) => [x.day, x.count]));
    expect(cnt).toEqual(Object.fromEntries(days.map((d) => [d, [-1, -2, -3, -6].map((n) => addDays(T, n)).includes(d) ? 1 : 0])));
    expect(p.minutes_by_day.map((x) => x.day)).toEqual(days);
    const mins = Object.fromEntries(p.minutes_by_day.map((x) => [x.day, x.minutes]));
    expect(mins[addDays(T, -4)]).toBe(20);
    expect(mins[addDays(T, -5)]).toBe(10);
    expect(p.minutes_by_category).toEqual([
      expect.objectContaining({ category_id: workCat.id, name: 'Công việc', minutes: 20 }),
      expect.objectContaining({ category_id: null, minutes: 10 }),
    ]);
    // created in range: 4 completed (-1,-2,-3,-6) + 'Có giờ' open; cancelled excluded → 4/5
    expect(p.completion_rate).toBe(0.8);
    // with due date: d-1 late, d-2 on the day, d-3 early → 2/3
    expect(p.on_time_rate).toBe(0.6667);
    expect(p.avg_cycle_hours).toBe(2);
    // all completion days tie at 1 → most minutes (none on those days) → smallest weekday
    const expectedWd = Math.min(...[-1, -2, -3, -6].map((n) => dow(addDays(T, n))));
    expect(p.busiest_weekday).toBe(expectedWd);
    for (const x of [...p.completed_by_day, ...p.minutes_by_day]) {
      expect(typeof (x.count ?? x.minutes)).toBe('number');
    }
    for (const f of ['completion_rate', 'on_time_rate', 'avg_cycle_hours', 'busiest_weekday']) expect(typeof p[f]).toBe('number');
  });

  it('productivity on an empty range → nulls, zero-filled', async () => {
    setClient(U.client);
    const d = addDays(T, -100);
    const p = await dashboard.productivity(d, d);
    expect(p).toEqual({
      completed_by_day: [{ day: d, count: 0 }],
      minutes_by_day: [{ day: d, minutes: 0 }],
      minutes_by_category: [],
      completion_rate: null, on_time_rate: null, avg_cycle_hours: null, busiest_weekday: null,
    });
  });

  it('invalid ranges → AppError invalid_input (client and server)', async () => {
    setClient(U.client);
    await expect(dashboard.productivity(T, from)).rejects.toEqual(isAppError('invalid_input'));        // from > to (server)
    await expect(dashboard.productivity(addDays(T, -400), T)).rejects.toEqual(isAppError('invalid_input')); // > 366 days (server)
    await expect(dashboard.productivity('2026-13-01', T)).rejects.toEqual(isAppError('invalid_input'));  // client
    await expect(dashboard.productivity(null, T)).rejects.toEqual(isAppError('invalid_input'));
    const err = await dashboard.productivity(T, from).catch((e) => e);
    expect(err.message).toBe('Dữ liệu không hợp lệ.');
  });
});
