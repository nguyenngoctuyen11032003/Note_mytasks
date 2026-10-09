// Dashboard aggregates — one RPC per widget group.
import { rpc, rpcOr, vDay } from './errors.js';
import { endOfMonth, diffDays, startOfMonth } from '../utils/date.js';

const n = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const nOrNull = (v) => (v == null || v === '' ? null : Number(v));

/** RPC dashboard_summary — shape documented in docs/backend-api-contract.md §3. */
export async function summary() {
  const d = (await rpcOr('dashboard_summary', undefined, legacySummary)) || {};
  const t = d.tasks || {};
  const tm = d.time || {};
  const m = d.money || {};
  const k = d.kpis || {};
  const s = d.shopping || {};
  const st = d.streak || {};
  return {
    today: d.today ?? null,
    tasks: { open: n(t.open), overdue: n(t.overdue), due_today: n(t.due_today), completed_today: n(t.completed_today), completed_this_week: n(t.completed_this_week) },
    time: { today_minutes: n(tm.today_minutes), week_minutes: n(tm.week_minutes), running: tm.running ?? null },
    money: {
      month_spent: n(m.month_spent),
      month_budget: nOrNull(m.month_budget),
      month_remaining: nOrNull(m.month_remaining),
      month_projected: n(m.month_projected),
      today_spent: n(m.today_spent),
    },
    kpis: { active: n(k.active), on_track: n(k.on_track), at_risk: n(k.at_risk), off_track: n(k.off_track) },
    shopping: { planned_count: n(s.planned_count), planned_total: n(s.planned_total) },
    streak: { current: n(st.current), longest: n(st.longest) },
  };
}

/**
 * Fallback on 000200's get_dashboard_summary (different shape): mapped to the
 * contract shape; fields it lacks (KPI on-track split, streak) are 0.
 */
async function legacySummary() {
  const d = (await rpc('get_dashboard_summary')) || {};
  const e = d.expenses || {};
  const spent = n(e.month_total);
  const budget = nOrNull(e.budget_total);
  let projected = spent;
  if (d.today) {
    const m = startOfMonth(d.today);
    projected = Math.round((spent / (diffDays(d.today, m) + 1)) * (diffDays(endOfMonth(m), m) + 1) * 100) / 100;
  }
  const r = d.time?.running;
  return {
    today: d.today ?? null,
    tasks: d.tasks || {},
    time: { ...(d.time || {}), running: r ? { entry: r, task_title: r.task_title ?? null } : null },
    money: { month_spent: spent, month_budget: budget, month_remaining: budget == null ? null : budget - spent, month_projected: projected, today_spent: n(e.today_total) },
    kpis: { active: n(d.kpis?.active) },
    shopping: { planned_count: n(d.shopping?.planned), planned_total: n(d.shopping?.planned_total) },
    streak: {},
  };
}

/** RPC productivity_stats(p_from, p_to). */
export async function productivity(from, to) {
  const d = (await rpc('productivity_stats', { p_from: vDay(from, 'from', { required: true }), p_to: vDay(to, 'to', { required: true }) })) || {};
  return {
    completed_by_day: (d.completed_by_day || []).map((x) => ({ ...x, count: n(x.count) })),
    minutes_by_day: (d.minutes_by_day || []).map((x) => ({ ...x, minutes: n(x.minutes) })),
    minutes_by_category: (d.minutes_by_category || []).map((x) => ({ ...x, minutes: n(x.minutes) })),
    completion_rate: nOrNull(d.completion_rate),
    on_time_rate: nOrNull(d.on_time_rate),
    avg_cycle_hours: nOrNull(d.avg_cycle_hours),
    busiest_weekday: nOrNull(d.busiest_weekday),
  };
}

/** RPC streaks() → {current, longest, last_active_day}. */
export async function streaks() {
  const d = (await rpc('streaks')) || {};
  return { current: n(d.current), longest: n(d.longest), last_active_day: d.last_active_day ?? null };
}

/* ------------------------------------------------------------------ */
/* Pure helpers (no network) — used by the Dashboard page.             */
/* ------------------------------------------------------------------ */

/**
 * Today's spending allowance: what is left of the month budget (excluding
 * today's own spending) spread evenly over the remaining days incl. today.
 * Returns null when there is no budget.
 */
export function dailyAllowance({ budget, monthSpent = 0, todaySpent = 0, today: t, monthEnd }) {
  if (budget == null || !(budget > 0) || !t || !monthEnd) return null;
  const daysLeft = Math.max(1, diffDays(monthEnd, t) + 1);
  return Math.max(0, (budget - (monthSpent - todaySpent)) / daysLeft);
}

/**
 * Burn-down series for a month. `byDay` = { 'YYYY-MM-DD': amount }.
 * → { days, actual (null after today), ideal (null without budget), projected (null before today), projectedTotal }
 */
export function burnDown({ byDay = {}, month, budget = null, today: t }) {
  const start = startOfMonth(month);
  const end = endOfMonth(start);
  const days = [];
  for (let d = start, i = 0; d <= end && i < 32; i++) {
    days.push(d);
    const [y, m, dd] = d.split('-').map(Number);
    const nx = new Date(Date.UTC(y, m - 1, dd + 1, 12));
    d = nx.toISOString().slice(0, 10);
  }
  const total = days.length;
  let acc = 0;
  const actual = days.map((d) => (t && d > t ? null : (acc += Number(byDay[d]) || 0)));
  const elapsed = t ? Math.min(total, Math.max(0, diffDays(t, start) + 1)) : total;
  const rate = elapsed > 0 ? acc / elapsed : 0;
  const projected = days.map((d, i) => (i + 1 < elapsed ? null : Math.round(rate * (i + 1))));
  const ideal = budget > 0 ? days.map((_, i) => Math.round((budget * (i + 1)) / total)) : null;
  return { days, actual, ideal, projected, spent: acc, projectedTotal: Math.round(rate * total), elapsed, total };
}

/**
 * Activity streak from a set of active days (≥ 1 task completed or ≥ 15 min tracked).
 * Counts back from today (or yesterday when today is not active yet), never
 * past `windowStart`. `capped` = the streak reaches the window start.
 */
export function streakFrom(activeDays, t, windowStart) {
  const has = (d) => activeDays.has(d);
  const back = (d) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd - 1, 12)).toISOString().slice(0, 10);
  };
  let d = has(t) ? t : back(t);
  let current = 0;
  while (d >= windowStart && has(d)) { current++; d = back(d); }
  let longest = 0, run = 0;
  for (let x = t; x >= windowStart; x = back(x)) {
    run = has(x) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current, longest: Math.max(longest, current), capped: d < windowStart };
}
