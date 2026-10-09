// Smart library end-to-end: pure JS parsers/scorers fed with and checked against the
// REAL database (services → PostgREST → SQL triggers/RPCs on the local stack).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, todayVN } from './env.js';
import { parseTaskInput, parseExpenseInput, suggestCategory, focusScore, buildInsights, REASON_ORDER } from '../../src/services/smart/index.js';
import * as tasks from '../../src/services/tasks.js';
import * as categories from '../../src/services/categories.js';
import * as expenses from '../../src/services/expenses.js';
import * as budgets from '../../src/services/budgets.js';
import * as kpis from '../../src/services/kpis.js';
import * as dashboard from '../../src/services/dashboard.js';

const T = todayVN();
const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

// ---------------------------------------------------------------------------
// quick-add → createTask → recurrence spawn
// ---------------------------------------------------------------------------
describe('smart quick-add task → DB → recurrence', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Quick' }); setClient(U.client); });
  afterAll(async () => { await deleteUser(U?.user); });

  it("'Họp team thứ 6 !gấp 30p #work @công việc mỗi tuần' round-trips and spawns next week", async () => {
    setClient(U.client);
    const cats = await categories.listCategories(); // both kinds, straight from the DB
    const work = cats.find((c) => c.kind === 'task' && c.name === 'Công việc');

    const parsed = parseTaskInput('Họp team thứ 6 !gấp 30p #work @công việc mỗi tuần', { today: T, categories: cats });
    // next Friday strictly after today
    const friday = addDays(T, ((5 - dow(T) + 7) % 7) || 7);
    expect(parsed).toEqual({
      title: 'Họp team', due_date: friday, priority: 'urgent', tags: ['work'],
      estimated_minutes: 30, category_id: work.id, recurrence: 'weekly',
    });

    const created = await tasks.createTask(parsed);
    const { data: row, error } = await admin.from('tasks').select('*').eq('id', created.id).single();
    expect(error).toBeNull();
    expect(row).toMatchObject({
      user_id: U.user.id, title: 'Họp team', due_date: friday, priority: 'urgent', tags: ['work'],
      estimated_minutes: 30, category_id: work.id, recurrence: 'weekly', status: 'todo', recurrence_parent_id: null,
    });
    expect(created.category).toMatchObject({ id: work.id, name: 'Công việc' });

    await tasks.setTaskStatus(created.id, 'completed');
    const { data: series } = await admin.from('tasks').select('*').eq('user_id', U.user.id).order('due_date');
    expect(series).toHaveLength(2);
    const next = series.find((t) => t.id !== created.id);
    expect(next).toMatchObject({
      title: 'Họp team', status: 'todo', due_date: addDays(friday, 7), priority: 'urgent', tags: ['work'],
      estimated_minutes: 30, category_id: work.id, recurrence: 'weekly', recurrence_parent_id: created.id,
      completed_at: null,
    });

    // reopen + complete again → no duplicate
    await tasks.setTaskStatus(created.id, 'todo');
    await tasks.setTaskStatus(created.id, 'completed');
    const { count } = await admin.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', U.user.id);
    expect(count).toBe(2);

    // completing the spawned one continues the same series (+7 again)
    await tasks.setTaskStatus(next.id, 'completed');
    const { data: s3 } = await admin.from('tasks').select('due_date, recurrence_parent_id, status').eq('user_id', U.user.id).eq('status', 'todo');
    expect(s3).toEqual([{ due_date: addDays(friday, 14), recurrence_parent_id: created.id, status: 'todo' }]);
  });
});

// ---------------------------------------------------------------------------
// expense quick entry → createExpense → spending summary / dashboard
// ---------------------------------------------------------------------------
describe('smart expense quick entry → DB → summaries', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Exp' }); setClient(U.client); });
  afterAll(async () => { await deleteUser(U?.user); });

  it("'cà phê 35k hôm qua momo' is stored as 35 000 yesterday via e-wallet", async () => {
    setClient(U.client);
    const yesterday = addDays(T, -1);
    const parsed = parseExpenseInput('cà phê 35k hôm qua momo', { today: T });
    expect(parsed).toEqual({ amount: 35000, description: 'cà phê', spent_on: yesterday, payment_method: 'e_wallet' });

    const expCats = await categories.listCategories('expense');
    const [top] = suggestCategory(parsed.description, { history: [], categories: expCats });
    const food = expCats.find((c) => c.name === 'Ăn uống');
    expect(top).toMatchObject({ category_id: food.id, source: 'keywords' });

    const e = await expenses.createExpense({ ...parsed, category_id: top.category_id });
    expect(e).toMatchObject({ amount: 35000, spent_on: yesterday, payment_method: 'e_wallet', description: 'cà phê', category: { name: 'Ăn uống' } });

    const sum = await expenses.summary(yesterday, yesterday);
    expect(sum.total).toBe(35000);
    expect(sum.count).toBe(1);
    expect(sum.by_day).toEqual([{ day: yesterday, total: 35000 }]);
    expect(sum.by_payment_method).toEqual([expect.objectContaining({ method: 'e_wallet', total: 35000 })]);
    expect(sum.by_category).toEqual([expect.objectContaining({ category_id: food.id, total: 35000, count: 1 })]);
    expect((await expenses.summary(T, T)).total).toBe(0);

    const dash = await dashboard.summary();
    expect(dash.money.today_spent).toBe(0);
    expect(dash.money.month_spent).toBe(yesterday.slice(0, 7) === T.slice(0, 7) ? 35000 : 0);
  });
});

// ---------------------------------------------------------------------------
// suggestCategory (JS, history from DB) vs RPC suggest_expense_category
// ---------------------------------------------------------------------------
describe('suggestCategory JS vs SQL suggest_expense_category', () => {
  let U, cats, by;
  beforeAll(async () => {
    U = await newUser({ displayName: 'Cat' });
    setClient(U.client);
    cats = await categories.listCategories('expense');
    by = Object.fromEntries(cats.map((c) => [c.name, c.id]));
    const seed = [
      // this user files coffee with friends under "Giải trí" (overrides the keyword dictionary)
      ['cà phê với bạn', 'Giải trí'], ['cà phê bạn bè', 'Giải trí'], ['cà phê cuối tuần bạn', 'Giải trí'],
      ['đổ xăng xe máy', 'Đi lại'], ['xăng xe máy', 'Đi lại'], ['thay nhớt xe máy', 'Đi lại'],
      ['phở bò', 'Ăn uống'], ['bún bò huế', 'Ăn uống'],
      ['tiền điện tháng', 'Nhà ở'], ['internet fpt', 'Nhà ở'],
      ['khóa học tiếng anh', 'Học tập'],
    ];
    for (let i = 0; i < seed.length; i++) {
      await expenses.createExpense({ amount: 50000 + i * 1000, description: seed[i][0], category_id: by[seed[i][1]], spent_on: addDays(T, -(i + 1)) });
    }
  });
  afterAll(async () => { await deleteUser(U?.user); });

  it.each([
    ['cà phê với bạn', 'Giải trí'],
    ['xăng xe máy', 'Đi lại'],
    ['bún bò', 'Ăn uống'],
    ['tiền điện', 'Nhà ở'],
    ['khóa học online', 'Học tập'],
  ])('%s → %s (both engines agree on top-1)', async (text, expected) => {
    setClient(U.client);
    const history = (await expenses.listRecent()).map((h) => ({ description: h.description, category_id: h.category_id }));
    expect(history).toHaveLength(11);
    const js = suggestCategory(text, { history, categories: cats });
    const sql = await expenses.suggestCategory(text);
    expect(js[0]?.category_id, `JS ${JSON.stringify(js)}`).toBe(by[expected]);
    expect(sql[0]?.category_id, `SQL ${JSON.stringify(sql)}`).toBe(by[expected]);
    expect(sql[0].name).toBe(expected);
    for (const r of [...js, ...sql]) {
      expect(typeof r.confidence).toBe('number');
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
    expect(js.length).toBeLessThanOrEqual(3);
    expect(sql.length).toBeLessThanOrEqual(3);
  });

  it('no shared history → SQL empty, JS falls back to keywords', async () => {
    setClient(U.client);
    const history = await expenses.listRecent();
    expect(await expenses.suggestCategory('netflix')).toEqual([]);
    const js = suggestCategory('netflix', { history, categories: cats });
    expect(js[0]).toMatchObject({ category_id: by['Giải trí'], source: 'keywords' });
  });
});

// ---------------------------------------------------------------------------
// focusScore (JS) vs SQL focus_tasks on the same rows
// ---------------------------------------------------------------------------
describe('focusScore JS equals SQL focus_tasks', () => {
  let U;
  beforeAll(async () => { U = await newUser({ displayName: 'Focus' }); setClient(U.client); });
  afterAll(async () => { await deleteUser(U?.user); });

  it('same score and reasons for every open task', async () => {
    setClient(U.client);
    const specs = [
      { title: 'urgent overdue 15d', priority: 'urgent', due_date: addDays(T, -15) },
      { title: 'high overdue 2d quick', priority: 'high', due_date: addDays(T, -2), estimated_minutes: 30 },
      { title: 'medium today', priority: 'medium', due_date: T },
      { title: 'low tomorrow in_progress', priority: 'low', due_date: addDays(T, 1), status: 'in_progress' },
      { title: 'medium +3', due_date: addDays(T, 3), estimated_minutes: 31 },
      { title: 'high +6 zero-est', priority: 'high', due_date: addDays(T, 6), estimated_minutes: 0 },
      { title: 'urgent +8', priority: 'urgent', due_date: addDays(T, 8) },
      { title: 'no due stale', priority: 'low', stale: 20 },
      { title: 'no due 14d (not stale)', stale: 14 },
      { title: 'completed (excluded)', status: 'completed', due_date: T },
      { title: 'cancelled (excluded)', status: 'cancelled', due_date: addDays(T, -1) },
    ];
    for (const { stale, status, ...s } of specs) {
      const t = await tasks.createTask(s);
      if (status) await tasks.setTaskStatus(t.id, status);
      if (stale) {
        const { error } = await admin.from('tasks').update({ created_at: `${addDays(T, -stale)}T12:00:00+07:00` }).eq('id', t.id);
        expect(error).toBeNull();
      }
    }

    const ranked = await tasks.focusTasks(50);
    const rows = await tasks.listTasks({});
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(ranked).toHaveLength(9);
    for (const r of ranked) {
      const task = byId.get(r.task_id);
      const js = focusScore(task, T);
      expect(typeof r.score).toBe('number');
      expect({ title: task.title, score: js.score, reasons: js.reasons }).toEqual({ title: r.title, score: r.score, reasons: r.reasons });
      // canonical reason order
      const idx = r.reasons.map((x) => REASON_ORDER.indexOf(x));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
    // excluded statuses score 0 in JS too
    for (const t of rows.filter((x) => !['todo', 'in_progress'].includes(x.status))) expect(focusScore(t, T)).toEqual({ score: 0, reasons: [] });
    // JS ranking reproduces SQL ordering (score desc)
    const jsOrder = ranked.map((r) => focusScore(byId.get(r.task_id), T).score);
    expect(jsOrder).toEqual([...jsOrder].sort((a, b) => b - a));
    expect(ranked[0].title).toBe('urgent overdue 15d');
    expect(ranked[0].score).toBe(40 + 50);
  });
});

// ---------------------------------------------------------------------------
// buildInsights fed with real service outputs
// ---------------------------------------------------------------------------
describe('buildInsights with real dashboard/budget/KPI/anomaly/productivity outputs', () => {
  let U, by;
  beforeAll(async () => {
    U = await newUser({ displayName: 'Insight' });
    setClient(U.client);
    const cats = await categories.listCategories('expense');
    by = Object.fromEntries(cats.map((c) => [c.name, c.id]));
  });
  afterAll(async () => { await deleteUser(U?.user); });

  const validate = (list) => {
    expect(Array.isArray(list)).toBe(true);
    const RANK = { critical: 0, warning: 1, success: 2, info: 3 };
    let prev = -1;
    for (const x of list) {
      expect(Object.keys(x).sort()).toEqual(expect.arrayContaining(['id', 'severity', 'title', 'detail']));
      expect(typeof x.id).toBe('string');
      expect(Object.keys(RANK)).toContain(x.severity);
      expect(typeof x.title).toBe('string');
      expect(typeof x.detail).toBe('string');
      expect(x.title.length).toBeGreaterThan(0);
      expect(x.detail.length).toBeGreaterThan(0);
      expect(`${x.title} ${x.detail}`).toMatch(VI);
      expect(`${x.title} ${x.detail}`).not.toMatch(/NaN|undefined|null|\[object/);
      if (x.action) expect(x.action).toEqual({ label: expect.any(String), route: expect.stringMatching(/^#\//) });
      expect(RANK[x.severity]).toBeGreaterThanOrEqual(prev);
      prev = RANK[x.severity];
      expect('rank' in x || 'i' in x).toBe(false);
    }
    expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
  };

  const gather = async () => {
    const [summary, bs, kp, an, prod, spending] = await Promise.all([
      dashboard.summary(), budgets.status(), kpis.progress(), expenses.anomalies(30),
      dashboard.productivity(addDays(T, -29), T), expenses.summary(addDays(T, -29), T),
    ]);
    return { summary, budgets: bs, kpis: kp, anomalies: an, productivity: prod, spending };
  };

  it('empty account → valid (possibly empty) list, no throw', async () => {
    setClient(U.client);
    const input = await gather();
    const list = buildInsights(input);
    validate(list);
    expect(list).toEqual([]);
  });

  it('overspent month + category, overdue tasks, off-track KPI, anomaly → critical/warning insights', async () => {
    setClient(U.client);
    // anomaly history: 5 normal meals 31–60 days ago (always an earlier month)
    const hist = [28000, 30000, 30000, 31000, 32000];
    for (let i = 0; i < hist.length; i++) {
      await expenses.createExpense({ amount: hist[i], category_id: by['Ăn uống'], description: 'cơm trưa', spent_on: addDays(T, -(31 + i * 7)) });
    }
    // this month: 500k dinner (anomaly, over the food budget), total over the monthly budget
    const big = await expenses.createExpense({ amount: 500000, category_id: by['Ăn uống'], description: 'tiệc nhà hàng', spent_on: T });
    await expenses.createExpense({ amount: 120000, category_id: by['Đi lại'], description: 'grab', spent_on: T });
    await budgets.setBudget({ amount: 400000 });
    await budgets.setBudget({ amount: 200000, categoryId: by['Ăn uống'] });
    await budgets.setBudget({ amount: 1000000, categoryId: by['Đi lại'] });

    // 2 overdue tasks
    await tasks.createTask({ title: 'Trễ 1', due_date: addDays(T, -2) });
    await tasks.createTask({ title: 'Trễ 2', due_date: addDays(T, -1) });
    // an off-track KPI
    const k = await kpis.createKpi({ name: 'Đọc sách', unit: 'cuốn', target_value: 100, start_date: addDays(T, -10), end_date: addDays(T, 10) });
    for (const [d, v] of [[-10, 0], [-5, 1], [0, 2]]) await kpis.addRecord(k.id, { recorded_on: addDays(T, d), value: v });

    const input = await gather();
    // sanity on the raw shapes buildInsights relies on
    expect(input.budgets.find((r) => r.category_id == null)).toMatchObject({ budget: 400000, spent: 620000, status: 'over' });
    expect(input.budgets.find((r) => r.category_id === by['Ăn uống'])).toMatchObject({ category_name: 'Ăn uống', budget: 200000, spent: 500000, status: 'over' });
    expect(input.anomalies).toEqual([expect.objectContaining({ expense_id: big.id, amount: 500000, baseline: 30000, category_name: 'Ăn uống', spent_on: T })]);
    expect(input.kpis).toEqual([expect.objectContaining({ kpi_id: k.id, name: 'Đọc sách', status: 'off_track', progress_pct: 2, expected_pct: 50 })]);
    expect(input.summary.money).toMatchObject({ month_spent: 620000, month_budget: 400000 });

    const list = buildInsights({ ...input, limit: 20 });
    validate(list);
    const ids = new Map(list.map((x) => [x.id, x]));

    const total = ids.get('budget_over_total');
    expect(total).toMatchObject({ severity: 'critical', title: 'Đã vượt ngân sách tháng' });
    expect(total.detail).toMatch(/620\.000.*400\.000.*220\.000/);
    expect(ids.get(`budget_over_${by['Ăn uống']}`)).toMatchObject({ severity: 'critical', title: 'Vượt ngân sách Ăn uống' });
    expect(ids.has(`budget_over_${by['Đi lại']}`)).toBe(false);
    expect(ids.get('tasks_overdue')).toMatchObject({ severity: 'warning', title: '2 công việc quá hạn' });
    const kpiIns = ids.get(`kpi_off_track_${k.id}`);
    expect(kpiIns).toMatchObject({ severity: 'warning', title: 'KPI "Đọc sách" đang chệch mục tiêu' });
    expect(kpiIns.detail).toBe('Tiến độ 2% trong khi thời gian đã trôi 50%.');
    const an = ids.get(`anomaly_${big.id}`);
    expect(an).toMatchObject({ severity: 'warning' });
    expect(an.title).toMatch(/tiệc nhà hàng/);
    expect(an.detail).toMatch(/16,7 lần/); // 500k / 30k baseline
    expect(list[0].severity).toBe('critical');

    // default limit = 6, still valid & critical first
    const top = buildInsights(input);
    validate(top);
    expect(top.length).toBeLessThanOrEqual(6);
    expect(top.slice(0, 2).map((x) => x.severity)).toEqual(['critical', 'critical']);

    // summary-only path (no budget_status rows): money block drives the total insight
    const fromSummary = buildInsights({ summary: input.summary });
    validate(fromSummary);
    expect(fromSummary.find((x) => x.id === 'budget_over_total')?.severity).toBe('critical');
  });

  it('near-budget month → warning (not critical)', async () => {
    setClient(U.client);
    await budgets.setBudget({ amount: 700000 }); // 620k / 700k = 88.6 %
    const input = await gather();
    const list = buildInsights({ ...input, limit: 20 });
    validate(list);
    const ids = new Set(list.map((x) => x.id));
    expect(ids.has('budget_over_total')).toBe(false);
    const w = list.find((x) => x.id === 'budget_warning_total' || x.id === 'budget_projected_total');
    expect(w?.severity).toBe('warning');
  });
});
