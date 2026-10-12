-- =====================================================================
-- Fitora: saved-foods hardening + AI quota day (follows 20261012000200).
--
--   1. fit_custom_foods.default_servings: how many servings the user usually eats
--      ("2 cái" scanned -> saved serving "1 cái" + default_servings 2), so the
--      one-tap re-log logs what was really eaten instead of half of it.
--   2. fit_custom_foods.name_key + unique (user_id, name_key): the app's normalised
--      dish name ("Phở Bò" = "pho bo"); two concurrent saves of the same new dish can
--      no longer create duplicates. NULL for foods saved before this migration (and
--      for hand-made foods): they are not affected and get their key lazily when the
--      app next recognises them by name; NULLs never collide in a unique index.
--   3. fit_ai_quota_consume(): the day of the counter is the UTC date, no longer the
--      date in profiles.timezone, which every user can edit (flipping between
--      UTC-12 and UTC+14 multiplied the daily AI allowance).
--
-- PURELY ADDITIVE and idempotent; only fit_* objects are touched.
-- =====================================================================

-- 1 + 2 ---------------------------------------------------------------
alter table public.fit_custom_foods add column if not exists default_servings numeric(8,2);
alter table public.fit_custom_foods add column if not exists name_key         text;

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_default_servings_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_default_servings_check
  check (default_servings is null or default_servings between 0.01 and 1000);

alter table public.fit_custom_foods drop constraint if exists fit_custom_foods_name_key_check;
alter table public.fit_custom_foods add constraint fit_custom_foods_name_key_check
  check (name_key is null or char_length(name_key) between 1 and 120);

create unique index if not exists fit_custom_foods_user_name_key_uidx
  on public.fit_custom_foods (user_id, name_key);


-- 3 -------------------------------------------------------------------
-- Same behaviour as 20261009001400, except the counter day is the UTC date.
-- (Signature unchanged: privileges are kept, and re-stated below.)
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
  -- UTC, not public.user_today(): the user can change profiles.timezone at will.
  v_today := (now() at time zone 'utc')::date;

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

revoke execute on function public.fit_ai_quota_consume(integer) from public, anon;
grant execute on function public.fit_ai_quota_consume(integer) to authenticated;
