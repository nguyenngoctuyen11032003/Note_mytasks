import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon, q, categoryId } from './harness.js';

let db, a, b;
beforeAll(async () => {
  db = await createDb();
  a = await createUser(db, { displayName: 'An' });
  b = await createUser(db, { displayName: 'Bình' });
});

describe('initial schema (harness smoke test)', () => {
  it('sign-up creates profile + 14 default categories', async () => {
    const cats = await q(db, a, 'select kind from public.categories');
    expect(cats).toHaveLength(14);
    const [p] = await q(db, a, 'select display_name from public.profiles');
    expect(p.display_name).toBe('An');
  });

  it('RLS isolates users', async () => {
    await q(db, a, `insert into public.tasks (title) values ('A task')`);
    expect(await q(db, b, 'select * from public.tasks')).toHaveLength(0);
    expect(await q(db, a, 'select * from public.tasks')).toHaveLength(1);
  });

  it('composite FK blocks cross-user category', async () => {
    const bCat = await categoryId(db, b, 'task', 'Công việc');
    await expect(q(db, a, 'insert into public.tasks (title, category_id) values ($1, $2)', ['x', bCat])).rejects.toThrow();
  });

  it('anon has no access', async () => {
    await expect(asAnon(db, (tx) => tx.query('select * from public.tasks'))).rejects.toThrow(/permission denied/);
  });

  it('completed_at trigger', async () => {
    const [t] = await q(db, a, `insert into public.tasks (title, status) values ('done', 'completed') returning completed_at`);
    expect(t.completed_at).toBeTruthy();
  });
});
