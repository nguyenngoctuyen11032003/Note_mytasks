-- Re-sync of every function defined in 000250–000500.
--
-- Why: 000300–000500 reached the hosted database while they were still being
-- written, so the hosted function bodies (e.g. stop_timer deleting < 1 s segments)
-- differ from the reviewed migration files, and `db push` never re-applies an
-- already-recorded version. This migration re-states the FINAL definitions; it is
-- idempotent (create or replace / if not exists / drop trigger if exists), so on a
-- fresh database it is a no-op re-definition.
-- GENERATED from 000250, 000300 (minus its schema section), 000400, 000500.
-- If a hosted function has a different signature/return type, create or replace
-- fails and the whole push rolls back — nothing is left half-applied.

-- ---------------------------------------------------------------------
-- 000300 schema, guarded (no-op where already present)
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists recurrence text
    check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  add column if not exists recurrence_parent_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_recurrence_parent_not_self'
                   and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks
      add constraint tasks_recurrence_parent_not_self check (recurrence_parent_id <> id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_recurrence_parent_fkey'
                   and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks
      add constraint tasks_recurrence_parent_fkey
        foreign key (recurrence_parent_id, user_id)
        references public.tasks (id, user_id) on delete set null (recurrence_parent_id);
  end if;
end;
$$;

create index if not exists tasks_recurrence_parent_idx
  on public.tasks (recurrence_parent_id, due_date)
  where recurrence_parent_id is not null;

-- =====================================================================
-- from 20261009000250_smart_helpers.sql
-- =====================================================================
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

-- =====================================================================
-- from 20261009000300_tasks_time.sql
-- =====================================================================
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
-- Body kept byte-identical to 20261009000800 (make_date instead of date_trunc on a
-- date, which depends on the session TimeZone), so re-running this resync on its own
-- never brings the non-IMMUTABLE version back.
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
      v_month := (make_date(extract(year from v)::integer, extract(month from v)::integer, 1)
                  + interval '1 month')::date;   -- pure date math: no timestamptz, no session TZ
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

drop trigger if exists trg_tasks_spawn_recurrence on public.tasks;
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

-- =====================================================================
-- from 20261009000400_finance.sql
-- =====================================================================
-- =====================================================================
-- Finance smart features (contract: docs/backend-api-contract.md §2)
--
--   budget_status(p_month)              carry-forward budgets + month projection
--   spending_summary(p_from, p_to)      totals / breakdowns / every day / previous period
--   expense_anomalies(p_days)           robust (median + MAD) outliers per category
--   suggest_expense_category(text)      token vote over the user's own history
--   set_budget(amount, category, month) upsert of a carry-forward budget row
--
--   purchase_shopping_item is owned by migration 20261009000200_business_logic.sql
--   and is intentionally NOT redefined here.
--
-- All functions: SECURITY INVOKER (RLS decides visibility), search_path = '',
-- fully-qualified names, EXECUTE for `authenticated` only.
-- Business errors: errcode P0001 with a snake_case message
-- (invalid_input, not_found, not_authenticated).
-- "Today" / "this month" = public.user_today() (caller's profiles.timezone).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helper: lowercase + strip Vietnamese diacritics (NFC first, so decomposed
-- input from some keyboards / copy-paste still matches). Upper-case letters are
-- mapped explicitly because lower() only folds ASCII under the C collation.
-- ---------------------------------------------------------------------
create or replace function public.vi_normalize(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.translate(
    pg_catalog.lower(pg_catalog.normalize(coalesce(p_text, ''), 'NFC')),
    'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬĐÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ',
    'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyaaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
  );
$$;


-- ---------------------------------------------------------------------
-- budget_status(p_month)
--   Rows: overall (category_id null) when an overall budget applies, then one
--   row per expense category that has a budget or spending in the month.
--   Uncategorised spending counts towards the overall row only.
-- ---------------------------------------------------------------------
create or replace function public.budget_status(p_month date default null)
returns table (
  category_id   uuid,
  category_name text,
  color         text,
  budget        numeric,
  spent         numeric,
  remaining     numeric,
  used_pct      numeric,
  projected     numeric,
  status        text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_today date := public.user_today();
  v_cur   date := date_trunc('month', v_today)::date;
  v_month date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_next  date := (date_trunc('month', coalesce(p_month, v_today)) + interval '1 month')::date;
  v_num   integer;   -- projected = round(spent * v_num / v_den, 2)
  v_den   integer;
begin
  if v_month = v_cur then
    v_num := v_next - v_month;          -- days in month
    v_den := v_today - v_month + 1;     -- days elapsed, today included
  elsif v_month < v_cur then
    v_num := 1; v_den := 1;             -- closed month: projection = actual
  else
    v_num := 0; v_den := 1;             -- future month
  end if;

  return query
  with cat_budget as (
    select distinct on (b.category_id) b.category_id as cid, b.amount
      from public.budgets b
     where b.user_id = v_uid
       and b.category_id is not null
       and b.effective_month <= v_month
     order by b.category_id, b.effective_month desc
  ),
  overall as (
    select b.amount
      from public.budgets b
     where b.user_id = v_uid
       and b.category_id is null
       and b.effective_month <= v_month
     order by b.effective_month desc
     limit 1
  ),
  spend as (
    select e.category_id as cid, sum(e.amount) as spent
      from public.expenses e
     where e.user_id = v_uid
       and e.spent_on >= v_month
       and e.spent_on <  v_next
     group by e.category_id
  ),
  keys as (
    select cb.cid from cat_budget cb
    union
    select s.cid from spend s where s.cid is not null
  ),
  r as (
    select null::uuid as cid, null::text as cname, null::text as ccolor,
           o.amount as bud,
           coalesce((select sum(s.spent) from spend s), 0)::numeric as sp,
           0 as ord
      from overall o
    union all
    select c.id, c.name, c.color, cb.amount, coalesce(s.spent, 0)::numeric, 1
      from keys k
      join public.categories c on c.id = k.cid
      left join cat_budget cb on cb.cid = k.cid
      left join spend s       on s.cid  = k.cid
  ),
  calc as (
    select r.*, round(r.sp * v_num / v_den, 2) as proj from r
  )
  select calc.cid,
         calc.cname,
         calc.ccolor,
         calc.bud,
         calc.sp,
         calc.bud - calc.sp,
         case when calc.bud > 0 then round(calc.sp / calc.bud * 100, 1) end,
         calc.proj,
         case
           when calc.bud is null                                   then 'no_budget'
           when calc.sp > calc.bud                                 then 'over'
           when (calc.bud > 0 and calc.sp >= calc.bud * 0.8)
             or calc.proj > calc.bud                               then 'warning'
           else 'ok'
         end
    from calc
   order by calc.ord, calc.sp desc, calc.cname;
end;
$$;


-- ---------------------------------------------------------------------
-- spending_summary(p_from, p_to)
-- ---------------------------------------------------------------------
create or replace function public.spending_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_days      integer;
  v_total     numeric;
  v_count     bigint;
  v_prev      numeric;
  v_by_cat    jsonb;
  v_by_pm     jsonb;
  v_by_day    jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from + 1 > 366 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;
  v_days := p_to - p_from + 1;

  select coalesce(sum(e.amount), 0), count(*)
    into v_total, v_count
    from public.expenses e
   where e.user_id = v_uid and e.spent_on between p_from and p_to;

  select coalesce(sum(e.amount), 0)
    into v_prev
    from public.expenses e
   where e.user_id = v_uid and e.spent_on between p_from - v_days and p_from - 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id,
           'name',        x.name,
           'color',       x.color,
           'total',       x.total,
           'count',       x.cnt,
           'pct',         case when v_total > 0 then round(x.total / v_total * 100, 1) else 0 end
         ) order by x.total desc, x.name nulls last), '[]'::jsonb)
    into v_by_cat
    from (
      select e.category_id, c.name, c.color, sum(e.amount) as total, count(*) as cnt
        from public.expenses e
        left join public.categories c on c.id = e.category_id
       where e.user_id = v_uid and e.spent_on between p_from and p_to
       group by e.category_id, c.name, c.color
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.payment_method, 'total', x.total)
           order by x.total desc, x.payment_method), '[]'::jsonb)
    into v_by_pm
    from (
      select e.payment_method, sum(e.amount) as total
        from public.expenses e
       where e.user_id = v_uid and e.spent_on between p_from and p_to
       group by e.payment_method
    ) x;

  select jsonb_agg(jsonb_build_object('day', d.day, 'total', coalesce(s.total, 0)) order by d.day)
    into v_by_day
    from (select g::date as day from generate_series(p_from, p_to, interval '1 day') g) d
    left join (
      select e.spent_on, sum(e.amount) as total
        from public.expenses e
       where e.user_id = v_uid and e.spent_on between p_from and p_to
       group by e.spent_on
    ) s on s.spent_on = d.day;

  return jsonb_build_object(
    'total',             v_total,
    'count',             v_count,
    'daily_avg',         round(v_total / v_days, 2),
    'by_category',       v_by_cat,
    'by_payment_method', v_by_pm,
    'by_day',            v_by_day,
    'prev_total',        v_prev,
    'change_pct',        case when v_prev > 0 then round((v_total - v_prev) / v_prev * 100, 1) end
  );
end;
$$;


-- ---------------------------------------------------------------------
-- expense_anomalies(p_days)
--   Window   W = [today - p_days + 1, today]
--   History  H = same category, [start(W) - 180, start(W) - 1]  (>= 5 samples)
--   Robust z = 0.6745 * (x - median(H)) / MAD(H)
--   Anomaly: z >= 3.5 AND x >= 2*median; when MAD = 0: x >= 3*median (z_score null).
--   H ends before W, so an expense is never part of its own baseline.
-- ---------------------------------------------------------------------
create or replace function public.expense_anomalies(p_days integer default 30)
returns table (
  expense_id    uuid,
  amount        numeric,
  category_id   uuid,
  category_name text,
  spent_on      date,
  description   text,
  baseline      numeric,
  z_score       numeric,
  reason        text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_today date := public.user_today();
  v_start date;
begin
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;
  v_start := v_today - (p_days - 1);

  return query
  with hist as (
    select h.category_id as cid, h.amount
      from public.expenses h
     where h.user_id = v_uid
       and h.category_id is not null
       and h.spent_on >= v_start - 180
       and h.spent_on <  v_start
  ),
  med as (
    select hist.cid,
           (percentile_cont(0.5) within group (order by hist.amount))::numeric as m
      from hist
     group by hist.cid
    having count(*) >= 5
  ),
  mad as (
    select hist.cid,
           (percentile_cont(0.5) within group (order by abs(hist.amount - med.m)))::numeric as mad
      from hist
      join med on med.cid = hist.cid
     group by hist.cid
  ),
  scored as (
    select e.id, e.amount, e.category_id as cid, e.spent_on as day, e.description as descr,
           med.m, mad.mad,
           case when mad.mad > 0 then 0.6745 * (e.amount - med.m) / mad.mad end as z
      from public.expenses e
      join med on med.cid = e.category_id
      join mad on mad.cid = e.category_id
     where e.user_id = v_uid
       and e.spent_on between v_start and v_today
  )
  select s.id, s.amount, s.cid, c.name, s.day, s.descr,
         round(s.m, 2), round(s.z, 2), 'high_vs_category'::text
    from scored s
    left join public.categories c on c.id = s.cid
   where (s.mad > 0 and s.z >= 3.5 and s.amount >= 2 * s.m)
      or (s.mad = 0 and s.amount >= 3 * s.m)
   order by s.day desc, s.amount desc;
end;
$$;


-- ---------------------------------------------------------------------
-- suggest_expense_category(p_description)
--   Tokens = accent-free lowercase [a-z0-9]+ runs of length >= 2.
--   Every past expense (365 days) votes for its category once per shared token.
--   confidence = category votes / all votes (top 3).
-- ---------------------------------------------------------------------
create or replace function public.suggest_expense_category(p_description text)
returns table (category_id uuid, name text, confidence numeric)
language sql
stable
set search_path = ''
as $$
  with q as (
    select distinct t.tok
      from regexp_split_to_table(public.vi_normalize(p_description), '[^a-z0-9]+') as t(tok)
     where length(t.tok) >= 2
  ),
  hist as (
    select e.category_id as cid, public.vi_normalize(e.description) as d
      from public.expenses e
     where e.user_id = (select auth.uid())
       and e.category_id is not null
       and e.description is not null
       and e.spent_on >= public.user_today() - 365
  ),
  votes as (
    select h.cid, count(*)::numeric as v
      from hist h
      cross join lateral (
        select distinct t.tok
          from regexp_split_to_table(h.d, '[^a-z0-9]+') as t(tok)
         where length(t.tok) >= 2
      ) ht
      join q on q.tok = ht.tok
     group by h.cid
  ),
  tot as (select sum(v) as s from votes)
  select v.cid, c.name, round(v.v / tot.s, 2)
    from votes v
    join public.categories c on c.id = v.cid
   cross join tot
   order by v.v desc, c.name
   limit 3;
$$;


-- ---------------------------------------------------------------------
-- set_budget(p_amount, p_category_id, p_month)
--   Upserts the carry-forward row for the month (default: current month).
-- ---------------------------------------------------------------------
create or replace function public.set_budget(
  p_amount      numeric,
  p_category_id uuid default null,
  p_month       date default null
)
returns public.budgets
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_month date := date_trunc('month', coalesce(p_month, public.user_today()))::date;
  v_kind  text;
  v_row   public.budgets;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_amount is null or p_amount < 0 or p_amount >= 1e12 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  if p_category_id is null then
    insert into public.budgets (user_id, effective_month, category_id, amount)
    values (v_uid, v_month, null, p_amount)
    on conflict (user_id, effective_month) where category_id is null
    do update set amount = excluded.amount
    returning * into v_row;
  else
    select c.kind into v_kind
      from public.categories c
     where c.id = p_category_id and c.user_id = v_uid;
    if v_kind is null then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if v_kind <> 'expense' then
      raise exception using errcode = 'P0001', message = 'invalid_input';
    end if;

    insert into public.budgets (user_id, effective_month, category_id, amount)
    values (v_uid, v_month, p_category_id, p_amount)
    on conflict (user_id, effective_month, category_id) where category_id is not null
    do update set amount = excluded.amount
    returning * into v_row;
  end if;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: Supabase default-grants EXECUTE to anon; only signed-in users call these.
-- ---------------------------------------------------------------------
revoke execute on function
  public.vi_normalize(text),
  public.budget_status(date),
  public.spending_summary(date, date),
  public.expense_anomalies(integer),
  public.suggest_expense_category(text),
  public.set_budget(numeric, uuid, date)
  from public, anon;

grant execute on function
  public.vi_normalize(text),
  public.budget_status(date),
  public.spending_summary(date, date),
  public.expense_anomalies(integer),
  public.suggest_expense_category(text),
  public.set_budget(numeric, uuid, date)
  to authenticated;

-- =====================================================================
-- from 20261009000500_kpi_dashboard.sql
-- =====================================================================
-- =====================================================================
-- Smart features — section 3 of docs/backend-api-contract.md:
--   kpi_forecast(p_kpi_id)          KPI forecast (linear regression)
--   dashboard_summary()             one call for the Dashboard page
--   productivity_stats(p_from,p_to) report charts
--   streaks()                       activity streak
--
-- Self-contained on purpose: depends only on 000100 (tables) and 000250
-- (user_tz / user_today). It does NOT call timer_current() (000300) or
-- budget_status() (000400); the running timer and the month budget are read
-- straight from the tables, using the same rules as those functions, so this
-- migration applies whether or not 000300/000400 exist.
--
-- Documented rules (shared by every function below)
--   * "Day" = calendar day in the caller's profiles.timezone (public.user_tz()).
--     The timezone is resolved ONCE per call and applied with `at time zone`,
--     instead of calling user_day() per row.
--   * A time entry belongs entirely to the day it STARTED on (an entry
--     23:30 -> 00:30 counts 60 min for the first day). Never split.
--   * Minutes = round(sum(seconds) / 60). Only finished entries count, except
--     dashboard_summary().time.today_minutes / week_minutes, which also add the
--     running segment's elapsed time so the tiles move with the timer.
--   * Week start = profiles.week_starts_on (0 = Sunday .. 6 = Saturday):
--       week_start = today - ((dow(today) - week_starts_on + 7) % 7)
--   * Range-taking RPCs: both bounds required, p_from <= p_to, at most 366 days
--     inclusive, else P0001 'invalid_input'.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. kpi_forecast  (named so it is not confused with the kpi_progress VIEW of 000200)
--
--   Points       = one per recorded_on day: the LATEST record of that day
--                  (created_at desc, id desc) -- duplicates of a day never
--                  double-weight the regression. Same "latest" rule as the
--                  trg_kpi_records_sync trigger, so current_value agrees.
--   records      = number of such points (distinct days).
--   slope_per_day= regr_slope(value, recorded_on - start_date), >= 2 points,
--                  rounded to 6 decimals.
--   projected_value (needs end_date and slope)
--                = current + slope * (end_date - last_point_day), anchored on the
--                  latest point (not the regression intercept) so the forecast
--                  starts from where the user really is. Once the deadline has
--                  passed (today > end_date) there is no future left, so
--                  projected_value = current_value.
--   projected_completion = last_point_day + ceil((target - current) / slope)
--                  when slope > 0 and not yet achieved; null when > 100 years out.
--   expected_pct = % of start->end elapsed at today, clamped to 0..100
--                  (end_date = start_date: 0 before, 100 from that day on).
--   status       = achieved   current >= target
--                  no_data    < 2 points
--                  -- with end_date (contract rules):
--                  on_track   projected_value >= target OR progress_pct >= expected_pct
--                  at_risk    projected_value >= 80% target
--                  off_track  otherwise
--                  -- without end_date (no deadline -> judge the trend):
--                  on_track slope > 0, at_risk slope = 0 (stalled), off_track slope < 0
--   KPIs are "higher is better" (target_value > 0, achieved = current >= target).
-- ---------------------------------------------------------------------

create or replace function public.kpi_forecast(p_kpi_id uuid default null)
returns table (
  kpi_id               uuid,
  name                 text,
  unit                 text,
  target_value         numeric,
  current_value        numeric,
  progress_pct         numeric,
  start_date           date,
  end_date             date,
  records              int,
  slope_per_day        numeric,
  projected_value      numeric,
  projected_completion date,
  expected_pct         numeric,
  status               text
)
language sql
stable
set search_path = ''
as $$
  with ctx as (
    select public.user_today() as today
  ),
  k as (
    select k.*
      from public.kpis k
     where k.user_id = (select auth.uid())
       and case when p_kpi_id is null then k.status = 'active' else k.id = p_kpi_id end
  ),
  pts as (            -- latest record per (kpi, day)
    select distinct on (r.kpi_id, r.recorded_on)
           r.kpi_id, r.recorded_on, r.value
      from public.kpi_records r
      join k on k.id = r.kpi_id
     order by r.kpi_id, r.recorded_on, r.created_at desc, r.id desc
  ),
  agg as (
    select p.kpi_id,
           count(*)::int                                                     as n,
           regr_slope(p.value::float8, (p.recorded_on - k.start_date)::float8) as slope,
           max(p.recorded_on)                                                as last_day
      from pts p
      join k on k.id = p.kpi_id
     group by p.kpi_id
  ),
  lastpt as (
    select distinct on (p.kpi_id) p.kpi_id, p.value
      from pts p
     order by p.kpi_id, p.recorded_on desc
  ),
  base as (
    select k.id, k.name, k.unit, k.target_value, k.start_date, k.end_date, k.created_at,
           coalesce(l.value, k.current_value)                                  as cur,
           coalesce(a.n, 0)                                                    as n,
           case when a.n >= 2 then round(a.slope::numeric, 6) end              as slope,
           a.last_day,
           c.today
      from k
     cross join ctx c
      left join agg a    on a.kpi_id = k.id
      left join lastpt l on l.kpi_id = k.id
  ),
  calc as (
    select b.*,
           round(b.cur / b.target_value * 100, 1) as progress_pct,
           case
             when b.end_date is null then null
             when b.end_date = b.start_date then
               case when b.today >= b.end_date then 100.0 else 0.0 end
             else round(least(greatest(
                    (b.today - b.start_date)::numeric / (b.end_date - b.start_date) * 100, 0), 100), 1)
           end as expected_pct,
           case
             when b.end_date is null or b.slope is null then null
             when b.today > b.end_date then b.cur
             else round(b.cur + b.slope * greatest(b.end_date - b.last_day, 0), 2)
           end as projected_value,
           case
             when b.slope > 0 and b.cur < b.target_value
                  and ceil((b.target_value - b.cur) / b.slope) <= 36500
               then b.last_day + ceil((b.target_value - b.cur) / b.slope)::int
           end as projected_completion
      from base b
  )
  select c.id, c.name, c.unit, c.target_value, c.cur, c.progress_pct,
         c.start_date, c.end_date, c.n, c.slope, c.projected_value,
         c.projected_completion, c.expected_pct,
         case
           when c.cur >= c.target_value then 'achieved'
           when c.n < 2 then 'no_data'
           when c.end_date is null then
             case when c.slope > 0 then 'on_track'
                  when c.slope = 0 then 'at_risk'
                  else 'off_track' end
           when c.projected_value >= c.target_value
             or c.progress_pct >= c.expected_pct then 'on_track'
           when c.projected_value >= 0.8 * c.target_value then 'at_risk'
           else 'off_track'
         end
    from calc c
   order by c.end_date nulls last, c.created_at, c.id;
$$;


-- ---------------------------------------------------------------------
-- 2. streaks
--   Active day = >= 1 task completed that day OR >= 15 minutes (900 s) of
--   FINISHED time entries started that day (running segment not counted:
--   it is not a fact yet). Days after today are ignored.
--   current = length of the run ending today, or ending yesterday when today
--   is not active yet (the streak is still alive until today is over).
-- ---------------------------------------------------------------------

create or replace function public.streaks()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tz     text := public.user_tz();
  v_today  date := (now() at time zone v_tz)::date;
  v_result jsonb;
begin
  with act as (
    select (t.completed_at at time zone v_tz)::date as d
      from public.tasks t
     where t.user_id = v_uid and t.status = 'completed'
    union
    select x.d
      from (select (te.started_at at time zone v_tz)::date as d,
                   sum(te.duration_seconds) as secs
              from public.time_entries te
             where te.user_id = v_uid and te.ended_at is not null
             group by 1) x
     where x.secs >= 900
  ),
  days as (
    select distinct a.d from act a where a.d <= v_today
  ),
  isl as (
    select d.d, d.d - (row_number() over (order by d.d))::int as grp from days d
  ),
  runs as (
    select max(i.d) as e, count(*)::int as len from isl i group by i.grp
  )
  select jsonb_build_object(
           'current',         coalesce((select r.len from runs r where r.e >= v_today - 1
                                         order by r.e desc limit 1), 0),
           'longest',         coalesce((select max(r.len) from runs r), 0),
           'last_active_day', (select max(r.e) from runs r))
    into v_result;
  return v_result;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. dashboard_summary
--   tasks.open            todo + in_progress
--   tasks.overdue         open and due_date < today
--   tasks.due_today       open and due_date = today
--   tasks.completed_*     by completed_at day (user tz); week = week_start..today
--   time.running          same shape as timer_current():
--                         {entry, task_title, elapsed_seconds, task_total_seconds}
--                         task_total_seconds = finished seconds of that task + elapsed
--   money.month_budget    overall carry-forward budget (category_id null,
--                         greatest effective_month <= this month), null if none
--   money.month_remaining budget - spent (null without budget)
--   money.month_projected spent / days_elapsed * days_in_month (2 decimals)
--   kpis.*                from kpi_forecast() over active KPIs;
--                         'achieved' is counted as on_track, 'no_data' in none.
--   shopping.planned_*    status = 'planned' only (wishlist excluded)
-- ---------------------------------------------------------------------

create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tz         text;
  v_today      date;
  v_ws         int;
  v_week_start date;
  v_month      date;
  v_next_month date;
  v_tasks      jsonb;
  v_time       jsonb;
  v_running    jsonb;
  v_spent      numeric;
  v_today_sp   numeric;
  v_budget     numeric;
  v_kpis       jsonb;
  v_shopping   jsonb;
  v_streak     jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;

  v_tz    := public.user_tz();
  v_today := (now() at time zone v_tz)::date;
  select p.week_starts_on into v_ws from public.profiles p where p.id = v_uid;
  v_ws         := coalesce(v_ws, 1);
  v_week_start := v_today - ((extract(dow from v_today)::int - v_ws + 7) % 7);
  v_month      := date_trunc('month', v_today)::date;
  v_next_month := (v_month + interval '1 month')::date;

  -- tasks
  select jsonb_build_object(
           'open',      count(*) filter (where t.status in ('todo', 'in_progress')),
           'overdue',   count(*) filter (where t.status in ('todo', 'in_progress') and t.due_date < v_today),
           'due_today', count(*) filter (where t.status in ('todo', 'in_progress') and t.due_date = v_today),
           'completed_today', count(*) filter (
              where t.status = 'completed' and (t.completed_at at time zone v_tz)::date = v_today),
           'completed_this_week', count(*) filter (
              where t.status = 'completed'
                and (t.completed_at at time zone v_tz)::date between v_week_start and v_today))
    into v_tasks
    from public.tasks t
   where t.user_id = v_uid;

  -- time (finished + running elapsed, attributed to the start day)
  select jsonb_build_object(
           'today_minutes', coalesce(round(sum(s.secs) filter (where s.d = v_today) / 60.0), 0)::int,
           'week_minutes',  coalesce(round(sum(s.secs) / 60.0), 0)::int)
    into v_time
    from (
      select (te.started_at at time zone v_tz)::date as d,
             coalesce(te.duration_seconds::numeric,
                      greatest(extract(epoch from now() - te.started_at), 0)) as secs
        from public.time_entries te
       where te.user_id = v_uid
         and te.started_at >= (v_week_start::timestamp at time zone v_tz)
    ) s
   where s.d between v_week_start and v_today;

  select jsonb_build_object(
           'entry',              to_jsonb(te.*),
           'task_title',         t.title,
           'elapsed_seconds',    e.secs,
           'task_total_seconds', case when te.task_id is null then e.secs
                                      else coalesce((select sum(x.duration_seconds)
                                                       from public.time_entries x
                                                      where x.user_id = v_uid
                                                        and x.task_id = te.task_id
                                                        and x.ended_at is not null), 0) + e.secs
                                 end)
    into v_running
    from public.time_entries te
    left join public.tasks t on t.id = te.task_id
   cross join lateral (
     select greatest(floor(extract(epoch from now() - te.started_at)), 0)::bigint as secs
   ) e
   where te.user_id = v_uid and te.ended_at is null
   order by te.started_at desc
   limit 1;

  -- money
  select coalesce(sum(e.amount), 0),
         coalesce(sum(e.amount) filter (where e.spent_on = v_today), 0)
    into v_spent, v_today_sp
    from public.expenses e
   where e.user_id = v_uid
     and e.spent_on >= v_month and e.spent_on < v_next_month;

  select b.amount into v_budget
    from public.budgets b
   where b.user_id = v_uid and b.category_id is null and b.effective_month <= v_month
   order by b.effective_month desc
   limit 1;

  -- KPIs
  select jsonb_build_object(
           'active',    count(*),
           'on_track',  count(*) filter (where k.status in ('on_track', 'achieved')),
           'at_risk',   count(*) filter (where k.status = 'at_risk'),
           'off_track', count(*) filter (where k.status = 'off_track'))
    into v_kpis
    from public.kpi_forecast(null) k;

  -- shopping
  select jsonb_build_object(
           'planned_count', count(*),
           'planned_total', coalesce(sum(s.total_price), 0))
    into v_shopping
    from public.shopping_items s
   where s.user_id = v_uid and s.status = 'planned';

  v_streak := public.streaks();

  return jsonb_build_object(
    'today', v_today,
    'tasks', v_tasks,
    'time',  v_time || jsonb_build_object('running', v_running),
    'money', jsonb_build_object(
               'month_spent',     v_spent,
               'month_budget',    v_budget,
               'month_remaining', v_budget - v_spent,
               'month_projected', round(v_spent / (v_today - v_month + 1) * (v_next_month - v_month), 2),
               'today_spent',     v_today_sp),
    'kpis',     v_kpis,
    'shopping', v_shopping,
    'streak',   jsonb_build_object('current', v_streak -> 'current', 'longest', v_streak -> 'longest'));
end;
$$;


-- ---------------------------------------------------------------------
-- 4. productivity_stats
--   completed_by_day     tasks completed per day (all days of the range, 0-filled)
--   minutes_by_day       finished time per start day (0-filled)
--   minutes_by_category  finished time in range by the task's category; entries
--                        without task/category -> {category_id:null,name:null}
--   completion_rate      of tasks CREATED in the range (cancelled excluded from
--                        the denominator), share now completed. 0..1, 4 dp; null if none.
--   on_time_rate         of tasks COMPLETED in the range that have a due_date,
--                        share completed on/before due_date. 0..1, 4 dp; null if none.
--   avg_cycle_hours      avg(completed_at - created_at) of tasks completed in the
--                        range, 1 dp; null if none.
--   busiest_weekday      0=Sun..6: most completed tasks, tie -> most minutes,
--                        tie -> smallest weekday; null when no activity at all.
-- ---------------------------------------------------------------------

create or replace function public.productivity_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_tz      text;
  v_lo      timestamptz;
  v_hi      timestamptz;
  v_result  jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from + 1 > 366 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  v_tz := public.user_tz();
  v_lo := p_from::timestamp at time zone v_tz;
  v_hi := (p_to + 1)::timestamp at time zone v_tz;

  with days as (
    select p_from + i as d from generate_series(0, p_to - p_from) i
  ),
  done as (
    select t.*, (t.completed_at at time zone v_tz)::date as d
      from public.tasks t
     where t.user_id = v_uid and t.status = 'completed'
       and t.completed_at >= v_lo and t.completed_at < v_hi
  ),
  created as (
    select t.status
      from public.tasks t
     where t.user_id = v_uid and t.status <> 'cancelled'
       and t.created_at >= v_lo and t.created_at < v_hi
  ),
  te as (
    select (x.started_at at time zone v_tz)::date as d, x.duration_seconds as secs, x.task_id
      from public.time_entries x
     where x.user_id = v_uid and x.ended_at is not null
       and x.started_at >= v_lo and x.started_at < v_hi
  ),
  per_day as (
    select dd.d,
           (select count(*) from done o where o.d = dd.d)::int                 as cnt,
           coalesce((select sum(e.secs) from te e where e.d = dd.d), 0)        as secs
      from days dd
  ),
  by_cat as (
    select c.id as category_id, c.name, c.color, sum(e.secs) as secs
      from te e
      left join public.tasks t      on t.id = e.task_id
      left join public.categories c on c.id = t.category_id
     group by c.id, c.name, c.color
  ),
  wd as (
    select extract(dow from p.d)::int as dow, sum(p.cnt) as cnt, sum(p.secs) as secs
      from per_day p
     group by 1
  )
  select jsonb_build_object(
    'completed_by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', p.d, 'count', p.cnt) order by p.d), '[]'::jsonb)
                           from per_day p),
    'minutes_by_day',   (select coalesce(jsonb_agg(jsonb_build_object('day', p.d, 'minutes', round(p.secs / 60.0)::int) order by p.d), '[]'::jsonb)
                           from per_day p),
    'minutes_by_category',
                        (select coalesce(jsonb_agg(jsonb_build_object(
                                   'category_id', b.category_id, 'name', b.name, 'color', b.color,
                                   'minutes', round(b.secs / 60.0)::int)
                                 order by b.secs desc, b.name nulls last), '[]'::jsonb)
                           from by_cat b),
    'completion_rate',  (select case when count(*) = 0 then null
                                     else round(count(*) filter (where c.status = 'completed')::numeric / count(*), 4) end
                           from created c),
    'on_time_rate',     (select case when count(*) = 0 then null
                                     else round(count(*) filter (where o.d <= o.due_date)::numeric / count(*), 4) end
                           from done o where o.due_date is not null),
    'avg_cycle_hours',  (select round((avg(extract(epoch from o.completed_at - o.created_at)) / 3600.0)::numeric, 1)
                           from done o),
    'busiest_weekday',  (select w.dow from wd w where w.cnt > 0 or w.secs > 0
                          order by w.cnt desc, w.secs desc, w.dow limit 1))
    into v_result;

  return v_result;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------

revoke execute on function
  public.kpi_forecast(uuid),
  public.dashboard_summary(),
  public.productivity_stats(date, date),
  public.streaks()
  from public, anon;

grant execute on function
  public.kpi_forecast(uuid),
  public.dashboard_summary(),
  public.productivity_stats(date, date),
  public.streaks()
  to authenticated;
