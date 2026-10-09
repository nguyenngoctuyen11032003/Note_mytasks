// CSV export (backup / spreadsheets). Fetches every page (PostgREST caps a
// response at 1000 rows by default) and renders with utils/csv.js.
import { toCSV, downloadText } from '../utils/csv.js';
import { dayStartInstant, dayEndInstant, toLocalInput } from '../utils/date.js';
import { db, run, invalid, vDay } from './errors.js';

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
