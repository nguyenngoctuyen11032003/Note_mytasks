-- =====================================================================
-- Fitora: workouts logged by the Vyora gym app (follows 20261012000400).
--
--   fit_workouts.source      'fitora' (default — every existing row and every row
--                            Fitora inserts) | 'gym' (Vyora session timer).
--   fit_workouts.client_ref  uuid of the Vyora session. unique (user_id, client_ref)
--                            makes the app's offline retries idempotent: it inserts
--                            with ON CONFLICT (user_id, client_ref) DO NOTHING, so a
--                            row whose first insert succeeded but whose response was
--                            lost is never duplicated (nor overwritten after the
--                            user edited it in Fitora). NULLs never collide, so
--                            Fitora rows (client_ref null) are unaffected.
--   A 'gym' row must carry its client_ref.
--
-- RLS, grants, triggers and the summary RPCs are unchanged: a gym row is an
-- ordinary fit_workouts row, so status='done' rows count as workout_kcal in
-- fit_day_summary / fit_range_summary exactly like Fitora's own sessions.
--
-- PURELY ADDITIVE and idempotent; only fit_* objects are touched.
-- =====================================================================

alter table public.fit_workouts add column if not exists source text not null default 'fitora';
alter table public.fit_workouts add column if not exists client_ref uuid;

alter table public.fit_workouts drop constraint if exists fit_workouts_source_check;
alter table public.fit_workouts add constraint fit_workouts_source_check
  check (source in ('fitora', 'gym'));

alter table public.fit_workouts drop constraint if exists fit_workouts_gym_client_ref_check;
alter table public.fit_workouts add constraint fit_workouts_gym_client_ref_check
  check (source <> 'gym' or client_ref is not null);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'fit_workouts_user_client_ref_key'
       and conrelid = 'public.fit_workouts'::regclass
  ) then
    alter table public.fit_workouts
      add constraint fit_workouts_user_client_ref_key unique (user_id, client_ref);
  end if;
end $$;

comment on column public.fit_workouts.source is
  'Origin of the row: fitora (Fitora app, default) or gym (Vyora session timer).';
comment on column public.fit_workouts.client_ref is
  'Vyora session uuid; unique per user, makes offline retries idempotent. Null for Fitora rows.';
