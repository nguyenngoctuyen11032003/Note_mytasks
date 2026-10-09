import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import * as expenses from '../../src/services/expenses.js';
import * as budgets from '../../src/services/budgets.js';
import * as shopping from '../../src/services/shopping.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});

describe('expenses', () => {
  it('list applies every filter and normalises amount', async () => {
    fake.respond('expenses', { data: [{ id: 'e', amount: '35000.00' }] });
    const rows = await expenses.listExpenses({
      from: '2026-10-01', to: '2026-10-31', categoryId: 'c1', paymentMethod: ['cash', 'bank'], search: 'cà phê 50%', minAmount: '1000', maxAmount: 99999,
    });
    expect(rows[0].amount).toBe(35000);
    const c = fake.last('from', 'expenses');
    expect(fake.argsOf(c, 'gte')).toEqual([['spent_on', '2026-10-01'], ['amount', 1000]]);
    expect(fake.argsOf(c, 'lte')).toEqual([['spent_on', '2026-10-31'], ['amount', 99999]]);
    expect(fake.argsOf(c, 'eq')).toEqual([['category_id', 'c1']]);
    expect(fake.argsOf(c, 'in')).toEqual([['payment_method', ['cash', 'bank']]]);
    expect(fake.argsOf(c, 'or')[0][0]).toBe('description.ilike."%cà phê 50\\\\%%",note.ilike."%cà phê 50\\\\%%"');
    expect(fake.argsOf(c, 'order')[0]).toEqual(['spent_on', { ascending: false }]);
  });

  it('single paymentMethod → eq; categoryId none → is null', async () => {
    await expenses.listExpenses({ paymentMethod: 'cash', categoryId: 'none' });
    const c = fake.last('from', 'expenses');
    expect(fake.argsOf(c, 'eq')).toEqual([['payment_method', 'cash']]);
    expect(fake.argsOf(c, 'is')).toEqual([['category_id', null]]);
  });

  it('create whitelists columns and converts numeric strings', async () => {
    await expenses.createExpense({ amount: '120000', spent_on: '2026-10-09', description: ' Grab ', note: '', user_id: 'x', id: 'y', category_id: '' });
    const row = fake.argsOf(fake.last('from', 'expenses'), 'insert')[0][0];
    expect(row).toEqual({ amount: 120000, spent_on: '2026-10-09', description: 'Grab', note: null, category_id: null });
  });

  it.each([
    [{ amount: 0 }, 'amount'],
    [{ amount: -5 }, 'amount'],
    [{ amount: 'abc' }, 'amount'],
    [{}, 'amount'],
    [{ amount: 1, description: 'x'.repeat(201) }, 'description'],
    [{ amount: 1, payment_method: 'bitcoin' }, 'payment_method'],
    [{ amount: 1, spent_on: '2026-02-30' }, 'spent_on'],
    [{ amount: 1, note: 'x'.repeat(1001) }, 'note'],
  ])('create(%o) → invalid_input on %s', async (input, field) => {
    await expect(expenses.createExpense(input)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
  });

  it('update is partial', async () => {
    await expenses.updateExpense('e1', { note: 'n', created_at: 'x' });
    expect(fake.argsOf(fake.last('from', 'expenses'), 'update')[0][0]).toEqual({ note: 'n' });
  });

  it('summary → spending_summary(p_from, p_to) normalised', async () => {
    fake.respond('rpc:spending_summary', {
      data: { total: '100.5', count: 2, daily_avg: '50.25', by_category: [{ name: 'A', total: '100.5', count: '2', pct: '100' }], by_payment_method: [{ method: 'cash', total: '100.5' }], by_day: [{ day: '2026-10-01', total: '0' }], prev_total: '0', change_pct: null },
    });
    const s = await expenses.summary('2026-10-01', '2026-10-02');
    expect(fake.last('rpc', 'spending_summary').args).toEqual([{ p_from: '2026-10-01', p_to: '2026-10-02' }]);
    expect(s.total).toBe(100.5);
    expect(s.by_category[0]).toMatchObject({ total: 100.5, count: 2, pct: 100 });
    expect(s.by_payment_method[0].total).toBe(100.5);
    expect(s.by_day[0].total).toBe(0);
    expect(s.change_pct).toBeNull();
    await expect(expenses.summary(null, '2026-10-02')).rejects.toMatchObject({ details: { field: 'from' } });
  });

  it('anomalies → expense_anomalies(p_days)', async () => {
    fake.respond('rpc:expense_anomalies', { data: [{ amount: '900000', baseline: '50000', z_score: '7.2' }] });
    const [a] = await expenses.anomalies(14);
    expect(fake.last('rpc', 'expense_anomalies').args).toEqual([{ p_days: 14 }]);
    expect(a).toMatchObject({ amount: 900000, baseline: 50000, z_score: 7.2 });
  });

  it('suggestCategory → suggest_expense_category(p_description); short text skips the call', async () => {
    fake.respond('rpc:suggest_expense_category', { data: [{ category_id: 'c', name: 'Ăn uống', confidence: '0.8' }] });
    const r = await expenses.suggestCategory(' cà phê ');
    expect(fake.last('rpc', 'suggest_expense_category').args).toEqual([{ p_description: 'cà phê' }]);
    expect(r[0].confidence).toBe(0.8);
    expect(await expenses.suggestCategory('a')).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('budgets', () => {
  it('status → budget_status(p_month) normalised', async () => {
    fake.respond('rpc:budget_status', { data: [{ category_id: null, budget: '5000000', spent: '1200000', remaining: '3800000', used_pct: '24', projected: '4000000', status: 'ok' }] });
    const [r] = await budgets.status('2026-10');
    expect(fake.last('rpc', 'budget_status').args).toEqual([{ p_month: '2026-10-01' }]);
    expect(r).toMatchObject({ budget: 5000000, spent: 1200000, used_pct: 24, projected: 4000000 });
    await budgets.status();
    expect(fake.last('rpc', 'budget_status').args).toEqual([{ p_month: null }]);
  });

  it('month must be the first day of a month', async () => {
    await expect(budgets.status('2026-10-15')).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'month' } });
    await expect(budgets.setBudget({ amount: 1, month: '2026-13' })).rejects.toMatchObject({ details: { field: 'month' } });
    expect(budgets.toMonth('2026-10-01')).toBe('2026-10-01');
  });

  it('status falls back to 000200 get_budget_status and maps columns', async () => {
    fake.respond('rpc:budget_status', { error: { code: 'PGRST202', message: 'Could not find the function' } });
    fake.respond('rpc:get_budget_status', {
      data: [
        { category_id: null, category_name: null, color: null, budget_amount: '1000', spent: '1200', remaining: '-200', percent_used: '120.0' },
        { category_id: 'c', category_name: 'Ăn', color: '#000000', budget_amount: null, spent: '10', remaining: null, percent_used: null },
      ],
    });
    const rows = await budgets.status('2020-01-01');
    expect(fake.last('rpc', 'get_budget_status').args).toEqual([{ p_month: '2020-01-01' }]);
    expect(rows[0]).toMatchObject({ budget: 1000, spent: 1200, remaining: -200, used_pct: 120, projected: 1200, status: 'over' });
    expect(rows[1]).toMatchObject({ budget: null, status: 'no_budget' });
  });

  it('setBudget → set_budget(p_amount, p_category_id, p_month)', async () => {
    fake.respond('rpc:set_budget', { data: { id: 'b', amount: '3000000.00' } });
    const b = await budgets.setBudget({ amount: '3000000', categoryId: 'c1', month: '2026-10-01' });
    expect(fake.last('rpc', 'set_budget').args).toEqual([{ p_amount: 3000000, p_category_id: 'c1', p_month: '2026-10-01' }]);
    expect(b.amount).toBe(3000000);
    await expect(budgets.setBudget({ amount: -1 })).rejects.toMatchObject({ details: { field: 'amount' } });
  });

  it('setBudget falls back to a direct update of the existing row (overall → is null)', async () => {
    fake.respond('rpc:set_budget', { error: { code: 'PGRST202', message: 'nf' } });
    fake.respond('budgets', { data: { id: 'b1' } }, { data: { id: 'b1', amount: '200' } });
    const b = await budgets.setBudget({ amount: 200, month: '2026-10-01' });
    const [find, upd] = fake.calls.filter((c) => c.name === 'budgets');
    expect(fake.argsOf(find, 'eq')).toEqual([['effective_month', '2026-10-01']]);
    expect(fake.argsOf(find, 'is')).toEqual([['category_id', null]]);
    expect(fake.argsOf(upd, 'update')[0][0]).toEqual({ amount: 200 });
    expect(fake.argsOf(upd, 'eq')).toEqual([['id', 'b1']]);
    expect(b.amount).toBe(200);
  });

  it('setBudget fallback inserts when no row exists for the category', async () => {
    fake.respond('rpc:set_budget', { error: { code: '42883', message: 'nf' } });
    fake.respond('budgets', { data: null }, { data: { id: 'b2', amount: 50 } });
    await budgets.setBudget({ amount: 50, categoryId: 'c1', month: '2026-11' });
    const [find, ins] = fake.calls.filter((c) => c.name === 'budgets');
    expect(fake.argsOf(find, 'eq')).toEqual([['effective_month', '2026-11-01'], ['category_id', 'c1']]);
    expect(fake.argsOf(ins, 'insert')[0][0]).toEqual({ effective_month: '2026-11-01', category_id: 'c1', amount: 50 });
  });

  it('listBudgets / resolveBudgets (compat)', async () => {
    fake.respond('budgets', { data: [
      { effective_month: '2026-01-01', category_id: null, amount: '100' },
      { effective_month: '2026-06-01', category_id: null, amount: '200' },
      { effective_month: '2026-12-01', category_id: null, amount: '300' },
      { effective_month: '2026-03-01', category_id: 'c', amount: '50' },
    ] });
    const rows = await budgets.listBudgets();
    const r = budgets.resolveBudgets(rows, '2026-10-01');
    expect(r.overall).toBe(200);
    expect(r.byCategory.get('c')).toBe(50);
  });
});

describe('shopping', () => {
  it('create strips total_price / expense_id and validates', async () => {
    await shopping.createItem({ name: ' Tai nghe ', unit_price: '1500000', quantity: '2', total_price: 3000000, expense_id: 'e', url: '', user_id: 'u' });
    const row = fake.argsOf(fake.last('from', 'shopping_items'), 'insert')[0][0];
    expect(row).toEqual({ name: 'Tai nghe', unit_price: 1500000, quantity: 2, url: null });
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: 'a', quantity: 0 }, 'quantity'],
    [{ name: 'a', quantity: 10000 }, 'quantity'],
    [{ name: 'a', quantity: 1.5 }, 'quantity'],
    [{ name: 'a', unit_price: -1 }, 'unit_price'],
    [{ name: 'a', url: 'ftp://x' }, 'url'],
    [{ name: 'a', url: 'javascript:alert(1)' }, 'url'],
    [{ name: 'a', priority: 'asap' }, 'priority'],
    [{ name: 'a', status: 'bought' }, 'status'],
  ])('create(%o) → invalid_input on %s', async (input, field) => {
    await expect(shopping.createItem(input)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
  });

  it('purchase → purchase_shopping_item with exact 000200 args', async () => {
    fake.respond('rpc:purchase_shopping_item', { data: { id: 'i1', status: 'purchased', total_price: '3000000', unit_price: '1500000', quantity: 2 } });
    const r = await shopping.purchase('i1', { spentOn: '2026-10-09', paymentMethod: 'e_wallet' });
    expect(fake.last('rpc', 'purchase_shopping_item').args).toEqual([{ p_item_id: 'i1', p_purchased_on: '2026-10-09', p_payment_method: 'e_wallet', p_create_expense: true }]);
    expect(r.total_price).toBe(3000000);
  });

  it('purchase validates payment method client-side', async () => {
    await expect(shopping.purchase('i1', { paymentMethod: 'paypal' })).rejects.toMatchObject({ details: { field: 'paymentMethod' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('purchase maps 000200 errors', async () => {
    fake.respond('rpc:purchase_shopping_item', { error: { code: '22023', message: 'item is already purchased' } });
    await expect(shopping.purchase('i1')).rejects.toMatchObject({ code: 'already_purchased' });
    fake.respond('rpc:purchase_shopping_item', { error: { code: 'P0002', message: 'shopping item not found' } });
    await expect(shopping.purchase('i1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('markPurchased (compat) delegates and re-files the expense category', async () => {
    fake.respond('rpc:purchase_shopping_item', { data: { id: 'i1', expense_id: 'exp1', category_id: 'c1' } });
    const item = { id: 'i1', category_id: 'c1', expense_id: null };
    await shopping.markPurchased(item, { purchased_on: '2026-10-09', createExpenseRow: true, expenseCategoryId: 'c2', payment_method: 'bank' });
    expect(fake.last('rpc', 'purchase_shopping_item').args).toEqual([{ p_item_id: 'i1', p_purchased_on: '2026-10-09', p_payment_method: 'bank', p_create_expense: true }]);
    const upd = fake.last('from', 'expenses');
    expect(fake.argsOf(upd, 'update')[0][0]).toEqual({ category_id: 'c2' });
    expect(fake.argsOf(upd, 'eq')).toEqual([['id', 'exp1']]);
  });

  it('markPurchased defaults to no expense and accepts an id', async () => {
    fake.respond('rpc:purchase_shopping_item', { data: { id: 'i1' } });
    await shopping.markPurchased('i1', { purchased_on: '2026-10-09' });
    expect(fake.last('rpc', 'purchase_shopping_item').args[0]).toMatchObject({ p_item_id: 'i1', p_create_expense: false });
    expect(fake.last('from', 'expenses')).toBeUndefined();
  });

  it('listShopping alias + filters', async () => {
    expect(shopping.listShopping).toBe(shopping.listItems);
    await shopping.listShopping({ status: ['wishlist', 'planned'], search: 'a_b' });
    const c = fake.last('from', 'shopping_items');
    expect(fake.argsOf(c, 'in')).toEqual([['status', ['wishlist', 'planned']]]);
    expect(fake.argsOf(c, 'or')[0][0]).toContain('name.ilike."%a\\\\_b%"');
  });
});
