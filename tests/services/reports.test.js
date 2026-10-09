import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import { exportCsv, fetchAll, PAGE_SIZE } from '../../src/services/reports.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));

describe('reports.exportCsv', () => {
  it('pages through results 1000 rows at a time until a short page', async () => {
    const exp = (i) => ({ id: `e${i}`, amount: '10.00', spent_on: '2026-10-01', payment_method: 'cash', description: `d${i}`, note: null, category: { name: 'Ăn uống' } });
    fake.respond('expenses', { data: rows(PAGE_SIZE, exp) }, { data: rows(PAGE_SIZE, exp) }, { data: rows(5, exp) });
    const r = await exportCsv('expenses', { from: '2026-10-01', to: '2026-10-31' });
    expect(r.count).toBe(2005);
    const calls = fake.calls.filter((c) => c.name === 'expenses');
    expect(calls.map((c) => fake.argsOf(c, 'range')[0])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(fake.argsOf(calls[0], 'gte')).toEqual([['spent_on', '2026-10-01']]);
    expect(fake.argsOf(calls[0], 'lte')).toEqual([['spent_on', '2026-10-31']]);
    expect(r.filename).toBe('chi-tieu_2026-10-01_2026-10-31.csv');
    const lines = r.csv.split('\r\n');
    expect(lines[0]).toBe('Ngày,Số tiền,Danh mục,Mô tả,Phương thức,Ghi chú');
    expect(lines[1]).toBe('2026-10-01,10,Ăn uống,d0,Tiền mặt,');
    expect(lines).toHaveLength(2006);
  });

  it('exact multiple of the page size issues one extra (empty) request', async () => {
    fake.respond('kpi_records', { data: rows(PAGE_SIZE, (i) => ({ id: i, value: '1', recorded_on: '2026-01-01', kpi: { name: 'K', unit: 'km' } })) }, { data: [] });
    const r = await exportCsv('kpi_records');
    expect(r.count).toBe(PAGE_SIZE);
    expect(fake.calls).toHaveLength(2);
    expect(r.csv.split('\r\n')[0]).toBe('KPI,Đơn vị,Ngày,Giá trị,Ghi chú');
    expect(r.filename).toBe('kpi.csv');
  });

  it('tasks: Vietnamese labels, quoted cells, tags joined, created_at range in user tz', async () => {
    fake.respond('tasks', { data: [{ id: 't', title: 'Họp, "gấp"', description: null, status: 'in_progress', priority: 'urgent', tags: ['a', 'b'], due_date: null, estimated_minutes: 30, actual_minutes: '0', completed_at: null, created_at: '2026-10-01T03:00:00Z', category: null }] });
    const r = await exportCsv('tasks', { from: '2026-10-01', to: '2026-10-01' });
    const [head, line] = r.csv.split('\r\n');
    expect(head).toBe('Tiêu đề,Mô tả,Trạng thái,Độ ưu tiên,Danh mục,Thẻ,Hạn chót,Ước tính (phút),Thực tế (phút),Hoàn thành lúc,Tạo lúc');
    expect(line).toBe('"Họp, ""gấp""",,Đang làm,Khẩn cấp,,"a; b",,30,0,,2026-10-01 10:00');
    const c = fake.last('from', 'tasks');
    expect(fake.argsOf(c, 'gte')).toEqual([['created_at', '2026-09-30T17:00:00.000Z']]);
    expect(fake.argsOf(c, 'lt')).toEqual([['created_at', '2026-10-01T17:00:00.000Z']]);
  });

  it('time: duration in minutes and task title', async () => {
    fake.respond('time_entries', { data: [{ id: 'x', started_at: '2026-10-01T01:00:00Z', ended_at: '2026-10-01T02:30:00Z', duration_seconds: '5400', description: 'd', source: 'manual', task: { title: 'T' } }] });
    const r = await exportCsv('time');
    expect(r.csv.split('\r\n')[1]).toBe('2026-10-01 08:00,2026-10-01 09:30,90,T,d,Nhập tay');
  });

  it('rejects unknown kind and inverted ranges', async () => {
    await expect(exportCsv('users')).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'kind' } });
    await expect(exportCsv('tasks', { from: '2026-10-02', to: '2026-10-01' })).rejects.toMatchObject({ details: { field: 'to' } });
    await expect(exportCsv('tasks', { from: '1/10/2026' })).rejects.toMatchObject({ details: { field: 'from' } });
  });

  it('errors mid-pagination propagate as AppError', async () => {
    fake.respond('expenses', { data: rows(PAGE_SIZE, (i) => ({ id: i })) }, { error: { code: 'PGRST301', message: 'JWT expired' } });
    await expect(exportCsv('expenses')).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('fetchAll with a custom page size', async () => {
    fake.respond('t', { data: [1, 2] }, { data: [3] });
    const out = await fetchAll(() => fake.from('t').select('*'), 2);
    expect(out).toEqual([1, 2, 3]);
  });

  it('not_configured', async () => {
    h.client = null;
    await expect(exportCsv('tasks')).rejects.toMatchObject({ code: 'not_configured' });
  });
});
