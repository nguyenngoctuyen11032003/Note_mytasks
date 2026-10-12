-- =====================================================================
-- Fitora "remember, don't repeat" (contract: Fitora/docs/PLAN.md §2).
--
--   * fit_custom_foods becomes "Món của tôi / món đã lưu": a dish confirmed after
--     an AI scan is saved here (source 'ai', photo from the scan) so it can be
--     re-logged with one tap instead of scanning again. Usage counters drive the
--     "dùng gần đây / hay dùng" ordering.
--   * fit_meal_templates = "Bữa mẫu": a named set of items re-logged at once.
--   * fit_mark_food_used / fit_mark_meal_template_used: atomic usage bump.
--
-- PURELY ADDITIVE and idempotent: only fit_* objects are created or extended
-- (add column if not exists, constraints re-created by name). Nothing owned by
-- Note_mytasks is touched. Same conventions as 20261009001400_fitora_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. fit_custom_foods: provenance, photo, usage, preferred meal
-- ---------------------------------------------------------------------
alter table public.fit_custom_foods add column if not exists source       text not null default 'manual';
alter table public.fit_custom_foods add column if not exists photo_path   text;
alter table public.fit_custom_foods add column if not exists use_count    integer not null default 0;
alter table public.fit_custom_foods add column if not exists last_used_at timestamptz;
alter table public.fit_custom_foods add column if not exists default_meal text;

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_source_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_source_check
  check (source in ('manual', 'ai', 'meal'));

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_photo_path_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_photo_path_check
  check (photo_path is null or (char_length(photo_path) <= 300 and split_part(photo_path, '/', 1) = user_id::text));

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_use_count_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_use_count_check
  check (use_count >= 0);

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_default_meal_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_default_meal_check
  check (default_meal is null or default_meal in ('breakfast', 'lunch', 'dinner', 'snack'));

create index if not exists fit_custom_foods_user_recent_idx
  on public.fit_custom_foods (user_id, last_used_at desc nulls last);


-- ---------------------------------------------------------------------
-- 2. fit_meal_templates ("Bữa mẫu")
--    items: jsonb array (1..30) of
--      {name, quantity, unit, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, custom_food_id|null}
--    custom_food_id inside the JSON is NOT a foreign key (the food may be deleted
--    later); the client drops stale ids when it logs the template.
-- ---------------------------------------------------------------------
create table if not exists public.fit_meal_templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  meal         text check (meal is null or meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  items        jsonb not null check (
                 jsonb_typeof(items) = 'array'
                 and jsonb_array_length(items) between 1 and 30
                 and pg_column_size(items) <= 32768),
  total_kcal   numeric(9,1) not null default 0 check (total_kcal between 0 and 1500000),
  use_count    integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id)
);

create index if not exists fit_meal_templates_user_recent_idx
  on public.fit_meal_templates (user_id, last_used_at desc nulls last);

drop trigger if exists trg_fit_meal_templates_updated_at on public.fit_meal_templates;
create trigger trg_fit_meal_templates_updated_at
  before update on public.fit_meal_templates
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 3. RPCs: atomic usage bump (SECURITY INVOKER: RLS applies, own rows only).
--    Return the updated rows so the client can refresh its cache.
--    fit_mark_food_used(ids, meal): +1 use, last_used_at = now(), and when a
--    meal is given it becomes the food's default_meal (the meal it was last
--    logged at, pre-selected next time).
-- ---------------------------------------------------------------------
create or replace function public.fit_mark_food_used(p_ids uuid[], p_meal text default null)
returns setof public.fit_custom_foods
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_meal is not null and p_meal not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception using errcode = '22023', message = 'invalid meal';
  end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    return;
  end if;
  if array_length(p_ids, 1) > 100 then
    raise exception using errcode = '22023', message = 'too many ids';
  end if;

  return query
  update public.fit_custom_foods f
     set use_count    = least(f.use_count, 2147483646) + 1,
         last_used_at = now(),
         default_meal = coalesce(p_meal, f.default_meal)
   where f.user_id = v_uid and f.id = any (p_ids)
  returning f.*;
end;
$$;

create or replace function public.fit_mark_meal_template_used(p_id uuid)
returns setof public.fit_meal_templates
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;

  return query
  update public.fit_meal_templates t
     set use_count    = least(t.use_count, 2147483646) + 1,
         last_used_at = now()
   where t.user_id = v_uid and t.id = p_id
  returning t.*;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------
revoke all on public.fit_meal_templates from anon, authenticated;
grant select, insert, update, delete on public.fit_meal_templates to authenticated;

revoke execute on function
  public.fit_mark_food_used(uuid[], text),
  public.fit_mark_meal_template_used(uuid)
  from public, anon;

grant execute on function
  public.fit_mark_food_used(uuid[], text),
  public.fit_mark_meal_template_used(uuid)
  to authenticated;


-- ---------------------------------------------------------------------
-- 5. Row-level security (owner-only, same rule set as 001400)
-- ---------------------------------------------------------------------
alter table public.fit_meal_templates enable row level security;

drop policy if exists fit_meal_templates_select_own on public.fit_meal_templates;
drop policy if exists fit_meal_templates_insert_own on public.fit_meal_templates;
drop policy if exists fit_meal_templates_update_own on public.fit_meal_templates;
drop policy if exists fit_meal_templates_delete_own on public.fit_meal_templates;

create policy fit_meal_templates_select_own on public.fit_meal_templates
  for select to authenticated using (user_id = (select auth.uid()));
create policy fit_meal_templates_insert_own on public.fit_meal_templates
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy fit_meal_templates_update_own on public.fit_meal_templates
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy fit_meal_templates_delete_own on public.fit_meal_templates
  for delete to authenticated using (user_id = (select auth.uid()));
