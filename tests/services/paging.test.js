import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import * as tasks from '../../src/services/tasks.js';
import * as kpis from '../../src/services/kpis.js';

const rows = (n, p = 'x') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, title: 't' }));
let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});

describe('max_rows paging', () => {
  it('listTasks pages past 1000 rows (limit 2500) with an id tiebreak', async () => {
    fake.respond('tasks', { data: rows(1000, 'a') }, { data: rows(1000, 'b') }, { data: rows(300, 'c') });
    const out = await tasks.listTasks({ limit: 2500 });
    expect(out).toHaveLength(2300);
    const ranges = fake.calls.filter((c) => c.kind === 'from' && c.name === 'tasks').map((c) => fake.argsOf(c, 'range')[0]);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2499]]);
    expect(fake.argsOf(fake.last('from', 'tasks'), 'order').at(-1)).toEqual(['id', { ascending: true }]);
  });

  it('listTasks stops after a short page', async () => {
    fake.respond('tasks', { data: rows(20) });
    expect(await tasks.listTasks({ limit: 2000 })).toHaveLength(20);
  });

  it('listRecords pages until a short page', async () => {
    fake.respond('kpi_records', { data: rows(1000).map((r) => ({ ...r, value: '1' })) }, { data: rows(5).map((r) => ({ ...r, value: '2' })) });
    const out = await kpis.listRecords('k1');
    expect(out).toHaveLength(1005);
    expect(out[0].value).toBe(1);
  });
});

describe('kpis.updateKpi date bounds', () => {
  it('end_date alone before the stored start_date → invalid_input on end_date', async () => {
    fake.respond('kpis', { data: { start_date: '2026-10-10', end_date: null } });
    await expect(kpis.updateKpi('k1', { end_date: '2026-10-01' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'end_date' } });
  });

  it('start_date alone after the stored end_date → invalid_input on start_date', async () => {
    fake.respond('kpis', { data: { start_date: '2026-01-01', end_date: '2026-03-01' } });
    await expect(kpis.updateKpi('k1', { start_date: '2026-04-01' })).rejects.toMatchObject({ details: { field: 'start_date' } });
  });
});
