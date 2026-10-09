// Budgets — carry-forward rows: "from effective_month on, the budget is X".
// Writes go through RPC set_budget (upsert of the row for that month).
import { today, startOfMonth, endOfMonth, diffDays } from '../utils/date.js';
import { db, run, rpc, rpcOr, invalid, requireId, vNumber, vUuidOrNull, isDay, numify, single } from './errors.js';

export const BUDGET_COLS = 'id, effective_month, category_id, amount, created_at, updated_at';
const MAX_AMOUNT = 999_999_999_999.99;

/**
 * Normalise a month to its first day. Accepts 'YYYY-MM' or 'YYYY-MM-01'
 * (mirrors CHECK extract(day from effective_month) = 1); null → null.
 */
export function toMonth(month, field = 'month') {
  if (month == null || month === '') return null;
  const s = String(month).trim();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  const day = m ? `${m[1]}-${m[2]}-01` : null;
  if (!m || !isDay(day) || (m[3] && m[3] !== '01')) {
    throw invalid(field, 'Tháng phải là ngày đầu tháng (YYYY-MM-01).');
  }
  return day;
}

const normalizeStatus = (rows) => numify(rows || [], ['budget', 'spent', 'remaining', 'used_pct', 'projected']);

/** RPC budget_status — month null = current month (user timezone). */
export async function status(month = null) {
  const p = toMonth(month);
  return normalizeStatus(await rpcOr('budget_status', { p_month: p }, () => legacyStatus(p)));
}

function statusOf(budget, spent, projected) {
  if (budget == null) return 'no_budget';
  if (budget > 0 ? spent / budget > 1 : spent > 0) return 'over';
  if ((budget > 0 && spent / budget >= 0.8) || projected > budget) return 'warning';
  return 'ok';
}

/** Fallback on 000200's get_budget_status (no projection there → computed here). */
async function legacyStatus(month) {
  const rows = (await rpc('get_budget_status', { p_month: month })) || [];
  const t = today();
  const m = month || startOfMonth(t);
  const end = endOfMonth(m);
  const days = diffDays(end, m) + 1;
  const elapsed = t < m ? 0 : t > end ? days : diffDays(t, m) + 1;
  return rows.map((r) => {
    const budget = r.budget_amount == null ? null : Number(r.budget_amount);
    const spent = Number(r.spent) || 0;
    const projected = elapsed === 0 ? 0 : elapsed >= days ? spent : (spent / elapsed) * days;
    return {
      category_id: r.category_id, category_name: r.category_name, color: r.color,
      budget, spent,
      remaining: r.remaining == null ? null : Number(r.remaining),
      used_pct: r.percent_used == null ? null : Number(r.percent_used),
      projected: Math.round(projected * 100) / 100,
      status: statusOf(budget, spent, projected),
    };
  });
}

/** RPC set_budget. categoryId null = overall budget. amount 0 = "no budget from now on". */
export async function setBudget({ amount, categoryId = null, month = null } = {}) {
  const a = vNumber(amount, 'amount', { required: true, min: 0, max: MAX_AMOUNT, label: 'Ngân sách' });
  const cat = vUuidOrNull(categoryId, 'categoryId');
  const m = toMonth(month);
  let row;
  try {
    row = single(await rpc('set_budget', { p_amount: a, p_category_id: cat, p_month: m }));
  } catch (e) {
    // Migration 000400 not applied yet → direct upsert on public.budgets.
    if (e?.code !== 'feature_unavailable') throw e;
    row = await upsertBudgetRow(a, cat, m || startOfMonth(today()));
  }
  return numify(row, ['amount']);
}

async function upsertBudgetRow(amount, categoryId, month) {
  let q = db().from('budgets').select('id').eq('effective_month', month);
  q = categoryId ? q.eq('category_id', categoryId) : q.is('category_id', null);
  const existing = await run(q.maybeSingle());
  if (existing) return run(db().from('budgets').update({ amount }).eq('id', existing.id).select(BUDGET_COLS).single());
  return run(db().from('budgets').insert({ effective_month: month, category_id: categoryId, amount }).select(BUDGET_COLS).single());
}

export async function listBudgets() {
  const q = db().from('budgets').select(BUDGET_COLS).order('effective_month', { ascending: true });
  return numify(await run(q), ['amount']);
}

export async function deleteBudget(id) {
  requireId(id);
  await run(db().from('budgets').delete().eq('id', id));
  return true;
}

/**
 * Pure helper: resolve budgets for `month` from rows of listBudgets().
 * Returns { overall: number|null, byCategory: Map<categoryId, number> }.
 */
export function resolveBudgets(rows, month) {
  const latest = new Map();
  for (const r of rows || []) {
    if (r.effective_month > month) continue;
    const key = r.category_id ?? '__overall';
    const prev = latest.get(key);
    if (!prev || r.effective_month > prev.effective_month) latest.set(key, r);
  }
  const overall = latest.get('__overall');
  latest.delete('__overall');
  return {
    overall: overall ? Number(overall.amount) : null,
    byCategory: new Map([...latest].map(([k, r]) => [k, Number(r.amount)])),
  };
}

export { status as budgetStatus, listBudgets as list, deleteBudget as remove, deleteBudget as delete };
