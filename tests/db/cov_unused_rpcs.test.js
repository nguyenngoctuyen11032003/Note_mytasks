// Coverage for the exposed-but-unused RPCs of migration 20261009000200_business_logic.sql
// (get_daily_expenses, get_expense_by_category, get_task_stats, get_time_by_day,
// get_time_by_category, get_budget_status, get_dashboard_summary, assert_date_range)
// plus current_user_timezone, user_day (000250/000600) and tags_valid (001000),
// against real Postgres (PGlite) with every migration applied.
//
// Dataset A is pinned to March 2026 in Asia/Ho_Chi_Minh (UTC+7, no DST) so every
// expected number is exact and hand-computed below. Several rows sit on a local
// midnight that is a different calendar day in UTC, to prove the RPCs bucket by the
// profile timezone and not by UTC.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon, q, categoryId } from './harness.js';

let db;
let A; // main user (Asia/Ho_Chi_Minh)
let B; // isolation user (America/New_York)
const ids = {};

const num = (v) => (v === null || v === undefined ? v : Number(v));
/** Instant of local wall-clock `day hh:mm` at a fixed UTC offset (hours). */
const atOff = (off) => (day, hhmm = '10:00', sec = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m, sec) - off * 3600000).toISOString();
};
const vn = atOff(7);
const plus = (iso, sec) => new Date(Date.parse(iso) + sec * 1000).toISOString();

async function task(user, f = {}) {
  const status = f.status ?? (f.completed_at ? 'completed' : 'todo');
  await db.exec('alter table public.tasks disable trigger trg_tasks_completed_at');
  try {
    const { rows } = await db.query(
      `insert into public.tasks (user_id, title, status, due_date, category_id, created_at, completed_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7) returning id`,
      [user, f.title ?? 'task', status, f.due_date ?? null, f.category_id ?? null, f.created_at ?? null, f.completed_at ?? null],
    );
    return rows[0].id;
  } finally {
    await db.exec('alter table public.tasks enable trigger trg_tasks_completed_at');
  }
}
async function entry(user, startedAt, endedAt, taskId = null) {
  const { rows } = await db.query(
    `insert into public.time_entries (user_id, task_id, started_at, ended_at, source)
     values ($1, $2, $3, $4, 'manual') returning id`,
    [user, taskId, startedAt, endedAt],
  );
  return rows[0].id;
}
const entryMin = (user, start, minutes, taskId = null) => entry(user, start, plus(start, minutes * 60), taskId);
async function exp(user, amount, day, catId = null) {
  await db.query('insert into public.expenses (user_id, amount, spent_on, category_id) values ($1, $2, $3, $4)', [user, amount, day, catId]);
}
async function budget(user, month, amount, catId = null) {
  await db.query('insert into public.budgets (user_id, effective_month, category_id, amount) values ($1, $2, $3, $4)', [user, month, catId, amount]);
}
const rpcRows = (user, sql, params) => q(db, user, sql, params);

beforeAll(async () => {
  db = await createDb();
  A = await createUser(db);
  B = await createUser(db);
  await db.query("update public.profiles set timezone = 'Asia/Ho_Chi_Minh' where id = $1", [A]);
  await db.query("update public.profiles set timezone = 'America/New_York' where id = $1", [B]);

  ids.food = await categoryId(db, A, 'expense', 'Ăn uống');
  ids.travel = await categoryId(db, A, 'expense', 'Đi lại');
  ids.home = await categoryId(db, A, 'expense', 'Nhà ở');
  ids.work = await categoryId(db, A, 'task', 'Công việc');
  ids.personal = await categoryId(db, A, 'task', 'Cá nhân');

  // ---- expenses (A) ----
  await exp(A, 100000, '2026-03-01', ids.food);
  await exp(A, 50000, '2026-03-01', ids.food);
  await exp(A, 30000, '2026-03-02', ids.travel);
  await exp(A, 20000, '2026-03-04', null);
  await exp(A, 999, '2026-02-28', ids.food); // before the report range
  await exp(A, 777, '2026-03-08', null); // after the report range, same month
  // ---- budgets (A) ----
  await budget(A, '2026-01-01', 500000); // overall, carried forward into March
  await budget(A, '2026-04-01', 1000000); // overall, from April
  await budget(A, '2026-02-01', 100000, ids.food);
  await budget(A, '2026-03-01', 300000, ids.home); // budget, no spending

  // ---- tasks (A) ----
  // t1: created 23:30 local 03-01 (16:30Z), completed 00:30 local 03-02 (17:30Z on 03-01!)
  ids.t1 = await task(A, { created_at: vn('2026-03-01', '23:30'), completed_at: vn('2026-03-02', '00:30') });
  ids.t2 = await task(A, { created_at: vn('2026-03-03', '10:00'), category_id: ids.work });
  // t3: created 06:00 local 03-03 = 23:00Z on 03-02
  ids.t3 = await task(A, { created_at: vn('2026-03-03', '06:00'), category_id: ids.personal });
  ids.t4 = await task(A, { created_at: vn('2026-02-27', '09:00'), completed_at: vn('2026-03-05', '09:00') });
  ids.t5 = await task(A, { created_at: vn('2026-03-08', '00:10') }); // 03-07 17:10Z — outside in local time

  // ---- time entries (A) ----
  await entryMin(A, vn('2026-03-01', '23:50'), 30, ids.t2); // day 03-01 (crosses local midnight)
  await entryMin(A, vn('2026-03-02', '08:00'), 90, ids.t3);
  await entryMin(A, vn('2026-03-02', '10:00'), 45);
  await entry(A, vn('2026-03-04', '12:00'), plus(vn('2026-03-04', '12:00'), 50)); // 50 s
  await entryMin(A, vn('2026-03-06', '07:00'), 20, ids.t2);
  await entryMin(A, vn('2026-03-07', '23:30'), 60, ids.t3); // day 03-07, ends on 03-08
  await entryMin(A, vn('2026-02-28', '23:00'), 59); // before range (16:00Z 02-28)
  await entryMin(A, vn('2026-03-08', '00:10'), 10); // after range locally, 03-07 in UTC

  // ---- B: a little data of its own on the same days ----
  const bFood = await categoryId(db, B, 'expense', 'Ăn uống');
  await exp(B, 5000, '2026-03-01', bFood);
  await budget(B, '2026-03-01', 70000);
  await task(B, { created_at: '2026-03-02T15:00:00Z', completed_at: '2026-03-02T16:00:00Z' });
  await entryMin(B, '2026-03-02T15:00:00Z', 15);
});

const RANGE = ['2026-03-01', '2026-03-07'];

// ===========================================================================
describe('get_daily_expenses', () => {
  it('one row per day, zero-filled, exact totals', async () => {
    const rows = await rpcRows(A, 'select day::text, total, tx_count from public.get_daily_expenses($1, $2)', RANGE);
    expect(rows.map((r) => [r.day, num(r.total), num(r.tx_count)])).toEqual([
      ['2026-03-01', 150000, 2],
      ['2026-03-02', 30000, 1],
      ['2026-03-03', 0, 0],
      ['2026-03-04', 20000, 1],
      ['2026-03-05', 0, 0],
      ['2026-03-06', 0, 0],
      ['2026-03-07', 0, 0],
    ]);
  });

  it('single-day range and range edges', async () => {
    expect((await rpcRows(A, 'select day::text, total from public.get_daily_expenses($1, $1)', ['2026-02-28']))
      .map((r) => [r.day, num(r.total)])).toEqual([['2026-02-28', 999]]);
    const feb28toMar1 = await rpcRows(A, 'select count(*) n, sum(total) s from public.get_daily_expenses($1, $2)', ['2026-02-28', '2026-03-01']);
    expect([num(feb28toMar1[0].n), num(feb28toMar1[0].s)]).toEqual([2, 150999]);
  });

  it('days do not shift with the session TimeZone (generate_series over timestamptz)', async () => {
    for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'America/Sao_Paulo']) {
      const rows = await asUser(db, A, async (tx) => {
        await tx.query(`select set_config('timezone', $1, true)`, [tz]);
        return (await tx.query("select day::text from public.get_daily_expenses('2026-03-06', '2026-03-10')")).rows;
      });
      expect(rows.map((r) => r.day), tz).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
    }
  });
});

// ===========================================================================
describe('get_expense_by_category', () => {
  it('totals, counts, share %, ordered by total desc; uncategorised as NULL', async () => {
    const rows = await rpcRows(A, 'select category_id, category_name, color, total, tx_count, share_percent from public.get_expense_by_category($1, $2)', RANGE);
    expect(rows.map((r) => [r.category_id, r.category_name, num(r.total), num(r.tx_count), num(r.share_percent)])).toEqual([
      [ids.food, 'Ăn uống', 150000, 2, 75],
      [ids.travel, 'Đi lại', 30000, 1, 15],
      [null, null, 20000, 1, 10],
    ]);
    expect(rows[0].color).toBe('#E5793B');
  });

  it('empty range → no rows', async () => {
    expect(await rpcRows(A, 'select * from public.get_expense_by_category($1, $1)', ['2026-03-03'])).toEqual([]);
  });
});

// ===========================================================================
describe('get_task_stats', () => {
  it('created / completed per LOCAL day (timezone-boundary rows land on the local day)', async () => {
    const rows = await rpcRows(A, 'select day::text, created_count, completed_count from public.get_task_stats($1, $2)', RANGE);
    expect(rows.map((r) => [r.day, num(r.created_count), num(r.completed_count)])).toEqual([
      ['2026-03-01', 1, 0], // t1 (UTC would say 03-01 too)
      ['2026-03-02', 0, 1], // t1 completed 00:30 local (UTC: 03-01)
      ['2026-03-03', 2, 0], // t2, t3 (t3 is 03-02 in UTC)
      ['2026-03-04', 0, 0],
      ['2026-03-05', 0, 1], // t4
      ['2026-03-06', 0, 0],
      ['2026-03-07', 0, 0], // t5 is 03-07 in UTC but 03-08 locally
    ]);
  });
});

// ===========================================================================
describe('get_time_by_day', () => {
  it('finished minutes and entry counts per local start day', async () => {
    const rows = await rpcRows(A, 'select day::text, minutes, entry_count from public.get_time_by_day($1, $2)', RANGE);
    expect(rows.map((r) => [r.day, num(r.minutes), num(r.entry_count)])).toEqual([
      ['2026-03-01', 30, 1],
      ['2026-03-02', 135, 2],
      ['2026-03-03', 0, 0],
      ['2026-03-04', 1, 1], // 50 s rounds to 1 min
      ['2026-03-05', 0, 0],
      ['2026-03-06', 20, 1],
      ['2026-03-07', 60, 1], // the 00:10 local 03-08 entry is excluded
    ]);
  });

  it('a running segment is not counted', async () => {
    const C = await createUser(db);
    await entryMin(C, vn('2026-03-02', '08:00'), 30);
    await entry(C, vn('2026-03-02', '09:00'), null);
    const rows = await rpcRows(C, "select minutes, entry_count from public.get_time_by_day('2026-03-02', '2026-03-02')");
    expect([num(rows[0].minutes), num(rows[0].entry_count)]).toEqual([30, 1]);
    const cat = await rpcRows(C, "select minutes from public.get_time_by_category('2026-03-02', '2026-03-02')");
    expect(cat.map((r) => num(r.minutes))).toEqual([30]);
  });

  it('DST zone: the 23-hour and 25-hour days bucket correctly (America/New_York)', async () => {
    const ny = '2026-03-08T04:30:00Z'; // 23:30 EST on 03-07
    await entryMin(B, ny, 20);
    await entryMin(B, '2026-03-09T03:30:00Z', 20); // 23:30 EDT on 03-08
    await entryMin(B, '2026-03-09T04:10:00Z', 10); // 00:10 EDT on 03-09
    const rows = await rpcRows(B, "select day::text, minutes from public.get_time_by_day('2026-03-07', '2026-03-09')");
    expect(rows.map((r) => [r.day, num(r.minutes)])).toEqual([['2026-03-07', 20], ['2026-03-08', 20], ['2026-03-09', 10]]);
  });
});

// ===========================================================================
describe('get_time_by_category', () => {
  it('minutes and share per task category; NULL = no task / no category', async () => {
    // Cá nhân: 90 + 60 min = 9000 s; Công việc: 30 + 20 = 3000 s; none: 45 min + 50 s = 2750 s
    const rows = await rpcRows(A, 'select category_id, category_name, minutes, share_percent from public.get_time_by_category($1, $2)', RANGE);
    expect(rows.map((r) => [r.category_id, r.category_name, num(r.minutes), num(r.share_percent)])).toEqual([
      [ids.personal, 'Cá nhân', 150, 61],
      [ids.work, 'Công việc', 50, 20.3],
      [null, null, 46, 18.6],
    ]);
  });
});

// ===========================================================================
describe('get_budget_status', () => {
  const status = (user, month) => rpcRows(user,
    'select category_id, category_name, budget_amount, spent, remaining, percent_used from public.get_budget_status($1::date)', [month])
    .then((rows) => rows.map((r) => [r.category_name, num(r.budget_amount), num(r.spent), num(r.remaining), num(r.percent_used)]));

  it('March: carry-forward budgets, overall row first, categories by sort order', async () => {
    expect(await status(A, '2026-03-15')).toEqual([
      [null, 500000, 200777, 299223, 40.2], // overall: all March spending incl. uncategorised + 03-08
      ['Ăn uống', 100000, 150000, -50000, 150], // Feb budget carried forward
      ['Đi lại', null, 30000, null, null], // spending without budget
      ['Nhà ở', 300000, 0, 300000, 0], // budget without spending
    ]);
  });

  it('April: the newer overall budget applies, category budgets still carry forward', async () => {
    expect(await status(A, '2026-04-01')).toEqual([
      [null, 1000000, 0, 1000000, 0],
      ['Ăn uống', 100000, 0, 100000, 0],
      ['Nhà ở', 300000, 0, 300000, 0],
    ]);
  });

  it('before any budget: overall row has a null budget', async () => {
    expect(await status(A, '2025-12-01')).toEqual([[null, null, 0, null, null]]);
  });

  it('null month = the user\'s current month (no crash)', async () => {
    const rows = await rpcRows(A, 'select category_id from public.get_budget_status()');
    expect(rows[0].category_id).toBeNull();
  });
});

// ===========================================================================
describe('date range validation (assert_date_range and every report RPC)', () => {
  const REPORTS = ['get_daily_expenses', 'get_expense_by_category', 'get_task_stats', 'get_time_by_day', 'get_time_by_category'];
  const bad = [
    [null, '2026-03-01', /requires both/],
    ['2026-03-01', null, /requires both/],
    ['2026-03-02', '2026-03-01', /on or before/],
    ['2026-01-01', '2027-01-03', /366 days/], // 367 days apart
  ];

  async function err(user, sql, params) {
    try {
      await rpcRows(user, sql, params);
    } catch (e) {
      return e;
    }
    return null;
  }

  it('assert_date_range: rejects with SQLSTATE 22023, accepts up to 366 days apart', async () => {
    for (const [f, t, re] of bad) {
      const e = await err(A, 'select public.assert_date_range($1::date, $2::date)', [f, t]);
      expect(e?.code, `${f}..${t}`).toBe('22023');
      expect(e.message).toMatch(re);
    }
    await rpcRows(A, "select public.assert_date_range('2026-01-01', '2027-01-02')"); // 366 apart
    await rpcRows(A, "select public.assert_date_range('2026-03-01', '2026-03-01')");
  });

  it.each(REPORTS)('%s rejects invalid ranges and accepts the 366-day maximum', async (fn) => {
    for (const [f, t, re] of bad) {
      const e = await err(A, `select * from public.${fn}($1::date, $2::date)`, [f, t]);
      expect(e?.code, `${fn} ${f}..${t}`).toBe('22023');
      expect(e.message).toMatch(re);
    }
    await rpcRows(A, `select * from public.${fn}('2026-01-01', '2027-01-02')`);
  });
});

// ===========================================================================
describe('RLS isolation', () => {
  it('B sees none of A\'s rows in any report RPC (only its own)', async () => {
    const daily = await rpcRows(B, 'select day::text, total from public.get_daily_expenses($1, $2) where total > 0', RANGE);
    expect(daily.map((r) => [r.day, num(r.total)])).toEqual([['2026-03-01', 5000]]);

    const byCat = await rpcRows(B, 'select category_id, total from public.get_expense_by_category($1, $2)', RANGE);
    expect(byCat.map((r) => num(r.total))).toEqual([5000]);
    expect(byCat.some((r) => [ids.food, ids.travel].includes(r.category_id))).toBe(false);

    const stats = await rpcRows(B, 'select sum(created_count) c, sum(completed_count) d from public.get_task_stats($1, $2)', RANGE);
    expect([num(stats[0].c), num(stats[0].d)]).toEqual([1, 1]);

    const byDay = await rpcRows(B, 'select sum(minutes) m, sum(entry_count) n from public.get_time_by_day($1, $2)', ['2026-03-01', '2026-03-06']);
    expect([num(byDay[0].m), num(byDay[0].n)]).toEqual([15, 1]);

    const tcat = await rpcRows(B, "select category_id, minutes from public.get_time_by_category('2026-03-01', '2026-03-06')");
    expect(tcat.map((r) => [r.category_id, num(r.minutes)])).toEqual([[null, 15]]);

    const bs = await rpcRows(B, "select category_id, budget_amount, spent from public.get_budget_status('2026-03-01')");
    expect(bs.map((r) => [num(r.budget_amount), num(r.spent)])).toEqual([[70000, 5000], [null, 5000]]);
    expect(bs.some((r) => [ids.food, ids.home].includes(r.category_id))).toBe(false);

    const [{ s }] = await rpcRows(B, 'select public.get_dashboard_summary() s');
    expect(s.timezone).toBe('America/New_York');
  });

  it('a user with no data gets zero-filled / empty results', async () => {
    const C = await createUser(db);
    const daily = await rpcRows(C, 'select sum(total) t, count(*) n from public.get_daily_expenses($1, $2)', RANGE);
    expect([num(daily[0].t), num(daily[0].n)]).toEqual([0, 7]);
    expect(await rpcRows(C, 'select * from public.get_expense_by_category($1, $2)', RANGE)).toEqual([]);
    expect(await rpcRows(C, 'select * from public.get_time_by_category($1, $2)', RANGE)).toEqual([]);
  });
});

// ===========================================================================
describe('anon is denied', () => {
  const CALLS = [
    "select public.get_dashboard_summary()",
    "select * from public.get_budget_status('2026-03-01')",
    "select * from public.get_expense_by_category('2026-03-01', '2026-03-07')",
    "select * from public.get_daily_expenses('2026-03-01', '2026-03-07')",
    "select * from public.get_task_stats('2026-03-01', '2026-03-07')",
    "select * from public.get_time_by_day('2026-03-01', '2026-03-07')",
    "select * from public.get_time_by_category('2026-03-01', '2026-03-07')",
    "select public.assert_date_range('2026-03-01', '2026-03-07')",
    'select public.current_user_timezone()',
    'select public.user_today()',
    'select public.user_day(now())',
    "select public.tags_valid(array['a'])",
  ];
  it.each(CALLS)('%s → permission denied (42501)', async (sql) => {
    let e = null;
    try { await asAnon(db, (tx) => tx.query(sql)); } catch (x) { e = x; }
    expect(e?.code).toBe('42501');
  });

  it('get_dashboard_summary without a JWT sub (role authenticated) → 42501 not authenticated', async () => {
    let e = null;
    try {
      await db.transaction(async (tx) => {
        await tx.exec('set local role authenticated');
        await tx.query('select public.get_dashboard_summary()');
      });
    } catch (x) { e = x; }
    expect(e?.code).toBe('42501');
  });
});

// ===========================================================================
describe('current_user_timezone / user_day', () => {
  it('returns the profile timezone; default when the profile row is missing', async () => {
    expect((await rpcRows(A, 'select public.current_user_timezone() tz'))[0].tz).toBe('Asia/Ho_Chi_Minh');
    expect((await rpcRows(B, 'select public.current_user_timezone() tz'))[0].tz).toBe('America/New_York');
    const C = await createUser(db);
    await db.query('delete from public.profiles where id = $1', [C]);
    expect((await rpcRows(C, 'select public.current_user_timezone() tz'))[0].tz).toBe('Asia/Ho_Chi_Minh');
  });

  it('user_day buckets an instant by the caller\'s timezone', async () => {
    const day = async (u, ts) => (await rpcRows(u, 'select public.user_day($1::timestamptz)::text d', [ts]))[0].d;
    expect(await day(A, '2026-03-01T17:30:00Z')).toBe('2026-03-02'); // 00:30 +07
    expect(await day(A, '2026-03-01T16:59:59Z')).toBe('2026-03-01');
    expect(await day(B, '2026-03-01T17:30:00Z')).toBe('2026-03-01');
    // New York DST boundaries
    expect(await day(B, '2026-03-08T04:59:00Z')).toBe('2026-03-07');
    expect(await day(B, '2026-03-08T05:00:00Z')).toBe('2026-03-08');
    expect(await day(B, '2026-03-09T03:59:00Z')).toBe('2026-03-08');
    expect(await day(B, '2026-03-09T04:00:00Z')).toBe('2026-03-09');
    expect(await day(B, '2026-11-01T03:59:00Z')).toBe('2026-10-31');
    expect(await day(B, '2026-11-01T04:00:00Z')).toBe('2026-11-01');
    expect(await day(B, '2026-11-02T04:59:00Z')).toBe('2026-11-01');
    expect(await day(B, '2026-11-02T05:00:00Z')).toBe('2026-11-02');
    expect(await rpcRows(A, 'select public.user_day(null) d')).toEqual([{ d: null }]);
  });

  it('user_today matches the timezone and follows a profile change', async () => {
    const C = await createUser(db);
    const today = async () => (await rpcRows(C, 'select public.user_today()::text t'))[0].t;
    const local = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      await db.query('update public.profiles set timezone = $1 where id = $2', [tz, C]);
      const b = local(tz);
      const t = await today();
      expect([b, local(tz)]).toContain(t);
    }
  });
});

// ===========================================================================
describe('tags_valid', () => {
  const tv = async (tags) => (await rpcRows(A, 'select public.tags_valid($1::text[]) v', [tags]))[0].v;
  it('null / empty / normal tags are valid', async () => {
    expect(await tv(null)).toBe(true);
    expect(await tv([])).toBe(true);
    expect(await tv(['a', 'work', 'việc nhà'])).toBe(true);
    expect(await tv(['x'.repeat(100)])).toBe(true);
    expect(await tv(['ệ'.repeat(100)])).toBe(true); // characters, not bytes
  });
  it('empty string, NULL element, > 100 characters are invalid', async () => {
    expect(await tv([''])).toBe(false);
    expect(await tv(['ok', null])).toBe(false);
    expect(await tv(['x'.repeat(101)])).toBe(false);
    expect(await tv(['ok', 'ệ'.repeat(101)])).toBe(false);
  });
  it('is enforced on tasks and notes (constraint)', async () => {
    let e = null;
    try { await rpcRows(A, "insert into public.tasks (title, tags) values ('x', array[''])"); } catch (x) { e = x; }
    expect(e?.code).toBe('23514');
    e = null;
    try { await rpcRows(A, "insert into public.notes (title, tags) values ('x', array[repeat('y', 101)])"); } catch (x) { e = x; }
    expect(e?.code).toBe('23514');
  });
});

// ===========================================================================
describe('get_dashboard_summary', () => {
  // Fixed-offset zone where the local clock reads ~12:00 now → no midnight races.
  const OFF = 12 - new Date().getUTCHours();
  const TZ = OFF === 0 ? 'Etc/UTC' : `Etc/GMT${OFF > 0 ? '-' : '+'}${Math.abs(OFF)}`;
  const at = atOff(OFF);
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('exact numbers for every block', async () => {
    const D = await createUser(db);
    await db.query('update public.profiles set timezone = $1, week_starts_on = 1 where id = $2', [TZ, D]);
    const T = (await rpcRows(D, 'select public.user_today()::text t'))[0].t;
    const dow = new Date(`${T}T00:00:00Z`).getUTCDay();
    const ws = addDays(T, -((dow - 1 + 7) % 7));
    const ms = `${T.slice(0, 7)}-01`;
    const pm = (() => { const d = new Date(`${ms}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
    const Y = addDays(T, -1);
    const yInWeek = Y >= ws ? 1 : 0;
    const yInMonth = Y >= ms ? 1 : 0;

    // tasks
    await task(D, { status: 'todo', due_date: T });
    await task(D, { status: 'in_progress', due_date: Y });
    await task(D, { status: 'todo' });
    await task(D, { status: 'cancelled', due_date: Y });
    await task(D, { completed_at: at(T, '09:00') });
    await task(D, { completed_at: at(Y, '09:00') });
    await task(D, { completed_at: at(addDays(T, -40), '09:00') });
    // time
    await entryMin(D, at(T, '08:00'), 30);
    await entryMin(D, at(Y, '08:00'), 45);
    await entryMin(D, at(addDays(T, -8), '08:00'), 60);
    const runStart = new Date(Date.now() - 600_000).toISOString();
    const runId = await entry(D, runStart, null);
    // money
    await exp(D, 10000, T);
    await exp(D, 20000, Y);
    await exp(D, 5000, pm);
    await exp(D, 7777, addDays(pm, -1)); // before the previous month
    await budget(D, pm, 400000);
    await budget(D, `${addDays(ms, 31).slice(0, 7)}-01`, 900000); // next month: not yet effective
    await budget(D, ms, 1, await categoryId(db, D, 'expense', 'Khác')); // category budget: ignored
    // kpis
    await db.query(`insert into public.kpis (user_id, name, target_value, current_value, start_date, status) values
      ($1, 'a', 200, 50, '2026-01-01', 'active'), ($1, 'b', 10, 30, '2026-01-01', 'active'),
      ($1, 'c', 1, 1, '2026-01-01', 'completed'), ($1, 'd', 5, 1, '2026-01-01', 'paused')`, [D]);
    // shopping
    await db.query(`insert into public.shopping_items (user_id, name, unit_price, quantity, priority, status, purchased_on) values
      ($1, 'w', 1000, 2, 'must_buy', 'wishlist', null), ($1, 'p1', 5000, 3, 'high', 'planned', null),
      ($1, 'p2', 2500, 1, 'must_buy', 'planned', null), ($1, 'x', 9, 1, 'must_buy', 'purchased', $2),
      ($1, 'y', 9, 1, 'must_buy', 'cancelled', null)`, [D, T]);

    const [{ s }] = await rpcRows(D, 'select public.get_dashboard_summary() s');
    expect(s.today).toBe(T);
    expect(s.week_start).toBe(ws);
    expect(s.timezone).toBe(TZ);
    expect(s.tasks).toEqual({
      open: 3, in_progress: 1, due_today: 1, overdue: 1,
      completed_today: 1, completed_this_week: 1 + yInWeek, completed_this_month: 1 + yInMonth,
    });
    // running 10 min counts toward today (+ a few ms of execution)
    expect(s.time.today_minutes).toBe(40);
    expect(s.time.week_minutes).toBe(40 + 45 * yInWeek + (addDays(T, -8) >= ws ? 60 : 0));
    expect(s.time.running).toMatchObject({ id: runId, task_id: null, task_title: null });
    expect(Date.parse(s.time.running.started_at)).toBe(Date.parse(runStart));
    expect(s.expenses).toEqual({
      month: ms,
      month_total: 10000 + 20000 * yInMonth,
      month_count: 1 + yInMonth,
      today_total: 10000,
      prev_month_total: 5000 + 20000 * (1 - yInMonth),
      budget_total: 400000,
    });
    expect(s.kpis).toEqual({ active: 2, completed: 1, avg_progress_percent: 62.5 });
    expect(s.shopping).toEqual({ wishlist: 1, planned: 2, planned_total: 17500, must_buy: 2 });
  });
});
