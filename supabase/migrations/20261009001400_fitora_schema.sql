-- =====================================================================
-- Fitora (AI Nutrition & Fitness Coach) — tables, RLS, RPCs.
--
-- Fitora is a SEPARATE frontend (its own repo / GitHub Pages site) that shares
-- this Supabase project, so it shares auth.users and reads public.profiles
-- (display_name, avatar_url). Its migrations live here because `supabase db push`
-- needs the whole migration history of the project in one directory.
-- Contract: Fitora/docs/PLAN.md §2.
--
-- PURELY ADDITIVE: every object is new and prefixed `fit_`. Nothing owned by
-- Note_mytasks (or the other app sharing the database) is altered or dropped.
-- Existing helpers reused read-only: public.set_updated_at(), public.user_today().
--
-- Conventions (same as 000100 / 000700):
--   * user_id uuid not null default auth.uid() references auth.users on delete cascade.
--   * Enums are text + CHECK. Calendar days are `date`, bounded 1900..2999 (001000).
--   * Cross-table references are COMPOSITE FKs (child_id, user_id) -> parent(id, user_id)
--     so a user cannot point a row at someone else's food / template (FK checks
--     bypass RLS). Deleting the parent keeps the child and clears only the id
--     (PG15 `on delete set null (col)`).
--   * RLS on every table; policies for `authenticated` only, UPDATE has USING +
--     WITH CHECK; anon has no privileges. fit_ai_usage is read-only to clients and
--     written only by the SECURITY DEFINER RPC fit_ai_quota_consume().
--   * Functions pin `set search_path = ''`. EXECUTE revoked from public/anon.
--   * Idempotent: if not exists / drop ... if exists / create or replace.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. fit_profiles (1:1 with auth.users)
--    Columns are nullable so onboarding may save step by step; once
--    onboarded_at is set the profile must be complete (fit_profiles_complete).
-- ---------------------------------------------------------------------
create table if not exists public.fit_profiles (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  sex              text check (sex in ('male', 'female')),
  birth_date       date check (birth_date between date '1900-01-01' and date '2999-12-31'),
  height_cm        numeric(5,1) check (height_cm between 80 and 250),
  activity_level   text check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal             text check (goal in ('lose', 'gain', 'maintain', 'recomp')),
  goal_pace        text check (goal_pace in ('slow', 'medium', 'fast')),
  start_weight_kg  numeric(5,1) check (start_weight_kg between 20 and 400),
  target_weight_kg numeric(5,1) check (target_weight_kg between 20 and 400),
  calorie_target   integer check (calorie_target between 800 and 6000),
  protein_g        integer check (protein_g between 0 and 1000),
  carbs_g          integer check (carbs_g between 0 and 1000),
  fat_g            integer check (fat_g between 0 and 1000),
  macro_custom     boolean not null default false,
  water_target_ml  integer not null default 2000 check (water_target_ml between 0 and 20000),
  step_target      integer not null default 8000 check (step_target between 0 and 200000),
  onboarded_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fit_profiles_complete check (
    onboarded_at is null or (
      sex is not null and birth_date is not null and height_cm is not null
      and activity_level is not null and goal is not null and start_weight_kg is not null
      and calorie_target is not null and protein_g is not null and carbs_g is not null and fat_g is not null
    )
  )
);

drop trigger if exists trg_fit_profiles_updated_at on public.fit_profiles;
create trigger trg_fit_profiles_updated_at
  before update on public.fit_profiles
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 2. fit_custom_foods (nutrition per 100 g + a default serving)
-- ---------------------------------------------------------------------
create table if not exists public.fit_custom_foods (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  brand         text check (brand is null or char_length(brand) <= 120),
  serving_label text not null default '1 phần' check (char_length(btrim(serving_label)) between 1 and 40),
  serving_grams numeric(8,2) not null check (serving_grams > 0 and serving_grams <= 10000),
  kcal_100g     numeric(7,2) not null default 0 check (kcal_100g    between 0 and 1000),
  protein_100g  numeric(6,2) not null default 0 check (protein_100g between 0 and 100),
  carbs_100g    numeric(6,2) not null default 0 check (carbs_100g   between 0 and 100),
  fat_100g      numeric(6,2) not null default 0 check (fat_100g     between 0 and 100),
  fiber_100g    numeric(6,2) not null default 0 check (fiber_100g   between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, user_id)
);

create index if not exists fit_custom_foods_user_name_idx on public.fit_custom_foods (user_id, name);

drop trigger if exists trg_fit_custom_foods_updated_at on public.fit_custom_foods;
create trigger trg_fit_custom_foods_updated_at
  before update on public.fit_custom_foods
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 3. fit_meal_entries (one logged food; values are the TOTAL for the entry)
--    photo_path must live in the caller's own storage folder (<uid>/...).
-- ---------------------------------------------------------------------
create table if not exists public.fit_meal_entries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  eaten_on       date not null check (eaten_on between date '1900-01-01' and date '2999-12-31'),
  meal           text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  name           text not null check (char_length(btrim(name)) between 1 and 120),
  quantity       numeric(8,2) not null default 1 check (quantity > 0 and quantity <= 10000),
  unit           text not null default 'phần' check (char_length(btrim(unit)) between 1 and 20),
  grams          numeric(8,1) not null default 0 check (grams     between 0 and 100000),
  kcal           numeric(8,1) not null default 0 check (kcal      between 0 and 50000),
  protein_g      numeric(7,1) not null default 0 check (protein_g between 0 and 10000),
  carbs_g        numeric(7,1) not null default 0 check (carbs_g   between 0 and 10000),
  fat_g          numeric(7,1) not null default 0 check (fat_g     between 0 and 10000),
  fiber_g        numeric(7,1) not null default 0 check (fiber_g   between 0 and 10000),
  source         text not null default 'manual' check (source in ('ai', 'search', 'custom', 'manual')),
  custom_food_id uuid,
  photo_path     text,
  ai_meta        jsonb check (ai_meta is null or (jsonb_typeof(ai_meta) = 'object' and pg_column_size(ai_meta) <= 32768)),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint fit_meal_entries_photo_path_check check (
    photo_path is null or (char_length(photo_path) <= 300 and split_part(photo_path, '/', 1) = user_id::text)
  ),
  constraint fit_meal_entries_custom_food_fkey foreign key (custom_food_id, user_id)
    references public.fit_custom_foods (id, user_id) on delete set null (custom_food_id)
);

create index if not exists fit_meal_entries_user_day_idx on public.fit_meal_entries (user_id, eaten_on);
create index if not exists fit_meal_entries_user_food_idx
  on public.fit_meal_entries (user_id, custom_food_id) where custom_food_id is not null;

drop trigger if exists trg_fit_meal_entries_updated_at on public.fit_meal_entries;
create trigger trg_fit_meal_entries_updated_at
  before update on public.fit_meal_entries
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 4. fit_workout_templates
-- ---------------------------------------------------------------------
create table if not exists public.fit_workout_templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  category     text not null default 'other' check (category in
                 ('gym', 'cardio', 'yoga', 'running', 'swimming', 'cycling', 'team_sport', 'walking', 'other')),
  activity     text not null check (char_length(btrim(activity)) between 1 and 80),
  met          numeric(4,1) not null check (met between 1 and 25),
  duration_min integer not null check (duration_min between 1 and 1440),
  notes        text check (notes is null or char_length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id)
);

drop trigger if exists trg_fit_workout_templates_updated_at on public.fit_workout_templates;
create trigger trg_fit_workout_templates_updated_at
  before update on public.fit_workout_templates
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 5. fit_workouts (planned or done sessions; only 'done' counts as burned)
-- ---------------------------------------------------------------------
create table if not exists public.fit_workouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workout_on   date not null check (workout_on between date '1900-01-01' and date '2999-12-31'),
  start_time   time,
  category     text not null default 'other' check (category in
                 ('gym', 'cardio', 'yoga', 'running', 'swimming', 'cycling', 'team_sport', 'walking', 'other')),
  activity     text not null check (char_length(btrim(activity)) between 1 and 80),
  title        text not null check (char_length(btrim(title)) between 1 and 80),
  met          numeric(4,1) not null check (met between 1 and 25),
  duration_min integer not null check (duration_min between 1 and 1440),
  kcal         numeric(8,1) not null default 0 check (kcal between 0 and 20000),
  status       text not null default 'done' check (status in ('planned', 'done')),
  template_id  uuid,
  notes        text check (notes is null or char_length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fit_workouts_template_fkey foreign key (template_id, user_id)
    references public.fit_workout_templates (id, user_id) on delete set null (template_id)
);

create index if not exists fit_workouts_user_day_idx on public.fit_workouts (user_id, workout_on);
create index if not exists fit_workouts_user_template_idx
  on public.fit_workouts (user_id, template_id) where template_id is not null;

drop trigger if exists trg_fit_workouts_updated_at on public.fit_workouts;
create trigger trg_fit_workouts_updated_at
  before update on public.fit_workouts
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 6. fit_daily_logs (water + steps per day)
-- ---------------------------------------------------------------------
create table if not exists public.fit_daily_logs (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  log_date   date not null check (log_date between date '1900-01-01' and date '2999-12-31'),
  water_ml   integer not null default 0 check (water_ml between 0 and 20000),
  steps      integer not null default 0 check (steps between 0 and 200000),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

drop trigger if exists trg_fit_daily_logs_updated_at on public.fit_daily_logs;
create trigger trg_fit_daily_logs_updated_at
  before update on public.fit_daily_logs
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 7. fit_body_measurements (one row per day; at least one value)
-- ---------------------------------------------------------------------
create table if not exists public.fit_body_measurements (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  measured_on  date not null check (measured_on between date '1900-01-01' and date '2999-12-31'),
  weight_kg    numeric(5,1) check (weight_kg    between 20 and 400),
  body_fat_pct numeric(4,1) check (body_fat_pct between 1 and 75),
  chest_cm     numeric(5,1) check (chest_cm     between 20 and 300),
  waist_cm     numeric(5,1) check (waist_cm     between 20 and 300),
  hip_cm       numeric(5,1) check (hip_cm       between 20 and 300),
  thigh_cm     numeric(5,1) check (thigh_cm     between 10 and 200),
  arm_cm       numeric(5,1) check (arm_cm       between 5 and 150),
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fit_body_measurements_any_value check (
    num_nonnulls(weight_kg, body_fat_pct, chest_cm, waist_cm, hip_cm, thigh_cm, arm_cm) >= 1
  ),
  unique (user_id, measured_on)
);

drop trigger if exists trg_fit_body_measurements_updated_at on public.fit_body_measurements;
create trigger trg_fit_body_measurements_updated_at
  before update on public.fit_body_measurements
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 8. fit_progress_photos (image lives in the private `fitora` bucket, 001500)
-- ---------------------------------------------------------------------
create table if not exists public.fit_progress_photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  taken_on     date not null check (taken_on between date '1900-01-01' and date '2999-12-31'),
  pose         text not null default 'front' check (pose in ('front', 'side', 'back', 'other')),
  storage_path text not null,
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  constraint fit_progress_photos_path_check check (
    char_length(storage_path) <= 300 and split_part(storage_path, '/', 1) = user_id::text
  )
);

create index if not exists fit_progress_photos_user_day_idx on public.fit_progress_photos (user_id, taken_on desc);


-- ---------------------------------------------------------------------
-- 9. fit_ai_usage (daily AI scan counter; written only by fit_ai_quota_consume)
-- ---------------------------------------------------------------------
create table if not exists public.fit_ai_usage (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  used_on date not null,
  count   integer not null default 0 check (count >= 0),
  primary key (user_id, used_on)
);


-- ---------------------------------------------------------------------
-- 10. RPCs
-- ---------------------------------------------------------------------

-- Totals for one day. SECURITY INVOKER: RLS applies; the explicit user filter
-- only lets the (user_id, day) indexes be used.
create or replace function public.fit_day_summary(p_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_res jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_date is null then
    raise exception using errcode = '22023', message = 'p_date is required';
  end if;

  select jsonb_build_object(
           'kcal_in',      coalesce(m.kcal, 0),
           'protein_g',    coalesce(m.protein_g, 0),
           'carbs_g',      coalesce(m.carbs_g, 0),
           'fat_g',        coalesce(m.fat_g, 0),
           'fiber_g',      coalesce(m.fiber_g, 0),
           'workout_kcal', coalesce(w.kcal, 0),
           'water_ml',     coalesce(d.water_ml, 0),
           'steps',        coalesce(d.steps, 0))
    into v_res
    from (select sum(e.kcal) as kcal, sum(e.protein_g) as protein_g, sum(e.carbs_g) as carbs_g,
                 sum(e.fat_g) as fat_g, sum(e.fiber_g) as fiber_g
            from public.fit_meal_entries e
           where e.user_id = v_uid and e.eaten_on = p_date) m
   cross join (select sum(x.kcal) as kcal
                 from public.fit_workouts x
                where x.user_id = v_uid and x.workout_on = p_date and x.status = 'done') w
    left join public.fit_daily_logs d on d.user_id = v_uid and d.log_date = p_date;

  return v_res;
end;
$$;

-- One row per calendar day in [p_from, p_to] (inclusive, at most 366 days).
create or replace function public.fit_range_summary(p_from date, p_to date)
returns table (
  day          date,
  kcal_in      numeric,
  protein_g    numeric,
  carbs_g      numeric,
  fat_g        numeric,
  fiber_g      numeric,
  workout_kcal numeric,
  water_ml     integer,
  steps        integer,
  weight_kg    numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_from is null or p_to is null then
    raise exception using errcode = '22023', message = 'date range requires both p_from and p_to';
  end if;
  if p_from > p_to then
    raise exception using errcode = '22023', message = 'p_from must be on or before p_to';
  end if;
  if p_to - p_from > 365 then
    raise exception using errcode = '22023', message = 'date range is limited to 366 days';
  end if;
  if p_from < date '1900-01-01' or p_to > date '2999-12-31' then
    raise exception using errcode = '22023', message = 'date out of range';
  end if;

  return query
  with days as (
    select g::date as d from pg_catalog.generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ), meals as (
    select e.eaten_on as d, sum(e.kcal) as kcal, sum(e.protein_g) as protein_g, sum(e.carbs_g) as carbs_g,
           sum(e.fat_g) as fat_g, sum(e.fiber_g) as fiber_g
      from public.fit_meal_entries e
     where e.user_id = v_uid and e.eaten_on between p_from and p_to
     group by e.eaten_on
  ), wk as (
    select x.workout_on as d, sum(x.kcal) as kcal
      from public.fit_workouts x
     where x.user_id = v_uid and x.workout_on between p_from and p_to and x.status = 'done'
     group by x.workout_on
  )
  select days.d,
         coalesce(meals.kcal, 0)::numeric,
         coalesce(meals.protein_g, 0)::numeric,
         coalesce(meals.carbs_g, 0)::numeric,
         coalesce(meals.fat_g, 0)::numeric,
         coalesce(meals.fiber_g, 0)::numeric,
         coalesce(wk.kcal, 0)::numeric,
         coalesce(dl.water_ml, 0),
         coalesce(dl.steps, 0),
         bm.weight_kg::numeric
    from days
    left join meals on meals.d = days.d
    left join wk    on wk.d = days.d
    left join public.fit_daily_logs dl
           on dl.user_id = v_uid and dl.log_date = days.d
    left join public.fit_body_measurements bm
           on bm.user_id = v_uid and bm.measured_on = days.d
   order by days.d;
end;
$$;

-- Atomically take one AI scan from today's quota (today = the user's local day,
-- public.user_today()). Returns false, without counting, once p_limit is reached.
-- SECURITY DEFINER because clients have no write access to fit_ai_usage; it only
-- ever touches the caller's own row (auth.uid()).
create or replace function public.fit_ai_quota_consume(p_limit integer default 40)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 1000);
  v_today date;
  v_count integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  v_today := public.user_today();

  insert into public.fit_ai_usage as u (user_id, used_on, count)
  values (v_uid, v_today, 1)
  on conflict (user_id, used_on) do update
     set count = u.count + 1
   where u.count < v_limit
  returning u.count into v_count;

  -- Housekeeping: old counters of this user are no longer needed.
  delete from public.fit_ai_usage a where a.user_id = v_uid and a.used_on < v_today - 60;

  return v_count is not null;
end;
$$;


-- ---------------------------------------------------------------------
-- 11. Privileges (scoped to Fitora objects only)
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;

revoke all on
  public.fit_profiles, public.fit_custom_foods, public.fit_meal_entries,
  public.fit_workout_templates, public.fit_workouts, public.fit_daily_logs,
  public.fit_body_measurements, public.fit_progress_photos, public.fit_ai_usage
  from anon, authenticated;

grant select, insert, update, delete on
  public.fit_profiles, public.fit_custom_foods, public.fit_meal_entries,
  public.fit_workout_templates, public.fit_workouts, public.fit_daily_logs,
  public.fit_body_measurements, public.fit_progress_photos
  to authenticated;

grant select on public.fit_ai_usage to authenticated;  -- written only by fit_ai_quota_consume()

revoke execute on function
  public.fit_day_summary(date),
  public.fit_range_summary(date, date),
  public.fit_ai_quota_consume(integer)
  from public, anon;

grant execute on function
  public.fit_day_summary(date),
  public.fit_range_summary(date, date),
  public.fit_ai_quota_consume(integer)
  to authenticated;


-- ---------------------------------------------------------------------
-- 12. Row-level security
-- ---------------------------------------------------------------------
alter table public.fit_profiles          enable row level security;
alter table public.fit_custom_foods      enable row level security;
alter table public.fit_meal_entries      enable row level security;
alter table public.fit_workout_templates enable row level security;
alter table public.fit_workouts          enable row level security;
alter table public.fit_daily_logs        enable row level security;
alter table public.fit_body_measurements enable row level security;
alter table public.fit_progress_photos   enable row level security;
alter table public.fit_ai_usage          enable row level security;

-- Owner-only rule set, generated in a loop so the tables cannot drift apart.
do $$
declare
  t text;
begin
  foreach t in array array[
    'fit_profiles', 'fit_custom_foods', 'fit_meal_entries', 'fit_workout_templates',
    'fit_workouts', 'fit_daily_logs', 'fit_body_measurements', 'fit_progress_photos'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))',
      t || '_delete_own', t);
  end loop;
end;
$$;

-- fit_ai_usage: read own counter only. No INSERT/UPDATE/DELETE policy: the RPC writes it.
drop policy if exists fit_ai_usage_select_own on public.fit_ai_usage;
create policy fit_ai_usage_select_own on public.fit_ai_usage
  for select to authenticated
  using (user_id = (select auth.uid()));
