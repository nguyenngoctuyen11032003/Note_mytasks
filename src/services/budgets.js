// Budgets — carry-forward rows: "from effective_month on, the budget is X".
// Writes go through RPC set_budget (upsert of the row for that month).
import { today, startOfMonth, endOfMonth, diffDays, addDays as addDaysTo } from '../utils/date.js';
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

// Same rules as SQL budget_status (exact numeric): over = spent > budget,
// warning = spent >= budget * 0.8. Compared in integer cents (spent*5 >= budget*4)
// so float division can't flip the result at the 80 % boundary (8000.08 / 10000.10).
const cents = (v) => Math.round(Number(v) * 100);
function statusOf(budget, spent, projected) {
  if (budget == null) return 'no_budget';
  const b = cents(budget);
  const s = cents(spent);
  if (b > 0 ? s > b : s > 0) return 'over';
  if ((b > 0 && s * 5 >= b * 4) || cents(projected) > b) return 'warning';
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

/** Pure: same status rule as budget_status (over > warning (≥ 80 % or projected over) > ok). */
export function budgetState(budget, spent, projected) {
  return statusOf(budget == null ? null : Number(budget), Number(spent) || 0, Number(projected) || 0);
}

/**
 * Pure: amount at/above which a single expense counts as a one-off (rent,
 * transfers, a big purchase) — it is counted once in a forecast but not
 * extrapolated over the rest of the month. Infinity when history is thin.
 */
export function oneOffThreshold(history = []) {
  const a = (history || []).map((x) => Number(x.amount)).filter((v) => v > 0).sort((x, y) => x - y);
  if (a.length < 10) return Infinity;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return Math.max(q(0.9), q(0.5) * 5);
}

/**
 * Pure: month-end forecast = everything recorded in the month + the routine
 * daily rate × days left. The routine rate leaves out one-offs (≥ threshold)
 * and, early in the month, leans on `baseRate` (routine spend per day before
 * the month) so two days of data cannot swing it wildly.
 * Past month → its total; future month → what is already planned.
 */
export function projectMonth(items, { month, today: t = today(), threshold = Infinity, baseRate = null, weight = 7 } = {}) {
  const m = startOfMonth(month || t);
  const end = endOfMonth(m);
  let spent = 0, routine = 0;
  for (const x of items || []) {
    if (x.spent_on < m || x.spent_on > end) continue;
    const v = Number(x.amount) || 0;
    spent += v;
    if (x.spent_on <= t && v < threshold) routine += v;
  }
  if (t < m || t >= end) return Math.round(spent * 100) / 100;
  const elapsed = diffDays(t, m) + 1;
  const left = diffDays(end, m) + 1 - elapsed;
  const rate = baseRate != null && baseRate >= 0 ? (routine + baseRate * weight) / (elapsed + weight) : routine / elapsed;
  return Math.round((spent + rate * left) * 100) / 100;
}

/**
 * Pure: routine spend per day over the `days` before `month` (one-offs
 * excluded), from a newest-first history. null when history does not reach.
 */
export function routineRate(history, { month, threshold = Infinity, days = 56 } = {}) {
  const m = startOfMonth(month);
  const list = (history || []).filter((x) => x.spent_on < m);
  if (!list.length) return null;
  const oldest = list.reduce((o, x) => (x.spent_on < o ? x.spent_on : o), m);
  const span = Math.min(days, diffDays(m, oldest));
  if (span < 14) return null;
  const from = addDaysTo(m, -span);
  const total = list.reduce((s, x) => s + (x.spent_on >= from && Number(x.amount) < threshold ? Number(x.amount) : 0), 0);
  return total / span;
}

export { status as budgetStatus, listBudgets as list, deleteBudget as remove, deleteBudget as delete };
