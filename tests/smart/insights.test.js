import { describe, it, expect } from 'vitest';
import { buildInsights } from '../../src/services/smart/insights.js';
import { money } from '../../src/utils/format.js';

const SEV = { critical: 0, warning: 1, success: 2, info: 3 };
const ids = (xs) => xs.map((x) => x.id);
const byId = (xs, id) => xs.find((x) => x.id === id);

describe('buildInsights — basics', () => {
  it('no input → []', () => {
    expect(buildInsights()).toEqual([]);
    expect(buildInsights({})).toEqual([]);
    expect(buildInsights({ summary: {}, budgets: [], kpis: [], anomalies: [], productivity: {} })).toEqual([]);
  });

  it('every insight has the contract shape', () => {
    const xs = buildInsights({
      summary: { tasks: { overdue: 2, due_today: 1 }, streak: { current: 3, longest: 3 } },
      productivity: { on_time_rate: 0.3 },
    });
    for (const x of xs) {
      expect(Object.keys(x).sort()).toEqual(expect.arrayContaining(['detail', 'id', 'severity', 'title']));
      expect(['info', 'warning', 'critical', 'success']).toContain(x.severity);
      expect(typeof x.title).toBe('string');
      if (x.action) expect(x.action.route).toMatch(/^#\//);
      expect(x).not.toHaveProperty('rank');
    }
  });
});

describe('buildInsights — tasks', () => {
  it.each([
    [1, 'warning'],
    [4, 'warning'],
    [5, 'critical'],
  ])('%i overdue → %s', (overdue, severity) => {
    const [x] = buildInsights({ summary: { tasks: { overdue } } });
    expect(x).toMatchObject({ id: 'tasks_overdue', severity, action: { route: '#/tasks?filter=overdue' } });
    expect(x.title).toContain(String(overdue));
  });

  it('due today → info; productive day → success only without overdue', () => {
    expect(buildInsights({ summary: { tasks: { due_today: 3 } } })[0]).toMatchObject({ id: 'tasks_due_today', severity: 'info' });
    expect(ids(buildInsights({ summary: { tasks: { completed_today: 6 } } }))).toEqual(['tasks_productive_day']);
    expect(ids(buildInsights({ summary: { tasks: { completed_today: 6, overdue: 1 } } }))).toEqual(['tasks_overdue']);
  });
});

describe('buildInsights — budgets', () => {
  it('category over budget → critical with formatted money', () => {
    const [x] = buildInsights({ budgets: [{ category_id: 'c1', category_name: 'Ăn uống', budget: 2000000, spent: 2500000, projected: 3000000, status: 'over' }] });
    expect(x).toMatchObject({ id: 'budget_over_c1', severity: 'critical', title: 'Vượt ngân sách Ăn uống', action: { route: '#/expenses' } });
    expect(x.detail).toContain(money(2500000));
    expect(x.detail).toContain(money(500000));
  });

  it('warning ≥ 80% used vs projected overspend', () => {
    const xs = buildInsights({ budgets: [
      { category_id: 'a', category_name: 'Đi lại', budget: 1000000, spent: 850000, projected: 900000, status: 'warning' },
      { category_id: 'b', category_name: 'Giải trí', budget: 1000000, spent: 300000, projected: 1400000, status: 'warning' },
      { category_id: 'c', category_name: 'Học tập', budget: 1000000, spent: 100000, projected: 300000, status: 'ok' },
    ] });
    expect(ids(xs)).toEqual(['budget_warning_a', 'budget_warning_b']);
    expect(byId(xs, 'budget_warning_a').title).toContain('85%');
    expect(byId(xs, 'budget_warning_b').title).toContain('dự kiến vượt');
    expect(byId(xs, 'budget_warning_b').detail).toContain(money(1400000));
  });

  it('total row: over / warning / projected', () => {
    const total = (spent, projected, status) => buildInsights({ budgets: [{ category_id: null, category_name: null, budget: 10000000, spent, projected, status }] })[0];
    expect(total(11000000, 12000000, 'over').id).toBe('budget_over_total');
    expect(total(9000000, 9500000, 'warning').id).toBe('budget_warning_total');
    expect(total(5000000, 12000000, 'warning')).toMatchObject({ id: 'budget_projected_total', severity: 'warning' });
    expect(total(1000000, 2000000, 'ok')).toBeUndefined();
  });

  it('falls back to summary.money when budget rows are missing', () => {
    const xs = buildInsights({ summary: { money: { month_spent: 1200000, month_budget: 1000000, month_projected: 1500000 } } });
    expect(xs[0]).toMatchObject({ id: 'budget_over_total', severity: 'critical' });
    expect(buildInsights({ summary: { money: { month_spent: 100, month_budget: null } } })).toEqual([]);
  });

  it('groups > 2 over-budget categories; ignores categories without budget', () => {
    const rows = ['A', 'B', 'C', 'D'].map((n) => ({ category_id: n, category_name: n, budget: 100, spent: 200, status: 'over' }));
    rows.push({ category_id: 'E', category_name: 'E', budget: null, spent: 999, status: 'no_budget' });
    const xs = buildInsights({ budgets: rows });
    expect(ids(xs)).toEqual(['budget_over_many']);
    expect(xs[0].title).toContain('4');
    expect(xs[0].detail).toContain('và 1 mục khác');
  });

  it('accepts numeric strings (numeric from PostgREST)', () => {
    const [x] = buildInsights({ budgets: [{ category_id: 'c', category_name: 'X', budget: '1000000', spent: '1500000', status: 'over' }] });
    expect(x.id).toBe('budget_over_c');
  });
});

describe('buildInsights — KPIs', () => {
  const kpi = (id, status, extra = {}) => ({ kpi_id: id, name: `KPI ${id}`, status, progress_pct: 30, expected_pct: 60, target_value: 100, projected_value: 85, unit: 'km', ...extra });

  it.each([
    ['off_track', 'warning'],
    ['at_risk', 'warning'],
    ['achieved', 'success'],
  ])('%s → %s', (status, severity) => {
    const [x] = buildInsights({ kpis: [kpi('k1', status)] });
    expect(x).toMatchObject({ id: `kpi_${status}_k1`, severity, action: { route: '#/kpi' } });
  });

  it('on_track / no_data produce nothing; > 2 same status are grouped', () => {
    expect(buildInsights({ kpis: [kpi('a', 'on_track'), kpi('b', 'no_data')] })).toEqual([]);
    const xs = buildInsights({ kpis: [kpi('a', 'achieved'), kpi('b', 'achieved'), kpi('c', 'achieved')] });
    expect(ids(xs)).toEqual(['kpi_achieved_many']);
  });

  it('at_risk detail shows the projection with unit', () => {
    expect(buildInsights({ kpis: [kpi('k', 'at_risk')] })[0].detail).toContain('85 km');
  });

  it('uses summary.kpis counts when rows are not given', () => {
    expect(buildInsights({ summary: { kpis: { active: 3, off_track: 2, at_risk: 1 } } })[0]).toMatchObject({ id: 'kpi_off_track_count' });
    expect(buildInsights({ summary: { kpis: { active: 3, off_track: 0, at_risk: 1 } } })[0]).toMatchObject({ id: 'kpi_at_risk_count' });
  });
});

describe('buildInsights — anomalies, streaks, productivity, spending', () => {
  const anomaly = (id, amount) => ({ expense_id: id, amount, category_id: 'c', category_name: 'Ăn uống', spent_on: '2026-10-05', description: 'Lẩu', baseline: 100000, z_score: 6, reason: 'high_vs_category' });

  it('single anomaly with ratio and date', () => {
    const [x] = buildInsights({ anomalies: [anomaly('e1', 450000)] });
    expect(x).toMatchObject({ id: 'anomaly_e1', severity: 'warning' });
    expect(x.title).toContain(money(450000));
    expect(x.detail).toContain('4,5 lần');
    expect(x.detail).toContain('05/10/2026');
  });

  it('dedupes identical ids and groups many anomalies', () => {
    expect(ids(buildInsights({ anomalies: [anomaly('e1', 300000), anomaly('e1', 300000)] }))).toEqual(['anomaly_e1']);
    const xs = buildInsights({ anomalies: [anomaly('a', 300000), anomaly('b', 900000), anomaly('c', 400000)] });
    expect(ids(xs)).toEqual(['anomaly_many']);
    expect(xs[0].detail).toContain(money(900000));
  });

  it.each([
    [2, null],
    [3, 'streak_3'],
    [6, 'streak_3'],
    [7, 'streak_7'],
    [29, 'streak_7'],
    [30, 'streak_30'],
    [120, 'streak_30'],
  ])('streak %i → %s', (current, id) => {
    const xs = buildInsights({ summary: { streak: { current, longest: 200 } } });
    expect(xs[0]?.id ?? null).toBe(id);
    if (id) expect(xs[0].severity).toBe('success');
  });

  it.each([
    [0.3, 'on_time_low', 'warning'],
    [0.5, 'on_time_low', 'info'],
    [45, 'on_time_low', 'info'], // percent input
    [0.75, null, null],
    [0.95, 'on_time_high', 'success'],
    [null, null, null],
  ])('on_time_rate %s → %s', (rate, id, severity) => {
    const xs = buildInsights({ productivity: { on_time_rate: rate } });
    expect(xs[0]?.id ?? null).toBe(id);
    if (id) expect(xs[0].severity).toBe(severity);
  });

  it.each([
    [80, 'spending_rise', 'warning'],
    [30, 'spending_rise', 'info'],
    [10, null, null],
    [-35, 'spending_drop', 'success'],
    [null, null, null],
  ])('change_pct %s → %s', (change_pct, id, severity) => {
    const xs = buildInsights({ spending: { change_pct, total: 1800000, prev_total: 1000000 } });
    expect(xs[0]?.id ?? null).toBe(id);
    if (id) expect(xs[0].severity).toBe(severity);
  });
});

describe('buildInsights — ordering & limit', () => {
  const everything = {
    summary: { tasks: { overdue: 7, due_today: 2, completed_today: 1 }, streak: { current: 7, longest: 7 } },
    budgets: [
      { category_id: null, budget: 5000000, spent: 6000000, status: 'over' },
      { category_id: 'a', category_name: 'Ăn uống', budget: 1000000, spent: 1500000, status: 'over' },
      { category_id: 'b', category_name: 'Đi lại', budget: 1000000, spent: 900000, status: 'warning' },
    ],
    kpis: [{ kpi_id: 'k', name: 'Chạy bộ', status: 'off_track', progress_pct: 10, expected_pct: 50 }],
    anomalies: [{ expense_id: 'e', amount: 900000, baseline: 100000, category_name: 'Ăn uống' }],
    productivity: { on_time_rate: 0.2 },
    spending: { change_pct: 70 },
  };

  it('sorts critical > warning > success > info and caps at 6', () => {
    const xs = buildInsights(everything);
    expect(xs).toHaveLength(6);
    for (let i = 1; i < xs.length; i++) expect(SEV[xs[i - 1].severity]).toBeLessThanOrEqual(SEV[xs[i].severity]);
    expect(xs[0].severity).toBe('critical');
    expect(new Set(ids(xs)).size).toBe(xs.length);
  });

  it('custom limit', () => {
    expect(buildInsights({ ...everything, limit: 2 })).toHaveLength(2);
    expect(buildInsights({ ...everything, limit: 50 }).length).toBeGreaterThan(6);
  });

  it('is deterministic', () => {
    expect(buildInsights(everything)).toEqual(buildInsights(everything));
  });
});
