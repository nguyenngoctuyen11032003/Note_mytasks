// 001400 / 001500: Fitora tables, RLS, RPCs and the private `fitora` storage bucket.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, createUser, asUser, asAnon, q } from './harness.js';

let db, a, b;
const num = (v) => (v === null || v === undefined ? v : Number(v));

const TABLES = [
  'fit_profiles', 'fit_custom_foods', 'fit_meal_entries', 'fit_workout_templates', 'fit_workouts',
  'fit_daily_logs', 'fit_body_measurements', 'fit_progress_photos', 'fit_ai_usage',
];

/** Minimal valid row per writable table (user_id comes from auth.uid()). */
const sample = (uid) => ({
  fit_profiles: { sex: 'female', birth_date: '1995-05-01', height_cm: 165, activity_level: 'light', goal: 'lose',
    start_weight_kg: 62, calorie_target: 1600, protein_g: 120, carbs_g: 160, fat_g: 50 },
  fit_custom_foods: { name: 'Bánh mì nhà làm', serving_grams: 120, kcal_100g: 260 },
  fit_meal_entries: { eaten_on: '2026-03-10', meal: 'lunch', name: 'Phở bò', quantity: 1, unit: 'bát', grams: 500, kcal: 450 },
  fit_workout_templates: { name: 'Chạy sáng', category: 'running', activity: 'running_8kmh', met: 8.3, duration_min: 30 },
  fit_workouts: { workout_on: '2026-03-10', category: 'gym', activity: 'weights', title: 'Tập ngực', met: 5, duration_min: 45, kcal: 250 },
  fit_daily_logs: { log_date: '2026-03-10', water_ml: 500, steps: 4000 },
  fit_body_measurements: { measured_on: '2026-03-10', weight_kg: 61.5 },
  fit_progress_photos: { taken_on: '2026-03-10', storage_path: `${uid}/progress/x.webp` },
});

async function insertRow(tx, table, row) {
  const cols = Object.keys(row);
  if (!cols.length) return (await tx.query(`insert into public.${table} default values returning *`)).rows[0];
  const sql = `insert into public.${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`;
  return (await tx.query(sql, Object.values(row))).rows[0];
}
const ins = (uid, table, row) => asUser(db, uid, (tx) => insertRow(tx, table, row));

beforeAll(async () => {
  db = await createDb();
  a = await createUser(db);
  b = await createUser(db);
});

describe('001400 fitora schema: privileges & RLS', () => {
  it('every fit_* table has RLS enabled and anon has no privileges', async () => {
    const { rows } = await db.query(`
      select c.relname, c.relrowsecurity,
             has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
               or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete') as anon_any
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'fit\\_%' and c.relkind = 'r'`);
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.anon_any, r.relname).toBe(false);
    }
  });

  it('anon is denied on every table and RPC', async () => {
    for (const t of TABLES) {
      await expect(asAnon(db, (tx) => tx.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
    for (const call of ["public.fit_day_summary('2026-03-10')", "public.fit_range_summary('2026-03-01', '2026-03-02')", 'public.fit_ai_quota_consume()']) {
      await expect(asAnon(db, (tx) => tx.query(`select ${call}`)), call).rejects.toThrow(/permission denied/);
    }
  });

  it('A/B isolation on every writable table (select / update / delete / forged insert)', async () => {
    const rowsA = sample(a);
    for (const [table, row] of Object.entries(rowsA)) {
      const created = await ins(a, table, row);
      expect(created.user_id, table).toBe(a);
    }
    for (const table of Object.keys(rowsA)) {
      await asUser(db, b, async (tx) => {
        expect((await tx.query(`select 1 from public.${table}`)).rows, table).toHaveLength(0);
        expect((await tx.query(`update public.${table} set user_id = user_id`)).affectedRows, table).toBe(0);
        expect((await tx.query(`delete from public.${table}`)).affectedRows, table).toBe(0);
      });
      // B cannot write a row owned by A
      await expect(ins(b, table, { ...sample(a)[table], user_id: a }), table).rejects.toThrow(/row-level security/);
      // A cannot hand its row over to B
      await expect(asUser(db, a, (tx) => tx.query(`update public.${table} set user_id = $1`, [b])), table)
        .rejects.toThrow(/row-level security|violates foreign key/);
      const own = await q(db, a, `select count(*)::int n from public.${table}`);
      expect(own[0].n, table).toBe(1);
    }
  });

  it('fit_ai_usage is read-only for clients', async () => {
    for (const sql of [
      "insert into public.fit_ai_usage (used_on, count) values ('2026-03-10', 0)",
      'update public.fit_ai_usage set count = 0',
      'delete from public.fit_ai_usage',
    ]) {
      await expect(asUser(db, a, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('does not touch objects of the other app (purely additive)', async () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261009001400_fitora_schema.sql', import.meta.url), 'utf8');
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(alter|drop)\s+(table|function|view|type|schema)\b(?![^;]*\bfit_)/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it('is idempotent', async () => {
    for (const f of ['20261009001400_fitora_schema.sql', '20261009001500_fitora_storage.sql']) {
      await db.exec(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8'));
    }
    const { rows } = await db.query("select count(*)::int n from pg_policies where schemaname = 'public' and tablename like 'fit\\_%'");
    expect(rows[0].n).toBe(8 * 4 + 1);
  });
});

describe('001400 composite foreign keys', () => {
  let foodB, tplB, foodA, tplA;
  beforeAll(async () => {
    foodB = (await ins(b, 'fit_custom_foods', { name: 'B food', serving_grams: 100 })).id;
    tplB = (await ins(b, 'fit_workout_templates', { name: 'B tpl', activity: 'x', met: 4, duration_min: 20 })).id;
    foodA = (await ins(a, 'fit_custom_foods', { name: 'A food', serving_grams: 100 })).id;
    tplA = (await ins(a, 'fit_workout_templates', { name: 'A tpl', activity: 'x', met: 4, duration_min: 20 })).id;
  });

  it("cannot reference another user's custom food or template", async () => {
    await expect(ins(a, 'fit_meal_entries', { eaten_on: '2026-03-11', meal: 'snack', name: 'x', custom_food_id: foodB, source: 'custom' }))
      .rejects.toThrow(/foreign key/);
    await expect(ins(a, 'fit_workouts', { workout_on: '2026-03-11', activity: 'x', title: 'x', met: 4, duration_min: 10, template_id: tplB }))
      .rejects.toThrow(/foreign key/);
  });

  it('deleting the parent keeps the child and clears only the reference', async () => {
    const m = await ins(a, 'fit_meal_entries', { eaten_on: '2026-03-11', meal: 'snack', name: 'x', custom_food_id: foodA, source: 'custom' });
    const w = await ins(a, 'fit_workouts', { workout_on: '2026-03-11', activity: 'x', title: 'x', met: 4, duration_min: 10, template_id: tplA });
    await q(db, a, 'delete from public.fit_custom_foods where id = $1', [foodA]);
    await q(db, a, 'delete from public.fit_workout_templates where id = $1', [tplA]);
    const [mm] = await q(db, a, 'select custom_food_id, user_id from public.fit_meal_entries where id = $1', [m.id]);
    const [ww] = await q(db, a, 'select template_id, user_id from public.fit_workouts where id = $1', [w.id]);
    expect(mm).toEqual({ custom_food_id: null, user_id: a });
    expect(ww).toEqual({ template_id: null, user_id: a });
  });

  it('deleting the auth user cascades to every fit_* row', async () => {
    const c = await createUser(db);
    for (const [t, row] of Object.entries(sample(c))) await ins(c, t, row);
    await asUser(db, c, (tx) => tx.query('select public.fit_ai_quota_consume()'));
    await db.query('delete from auth.users where id = $1', [c]);
    for (const t of TABLES) {
      const { rows } = await db.query(`select count(*)::int n from public.${t} where user_id = $1`, [c]);
      expect(rows[0].n, t).toBe(0);
    }
  });
});

describe('001400 check constraints', () => {
  const bad = [
    ['fit_profiles', { sex: 'other' }],
    ['fit_profiles', { height_cm: 79 }],
    ['fit_profiles', { calorie_target: 700 }],
    ['fit_profiles', { protein_g: 1001 }],
    ['fit_profiles', { goal: 'bulk' }],
    ['fit_profiles', { goal_pace: 'turbo' }],
    ['fit_profiles', { onboarded_at: '2026-03-10T00:00:00Z' }], // incomplete profile cannot be onboarded
    ['fit_custom_foods', { name: '   ', serving_grams: 100 }],
    ['fit_custom_foods', { name: 'x', serving_grams: 0 }],
    ['fit_custom_foods', { name: 'x', serving_grams: 10, kcal_100g: -1 }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'brunch', name: 'x' }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', quantity: 0 }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', unit: '' }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', kcal: -5 }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', source: 'magic' }],
    ['fit_meal_entries', { eaten_on: 'infinity', meal: 'lunch', name: 'x' }],
    ['fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x'.repeat(121) }],
    ['fit_workout_templates', { name: 'x', activity: 'x', met: 26, duration_min: 10 }],
    ['fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 0.5, duration_min: 10 }],
    ['fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 5, duration_min: 1441 }],
    ['fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 5, duration_min: 10, status: 'skipped' }],
    ['fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 5, duration_min: 10, category: 'chess' }],
    ['fit_daily_logs', { log_date: '2026-03-20', water_ml: -1 }],
    ['fit_daily_logs', { log_date: '2026-03-20', steps: -1 }],
    ['fit_body_measurements', { measured_on: '2026-03-20' }], // needs at least one value
    ['fit_progress_photos', { taken_on: '2026-03-10', storage_path: 'x.webp', pose: 'front' }],
    ['fit_progress_photos', { taken_on: '2026-03-10', storage_path: 'PLACEHOLDER', pose: 'upside' }],
  ];

  it('rejects invalid values', async () => {
    const c = await createUser(db);
    for (const [table, row] of bad) {
      const r = { ...row };
      if (r.storage_path === 'PLACEHOLDER') r.storage_path = `${c}/progress/x.webp`;
      await expect(ins(c, table, r), `${table} ${JSON.stringify(row)}`).rejects.toThrow(/violates check constraint|invalid input/);
    }
  });

  it("meal photo_path / progress storage_path must be in the owner's folder", async () => {
    const c = await createUser(db);
    await expect(ins(c, 'fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', photo_path: `${a}/meals/y.webp` }))
      .rejects.toThrow(/check constraint/);
    await expect(ins(c, 'fit_progress_photos', { taken_on: '2026-03-10', storage_path: `${a}/progress/y.webp` }))
      .rejects.toThrow(/check constraint/);
    const ok = await ins(c, 'fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'x', photo_path: `${c}/meals/y.webp`, ai_meta: { model: 'm' } });
    expect(ok.photo_path).toBe(`${c}/meals/y.webp`);
  });

  it('one measurement per user per day; defaults applied', async () => {
    const c = await createUser(db);
    await ins(c, 'fit_body_measurements', { measured_on: '2026-03-10', waist_cm: 70 });
    await expect(ins(c, 'fit_body_measurements', { measured_on: '2026-03-10', weight_kg: 60 })).rejects.toThrow(/unique/);
    const p = await ins(c, 'fit_profiles', {});
    expect(p).toMatchObject({ macro_custom: false, water_target_ml: 2000, step_target: 8000, onboarded_at: null });
    const w = await ins(c, 'fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 5, duration_min: 10 });
    expect(w.status).toBe('done');
    const f = await ins(c, 'fit_custom_foods', { name: 'x', serving_grams: 50 });
    expect(f.serving_label).toBe('1 phần');
    const ph = await ins(c, 'fit_progress_photos', { taken_on: '2026-03-10', storage_path: `${c}/progress/z.webp` });
    expect(ph.pose).toBe('front');
  });

  it('a complete profile can be onboarded; updated_at moves on update', async () => {
    const c = await createUser(db);
    const p = await ins(c, 'fit_profiles', { ...sample(c).fit_profiles, onboarded_at: '2026-03-10T00:00:00Z' });
    expect(p.onboarded_at).not.toBeNull();
    await db.query("update public.fit_profiles set updated_at = now() - interval '1 day' where user_id = $1", [c]);
    const [u] = await q(db, c, 'update public.fit_profiles set goal = $1 returning updated_at', ['gain']);
    expect(Date.now() - new Date(u.updated_at).getTime()).toBeLessThan(3600_000);
    await expect(q(db, c, 'update public.fit_profiles set sex = null')).rejects.toThrow(/fit_profiles_complete/);
  });
});

describe('001400 RPCs', () => {
  let u, v;
  beforeAll(async () => {
    u = await createUser(db);
    v = await createUser(db);
    const meal = (d, kcal, p, c, f, fi) =>
      ins(u, 'fit_meal_entries', { eaten_on: d, meal: 'lunch', name: 'm', kcal, protein_g: p, carbs_g: c, fat_g: f, fiber_g: fi });
    await meal('2026-03-10', 450, 25, 55, 12, 2);
    await meal('2026-03-10', 300.5, 10, 40, 8, 3);
    await meal('2026-03-12', 200, 5, 30, 4, 1);
    const wk = (d, kcal, status) => ins(u, 'fit_workouts', { workout_on: d, activity: 'x', title: 'x', met: 5, duration_min: 30, kcal, status });
    await wk('2026-03-10', 250, 'done');
    await wk('2026-03-10', 999, 'planned');
    await wk('2026-03-11', 120, 'done');
    await ins(u, 'fit_daily_logs', { log_date: '2026-03-10', water_ml: 1500, steps: 7000 });
    await ins(u, 'fit_body_measurements', { measured_on: '2026-03-11', weight_kg: 70.4 });
    await ins(u, 'fit_body_measurements', { measured_on: '2026-03-12', waist_cm: 80 });
    // noise from another user on the same days
    await ins(v, 'fit_meal_entries', { eaten_on: '2026-03-10', meal: 'lunch', name: 'v', kcal: 5000 });
    await ins(v, 'fit_workouts', { workout_on: '2026-03-10', activity: 'x', title: 'x', met: 5, duration_min: 30, kcal: 5000 });
    await ins(v, 'fit_daily_logs', { log_date: '2026-03-10', water_ml: 9999, steps: 99999 });
    await ins(v, 'fit_body_measurements', { measured_on: '2026-03-10', weight_kg: 99 });
  });

  it('fit_day_summary sums own meals, done workouts and the daily log', async () => {
    const [{ s }] = await q(db, u, "select public.fit_day_summary('2026-03-10') s");
    expect(s).toEqual({ kcal_in: 750.5, protein_g: 35, carbs_g: 95, fat_g: 20, fiber_g: 5, workout_kcal: 250, water_ml: 1500, steps: 7000 });
    const [{ s: empty }] = await q(db, u, "select public.fit_day_summary('2026-01-01') s");
    expect(empty).toEqual({ kcal_in: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, workout_kcal: 0, water_ml: 0, steps: 0 });
  });

  it('fit_range_summary returns one row per day with done-only workouts and same-day weight', async () => {
    const rows = await q(db, u, "select * from public.fit_range_summary('2026-03-09', '2026-03-13')");
    expect(rows).toHaveLength(5);
    const norm = rows.map((r) => ({
      kcal_in: num(r.kcal_in), protein_g: num(r.protein_g), workout_kcal: num(r.workout_kcal),
      water_ml: r.water_ml, steps: r.steps, weight_kg: num(r.weight_kg),
    }));
    expect(norm).toEqual([
      { kcal_in: 0, protein_g: 0, workout_kcal: 0, water_ml: 0, steps: 0, weight_kg: null },
      { kcal_in: 750.5, protein_g: 35, workout_kcal: 250, water_ml: 1500, steps: 7000, weight_kg: null },
      { kcal_in: 0, protein_g: 0, workout_kcal: 120, water_ml: 0, steps: 0, weight_kg: 70.4 },
      { kcal_in: 200, protein_g: 5, workout_kcal: 0, water_ml: 0, steps: 0, weight_kg: null },
      { kcal_in: 0, protein_g: 0, workout_kcal: 0, water_ml: 0, steps: 0, weight_kg: null },
    ]);
    const days = await q(db, u, "select day::text d from public.fit_range_summary('2026-03-09', '2026-03-13')");
    expect(days.map((r) => r.d)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13']);
    const one = await q(db, u, "select count(*)::int n from public.fit_range_summary('2026-03-10', '2026-03-10')");
    expect(one[0].n).toBe(1);
  });

  it('fit_range_summary validates the range (max 366 days)', async () => {
    const ok = await q(db, u, "select count(*)::int n from public.fit_range_summary('2024-01-01', '2024-12-31')");
    expect(ok[0].n).toBe(366);
    for (const [f, t] of [['2024-01-01', '2025-01-01'], ['2026-03-10', '2026-03-09'], [null, '2026-03-09']]) {
      await expect(q(db, u, 'select * from public.fit_range_summary($1, $2)', [f, t])).rejects.toThrow(/p_from|366|requires/);
    }
  });

  it('RPCs reject a session without a user', async () => {
    await expect(asUser(db, '', (tx) => tx.query("select public.fit_day_summary('2026-03-10')"))).rejects.toThrow(/not_authenticated/);
    await expect(asUser(db, '', (tx) => tx.query('select public.fit_ai_quota_consume()'))).rejects.toThrow(/not_authenticated/);
  });

  it('fit_ai_quota_consume counts per user per day and stops at the limit', async () => {
    const w = await createUser(db);
    const take = (uid, lim) => q(db, uid, 'select public.fit_ai_quota_consume($1) ok', [lim]).then((r) => r[0].ok);
    expect(await take(w, 3)).toBe(true);
    expect(await take(w, 3)).toBe(true);
    expect(await take(w, 3)).toBe(true);
    expect(await take(w, 3)).toBe(false);
    expect(await take(w, 3)).toBe(false);
    const [{ count }] = await q(db, w, 'select count from public.fit_ai_usage');
    expect(count).toBe(3); // refused calls are not counted
    expect(await take(w, 5)).toBe(true); // higher limit continues from the same counter
    // another user has an independent counter
    const x = await createUser(db);
    expect(await take(x, 1)).toBe(true);
    expect(await take(x, 1)).toBe(false);
    // default limit is 40
    const y = await createUser(db);
    for (let i = 0; i < 40; i++) expect(await q(db, y, 'select public.fit_ai_quota_consume() ok').then((r) => r[0].ok)).toBe(true);
    expect(await q(db, y, 'select public.fit_ai_quota_consume() ok').then((r) => r[0].ok)).toBe(false);
  });

  it('function attributes and EXECUTE privileges', async () => {
    const { rows } = await db.query(`
      select p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'fit\\_%'`);
    expect(rows.map((r) => r.proname).sort()).toEqual(['fit_ai_quota_consume', 'fit_day_summary', 'fit_range_summary']);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(r.proname === 'fit_ai_quota_consume');
      expect(r.proconfig, r.proname).toContain('search_path=""');
      expect(r.anon_x, r.proname).toBe(false);
      expect(r.public_x, r.proname).toBe(false);
      expect(r.auth_x, r.proname).toBe(true);
    }
  });
});

describe('001500 fitora storage', () => {
  const put = (tx, bucket, name) =>
    tx.query('insert into storage.objects (bucket_id, name) values ($1, $2) returning name', [bucket, name]);

  it('creates a private 5 MB bucket for raster images', async () => {
    const { rows } = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'fitora'");
    expect(rows[0]).toEqual({ public: false, file_size_limit: 5242880, allowed_mime_types: ['image/webp', 'image/jpeg', 'image/png'] });
    const { rows: pol } = await db.query("select count(*)::int n from pg_policies where schemaname = 'storage' and policyname like 'fitora\\_%'");
    expect(pol[0].n).toBe(4);
  });

  it('owner can write, read, move and delete inside their own folder', async () => {
    await asUser(db, a, async (tx) => {
      await put(tx, 'fitora', `${a}/meals/m1.webp`);
      await put(tx, 'fitora', `${a}/progress/p1.webp`);
      const own = await tx.query("select name from storage.objects where bucket_id = 'fitora' order by name");
      expect(own.rows.map((r) => r.name)).toEqual([`${a}/meals/m1.webp`, `${a}/progress/p1.webp`]);
      expect((await tx.query('update storage.objects set name = $1 where name = $2', [`${a}/meals/m2.webp`, `${a}/meals/m1.webp`])).affectedRows).toBe(1);
      expect((await tx.query('delete from storage.objects where name = $1', [`${a}/meals/m2.webp`])).affectedRows).toBe(1);
    });
  });

  it("rejects writes into another user's folder or the bucket root, and moving out of the own folder", async () => {
    for (const name of [`${b}/meals/x.webp`, 'x.webp']) {
      await expect(asUser(db, a, (tx) => put(tx, 'fitora', name))).rejects.toThrow(/row-level security/);
    }
    await expect(asUser(db, a, (tx) => tx.query('update storage.objects set name = $1 where name = $2', [`${b}/progress/p1.webp`, `${a}/progress/p1.webp`])))
      .rejects.toThrow(/row-level security/);
  });

  it("cannot see, move or delete another user's images; anon has nothing", async () => {
    await asUser(db, b, (tx) => put(tx, 'fitora', `${b}/progress/secret.webp`));
    await asUser(db, a, async (tx) => {
      expect((await tx.query("select 1 from storage.objects where bucket_id = 'fitora' and name like $1", [`${b}/%`])).rows).toHaveLength(0);
      expect((await tx.query('update storage.objects set name = $1 where name = $2', [`${a}/stolen.webp`, `${b}/progress/secret.webp`])).affectedRows).toBe(0);
      expect((await tx.query('delete from storage.objects where name = $1', [`${b}/progress/secret.webp`])).affectedRows).toBe(0);
    });
    await expect(asAnon(db, (tx) => put(tx, 'fitora', `${a}/meals/anon.webp`))).rejects.toThrow(/row-level security/);
    const seen = await asAnon(db, (tx) => tx.query("select 1 from storage.objects where bucket_id = 'fitora'"));
    expect(seen.rows).toHaveLength(0);
  });
});
