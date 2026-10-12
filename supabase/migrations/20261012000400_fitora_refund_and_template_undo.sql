-- =====================================================================
-- Fitora: AI quota refund + undo of a meal-template usage bump
-- (follows 20261012000300).
--
--   1. fit_ai_usage.refunded + fit_ai_quota_refund(): the Edge Function gives the
--      scan back when the AI provider failed (429 / 5xx / timeout / unreadable
--      answer), so a failed scan does not cost one of the daily scans. A client can
--      call the RPC too, so refunds are CAPPED at 10 per UTC day: the worst a user
--      can gain by abusing it is 10 extra scans per day.
--   2. fit_unmark_meal_template_used(): "Hoàn tác" after logging a "Bữa mẫu";
--      mirrors fit_unmark_food_used (20261012000200) for fit_meal_templates.
--
-- PURELY ADDITIVE and idempotent; only fit_* objects are touched.
-- =====================================================================

-- 1 -------------------------------------------------------------------
alter table public.fit_ai_usage add column if not exists refunded integer not null default 0;

alter table public.fit_ai_usage drop constraint if exists fit_ai_usage_refunded_check;
alter table public.fit_ai_usage add constraint fit_ai_usage_refunded_check
  check (refunded between 0 and 1000);

-- Gives ONE scan back to the caller for the UTC day (same day as fit_ai_quota_consume).
-- true = refunded; false = nothing to refund (no scan today, or the daily cap of
-- 10 refunds is used up).
create or replace function public.fit_ai_quota_refund()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;

  update public.fit_ai_usage u
     set count    = u.count - 1,
         refunded = u.refunded + 1
   where u.user_id = v_uid
     and u.used_on = (now() at time zone 'utc')::date
     and u.count > 0
     and u.refunded < 10
  returning 1 into v_n;

  return v_n is not null;
end;
$$;

revoke execute on function public.fit_ai_quota_refund() from public, anon;
grant execute on function public.fit_ai_quota_refund() to authenticated;


-- 2 -------------------------------------------------------------------
-- fit_unmark_meal_template_used(id, prev_last_used_at): best-effort reversal of ONE
-- fit_mark_meal_template_used bump:
--   use_count    -1 (only rows with use_count > 0 are touched)
--   last_used_at back to the snapshot, never moved FORWARD; null when the count hits 0
create or replace function public.fit_unmark_meal_template_used(
  p_id uuid, p_prev_last_used_at timestamptz default null)
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
     set use_count    = t.use_count - 1,
         last_used_at = case
                          when t.use_count <= 1 then null
                          when p_prev_last_used_at is null or p_prev_last_used_at <= t.last_used_at then p_prev_last_used_at
                          else t.last_used_at
                        end
   where t.user_id = v_uid and t.id = p_id and t.use_count > 0
  returning t.*;
end;
$$;

revoke execute on function public.fit_unmark_meal_template_used(uuid, timestamptz) from public, anon;
grant execute on function public.fit_unmark_meal_template_used(uuid, timestamptz) to authenticated;
