import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import { computeProductivity, budgetForRange, financeReport, productivityFor } from '../../src/services/reports.js';
import { parseBackup, importAll } from '../../src/services/backup.js';
import { configureDates } from '../../src/utils/date.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
  configureDates({ timezone: 'Asia/Ho_Chi_Minh', weekStartsOn: 1 });
});

describe('reports.computeProductivity (mirror of productivity_stats)', () => {
  it('counts completions per day, rates and busiest weekday', () => {
    const tasks = [
      { id: 1, status: 'completed', due_date: '2026-10-05', created_at: '2026-10-04T01:00:00Z', completed_at: '2026-10-05T03:00:00Z' },
      { id: 2, status: 'completed', due_date: '2026-10-04', created_at: '2026-10-05T01:00:00Z', completed_at: '2026-10-05T05:00:00Z' },
      { id: 3, status: 'todo', due_date: null, created_at: '2026-10-05T02:00:00Z', completed_at: null },
      { id: 4, status: 'cancelled', due_date: null, created_at: '2026-10-05T02:00:00Z', completed_at: null },
    ];
    const entries = [{ started_at: '2026-10-05T02:00:00Z', ended_at: '2026-10-05T03:00:00Z', duration_seconds: 3600, task: { category: { id: 'c1', name: 'Công việc', color: '#3B82C4' } } }];
    const r = computeProductivity(tasks, entries, '2026-10-04', '2026-10-06');
    expect(r.completed_by_day).toEqual([{ day: '2026-10-04', count: 0 }, { day: '2026-10-05', count: 2 }, { day: '2026-10-06', count: 0 }]);
    expect(r.minutes_by_day[1].minutes).toBe(60);
    expect(r.minutes_by_category[0]).toMatchObject({ category_id: 'c1', minutes: 60 });
    expect(r.completion_rate).toBeCloseTo(2 / 3); // created 1,2,3 (cancelled excluded), 1 & 2 completed
    expect(r.on_time_rate).toBe(0.5);
    expect(r.busiest_weekday).toBe(1); // 2026-10-05 is a Monday
  });

  it('falls back to local computation when the RPC is missing', async () => {
    fake.respond('rpc:productivity_stats', { error: { code: 'PGRST202', message: 'Could not find the function' } });
    fake.respond('tasks', { data: [] });
    fake.respond('time_entries', { data: [] });
    const r = await productivityFor('2026-10-01', '2026-10-03');
    expect(r.source).toBe('local');
    expect(r.completed_by_day).toHaveLength(3);
  });
});

describe('reports.budgetForRange', () => {
  it('pro-rates carry-forward monthly budgets by covered days', () => {
    const rows = [
      { effective_month: '2026-09-01', category_id: null, amount: 3000 },
      { effective_month: '2026-10-01', category_id: 'food', amount: 3100 },
    ];
    const b = budgetForRange(rows, '2026-09-16', '2026-10-15');
    // 16 days of Sep (16th..30th = 15 days → 15/30) + Oct carried forward (15/31)
    expect(b.overall).toBeCloseTo(3000 * (15 / 30) + 3000 * (15 / 31));
    expect(b.byCategory.get('food')).toBeCloseTo(3100 * (15 / 31));
  });
});

describe('reports.financeReport', () => {
  it('splits current / previous period and ranks the top expenses', async () => {
    fake.respond('expenses', { data: [
      { id: 'a', amount: '100', category_id: 'c', spent_on: '2026-09-30', category: { name: 'Ăn', color: '#E5793B' } },
      { id: 'b', amount: '300', category_id: 'c', spent_on: '2026-10-02', category: { name: 'Ăn', color: '#E5793B' } },
      { id: 'c', amount: '50', category_id: null, spent_on: '2026-10-03', category: null },
    ] });
    fake.respond('budgets', { data: [] });
    const f = await financeReport({ from: '2026-10-01', to: '2026-10-03', prevFrom: '2026-09-28', prevTo: '2026-09-30' });
    expect(f.total).toBe(350);
    expect(f.prev_total).toBe(100);
    expect(f.change_pct).toBe(250);
    expect(f.top.map((x) => x.id)).toEqual(['b', 'c']);
    expect(f.by_category[0]).toMatchObject({ category_id: 'c', total: 300, prev_total: 100 });
    expect(f.budget.has_any).toBe(false);
  });
});

describe('backup.parseBackup', () => {
  it('rejects non-JSON and foreign files, counts tables', async () => {
    await expect(parseBackup('nope')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(parseBackup(JSON.stringify({ app: 'other', tables: {} }))).rejects.toMatchObject({ code: 'invalid_input' });
    const p = await parseBackup('﻿' + JSON.stringify({ app: 'note-mytasks', version: 1, tables: { tasks: [{ id: 't1', title: 'A' }], weird: [] } }));
    expect(p.counts.tasks).toBe(1);
    expect(p.total).toBe(1);
    expect(p.unknown).toEqual(['weird']);
  });
});

describe('backup.importAll', () => {
  it('remaps ids, reuses same-name categories and never sends user_id', async () => {
    fake.respond('categories', { data: [{ id: 'existing-food', kind: 'expense', name: 'Ăn uống' }] }); // select existing
    fake.respond('budgets', { data: [] }); // select existing budgets
    const backup = {
      tables: {
        categories: [
          { id: 'old-food', kind: 'expense', name: 'ăn uống', color: '#E5793B', user_id: 'someone' },
          { id: 'old-work', kind: 'task', name: 'Dự án', color: '#3B82C4', user_id: 'someone' },
        ],
        tasks: [{ id: 'old-t', title: 'Viết báo cáo', status: 'todo', priority: 'high', category_id: 'old-work', tags: [], user_id: 'someone' }],
        time_entries: [
          { id: 'e1', task_id: 'old-t', started_at: '2026-10-01T01:00:00Z', ended_at: '2026-10-01T02:00:00Z', source: 'manual', duration_seconds: 3600 },
          { id: 'e2', task_id: 'old-t', started_at: '2026-10-02T01:00:00Z', ended_at: null },
        ],
        expenses: [{ id: 'old-x', amount: 50000, category_id: 'old-food', spent_on: '2026-10-01', payment_method: 'cash' }],
      },
    };
    const report = await importAll(backup);
    const inserts = fake.calls.filter((c) => c.chain.some((s) => s.method === 'insert'));
    const payload = (name) => inserts.filter((c) => c.name === name).flatMap((c) => [].concat(c.chain.find((s) => s.method === 'insert').args[0]));
    const cats = payload('categories');
    expect(cats).toHaveLength(1); // 'ăn uống' matched the existing one
    expect(cats[0].id).not.toBe('old-work');
    const [task] = payload('tasks');
    expect(task.category_id).toBe(cats[0].id);
    const [entry] = payload('time_entries');
    expect(entry.task_id).toBe(task.id);
    expect(entry).not.toHaveProperty('duration_seconds');
    const [exp] = payload('expenses');
    expect(exp.category_id).toBe('existing-food');
    for (const row of [...cats, task, entry, exp]) expect(row).not.toHaveProperty('user_id');
    expect(report.skipped.time_entries).toBe(1); // running timer
    expect(report.skipped.categories).toBe(1);
    expect(report.inserted.tasks).toBe(1);
  });
});
