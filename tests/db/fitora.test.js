// 001400 / 001500: Fitora tables, RLS, RPCs and the private `fitora` storage bucket.
// 20261012000100: saved foods (source / photo / usage) and meal templates ("Bữa mẫu").
// 20261012000300: default_servings, name_key uniqueness, UTC day for the AI quota.
// 20261012000400: capped AI quota refund, undo of a meal-template usage bump.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, createUser, asUser, asAnon, q } from './harness.js';

let db, a, b;
const num = (v) => (v === null || v === undefined ? v : Number(v));

const TABLES = [
  'fit_profiles', 'fit_custom_foods', 'fit_meal_entries', 'fit_workout_templates', 'fit_workouts',
  'fit_daily_logs', 'fit_body_measurements', 'fit_progress_photos', 'fit_ai_usage', 'fit_meal_templates',
];
const TPL_ITEM = { name: 'Phở bò', quantity: 1, unit: 'bát', grams: 500, kcal: 450, protein_g: 25, carbs_g: 55, fat_g: 12, fiber_g: 2, custom_food_id: null };

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
  fit_meal_templates: { name: 'Sáng quen thuộc', meal: 'breakfast', items: JSON.stringify([TPL_ITEM]), total_kcal: 450 },
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
    for (const call of [
      "public.fit_day_summary('2026-03-10')", "public.fit_range_summary('2026-03-01', '2026-03-02')", 'public.fit_ai_quota_consume()',
      'public.fit_mark_food_used(array[gen_random_uuid()])', 'public.fit_mark_meal_template_used(gen_random_uuid())',
      'public.fit_unmark_food_used(gen_random_uuid(), null, null)', 'public.fit_ai_quota_refund()',
      'public.fit_unmark_meal_template_used(gen_random_uuid(), null)',
    ]) {
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
    for (const f of ['20261009001400_fitora_schema.sql', '20261012000100_fitora_saved_foods.sql', '20261012000200_fitora_unmark_food_used.sql', '20261012000300_fitora_saved_foods_hardening.sql', '20261012000400_fitora_refund_and_template_undo.sql']) {
      const sql = readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8');
      const code = sql.replace(/--.*$/gm, '');
      expect(code, f).not.toMatch(/\b(alter|drop)\s+(table|function|view|type|schema)\b(?![^;]*\bfit_)/i);
      expect(code, f).not.toMatch(/\btruncate\b/i);
      expect(code, f).not.toMatch(/\bdrop\s+column\b/i);
    }
    // 000100 only ALTERs fit_* tables.
    const add = readFileSync(new URL('../../supabase/migrations/20261012000100_fitora_saved_foods.sql', import.meta.url), 'utf8')
      .replace(/--.*$/gm, '');
    const altered = [...add.matchAll(/\balter\s+table\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(altered.length).toBeGreaterThan(0);
    for (const t of altered) expect(t).toMatch(/^public\.fit_/);
  });

  it('is idempotent', async () => {
    for (const f of ['20261009001400_fitora_schema.sql', '20261009001500_fitora_storage.sql', '20261012000100_fitora_saved_foods.sql', '20261012000200_fitora_unmark_food_used.sql', '20261012000300_fitora_saved_foods_hardening.sql', '20261012000400_fitora_refund_and_template_undo.sql']) {
      await db.exec(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8'));
    }
    const { rows } = await db.query("select count(*)::int n from pg_policies where schemaname = 'public' and tablename like 'fit\\_%'");
    expect(rows[0].n).toBe(9 * 4 + 1);
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
    expect(rows.map((r) => r.proname).sort()).toEqual([
      'fit_ai_quota_consume', 'fit_day_summary', 'fit_mark_food_used', 'fit_mark_meal_template_used', 'fit_range_summary',
      'fit_unmark_food_used', 'fit_ai_quota_refund', 'fit_unmark_meal_template_used',
    ].sort());
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(['fit_ai_quota_consume', 'fit_ai_quota_refund'].includes(r.proname));
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

describe('20261012000100 saved foods & meal templates', () => {
  let u, v;
  beforeAll(async () => {
    u = await createUser(db);
    v = await createUser(db);
  });

  it('fit_custom_foods gets source / photo / usage / default meal with safe defaults', async () => {
    const f = await ins(u, 'fit_custom_foods', { name: 'Bún chả', serving_grams: 350, kcal_100g: 160 });
    expect(f).toMatchObject({ source: 'manual', photo_path: null, use_count: 0, last_used_at: null, default_meal: null });
    const ai = await ins(u, 'fit_custom_foods', {
      name: 'Cơm tấm', serving_grams: 450, kcal_100g: 170, source: 'ai', photo_path: `${u}/meals/s.webp`, default_meal: 'lunch',
    });
    expect(ai).toMatchObject({ source: 'ai', photo_path: `${u}/meals/s.webp`, default_meal: 'lunch' });
  });

  it('rejects invalid saved-food values and foreign photo folders', async () => {
    for (const row of [
      { name: 'x', serving_grams: 10, source: 'scan' },
      { name: 'x', serving_grams: 10, use_count: -1 },
      { name: 'x', serving_grams: 10, default_meal: 'brunch' },
      { name: 'x', serving_grams: 10, photo_path: `${v}/meals/x.webp` },
      { name: 'x', serving_grams: 10, photo_path: 'x.webp' },
    ]) {
      await expect(ins(u, 'fit_custom_foods', row), JSON.stringify(row)).rejects.toThrow(/check constraint/);
    }
  });

  it('fit_meal_templates validates name, meal and items', async () => {
    const ok = await ins(u, 'fit_meal_templates', { name: 'Trưa văn phòng', items: JSON.stringify([TPL_ITEM, TPL_ITEM]) });
    expect(ok).toMatchObject({ meal: null, use_count: 0, last_used_at: null });
    expect(Number(ok.total_kcal)).toBe(0);
    const big = Array.from({ length: 31 }, () => TPL_ITEM);
    for (const row of [
      { name: ' ', items: JSON.stringify([TPL_ITEM]) },
      { name: 'x'.repeat(81), items: JSON.stringify([TPL_ITEM]) },
      { name: 'x', meal: 'brunch', items: JSON.stringify([TPL_ITEM]) },
      { name: 'x', items: '[]' },
      { name: 'x', items: JSON.stringify(TPL_ITEM) },
      { name: 'x', items: JSON.stringify(big) },
      { name: 'x', items: JSON.stringify([{ ...TPL_ITEM, name: 'y'.repeat(40000) }]) },
      { name: 'x', items: JSON.stringify([TPL_ITEM]), total_kcal: -1 },
      { name: 'x', items: JSON.stringify([TPL_ITEM]), use_count: -1 },
    ]) {
      await expect(ins(u, 'fit_meal_templates', row), JSON.stringify(row).slice(0, 80)).rejects.toThrow(/check constraint|not-null/);
    }
    await expect(ins(u, 'fit_meal_templates', { name: 'x' })).rejects.toThrow(/not-null/);
  });

  it('fit_mark_food_used bumps only own rows atomically and returns them', async () => {
    const f1 = await ins(u, 'fit_custom_foods', { name: 'Phở', serving_grams: 500 });
    const f2 = await ins(u, 'fit_custom_foods', { name: 'Bánh mì', serving_grams: 150 });
    const fv = await ins(v, 'fit_custom_foods', { name: 'V food', serving_grams: 100 });
    const rows = await q(db, u, 'select id, use_count, last_used_at from public.fit_mark_food_used($1)', [[f1.id, f2.id, fv.id]]);
    expect(rows.map((r) => r.id).sort()).toEqual([f1.id, f2.id].sort());
    for (const r of rows) {
      expect(r.use_count).toBe(1);
      expect(r.last_used_at).not.toBeNull();
    }
    await q(db, u, 'select public.fit_mark_food_used($1)', [[f1.id]]);
    const [again] = await q(db, u, 'select use_count from public.fit_custom_foods where id = $1', [f1.id]);
    expect(again.use_count).toBe(2);
    const [other] = await db.query('select use_count from public.fit_custom_foods where id = $1', [fv.id]).then((r) => r.rows);
    expect(other.use_count).toBe(0);
    // a meal remembers where the food was last logged; null keeps the previous one
    const [m1] = await q(db, u, "select default_meal from public.fit_mark_food_used($1, 'dinner')", [[f2.id]]);
    expect(m1.default_meal).toBe('dinner');
    const [m2] = await q(db, u, 'select default_meal, use_count from public.fit_mark_food_used($1)', [[f2.id]]);
    expect(m2).toEqual({ default_meal: 'dinner', use_count: 3 });
    await expect(q(db, u, "select public.fit_mark_food_used($1, 'brunch')", [[f2.id]])).rejects.toThrow(/invalid meal/);
    expect(await q(db, u, "select * from public.fit_mark_food_used('{}'::uuid[])")).toHaveLength(0);
    expect(await q(db, u, 'select * from public.fit_mark_food_used(null)')).toHaveLength(0);
    const many = Array.from({ length: 101 }, () => f1.id);
    await expect(q(db, u, 'select public.fit_mark_food_used($1)', [many])).rejects.toThrow(/too many/);
    await expect(asUser(db, '', (tx) => tx.query('select public.fit_mark_food_used($1)', [[f1.id]]))).rejects.toThrow(/not_authenticated/);
  });

  it('fit_unmark_food_used reverses one bump (undo) for own rows only, never moving last_used_at forward', async () => {
    const prev = '2026-03-01T08:00:00Z';
    const f = await ins(u, 'fit_custom_foods', { name: 'Bún bò', serving_grams: 500, use_count: 3, last_used_at: prev, default_meal: 'breakfast' });
    const [bumped] = await q(db, u, "select use_count, last_used_at, default_meal from public.fit_mark_food_used($1, 'dinner')", [[f.id]]);
    expect(bumped.use_count).toBe(4);
    expect(bumped.default_meal).toBe('dinner');
    const [undone] = await q(db, u, 'select use_count, last_used_at, default_meal from public.fit_unmark_food_used($1, $2, $3)', [f.id, prev, 'breakfast']);
    expect(undone.use_count).toBe(3);
    expect(new Date(undone.last_used_at).toISOString()).toBe(new Date(prev).toISOString());
    expect(undone.default_meal).toBe('breakfast');
    // a "previous" timestamp later than the current one is ignored (cannot inflate recency)
    const [fwd] = await q(db, u, 'select last_used_at from public.fit_unmark_food_used($1, $2, null)', [f.id, '2099-01-01T00:00:00Z']);
    expect(new Date(fwd.last_used_at).toISOString()).toBe(new Date(prev).toISOString());
    // a food whose first use is undone goes back to "never used"
    const g = await ins(u, 'fit_custom_foods', { name: 'Chè', serving_grams: 200 });
    await q(db, u, "select public.fit_mark_food_used($1, 'snack')", [[g.id]]);
    const [g0] = await q(db, u, 'select use_count, last_used_at, default_meal from public.fit_unmark_food_used($1, null, null)', [g.id]);
    expect(g0).toEqual({ use_count: 0, last_used_at: null, default_meal: null });
    // never below 0, other users untouched, input validated, anon/unauth denied
    expect(await q(db, u, 'select * from public.fit_unmark_food_used($1, null, null)', [g.id])).toHaveLength(0);
    const fv = await ins(v, 'fit_custom_foods', { name: 'V', serving_grams: 100, use_count: 2, last_used_at: prev });
    expect(await q(db, u, 'select * from public.fit_unmark_food_used($1, null, null)', [fv.id])).toHaveLength(0);
    const [o] = (await db.query('select use_count from public.fit_custom_foods where id = $1', [fv.id])).rows;
    expect(o.use_count).toBe(2);
    await expect(q(db, u, "select public.fit_unmark_food_used($1, null, 'brunch')", [f.id])).rejects.toThrow(/invalid meal/);
    await expect(asUser(db, '', (tx) => tx.query('select public.fit_unmark_food_used($1, null, null)', [f.id]))).rejects.toThrow(/not_authenticated/);
  });

  it('fit_mark_meal_template_used bumps only the own template', async () => {
    const t = await ins(u, 'fit_meal_templates', sample(u).fit_meal_templates);
    const tv = await ins(v, 'fit_meal_templates', sample(v).fit_meal_templates);
    const [r] = await q(db, u, 'select use_count, last_used_at from public.fit_mark_meal_template_used($1)', [t.id]);
    expect(r.use_count).toBe(1);
    expect(r.last_used_at).not.toBeNull();
    expect(await q(db, u, 'select * from public.fit_mark_meal_template_used($1)', [tv.id])).toHaveLength(0);
    const [o] = (await db.query('select use_count from public.fit_meal_templates where id = $1', [tv.id])).rows;
    expect(o.use_count).toBe(0);
  });

  it('a meal entry may share the saved food photo; deleting the food keeps the entry', async () => {
    const photo = `${u}/meals/shared.webp`;
    const f = await ins(u, 'fit_custom_foods', { name: 'Gỏi cuốn', serving_grams: 200, source: 'ai', photo_path: photo });
    const m = await ins(u, 'fit_meal_entries', {
      eaten_on: '2026-03-12', meal: 'snack', name: 'Gỏi cuốn', custom_food_id: f.id, source: 'custom', photo_path: photo,
    });
    await q(db, u, 'delete from public.fit_custom_foods where id = $1', [f.id]);
    const [mm] = await q(db, u, 'select custom_food_id, photo_path from public.fit_meal_entries where id = $1', [m.id]);
    expect(mm).toEqual({ custom_food_id: null, photo_path: photo });
  });

  it('recent-first index exists and existing rows were back-filled with defaults', async () => {
    const { rows } = await db.query(
      "select indexname from pg_indexes where schemaname = 'public' and indexname in ('fit_custom_foods_user_recent_idx', 'fit_meal_templates_user_recent_idx') order by 1");
    expect(rows.map((r) => r.indexname)).toEqual(['fit_custom_foods_user_recent_idx', 'fit_meal_templates_user_recent_idx']);
    const { rows: n } = await db.query("select count(*)::int n from public.fit_custom_foods where source is null or use_count is null");
    expect(n[0].n).toBe(0);
  });
});

describe('20261012000300 saved-foods hardening & AI quota day', () => {
  let u, v;
  beforeAll(async () => {
    u = await createUser(db);
    v = await createUser(db);
  });

  it('default_servings is optional and bounded', async () => {
    const f = await ins(u, 'fit_custom_foods', { name: 'Bánh bao', serving_label: '1 cái', serving_grams: 150 });
    expect(f.default_servings).toBeNull();
    const g = await ins(u, 'fit_custom_foods', { name: 'Bánh bao 2', serving_label: '1 cái', serving_grams: 150, default_servings: 2.5 });
    expect(Number(g.default_servings)).toBe(2.5);
    for (const bad of [0, -1, 1000.01]) {
      await expect(ins(u, 'fit_custom_foods', { name: 'x', serving_grams: 10, default_servings: bad }), String(bad)).rejects.toThrow(/check constraint/);
    }
  });

  it('name_key is unique per user; NULL keys (older / hand-made foods) never collide', async () => {
    await ins(u, 'fit_custom_foods', { name: 'Cơm tấm', serving_grams: 400, name_key: 'com tam' });
    await expect(ins(u, 'fit_custom_foods', { name: 'COM TAM', serving_grams: 300, name_key: 'com tam' })).rejects.toThrow(/duplicate key|unique/);
    // another user may have the same dish
    await expect(ins(v, 'fit_custom_foods', { name: 'Cơm tấm', serving_grams: 400, name_key: 'com tam' })).resolves.toMatchObject({ name_key: 'com tam' });
    // no key = no constraint (hand-made foods with the same name stay allowed)
    await ins(u, 'fit_custom_foods', { name: 'Bún', serving_grams: 300 });
    await ins(u, 'fit_custom_foods', { name: 'Bún', serving_grams: 350 });
    for (const bad of ['', 'x'.repeat(121)]) {
      await expect(ins(u, 'fit_custom_foods', { name: 'y', serving_grams: 10, name_key: bad })).rejects.toThrow(/check constraint/);
    }
  });

  it('fit_ai_quota_consume counts the UTC day, not the (user-editable) profile time zone', async () => {
    const w = await createUser(db);
    const take = () => q(db, w, 'select public.fit_ai_quota_consume(3) ok').then((r) => r[0].ok);
    const tz = (zone) => db.query('update public.profiles set timezone = $1 where id = $2', [zone, w]);
    expect(await take()).toBe(true);
    await tz('Etc/GMT+12');
    expect(await take()).toBe(true);
    await tz('Pacific/Kiritimati');
    expect(await take()).toBe(true);
    await tz('Asia/Ho_Chi_Minh');
    expect(await take()).toBe(false); // 3 per UTC day, however often the zone is flipped
    const rows = await q(db, w, 'select used_on::text d, count from public.fit_ai_usage');
    expect(rows).toEqual([{ d: new Date().toISOString().slice(0, 10), count: 3 }]);
  });
});

describe('20261012000400 AI quota refund & meal-template undo', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const consume = (uid, limit = 40) => q(db, uid, 'select public.fit_ai_quota_consume($1) ok', [limit]).then((r) => r[0].ok);
  const refund = (uid) => q(db, uid, 'select public.fit_ai_quota_refund() ok').then((r) => r[0].ok);
  const usage = (uid) => q(db, uid, 'select used_on::text d, count, refunded from public.fit_ai_usage');

  it('a refund after a scan gives that scan back', async () => {
    const u = await createUser(db);
    expect(await consume(u)).toBe(true);
    expect(await consume(u)).toBe(true);
    expect(await refund(u)).toBe(true);
    expect(await usage(u)).toEqual([{ d: today(), count: 1, refunded: 1 }]);
  });

  it('nothing to refund without a scan today (no row, or count already 0)', async () => {
    const u = await createUser(db);
    expect(await refund(u)).toBe(false);
    expect(await usage(u)).toEqual([]);
    expect(await consume(u)).toBe(true);
    expect(await refund(u)).toBe(true);
    expect(await refund(u)).toBe(false); // count is 0: never negative
    expect(await usage(u)).toEqual([{ d: today(), count: 0, refunded: 1 }]);
  });

  it('refunds are capped at 10 per day, so calling the RPC directly cannot buy unlimited scans', async () => {
    const u = await createUser(db);
    for (let i = 0; i < 10; i++) {
      expect(await consume(u, 1), `consume ${i}`).toBe(true);
      expect(await refund(u), `refund ${i}`).toBe(true);
    }
    expect(await consume(u, 1)).toBe(true);
    expect(await refund(u)).toBe(false); // 11th refund
    expect(await consume(u, 1)).toBe(false); // the daily limit holds again
    expect(await usage(u)).toEqual([{ d: today(), count: 1, refunded: 10 }]);
  });

  it('only the caller is refunded; anon is denied; the column stays read-only for clients', async () => {
    const u = await createUser(db);
    const w = await createUser(db);
    expect(await consume(u)).toBe(true);
    expect(await refund(w)).toBe(false);
    expect(await usage(u)).toEqual([{ d: today(), count: 1, refunded: 0 }]);
    await expect(asAnon(db, (tx) => tx.query('select public.fit_ai_quota_refund()'))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, u, (tx) => tx.query('update public.fit_ai_usage set refunded = 0'))).rejects.toThrow(/permission denied/);
  });

  it('fit_unmark_meal_template_used reverses one bump, never below 0, own rows only', async () => {
    const u = await createUser(db);
    const w = await createUser(db);
    const t = await ins(u, 'fit_meal_templates', sample(u).fit_meal_templates);
    const mark = () => q(db, u, 'select public.fit_mark_meal_template_used($1)', [t.id]);
    const unmark = (uid, prev) => q(db, uid, 'select use_count, last_used_at from public.fit_unmark_meal_template_used($1, $2)', [t.id, prev]);
    const state = async () => (await q(db, u, 'select use_count, last_used_at from public.fit_meal_templates where id = $1', [t.id]))[0];

    await mark();
    const first = await state();
    await mark();
    expect((await state()).use_count).toBe(2);
    // B cannot touch A's template
    expect(await unmark(w, first.last_used_at)).toEqual([]);
    expect((await state()).use_count).toBe(2);
    // undo of the 2nd log: back to the snapshot
    expect(await unmark(u, first.last_used_at)).toEqual([{ use_count: 1, last_used_at: first.last_used_at }]);
    // a snapshot LATER than the current value is ignored (never moved forward)
    await mark();
    const cur = await state();
    await unmark(u, new Date(Date.parse(cur.last_used_at) + 3600e3).toISOString());
    expect(await state()).toEqual({ use_count: 1, last_used_at: cur.last_used_at });
    // last undo: count 0 and last_used_at cleared; one more is a no-op
    expect(await unmark(u, first.last_used_at)).toEqual([{ use_count: 0, last_used_at: null }]);
    expect(await unmark(u, null)).toEqual([]);
    expect(await state()).toEqual({ use_count: 0, last_used_at: null });
  });
});
