// Finance service layer against the REAL local Supabase stack
// (expenses / budgets / shopping / CSV export / RLS).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { admin, newUser, deleteUser, todayVN } from './env.js';
import * as expenses from '../../src/services/expenses.js';
import * as budgets from '../../src/services/budgets.js';
import * as shopping from '../../src/services/shopping.js';
import * as reports from '../../src/services/reports.js';
import * as categories from '../../src/services/categories.js';
import { AppError } from '../../src/services/errors.js';

// ---------------------------------------------------------------- helpers
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Await a promise expected to reject with AppError(code). */
async function expectCode(p, code) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected AppError(${code})`).toBeInstanceOf(AppError);
  expect(err.code).toBe(code);
  expect(typeof err.message).toBe('string');
  expect(err.message).not.toMatch(/violates|constraint|PGRST|SQLSTATE/i);
  return err;
}

async function expenseCats() {
  const list = await categories.listCategories('expense');
  return Object.fromEntries(list.map((c) => [c.name, c.id]));
}

async function adminInsert(table, rows) {
  const { data, error } = await admin.from(table).insert(rows).select('id');
  if (error) throw error;
  return data;
}

// ======================================================================
describe('expenses: CRUD, filters, normalisation, validation', () => {
  let A; let cats;
  beforeAll(async () => { A = await newUser(); setClient(A.client); cats = await expenseCats(); });
  afterAll(async () => { await deleteUser(A?.user); });

  let e1; let e2; let e3; let e4;
  it('create returns numeric amount and embedded category', async () => {
    setClient(A.client);
    e1 = await expenses.createExpense({ amount: '12345.67', category_id: cats['Ăn uống'], description: 'Cà phê, sữa (50%) "đặc biệt"', spent_on: '2025-03-01', payment_method: 'cash', note: ' ' });
    expect(typeof e1.amount).toBe('number');
    expect(e1.amount).toBe(12345.67);
    expect(e1.category).toMatchObject({ id: cats['Ăn uống'], name: 'Ăn uống' });
    expect(e1.note).toBeNull(); // whitespace-only → null
    e2 = await expenses.createExpense({ amount: 500, category_id: cats['Đi lại'], description: 'Grab 500', spent_on: '2025-03-05', payment_method: 'e_wallet' });
    e3 = await expenses.createExpense({ amount: 200000, description: 'a_b underscore', spent_on: '2025-03-10', payment_method: 'bank', note: 'note với dấu phẩy, chấm.' });
    e4 = await expenses.createExpense({ amount: 99, category_id: cats['Ăn uống'], description: 'axb plain', spent_on: '2025-02-27', payment_method: 'credit_card' });
    expect(e3.category).toBeNull();
  });

  it('update / delete', async () => {
    const u = await expenses.updateExpense(e2.id, { amount: '750.5', note: 'sửa' });
    expect(u.amount).toBe(750.5);
    expect(u.note).toBe('sửa');
    expect(u.description).toBe('Grab 500');
    const tmp = await expenses.createExpense({ amount: 1, spent_on: '2025-03-02' });
    expect(tmp.payment_method).toBe('cash');
    await expenses.deleteExpense(tmp.id);
    const all = await expenses.listExpenses({});
    expect(all.map((x) => x.id)).not.toContain(tmp.id);
    expect(all).toHaveLength(4);
    all.forEach((x) => expect(typeof x.amount).toBe('number'));
    // newest spent_on first
    expect(all.map((x) => x.spent_on)).toEqual(['2025-03-10', '2025-03-05', '2025-03-01', '2025-02-27']);
  });

  it('update/delete of a missing id', async () => {
    await expectCode(expenses.updateExpense('00000000-0000-0000-0000-000000000000', { amount: 1 }), 'not_found');
  });

  it('filters: date range', async () => {
    const r = await expenses.listExpenses({ from: '2025-03-01', to: '2025-03-05' });
    expect(r.map((x) => x.id).sort()).toEqual([e1.id, e2.id].sort());
    expect((await expenses.listExpenses({ from: '2025-03-06' })).map((x) => x.id)).toEqual([e3.id]);
    expect((await expenses.listExpenses({ to: '2025-02-28' })).map((x) => x.id)).toEqual([e4.id]);
    await expectCode(expenses.listExpenses({ from: '2025-02-30' }), 'invalid_input');
  });

  it('filters: category (id and "none")', async () => {
    const r = await expenses.listExpenses({ categoryId: cats['Ăn uống'] });
    expect(r.map((x) => x.id).sort()).toEqual([e1.id, e4.id].sort());
    expect((await expenses.listExpenses({ categoryId: 'none' })).map((x) => x.id)).toEqual([e3.id]);
  });

  it('filters: payment method (single and array)', async () => {
    expect((await expenses.listExpenses({ paymentMethod: 'e_wallet' })).map((x) => x.id)).toEqual([e2.id]);
    const r = await expenses.listExpenses({ paymentMethod: ['bank', 'credit_card'] });
    expect(r.map((x) => x.id).sort()).toEqual([e3.id, e4.id].sort());
    expect(await expenses.listExpenses({ paymentMethod: [] })).toHaveLength(4);
  });

  it('filters: min / max amount (inclusive, string input ok)', async () => {
    expect((await expenses.listExpenses({ minAmount: 12345.67 })).map((x) => x.id).sort()).toEqual([e1.id, e3.id].sort());
    expect((await expenses.listExpenses({ maxAmount: '750.5' })).map((x) => x.id).sort()).toEqual([e2.id, e4.id].sort());
    expect((await expenses.listExpenses({ minAmount: 100, maxAmount: 20000 })).map((x) => x.id).sort()).toEqual([e1.id, e2.id].sort());
    await expectCode(expenses.listExpenses({ minAmount: 'abc' }), 'invalid_input');
  });

  it('filters: search with special characters is literal', async () => {
    const ids = async (s) => (await expenses.listExpenses({ search: s })).map((x) => x.id).sort();
    expect(await ids('50%')).toEqual([e1.id]);           // % literal (would match e2 "500" otherwise)
    expect(await ids('a_b')).toEqual([e3.id]);           // _ literal (would match "axb")
    expect(await ids('sữa (50%)')).toEqual([e1.id]);     // parentheses
    expect(await ids('"đặc biệt"')).toEqual([e1.id]);    // double quotes
    expect(await ids('Cà phê, sữa')).toEqual([e1.id]);   // comma
    expect(await ids('CÀ PHÊ')).toEqual([e1.id]);        // case-insensitive (ilike)
    expect(await ids('dấu phẩy, chấm.')).toEqual([e3.id]); // matches note
    expect(await ids('grab')).toEqual([e2.id]);
    expect(await ids('\\')).toEqual([]);
    expect(await ids('   ')).toHaveLength(4);
    expect(await ids('không-có-gì')).toEqual([]);
  });

  it('validation errors map to invalid_input before reaching the DB', async () => {
    await expectCode(expenses.createExpense({ amount: 0, spent_on: '2025-03-01' }), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: -5 }), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: 'abc' }), 'invalid_input');
    await expectCode(expenses.createExpense({}), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: 1e13 }), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: 1, spent_on: '2025-02-30' }), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: 1, payment_method: 'bitcoin' }), 'invalid_input');
    await expectCode(expenses.createExpense({ amount: 1, description: 'x'.repeat(201) }), 'invalid_input');
    await expectCode(expenses.updateExpense(e1.id, {}), 'invalid_input');
    await expectCode(expenses.updateExpense(e1.id, { user_id: A.user.id }), 'invalid_input'); // non-whitelisted only
    const err = await expectCode(expenses.createExpense({ amount: 1, category_id: '00000000-0000-0000-0000-000000000000' }), 'invalid_reference');
    expect(err.cause).toBeTruthy();
  });

  it('task category on an expense is rejected by the DB', async () => {
    const taskCat = (await categories.listCategories('task'))[0];
    let err;
    try { await expenses.createExpense({ amount: 1, category_id: taskCat.id }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect(['invalid_input', 'invalid_reference', 'forbidden']).toContain(err.code);
  });

  it('getExpensesByIds / listRecent', async () => {
    const got = await expenses.getExpensesByIds([e1.id, e2.id, e1.id, null]);
    expect(got.map((x) => x.id).sort()).toEqual([e1.id, e2.id].sort());
    expect(typeof got[0].amount).toBe('number');
    expect(await expenses.getExpensesByIds([])).toEqual([]);
    const recent = await expenses.listRecent({ days: 3660 });
    expect(recent.length).toBe(4);
  });
});

// ======================================================================
describe('expenses: summary / anomalies / suggestCategory', () => {
  let A; let cats;
  beforeAll(async () => { A = await newUser(); setClient(A.client); cats = await expenseCats(); });
  afterAll(async () => { await deleteUser(A?.user); });

  it('summary totals, zero-filled by_day, breakdowns and previous period', async () => {
    setClient(A.client);
    await expenses.createExpense({ amount: 100.25, category_id: cats['Ăn uống'], spent_on: '2025-05-02', payment_method: 'cash' });
    await expenses.createExpense({ amount: 300, category_id: cats['Ăn uống'], spent_on: '2025-05-02', payment_method: 'bank' });
    await expenses.createExpense({ amount: 599.75, category_id: cats['Đi lại'], spent_on: '2025-05-05', payment_method: 'bank' });
    await expenses.createExpense({ amount: 50, spent_on: '2025-05-07', payment_method: 'cash' }); // uncategorised
    await expenses.createExpense({ amount: 525, spent_on: '2025-04-30' }); // previous period (Apr 24–30)
    await expenses.createExpense({ amount: 9999, spent_on: '2025-04-23' }); // outside both

    const s = await expenses.summary('2025-05-01', '2025-05-07');
    expect(s.total).toBe(1050);
    expect(s.count).toBe(4);
    expect(s.daily_avg).toBe(150);
    expect(s.prev_total).toBe(525);
    expect(s.change_pct).toBe(100);
    expect(s.by_day).toHaveLength(7);
    expect(s.by_day.map((d) => d.day)).toEqual(['2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', '2025-05-06', '2025-05-07']);
    expect(s.by_day.map((d) => d.total)).toEqual([0, 400.25, 0, 0, 599.75, 0, 50]);
    s.by_day.forEach((d) => expect(typeof d.total).toBe('number'));
    expect(s.by_category[0]).toMatchObject({ category_id: cats['Đi lại'], total: 599.75, count: 1 });
    const food = s.by_category.find((c) => c.category_id === cats['Ăn uống']);
    expect(food).toMatchObject({ name: 'Ăn uống', total: 400.25, count: 2, pct: 38.1 });
    expect(s.by_category.find((c) => c.category_id == null)).toMatchObject({ total: 50, count: 1 });
    expect(s.by_payment_method).toEqual([{ method: 'bank', total: 899.75 }, { method: 'cash', total: 150.25 }]);
  });

  it('summary: empty range → zeros, change_pct null; bad range → invalid_input', async () => {
    const s = await expenses.summary('2024-01-01', '2024-01-03');
    expect(s).toMatchObject({ total: 0, count: 0, daily_avg: 0, prev_total: 0, change_pct: null, by_category: [], by_payment_method: [] });
    expect(s.by_day).toEqual([{ day: '2024-01-01', total: 0 }, { day: '2024-01-02', total: 0 }, { day: '2024-01-03', total: 0 }]);
    await expectCode(expenses.summary('2025-05-07', '2025-05-01'), 'invalid_input');
    await expectCode(expenses.summary('2024-01-01', '2025-06-01'), 'invalid_input'); // > 366 days
    await expectCode(expenses.summary(null, '2025-05-01'), 'invalid_input');
  });

  it('anomalies: none on normal data, one true positive on an outlier', async () => {
    const t = todayVN();
    const uid = A.user.id;
    // 12 history samples per category, 40–95 days ago (before the 30-day window)
    const hist = [];
    const base = [95000, 100000, 105000, 98000, 102000, 99000, 101000, 97000, 103000, 100000, 96000, 104000];
    base.forEach((amt, i) => {
      hist.push({ user_id: uid, amount: amt, category_id: cats['Ăn uống'], spent_on: addDays(t, -40 - i * 5), description: 'cơm trưa' });
      hist.push({ user_id: uid, amount: amt / 2, category_id: cats['Đi lại'], spent_on: addDays(t, -40 - i * 5), description: 'xe buýt' });
    });
    await adminInsert('expenses', hist);
    // normal in-window spending
    await adminInsert('expenses', [
      { user_id: uid, amount: 110000, category_id: cats['Ăn uống'], spent_on: addDays(t, -3), description: 'cơm trưa' },
      { user_id: uid, amount: 52000, category_id: cats['Đi lại'], spent_on: addDays(t, -2), description: 'xe buýt' },
    ]);
    expect(await expenses.anomalies(30)).toEqual([]);

    const [out] = await adminInsert('expenses', [
      { user_id: uid, amount: 1500000, category_id: cats['Ăn uống'], spent_on: addDays(t, -1), description: 'tiệc' },
    ]);
    const list = await expenses.anomalies(30);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ expense_id: out.id, amount: 1500000, category_id: cats['Ăn uống'], category_name: 'Ăn uống', reason: 'high_vs_category', baseline: 100000 });
    expect(typeof list[0].z_score).toBe('number');
    expect(list[0].z_score).toBeGreaterThanOrEqual(3.5);
    // a 1-day window excludes yesterday's outlier
    expect(await expenses.anomalies(1)).toEqual([]);
    await expectCode(expenses.anomalies(0), 'invalid_input');
    await expectCode(expenses.anomalies(400), 'invalid_input');
  });

  it('suggestCategory learns from history (with/without diacritics)', async () => {
    const B = await newUser();
    try {
      setClient(B.client);
      const c = await expenseCats();
      const t = todayVN();
      const rows = [
        ['Cà phê sáng', 'Ăn uống'], ['Cà phê Highlands', 'Ăn uống'], ['cafe phê đá', 'Ăn uống'],
        ['Grab đi làm', 'Đi lại'], ['Grab về nhà', 'Đi lại'],
        ['Tiền điện tháng', 'Nhà ở'],
      ].map(([d, cat]) => ({ user_id: B.user.id, amount: 10000, category_id: c[cat], description: d, spent_on: t }));
      await adminInsert('expenses', rows);

      const s1 = await expenses.suggestCategory('cà phê sữa');
      expect(s1[0]).toMatchObject({ category_id: c['Ăn uống'], name: 'Ăn uống' });
      expect(typeof s1[0].confidence).toBe('number');
      expect(s1[0].confidence).toBe(1);
      const s2 = await expenses.suggestCategory('ca phe');           // no diacritics
      expect(s2[0]?.category_id).toBe(c['Ăn uống']);
      const s3 = await expenses.suggestCategory('CÀ PHÊ');           // upper-case Vietnamese
      expect(s3[0]?.category_id).toBe(c['Ăn uống']);
      const s4 = await expenses.suggestCategory('cà phê'); // decomposed (NFD) input
      expect(s4[0]?.category_id).toBe(c['Ăn uống']);
      const s5 = await expenses.suggestCategory('grab sân bay');
      expect(s5[0]?.category_id).toBe(c['Đi lại']);
      const s6 = await expenses.suggestCategory('tien dien');
      expect(s6[0]?.category_id).toBe(c['Nhà ở']);
      const mixed = await expenses.suggestCategory('grab cà phê');
      expect(mixed.length).toBe(2);
      expect(mixed[0].category_id).toBe(c['Ăn uống']); // 3 votes vs 2
      expect(mixed.reduce((a, x) => a + x.confidence, 0)).toBeCloseTo(1, 1);
      expect(await expenses.suggestCategory('xyz qwe')).toEqual([]);
      expect(await expenses.suggestCategory('a')).toEqual([]);
      // other users' history is never used
      setClient(A.client);
      expect(await expenses.suggestCategory('grab')).toEqual([]);
    } finally {
      setClient(A.client);
      await deleteUser(B.user);
    }
  });
});

// ======================================================================
describe('budgets', () => {
  let A; let cats;
  beforeAll(async () => { A = await newUser(); setClient(A.client); cats = await expenseCats(); });
  afterAll(async () => { await deleteUser(A?.user); });

  it('setBudget overall + category (RPC set_budget), upsert, numeric amount', async () => {
    setClient(A.client);
    const o = await budgets.setBudget({ amount: '1000', month: '2025-01' });
    expect(o).toMatchObject({ effective_month: '2025-01-01', category_id: null, amount: 1000 });
    const o2 = await budgets.setBudget({ amount: 1200, month: '2025-01-01' }); // upsert same month
    expect(o2.id).toBe(o.id);
    expect(o2.amount).toBe(1200);
    for (const name of ['Ăn uống', 'Đi lại', 'Nhà ở']) {
      const r = await budgets.setBudget({ amount: 100, categoryId: cats[name], month: '2025-01' });
      expect(r).toMatchObject({ category_id: cats[name], amount: 100 });
    }
    const list = await budgets.listBudgets();
    expect(list).toHaveLength(4);
    list.forEach((b) => expect(typeof b.amount).toBe('number'));
  });

  it('setBudget validation', async () => {
    await expectCode(budgets.setBudget({ amount: -1 }), 'invalid_input');
    await expectCode(budgets.setBudget({}), 'invalid_input');
    await expectCode(budgets.setBudget({ amount: 1, month: '2025-01-15' }), 'invalid_input');
    await expectCode(budgets.setBudget({ amount: 1, month: '2025-13' }), 'invalid_input');
    const taskCat = (await categories.listCategories('task'))[0];
    await expectCode(budgets.setBudget({ amount: 1, categoryId: taskCat.id, month: '2025-01' }), 'invalid_input');
    await expectCode(budgets.setBudget({ amount: 1, categoryId: '00000000-0000-0000-0000-000000000000', month: '2025-01' }), 'not_found');
  });

  it('carry-forward to later months + status ok / warning / over / no_budget', async () => {
    // Spending in February (closed month → projected = spent)
    await expenses.createExpense({ amount: 50, category_id: cats['Ăn uống'], spent_on: '2025-02-03' });  // 50%  ok
    await expenses.createExpense({ amount: 85, category_id: cats['Đi lại'], spent_on: '2025-02-10' });   // 85%  warning
    await expenses.createExpense({ amount: 150, category_id: cats['Nhà ở'], spent_on: '2025-02-20' });   // 150% over
    await expenses.createExpense({ amount: 30, category_id: cats['Giải trí'], spent_on: '2025-02-21' }); // no budget
    await expenses.createExpense({ amount: 15, spent_on: '2025-02-22' });                                // uncategorised

    const st = await budgets.status('2025-02');
    const by = (id) => st.find((r) => r.category_id === id);
    const overall = by(null);
    expect(overall).toMatchObject({ budget: 1200, spent: 330, remaining: 870, used_pct: 27.5, projected: 330, status: 'ok' });
    expect(st[0].category_id).toBeNull(); // overall row first
    expect(by(cats['Ăn uống'])).toMatchObject({ budget: 100, spent: 50, remaining: 50, used_pct: 50, status: 'ok', category_name: 'Ăn uống' });
    expect(by(cats['Đi lại'])).toMatchObject({ budget: 100, spent: 85, status: 'warning' });
    expect(by(cats['Nhà ở'])).toMatchObject({ budget: 100, spent: 150, remaining: -50, used_pct: 150, status: 'over' });
    expect(by(cats['Giải trí'])).toMatchObject({ budget: null, spent: 30, status: 'no_budget' });
    st.forEach((r) => { expect(typeof r.spent).toBe('number'); expect(typeof r.projected).toBe('number'); });

    // January has budgets but no spending; December 2024 nothing applies
    const jan = await budgets.status('2025-01-01');
    expect(jan.find((r) => r.category_id === null)).toMatchObject({ budget: 1200, spent: 0, status: 'ok' });
    expect(await budgets.status('2024-12')).toEqual([]);

    // A new overall row from April on; March still carries January's
    await budgets.setBudget({ amount: 2000, month: '2025-04' });
    expect((await budgets.status('2025-03')).find((r) => r.category_id === null).budget).toBe(1200);
    expect((await budgets.status('2025-06')).find((r) => r.category_id === null).budget).toBe(2000);
    // future month: projected 0
    const future = await budgets.status('2099-01');
    expect(future.find((r) => r.category_id === null)).toMatchObject({ budget: 2000, spent: 0, projected: 0 });
    await expectCode(budgets.status('2025-02-15'), 'invalid_input');
  });

  it('status() defaults to the current month', async () => {
    const m = todayVN().slice(0, 7);
    await expenses.createExpense({ amount: 10, category_id: cats['Ăn uống'], spent_on: todayVN() });
    const cur = await budgets.status();
    const explicit = await budgets.status(m);
    expect(cur).toEqual(explicit);
    expect(cur.find((r) => r.category_id === cats['Ăn uống'])).toMatchObject({ budget: 100, spent: 10 });
  });

  it('resolveBudgets mirrors carry-forward; deleteBudget', async () => {
    const rows = await budgets.listBudgets();
    const feb = budgets.resolveBudgets(rows, '2025-02-01');
    expect(feb.overall).toBe(1200);
    expect(feb.byCategory.get(cats['Ăn uống'])).toBe(100);
    expect(feb.byCategory.size).toBe(3);
    expect(budgets.resolveBudgets(rows, '2025-05-01').overall).toBe(2000);
    expect(budgets.resolveBudgets(rows, '2024-12-01')).toEqual({ overall: null, byCategory: new Map() });

    const apr = rows.find((r) => r.effective_month === '2025-04-01');
    await budgets.deleteBudget(apr.id);
    const after = await budgets.listBudgets();
    expect(after.map((r) => r.id)).not.toContain(apr.id);
    expect((await budgets.status('2025-06')).find((r) => r.category_id === null).budget).toBe(1200);
    // amount 0 = "no budget from now on" → over as soon as anything is spent
    await budgets.setBudget({ amount: 0, categoryId: cats['Ăn uống'], month: '2025-02' });
    expect((await budgets.status('2025-02')).find((r) => r.category_id === cats['Ăn uống'])).toMatchObject({ budget: 0, status: 'over', used_pct: null });
  });
});

// ======================================================================
describe('shopping', () => {
  let A; let cats;
  beforeAll(async () => { A = await newUser(); setClient(A.client); cats = await expenseCats(); });
  afterAll(async () => { await deleteUser(A?.user); });

  let item; let item2;
  it('CRUD + total_price generated + numeric normalisation', async () => {
    setClient(A.client);
    item = await shopping.createItem({ name: 'Bàn phím cơ', category_id: cats['Công nghệ'], unit_price: '1250000.5', quantity: 2, priority: 'high', status: 'planned', url: 'https://example.com/kb' });
    expect(item).toMatchObject({ unit_price: 1250000.5, quantity: 2, total_price: 2500001, status: 'planned', expense_id: null });
    expect(item.category?.name).toBe('Công nghệ');
    item2 = await shopping.createItem({ name: 'Tai nghe (100%) mới' });
    expect(item2).toMatchObject({ status: 'wishlist', priority: 'medium', unit_price: 0, quantity: 1, total_price: 0 });
    const u = await shopping.updateItem(item2.id, { unit_price: 300000, note: 'giảm giá' });
    expect(u.total_price).toBe(300000);
    const tmp = await shopping.createItem({ name: 'tạm' });
    await shopping.deleteItem(tmp.id);

    const all = await shopping.listItems();
    expect(all.map((x) => x.id).sort()).toEqual([item.id, item2.id].sort());
    expect((await shopping.listShopping({ status: 'planned' })).map((x) => x.id)).toEqual([item.id]);
    expect((await shopping.listItems({ status: ['planned', 'wishlist'] }))).toHaveLength(2);
    expect((await shopping.listItems({ categoryId: 'none' })).map((x) => x.id)).toEqual([item2.id]);
    expect((await shopping.listItems({ search: '(100%)' })).map((x) => x.id)).toEqual([item2.id]);
    expect((await shopping.listItems({ search: 'giảm' })).map((x) => x.id)).toEqual([item2.id]);
    expect(shopping.listShopping).toBe(shopping.listItems);
  });

  it('validation', async () => {
    await expectCode(shopping.createItem({ name: '  ' }), 'invalid_input');
    await expectCode(shopping.createItem({ name: 'x', quantity: 0 }), 'invalid_input');
    await expectCode(shopping.createItem({ name: 'x', quantity: 1.5 }), 'invalid_input');
    await expectCode(shopping.createItem({ name: 'x', url: 'ftp://a' }), 'invalid_input');
    await expectCode(shopping.createItem({ name: 'x', priority: 'urgent' }), 'invalid_input');
    await expectCode(shopping.updateItem(item.id, { total_price: 5, expense_id: null }), 'invalid_input');
    // status purchased without a date → today is filled in
    const p = await shopping.createItem({ name: 'đã mua sẵn', status: 'purchased' });
    expect(p.purchased_on).toBe(todayVN());
    await shopping.deleteItem(p.id);
  });

  it('purchase() creates one linked expense; second purchase → already_purchased', async () => {
    const row = await shopping.purchase(item.id, { spentOn: '2025-06-15', paymentMethod: 'credit_card', createExpense: true });
    expect(row).toMatchObject({ id: item.id, status: 'purchased', purchased_on: '2025-06-15', total_price: 2500001 });
    expect(typeof row.total_price).toBe('number');
    expect(row.expense_id).toBeTruthy();
    const { data: exp, error } = await admin.from('expenses').select('*').eq('id', row.expense_id).single();
    expect(error).toBeNull();
    expect(exp).toMatchObject({ user_id: A.user.id, category_id: cats['Công nghệ'], description: 'Bàn phím cơ', spent_on: '2025-06-15', payment_method: 'credit_card' });
    expect(Number(exp.amount)).toBe(2500001);
    // visible through the service as well
    const [viaSvc] = await expenses.listExpenses({ from: '2025-06-15', to: '2025-06-15' });
    expect(viaSvc).toMatchObject({ id: row.expense_id, amount: 2500001 });

    const err = await expectCode(shopping.purchase(item.id, { spentOn: '2025-06-16' }), 'already_purchased');
    expect(err.message).toBe('Món này đã được đánh dấu là đã mua.');
    const { count } = await admin.from('expenses').select('id', { count: 'exact', head: true }).eq('user_id', A.user.id);
    expect(count).toBe(1);

    await expectCode(shopping.purchase('00000000-0000-0000-0000-000000000000'), 'not_found');
    await expectCode(shopping.purchase(item2.id, { spentOn: '2025-02-30' }), 'invalid_input');
    await expectCode(shopping.purchase(item2.id, { paymentMethod: 'gold' }), 'invalid_input');
  });

  it('purchase without expense / zero-price item creates no expense; default date = today', async () => {
    const a = await shopping.createItem({ name: 'không tạo chi', unit_price: 1000 });
    const ra = await shopping.purchase(a.id, { createExpense: false });
    expect(ra).toMatchObject({ status: 'purchased', purchased_on: todayVN(), expense_id: null });
    const z = await shopping.createItem({ name: 'miễn phí' });
    const rz = await shopping.purchase(z.id);
    expect(rz.expense_id).toBeNull();
  });

  it('markPurchased legacy form applies expenseCategoryId to the new expense', async () => {
    const it2 = await shopping.updateItem(item2.id, { category_id: cats['Mua sắm'] });
    const row = await shopping.markPurchased(it2, { purchased_on: '2025-06-20', createExpenseRow: true, expenseCategoryId: cats['Giải trí'], payment_method: 'bank' });
    expect(row).toMatchObject({ status: 'purchased', purchased_on: '2025-06-20' });
    const { data: exp } = await admin.from('expenses').select('*').eq('id', row.expense_id).single();
    expect(exp).toMatchObject({ category_id: cats['Giải trí'], payment_method: 'bank', spent_on: '2025-06-20' });
    expect(Number(exp.amount)).toBe(300000);
    // item keeps its own category
    expect((await shopping.listItems({ categoryId: cats['Mua sắm'] })).map((x) => x.id)).toEqual([item2.id]);
    // string id form, no expense
    const it3 = await shopping.createItem({ name: 'legacy id', unit_price: 5 });
    const r3 = await shopping.markPurchased(it3.id, { purchased_on: '2025-06-21' });
    expect(r3.expense_id).toBeNull();
  });

  it('revertPurchase removes the linked expense', async () => {
    const [cur] = (await shopping.listItems()).filter((x) => x.id === item2.id);
    const r = await shopping.revertPurchase(cur, { status: 'planned' });
    expect(r).toMatchObject({ status: 'planned', purchased_on: null, expense_id: null });
    const { data } = await admin.from('expenses').select('id').eq('id', cur.expense_id);
    expect(data).toEqual([]);
  });
});

// ======================================================================
describe('reports.exportCsv (range pagination past 1000 rows)', () => {
  let A;
  beforeAll(async () => { A = await newUser(); setClient(A.client); });
  afterAll(async () => { await deleteUser(A?.user); });

  it('expenses: 1100 rows in one admin insert → all exported', async () => {
    setClient(A.client);
    const uid = A.user.id;
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      user_id: uid,
      amount: i + 1,
      spent_on: addDays('2024-01-01', i % 300),
      payment_method: 'cash',
      description: i === 0 ? 'có "dấu ngoặc", phẩy' : `chi ${i}`,
    }));
    const { error } = await admin.from('expenses').insert(rows);
    expect(error).toBeNull();

    const res = await reports.exportCsv('expenses');
    expect(res.count).toBe(1100);
    expect(res.filename).toBe('chi-tieu.csv');
    const lines = res.csv.split('\r\n');
    expect(lines[0]).toBe('Ngày,Số tiền,Danh mục,Mô tả,Phương thức,Ghi chú');
    expect(lines).toHaveLength(1101);
    expect(res.csv).toContain('"có ""dấu ngoặc"", phẩy"');
    // no duplicates/gaps across pages: amounts are 1..1100
    const amounts = lines.slice(1).map((l) => Number(l.split(',')[1])).filter(Number.isFinite);
    expect(new Set(amounts).size).toBe(1100);
    expect(lines.slice(1).every((l) => l.includes('Tiền mặt'))).toBe(true);

    const ranged = await reports.exportCsv('expenses', { from: '2024-01-01', to: '2024-01-10' });
    // days 0..9 of each 300-day cycle: i%300 < 10 → 4 cycles (0,300,600,900) × 10 = 40
    expect(ranged.count).toBe(40);
    expect(ranged.filename).toBe('chi-tieu_2024-01-01_2024-01-10.csv');
    expect(ranged.csv.split('\r\n')).toHaveLength(41);

    // listExpenses' default limit (2000) is honoured past PostgREST max_rows (1000)
    const listed = await expenses.listExpenses({});
    expect(listed).toHaveLength(1100);
    expect(new Set(listed.map((x) => x.id)).size).toBe(1100);
    expect(await expenses.listExpenses({ limit: 1050 })).toHaveLength(1050);
    expect(await expenses.listExpenses({ limit: 5 })).toHaveLength(5);

    await expectCode(reports.exportCsv('expenses', { from: '2024-02-01', to: '2024-01-01' }), 'invalid_input');
    await expectCode(reports.exportCsv('nope'), 'invalid_input');
  });

  it('tasks, time, kpi_records', async () => {
    const uid = A.user.id;
    const [t1] = await adminInsert('tasks', [
      { user_id: uid, title: 'Viết báo cáo, quý 3', priority: 'high', tags: ['a', 'b'] },
      { user_id: uid, title: 'Task 2', priority: 'medium', tags: [] },
    ]);
    const tk = await reports.exportCsv('tasks');
    expect(tk.count).toBe(2);
    const tl = tk.csv.split('\r\n');
    expect(tl[0]).toBe('Tiêu đề,Mô tả,Trạng thái,Độ ưu tiên,Danh mục,Thẻ,Hạn chót,Ước tính (phút),Thực tế (phút),Hoàn thành lúc,Tạo lúc');
    expect(tl).toHaveLength(3);
    expect(tk.csv).toContain('"Viết báo cáo, quý 3",,Cần làm,Cao');
    expect(tk.csv).toContain('"a; b"');

    await adminInsert('time_entries', [
      { user_id: uid, task_id: t1.id, started_at: '2025-03-01T02:00:00Z', ended_at: '2025-03-01T03:30:00Z', source: 'manual', description: 'phiên 1' },
      { user_id: uid, task_id: null, started_at: '2025-03-02T02:00:00Z', ended_at: '2025-03-02T02:20:00Z', source: 'manual', description: null },
    ]);
    const tm = await reports.exportCsv('time', { from: '2025-03-01', to: '2025-03-31' });
    expect(tm.count).toBe(2);
    const ml = tm.csv.split('\r\n');
    expect(ml[0]).toBe('Bắt đầu,Kết thúc,Thời lượng (phút),Công việc,Mô tả,Nguồn');
    expect(ml[1]).toBe('2025-03-01 09:00,2025-03-01 10:30,90,"Viết báo cáo, quý 3",phiên 1,Nhập tay');
    expect(ml[2]).toBe('2025-03-02 09:00,2025-03-02 09:20,20,,,Nhập tay');

    const [k] = await adminInsert('kpis', [{ user_id: uid, name: 'Đọc sách', unit: 'cuốn', target_value: 12, start_date: '2025-01-01' }]);
    await adminInsert('kpi_records', [
      { user_id: uid, kpi_id: k.id, recorded_on: '2025-02-01', value: 1.5, note: 'tháng 2' },
      { user_id: uid, kpi_id: k.id, recorded_on: '2025-03-01', value: 3, note: null },
    ]);
    const kr = await reports.exportCsv('kpi_records');
    expect(kr.count).toBe(2);
    const kl = kr.csv.split('\r\n');
    expect(kl[0]).toBe('KPI,Đơn vị,Ngày,Giá trị,Ghi chú');
    expect(kl[1]).toBe('Đọc sách,cuốn,2025-02-01,1.5,tháng 2');
    expect((await reports.exportCsv('kpi_records', { from: '2025-02-15' })).count).toBe(1);
  });
});

// ======================================================================
describe('RLS: user B cannot see or act on user A finance data', () => {
  let A; let B; let catsA; let itemA; let expA; let budA;
  beforeAll(async () => {
    A = await newUser(); B = await newUser();
    setClient(A.client);
    catsA = await expenseCats();
    expA = await expenses.createExpense({ amount: 777, category_id: catsA['Ăn uống'], description: 'bí mật', spent_on: '2025-07-01' });
    budA = await budgets.setBudget({ amount: 5000, month: '2025-07' });
    await budgets.setBudget({ amount: 1000, categoryId: catsA['Ăn uống'], month: '2025-07' });
    itemA = await shopping.createItem({ name: 'đồ của A', unit_price: 100 });
  });
  afterAll(async () => { await deleteUser(A?.user); await deleteUser(B?.user); });

  it('B sees none of A’s expenses / budgets / summary / items', async () => {
    setClient(B.client);
    expect(await expenses.listExpenses({})).toEqual([]);
    expect(await expenses.listExpenses({ search: 'bí mật' })).toEqual([]);
    expect(await expenses.getExpensesByIds([expA.id])).toEqual([]);
    expect(await budgets.listBudgets()).toEqual([]);
    expect(await budgets.status('2025-07')).toEqual([]);
    const s = await expenses.summary('2025-07-01', '2025-07-31');
    expect(s.total).toBe(0);
    expect(s.count).toBe(0);
    expect(await shopping.listItems()).toEqual([]);
    expect((await reports.exportCsv('expenses')).count).toBe(0);
  });

  it('B cannot purchase / update / delete A’s rows', async () => {
    setClient(B.client);
    await expectCode(shopping.purchase(itemA.id, { spentOn: '2025-07-02' }), 'not_found');
    await expectCode(shopping.updateItem(itemA.id, { name: 'hack' }), 'not_found');
    await expectCode(expenses.updateExpense(expA.id, { amount: 1 }), 'not_found');
    await shopping.deleteItem(itemA.id);   // silently affects 0 rows
    await expenses.deleteExpense(expA.id);
    await budgets.deleteBudget(budA.id);
    // B cannot budget A's category nor file an expense under it
    await expectCode(budgets.setBudget({ amount: 1, categoryId: catsA['Ăn uống'], month: '2025-07' }), 'not_found');
    await expectCode(expenses.createExpense({ amount: 1, category_id: catsA['Ăn uống'] }), 'invalid_reference');

    setClient(A.client);
    expect((await shopping.listItems()).map((x) => x.id)).toEqual([itemA.id]);
    expect((await shopping.listItems())[0]).toMatchObject({ status: 'wishlist', name: 'đồ của A' });
    expect((await expenses.listExpenses({})).map((x) => x.amount)).toEqual([777]);
    expect((await budgets.listBudgets())).toHaveLength(2);
    expect((await budgets.status('2025-07')).find((r) => r.category_id === null)).toMatchObject({ budget: 5000, spent: 777 });
  });
});

describe('shopping.listItems paging past PostgREST max_rows', () => {
  let U;
  beforeAll(async () => { U = await newUser(); });
  afterAll(async () => { await deleteUser(U?.user); });
  it('returns all 1100 items without duplicates', async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ user_id: U.user.id, name: `Item ${i}`, unit_price: i }));
    const { error } = await admin.from('shopping_items').insert(rows);
    expect(error).toBeNull();
    setClient(U.client);
    const all = await shopping.listItems();
    expect(all).toHaveLength(1100);
    expect(new Set(all.map((x) => x.id)).size).toBe(1100);
  });
});
