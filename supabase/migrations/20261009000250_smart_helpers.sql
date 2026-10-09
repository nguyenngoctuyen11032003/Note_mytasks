-- Shared helpers for the "smart" RPC layer (migrations 0003xx–0005xx build on these
-- and on 20261009000200_business_logic.sql, which owns public.user_today() and
-- public.current_user_timezone()).
--
-- Rules for every RPC in this project
--   * SECURITY INVOKER (the default): RLS still decides which rows are visible.
--     SECURITY DEFINER only when a function must write something the caller cannot,
--     and then it re-checks ownership itself.
--   * `set search_path = ''` and fully-qualified names.
--   * EXECUTE revoked from public/anon, granted to authenticated only.
--   * "Today" / "this month" are computed in the caller's profiles.timezone, never UTC.

-- Caller's IANA timezone (alias of public.current_user_timezone() from 000200).
create or replace function public.user_tz()
returns text
language sql
stable
set search_path = ''
as $$
  select public.current_user_timezone();
$$;

-- Calendar day of an instant in the caller's timezone.
create or replace function public.user_day(p_ts timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_ts at time zone public.user_tz())::date;
$$;

revoke execute on function public.user_tz()                 from public, anon;
revoke execute on function public.user_day(timestamptz)     from public, anon;
grant  execute on function public.user_tz()                 to authenticated;
grant  execute on function public.user_day(timestamptz)     to authenticated;
