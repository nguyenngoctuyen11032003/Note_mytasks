// Focus score — client mirror of SQL `focus_tasks` (migration 000300).
//
//   priority : urgent 40, high 28, medium 16, low/other 6
//   due      : overdue 30 + min(days_overdue*2, 20); today 30; tomorrow 22;
//              2–3 days 15; 4–7 days 8; later / none 0
//   in_progress +10 ; quick win (0 < estimated_minutes <= 30) +5 ;
//   stale (created more than 14 user-days ago) +5
//
// Only open tasks (todo / in_progress) are scored; other statuses → {score: 0, reasons: []}.
// `reasons` follow the canonical order emitted by SQL focus_tasks (000300):
// overdue, due_today, due_tomorrow, due_soon (2–7 days), priority_urgent, priority_high,
// in_progress, quick_win, stale. (Medium/low priority and far due dates add points
// but have no reason code, as in SQL.)

import { diffDays, dayOf } from '../../utils/date.js';
import { resolveToday, isIsoDay } from './text.js';

const PRIORITY_POINTS = { urgent: 40, high: 28, medium: 16, low: 6 };
export const REASON_ORDER = [
  'overdue', 'due_today', 'due_tomorrow', 'due_soon',
  'priority_urgent', 'priority_high', 'in_progress', 'quick_win', 'stale',
];

function toDay(v) {
  if (v == null || v === '') return null;
  if (isIsoDay(v)) return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && v.length === 10) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : dayOf(d); // timestamptz → user-tz day
}

/**
 * @param {{priority?, due_date?, status?, estimated_minutes?, created_at?}} task
 * @param {string|Date} [today] 'YYYY-MM-DD'; defaults to the user's current day.
 * @returns {{score: number, reasons: string[]}}
 */
export function focusScore(task, today) {
  const t = resolveToday(today);
  if (!task || !['todo', 'in_progress'].includes(task.status ?? 'todo')) return { score: 0, reasons: [] };

  const parts = []; // [reason|null, points]
  parts.push([
    task.priority === 'urgent' ? 'priority_urgent' : task.priority === 'high' ? 'priority_high' : null,
    PRIORITY_POINTS[task.priority] ?? 6,
  ]);

  const due = toDay(task.due_date);
  if (due) {
    const left = diffDays(due, t);
    if (left < 0) parts.push(['overdue', 30 + Math.min(-left * 2, 20)]);
    else if (left === 0) parts.push(['due_today', 30]);
    else if (left === 1) parts.push(['due_tomorrow', 22]);
    else if (left <= 3) parts.push(['due_soon', 15]);
    else if (left <= 7) parts.push(['due_soon', 8]);
  }
  if (task.status === 'in_progress') parts.push(['in_progress', 10]);
  const est = Number(task.estimated_minutes);
  if (task.estimated_minutes != null && est > 0 && est <= 30) parts.push(['quick_win', 5]);
  const created = toDay(task.created_at);
  if (created && diffDays(t, created) > 14) parts.push(['stale', 5]);

  const score = parts.reduce((s, [, p]) => s + p, 0);
  const reasons = parts
    .filter(([r]) => r)
    .sort((a, b) => REASON_ORDER.indexOf(a[0]) - REASON_ORDER.indexOf(b[0]))
    .map(([r]) => r);
  return { score, reasons };
}
