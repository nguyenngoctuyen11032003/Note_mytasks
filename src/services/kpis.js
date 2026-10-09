// KPIs. current_value is owned by the kpi_records trigger (latest snapshot)
// and is never sent. A record is a snapshot of the actual value, not a delta.
import {
  db, run, rpc, invalid, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vDay, numify,
} from './errors.js';

export const KPI_STATUSES = ['active', 'completed', 'paused', 'archived'];
/** Columns of the security_invoker VIEW public.kpi_progress. */
export const KPI_VIEW_COLS =
  'id, name, description, unit, target_value, current_value, start_date, end_date, status, progress_percent, days_left, last_recorded_on, record_count, created_at, updated_at';
export const KPI_COLS = 'id, name, description, unit, target_value, current_value, start_date, end_date, status, created_at, updated_at';
export const RECORD_COLS = 'id, kpi_id, recorded_on, value, note, created_at, updated_at';
export const KPI_WRITABLE = ['name', 'description', 'unit', 'target_value', 'start_date', 'end_date', 'status'];
export const RECORD_WRITABLE = ['recorded_on', 'value', 'note'];
const MAX_VALUE = 9_999_999_999_999_999.99; // numeric(18,2)

export function validateKpi(input, { partial = false } = {}) {
  const p = pick(input, KPI_WRITABLE);
  if (!partial || 'name' in p) p.name = vText(p.name, 'name', { required: true, max: 120, label: 'Tên KPI' });
  if ('description' in p) p.description = vText(p.description, 'description', { max: 2000, label: 'Mô tả' });
  // unit is NOT NULL DEFAULT '' → keep '' instead of null.
  if ('unit' in p) p.unit = vText(p.unit, 'unit', { max: 20, label: 'Đơn vị', keepEmpty: true });
  if (!partial || 'target_value' in p) {
    p.target_value = vNumber(p.target_value, 'target_value', { required: true, gt: 0, max: MAX_VALUE, label: 'Mục tiêu' });
  }
  if ('start_date' in p) p.start_date = vDay(p.start_date, 'start_date', { required: true, label: 'Ngày bắt đầu' });
  if ('end_date' in p) p.end_date = vDay(p.end_date, 'end_date', { label: 'Ngày kết thúc' });
  if (p.start_date && p.end_date && p.end_date < p.start_date) {
    throw invalid('end_date', 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
  }
  if ('status' in p) p.status = vEnum(p.status, 'status', KPI_STATUSES, { required: true, label: 'Trạng thái' });
  return p;
}

export function validateRecord(input, { partial = false } = {}) {
  const p = pick(input, RECORD_WRITABLE);
  if ('recorded_on' in p) p.recorded_on = vDay(p.recorded_on, 'recorded_on', { required: true, label: 'Ngày ghi nhận' });
  if (!partial || 'value' in p) p.value = vNumber(p.value, 'value', { required: true, min: -MAX_VALUE, max: MAX_VALUE, label: 'Giá trị' });
  if ('note' in p) p.note = vText(p.note, 'note', { max: 1000, label: 'Ghi chú' });
  return p;
}

const NUM_KPI = ['target_value', 'current_value', 'progress_percent', 'days_left', 'record_count'];
const normKpi = (rows) => numify(rows, NUM_KPI);
const normRec = (rows) => numify(rows, ['value']);

/** KPIs with progress (from VIEW kpi_progress). */
export async function listKpis({ status } = {}) {
  let q = db().from('kpi_progress').select(KPI_VIEW_COLS);
  if (Array.isArray(status)) {
    if (status.length) q = q.in('status', status);
  } else if (status) q = q.eq('status', status);
  return normKpi(await run(q.order('status').order('created_at', { ascending: false })));
}

export async function createKpi(input) {
  const row = validateKpi(input);
  return normKpi(await run(db().from('kpis').insert(row).select(KPI_COLS).single()));
}

export async function updateKpi(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateKpi(patch, { partial: true }));
  // Only one bound sent: check it against the stored other bound so the error
  // names the field (the DB CHECK would only say "invalid input").
  if (('end_date' in row && row.end_date && !('start_date' in row)) || ('start_date' in row && !('end_date' in row))) {
    const cur = await run(db().from('kpis').select('start_date, end_date').eq('id', id).maybeSingle());
    if (cur) {
      const start = row.start_date ?? cur.start_date;
      const end = 'end_date' in row ? row.end_date : cur.end_date;
      if (start && end && end < start) {
        throw 'end_date' in row
          ? invalid('end_date', 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.')
          : invalid('start_date', 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
      }
    }
  }
  return normKpi(await run(db().from('kpis').update(row).eq('id', id).select(KPI_COLS).single()));
}

export async function deleteKpi(id) {
  requireId(id);
  await run(db().from('kpis').delete().eq('id', id));
  return true;
}

const PAGE = 1000; // PostgREST max_rows

export async function listRecords(kpiId) {
  requireId(kpiId, 'kpi_id');
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const q = db().from('kpi_records').select(RECORD_COLS).eq('kpi_id', kpiId)
      .order('recorded_on', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = (await run(q)) || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return normRec(out);
}

/**
 * addRecord(kpiId, {recorded_on, value, note})
 * Compat form: addRecord({kpi_id, recorded_on, value, note}).
 */
export async function addRecord(kpiId, input) {
  if (kpiId && typeof kpiId === 'object') {
    input = kpiId;
    kpiId = kpiId.kpi_id;
  }
  requireId(kpiId, 'kpi_id');
  const row = { kpi_id: kpiId, ...validateRecord(input) };
  return normRec(await run(db().from('kpi_records').insert(row).select(RECORD_COLS).single()));
}

/** All records (optionally since a day) — for charts. */
const REC_PAGE = 1000; // PostgREST max_rows
const REC_CAP = 10000;
export async function listAllRecords(sinceDay) {
  let q = db().from('kpi_records').select(RECORD_COLS);
  if (sinceDay) q = q.gte('recorded_on', vDay(sinceDay, 'sinceDay'));
  // Newest first so a cap would drop the oldest history, never the latest snapshot.
  q = q.order('recorded_on', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: true });
  // PostgREST caps each response at max_rows: page so nothing is silently dropped.
  const out = [];
  while (out.length < REC_CAP) {
    const want = Math.min(REC_PAGE, REC_CAP - out.length);
    const rows = (await run(q.range(out.length, out.length + want - 1))) || [];
    out.push(...rows);
    if (rows.length < want) break;
  }
  return normRec(out.reverse());
}

export async function updateRecord(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateRecord(patch, { partial: true }));
  return normRec(await run(db().from('kpi_records').update(row).eq('id', id).select(RECORD_COLS).single()));
}

export async function deleteRecord(id) {
  requireId(id);
  await run(db().from('kpi_records').delete().eq('id', id));
  return true;
}

/** Forecast (RPC kpi_forecast). kpiId null = all active KPIs. */
export async function progress(kpiId = null) {
  const rows = await rpc('kpi_forecast', { p_kpi_id: kpiId || null });
  return numify(rows || [], [
    'target_value', 'current_value', 'progress_pct', 'records', 'slope_per_day', 'projected_value', 'expected_pct',
  ]);
}

/** Pure helper: progress % from a kpis row. */
export function kpiProgress(k) {
  const t = Number(k.target_value) || 0;
  return t > 0 ? (Number(k.current_value) / t) * 100 : 0;
}

export { listKpis as list, createKpi as create, updateKpi as update, deleteKpi as remove, deleteKpi as delete, progress as forecast, progress as kpiForecast };

/* ------------------------------------------------------------------ */
/* Client-side forecast — mirrors SQL kpi_forecast() (migration 000600) */
/* so non-active KPIs (and databases without the RPC) get the same     */
/* numbers. Pure: no network.                                          */
/* ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const numToDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * forecastLocal(kpi, records, today) → same shape as a kpi_forecast() row.
 * `records` = this KPI's kpi_records rows (any order).
 */
export function forecastLocal(kpi, records = [], todayDay) {
  const target = Number(kpi.target_value) || 0;
  // Latest record per calendar day.
  const byDay = new Map();
  [...records]
    .sort((a, b) => (a.recorded_on === b.recorded_on ? String(a.created_at).localeCompare(String(b.created_at)) : a.recorded_on < b.recorded_on ? -1 : 1))
    .forEach((r) => byDay.set(r.recorded_on, Number(r.value)));
  const pts = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = pts.length;
  const s0 = dayNum(kpi.start_date);
  const t = dayNum(todayDay);
  const end = kpi.end_date ? dayNum(kpi.end_date) : null;

  let slope = null;
  if (n >= 2) {
    const xs = pts.map(([d]) => dayNum(d) - s0), ys = pts.map(([, v]) => v);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
    slope = sxx > 0 ? round(sxy / sxx, 6) : null;
  }
  const cur = n ? pts[n - 1][1] : Number(kpi.current_value) || 0;
  const lastDay = n ? dayNum(pts[n - 1][0]) : null;
  const progress = target > 0 ? round((cur / target) * 100, 1) : 0;

  let expected = null;
  if (end != null) {
    if (end === s0) expected = t >= end ? 100 : 0;
    else expected = round(Math.min(Math.max(((t - s0) / (end - s0)) * 100, 0), 100), 1);
  }
  let projected = null;
  if (end != null && slope != null) projected = t > end ? cur : round(cur + slope * Math.max(end - lastDay, 0), 2);
  let completion = null;
  if (slope > 0 && cur < target) {
    const need = Math.ceil((target - cur) / slope);
    if (need <= 36500) completion = numToDay(lastDay + need);
  }
  let status;
  if (cur >= target) status = 'achieved';
  else if (n < 2) status = 'no_data';
  else if (end == null) status = slope > 0 ? 'on_track' : slope === 0 ? 'at_risk' : 'off_track';
  else if (projected >= target || progress >= expected) status = 'on_track';
  else if (projected >= 0.8 * target) status = 'at_risk';
  else status = 'off_track';

  return {
    kpi_id: kpi.id, name: kpi.name, unit: kpi.unit, target_value: target, current_value: cur, progress_pct: progress,
    start_date: kpi.start_date, end_date: kpi.end_date, records: n, slope_per_day: slope, projected_value: projected,
    projected_completion: completion, expected_pct: expected, status,
  };
}

/**
 * Forecast for every KPI: server RPC for active ones (source of truth),
 * local computation for the rest or when the RPC is unavailable.
 * Returns Map(kpi_id → forecast row).
 */
export async function forecastAll(kpis, records, todayDay) {
  const out = new Map();
  let server = [];
  if (kpis.some((k) => k.status === 'active')) {
    try { server = await progress(null); } catch { server = []; }
  }
  server.forEach((f) => out.set(f.kpi_id, f));
  for (const k of kpis) {
    if (!out.has(k.id)) out.set(k.id, forecastLocal(k, records.filter((r) => r.kpi_id === k.id), todayDay));
  }
  return out;
}
