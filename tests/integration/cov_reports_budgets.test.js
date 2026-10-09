// Reports (financeReport, kpiReport, notesReport, productivityReport), budget helpers and
// dashboard burn-down/allowance — real services against the LOCAL Supabase stack.
// Every expected number is computed in this file from the seed, never from the service.
// Calls mirror the UI: src/pages/reports.js (`{from, to, prevFrom, prevTo}`),
// src/pages/expenses.js (status / budgetState / projectMonth / routineRate / oneOffThreshold),
// src/pages/dashboard.js (burnDown / dailyAllowance).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import pg from 'pg';
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import * as reports from '../../src/services/reports.js';
import * as budgets from '../../src/services/budgets.js';
import * as dashboard from '../../src/services/dashboard.js';

// ---------------------------------------------------------------------------
// independent helpers
// ---------------------------------------------------------------------------
const DB_URL = process.env.IT_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const TZ = 'Asia/Ho_Chi_Minh';
const vnDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const dayVN = (iso) => vnDayFmt.format(new Date(iso));
const vn = (day, hm = '12:00', s = '00') => `${day}T${hm}:${s}+07:00`;
const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const addMonths = (d, n) => {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const som = (d) => d.slice(0, 8) + '01';
const daysIn = (d) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const eom = (d) => `${d.slice(0, 8)}${String(daysIn(d)).padStart(2, '0')}`;
const range = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const r2 = (v) => Math.round(v * 100) / 100;
const round = (v, k) => Math.round(v * 10 ** k) / 10 ** k;

async function ins(table, rows) {
  const { data, error } = await admin.from(table).insert(rows, { defaultToNull: false }).select('*');
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

/** Tasks with arbitrary created_at / completed_at (completed_at trigger off — local DB only). */
async function insertTasksRaw(userId, rows) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  const ids = [];
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const r of rows) {
      const { rows: [x] } = await c.query(
        `insert into public.tasks (user_id, title, status, category_id, due_date, completed_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [userId, r.title, r.status, r.category_id || null, r.due_date || null, r.completed_at || null, r.created_at],
      );
      ids.push(x.id);
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
  return ids;
}

// ===========================================================================
// Reports
// ===========================================================================
describe('reports.js — period reports (real DB, Asia/Ho_Chi_Minh)', () => {
  let R, cat = {}, catRow = {};
  const AUG = { from: '2026-08-01', to: '2026-08-31', prevFrom: '2026-07-01', prevTo: '2026-07-31' };
  const CROSS = { from: '2026-07-20', to: '2026-08-10', prevFrom: '2026-06-28', prevTo: '2026-07-19' };

  // [spent_on, amount, category key | null, payment_method, description]
  const EXP = [
    ['2026-06-30', 70000, 'food', 'cash', 'jun30'],
    ['2026-07-01', 100000, 'food', 'cash', 'jul1'],
    ['2026-07-15', 250000, 'transport', 'bank', 'jul15'],
    ['2026-07-31', 80000, 'ent', 'e_wallet', 'jul31-ent'],
    ['2026-07-31', 45000.5, null, 'cash', 'jul31-none'],
    ['2026-08-01', 150000, 'food', 'cash', 'aug1-food'],
    ['2026-08-01', 35000, 'transport', 'e_wallet', 'aug1-tr'],
    ['2026-08-02', 1200000, 'gift', 'credit_card', 'aug2-gift'],
    ['2026-08-05', 60000, 'food', 'cash', 'aug5'],
    ['2026-08-10', 99999.99, null, 'other', 'aug10'],
    ['2026-08-15', 420000, 'transport', 'bank', 'aug15-tr'],
    ['2026-08-15', 420000, 'food', 'bank', 'aug15-food'],
    ['2026-08-20', 75000, 'food', 'cash', 'aug20-a'],
    ['2026-08-20', 15000, 'food', 'cash', 'aug20-b'],
    ['2026-08-25', 300000, 'gift', 'bank', 'aug25'],
    ['2026-08-30', 52000, 'transport', 'cash', 'aug30'],
    ['2026-08-31', 88000, 'food', 'credit_card', 'aug31'],
    ['2026-09-01', 500000, 'food', 'cash', 'sep1'],
  ];
  // [effective_month, category key | null, amount]
  const BUD = [
    ['2026-06-01', null, 10000000],
    ['2026-08-01', null, 12400000],
    ['2026-07-01', 'food', 3100000],
    ['2026-06-01', 'transport', 500000],
    ['2026-08-01', 'transport', 0],
    ['2026-05-01', 'health', 620000],
  ];
  let expRows = [];

  // Tasks: created/completed in VN local time around day boundaries.
  const TASKS = [
    { key: 't1', status: 'completed', cat: 'work', created_at: vn('2026-07-25', '10:00'), completed_at: vn('2026-08-01', '00:30'), due_date: '2026-08-01' },
    { key: 't2', status: 'completed', cat: 'personal', created_at: vn('2026-08-03', '09:00'), completed_at: vn('2026-08-03', '23:30'), due_date: '2026-08-02' },
    { key: 't3', status: 'completed', cat: 'work', created_at: vn('2026-08-10', '08:00'), completed_at: vn('2026-08-12', '08:00') },
    { key: 't4', status: 'completed', cat: null, created_at: vn('2026-07-31', '23:00'), completed_at: vn('2026-07-31', '23:45') },
    { key: 't5', status: 'todo', cat: null, created_at: vn('2026-08-15', '07:00') },
    { key: 't6', status: 'cancelled', cat: null, created_at: vn('2026-08-16', '07:00') },
    { key: 't7', status: 'in_progress', cat: 'personal', created_at: vn('2026-08-20', '07:00') },
    { key: 't8', status: 'completed', cat: null, created_at: vn('2026-08-31', '23:50'), completed_at: vn('2026-09-01', '00:10'), due_date: '2026-08-31' },
    { key: 't9', status: 'todo', cat: null, created_at: vn('2026-08-01', '00:05') },
    { key: 't10', status: 'todo', cat: null, created_at: vn('2026-07-31', '23:55') },
  ];
  const taskId = {};
  // Time entries: [task key | null, start, end | null]
  const ENTRIES = [
    ['t1', vn('2026-08-01', '00:10'), vn('2026-08-01', '00:40')],
    ['t2', vn('2026-08-03', '10:00'), vn('2026-08-03', '11:20')],
    [null, vn('2026-08-03', '14:00'), vn('2026-08-03', '14:45')],
    [null, vn('2026-08-05', '10:00', '00'), vn('2026-08-05', '10:01', '29')],
    ['t3', vn('2026-08-12', '09:00'), vn('2026-08-12', '10:30')],
    ['t4', vn('2026-07-31', '23:30'), vn('2026-07-31', '23:59')],
    ['t7', vn('2026-08-31', '23:30'), vn('2026-09-01', '00:30')],
    ['t7', vn('2026-07-31', '16:00'), vn('2026-08-01', '01:00')], // starts 07-31 → counted on 07-31
    ['t5', vn('2026-08-21', '10:00'), null], // running → ignored
  ];

  const KPI = [
    { key: 'k1', name: 'Doanh số', status: 'active', target_value: 100, created_at: '2026-01-03T00:00:00Z' },
    { key: 'k4', name: 'Chỉ trước kỳ', status: 'active', target_value: 40, created_at: '2026-01-02T00:00:00Z' },
    { key: 'k5', name: 'Chưa ghi', status: 'active', target_value: 7, created_at: '2026-01-01T00:00:00Z' },
    { key: 'k2', name: 'Tạm dừng', status: 'paused', target_value: 50, created_at: '2026-01-04T00:00:00Z' },
    { key: 'k3', name: 'Lưu trữ', status: 'archived', target_value: 10, created_at: '2026-01-05T00:00:00Z' },
  ];
  // [kpi key, recorded_on, value, created_at]
  const REC = [
    ['k1', '2026-06-15', 10, '2026-06-15T01:00:00Z'],
    ['k1', '2026-07-20', 30, '2026-07-20T01:00:00Z'],
    ['k1', '2026-08-05', 50, '2026-08-05T01:00:00Z'],
    ['k1', '2026-08-20', 65, '2026-08-20T01:00:00Z'],
    ['k1', '2026-08-20', 70, '2026-08-20T05:00:00Z'],
    ['k1', '2026-09-05', 90, '2026-09-05T01:00:00Z'],
    ['k4', '2026-07-01', 20, '2026-07-01T01:00:00Z'],
    ['k2', '2026-08-10', 5, '2026-08-10T01:00:00Z'],
    ['k3', '2026-08-10', 3, '2026-08-10T01:00:00Z'],
  ];
  const kpiId = {};

  // [title, created_at, extra]
  const NOTES = [
    ['Aug A', vn('2026-08-01', '00:30'), {}],
    ['Aug B', vn('2026-08-15'), { archived: true }],
    ['Aug C', vn('2026-08-31', '23:59'), {}],
    ['Aug trashed', vn('2026-08-10'), { trashed_at: '2026-08-11T00:00:00Z' }],
    ['Jul A', vn('2026-07-31', '23:30'), {}],
    ['Jul B', vn('2026-07-02'), {}],
    ['Old', vn('2026-01-01'), {}],
    ['Aug D', vn('2026-08-20'), {}],
    ['Aug E', vn('2026-08-21'), {}],
    ['Aug F', vn('2026-08-22'), {}],
  ];

  beforeAll(async () => {
    R = await newUser({ displayName: 'RPT' });
    const uid = R.user.id;
    const { data: cats } = await admin.from('categories').select('*').eq('user_id', uid);
    const pick = (kind, name) => cats.find((c) => c.kind === kind && c.name === name);
    catRow = {
      food: pick('expense', 'Ăn uống'), transport: pick('expense', 'Đi lại'), health: pick('expense', 'Sức khỏe'),
      ent: pick('expense', 'Giải trí'), work: pick('task', 'Công việc'), personal: pick('task', 'Cá nhân'),
    };
    [catRow.gift] = await ins('categories', [{ user_id: uid, kind: 'expense', name: 'Quà tặng', color: '#123456' }]);
    for (const [k, v] of Object.entries(catRow)) cat[k] = v.id;

    expRows = await ins('expenses', EXP.map(([d, a, c, pm, desc]) => ({ user_id: uid, spent_on: d, amount: a, category_id: c ? cat[c] : null, payment_method: pm, description: desc })));
    await ins('budgets', BUD.map(([m, c, a]) => ({ user_id: uid, effective_month: m, category_id: c ? cat[c] : null, amount: a })));

    const tids = await insertTasksRaw(uid, TASKS.map((t) => ({ ...t, title: t.key, category_id: t.cat ? cat[t.cat] : null })));
    TASKS.forEach((t, i) => { taskId[t.key] = tids[i]; });
    await ins('time_entries', ENTRIES.map(([t, s, e]) => ({ user_id: uid, task_id: t ? taskId[t] : null, started_at: s, ended_at: e, source: 'manual' })));

    const ks = await ins('kpis', KPI.map((k) => ({ user_id: uid, name: k.name, status: k.status, target_value: k.target_value, start_date: '2026-01-01', created_at: k.created_at })));
    KPI.forEach((k, i) => { kpiId[k.key] = ks[i].id; });
    await ins('kpi_records', REC.map(([k, d, v, c]) => ({ user_id: uid, kpi_id: kpiId[k], recorded_on: d, value: v, created_at: c })));

    await ins('notes', NOTES.map(([title, created_at, extra]) => ({ user_id: uid, title, content: '', created_at, ...extra })));
    setClient(R.client);
  });
  afterAll(async () => { await deleteUser(R?.user); });

  // ---------------- finance ----------------
  /** Budget of [from, to] = Σ over days of (resolved monthly budget of that day's month) / days in that month. */
  function expectedBudget(from, to) {
    const resolve = (month, key) => {
      const rows = BUD.filter(([m, c]) => m <= month && c === key).sort((a, b) => (a[0] < b[0] ? 1 : -1));
      return rows.length ? rows[0][2] : null;
    };
    let overall = null;
    const byCat = {};
    for (const d of range(from, to)) {
      const m = som(d);
      const o = resolve(m, null);
      if (o != null && o > 0) overall = (overall ?? 0) + o / daysIn(d);
      for (const k of new Set(BUD.map((b) => b[1]).filter(Boolean))) {
        const v = resolve(m, k);
        if (v != null && v > 0) byCat[k] = (byCat[k] ?? 0) + v / daysIn(d);
      }
    }
    return { overall, byCat };
  }

  function expectedFinance({ from, to, prevFrom, prevTo }) {
    const cur = EXP.filter(([d]) => d >= from && d <= to);
    const prev = prevFrom ? EXP.filter(([d]) => d >= prevFrom && d <= prevTo) : [];
    const total = cur.reduce((s, x) => s + x[1], 0);
    const prevTotal = prev.reduce((s, x) => s + x[1], 0);
    const bud = expectedBudget(from, to);
    const keys = new Set([...cur.map((x) => x[2]), ...prev.map((x) => x[2]), ...Object.keys(bud.byCat)]);
    const byCategory = [...keys].map((k) => {
      const t = cur.filter((x) => x[2] === k).reduce((s, x) => s + x[1], 0);
      return {
        category_id: k ? cat[k] : null,
        name: k ? catRow[k].name : null,
        color: k ? catRow[k].color : null,
        total: t,
        count: cur.filter((x) => x[2] === k).length,
        prev_total: prev.filter((x) => x[2] === k).reduce((s, x) => s + x[1], 0),
        budget: bud.byCat[k] ?? null,
        pct: total > 0 ? (t / total) * 100 : 0,
      };
    }).sort((a, b) => b.total - a.total || (b.budget ?? 0) - (a.budget ?? 0));
    const days = range(from, to);
    return {
      total, count: cur.length, daily_avg: total / days.length,
      prev_total: prevTotal, prev_count: prev.length,
      change_pct: prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
      by_category: byCategory,
      by_day: days.map((d) => ({ day: d, total: cur.filter((x) => x[0] === d).reduce((s, x) => s + x[1], 0) })),
      prev_by_day: prevFrom ? range(prevFrom, prevTo).map((d) => ({ day: d, total: prev.filter((x) => x[0] === d).reduce((s, x) => s + x[1], 0) })) : [],
      top: [...cur].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).slice(0, 10),
      budget: { overall: bud.overall, has_any: bud.overall != null || Object.keys(bud.byCat).length > 0 },
      curDescs: cur.map((x) => x[4]).sort(),
    };
  }

  function checkFinance(got, exp) {
    expect(got.total).toBeCloseTo(exp.total, 6);
    expect(got.count).toBe(exp.count);
    expect(got.daily_avg).toBeCloseTo(exp.daily_avg, 6);
    expect(got.prev_total).toBeCloseTo(exp.prev_total, 6);
    expect(got.prev_count).toBe(exp.prev_count);
    if (exp.change_pct == null) expect(got.change_pct).toBeNull();
    else expect(got.change_pct).toBeCloseTo(exp.change_pct, 8);
    expect(got.by_category).toHaveLength(exp.by_category.length);
    got.by_category.forEach((g, i) => {
      const e = exp.by_category[i];
      expect({ id: g.category_id, name: g.name, color: g.color, count: g.count }).toEqual({ id: e.category_id, name: e.name, color: e.color, count: e.count });
      expect(g.total).toBeCloseTo(e.total, 6);
      expect(g.prev_total).toBeCloseTo(e.prev_total, 6);
      expect(g.pct).toBeCloseTo(e.pct, 8);
      if (e.budget == null) expect(g.budget, e.name).toBeNull();
      else expect(g.budget).toBeCloseTo(e.budget, 4);
    });
    expect(got.by_day.map((x) => x.day)).toEqual(exp.by_day.map((x) => x.day));
    got.by_day.forEach((x, i) => expect(x.total).toBeCloseTo(exp.by_day[i].total, 6));
    expect(got.prev_by_day.map((x) => x.day)).toEqual(exp.prev_by_day.map((x) => x.day));
    got.prev_by_day.forEach((x, i) => expect(x.total).toBeCloseTo(exp.prev_by_day[i].total, 6));
    expect(got.top.map((x) => [x.amount, x.spent_on])).toEqual(exp.top.map((x) => [x[1], x[0]]));
    expect(got.top.map((x) => x.description).sort()).toEqual(exp.top.map((x) => x[4]).sort());
    if (exp.budget.overall == null) expect(got.budget.overall).toBeNull();
    else expect(got.budget.overall).toBeCloseTo(exp.budget.overall, 4);
    expect(got.budget.has_any).toBe(exp.budget.has_any);
    expect(got.rows.map((r) => r.description).sort()).toEqual(exp.curDescs);
    for (const r of got.rows) {
      expect(typeof r.amount).toBe('number');
      const src = EXP.find((x) => x[4] === r.description);
      expect(r).toMatchObject({ spent_on: src[0], amount: src[1], payment_method: src[3], category_id: src[2] ? cat[src[2]] : null });
      expect(r.category).toEqual(src[2] ? { name: catRow[src[2]].name, color: catRow[src[2]].color } : null);
    }
  }

  it('financeReport — calendar month vs previous month', async () => {
    const got = await reports.financeReport(AUG);
    const exp = expectedFinance(AUG);
    // Hand-checked anchors for the seed.
    expect(exp.total).toBeCloseTo(2914999.99, 6);
    expect(exp.prev_total).toBeCloseTo(475000.5, 6);
    expect(exp.budget.overall).toBeCloseTo(12400000, 6);
    expect(exp.by_category.map((c) => c.name)).toEqual(['Quà tặng', 'Ăn uống', 'Đi lại', null, 'Sức khỏe', 'Giải trí']);
    checkFinance(got, exp);
    // Zero budget in August for "Đi lại" = no budget; health budget only (no expense) is listed.
    expect(got.by_category.find((c) => c.name === 'Đi lại').budget).toBeNull();
    expect(got.by_category.find((c) => c.name === 'Sức khỏe')).toMatchObject({ total: 0, count: 0, budget: 620000, pct: 0 });
    expect(got.by_category.find((c) => c.name === 'Ăn uống').budget).toBeCloseTo(3100000, 6);
    expect(got.top).toHaveLength(10);
  });

  it('financeReport — custom cross-month range: budgets pro-rated by covered days', async () => {
    const got = await reports.financeReport(CROSS);
    const exp = expectedBudget(CROSS.from, CROSS.to);
    expect(exp.overall).toBeCloseTo((10000000 * 12) / 31 + (12400000 * 10) / 31, 6);
    expect(exp.byCat.food).toBeCloseTo(2200000, 6);
    expect(exp.byCat.health).toBeCloseTo(440000, 6);
    expect(exp.byCat.transport).toBeCloseTo((500000 * 12) / 31, 6);
    checkFinance(got, expectedFinance(CROSS));
  });

  it('financeReport — without a comparison period / empty period', async () => {
    const got = await reports.financeReport({ from: '2026-08-01', to: '2026-08-31' });
    checkFinance(got, expectedFinance({ from: '2026-08-01', to: '2026-08-31' }));
    expect(got).toMatchObject({ prev_total: 0, prev_count: 0, change_pct: null, prev_by_day: [] });
    const empty = await reports.financeReport({ from: '2026-03-01', to: '2026-03-03', prevFrom: '2026-02-26', prevTo: '2026-02-28' });
    expect(empty).toMatchObject({ total: 0, count: 0, daily_avg: 0, prev_total: 0, change_pct: null, top: [], rows: [], budget: { overall: null, has_any: false }, by_category: [] });
    expect(empty.by_day).toEqual([{ day: '2026-03-01', total: 0 }, { day: '2026-03-02', total: 0 }, { day: '2026-03-03', total: 0 }]);
  });

  // ---------------- KPIs ----------------
  it('kpiReport — start/end/change inside the period, archived excluded, forecast from kpi_forecast', async () => {
    const got = await reports.kpiReport(AUG);
    const { data: fc, error } = await R.client.rpc('kpi_forecast', { p_kpi_id: null });
    expect(error).toBeNull();
    const fcBy = new Map((fc || []).map((f) => [f.kpi_id, f]));
    expect(got.map((k) => k.name)).toEqual(['Doanh số', 'Chỉ trước kỳ', 'Chưa ghi', 'Tạm dừng']);
    for (const k of KPI.filter((x) => x.status !== 'archived')) {
      const g = got.find((x) => x.id === kpiId[k.key]);
      const recs = REC.filter((r) => r[0] === k.key).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[3] < b[3] ? -1 : 1));
      const current = recs.length ? recs.at(-1)[2] : 0; // latest overall (DB current_value)
      const upTo = recs.filter((r) => r[1] <= AUG.to);
      const before = upTo.filter((r) => r[1] < AUG.from).at(-1);
      const inside = upTo.filter((r) => r[1] >= AUG.from);
      const end = inside.at(-1) || before;
      const f = fcBy.get(kpiId[k.key]);
      expect(g, k.name).toMatchObject({
        name: k.name, status: k.status, target_value: k.target_value, current_value: current,
        records_in_period: inside.length,
        start_value: before ? before[2] : null,
        end_value: end ? end[2] : null,
        change: inside.length ? (end ? end[2] : 0) - (before ? before[2] : 0) : 0,
        forecast_status: f?.status ?? null,
        projected_value: f?.projected_value == null ? null : Number(f.projected_value),
        projected_completion: f?.projected_completion ?? null,
        expected_pct: f?.expected_pct == null ? null : Number(f.expected_pct),
      });
      expect(g.progress).toBeCloseTo((current / k.target_value) * 100, 10);
    }
    // Hand-checked anchors.
    const k1 = got.find((x) => x.name === 'Doanh số');
    expect(k1).toMatchObject({ records_in_period: 3, start_value: 30, end_value: 70, change: 40, current_value: 90, progress: 90 });
    expect(got.find((x) => x.name === 'Tạm dừng')).toMatchObject({ records_in_period: 1, start_value: null, end_value: 5, change: 5, progress: 10 });
    expect(got.find((x) => x.name === 'Chỉ trước kỳ')).toMatchObject({ records_in_period: 0, start_value: 20, end_value: 20, change: 0, progress: 50 });
    expect(got.find((x) => x.name === 'Chưa ghi')).toMatchObject({ records_in_period: 0, start_value: null, end_value: null, change: 0, progress: 0 });
    // A period before any record: k1's July view.
    const jul = await reports.kpiReport({ from: '2026-06-01', to: '2026-06-30' });
    expect(jul.find((x) => x.name === 'Doanh số')).toMatchObject({ records_in_period: 1, start_value: null, end_value: 10, change: 10 });
  });

  // ---------------- notes ----------------
  it('notesReport — notes created per local day, trash excluded, archived included', async () => {
    const got = await reports.notesReport(AUG);
    const live = NOTES.filter(([, , x]) => !x.trashed_at);
    const inR = (a, b) => live.filter(([, c]) => dayVN(c) >= a && dayVN(c) <= b);
    const cur = inR(AUG.from, AUG.to);
    expect(got.count).toBe(cur.length);
    expect(got.count).toBe(6);
    expect(got.prev).toBe(inR(AUG.prevFrom, AUG.prevTo).length);
    expect(got.prev).toBe(2);
    expect(got.total).toBe(live.length);
    expect(got.by_day).toEqual(range(AUG.from, AUG.to).map((d) => ({ day: d, count: cur.filter(([, c]) => dayVN(c) === d).length })));
    expect(got.by_day[0]).toEqual({ day: '2026-08-01', count: 1 }); // 00:30 VN = previous UTC day
    expect(got.by_day[30]).toEqual({ day: '2026-08-31', count: 1 });
    const latest = [...cur].sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 5).map((n) => n[0]);
    expect(got.latest.map((n) => n.title)).toEqual(latest);
    expect(latest).toEqual(['Aug C', 'Aug F', 'Aug E', 'Aug D', 'Aug B']);
    for (const n of got.latest) expect(Date.parse(n.created_at)).toBe(Date.parse(NOTES.find((x) => x[0] === n.title)[1]));
    const noPrev = await reports.notesReport({ from: AUG.from, to: AUG.to });
    expect(noPrev.prev).toBeNull();
  });

  // ---------------- productivity ----------------
  function expectedProd(from, to, { rpc }) {
    const days = range(from, to);
    const inR = (d) => d >= from && d <= to;
    const done = TASKS.filter((t) => t.status === 'completed' && inR(dayVN(t.completed_at)));
    const secs = Object.fromEntries(days.map((d) => [d, 0]));
    const byCat = new Map();
    for (const [tk, s, e] of ENTRIES) {
      if (!e || !inR(dayVN(s))) continue;
      const sec = (Date.parse(e) - Date.parse(s)) / 1000;
      secs[dayVN(s)] += sec;
      const ck = tk ? TASKS.find((t) => t.key === tk).cat : null;
      byCat.set(ck, (byCat.get(ck) || 0) + sec);
    }
    const cnt = Object.fromEntries(days.map((d) => [d, done.filter((t) => dayVN(t.completed_at) === d).length]));
    const created = TASKS.filter((t) => t.status !== 'cancelled' && inR(dayVN(t.created_at)));
    const withDue = done.filter((t) => t.due_date);
    const cyc = done.map((t) => (Date.parse(t.completed_at) - Date.parse(t.created_at)) / 3600e3);
    const wd = Array.from({ length: 7 }, (_, i) => ({ i, c: 0, s: 0 }));
    days.forEach((d) => { wd[dow(d)].c += cnt[d]; wd[dow(d)].s += secs[d]; });
    const busy = wd.filter((w) => w.c > 0 || w.s > 0).sort((a, b) => b.c - a.c || b.s - a.s || a.i - b.i)[0];
    const rate = (n, d) => (d ? (rpc ? round(n / d, 4) : n / d) : null);
    return {
      completed_by_day: days.map((d) => ({ day: d, count: cnt[d] })),
      minutes_by_day: days.map((d) => ({ day: d, minutes: Math.round(secs[d] / 60) })),
      minutes_by_category: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, s]) => ({
        category_id: k ? cat[k] : null, name: k ? catRow[k].name : null, color: k ? catRow[k].color : null, minutes: Math.round(s / 60),
      })),
      completion_rate: rate(created.filter((t) => t.status === 'completed').length, created.length),
      on_time_rate: rate(withDue.filter((t) => dayVN(t.completed_at) <= t.due_date).length, withDue.length),
      avg_cycle_hours: cyc.length ? round(cyc.reduce((s, h) => s + h, 0) / cyc.length, 1) : null,
      busiest_weekday: busy ? busy.i : null,
    };
  }
  function checkProd(got, exp) {
    expect(got.completed_by_day).toEqual(exp.completed_by_day);
    expect(got.minutes_by_day).toEqual(exp.minutes_by_day);
    expect(got.minutes_by_category).toEqual(exp.minutes_by_category);
    for (const k of ['completion_rate', 'on_time_rate']) {
      if (exp[k] == null) expect(got[k], k).toBeNull();
      else expect(got[k], k).toBeCloseTo(exp[k], 10);
    }
    expect(got.avg_cycle_hours).toBe(exp.avg_cycle_hours);
    expect(got.busiest_weekday).toBe(exp.busiest_weekday);
  }

  it('productivityReport — RPC path for the period and the previous period', async () => {
    const got = await reports.productivityReport(AUG);
    expect(got.cur.source).toBe('rpc');
    expect(got.prev.source).toBe('rpc');
    const cur = expectedProd(AUG.from, AUG.to, { rpc: true });
    const prev = expectedProd(AUG.prevFrom, AUG.prevTo, { rpc: true });
    // Hand-checked anchors (local-day boundaries).
    expect(cur.completed_by_day.filter((x) => x.count).map((x) => x.day)).toEqual(['2026-08-01', '2026-08-03', '2026-08-12']);
    expect(cur.minutes_by_day.filter((x) => x.minutes)).toEqual([
      { day: '2026-08-01', minutes: 30 }, { day: '2026-08-03', minutes: 125 }, { day: '2026-08-05', minutes: 1 },
      { day: '2026-08-12', minutes: 90 }, { day: '2026-08-31', minutes: 60 },
    ]);
    expect(cur.completion_rate).toBe(0.5); // created in Aug (non-cancelled): t2 t3 t5 t7 t8 t9 → completed t2 t3 t8
    expect(cur.on_time_rate).toBe(0.5);
    expect(cur.avg_cycle_hours).toBe(73.7); // (158.5 + 14.5 + 48) / 3
    expect(prev.completed_by_day.find((x) => x.day === '2026-07-31').count).toBe(1);
    expect(prev.minutes_by_day.find((x) => x.day === '2026-07-31').minutes).toBe(29 + 540);
    expect(prev.completion_rate).toBe(round(2 / 3, 4));
    expect(prev.on_time_rate).toBeNull();
    expect(prev.avg_cycle_hours).toBe(0.8);
    checkProd(got.cur, cur);
    checkProd(got.prev, prev);
    const solo = await reports.productivityReport({ from: AUG.from, to: AUG.to });
    expect(solo.prev).toBeNull();
    checkProd(solo.cur, cur);
  });

  it('productivityReport — ranges over 366 days are computed locally with the same numbers', async () => {
    const from = '2025-08-30', to = '2026-08-31'; // 367 days → RPC refuses → local mirror
    const got = await reports.productivityReport({ from, to, prevFrom: '2024-08-28', prevTo: '2025-08-29' });
    expect(got.cur.source).toBe('local');
    expect(got.prev.source).toBe('local');
    checkProd(got.cur, expectedProd(from, to, { rpc: false }));
    checkProd(got.prev, expectedProd('2024-08-28', '2025-08-29', { rpc: false }));
    expect(got.prev.completion_rate).toBeNull();
    expect(got.prev.busiest_weekday).toBeNull();
  });

  it('productivityFor — RPC and local mirror agree on the same range', async () => {
    const viaRpc = await reports.productivityFor('2026-07-01', '2026-08-31');
    expect(viaRpc.source).toBe('rpc');
    const exp = expectedProd('2026-07-01', '2026-08-31', { rpc: false });
    const { computeProductivity } = reports;
    const { data: tasks } = await R.client.from('tasks').select('id, status, due_date, created_at, completed_at');
    const { data: entries } = await R.client.from('time_entries')
      .select('id, task_id, started_at, ended_at, duration_seconds, task:tasks(category_id, category:categories(id, name, color))');
    const local = computeProductivity(tasks, entries, '2026-07-01', '2026-08-31');
    checkProd(local, exp);
    checkProd({ ...viaRpc, completion_rate: exp.completion_rate, on_time_rate: exp.on_time_rate }, exp);
    // RPC rounds rates to 4 decimals, the local mirror does not.
    expect(viaRpc.completion_rate).toBeCloseTo(exp.completion_rate, 4);
  });
});

// ===========================================================================
// Budgets — pure helpers vs real budget_status()
// ===========================================================================
describe('budgets.js — budgetState / projectMonth / routineRate / oneOffThreshold', () => {
  let U, cat = {};
  const T = todayVN();
  const CM = som(T), PM = addMonths(CM, -1), FM = addMonths(CM, 1);
  const D = daysIn(CM);
  const elapsed = Number(T.slice(8));
  let items = []; // { spent_on, amount, category_id }

  beforeAll(async () => {
    U = await newUser({ displayName: 'BUD' });
    const uid = U.user.id;
    const { data: cats } = await admin.from('categories').select('*').eq('user_id', uid).eq('kind', 'expense');
    const pick = (name) => cats.find((c) => c.name === name).id;
    Object.assign(cat, { food: pick('Ăn uống'), transport: pick('Đi lại'), health: pick('Sức khỏe'), ent: pick('Giải trí'), study: pick('Học tập') });
    const [g] = await ins('categories', [{ user_id: uid, kind: 'expense', name: 'Quà tặng', color: '#123456' }]);
    cat.gift = g.id;
    setClient(U.client);
    // Budgets set from the previous month on (carry forward) — exactly as the Expenses page does.
    await budgets.setBudget({ amount: 5000000, month: PM });
    await budgets.setBudget({ amount: 1000000, categoryId: cat.food, month: PM });
    await budgets.setBudget({ amount: 100000, categoryId: cat.transport, month: PM });
    await budgets.setBudget({ amount: 0, categoryId: cat.health, month: PM });
    await budgets.setBudget({ amount: 0, categoryId: cat.ent, month: PM });
    await budgets.setBudget({ amount: 10000.1, categoryId: cat.study, month: PM });
    // Transport: spent < 80 % but the linear projection exceeds the budget (when the month is young enough).
    const trCur = elapsed / D < 0.75 ? Math.floor((100000 * elapsed) / D + 1000) : 10000;
    const seed = [
      [addDays(PM, 4), 800000, 'food'], [addDays(PM, 4), 150000, 'transport'], [addDays(PM, 4), 50000, 'gift'],
      [addDays(PM, 4), 30000, 'health'], [addDays(PM, 4), 8000.08, 'study'],
      [CM, 100000, 'food'], [T, 50000, 'food'], [T, 10000, 'gift'], [T, trCur, 'transport'],
      [addDays(FM, 4), 200000, 'food'],
    ];
    const rows = await ins('expenses', seed.map(([d, a, c]) => ({ user_id: uid, spent_on: d, amount: a, category_id: cat[c], payment_method: 'cash' })));
    items = rows.map((r) => ({ spent_on: r.spent_on, amount: Number(r.amount), category_id: r.category_id }));
  });
  afterAll(async () => { await deleteUser(U?.user); });

  const spentOf = (m, catId) => r2(items.filter((x) => som(x.spent_on) === m && (catId === undefined || x.category_id === catId)).reduce((s, x) => s + x.amount, 0));
  const budgetOf = (catId) => ({ undefined: 5000000, [cat.food]: 1000000, [cat.transport]: 100000, [cat.health]: 0, [cat.ent]: 0, [cat.study]: 10000.1 }[catId] ?? null);
  const rowCat = (row) => (row.category_id == null ? undefined : row.category_id);
  const mine = (catId) => items.filter((x) => catId === undefined || x.category_id === catId);

  async function checkMonth(m, kind) {
    setClient(U.client);
    const rows = await budgets.status(m);
    // Overall + every category with a budget or spending in that month.
    const expectedCats = new Set([cat.food, cat.transport, cat.health, cat.ent, cat.study, ...items.filter((x) => som(x.spent_on) === m).map((x) => x.category_id)]);
    expect(rows[0].category_id).toBeNull();
    expect(new Set(rows.slice(1).map((r) => r.category_id))).toEqual(expectedCats);
    for (const row of rows) {
      const c = rowCat(row);
      const spent = spentOf(m, c);
      const budget = budgetOf(c);
      expect(row.spent, `${kind} spent ${row.category_name}`).toBeCloseTo(spent, 6);
      expect(row.budget).toBe(budget);
      const proj = kind === 'past' ? spent : kind === 'future' ? 0 : r2((spent * D) / elapsed);
      expect(row.projected, `${kind} projected ${row.category_name}`).toBeCloseTo(proj, 2);
      // Pure helper: same rule as SQL on the same inputs (study = 80 % with cents → see it.fails below).
      if (c !== cat.study) expect(budgets.budgetState(row.budget, row.spent, row.projected), `${kind} ${row.category_name}`).toBe(row.status);
      // projectMonth: past → actual; future → planned; current (no future-dated rows, no one-offs) → linear.
      const pm = budgets.projectMonth(mine(c), { month: m, today: T });
      if (kind === 'future') expect(pm).toBeCloseTo(spent, 6);
      else expect(pm, `${kind} projectMonth ${row.category_name}`).toBeCloseTo(row.projected, 1);
    }
    return rows;
  }

  it('previous month: over / warning (80 %) / ok / no_budget / zero budget', async () => {
    const rows = await checkMonth(PM, 'past');
    const st = (id) => rows.find((r) => r.category_id === id).status;
    expect(rows[0].status).toBe('ok');
    expect(st(cat.food)).toBe('warning'); // exactly 80 %
    expect(st(cat.transport)).toBe('over');
    expect(st(cat.gift)).toBe('no_budget');
    expect(st(cat.health)).toBe('over'); // zero budget + spending
    expect(st(cat.ent)).toBe('ok'); // zero budget, nothing spent
    expect(budgets.budgetState(1000000, 800000, 800000)).toBe('warning');
    expect(budgets.budgetState(100000, 150000, 150000)).toBe('over');
    expect(budgets.budgetState(null, 50000, 50000)).toBe('no_budget');
    expect(budgets.budgetState(0, 30000, 30000)).toBe('over');
    expect(budgets.budgetState(0, 0, 0)).toBe('ok');
    expect(budgets.budgetState('1000', '1000', '1000')).toBe('warning'); // strings (numeric columns) coerced
    expect(budgets.budgetState(1000, null, null)).toBe('ok');
  });

  it('current month: linear projection, carry-forward budgets; status(null) = status(current month)', async () => {
    const rows = await checkMonth(CM, 'current');
    expect(await budgets.status(null)).toEqual(rows);
    expect(await budgets.budgetStatus()).toEqual(rows);
    const tr = rows.find((r) => r.category_id === cat.transport);
    if (elapsed / D < 0.75) {
      expect(tr.spent / tr.budget).toBeLessThan(0.8);
      expect(tr.status).toBe('warning'); // projected over budget
      expect(budgets.budgetState(tr.budget, tr.spent, tr.projected)).toBe('warning');
      expect(budgets.budgetState(tr.budget, tr.spent, 0)).toBe('ok');
    }
  });

  it('next month: future-dated (planned) spending only, SQL projection 0', async () => {
    const rows = await checkMonth(FM, 'future');
    expect(rows.find((r) => r.category_id === cat.food)).toMatchObject({ spent: 200000, budget: 1000000, status: 'ok', projected: 0 });
  });

  // Regression: float division (8000.08 / 10000.10 = 0.7999999999999999) used to say 'ok'
  // where SQL budget_status's exact `spent >= budget * 0.8` says 'warning'.
  it('budgetState matches budget_status exactly at 80 % with cents', async () => {
    setClient(U.client);
    const rows = await budgets.status(PM);
    const st = rows.find((r) => r.category_id === cat.study);
    expect(st).toMatchObject({ budget: 10000.1, spent: 8000.08, status: 'warning' });
    expect(budgets.budgetState(st.budget, st.spent, st.projected)).toBe('warning');
  });

  it('oneOffThreshold — Infinity on thin history, else max(p90, 5 × median)', () => {
    expect(budgets.oneOffThreshold()).toBe(Infinity);
    expect(budgets.oneOffThreshold(null)).toBe(Infinity);
    expect(budgets.oneOffThreshold(Array.from({ length: 9 }, () => ({ amount: 100 })))).toBe(Infinity);
    // zero / negative / non-numeric amounts do not count towards the 10 needed
    expect(budgets.oneOffThreshold([...Array.from({ length: 9 }, () => ({ amount: 100 })), { amount: 0 }, { amount: -5 }, { amount: 'x' }])).toBe(Infinity);
    const ten = Array.from({ length: 10 }, (_, i) => ({ amount: (i + 1) * 1000 })); // sorted a[8]=9000, a[4]=5000
    expect(budgets.oneOffThreshold(ten)).toBe(25000);
    const rent = [...Array.from({ length: 19 }, () => ({ amount: '50000' })), { amount: 6500000 }];
    expect(budgets.oneOffThreshold(rent)).toBe(250000);
    const wide = Array.from({ length: 11 }, (_, i) => ({ amount: i === 10 ? 1e6 : 10 + i })); // p90 = a[9] = 19, 5×median = 75
    expect(budgets.oneOffThreshold(wide)).toBe(75);
    const p90 = Array.from({ length: 10 }, (_, i) => ({ amount: i < 8 ? 10 : 1000 })); // p90 = a[8] = 1000 > 5×10
    expect(budgets.oneOffThreshold(p90)).toBe(1000);
  });

  it('projectMonth — one-offs counted once, base rate damping, before/after/last day', () => {
    const m = '2026-10-01';
    const its = [
      ...range('2026-10-01', '2026-10-05').map((d) => ({ spent_on: d, amount: 50000 })),
      { spent_on: '2026-10-02', amount: 6500000 }, // rent
      { spent_on: '2026-10-20', amount: 100000 }, // planned
      { spent_on: '2026-09-30', amount: 999999 }, { spent_on: '2026-11-01', amount: 999999 }, // other months
    ];
    // elapsed 5, left 26
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-05', threshold: 250000 })).toBe(6850000 + 50000 * 26);
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-05', threshold: 250000, baseRate: 40000 }))
      .toBe(r2(6850000 + ((250000 + 40000 * 7) / 12) * 26));
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-05', threshold: 250000, baseRate: 40000, weight: 0 })).toBe(6850000 + 50000 * 26);
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-05', threshold: 250000, baseRate: -1 })).toBe(6850000 + 50000 * 26);
    // no threshold → the rent is extrapolated (plain linear on what happened so far)
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-05' })).toBe(r2(6850000 + (6750000 / 5) * 26));
    // month given mid-month string is normalised
    expect(budgets.projectMonth(its, { month: '2026-10-17', today: '2026-10-05', threshold: 250000 })).toBe(6850000 + 50000 * 26);
    // before the month / on its last day / after it → what is recorded
    expect(budgets.projectMonth(its, { month: m, today: '2026-09-30', threshold: 250000 })).toBe(6850000);
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-31', threshold: 250000 })).toBe(6850000);
    expect(budgets.projectMonth(its, { month: m, today: '2026-11-15' })).toBe(6850000);
    // first day: elapsed 1, left 30
    expect(budgets.projectMonth(its, { month: m, today: '2026-10-01', threshold: 250000 })).toBe(6850000 + 50000 * 30);
    expect(budgets.projectMonth([], { month: m, today: '2026-10-05' })).toBe(0);
    expect(budgets.projectMonth(null, { month: m, today: '2026-10-05' })).toBe(0);
    // February (28 days), 2028 leap year (29)
    expect(budgets.projectMonth([{ spent_on: '2027-02-01', amount: 100 }], { month: '2027-02-01', today: '2027-02-01' })).toBe(2800);
    expect(budgets.projectMonth([{ spent_on: '2028-02-01', amount: 100 }], { month: '2028-02-01', today: '2028-02-01' })).toBe(2900);
    // default month = today's month
    expect(budgets.projectMonth([{ spent_on: '2026-10-01', amount: 310 }], { today: '2026-10-01' })).toBe(9610);
  });

  it('routineRate — routine spend per day before the month, null when history is short', () => {
    const m = '2026-10-01';
    const sept = range('2026-09-01', '2026-09-30').map((d) => ({ spent_on: d, amount: 10000 }));
    expect(budgets.routineRate([...sept, { spent_on: '2026-09-02', amount: 6500000 }], { month: m, threshold: 250000 })).toBe(10000);
    // without threshold the one-off counts: (300000 + 6500000) / 30
    expect(budgets.routineRate([...sept, { spent_on: '2026-09-02', amount: 6500000 }], { month: m })).toBeCloseTo(6800000 / 30, 8);
    // items in / after the month are ignored
    expect(budgets.routineRate([...sept, { spent_on: '2026-10-01', amount: 1e9 }], { month: m })).toBe(10000);
    // 13-day span → null; 14 → rate
    expect(budgets.routineRate(range('2026-09-18', '2026-09-30').map((d) => ({ spent_on: d, amount: 1 })), { month: m })).toBeNull();
    expect(budgets.routineRate(range('2026-09-17', '2026-09-30').map((d) => ({ spent_on: d, amount: 7 })), { month: m })).toBe(7);
    expect(budgets.routineRate([], { month: m })).toBeNull();
    expect(budgets.routineRate(null, { month: m })).toBeNull();
    // long history → only the last 56 days: 2026-08-06..09-30
    const long = range('2026-06-01', '2026-09-30').map((d) => ({ spent_on: d, amount: d < '2026-08-06' ? 1e6 : 560 }));
    expect(budgets.routineRate(long, { month: m })).toBe(560);
    expect(budgets.routineRate(long, { month: m, days: 30 })).toBe(560);
    // sparse history: oldest 20 days back, two items → total / 20
    expect(budgets.routineRate([{ spent_on: '2026-09-11', amount: 300 }, { spent_on: '2026-09-25', amount: 100 }], { month: '2026-10-15' })).toBe(20);
  });

  it('UI forecast path (expenses.js) on real rows: threshold + baseRate + projectMonth', () => {
    // Same composition as src/pages/expenses.js forecast(), on the 10 seeded rows.
    const learn = [...items].sort((a, b) => (a.spent_on < b.spent_on ? 1 : -1));
    const threshold = budgets.oneOffThreshold(learn);
    const sorted = items.map((x) => x.amount).sort((a, b) => a - b);
    expect(sorted).toHaveLength(10);
    const expThreshold = Math.max(sorted[8], sorted[4] * 5);
    expect(threshold).toBe(expThreshold);
    const baseRate = budgets.routineRate(learn, { month: CM, threshold });
    // history before CM starts at PM+4 → span = days from PM+4 to CM
    const span = Math.min(56, Math.round((Date.parse(CM) - Date.parse(addDays(PM, 4))) / 864e5));
    const before = items.filter((x) => x.spent_on < CM && x.amount < expThreshold).reduce((s, x) => s + x.amount, 0);
    if (span < 14) expect(baseRate).toBeNull();
    else expect(baseRate).toBeCloseTo(before / span, 8);
    const f = budgets.projectMonth(items, { month: CM, today: T, threshold, baseRate });
    const spent = spentOf(CM);
    const routine = items.filter((x) => som(x.spent_on) === CM && x.spent_on <= T && x.amount < expThreshold).reduce((s, x) => s + x.amount, 0);
    const left = D - elapsed;
    const rate = baseRate != null ? (routine + baseRate * 7) / (elapsed + 7) : routine / elapsed;
    expect(f).toBeCloseTo(T >= eom(CM) ? spent : spent + rate * left, 1);
  });
});

// ===========================================================================
// Dashboard — burnDown / dailyAllowance
// ===========================================================================
describe('dashboard.js — burnDown / dailyAllowance', () => {
  it('burnDown — February, mid-month today, budget ideal line', () => {
    const byDay = { '2026-02-01': 100, '2026-02-10': '50', '2026-02-11': 999, '2026-01-31': 500 };
    const b = dashboard.burnDown({ byDay, month: '2026-02-01', budget: 2800, today: '2026-02-10' });
    expect(b.days).toEqual(range('2026-02-01', '2026-02-28'));
    expect(b.total).toBe(28);
    expect(b.elapsed).toBe(10);
    expect(b.actual).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 150, ...Array(18).fill(null)]);
    expect(b.spent).toBe(150);
    expect(b.ideal).toEqual(Array.from({ length: 28 }, (_, i) => 100 * (i + 1)));
    expect(b.projected).toEqual([...Array(9).fill(null), ...Array.from({ length: 19 }, (_, i) => Math.round(15 * (i + 10)))]);
    expect(b.projectedTotal).toBe(420);
  });

  it('burnDown — leap February, 31-day month end, month normalisation, no budget', () => {
    expect(dashboard.burnDown({ month: '2028-02-15', today: '2028-02-29' }).days).toHaveLength(29);
    const d = dashboard.burnDown({ byDay: { '2026-12-31': 3100 }, month: '2026-12-17', budget: 0, today: '2026-12-31' });
    expect(d.days[0]).toBe('2026-12-01');
    expect(d.days.at(-1)).toBe('2026-12-31');
    expect(d).toMatchObject({ total: 31, elapsed: 31, spent: 3100, projectedTotal: 3100, ideal: null });
    expect(d.actual.at(-1)).toBe(3100);
    expect(d.actual.at(-2)).toBe(0);
    expect(d.projected.slice(0, 30).every((v) => v === null)).toBe(true);
    expect(d.projected.at(-1)).toBe(3100);
    expect(dashboard.burnDown({ month: '2026-04-01', budget: null, today: '2026-04-02' }).ideal).toBeNull();
    expect(dashboard.burnDown({ month: '2026-04-01', budget: -5, today: '2026-04-02' }).ideal).toBeNull();
    expect(dashboard.burnDown({ month: '2026-04-01', today: '2026-04-02' }).days).toHaveLength(30);
  });

  it('burnDown — today before / after the month, or unknown', () => {
    const byDay = { '2026-03-05': 310, '2026-03-31': 0.5 };
    const before = dashboard.burnDown({ byDay, month: '2026-03-01', budget: 3100, today: '2026-02-28' });
    expect(before.actual.every((v) => v === null)).toBe(true);
    expect(before).toMatchObject({ elapsed: 0, spent: 0, projectedTotal: 0 });
    expect(before.projected.every((v) => v === 0)).toBe(true);
    const after = dashboard.burnDown({ byDay, month: '2026-03-01', budget: 3100, today: '2026-04-10' });
    expect(after.elapsed).toBe(31);
    expect(after.actual.at(-1)).toBe(310.5);
    expect(after.actual[3]).toBe(0);
    expect(after.actual[4]).toBe(310);
    expect(after.projected.slice(0, 30).every((v) => v === null)).toBe(true);
    expect(after.projectedTotal).toBe(311);
    const none = dashboard.burnDown({ byDay, month: '2026-03-01' });
    expect(none.elapsed).toBe(31);
    expect(none.spent).toBe(310.5);
    expect(none.actual.every((v) => v !== null)).toBe(true);
  });

  it('dailyAllowance — budget left (excluding today) over remaining days incl. today', () => {
    const base = { budget: 3100000, monthSpent: 1000000, todaySpent: 100000, today: '2026-10-09', monthEnd: '2026-10-31' };
    expect(dashboard.dailyAllowance(base)).toBeCloseTo(2200000 / 23, 8);
    expect(dashboard.dailyAllowance({ ...base, today: '2026-10-31' })).toBe(2200000);
    expect(dashboard.dailyAllowance({ ...base, today: '2026-10-01' })).toBeCloseTo(2200000 / 31, 8);
    expect(dashboard.dailyAllowance({ ...base, today: '2026-11-02' })).toBe(2200000); // past month end → 1 day
    expect(dashboard.dailyAllowance({ ...base, monthSpent: 5000000, todaySpent: 0 })).toBe(0); // overspent
    expect(dashboard.dailyAllowance({ ...base, monthSpent: undefined, todaySpent: undefined })).toBeCloseTo(3100000 / 23, 8);
    expect(dashboard.dailyAllowance({ ...base, budget: null })).toBeNull();
    expect(dashboard.dailyAllowance({ ...base, budget: 0 })).toBeNull();
    expect(dashboard.dailyAllowance({ ...base, budget: -1 })).toBeNull();
    expect(dashboard.dailyAllowance({ ...base, today: null })).toBeNull();
    expect(dashboard.dailyAllowance({ ...base, monthEnd: undefined })).toBeNull();
    expect(dashboard.dailyAllowance({ budget: 2900, today: '2028-02-01', monthEnd: '2028-02-29' })).toBe(100);
  });

  describe('against real data (current month, as the Dashboard page derives it)', () => {
    let U;
    const T = todayVN(), M = som(T), E = eom(T);
    beforeAll(async () => {
      U = await newUser({ displayName: 'DASH' });
      setClient(U.client);
      await budgets.setBudget({ amount: 3000000 });
      const rows = [[M, 120000], [T, 45000], [T, 5000.5]];
      if (T > M) rows.push([addDays(T, -1), 77000]);
      await ins('expenses', rows.map(([d, a]) => ({ user_id: U.user.id, spent_on: d, amount: a })));
    });
    afterAll(async () => { await deleteUser(U?.user); });

    it('burnDown.spent / dailyAllowance agree with budget_status and the seed', async () => {
      setClient(U.client);
      const { data: exps } = await U.client.from('expenses').select('spent_on, amount').gte('spent_on', M).lte('spent_on', E);
      const spendBy = {};
      exps.forEach((x) => { spendBy[x.spent_on] = (spendBy[x.spent_on] || 0) + Number(x.amount); });
      const monthSpent = exps.reduce((s, x) => s + Number(x.amount), 0);
      const todaySpent = spendBy[T] || 0;
      const [overall] = await budgets.status(null);
      expect(overall).toMatchObject({ category_id: null, budget: 3000000 });
      const burn = dashboard.burnDown({ byDay: spendBy, month: M, budget: overall.budget, today: T });
      expect(burn.spent).toBeCloseTo(overall.spent, 6);
      expect(burn.elapsed).toBe(Number(T.slice(8)));
      expect(burn.total).toBe(daysIn(T));
      expect(burn.projectedTotal).toBe(Math.round(overall.projected));
      const allowance = dashboard.dailyAllowance({ budget: overall.budget, monthSpent, todaySpent, today: T, monthEnd: E });
      expect(todaySpent).toBeCloseTo(50000.5, 6);
      expect(allowance).toBeCloseTo((3000000 - (monthSpent - 50000.5)) / (daysIn(T) - Number(T.slice(8)) + 1), 6);
    });
  });
});
