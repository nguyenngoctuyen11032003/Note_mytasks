-- =====================================================================
-- Smart features, part 1: Tasks & Time  (contract: docs/backend-api-contract.md §1)
--
--   1. Recurring tasks: tasks.recurrence, tasks.recurrence_parent_id, spawn trigger.
--   2. Timer RPCs: start_timer / stop_timer (REPLACE the 000200 versions with
--      identical signatures; the contract's timer_start / timer_stop), timer_current,
--      log_time.
--   3. Smart RPCs: focus_tasks (focus score), estimate_suggestion.
--
-- All RPCs are SECURITY INVOKER (RLS decides visibility), `search_path = ''`,
-- EXECUTE for `authenticated` only. Business errors:
--   raise exception using errcode = 'P0001', message = '<code>'
-- Codes used here: not_authenticated, not_found, task_closed, invalid_input,
--                  time_overlap, timer_already_running.
--
-- Concurrency: every RPC that writes time_entries first takes a per-user
-- transaction-scoped advisory lock (public.lock_user_time). This serializes
-- start_timer / stop_timer / log_time of the same user across connections, so
-- "stop the running segment, then open a new one" and "check overlap, then insert"
-- are atomic. The unique index time_entries_one_running_uq remains the last line
-- of defence; a unique_violation is mapped to `timer_already_running`.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------

alter table public.tasks
  add column recurrence text
    check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  add column recurrence_parent_id uuid,
  add constraint tasks_recurrence_parent_not_self check (recurrence_parent_id <> id),
  -- Composite FK (same pattern as the rest of the schema): a task can only belong
  -- to a series rooted in one of the SAME user's tasks.
  add constraint tasks_recurrence_parent_fkey
    foreign key (recurrence_parent_id, user_id)
    references public.tasks (id, user_id) on delete set null (recurrence_parent_id);

create index tasks_recurrence_parent_idx
  on public.tasks (recurrence_parent_id, due_date)
  where recurrence_parent_id is not null;


-- ---------------------------------------------------------------------
-- 2. Internal helpers
-- ---------------------------------------------------------------------

-- Per-user mutex for time_entries writers (released at commit/rollback).
create or replace function public.lock_user_time(p_user_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('time_entries:' || p_user_id::text, 0));
$$;

-- Next occurrence of a recurrence rule, strictly after p_from.
--   daily    : +1 day
--   weekdays : next Mon–Fri (Sat/Sun skipped)
--   weekly   : +7 days (same weekday)
--   monthly  : same day-of-month as p_anchor_day (defaults to day of p_from) in the
--              next month, clamped to the month's last day (31 Jan -> 28/29 Feb ->
--              31 Mar: the anchor prevents drift to the 28th).
-- If p_today is given and the occurrence is still before p_today, it rolls forward
-- (occurrence by occurrence, so the rhythm is kept) until it is >= p_today.
-- Pure function; granted to authenticated because the (SECURITY INVOKER) spawn
-- trigger calls it as the signed-in user. It exposes no data.
create or replace function public.recurrence_next_date(
  p_recurrence text,
  p_from       date,
  p_today      date    default null,
  p_anchor_day integer default null
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_anchor integer := least(greatest(coalesce(p_anchor_day, extract(day from p_from)::integer), 1), 31);
  v        date    := p_from;
  v_month  date;
  v_last   integer;
begin
  if p_recurrence is null or p_from is null then
    return null;
  end if;
  if p_recurrence not in ('daily', 'weekdays', 'weekly', 'monthly') then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  -- Fast-forward far-overdue series (avoids long loops; result is identical).
  if p_today is not null and v < p_today - 1 then
    if p_recurrence in ('daily', 'weekdays') then
      v := p_today - 1;                                   -- next step lands on >= today
    elsif p_recurrence = 'weekly' then
      v := v + 7 * ((p_today - 1 - v) / 7);               -- keeps weekday, still < today
    end if;
  end if;

  loop
    if p_recurrence = 'daily' then
      v := v + 1;
    elsif p_recurrence = 'weekdays' then
      v := v + 1;
      while extract(isodow from v) > 5 loop
        v := v + 1;
      end loop;
    elsif p_recurrence = 'weekly' then
      v := v + 7;
    else -- monthly
      v_month := (date_trunc('month', v) + interval '1 month')::date;
      v_last  := extract(day from (v_month + interval '1 month' - interval '1 day'))::integer;
      v       := v_month + (least(v_anchor, v_last) - 1);
    end if;
    exit when p_today is null or v >= p_today;
  end loop;

  return v;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Recurring tasks: spawn the next occurrence on completion
--
-- Fires when a task with `recurrence` enters 'completed' (insert or update).
--   * Series root  = coalesce(recurrence_parent_id, id).
--   * Base date    = due_date, or the owner's today when the task has no due date.
--   * Next due     = first occurrence strictly after the base date; if that is
--                    still in the past (task completed late), roll forward
--                    occurrence by occurrence until it is >= the owner's today.
--                    So an overdue daily task completed late gets due = today,
--                    never a pile of past-due copies.
--   * Monthly anchor = day-of-month of the root's due_date, as long as this task's
--                    due_date is that anchor clamped to its month (else the task
--                    was moved by the user and its own day becomes the anchor).
--   * No duplicates: skipped when another task of the same series already has a
--                    due_date >= the computed date (whatever its status). This makes
--                    reopen -> re-complete idempotent, even after the spawned copy
--                    itself was completed. A per-series advisory lock serializes
--                    concurrent completions of tasks in the same series.
--   * Copied: title, description, priority, category_id, tags, estimated_minutes,
--             recurrence. New task: status 'todo', actual_minutes 0.
-- SECURITY INVOKER: the insert runs as the owner and passes RLS normally
-- (log_activity records it as 'created').
-- Limitation: deleting the series root sets recurrence_parent_id to NULL on the
-- remaining tasks, so each of them becomes the root of its own series.
-- ---------------------------------------------------------------------

create or replace function public.tasks_spawn_next_recurrence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_root      uuid := coalesce(new.recurrence_parent_id, new.id);
  v_tz        text;
  v_today     date;
  v_root_due  date;
  v_anchor    integer;
  v_base      date;
  v_next      date;
  v_last      integer;
begin
  if new.recurrence is null or new.status <> 'completed' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task_series:' || v_root::text, 0));

  -- The owner's day (not the session's): correct even when service_role completes.
  select p.timezone into v_tz from public.profiles p where p.id = new.user_id;
  v_today := (now() at time zone coalesce(v_tz, public.user_tz()))::date;

  v_base := coalesce(new.due_date, v_today);

  if new.recurrence = 'monthly' then
    v_anchor := extract(day from v_base)::integer;
    if new.due_date is not null then
      select t.due_date into v_root_due from public.tasks t where t.id = v_root;
      if v_root_due is not null then
        v_last := extract(day from (date_trunc('month', new.due_date) + interval '1 month' - interval '1 day'))::integer;
        if extract(day from new.due_date)::integer = least(extract(day from v_root_due)::integer, v_last) then
          v_anchor := extract(day from v_root_due)::integer;
        end if;
      end if;
    end if;
  end if;

  v_next := public.recurrence_next_date(new.recurrence, v_base, v_today, v_anchor);

  if exists (
    select 1
      from public.tasks t
     where t.user_id = new.user_id
       and t.id <> new.id
       and (t.id = v_root or t.recurrence_parent_id = v_root)
       and t.due_date >= v_next
  ) then
    return null;
  end if;

  insert into public.tasks (
    user_id, title, description, status, priority, category_id, tags,
    due_date, estimated_minutes, recurrence, recurrence_parent_id)
  values (
    new.user_id, new.title, new.description, 'todo', new.priority, new.category_id, new.tags,
    v_next, new.estimated_minutes, new.recurrence, v_root);

  return null;
end;
$$;

create trigger trg_tasks_spawn_recurrence
  after insert or update of status on public.tasks
  for each row execute function public.tasks_spawn_next_recurrence();


-- ---------------------------------------------------------------------
-- 4. Timer
--
-- start_timer / stop_timer are the contract's timer_start / timer_stop. Migration
-- 000200 already shipped them under these names; they are REPLACED here with the
-- IDENTICAL signature and return type so existing callers and
-- supabase/tests/database.test.sql keep working. Compatibility choices:
--   * Error SQLSTATEs stay what 000200 used (and database.test.sql asserts):
--       not_found   -> errcode P0002 (no_data_found)
--       task_closed -> errcode 22023 (invalid_parameter_value)
--     but the MESSAGE is now the contract code, which is what the service maps.
--   * stop_timer on a segment shorter than 1 s keeps it, stretched to exactly 1 s
--     (000200 behaviour; database.test.sql starts and stops inside one transaction
--     and asserts a closed row). The contract says "delete".
--   * start_timer's auto-stop DELETES a < 1 s previous segment (contract): stretching
--     it would make it overlap the segment being opened.
-- ---------------------------------------------------------------------

create or replace function public.start_timer(p_task_id uuid default null, p_description text default null)
returns public.time_entries
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_desc   text := nullif(btrim(p_description), '');
  v_status text;
  v_row    public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if char_length(v_desc) > 500 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  perform public.lock_user_time(v_uid);

  if p_task_id is not null then
    -- RLS hides other users' tasks -> they are simply "not found".
    -- FOR UPDATE: the task cannot be closed concurrently between check and start.
    select t.status into v_status
      from public.tasks t
     where t.id = p_task_id and t.user_id = v_uid
       for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'not_found';
    end if;
    if v_status in ('completed', 'cancelled') then
      raise exception using errcode = '22023', message = 'task_closed';
    end if;
  end if;

  -- Auto-stop the running segment: < 1 s -> discard, else close at now().
  delete from public.time_entries te
   where te.user_id = v_uid
     and te.ended_at is null
     and te.started_at > now() - interval '1 second';
  update public.time_entries te
     set ended_at = now()
   where te.user_id = v_uid
     and te.ended_at is null;

  begin
    insert into public.time_entries (user_id, task_id, description, started_at, source)
    values (v_uid, p_task_id, v_desc, now(), 'timer')
    returning * into v_row;
  exception when unique_violation then
    -- Only reachable if a running row was inserted without going through the lock.
    raise exception using errcode = 'P0001', message = 'timer_already_running';
  end;

  if v_status = 'todo' then
    update public.tasks set status = 'in_progress' where id = p_task_id;
  end if;

  return v_row;
end;
$$;

-- Close the running segment; NULL when nothing runs.
create or replace function public.stop_timer()
returns public.time_entries
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  perform public.lock_user_time(v_uid);
  update public.time_entries te
     set ended_at = greatest(now(), te.started_at + interval '1 second')
   where te.user_id = v_uid
     and te.ended_at is null
  returning te.* into v_row;
  return v_row;
end;
$$;

-- timer_current: {entry, task_title, elapsed_seconds, task_total_seconds} or NULL.
--   elapsed_seconds    = whole seconds of the running segment.
--   task_total_seconds = finished segments of the same task + elapsed_seconds
--                        (NULL when the timer is not attached to a task).
create or replace function public.timer_current()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'entry',              to_jsonb(te),
           'task_title',         t.title,
           'elapsed_seconds',    e.secs,
           'task_total_seconds',
             case when te.task_id is null then null
                  else e.secs + coalesce((
                         select sum(x.duration_seconds)
                           from public.time_entries x
                          where x.task_id = te.task_id
                            and x.user_id = te.user_id
                            and x.ended_at is not null), 0)::bigint
             end)
    from public.time_entries te
    left join public.tasks t on t.id = te.task_id
   cross join lateral (
     select greatest(floor(extract(epoch from (now() - te.started_at))), 0)::bigint as secs
   ) e
   where te.user_id = (select auth.uid())
     and te.ended_at is null
   limit 1;
$$;

-- log_time: add a finished manual segment.
--   invalid_input: missing bounds, end <= start, end in the future (60 s tolerance
--                  for client clock skew), longer than 24 h, description > 500.
--   time_overlap : intersects another segment of the user; a running timer counts as
--                  [started_at, +infinity). Ranges are half-open, so back-to-back
--                  segments are fine.
--   not_found    : task does not exist / is not the caller's. Closed tasks are
--                  accepted (logging work after the fact is normal). p_task_id NULL
--                  logs time without a task.
create or replace function public.log_time(
  p_task_id     uuid,
  p_started_at  timestamptz,
  p_ended_at    timestamptz,
  p_description text default null
)
returns public.time_entries
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_desc text := nullif(btrim(p_description), '');
  v_row  public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_started_at is null or p_ended_at is null
     or p_ended_at <= p_started_at
     or p_ended_at > now() + interval '60 seconds'
     or p_ended_at - p_started_at > interval '24 hours'
     or char_length(v_desc) > 500 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  if p_task_id is not null and not exists (
    select 1 from public.tasks t where t.id = p_task_id and t.user_id = v_uid
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  perform public.lock_user_time(v_uid);

  if exists (
    select 1
      from public.time_entries te
     where te.user_id = v_uid
       and pg_catalog.tstzrange(te.started_at, coalesce(te.ended_at, 'infinity'::timestamptz), '[)')
           operator(pg_catalog.&&) pg_catalog.tstzrange(p_started_at, p_ended_at, '[)')
  ) then
    raise exception using errcode = 'P0001', message = 'time_overlap';
  end if;

  insert into public.time_entries (user_id, task_id, description, started_at, ended_at, source)
  values (v_uid, p_task_id, v_desc, p_started_at, p_ended_at, 'manual')
  returning * into v_row;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. focus_tasks: what to work on next
--   priority : urgent 40, high 28, medium 16, low 6
--   due      : overdue 30 + min(days_overdue*2, 20); today 30; tomorrow 22;
--              <= 3 days 15; <= 7 days 8; later / none 0
--   in_progress +10, quick win (0 < estimated_minutes <= 30) +5,
--   stale (created > 14 user-days ago) +5.
--   reasons (canonical order): overdue, due_today, due_tomorrow, due_soon (2–7 days),
--   priority_urgent, priority_high, in_progress, quick_win, stale.
--   Order: score desc, due_date asc nulls last, created_at asc, id.
--   p_limit: NULL -> 5; must be >= 1; capped at 100.
-- Mirrors src/services/smart/scoring.js focusScore().
-- ---------------------------------------------------------------------

create or replace function public.focus_tasks(p_limit integer default 5)
returns table (
  task_id  uuid,
  title    text,
  priority text,
  due_date date,
  status   text,
  score    numeric,
  reasons  text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := public.user_today();
  v_limit integer := coalesce(p_limit, 5);
begin
  if v_limit < 1 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;
  v_limit := least(v_limit, 100);

  return query
    with base as (
      select t.id, t.title, t.priority, t.due_date, t.status, t.created_at,
             t.due_date - v_today as days_left,
             (t.estimated_minutes > 0 and t.estimated_minutes <= 30) as quick,
             (v_today - public.user_day(t.created_at) > 14)          as stale
        from public.tasks t
       where t.user_id = (select auth.uid())
         and t.status in ('todo', 'in_progress')
    ),
    scored as (
      select b.*,
             (case b.priority when 'urgent' then 40 when 'high' then 28
                              when 'medium' then 16 else 6 end)
           + (case when b.days_left is null then 0
                   when b.days_left < 0  then 30 + least(-b.days_left * 2, 20)
                   when b.days_left = 0  then 30
                   when b.days_left = 1  then 22
                   when b.days_left <= 3 then 15
                   when b.days_left <= 7 then 8
                   else 0 end)
           + (case when b.status = 'in_progress' then 10 else 0 end)
           + (case when b.quick then 5 else 0 end)
           + (case when b.stale then 5 else 0 end) as pts,
             array_remove(array[
               case when b.days_left < 0 then 'overdue' end,
               case when b.days_left = 0 then 'due_today' end,
               case when b.days_left = 1 then 'due_tomorrow' end,
               case when b.days_left between 2 and 7 then 'due_soon' end,
               case when b.priority = 'urgent' then 'priority_urgent' end,
               case when b.priority = 'high' then 'priority_high' end,
               case when b.status = 'in_progress' then 'in_progress' end,
               case when b.quick then 'quick_win' end,
               case when b.stale then 'stale' end
             ]::text[], null) as why
        from base b
    )
    select s.id, s.title, s.priority, s.due_date, s.status, s.pts::numeric, s.why
      from scored s
     order by s.pts desc, s.due_date asc nulls last, s.created_at asc, s.id
     limit v_limit;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. estimate_suggestion: how good are my estimates?
--   Samples: the caller's 50 most recently completed tasks with
--   estimated_minutes > 0 and actual_minutes > 0 (optionally one category).
--   accuracy_ratio        = median(actual / estimated), 4 decimals (NULL if none)
--   median_actual_minutes = median(actual_minutes), 1 decimal (NULL if none)
--   suggested_multiplier  = round(accuracy_ratio, 2), NULL when samples < 3
-- An unknown / foreign category simply yields 0 samples (RLS).
-- ---------------------------------------------------------------------

create or replace function public.estimate_suggestion(p_category_id uuid default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with s as (
    select t.actual_minutes::numeric as actual,
           t.actual_minutes::numeric / t.estimated_minutes as ratio
      from public.tasks t
     where t.user_id = (select auth.uid())
       and t.status = 'completed'
       and t.estimated_minutes > 0
       and t.actual_minutes > 0
       and (p_category_id is null or t.category_id = p_category_id)
     order by t.completed_at desc, t.id
     limit 50
  ),
  agg as (
    select count(*)::integer as n,
           percentile_cont(0.5) within group (order by s.ratio)  as med_ratio,
           percentile_cont(0.5) within group (order by s.actual) as med_actual
      from s
  )
  select jsonb_build_object(
           'samples',               a.n,
           'accuracy_ratio',        round(a.med_ratio::numeric, 4),
           'median_actual_minutes', round(a.med_actual::numeric, 1),
           'suggested_multiplier',  case when a.n >= 3 then round(a.med_ratio::numeric, 2) end)
    from agg a;
$$;


-- ---------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------

revoke execute on function
  public.lock_user_time(uuid),
  public.recurrence_next_date(text, date, date, integer),
  public.tasks_spawn_next_recurrence(),
  public.start_timer(uuid, text),
  public.stop_timer(),
  public.timer_current(),
  public.log_time(uuid, timestamptz, timestamptz, text),
  public.focus_tasks(integer),
  public.estimate_suggestion(uuid)
  from public, anon;

-- The trigger function is never callable via /rpc. (The RPCs are SECURITY INVOKER,
-- so the helpers they call -- lock_user_time, recurrence_next_date -- must be
-- executable by authenticated; both are harmless: an advisory lock and a pure
-- date calculation.)
revoke execute on function public.tasks_spawn_next_recurrence() from authenticated;

grant execute on function
  public.lock_user_time(uuid),
  public.recurrence_next_date(text, date, date, integer),
  public.start_timer(uuid, text),
  public.stop_timer(),
  public.timer_current(),
  public.log_time(uuid, timestamptz, timestamptz, text),
  public.focus_tasks(integer),
  public.estimate_suggestion(uuid)
  to authenticated;
