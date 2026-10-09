// 000600 must repair a hosted DB whose 000300–000500 function bodies drifted
// (pushed while still being written) — simulate the drift, re-apply, compare.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, createUser, q } from './harness.js';

const RESYNC = readFileSync(new URL('../../supabase/migrations/20261009000600_resync_smart_functions.sql', import.meta.url), 'utf8');
const fnDef = async (db, name) =>
  (await db.query(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = $1`, [name])).rows.map((r) => r.d).join('\n');

let db, u;
beforeAll(async () => {
  db = await createDb();
  u = await createUser(db);
});

describe('000600 resync migration', () => {
  it('is idempotent on an up-to-date database', async () => {
    const before = await fnDef(db, 'stop_timer');
    await db.exec(RESYNC);
    await db.exec(RESYNC);
    expect(await fnDef(db, 'stop_timer')).toBe(before);
  });

  it('restores drifted function bodies and privileges', async () => {
    const good = await fnDef(db, 'stop_timer');
    await db.exec(`
      create or replace function public.stop_timer() returns public.time_entries
      language plpgsql set search_path = '' as $$ begin return null; end; $$;
      grant execute on function public.stop_timer() to anon;`);
    expect(await fnDef(db, 'stop_timer')).not.toBe(good);

    await db.exec(RESYNC);
    expect(await fnDef(db, 'stop_timer')).toBe(good);
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.focus_tasks(integer)', 'execute') as a`);
    expect(rows[0].a).toBe(false);
  });

  it('recreates a missing recurrence trigger', async () => {
    await db.exec('drop trigger trg_tasks_spawn_recurrence on public.tasks');
    await db.exec(RESYNC);
    await q(db, u, `insert into public.tasks (title, recurrence, due_date) values ('Daily', 'daily', public.user_today())`);
    await q(db, u, `update public.tasks set status = 'completed' where title = 'Daily'`);
    const rows = await q(db, u, `select status from public.tasks where title = 'Daily' order by due_date`);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'todo']);
  });
});
