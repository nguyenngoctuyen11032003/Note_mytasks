// Migration 20261009001000_integrity_hardening.sql — each block reproduces a
// finding of the adversarial SQL audit and proves it is fixed.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, q } from './harness.js';

let db, a, b;
const one = async (u, sql, p) => (await q(db, u, sql, p))[0];
const fails = (u, sql, p) => q(db, u, sql, p).then(() => null, (e) => e);

beforeAll(async () => {
  db = await createDb();
  a = await createUser(db);
  b = await createUser(db);
});

describe('purchase_shopping_item never creates a second expense', () => {
  it('re-buy after un-purchasing reuses the linked expense', async () => {
    const { id } = await one(a, `insert into public.shopping_items (name, unit_price) values ('Nồi', 500000) returning id`);
    const first = await one(a, 'select * from public.purchase_shopping_item($1)', [id]);
    await q(db, a, `update public.shopping_items set status = 'planned' where id = $1`, [id]);
    const again = await one(a, 'select * from public.purchase_shopping_item($1)', [id]);
    expect(again.expense_id).toBe(first.expense_id);
    const { n } = await one(a, `select count(*)::int n from public.expenses where description = 'Nồi'`);
    expect(n).toBe(1);
  });

  it('creates a fresh expense when the old one was deleted', async () => {
    const { id } = await one(a, `insert into public.shopping_items (name, unit_price) values ('Chảo', 200000) returning id`);
    const first = await one(a, 'select * from public.purchase_shopping_item($1)', [id]);
    await q(db, a, 'delete from public.expenses where id = $1', [first.expense_id]);
    await q(db, a, `update public.shopping_items set status = 'planned' where id = $1`, [id]);
    const again = await one(a, 'select * from public.purchase_shopping_item($1)', [id]);
    expect(again.expense_id).toBeTruthy();
    expect(again.expense_id).not.toBe(first.expense_id);
  });
});

describe('recurring tasks: one open occurrence per series', () => {
  const series = (u, title) =>
    q(db, u, 'select status, due_date::text d from public.tasks where title = $1 order by created_at, due_date', [title]);
  const open = (rows) => rows.filter((r) => r.status === 'todo');

  it('null due date: reopen + re-complete on a later day does not duplicate', async () => {
    await q(db, a, `insert into public.tasks (title, recurrence) values ('R-null', 'daily')`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-null'`);
    // As if the first completion happened yesterday: its spawn is due today, so a
    // re-completion today computes next = tomorrow, later than the existing spawn
    // (the audited bug spawned a duplicate here).
    await db.query(
      `update public.tasks set due_date = due_date - 1 where user_id = $1 and title = 'R-null' and recurrence_parent_id is not null`, [a]);
    await q(db, a, `update public.tasks set status = 'todo' where title = 'R-null' and recurrence_parent_id is null`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-null' and recurrence_parent_id is null`);
    expect(open(await series(a, 'R-null'))).toHaveLength(1);
  });

  it('overdue task: reopen + re-complete does not duplicate', async () => {
    await q(db, a, `insert into public.tasks (title, recurrence, due_date) values ('R-old', 'daily', public.user_today() - 8)`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-old'`);
    await q(db, a, `update public.tasks set status = 'todo' where title = 'R-old' and recurrence_parent_id is null`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-old' and recurrence_parent_id is null`);
    expect(open(await series(a, 'R-old'))).toHaveLength(1);
  });

  it('completing the open occurrence still continues the series', async () => {
    await q(db, a, `insert into public.tasks (title, recurrence, due_date) values ('R-go', 'weekly', public.user_today())`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-go'`);
    await q(db, a, `update public.tasks set status = 'completed' where title = 'R-go' and status = 'todo'`);
    const rows = await series(a, 'R-go');
    expect(rows.map((r) => r.status).sort()).toEqual(['completed', 'completed', 'todo']);
  });
});

describe('time_entries rules for API callers', () => {
  const clear = (u) => db.query('delete from public.time_entries where user_id = $1', [u]);
  const ins = (u, s, e) =>
    q(db, u,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - $1::interval, now() - $2::interval, 'manual') returning *`, [s, e]);

  it('direct overlapping insert → time_overlap; back-to-back is fine', async () => {
    await clear(a);
    await ins(a, '3 hours', '2 hours');
    expect((await fails(a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - interval '150 minutes', now() - interval '90 minutes', 'manual')`)).message).toBe('time_overlap');
    await expect(ins(a, '2 hours', '1 hour')).resolves.toHaveLength(1);
  });

  it('a finished entry overlapping the running timer → time_overlap', async () => {
    await clear(a);
    await q(db, a, 'select public.start_timer()');
    await db.query(`update public.time_entries set started_at = now() - interval '1 hour' where user_id = $1`, [a]);
    expect((await fails(a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - interval '30 minutes', now() - interval '10 minutes', 'manual')`)).message).toBe('time_overlap');
  });

  it('a second running entry still reports unique_violation (database.test.sql contract)', async () => {
    await clear(a);
    await q(db, a, 'select public.start_timer()');
    expect((await fails(a, 'insert into public.time_entries (started_at) values (now())')).code).toBe('23505');
  });

  it('future end, manual > 24 h and reopening are rejected; ended < started stays a check_violation', async () => {
    await clear(a);
    expect((await fails(a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - interval '1 hour', now() + interval '30 days', 'manual')`)).message).toBe('invalid_input');
    expect((await fails(a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - interval '30 hours', now() - interval '1 hour', 'manual')`)).message).toBe('invalid_input');
    const [r] = await ins(a, '5 hours', '4 hours');
    expect((await fails(a, 'update public.time_entries set ended_at = null where id = $1', [r.id])).message).toBe('invalid_input');
    expect((await fails(a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now(), now() - interval '1 minute', 'manual')`)).code).toBe('23514');
  });

  it('description-only edits of legacy overlapping rows still work', async () => {
    await clear(a);
    await db.query(
      `insert into public.time_entries (user_id, started_at, ended_at, source) values
         ($1, now() - interval '5 hours', now() - interval '3 hours', 'manual'),
         ($1, now() - interval '4 hours', now() - interval '2 hours', 'manual')`, [a]);
    await expect(q(db, a, `update public.time_entries set description = 'ok'`)).resolves.toBeDefined();
  });

  it('start → stop → start immediately (one transaction) never overlaps', async () => {
    await clear(a);
    await asUser(db, a, async (tx) => {
      await tx.query('select public.start_timer()');
      await tx.query('select public.stop_timer()');   // sub-second → stretched to 1 s
      await tx.query('select public.start_timer()');  // must not raise time_overlap
    });
    const rows = await q(db, a, 'select started_at, ended_at from public.time_entries order by started_at');
    expect(rows).toHaveLength(2);
    expect(new Date(rows[1].started_at) >= new Date(rows[0].ended_at)).toBe(true);
  });

  it('trusted roles are not restricted', async () => {
    await expect(db.query(
      `insert into public.time_entries (user_id, started_at, ended_at, source)
       values ($1, now() - interval '40 hours', now() - interval '1 hour', 'manual')`, [b])).resolves.toBeDefined();
  });
});

describe('update_time_entry', () => {
  let e1, e2;
  beforeAll(async () => {
    await db.query('delete from public.time_entries where user_id = $1', [a]);
    [e1] = await q(db, a,
      `insert into public.time_entries (started_at, ended_at, source, description)
       values (now() - interval '4 hours', now() - interval '3 hours', 'manual', 'x') returning *`);
    [e2] = await q(db, a,
      `insert into public.time_entries (started_at, ended_at, source)
       values (now() - interval '2 hours', now() - interval '1 hour', 'manual') returning *`);
  });

  it('edits times / description and keeps unspecified fields', async () => {
    const r = await one(a, `select * from public.update_time_entry($1, null, now() - interval '5 hours', null, 'mới')`, [e1.id]);
    expect(r.description).toBe('mới');
    expect(new Date(r.ended_at).getTime()).toBe(new Date(e1.ended_at).getTime());
  });

  it('overlap / invalid / not found / other user', async () => {
    expect((await fails(a, `select public.update_time_entry($1, null, null, now() - interval '90 minutes')`, [e1.id])).message).toBe('time_overlap');
    expect((await fails(a, `select public.update_time_entry($1, null, now(), now() - interval '1 hour')`, [e1.id])).message).toBe('invalid_input');
    expect((await fails(a, 'select public.update_time_entry(gen_random_uuid())')).message).toBe('not_found');
    expect((await fails(b, `select public.update_time_entry($1, null, null, null, 'hack')`, [e2.id])).message).toBe('not_found');
  });

  it('anon cannot execute it', async () => {
    const { rows } = await db.query(
      `select has_function_privilege('anon', 'public.update_time_entry(uuid,uuid,timestamptz,timestamptz,text)', 'execute') a`);
    expect(rows[0].a).toBe(false);
  });
});

describe('finite calendar dates and bounded helpers', () => {
  it.each([
    `insert into public.tasks (title, due_date) values ('inf', 'infinity')`,
    `insert into public.tasks (title, due_date) values ('far', '5874897-12-31')`,
    `insert into public.kpis (name, target_value, end_date) values ('k', 1, 'infinity')`,
    `insert into public.expenses (amount, spent_on) values (1, '-infinity')`,
    `select public.set_budget(100, null, 'infinity')`,
  ])('rejected: %s', async (sql) => {
    expect(await fails(a, sql)).toBeTruthy();
  });

  it('dashboard / forecast / focus keep working', async () => {
    await expect(q(db, a, 'select public.dashboard_summary()')).resolves.toBeDefined();
    await expect(q(db, a, 'select * from public.focus_tasks(10)')).resolves.toBeDefined();
    await expect(q(db, a, 'select * from public.kpi_forecast()')).resolves.toBeDefined();
  });

  it('recurrence_next_date rejects extreme inputs fast and still computes normal ones', async () => {
    const t = Date.now();
    expect((await fails(a, `select public.recurrence_next_date('monthly', '0001-01-01', '200000-01-01')`)).message).toBe('invalid_input');
    expect(Date.now() - t).toBeLessThan(2000);
    const { d } = await one(a, `select public.recurrence_next_date('monthly', '2026-01-31', null)::text d`);
    expect(d).toBe('2026-02-28');
  });

  it('tags are limited to 1..100 characters', async () => {
    expect(await fails(a, `insert into public.tasks (title, tags) values ('t', array[repeat('x', 101)])`)).toBeTruthy();
    expect(await fails(a, `insert into public.tasks (title, tags) values ('t', array[''])`)).toBeTruthy();
    await expect(q(db, a, `insert into public.tasks (title, tags) values ('t', array['ok', repeat('y', 100)])`)).resolves.toBeDefined();
  });
});
