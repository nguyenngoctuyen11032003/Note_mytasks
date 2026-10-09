// Actionable Vietnamese insights from the dashboard RPC payloads (contract §2/§3).
//
//   buildInsights({ summary, budgets, kpis, anomalies, productivity, spending, limit })
//     summary      : dashboard_summary() jsonb
//     budgets      : budget_status() rows
//     kpis         : kpi_progress() rows
//     anomalies    : expense_anomalies() rows
//     productivity : productivity_stats() jsonb
//     spending     : spending_summary() jsonb (optional; for change_pct)
//   → [{ id, severity: 'critical'|'warning'|'success'|'info', title, detail, action? }]
//
// All inputs are optional. Sorted critical > warning > success > info (then by internal
// importance), deduplicated by id, max `limit` (default 6). Rates (on_time_rate,
// completion_rate) may be 0–1 or 0–100; change_pct is a percentage (35 = +35%).
// When more than 2 categories/KPIs/anomalies share a state they are grouped into one
// insight to leave room for other signals.
//
// Robustness: never throws on malformed input, and texts never contain null/undefined/
// NaN/Infinity. Percentages are clamped to 0–999%, counts rounded, money shown ≥ 0.
// A budget is "over" only when spent > budget (a stale status 'over' is ignored).
// Anomalies need amount > 0 and, when a baseline is known, a ratio > 1. Rows without
// expense_id / kpi_id get stable index-based ids ("anomaly_i0", "kpi_achieved_i1").

import { money as fmtMoney, pct as fmtPct } from '../../utils/format.js';

const SEVERITY_RANK = { critical: 0, warning: 1, success: 2, info: 3 };
const STREAK_MILESTONES = [30, 7, 3];
const ROUTES = {
  overdue: '#/tasks?filter=overdue',
  today: '#/tasks?filter=today',
  tasks: '#/tasks',
  expenses: '#/expenses',
  budgets: '#/expenses?tab=budgets',
  kpi: '#/kpi',
  reports: '#/reports',
};

const n = (v) => (v == null || v === '' || typeof v === 'object' || !Number.isFinite(Number(v)) ? null : Number(v));
const asRate = (v) => { const x = n(v); return x == null ? null : x > 1 ? x / 100 : x; };
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** Non-negative rounded count (null/garbage → 0). */
const count = (v) => Math.max(0, Math.round(n(v) || 0));
/** Percentage text clamped to 0–999%. */
const pct = (v) => fmtPct(Math.min(999, Math.max(0, n(v) || 0)));
/** Money text, never negative. */
const money = (v) => fmtMoney(Math.max(0, n(v) || 0));
/** Printable string ('' for null/objects). */
const str = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());
const catName = (r) => str(r.category_name) || str(r.name) || 'Không tên';
const kpiName = (r) => str(r.name) || 'KPI không tên';
const kpiLabel = (r) => (str(r.name) ? `KPI "${str(r.name)}"` : 'KPI không tên');
/** 'YYYY-MM-DD…' → 'DD/MM/YYYY'; anything else → null. */
const viDate = (v) => {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};
const list = (rows, k = 3) => {
  const names = rows.slice(0, k).map(catName);
  return rows.length > k ? `${names.join(', ')} và ${rows.length - k} mục khác` : names.join(', ');
};

function tasksInsights(summary, out) {
  const t = summary?.tasks;
  if (!isObj(t)) return;
  const overdue = count(t.overdue);
  const dueToday = count(t.due_today);
  if (overdue > 0) {
    out.push({
      id: 'tasks_overdue', severity: overdue >= 5 ? 'critical' : 'warning', rank: 0,
      title: `${overdue} công việc quá hạn`,
      detail: 'Xử lý hoặc dời hạn để danh sách việc phản ánh đúng thực tế.',
      action: { label: 'Xem việc quá hạn', route: ROUTES.overdue },
    });
  }
  if (dueToday > 0) {
    out.push({
      id: 'tasks_due_today', severity: 'info', rank: 1,
      title: `${dueToday} việc đến hạn hôm nay`,
      detail: 'Ưu tiên hoàn thành các việc này trước khi bắt đầu việc mới.',
      action: { label: 'Xem hôm nay', route: ROUTES.today },
    });
  }
  const done = count(t.completed_today);
  if (done >= 5 && overdue === 0) {
    out.push({
      id: 'tasks_productive_day', severity: 'success', rank: 5,
      title: `Đã xong ${done} việc hôm nay`,
      detail: 'Ngày làm việc hiệu quả — không còn việc quá hạn.',
    });
  }
}

function budgetInsights(summary, budgets, out) {
  const rows = Array.isArray(budgets) ? budgets.filter(isObj) : [];
  const total = rows.find((r) => r.category_id == null);
  const cats = rows.filter((r) => r.category_id != null && str(r.category_id) && n(r.budget) > 0);

  // monthly total: prefer the budget_status total row, else dashboard money block
  let tb = null;
  if (total && n(total.budget) > 0) {
    tb = { budget: n(total.budget), spent: n(total.spent) || 0, projected: n(total.projected) };
  } else if (isObj(summary?.money) && n(summary.money.month_budget) > 0) {
    const m = summary.money;
    tb = { budget: n(m.month_budget), spent: n(m.month_spent) || 0, projected: n(m.month_projected) };
  }
  if (tb) {
    const usedPct = (tb.spent / tb.budget) * 100;
    if (tb.spent > tb.budget) {
      out.push({
        id: 'budget_over_total', severity: 'critical', rank: 0,
        title: 'Đã vượt ngân sách tháng',
        detail: `Đã chi ${money(tb.spent)} / ${money(tb.budget)} (vượt ${money(tb.spent - tb.budget)}).`,
        action: { label: 'Xem ngân sách', route: ROUTES.budgets },
      });
    } else if (usedPct >= 80) {
      out.push({
        id: 'budget_warning_total', severity: 'warning', rank: 1,
        title: `Đã dùng ${pct(usedPct)} ngân sách tháng`,
        detail: `Còn lại ${money(tb.budget - tb.spent)} cho phần còn lại của tháng.`,
        action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
      });
    } else if (tb.projected != null && tb.projected > tb.budget) {
      out.push({
        id: 'budget_projected_total', severity: 'warning', rank: 2,
        title: 'Dự kiến vượt ngân sách tháng',
        detail: `Với tốc độ hiện tại, cuối tháng sẽ chi khoảng ${money(tb.projected)} (ngân sách ${money(tb.budget)}).`,
        action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
      });
    }
  }

  const over = cats.filter((r) => (n(r.spent) || 0) > n(r.budget));
  const warn = cats.filter((r) => !over.includes(r) && (r.status === 'warning' ||
    (n(r.spent) || 0) >= 0.8 * n(r.budget) || (n(r.projected) ?? 0) > n(r.budget)));

  if (over.length > 2) {
    out.push({
      id: 'budget_over_many', severity: 'critical', rank: 1,
      title: `${over.length} danh mục vượt ngân sách`,
      detail: `${list(over)}.`,
      action: { label: 'Xem ngân sách', route: ROUTES.budgets },
    });
  } else {
    for (const r of over) {
      out.push({
        id: `budget_over_${str(r.category_id)}`, severity: 'critical', rank: 1,
        title: `Vượt ngân sách ${catName(r)}`,
        detail: `Đã chi ${money(r.spent)} / ${money(r.budget)} (vượt ${money(n(r.spent) - n(r.budget))}).`,
        action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
      });
    }
  }
  if (warn.length > 2) {
    out.push({
      id: 'budget_warning_many', severity: 'warning', rank: 3,
      title: `${warn.length} danh mục sắp chạm ngân sách`,
      detail: `${list(warn)}.`,
      action: { label: 'Xem ngân sách', route: ROUTES.budgets },
    });
  } else {
    for (const r of warn) {
      const spent = n(r.spent) || 0, budget = n(r.budget), projected = n(r.projected);
      const nearly = spent >= 0.8 * budget || projected == null || projected <= budget;
      out.push({
        id: `budget_warning_${str(r.category_id)}`, severity: 'warning', rank: 3,
        title: nearly ? `${catName(r)}: đã dùng ${pct((spent / budget) * 100)} ngân sách` : `${catName(r)}: dự kiến vượt ngân sách`,
        detail: nearly
          ? `Còn ${money(budget - spent)} trong tháng.`
          : `Dự kiến chi ${money(projected)} so với ngân sách ${money(budget)}.`,
        action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
      });
    }
  }
}

function kpiInsights(summary, kpis, out) {
  const rows = Array.isArray(kpis) ? kpis.filter(isObj) : null;
  if (!rows) {
    const k = summary?.kpis;
    if (!isObj(k)) return;
    if (count(k.off_track) > 0) {
      out.push({
        id: 'kpi_off_track_count', severity: 'warning', rank: 4,
        title: `${count(k.off_track)} KPI đang chệch mục tiêu`,
        detail: 'Xem lại kế hoạch hoặc điều chỉnh mục tiêu.',
        action: { label: 'Xem KPI', route: ROUTES.kpi },
      });
    } else if (count(k.at_risk) > 0) {
      out.push({
        id: 'kpi_at_risk_count', severity: 'warning', rank: 5,
        title: `${count(k.at_risk)} KPI có nguy cơ không đạt`,
        detail: 'Tăng tốc một chút để kịp mục tiêu.',
        action: { label: 'Xem KPI', route: ROUTES.kpi },
      });
    }
    return;
  }
  const indexed = rows.map((r, i) => ({ r, key: str(r.kpi_id) || `i${i}` }));
  const by = (s) => indexed.filter((x) => x.r.status === s);
  const withUnit = (v, r) => `${v.toLocaleString('vi-VN')}${str(r.unit) ? ' ' + str(r.unit) : ''}`;
  const groups = [
    ['off_track', 'warning', 4, (r) => `${kpiLabel(r)} đang chệch mục tiêu`,
      (r) => `Tiến độ ${pct(r.progress_pct)} trong khi thời gian đã trôi ${pct(r.expected_pct)}.`,
      (c) => `${c} KPI đang chệch mục tiêu`],
    ['at_risk', 'warning', 5, (r) => `${kpiLabel(r)} có nguy cơ không đạt`,
      (r) => {
        const proj = n(r.projected_value), target = n(r.target_value);
        if (proj != null && target != null) return `Dự báo đạt ${withUnit(proj, r)} / mục tiêu ${withUnit(target, r)}.`;
        if (proj != null) return `Dự báo đạt ${withUnit(proj, r)}.`;
        return `Tiến độ hiện tại ${pct(r.progress_pct)}.`;
      },
      (c) => `${c} KPI có nguy cơ không đạt`],
    ['achieved', 'success', 1, (r) => `Đã đạt ${kpiLabel(r)}`,
      () => 'Chúc mừng! Hãy đặt mục tiêu tiếp theo.',
      (c) => `Đã đạt ${c} KPI`],
  ];
  for (const [status, severity, rank, title, detail, groupTitle] of groups) {
    const g = by(status);
    if (!g.length) continue;
    if (g.length > 2) {
      out.push({
        id: `kpi_${status}_many`, severity, rank, title: groupTitle(g.length),
        detail: `${g.slice(0, 3).map((x) => kpiName(x.r)).join(', ')}${g.length > 3 ? '…' : ''}`,
        action: { label: 'Xem KPI', route: ROUTES.kpi },
      });
    } else {
      for (const { r, key } of g) {
        out.push({
          id: `kpi_${status}_${key}`, severity, rank, title: title(r), detail: detail(r),
          action: { label: 'Xem KPI', route: ROUTES.kpi },
        });
      }
    }
  }
}

function anomalyInsights(anomalies, out) {
  const ratioOf = (a) => (n(a.baseline) > 0 ? n(a.amount) / n(a.baseline) : null);
  const rows = (Array.isArray(anomalies) ? anomalies : [])
    .map((a, i) => (isObj(a) ? { a, key: str(a.expense_id) || `i${i}` } : null))
    .filter((x) => {
      if (!x || !(n(x.a.amount) > 0)) return false;
      const ratio = ratioOf(x.a);
      return ratio == null || ratio > 1; // at/below the usual level is not an anomaly
    });
  if (!rows.length) return;
  const describe = (a) => {
    const ratio = ratioOf(a);
    const cat = str(a.category_name) || 'danh mục';
    const what = str(a.description) || str(a.category_name) || 'Khoản chi';
    const day = viDate(a.spent_on);
    return {
      title: `Chi tiêu bất thường: ${what} ${money(a.amount)}`,
      detail: ratio
        ? `Cao gấp ${Math.min(ratio, 999).toFixed(1).replace('.', ',')} lần mức thường của ${cat} (${money(a.baseline)})${day ? `, ngày ${day}` : ''}.`
        : `Cao bất thường so với lịch sử ${cat}.`,
    };
  };
  if (rows.length > 2) {
    const top = rows.map((x) => x.a).sort((a, b) => n(b.amount) - n(a.amount))[0];
    out.push({
      id: 'anomaly_many', severity: 'warning', rank: 6,
      title: `${rows.length} khoản chi bất thường gần đây`,
      detail: `Lớn nhất: ${str(top.description) || str(top.category_name) || 'khoản chi'} ${money(top.amount)}.`,
      action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
    });
    return;
  }
  for (const { a, key } of rows) {
    out.push({
      id: `anomaly_${key}`, severity: 'warning', rank: 6, ...describe(a),
      action: { label: 'Xem chi tiêu', route: ROUTES.expenses },
    });
  }
}

function streakInsights(summary, out) {
  const s = summary?.streak;
  if (!isObj(s)) return;
  const cur = count(s.current);
  const m = STREAK_MILESTONES.find((x) => cur >= x);
  if (!m) return;
  const longest = count(s.longest);
  out.push({
    id: `streak_${m}`, severity: 'success', rank: 0,
    title: `Chuỗi ${cur} ngày liên tục!`,
    detail: cur >= longest && cur > 0
      ? 'Đây là chuỗi dài nhất của bạn — giữ vững nhé.'
      : `Kỷ lục của bạn là ${longest} ngày. Tiếp tục để phá kỷ lục.`,
  });
}

function productivityInsights(productivity, out) {
  if (!isObj(productivity)) return;
  const onTime = asRate(productivity.on_time_rate);
  if (onTime != null && onTime < 0.6) {
    out.push({
      id: 'on_time_low', severity: onTime < 0.4 ? 'warning' : 'info', rank: 7,
      title: `Chỉ ${pct(onTime * 100)} việc hoàn thành đúng hạn`,
      detail: 'Thử ước lượng thời gian sát hơn hoặc đặt hạn thực tế hơn.',
      action: { label: 'Xem công việc', route: ROUTES.tasks },
    });
  } else if (onTime != null && onTime >= 0.9) {
    out.push({
      id: 'on_time_high', severity: 'success', rank: 3,
      title: `${pct(onTime * 100)} việc hoàn thành đúng hạn`,
      detail: 'Bạn đang kiểm soát thời hạn rất tốt.',
    });
  }
}

function spendingInsights(summary, spending, out) {
  const sp = isObj(spending) ? spending : null;
  const nested = isObj(summary?.spending) ? summary.spending.change_pct : undefined;
  const change = n(sp?.change_pct ?? nested ?? summary?.change_pct);
  if (change == null) return;
  if (change >= 25) {
    const total = n(sp?.total), prev = n(sp?.prev_total);
    out.push({
      id: 'spending_rise', severity: change >= 50 ? 'warning' : 'info', rank: 8,
      title: `Chi tiêu tăng ${pct(change)} so với kỳ trước`,
      detail: total != null && prev != null && total >= 0 && prev >= 0
        ? `${money(total)} so với ${money(prev)} kỳ trước.`
        : 'Kiểm tra các danh mục tăng mạnh nhất.',
      action: { label: 'Xem báo cáo', route: ROUTES.reports },
    });
  } else if (change <= -20) {
    out.push({
      id: 'spending_drop', severity: 'success', rank: 4,
      title: `Chi tiêu giảm ${pct(-change)} so với kỳ trước`,
      detail: 'Bạn đang tiết kiệm tốt hơn.',
    });
  }
}

/** @returns {Array<{id, severity, title, detail, action?}>} */
export function buildInsights(input) {
  const { summary: rawSummary, budgets, kpis, anomalies, productivity, spending, limit: rawLimit } = isObj(input) ? input : {};
  const summary = isObj(rawSummary) ? rawSummary : undefined;
  const limit = n(rawLimit) != null && n(rawLimit) >= 0 ? Math.floor(n(rawLimit)) : 6;
  const out = [];
  tasksInsights(summary, out);
  budgetInsights(summary, budgets, out);
  kpiInsights(summary, kpis, out);
  anomalyInsights(anomalies, out);
  streakInsights(summary, out);
  productivityInsights(productivity, out);
  spendingInsights(summary, spending, out);

  const seen = new Set();
  return out
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rank - b.rank || a.i - b.i)
    .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
    .slice(0, limit)
    .map(({ rank, i, ...x }) => x);
}
