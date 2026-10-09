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
  return normKpi(await run(db().from('kpis').update(row).eq('id', id).select(KPI_COLS).single()));
}

export async function deleteKpi(id) {
  requireId(id);
  await run(db().from('kpis').delete().eq('id', id));
  return true;
}

export async function listRecords(kpiId) {
  requireId(kpiId, 'kpi_id');
  const q = db().from('kpi_records').select(RECORD_COLS).eq('kpi_id', kpiId)
    .order('recorded_on', { ascending: true }).order('created_at', { ascending: true });
  return normRec(await run(q));
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
export async function listAllRecords(sinceDay) {
  let q = db().from('kpi_records').select(RECORD_COLS);
  if (sinceDay) q = q.gte('recorded_on', vDay(sinceDay, 'sinceDay'));
  return normRec(await run(q.order('recorded_on', { ascending: true }).limit(5000)));
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
