-- =====================================================================
-- Fitora: reverse ONE saved-food usage bump ("Hoàn tác" right after a one-tap re-log).
--
-- PURELY ADDITIVE and idempotent: one new fit_* function (create or replace),
-- its privileges re-stated. Nothing owned by Note_mytasks is touched.
-- Follows 20261012000100 (fit_mark_food_used / saved foods).
-- =====================================================================

-- fit_unmark_food_used(id, prev_last_used_at, prev_default_meal): best-effort
-- reversal of ONE fit_mark_food_used bump. The caller passes the snapshot it had
-- before the bump:
--   use_count    -1 (only rows with use_count > 0 are touched)
--   last_used_at back to the snapshot, but never moved FORWARD (a value later
--                than the current one is ignored); null when the count hits 0
--   default_meal back to the snapshot (null allowed)
create or replace function public.fit_unmark_food_used(
  p_id uuid, p_prev_last_used_at timestamptz default null, p_prev_default_meal text default null)
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
  if p_prev_default_meal is not null and p_prev_default_meal not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception using errcode = '22023', message = 'invalid meal';
  end if;

  return query
  update public.fit_custom_foods f
     set use_count    = f.use_count - 1,
         last_used_at = case
                          when f.use_count <= 1 then null
                          when p_prev_last_used_at is null or p_prev_last_used_at <= f.last_used_at then p_prev_last_used_at
                          else f.last_used_at
                        end,
         default_meal = p_prev_default_meal
   where f.user_id = v_uid and f.id = p_id and f.use_count > 0
  returning f.*;
end;
$$;

revoke execute on function public.fit_unmark_food_used(uuid, timestamptz, text) from public, anon;
grant execute on function public.fit_unmark_food_used(uuid, timestamptz, text) to authenticated;
