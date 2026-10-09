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
