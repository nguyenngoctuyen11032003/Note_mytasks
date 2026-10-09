// Expenses — the only place money spent is counted.
import {
  db, run, rpc, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vDay, vUuidOrNull, numify, searchOr,
} from './errors.js';

export const PAYMENT_METHODS = {
  cash: 'Tiền mặt',
  bank: 'Chuyển khoản',
  credit_card: 'Thẻ tín dụng',
  e_wallet: 'Ví điện tử',
  other: 'Khác',
};
const METHODS = Object.keys(PAYMENT_METHODS);
const MAX_AMOUNT = 999_999_999_999.99; // numeric(14,2)

export const EXPENSE_COLS = 'id, amount, category_id, description, spent_on, payment_method, note, created_at, updated_at';
const SELECT = `${EXPENSE_COLS}, category:categories(id, name, color)`;
export const EXPENSE_WRITABLE = ['amount', 'category_id', 'description', 'spent_on', 'payment_method', 'note'];

export function validateExpense(input, { partial = false } = {}) {
  const p = pick(input, EXPENSE_WRITABLE);
  if (!partial || 'amount' in p) p.amount = vNumber(p.amount, 'amount', { required: true, gt: 0, max: MAX_AMOUNT, label: 'Số tiền' });
  if ('category_id' in p) p.category_id = vUuidOrNull(p.category_id, 'category_id');
  if ('description' in p) p.description = vText(p.description, 'description', { max: 200, label: 'Mô tả' });
  if ('spent_on' in p) p.spent_on = vDay(p.spent_on, 'spent_on', { required: true, label: 'Ngày chi' });
  if ('payment_method' in p) p.payment_method = vEnum(p.payment_method, 'payment_method', METHODS, { required: true, label: 'Phương thức thanh toán' });
  if ('note' in p) p.note = vText(p.note, 'note', { max: 1000, label: 'Ghi chú' });
  return p;
}

const normalize = (rows) => numify(rows, ['amount']);

export async function listExpenses({ from, to, categoryId, paymentMethod, search, minAmount, maxAmount, limit = 2000 } = {}) {
  let q = db().from('expenses').select(SELECT);
  if (from) q = q.gte('spent_on', vDay(from, 'from'));
  if (to) q = q.lte('spent_on', vDay(to, 'to'));
  if (categoryId === 'none') q = q.is('category_id', null);
  else if (categoryId) q = q.eq('category_id', categoryId);
  if (Array.isArray(paymentMethod)) {
    if (paymentMethod.length) q = q.in('payment_method', paymentMethod);
  } else if (paymentMethod) q = q.eq('payment_method', paymentMethod);
  const min = vNumber(minAmount, 'minAmount', { min: 0, label: 'Số tiền tối thiểu' });
  const max = vNumber(maxAmount, 'maxAmount', { min: 0, label: 'Số tiền tối đa' });
  if (min != null) q = q.gte('amount', min);
  if (max != null) q = q.lte('amount', max);
  const s = typeof search === 'string' ? search.trim() : '';
  if (s) q = q.or(searchOr(s, ['description', 'note']));
  q = q.order('spent_on', { ascending: false }).order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 2000, 1), 5000));
  return normalize(await run(q));
}

export async function createExpense(input) {
  const row = validateExpense(input);
  return normalize(await run(db().from('expenses').insert(row).select(SELECT).single()));
}

export async function updateExpense(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateExpense(patch, { partial: true }));
  return normalize(await run(db().from('expenses').update(row).eq('id', id).select(SELECT).single()));
}

export async function deleteExpense(id) {
  requireId(id);
  await run(db().from('expenses').delete().eq('id', id));
  return true;
}

const n = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

/** RPC spending_summary — every money field normalised to Number. */
export async function summary(from, to) {
  const d = (await rpc('spending_summary', { p_from: vDay(from, 'from', { required: true }), p_to: vDay(to, 'to', { required: true }) })) || {};
  return {
    total: n(d.total),
    count: n(d.count),
    daily_avg: n(d.daily_avg),
    prev_total: n(d.prev_total),
    change_pct: d.change_pct == null ? null : Number(d.change_pct),
    by_category: (d.by_category || []).map((c) => ({ ...c, total: n(c.total), count: n(c.count), pct: n(c.pct) })),
    by_payment_method: (d.by_payment_method || []).map((m) => ({ ...m, total: n(m.total) })),
    by_day: (d.by_day || []).map((x) => ({ ...x, total: n(x.total) })),
  };
}

/** RPC expense_anomalies. */
export async function anomalies(days = 30) {
  const p = vNumber(days, 'days', { min: 1, max: 365, integer: true, label: 'Số ngày' }) ?? 30;
  return numify((await rpc('expense_anomalies', { p_days: p })) || [], ['amount', 'baseline', 'z_score']);
}

/** RPC suggest_expense_category → [{category_id, name, confidence}] (≤ 3). */
export async function suggestCategory(description) {
  const s = typeof description === 'string' ? description.trim() : '';
  if (s.length < 2) return [];
  return numify((await rpc('suggest_expense_category', { p_description: s })) || [], ['confidence']);
}

// Short aliases (expenses.list / expenses.create …)
export { listExpenses as list, createExpense as create, updateExpense as update, deleteExpense as remove, deleteExpense as delete };
