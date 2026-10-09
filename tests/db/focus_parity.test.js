// SQL focus_tasks (000300) and JS smart/scoring.js must agree exactly:
// the UI scores optimistically offline with the JS copy.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q } from './harness.js';
import { focusScore } from '../../src/services/smart/scoring.js';

let db, u;
beforeAll(async () => {
  db = await createDb();
  u = await createUser(db);
  // every combination of priority × due offset × status × estimate × age
  await db.query(`
    insert into public.tasks (user_id, title, priority, due_date, status, estimated_minutes, created_at)
    select $1, concat_ws(' ', p, d, s, e, a), p,
           case when d is null then null else public_today_hcm() + d end,
           s, e, now() - make_interval(days => a)
    from unnest(array['low','medium','high','urgent']) p,
         unnest(array[null,-20,-5,-1,0,1,2,3,4,7,8,30]::int[]) d,
         unnest(array['todo','in_progress']) s,
         unnest(array[null,0,15,30,31]::int[]) e,
         unnest(array[0,14,15,40]) a`.replace('public_today_hcm()', `(now() at time zone 'Asia/Ho_Chi_Minh')::date`), [u]);
});

describe('focus score parity SQL ↔ JS', () => {
  it('same score and reasons for every combination', async () => {
    const sql = await q(db, u, 'select * from public.focus_tasks(100)');
    const all = await q(db, u, `select id, priority, due_date::text as due_date, status, estimated_minutes, created_at from public.tasks`);
    const today = (await q(db, u, 'select public.user_today()::text as d'))[0].d;
    const byId = new Map(all.map((t) => [t.id, t]));
    expect(sql.length).toBe(100);
    for (const row of sql) {
      const js = focusScore(byId.get(row.task_id), today);
      expect({ id: row.task_id, score: js.score, reasons: js.reasons })
        .toEqual({ id: row.task_id, score: Number(row.score), reasons: row.reasons });
    }
    // and the ranking itself: JS-sorted top scores equal SQL's
    const jsScores = all.map((t) => focusScore(t, today).score).sort((a, b) => b - a).slice(0, 100);
    expect(sql.map((r) => Number(r.score))).toEqual(jsScores);
  });
});
