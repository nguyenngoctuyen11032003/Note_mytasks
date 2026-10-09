-- Integrity hardening from the adversarial SQL audit (all findings reproduced on a
-- local Supabase stack). Every statement is idempotent; nothing here rewrites data.
--
--   1. purchase_shopping_item: re-buying an item that already has a linked expense
--      created a SECOND expense (money counted twice). Now reuses the link.
--   2. Recurring tasks: reopen + re-complete on a later day (or with a NULL / overdue
--      due date) spawned a duplicate next occurrence, because the de-dup compared
--      against a "next date" recomputed from today. Now: never spawn while the series
--      already has another open (todo / in_progress) task.
--   3. time_entries rules (no overlap, not in the future, manual <= 24 h, a finished
--      entry cannot be reopened) were only enforced inside log_time; a plain
--      INSERT/UPDATE through the API bypassed them. Now a BEFORE trigger enforces them
--      for API callers (roles anon/authenticated). service_role / postgres (seed,
--      admin, migrations) are trusted, like RLS.
--      + update_time_entry RPC for the app's "edit entry" form.
--      + start_timer never opens a segment that overlaps a just-stopped one
--        (stop_timer stretches sub-second segments to 1 s, so their end can be <1 s
--        in the future).
--   4. Date columns accepted 'infinity' / year 5874897, which broke kpi_forecast,
--      focus_tasks, dashboard_summary, the kpi_progress view and recurring tasks.
--      CHECK 1900-01-01 .. 2999-12-31 (added NOT VALID, then validated when possible).
--   5. recurrence_next_date (callable over /rpc) could burn ~8 s of CPU on extreme
--      inputs: inputs are now bounded to the same 1900..2999 window.
--   6. focus_tasks resolved the user's timezone once PER ROW (2.4 s on 10k tasks):
--      resolved once per call now. Same output.
--   7. timer_current.task_total_seconds was NULL for a timer without a task while
--      dashboard_summary.time.running reported the elapsed seconds: now both report
--      the elapsed seconds.
--   8. Oversized tags (5 MB) failed with a 500 from the GIN index: each tag is now
--      limited to 1..100 characters (tasks.tags and notes.tags).
--
-- Not changed on purpose: start_timer / purchase_shopping_item keep their SQLSTATEs
-- (P0002 / 22023) because supabase/tests/database.test.sql asserts them; the service
-- layer maps them by message.


-- ---------------------------------------------------------------------
-- 1. purchase_shopping_item: no second expense
-- ---------------------------------------------------------------------
create or replace function public.purchase_shopping_item(
  p_item_id        uuid,
  p_purchased_on   date    default null,
  p_payment_method text    default 'cash',
  p_create_expense boolean default true
)
returns public.shopping_items
language plpgsql
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_item       public.shopping_items;
  v_date       date := coalesce(p_purchased_on, public.user_today());
  v_expense_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;

  select * into v_item
    from public.shopping_items s
   where s.id = p_item_id and s.user_id = v_uid
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'shopping item not found';
  end if;
  if v_item.status = 'purchased' then
    raise exception using errcode = '22023', message = 'item is already purchased';
  end if;

  -- An expense still linked from an earlier purchase is reused, never duplicated.
  if v_item.expense_id is not null
     and exists (select 1 from public.expenses e where e.id = v_item.expense_id) then
    v_expense_id := v_item.expense_id;
  elsif p_create_expense and v_item.total_price > 0 then
    insert into public.expenses (user_id, amount, category_id, description, spent_on, payment_method, note)
    values (v_uid, v_item.total_price, v_item.category_id, v_item.name, v_date,
            coalesce(p_payment_method, 'cash'),
            format('Mua từ danh sách mua sắm (%s x %s)', v_item.quantity, v_item.unit_price))
    returning id into v_expense_id;
  end if;

  update public.shopping_items
     set status = 'purchased',
         purchased_on = v_date,
         expense_id = coalesce(v_expense_id, expense_id)
   where id = v_item.id
  returning * into v_item;

  return v_item;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Recurring tasks: one open occurrence per series
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

  -- The series already has its next open occurrence (e.g. this task was reopened
  -- and completed again): nothing to spawn, whatever "today" is now.
  if exists (
    select 1
      from public.tasks t
     where t.user_id = new.user_id
       and t.id <> new.id
       and (t.id = v_root or t.recurrence_parent_id = v_root)
       and t.status in ('todo', 'in_progress')
  ) then
    return null;
  end if;

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


-- ---------------------------------------------------------------------
-- 3. time_entries rules, enforced for API callers
-- ---------------------------------------------------------------------
create or replace function public.time_entries_enforce_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Trusted roles (seed, admin, migrations) are not restricted, like RLS.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- ended_at <= started_at: let the table CHECK report it (check_violation).
  if new.ended_at is not null and new.ended_at <= new.started_at then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.ended_at is not null and new.ended_at is null then
      raise exception using errcode = 'P0001', message = 'invalid_input',
        detail = 'a finished time entry cannot be reopened';
    end if;
    if new.started_at is not distinct from old.started_at
       and new.ended_at is not distinct from old.ended_at
       and new.user_id = old.user_id then
      return new;                                   -- times untouched (e.g. description edit)
    end if;
  end if;

  -- 60 s tolerance for client clock skew.
  if new.started_at > now() + interval '60 seconds'
     or new.ended_at > now() + interval '60 seconds' then
    raise exception using errcode = 'P0001', message = 'invalid_input',
      detail = 'time entries cannot be in the future';
  end if;

  if new.source = 'manual' and new.ended_at - new.started_at > interval '24 hours' then
    raise exception using errcode = 'P0001', message = 'invalid_input',
      detail = 'a manual entry is limited to 24 hours';
  end if;

  perform public.lock_user_time(new.user_id);

  -- A second RUNNING entry is reported by the unique index (unique_violation), so
  -- running-vs-running is left to it; every other overlap is rejected here.
  if exists (
    select 1
      from public.time_entries x
     where x.user_id = new.user_id
       and x.id <> new.id
       and (new.ended_at is not null or x.ended_at is not null)
       and x.started_at < coalesce(new.ended_at, 'infinity'::timestamptz)
       and coalesce(x.ended_at, 'infinity'::timestamptz) > new.started_at
  ) then
    raise exception using errcode = 'P0001', message = 'time_overlap';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_time_entries_enforce_rules on public.time_entries;
create trigger trg_time_entries_enforce_rules
  before insert or update of started_at, ended_at, user_id on public.time_entries
  for each row execute function public.time_entries_enforce_rules();

-- start_timer: open the new segment no earlier than the end of any just-stopped
-- segment (stop_timer may stretch a sub-second segment up to 1 s into the future).
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
  v_start  timestamptz;
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

  select greatest(now(), coalesce(max(te.ended_at), now())) into v_start
    from public.time_entries te
   where te.user_id = v_uid
     and te.ended_at > now();

  begin
    insert into public.time_entries (user_id, task_id, description, started_at, source)
    values (v_uid, p_task_id, v_desc, v_start, 'timer')
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

-- Edit a time entry with the same rules as log_time. NULL parameter = unchanged.
-- (Moving an entry off its task is done by deleting / re-logging it.)
create or replace function public.update_time_entry(
  p_id          uuid,
  p_task_id     uuid        default null,
  p_started_at  timestamptz default null,
  p_ended_at    timestamptz default null,
  p_description text        default null
)
returns public.time_entries
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old public.time_entries;
  v_row public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_id is null or char_length(p_description) > 500 then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  perform public.lock_user_time(v_uid);

  select * into v_old
    from public.time_entries te
   where te.id = p_id and te.user_id = v_uid
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if p_task_id is not null
     and not exists (select 1 from public.tasks t where t.id = p_task_id and t.user_id = v_uid) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if coalesce(p_ended_at, v_old.ended_at) is not null
     and coalesce(p_ended_at, v_old.ended_at) <= coalesce(p_started_at, v_old.started_at) then
    raise exception using errcode = 'P0001', message = 'invalid_input';
  end if;

  update public.time_entries te
     set task_id     = coalesce(p_task_id, te.task_id),
         started_at  = coalesce(p_started_at, te.started_at),
         ended_at    = coalesce(p_ended_at, te.ended_at),
         description = case when p_description is null then te.description
                            else nullif(btrim(p_description), '') end
   where te.id = p_id
  returning te.* into v_row;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. Finite, sane calendar dates
-- ---------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('tasks',          'due_date',        'tasks_due_date_range'),
      ('kpis',           'start_date',      'kpis_start_date_range'),
      ('kpis',           'end_date',        'kpis_end_date_range'),
      ('kpi_records',    'recorded_on',     'kpi_records_recorded_on_range'),
      ('expenses',       'spent_on',        'expenses_spent_on_range'),
      ('shopping_items', 'purchased_on',    'shopping_items_purchased_on_range'),
      ('budgets',        'effective_month', 'budgets_effective_month_range')
    ) v(tbl, col, con)
  loop
    if not exists (select 1 from pg_constraint
                    where conname = c.con and conrelid = format('public.%I', c.tbl)::regclass) then
      execute format(
        'alter table public.%I add constraint %I check (%I is null or %I between date %L and date %L) not valid',
        c.tbl, c.con, c.col, c.col, '1900-01-01', '2999-12-31');
    end if;
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, c.con);
    exception when check_violation then
      raise notice '% left NOT VALID: existing rows violate it', c.con;
    end;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. recurrence_next_date: bounded inputs
-- ---------------------------------------------------------------------
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
  -- Same window as the date-column CHECKs: bounds the loop below (callable via /rpc).
  if p_from not between date '1900-01-01' and date '2999-12-31'
     or (p_today is not null and p_today not between date '1900-01-01' and date '2999-12-31') then
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
-- 6. focus_tasks: timezone resolved once per call
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
  v_tz    text    := public.user_tz();
  v_today date    := (now() at time zone v_tz)::date;
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
             (t.estimated_minutes > 0 and t.estimated_minutes <= 30)     as quick,
             (v_today - (t.created_at at time zone v_tz)::date > 14)     as stale
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
-- 7. timer_current: task_total_seconds = elapsed for a timer without a task
-- ---------------------------------------------------------------------
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
             case when te.task_id is null then e.secs
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


-- ---------------------------------------------------------------------
-- 8. Tag length (each tag 1..100 characters)
-- ---------------------------------------------------------------------
create or replace function public.tags_valid(p_tags text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_tags is null
      or not exists (select 1 from pg_catalog.unnest(p_tags) tag
                      where tag is null or char_length(tag) not between 1 and 100);
$$;

do $$
declare
  c record;
begin
  for c in
    select * from (values ('tasks', 'tasks_tags_valid'), ('notes', 'notes_tags_valid')) v(tbl, con)
  loop
    if to_regclass(format('public.%I', c.tbl)) is null then
      continue;
    end if;
    if not exists (select 1 from pg_constraint
                    where conname = c.con and conrelid = format('public.%I', c.tbl)::regclass) then
      execute format('alter table public.%I add constraint %I check (public.tags_valid(tags)) not valid',
                     c.tbl, c.con);
    end if;
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, c.con);
    exception when check_violation then
      raise notice '% left NOT VALID: existing rows violate it', c.con;
    end;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke execute on function public.time_entries_enforce_rules()   from public, anon, authenticated;
revoke execute on function public.update_time_entry(uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.update_time_entry(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
-- tags_valid runs inside CHECK constraints as the writing role.
revoke execute on function public.tags_valid(text[])              from public, anon;
grant  execute on function public.tags_valid(text[])              to authenticated, service_role;
