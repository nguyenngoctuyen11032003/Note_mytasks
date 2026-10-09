// Finance RPCs (contract §2, migration 20261009000400_finance.sql) against real Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon, q, categoryId } from './harness.js';

let db;

// ---------- helpers ----------
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const addMonths = (s, n) => {
  const d = parse(monthStart(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};
const daysInMonth = (s) => {
  const d = parse(monthStart(s));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};
const num = (v) => (v === null || v === undefined ? v : Number(v));
const round2 = (x) => Math.round(x * 100) / 100;

async function todayOf(user) {
  const [r] = await q(db, user, 'select public.user_today()::text as t');
  return r.t;
}

async function exp(user, amount, day, catId = null, desc = null, pm = 'cash') {
  const { rows } = await db.query(
    `insert into public.expenses (user_id, amount, spent_on, category_id, description, payment_method)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [user, amount, day, catId, desc, pm],
  );
  return rows[0].id;
}

async function budget(user, month, amount, catId = null) {
  await db.query('insert into public.budgets (user_id, effective_month, category_id, amount) values ($1, $2, $3, $4)', [
    user,
    month,
    catId,
    amount,
  ]);
}

async function budgetStatus(user, month = null) {
  const rows = await q(
    db,
    user,
    `select category_id, category_name, color, budget, spent, remaining, used_pct, projected, status
       from public.budget_status($1::date)`,
    [month],
  );
  return rows.map((r) => ({
    ...r,
    budget: num(r.budget),
    spent: num(r.spent),
    remaining: num(r.remaining),
    used_pct: num(r.used_pct),
    projected: num(r.projected),
  }));
}

async function summary(user, from, to) {
  const [r] = await q(db, user, 'select public.spending_summary($1::date, $2::date) as s', [from, to]);
  return r.s;
}

async function anomalies(user, days) {
  const sql =
    days === undefined
      ? 'select expense_id, amount, category_id, category_name, spent_on::text, description, baseline, z_score, reason from public.expense_anomalies()'
      : 'select expense_id, amount, category_id, category_name, spent_on::text, description, baseline, z_score, reason from public.expense_anomalies($1)';
  const rows = await q(db, user, sql, days === undefined ? [] : [days]);
  return rows.map((r) => ({ ...r, amount: num(r.amount), baseline: num(r.baseline), z_score: num(r.z_score) }));
}

async function suggest(user, text) {
  const rows = await q(db, user, 'select category_id, name, confidence from public.suggest_expense_category($1)', [text]);
  return rows.map((r) => ({ ...r, confidence: num(r.confidence) }));
}

/** Reference implementation of the contract's projection + status rules. */
function expectedRow({ budget: b, spent, today, month }) {
  const cur = monthStart(today);
  let projected;
  if (month === cur) {
    const elapsed = (parse(today) - parse(month)) / 86400000 + 1;
    projected = round2((spent * daysInMonth(month)) / elapsed);
  } else if (month < cur) projected = spent;
  else projected = 0;
  let status;
  if (b === null) status = 'no_budget';
  else if (spent > b) status = 'over';
  else if ((b > 0 && spent >= 0.8 * b) || projected > b) status = 'warning';
  else status = 'ok';
  return {
    budget: b,
    spent,
    remaining: b === null ? null : b - spent,
    used_pct: b > 0 ? Math.round((spent / b) * 1000) / 10 : null,
    projected,
    status,
  };
}

function expectRow(row, exp) {
  expect(row.budget).toBe(exp.budget);
  expect(row.spent).toBe(exp.spent);
  expect(row.remaining).toBe(exp.remaining);
  if (exp.used_pct === null) expect(row.used_pct).toBeNull();
  else expect(row.used_pct).toBeCloseTo(exp.used_pct, 1);
  expect(row.projected).toBeCloseTo(exp.projected, 2);
  expect(row.status).toBe(exp.status);
}

beforeAll(async () => {
  db = await createDb();
});

// =====================================================================
describe('budget_status', () => {
  let u, today, M, food, transport, fun, other, study;

  beforeAll(async () => {
    u = await createUser(db, { displayName: 'Budget' });
    today = await todayOf(u);
    M = monthStart(today);
    food = await categoryId(db, u, 'expense', 'Ăn uống');
    transport = await categoryId(db, u, 'expense', 'Đi lại');
    fun = await categoryId(db, u, 'expense', 'Giải trí');
    other = await categoryId(db, u, 'expense', 'Khác');
    study = await categoryId(db, u, 'expense', 'Học tập');

    // overall: 10M from M-2, 12M from M+1
    await budget(u, addMonths(M, -2), 10_000_000);
    await budget(u, addMonths(M, 1), 12_000_000);
    // food: 3M from M-3, 2M from M-1 (current month must use 2M)
    await budget(u, addMonths(M, -3), 3_000_000, food);
    await budget(u, addMonths(M, -1), 2_000_000, food);
    // transport: 1M from M only
    await budget(u, M, 1_000_000, transport);
    // other: zero budget, no spending; study: 1M, tiny spending
    await budget(u, M, 0, other);
    await budget(u, M, 1_000_000, study);

    // current month spending (all on day 1 → always <= today)
    await exp(u, 1_000_000, M, food, 'Đi chợ');
    await exp(u, 700_000, M, food, 'Nhà hàng');
    await exp(u, 1_200_000, M, transport, 'Vé máy bay');
    await exp(u, 500_000, M, fun, 'Xem phim');
    await exp(u, 100_000, M, null, 'Không phân loại');
    await exp(u, 100, M, study, 'Bút');
    // previous month
    await exp(u, 2_500_000, addDays(addMonths(M, -1), 14), food, 'Tiệc');
    // next month (future) must not count in current month
    await exp(u, 999_000, addMonths(M, 1), food, 'Tương lai');
  });

  it('current month: carry-forward, overall row first, projections and statuses', async () => {
    const rows = await budgetStatus(u);
    expect(rows[0].category_id).toBeNull();
    expect(rows[0].category_name).toBeNull();
    const byName = Object.fromEntries(rows.slice(1).map((r) => [r.category_name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Ăn uống', 'Đi lại', 'Giải trí', 'Học tập', 'Khác'].sort());

    // overall includes uncategorised spending
    expectRow(rows[0], expectedRow({ budget: 10_000_000, spent: 3_500_100, today, month: M }));
    // food: carry-forward picks the M-1 row (2M), 85% → warning (or worse by projection)
    expectRow(byName['Ăn uống'], expectedRow({ budget: 2_000_000, spent: 1_700_000, today, month: M }));
    expect(['warning']).toContain(byName['Ăn uống'].status);
    expect(byName['Ăn uống'].used_pct).toBe(85);
    expect(byName['Ăn uống'].color).toBe('#E5793B');
    // transport over budget
    expectRow(byName['Đi lại'], expectedRow({ budget: 1_000_000, spent: 1_200_000, today, month: M }));
    expect(byName['Đi lại'].status).toBe('over');
    expect(byName['Đi lại'].remaining).toBe(-200_000);
    // spending without budget
    expectRow(byName['Giải trí'], expectedRow({ budget: null, spent: 500_000, today, month: M }));
    expect(byName['Giải trí'].status).toBe('no_budget');
    // zero budget, zero spending → ok, used_pct null
    expectRow(byName['Khác'], expectedRow({ budget: 0, spent: 0, today, month: M }));
    expect(byName['Khác'].status).toBe('ok');
    // small spending → ok
    expectRow(byName['Học tập'], expectedRow({ budget: 1_000_000, spent: 100, today, month: M }));
    expect(byName['Học tập'].status).toBe('ok');
    // category rows ordered by spent desc
    const spents = rows.slice(1).map((r) => r.spent);
    expect(spents).toEqual([...spents].sort((a, b) => b - a));
  });

  it('projection = spent / days elapsed (today inclusive) * days in month', async () => {
    const [overall] = await budgetStatus(u);
    const elapsed = (parse(today) - parse(M)) / 86400000 + 1;
    expect(overall.projected).toBeCloseTo((3_500_100 / elapsed) * daysInMonth(M), 2);
    // same thing computed independently in SQL
    const [ref] = await q(
      db,
      u,
      `select extract(day from (date_trunc('month', public.user_today()) + interval '1 month' - interval '1 day'))::int as dim,
              (public.user_today() - date_trunc('month', public.user_today())::date + 1) as elapsed`,
    );
    expect(ref.dim).toBe(daysInMonth(M));
    expect(ref.elapsed).toBe(elapsed);
  });

  it('p_month is truncated to the first day; null = current month', async () => {
    const a = await budgetStatus(u, null);
    const b = await budgetStatus(u, addDays(M, Math.min(5, daysInMonth(M) - 1)));
    expect(b).toEqual(a);
  });

  it('past month: projected = spent, carry-forward as of that month', async () => {
    const prev = addMonths(M, -1);
    const rows = await budgetStatus(u, addDays(prev, 10));
    expect(rows[0].category_id).toBeNull();
    expectRow(rows[0], expectedRow({ budget: 10_000_000, spent: 2_500_000, today, month: prev }));
    const food1 = rows.find((r) => r.category_name === 'Ăn uống');
    expectRow(food1, expectedRow({ budget: 2_000_000, spent: 2_500_000, today, month: prev }));
    expect(food1.projected).toBe(2_500_000);
    expect(food1.status).toBe('over');
    // transport budget starts in M → absent (no spending either)
    expect(rows.find((r) => r.category_name === 'Đi lại')).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  it('month before any overall budget: no overall row, older category budget applies', async () => {
    const rows = await budgetStatus(u, addMonths(M, -3));
    expect(rows).toHaveLength(1);
    expect(rows[0].category_name).toBe('Ăn uống');
    expectRow(rows[0], expectedRow({ budget: 3_000_000, spent: 0, today, month: addMonths(M, -3) }));
    expect(rows[0].status).toBe('ok');
    expect(await budgetStatus(u, addMonths(M, -4))).toEqual([]);
  });

  it('future month: projected = 0, newer overall row applies, category budgets carried', async () => {
    const next = addMonths(M, 1);
    const rows = await budgetStatus(u, next);
    expect(rows[0].category_id).toBeNull();
    expect(rows[0].budget).toBe(12_000_000);
    expect(rows[0].spent).toBe(999_000);
    expect(rows[0].projected).toBe(0);
    const byName = Object.fromEntries(rows.slice(1).map((r) => [r.category_name, r]));
    expect(byName['Ăn uống'].budget).toBe(2_000_000);
    expect(byName['Đi lại'].budget).toBe(1_000_000);
    expect(byName['Đi lại'].spent).toBe(0);
    expect(byName['Ăn uống'].projected).toBe(0);
    expect(byName['Ăn uống'].status).toBe('ok');
  });

  it('warning by projection only (spent < 80% but projected > budget)', async () => {
    const v = await createUser(db);
    const t = await todayOf(v);
    const m = monthStart(t);
    const elapsed = (parse(t) - parse(m)) / 86400000 + 1;
    const dim = daysInMonth(m);
    await budget(v, m, 1_000_000);
    // spent = 50% of budget; projection exceeds budget only if elapsed/dim < 0.5
    await exp(v, 500_000, m, null, 'x');
    const [row] = await budgetStatus(v);
    expect(row.status).toBe(500_000 * dim / elapsed > 1_000_000 ? 'warning' : 'ok');
    expectRow(row, expectedRow({ budget: 1_000_000, spent: 500_000, today: t, month: m }));
  });

  it('exactly 80% is warning, exactly 100% is warning (not over)', async () => {
    const v = await createUser(db);
    const t = await todayOf(v);
    const m = monthStart(t);
    const prev = addMonths(m, -1); // closed month → projection = spent, isolates thresholds
    const c1 = await categoryId(db, v, 'expense', 'Ăn uống');
    const c2 = await categoryId(db, v, 'expense', 'Đi lại');
    const c3 = await categoryId(db, v, 'expense', 'Nhà ở');
    await budget(v, prev, 100, c1);
    await budget(v, prev, 100, c2);
    await budget(v, prev, 100, c3);
    await exp(v, 80, prev, c1);
    await exp(v, 100, prev, c2);
    await exp(v, 79.99, prev, c3);
    const rows = await budgetStatus(v, prev);
    const s = Object.fromEntries(rows.map((r) => [r.category_name, r.status]));
    expect(s).toEqual({ 'Ăn uống': 'warning', 'Đi lại': 'warning', 'Nhà ở': 'ok' });
  });

  it("uses the user's timezone for the current month / days elapsed", async () => {
    const v = await createUser(db);
    await db.query(`update public.profiles set timezone = 'Pacific/Kiritimati' where id = $1`, [v]);
    const t = await todayOf(v);
    const { rows } = await db.query(`select (now() at time zone 'Pacific/Kiritimati')::date::text as t`);
    expect(t).toBe(rows[0].t);
    const m = monthStart(t);
    await budget(v, m, 10_000_000);
    await exp(v, 1_000_000, m);
    const [row] = await budgetStatus(v);
    expectRow(row, expectedRow({ budget: 10_000_000, spent: 1_000_000, today: t, month: m }));
  });
});

// =====================================================================
describe('spending_summary', () => {
  let u, food, transport;
  beforeAll(async () => {
    u = await createUser(db);
    food = await categoryId(db, u, 'expense', 'Ăn uống');
    transport = await categoryId(db, u, 'expense', 'Đi lại');
    await exp(u, 100_000, '2026-01-05', food, 'Phở', 'cash');
    await exp(u, 50_000, '2026-01-05', food, 'Cà phê', 'e_wallet');
    await exp(u, 200_000, '2026-01-07', transport, 'Taxi', 'bank');
    await exp(u, 50_000, '2026-01-11', null, 'Linh tinh', 'cash');
    // previous period (2025-12-29..2026-01-04)
    await exp(u, 300_000, '2026-01-04', food, 'Tiệc', 'cash');
    await exp(u, 300_000, '2025-12-29', food, 'Tiệc', 'cash');
    // outside both periods
    await exp(u, 999_000, '2025-12-28', food, 'old', 'cash');
    await exp(u, 500_000, '2026-01-12', food, 'after', 'cash');
  });

  it('totals, breakdowns, zero days, previous period and change_pct', async () => {
    const s = await summary(u, '2026-01-05', '2026-01-11');
    expect(s.total).toBe(400_000);
    expect(s.count).toBe(4);
    expect(s.daily_avg).toBe(57_142.86);
    expect(s.prev_total).toBe(600_000);
    expect(s.change_pct).toBe(-33.3);

    expect(s.by_category).toEqual([
      { category_id: transport, name: 'Đi lại', color: '#3B82C4', total: 200_000, count: 1, pct: 50 },
      { category_id: food, name: 'Ăn uống', color: '#E5793B', total: 150_000, count: 2, pct: 37.5 },
      { category_id: null, name: null, color: null, total: 50_000, count: 1, pct: 12.5 },
    ]);
    expect(s.by_payment_method).toEqual([
      { method: 'bank', total: 200_000 },
      { method: 'cash', total: 150_000 },
      { method: 'e_wallet', total: 50_000 },
    ]);
    expect(s.by_day).toEqual([
      { day: '2026-01-05', total: 150_000 },
      { day: '2026-01-06', total: 0 },
      { day: '2026-01-07', total: 200_000 },
      { day: '2026-01-08', total: 0 },
      { day: '2026-01-09', total: 0 },
      { day: '2026-01-10', total: 0 },
      { day: '2026-01-11', total: 50_000 },
    ]);
    const pctSum = s.by_category.reduce((a, c) => a + c.pct, 0);
    expect(pctSum).toBeCloseTo(100, 5);
  });

  it('single day range; positive change_pct', async () => {
    const s = await summary(u, '2026-01-07', '2026-01-07');
    expect(s.total).toBe(200_000);
    expect(s.by_day).toEqual([{ day: '2026-01-07', total: 200_000 }]);
    expect(s.prev_total).toBe(0); // 2026-01-06
    expect(s.change_pct).toBeNull();
    const s2 = await summary(u, '2026-01-05', '2026-01-05');
    expect(s2.prev_total).toBe(300_000);
    expect(s2.change_pct).toBe(-50);
    const s3 = await summary(u, '2026-01-12', '2026-01-12');
    expect(s3.prev_total).toBe(50_000);
    expect(s3.change_pct).toBe(900);
  });

  it('empty period: zeros and empty arrays, by_day still complete', async () => {
    const s = await summary(u, '2024-03-01', '2024-03-03');
    expect(s).toEqual({
      total: 0,
      count: 0,
      daily_avg: 0,
      by_category: [],
      by_payment_method: [],
      by_day: [
        { day: '2024-03-01', total: 0 },
        { day: '2024-03-02', total: 0 },
        { day: '2024-03-03', total: 0 },
      ],
      prev_total: 0,
      change_pct: null,
    });
  });

  it('validates the range', async () => {
    await expect(summary(u, '2026-01-10', '2026-01-09')).rejects.toThrow(/invalid_input/);
    await expect(summary(u, null, '2026-01-09')).rejects.toThrow(/invalid_input/);
    await expect(summary(u, '2026-01-01', null)).rejects.toThrow(/invalid_input/);
    await expect(summary(u, '2025-01-01', '2026-01-02')).rejects.toThrow(/invalid_input/); // 367 days
    const s = await summary(u, '2025-01-01', '2026-01-01'); // 366 days
    expect(s.by_day).toHaveLength(366);
  });

  it('errors carry SQLSTATE P0001', async () => {
    try {
      await summary(u, '2026-01-10', '2026-01-09');
      throw new Error('should fail');
    } catch (e) {
      expect(e.code).toBe('P0001');
      expect(e.message).toBe('invalid_input');
    }
  });
});

// =====================================================================
describe('expense_anomalies', () => {
  let u, T, food, transport, house, fun, ids;
  beforeAll(async () => {
    u = await createUser(db);
    T = await todayOf(u);
    food = await categoryId(db, u, 'expense', 'Ăn uống');
    transport = await categoryId(db, u, 'expense', 'Đi lại');
    house = await categoryId(db, u, 'expense', 'Nhà ở');
    fun = await categoryId(db, u, 'expense', 'Giải trí');
    ids = {};
    // food history (window = [T-29, T], history = [T-209, T-30]):
    // 45,50,52,55,58,60 k → median 53.5k, MAD 4k
    const hist = [50_000, 55_000, 60_000, 45_000, 52_000, 58_000];
    for (let i = 0; i < hist.length; i++) await exp(u, hist[i], addDays(T, -40 - i * 25), food, 'Ăn');
    await exp(u, 10_000_000, addDays(T, -210), food, 'too old for history');
    ids.big = await exp(u, 500_000, addDays(T, -2), food, 'Tiệc lớn');
    ids.normal = await exp(u, 60_000, addDays(T, -1), food, 'Ăn trưa');
    ids.mid = await exp(u, 110_000, addDays(T, -3), food, 'Lẩu'); // z 9.53, >= 2x median
    ids.notDouble = await exp(u, 100_000, addDays(T, -4), food, 'Nướng'); // z 7.84 but < 2x median
    // transport: only 4 history samples → never flagged
    for (let i = 0; i < 4; i++) await exp(u, 30_000, addDays(T, -35 - i), transport, 'Xe ôm');
    ids.transportBig = await exp(u, 3_000_000, addDays(T, -1), transport, 'Vé máy bay');
    // house: MAD = 0
    for (let i = 0; i < 5; i++) await exp(u, 3_000_000, addDays(T, -31 - i * 30), house, 'Tiền nhà');
    ids.house9 = await exp(u, 9_000_000, addDays(T, -5), house, 'Sửa nhà');
    ids.house8 = await exp(u, 8_000_000, addDays(T, -6), house, 'Đặt cọc');
    // fun: 4 in range + 3 older than 180 days before window → insufficient
    for (let i = 0; i < 4; i++) await exp(u, 100_000, addDays(T, -50 - i), fun, 'Phim');
    for (let i = 0; i < 3; i++) await exp(u, 100_000, addDays(T, -250 - i), fun, 'Phim cũ');
    ids.funBig = await exp(u, 5_000_000, addDays(T, -1), fun, 'Concert');
  });

  it('flags true positives with median baseline and robust z', async () => {
    const rows = await anomalies(u);
    const flagged = Object.fromEntries(rows.map((r) => [r.expense_id, r]));
    expect(Object.keys(flagged).sort()).toEqual([ids.big, ids.mid, ids.house9].sort());

    const big = flagged[ids.big];
    expect(big.baseline).toBe(53_500);
    expect(big.z_score).toBeCloseTo(round2((0.6745 * (500_000 - 53_500)) / 4_000), 2);
    expect(big.z_score).toBe(75.29);
    expect(big.reason).toBe('high_vs_category');
    expect(big.category_id).toBe(food);
    expect(big.category_name).toBe('Ăn uống');
    expect(big.spent_on).toBe(addDays(T, -2));
    expect(big.description).toBe('Tiệc lớn');
    expect(big.amount).toBe(500_000);
    expect(flagged[ids.mid].z_score).toBe(9.53);

    const h = flagged[ids.house9];
    expect(h.baseline).toBe(3_000_000);
    expect(h.z_score).toBeNull(); // MAD = 0
    // newest first
    expect(rows.map((r) => r.spent_on)).toEqual([...rows.map((r) => r.spent_on)].sort().reverse());
  });

  it('no false positives on normal data / below 2x median / MAD=0 below 3x', async () => {
    const got = (await anomalies(u)).map((r) => r.expense_id);
    expect(got).not.toContain(ids.normal);
    expect(got).not.toContain(ids.notDouble);
    expect(got).not.toContain(ids.house8);
  });

  it('insufficient history (< 5 samples in the 180 days before the window) → not flagged', async () => {
    const got = (await anomalies(u)).map((r) => r.expense_id);
    expect(got).not.toContain(ids.transportBig);
    expect(got).not.toContain(ids.funBig);
  });

  it('p_days moves both window and history', async () => {
    // window = today only → nothing recent in it
    expect(await anomalies(u, 1)).toEqual([]);
    // window of 3 days: [T-2, T] contains big (food); history now [T-182, T-3] includes mid/notDouble
    const got = (await anomalies(u, 3)).map((r) => r.expense_id);
    expect(got).toContain(ids.big);
  });

  it('a user with only normal spending gets nothing', async () => {
    const v = await createUser(db);
    const t = await todayOf(v);
    const c = await categoryId(db, v, 'expense', 'Ăn uống');
    const amounts = [40, 42, 45, 47, 50, 52, 55, 41, 48, 53];
    for (let i = 0; i < amounts.length; i++) await exp(v, amounts[i] * 1000, addDays(t, -31 - i * 7), c);
    for (let i = 0; i < 10; i++) await exp(v, (44 + i) * 1000, addDays(t, -i * 3), c);
    expect(await anomalies(v)).toEqual([]);
  });

  it('validates p_days', async () => {
    await expect(anomalies(u, 0)).rejects.toThrow(/invalid_input/);
    await expect(anomalies(u, 366)).rejects.toThrow(/invalid_input/);
    await expect(anomalies(u, null)).rejects.toThrow(/invalid_input/);
    await expect(anomalies(u, 365)).resolves.toBeInstanceOf(Array);
  });
});

// =====================================================================
describe('suggest_expense_category', () => {
  let u, food, transport, fun, T;
  beforeAll(async () => {
    u = await createUser(db);
    T = await todayOf(u);
    food = await categoryId(db, u, 'expense', 'Ăn uống');
    transport = await categoryId(db, u, 'expense', 'Đi lại');
    fun = await categoryId(db, u, 'expense', 'Giải trí');
    await exp(u, 35_000, T, food, 'Cà phê sáng');
    await exp(u, 30_000, addDays(T, -3), food, 'ca phe sua da');
    await exp(u, 45_000, addDays(T, -10), food, 'CÀ PHÊ với khách');
    await exp(u, 80_000, addDays(T, -5), transport, 'Grab đi làm');
    await exp(u, 90_000, addDays(T, -6), transport, 'grab về nhà');
    await exp(u, 500_000, addDays(T, -7), transport, 'Vé xe Cà Mau');
    await exp(u, 60_000, addDays(T, -400), fun, 'Trà sữa'); // older than 365 days
    await exp(u, 60_000, addDays(T, -2), null, 'trà đá vỉa hè'); // uncategorised → ignored
  });

  it('vi_normalize strips diacritics (NFC and NFD) and lowercases', async () => {
    const [r] = await q(db, u, 'select public.vi_normalize($1) a, public.vi_normalize($2) b, public.vi_normalize(null) c', [
      'ĐÀ NẴNG Cà Phê Sữa Đá Ưu Ỷ',
      'Cà phê'.normalize('NFD'),
    ]);
    expect(r.a).toBe('da nang ca phe sua da uu y');
    expect(r.b).toBe('ca phe');
    expect(r.c).toBe('');
  });

  it('"ca phe" (no accents) matches "Cà phê" history; votes split by shared tokens', async () => {
    const rows = await suggest(u, 'ca phe');
    // food: 3 expenses × 2 tokens = 6 votes; transport "Cà Mau" shares "ca" = 1 vote
    expect(rows.map((r) => r.category_id)).toEqual([food, transport]);
    expect(rows[0].name).toBe('Ăn uống');
    expect(rows[0].confidence).toBe(0.86);
    expect(rows[1].confidence).toBe(0.14);
  });

  it('accented / upper-case query matches unaccented history', async () => {
    const rows = await suggest(u, 'CÀ PHÊ SỮA');
    expect(rows[0].category_id).toBe(food);
    const g = await suggest(u, 'GRAB tới công ty');
    expect(g).toEqual([{ category_id: transport, name: 'Đi lại', confidence: 1 }]);
  });

  it('ignores history older than 365 days, uncategorised rows and 1-char tokens', async () => {
    expect(await suggest(u, 'Trà')).toEqual([]); // only in a >365-day-old row and an uncategorised row
    expect(await suggest(u, 'vỉa hè')).toEqual([]);
    expect(await suggest(u, 'a b c')).toEqual([]);
    expect(await suggest(u, '')).toEqual([]);
    expect(await suggest(u, null)).toEqual([]);
    expect(await suggest(u, 'xyz không khớp')).toEqual([]);
  });

  it('returns at most 3, confidences sum to ~1', async () => {
    const v = await createUser(db);
    const t = await todayOf(v);
    const names = ['Ăn uống', 'Đi lại', 'Nhà ở', 'Mua sắm'];
    for (let i = 0; i < names.length; i++) {
      const c = await categoryId(db, v, 'expense', names[i]);
      for (let k = 0; k <= i; k++) await exp(v, 1000, t, c, `mixed item ${k}`);
    }
    const rows = await suggest(v, 'mixed');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(['Mua sắm', 'Nhà ở', 'Đi lại']);
    expect(rows[0].confidence).toBe(0.4); // 4 / 10
  });
});

// =====================================================================
describe('set_budget', () => {
  let u, other, food, taskCat, otherFood, M;
  beforeAll(async () => {
    u = await createUser(db);
    other = await createUser(db);
    M = monthStart(await todayOf(u));
    food = await categoryId(db, u, 'expense', 'Ăn uống');
    taskCat = await categoryId(db, u, 'task', 'Công việc');
    otherFood = await categoryId(db, other, 'expense', 'Ăn uống');
  });

  const setBudget = (user, amount, cat = null, month = null) =>
    q(db, user, 'select id, user_id, category_id, amount, effective_month::text from public.set_budget($1, $2, $3::date)', [
      amount,
      cat,
      month,
    ]).then((r) => r[0]);

  it('defaults to the current month and upserts (overall)', async () => {
    const a = await setBudget(u, 5_000_000);
    expect(a.effective_month).toBe(M);
    expect(a.category_id).toBeNull();
    expect(a.user_id).toBe(u);
    expect(Number(a.amount)).toBe(5_000_000);
    const b = await setBudget(u, 6_000_000);
    expect(b.id).toBe(a.id);
    expect(Number(b.amount)).toBe(6_000_000);
    const { rows } = await db.query('select count(*)::int n from public.budgets where user_id = $1', [u]);
    expect(rows[0].n).toBe(1);
  });

  it('per-category, month truncated, carry-forward visible in budget_status', async () => {
    const prev = addMonths(M, -1);
    const a = await setBudget(u, 1_000_000, food, addDays(prev, 17));
    expect(a.effective_month).toBe(prev);
    expect(a.category_id).toBe(food);
    const a2 = await setBudget(u, 1_500_000, food, prev);
    expect(a2.id).toBe(a.id);
    const rows = await budgetStatus(u);
    expect(rows.find((r) => r.category_id === food).budget).toBe(1_500_000);
    expect(rows[0].budget).toBe(6_000_000);
    // a zero budget is allowed
    const z = await setBudget(u, 0, food);
    expect(Number(z.amount)).toBe(0);
  });

  it('rejects bad input', async () => {
    await expect(setBudget(u, -1)).rejects.toThrow(/invalid_input/);
    await expect(setBudget(u, null)).rejects.toThrow(/invalid_input/);
    await expect(setBudget(u, 100, taskCat)).rejects.toThrow(/invalid_input/);
    await expect(setBudget(u, 100, otherFood)).rejects.toThrow(/not_found/); // other user's category
    await expect(setBudget(u, 100, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not_found/);
  });
});

// =====================================================================
// purchase_shopping_item is owned by migration 000200 (business_logic); smoke-test the
// purchase → expense flow it provides so the finance numbers above stay consistent.
describe('purchase_shopping_item (from 000200)', () => {
  let u, v, food;
  beforeAll(async () => {
    u = await createUser(db);
    v = await createUser(db);
    food = await categoryId(db, u, 'expense', 'Ăn uống');
  });

  const newItem = async (user, unit, qty, cat = null) =>
    (
      await q(db, user, 'insert into public.shopping_items (name, unit_price, quantity, category_id, status) values ($1,$2,$3,$4,$5) returning id', [
        'Gạo ST25',
        unit,
        qty,
        cat,
        'planned',
      ])
    )[0].id;

  it('creates and links an expense, then refuses a second purchase', async () => {
    const id = await newItem(u, 50_000, 2, food);
    await q(db, u, 'select public.purchase_shopping_item($1)', [id]);
    const [item] = await q(db, u, 'select status, expense_id, purchased_on::text from public.shopping_items where id = $1', [id]);
    expect(item.status).toBe('purchased');
    expect(item.purchased_on).toBe(await todayOf(u));
    expect(item.expense_id).toBeTruthy();
    const [e] = await q(db, u, 'select amount, category_id, description from public.expenses where id = $1', [item.expense_id]);
    expect(Number(e.amount)).toBe(100_000);
    expect(e.category_id).toBe(food);
    expect(e.description).toBe('Gạo ST25');
    await expect(q(db, u, 'select public.purchase_shopping_item($1)', [id])).rejects.toThrow();
    const n = await q(db, u, 'select count(*)::int n from public.expenses');
    expect(n[0].n).toBe(1);
  });

  it('other users cannot purchase it; create_expense=false and zero price create no expense', async () => {
    const id = await newItem(u, 10_000, 1);
    await expect(q(db, v, 'select public.purchase_shopping_item($1)', [id])).rejects.toThrow();
    await q(db, u, 'select public.purchase_shopping_item($1, null, $2, false)', [id, 'cash']);
    const free = await newItem(u, 0, 1);
    await q(db, u, 'select public.purchase_shopping_item($1)', [free]);
    const rows = await q(db, u, 'select expense_id from public.shopping_items where id = any($1)', [[id, free]]);
    expect(rows.every((r) => r.expense_id === null)).toBe(true);
  });
});

// =====================================================================
describe('security', () => {
  const calls = [
    ['budget_status', 'select * from public.budget_status()'],
    ['spending_summary', `select public.spending_summary('2026-01-01', '2026-01-31')`],
    ['expense_anomalies', 'select * from public.expense_anomalies()'],
    ['suggest_expense_category', `select * from public.suggest_expense_category('ca phe')`],
    ['set_budget', 'select * from public.set_budget(100)'],
  ];

  it('anon cannot execute any finance RPC', async () => {
    for (const [, sql] of calls) {
      await expect(asAnon(db, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('EXECUTE granted to authenticated only; functions are SECURITY INVOKER with empty search_path', async () => {
    const { rows } = await db.query(`
      select p.proname,
             p.prosecdef,
             p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('budget_status','spending_summary','expense_anomalies','suggest_expense_category','set_budget','vi_normalize')`);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=""');
      expect(r.anon_x, r.proname).toBe(false);
      expect(r.public_x, r.proname).toBe(false);
      expect(r.auth_x, r.proname).toBe(true);
    }
  });

  it("RLS: no RPC exposes another user's data", async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const t = await todayOf(a);
    const m = monthStart(t);
    const food = await categoryId(db, a, 'expense', 'Ăn uống');
    await budget(a, m, 1_000_000);
    await budget(a, m, 500_000, food);
    for (let i = 0; i < 6; i++) await exp(a, 50_000 + i * 1000, addDays(t, -40 - i), food, 'Cà phê');
    await exp(a, 900_000, t, food, 'Cà phê đắt');

    expect((await anomalies(a)).length).toBe(1);
    expect((await budgetStatus(a)).length).toBe(2);
    expect((await suggest(a, 'ca phe')).length).toBe(1);

    expect(await budgetStatus(b)).toEqual([]);
    expect(await anomalies(b)).toEqual([]);
    expect(await suggest(b, 'ca phe')).toEqual([]);
    const s = await summary(b, addDays(t, -60), t);
    expect(s.total).toBe(0);
    expect(s.by_category).toEqual([]);
    expect(s.prev_total).toBe(0);

    // b's set_budget writes b's row only
    await q(db, b, 'select public.set_budget(42)');
    const own = await q(db, a, 'select amount from public.budgets where category_id is null');
    expect(own.map((r) => Number(r.amount))).toEqual([1_000_000]);
  });

  it('a session without a user id sees nothing and cannot write', async () => {
    await expect(
      asUser(db, '', (tx) => tx.query('select * from public.set_budget(1)')),
    ).rejects.toThrow(/not_authenticated/);
    const rows = await asUser(db, '', async (tx) => (await tx.query('select * from public.budget_status()')).rows);
    expect(rows).toEqual([]);
  });
});
