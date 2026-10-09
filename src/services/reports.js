// CSV export (backup / spreadsheets). Fetches every page (PostgREST caps a
// response at 1000 rows by default) and renders with utils/csv.js.
import { toCSV, downloadText } from '../utils/csv.js';
import {
  dayStartInstant, dayEndInstant, toLocalInput, daysBetween, dayOf, weekday, startOfMonth, endOfMonth, addMonths, diffDays,
} from '../utils/date.js';
import { db, run, invalid, vDay } from './errors.js';
import { productivity as productivityRpc } from './dashboard.js';
import { listKpis, progress as kpiForecastRpc } from './kpis.js';
import { listBudgets, resolveBudgets } from './budgets.js';

// Optional module built by another feature (notes). Resolved at build time to
// an empty object when the file does not exist, so reports keep working.
const NOTE_MODULES = import.meta.glob('./notes.js');

export const PAGE_SIZE = 1000;
const MAX_PAGES = 200; // 200k rows — safety stop

const TASK_STATUS_VI = { todo: 'Cần làm', in_progress: 'Đang làm', completed: 'Hoàn thành', cancelled: 'Đã hủy' };
const TASK_PRIORITY_VI = { low: 'Thấp', medium: 'Trung bình', high: 'Cao', urgent: 'Khẩn cấp' };
const PAYMENT_VI = { cash: 'Tiền mặt', bank: 'Chuyển khoản', credit_card: 'Thẻ tín dụng', e_wallet: 'Ví điện tử', other: 'Khác' };
const SOURCE_VI = { timer: 'Bấm giờ', manual: 'Nhập tay' };

const dt = (v) => (v ? toLocalInput(v).replace('T', ' ') : '');
const numStr = (v) => (v == null || v === '' ? '' : String(Number(v)));

/** Run `build()` (a fresh query each time) page by page until a short page. */
export async function fetchAll(build, pageSize = PAGE_SIZE) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * pageSize;
    const rows = (await run(build().range(from, from + pageSize - 1))) || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const KINDS = {
  tasks: {
    label: 'cong-viec',
    query: (c, from, to) => {
      let q = c.from('tasks').select('*, category:categories(name)');
      if (from) q = q.gte('created_at', dayStartInstant(from).toISOString());
      if (to) q = q.lt('created_at', dayEndInstant(to).toISOString());
      return q.order('created_at', { ascending: true }).order('id', { ascending: true });
    },
    columns: [
      { label: 'Tiêu đề', key: 'title' },
      { label: 'Mô tả', key: 'description' },
      { label: 'Trạng thái', value: (r) => TASK_STATUS_VI[r.status] ?? r.status },
      { label: 'Độ ưu tiên', value: (r) => TASK_PRIORITY_VI[r.priority] ?? r.priority },
      { label: 'Danh mục', value: (r) => r.category?.name ?? '' },
      { label: 'Thẻ', key: 'tags' },
      { label: 'Hạn chót', key: 'due_date' },
      { label: 'Ước tính (phút)', value: (r) => numStr(r.estimated_minutes) },
      { label: 'Thực tế (phút)', value: (r) => numStr(r.actual_minutes) },
      { label: 'Hoàn thành lúc', value: (r) => dt(r.completed_at) },
      { label: 'Tạo lúc', value: (r) => dt(r.created_at) },
    ],
  },
  expenses: {
    label: 'chi-tieu',
    query: (c, from, to) => {
      let q = c.from('expenses').select('id, amount, description, spent_on, payment_method, note, created_at, category:categories(name)');
      if (from) q = q.gte('spent_on', from);
      if (to) q = q.lte('spent_on', to);
      return q.order('spent_on', { ascending: true }).order('id', { ascending: true });
    },
    columns: [
      { label: 'Ngày', key: 'spent_on' },
      { label: 'Số tiền', value: (r) => numStr(r.amount) },
      { label: 'Danh mục', value: (r) => r.category?.name ?? '' },
      { label: 'Mô tả', key: 'description' },
      { label: 'Phương thức', value: (r) => PAYMENT_VI[r.payment_method] ?? r.payment_method },
      { label: 'Ghi chú', key: 'note' },
    ],
  },
  time: {
    label: 'thoi-gian',
    query: (c, from, to) => {
      let q = c.from('time_entries').select('id, started_at, ended_at, duration_seconds, description, source, task:tasks(title)');
      if (from) q = q.gte('started_at', dayStartInstant(from).toISOString());
      if (to) q = q.lt('started_at', dayEndInstant(to).toISOString());
      return q.order('started_at', { ascending: true }).order('id', { ascending: true });
    },
    columns: [
      { label: 'Bắt đầu', value: (r) => dt(r.started_at) },
      { label: 'Kết thúc', value: (r) => dt(r.ended_at) },
      { label: 'Thời lượng (phút)', value: (r) => (r.duration_seconds == null ? '' : String(Math.round(Number(r.duration_seconds) / 60))) },
      { label: 'Công việc', value: (r) => r.task?.title ?? '' },
      { label: 'Mô tả', key: 'description' },
      { label: 'Nguồn', value: (r) => SOURCE_VI[r.source] ?? r.source },
    ],
  },
  kpi_records: {
    label: 'kpi',
    query: (c, from, to) => {
      let q = c.from('kpi_records').select('id, recorded_on, value, note, kpi:kpis(name, unit)');
      if (from) q = q.gte('recorded_on', from);
      if (to) q = q.lte('recorded_on', to);
      return q.order('recorded_on', { ascending: true }).order('id', { ascending: true });
    },
    columns: [
      { label: 'KPI', value: (r) => r.kpi?.name ?? '' },
      { label: 'Đơn vị', value: (r) => r.kpi?.unit ?? '' },
      { label: 'Ngày', key: 'recorded_on' },
      { label: 'Giá trị', value: (r) => numStr(r.value) },
      { label: 'Ghi chú', key: 'note' },
    ],
  },
};

export const EXPORT_KINDS = Object.keys(KINDS);

/**
 * exportCsv(kind, {from, to}) → { filename, csv, count }
 * kind: 'tasks' | 'expenses' | 'time' | 'kpi_records'; from/to 'YYYY-MM-DD' (inclusive).
 */
export async function exportCsv(kind, { from, to } = {}) {
  const def = KINDS[kind];
  if (!def) throw invalid('kind', 'Loại dữ liệu xuất không hợp lệ.');
  const f = vDay(from, 'from', { label: 'Từ ngày' });
  const t = vDay(to, 'to', { label: 'Đến ngày' });
  if (f && t && t < f) throw invalid('to', 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
  const c = db();
  const rows = await fetchAll(() => def.query(c, f, t));
  const csv = toCSV(rows, def.columns);
  const range = f || t ? `_${f || 'dau'}_${t || 'nay'}` : '';
  return { filename: `${def.label}${range}.csv`, csv, count: rows.length };
}

/** Browser helper: export and trigger the download. Returns the row count. */
export async function downloadCsv(kind, range) {
  const { filename, csv, count } = await exportCsv(kind, range);
  downloadText(filename, csv);
  return count;
}

// ===========================================================================
// Period report (trang Báo cáo). Each section loads independently so a failing
// table/RPC only blanks its own section. Numbers are always JS numbers.
// ===========================================================================

const lo = (d) => dayStartInstant(d).toISOString();
const hi = (d) => dayEndInstant(d).toISOString();
const secsOf = (e) => (e.duration_seconds != null ? Number(e.duration_seconds) : e.ended_at ? (new Date(e.ended_at) - new Date(e.started_at)) / 1000 : 0);

async function fetchTaskRows(from, to) {
  const c = db();
  const a = lo(from), b = hi(to);
  return fetchAll(() => c.from('tasks')
    .select('id, status, due_date, created_at, completed_at')
    .or(`and(created_at.gte."${a}",created_at.lt."${b}"),and(completed_at.gte."${a}",completed_at.lt."${b}")`)
    .order('id', { ascending: true }));
}

async function fetchEntryRows(from, to) {
  const c = db();
  return fetchAll(() => c.from('time_entries')
    .select('id, task_id, started_at, ended_at, duration_seconds, task:tasks(category_id, category:categories(id, name, color))')
    .gte('started_at', lo(from)).lt('started_at', hi(to))
    .not('ended_at', 'is', null)
    .order('started_at', { ascending: true }).order('id', { ascending: true }));
}

/**
 * Pure mirror of SQL productivity_stats (migration 000500) — used when the RPC
 * is missing on the server or the range is longer than it accepts (366 days).
 * Rates are 0..1 like the RPC.
 */
export function computeProductivity(tasks, entries, from, to) {
  const days = daysBetween(from, to);
  const cnt = Object.fromEntries(days.map((d) => [d, 0]));
  const secs = Object.fromEntries(days.map((d) => [d, 0]));
  const inR = (d) => d >= from && d <= to;
  const done = (tasks || [])
    .filter((t) => t.status === 'completed' && t.completed_at)
    .map((t) => ({ ...t, d: dayOf(t.completed_at) }))
    .filter((t) => inR(t.d));
  done.forEach((t) => { cnt[t.d] += 1; });
  const cats = new Map();
  (entries || []).forEach((e) => {
    if (!e.ended_at) return;
    const d = dayOf(e.started_at);
    if (!(d in secs)) return;
    const s = secsOf(e);
    secs[d] += s;
    const cat = e.task?.category || null;
    const k = cat?.id ?? null;
    const cur = cats.get(k) || { category_id: k, name: cat?.name ?? null, color: cat?.color ?? null, secs: 0 };
    cur.secs += s;
    cats.set(k, cur);
  });
  const created = (tasks || []).filter((t) => t.status !== 'cancelled' && t.created_at && inR(dayOf(t.created_at)));
  const withDue = done.filter((t) => t.due_date);
  const wd = Array.from({ length: 7 }, (_, dow) => ({ dow, cnt: 0, secs: 0 }));
  days.forEach((d) => { const w = wd[weekday(d)]; w.cnt += cnt[d]; w.secs += secs[d]; });
  const busiest = wd.filter((w) => w.cnt > 0 || w.secs > 0).sort((a, b) => b.cnt - a.cnt || b.secs - a.secs || a.dow - b.dow)[0];
  const cycle = done.map((t) => (new Date(t.completed_at) - new Date(t.created_at)) / 3600000).filter((h) => Number.isFinite(h));
  return {
    completed_by_day: days.map((d) => ({ day: d, count: cnt[d] })),
    minutes_by_day: days.map((d) => ({ day: d, minutes: Math.round(secs[d] / 60) })),
    minutes_by_category: [...cats.values()]
      .sort((a, b) => b.secs - a.secs)
      .map((c) => ({ category_id: c.category_id, name: c.name, color: c.color, minutes: Math.round(c.secs / 60) })),
    completion_rate: created.length ? created.filter((t) => t.status === 'completed').length / created.length : null,
    on_time_rate: withDue.length ? withDue.filter((t) => t.d <= t.due_date).length / withDue.length : null,
    avg_cycle_hours: cycle.length ? Math.round((cycle.reduce((s, h) => s + h, 0) / cycle.length) * 10) / 10 : null,
    busiest_weekday: busiest ? busiest.dow : null,
  };
}

/** productivity_stats for one range; computed locally when the RPC cannot answer. */
export async function productivityFor(from, to) {
  const f = vDay(from, 'from', { required: true, label: 'Từ ngày' });
  const t = vDay(to, 'to', { required: true, label: 'Đến ngày' });
  if (diffDays(t, f) + 1 <= 366) {
    try {
      return { ...(await productivityRpc(f, t)), source: 'rpc' };
    } catch (e) {
      if (!['feature_unavailable', 'invalid_input', 'schema_missing'].includes(e?.code)) throw e;
    }
  }
  const [tasks, entries] = await Promise.all([fetchTaskRows(f, t), fetchEntryRows(f, t)]);
  return { ...computeProductivity(tasks, entries, f, t), source: 'local' };
}

/** { cur, prev } productivity for the period and its comparison period. */
export async function productivityReport({ from, to, prevFrom, prevTo }) {
  const [cur, prev] = await Promise.all([productivityFor(from, to), prevFrom ? productivityFor(prevFrom, prevTo) : null]);
  return { cur, prev };
}

async function fetchExpenseRows(from, to) {
  const c = db();
  const rows = await fetchAll(() => c.from('expenses')
    .select('id, amount, category_id, description, spent_on, payment_method, note, category:categories(name, color)')
    .gte('spent_on', from).lte('spent_on', to)
    .order('spent_on', { ascending: true }).order('id', { ascending: true }));
  return rows.map((r) => ({ ...r, amount: Number(r.amount) || 0 }));
}

/** Budget of an arbitrary range: carry-forward monthly budgets pro-rated by covered days. */
export function budgetForRange(budgetRows, from, to) {
  let overall = null;
  const byCategory = new Map();
  for (let m = startOfMonth(from); m <= to; m = addMonths(m, 1)) {
    const res = resolveBudgets(budgetRows, m);
    const mEnd = endOfMonth(m);
    const a = from > m ? from : m;
    const b = to < mEnd ? to : mEnd;
    const f = (diffDays(b, a) + 1) / (diffDays(mEnd, m) + 1);
    if (res.overall != null && res.overall > 0) overall = (overall ?? 0) + res.overall * f;
    res.byCategory.forEach((v, k) => { if (v > 0) byCategory.set(k, (byCategory.get(k) ?? 0) + v * f); });
  }
  return { overall, byCategory };
}

/**
 * Finance of the period: totals, by category (+ previous period), by day,
 * top 10 expenses and budget adherence (budgets pro-rated to the range).
 */
export async function financeReport({ from, to, prevFrom, prevTo }) {
  const start = prevFrom && prevFrom < from ? prevFrom : from;
  const [rows, budgetRows, catRows] = await Promise.all([
    fetchExpenseRows(start, to),
    listBudgets().catch(() => []),
    // Names for categories that only appear through a budget (no expense in range).
    run(db().from('categories').select('id, name, color').eq('kind', 'expense')).catch(() => []),
  ]);
  const catInfo = new Map((catRows || []).map((c) => [c.id, c]));
  const cur = rows.filter((r) => r.spent_on >= from && r.spent_on <= to);
  const prev = prevFrom ? rows.filter((r) => r.spent_on >= prevFrom && r.spent_on <= prevTo) : [];
  const sum = (list) => list.reduce((s, r) => s + r.amount, 0);
  const total = sum(cur);
  const prevTotal = sum(prev);

  const cats = new Map();
  const touch = (k, r) => {
    if (!cats.has(k)) {
      const info = r?.category || (k != null ? catInfo.get(k) : null) || null;
      cats.set(k, { category_id: k, name: info?.name ?? null, color: info?.color ?? null, total: 0, count: 0, prev_total: 0, budget: null });
    }
    return cats.get(k);
  };
  cur.forEach((r) => { const c = touch(r.category_id ?? null, r); c.total += r.amount; c.count += 1; });
  prev.forEach((r) => { touch(r.category_id ?? null, r).prev_total += r.amount; });

  const budget = budgetForRange(budgetRows, from, to);
  budget.byCategory.forEach((v, k) => { touch(k, null).budget = v; });

  const days = daysBetween(from, to);
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  cur.forEach((r) => { if (r.spent_on in byDay) byDay[r.spent_on] += r.amount; });
  const prevDays = prevFrom ? daysBetween(prevFrom, prevTo) : [];
  const prevByDay = Object.fromEntries(prevDays.map((d) => [d, 0]));
  prev.forEach((r) => { if (r.spent_on in prevByDay) prevByDay[r.spent_on] += r.amount; });

  return {
    total,
    count: cur.length,
    daily_avg: days.length ? total / days.length : 0,
    prev_total: prevTotal,
    prev_count: prev.length,
    change_pct: prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
    by_category: [...cats.values()]
      .map((c) => ({ ...c, pct: total > 0 ? (c.total / total) * 100 : 0 }))
      .sort((a, b) => b.total - a.total || (b.budget ?? 0) - (a.budget ?? 0)),
    by_day: days.map((d) => ({ day: d, total: byDay[d] })),
    prev_by_day: prevDays.map((d) => ({ day: d, total: prevByDay[d] })),
    top: [...cur].sort((a, b) => b.amount - a.amount || (a.spent_on < b.spent_on ? 1 : -1)).slice(0, 10),
    budget: { overall: budget.overall, has_any: budget.overall != null || budget.byCategory.size > 0 },
    rows: cur,
  };
}

/** KPI progress plus what changed inside the period. Archived KPIs are left out. */
export async function kpiReport({ from, to }) {
  const c = db();
  const [kpis, records, forecast] = await Promise.all([
    listKpis(),
    fetchAll(() => c.from('kpi_records').select('id, kpi_id, recorded_on, value, created_at')
      .lte('recorded_on', to)
      .order('recorded_on', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })),
    kpiForecastRpc().catch(() => []),
  ]);
  const fc = new Map((forecast || []).map((f) => [f.kpi_id, f]));
  const byKpi = new Map();
  for (const r of records) {
    if (!byKpi.has(r.kpi_id)) byKpi.set(r.kpi_id, []);
    byKpi.get(r.kpi_id).push({ ...r, value: Number(r.value) });
  }
  return (kpis || [])
    .filter((k) => k.status !== 'archived')
    .map((k) => {
      const recs = byKpi.get(k.id) || [];
      const before = recs.filter((r) => r.recorded_on < from).at(-1) || null;
      const inside = recs.filter((r) => r.recorded_on >= from);
      const end = inside.at(-1) || before;
      const f = fc.get(k.id) || null;
      const target = Number(k.target_value) || 0;
      return {
        ...k,
        progress: target > 0 ? (Number(k.current_value) / target) * 100 : 0,
        records_in_period: inside.length,
        start_value: before ? before.value : null,
        end_value: end ? end.value : null,
        change: inside.length ? (end?.value ?? 0) - (before?.value ?? 0) : 0,
        forecast_status: f?.status ?? null,
        projected_value: f?.projected_value ?? null,
        projected_completion: f?.projected_completion ?? null,
        expected_pct: f?.expected_pct ?? null,
      };
    });
}

/**
 * Notes created in the period (and the previous one). Returns null when the
 * notes feature/table is unavailable — reports never fail because of it.
 */
export async function notesReport({ from, to, prevFrom, prevTo }) {
  const load = NOTE_MODULES['./notes.js'];
  if (!load) return null;
  try {
    const mod = await load();
    if (typeof mod.listNotes !== 'function') return null;
    // archived: null → active + archived notes (trash excluded).
    // light: counts and titles only — never download every note's body.
    const lists = [await mod.listNotes({ limit: 2000, archived: null, light: true })];
    const seen = new Map();
    lists.flat().forEach((n) => { if (n && n.id != null && n.created_at) seen.set(n.id, n); });
    const all = [...seen.values()];
    const within = (a, b) => all.filter((n) => { const d = dayOf(n.created_at); return d >= a && d <= b; });
    const cur = within(from, to);
    const days = daysBetween(from, to);
    const byDay = Object.fromEntries(days.map((d) => [d, 0]));
    cur.forEach((n) => { const d = dayOf(n.created_at); if (d in byDay) byDay[d] += 1; });
    return {
      count: cur.length,
      prev: prevFrom ? within(prevFrom, prevTo).length : null,
      total: all.length,
      by_day: days.map((d) => ({ day: d, count: byDay[d] })),
      latest: [...cur]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 5)
        .map((n) => ({ id: n.id, title: n.title || '', created_at: n.created_at })),
    };
  } catch {
    return null;
  }
}
