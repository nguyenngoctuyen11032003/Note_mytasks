-- =====================================================================
-- Personal Management Dashboard — business logic layer
--
--   1. Integrity rules the first migration left to the app
--      (category kind, profile timezone, shopping purchase date).
--   2. kpi_progress view (progress %, days left).
--   3. RPC functions for the pages: dashboard, budgets, reports, timer,
--      shopping -> expense.
--
-- Every RPC is SECURITY INVOKER: it runs as the signed-in user, so RLS still
-- decides which rows are visible. The explicit `user_id = auth.uid()` filters
-- are there for index usage, not for security.
-- Dates: a "day" is always the calendar day in profiles.timezone.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------

create or replace function public.current_user_timezone()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select p.timezone from public.profiles p where p.id = (select auth.uid())),
    'Asia/Ho_Chi_Minh');
$$;

create or replace function public.user_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone public.current_user_timezone())::date;
$$;

-- Shared guard for report ranges: both bounds required, ordered, at most ~1 year.
create or replace function public.assert_date_range(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null then
    raise exception using errcode = '22023', message = 'date range requires both p_from and p_to';
  end if;
  if p_from > p_to then
    raise exception using errcode = '22023', message = 'p_from must be on or before p_to';
  end if;
  if p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'date range is limited to 366 days';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Integrity rules
-- ---------------------------------------------------------------------

-- 2a. profiles.timezone must be a real IANA zone, otherwise every
--     "per day" calculation would fail later with a confusing error.
create or replace function public.profiles_validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using errcode = '23514', message = format('unknown timezone: %s', new.timezone);
  end if;
  return new;
end;
$$;

create trigger trg_profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.profiles_validate_timezone();

-- 2b. Category kind must match the referencing table:
--     tasks -> 'task'; expenses / budgets / shopping_items -> 'expense'.
--     (The composite FK already guarantees the category belongs to the same user.)
create or replace function public.enforce_category_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_expected text := tg_argv[0];
  v_kind     text;
begin
  if new.category_id is null then
    return new;
  end if;
  select c.kind into v_kind
    from public.categories c
   where c.id = new.category_id and c.user_id = new.user_id;
  if v_kind is null then
    raise exception using errcode = '23503', message = 'category not found';
  end if;
  if v_kind <> v_expected then
    raise exception using errcode = '23514',
      message = format('%s requires a category of kind ''%s'' (got ''%s'')', tg_table_name, v_expected, v_kind);
  end if;
  return new;
end;
$$;

create trigger trg_tasks_category_kind
  before insert or update of category_id on public.tasks
  for each row execute function public.enforce_category_kind('task');
create trigger trg_expenses_category_kind
  before insert or update of category_id on public.expenses
  for each row execute function public.enforce_category_kind('expense');
create trigger trg_budgets_category_kind
  before insert or update of category_id on public.budgets
  for each row execute function public.enforce_category_kind('expense');
create trigger trg_shopping_items_category_kind
  before insert or update of category_id on public.shopping_items
  for each row execute function public.enforce_category_kind('expense');

-- A category that is already in use cannot switch kind (it would silently
-- break the rule above for existing rows).
create or replace function public.categories_lock_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind and (
       exists (select 1 from public.tasks          where category_id = old.id)
    or exists (select 1 from public.expenses       where category_id = old.id)
    or exists (select 1 from public.budgets        where category_id = old.id)
    or exists (select 1 from public.shopping_items where category_id = old.id)
  ) then
    raise exception using errcode = '23514', message = 'cannot change kind of a category that is in use';
  end if;
  return new;
end;
$$;

create trigger trg_categories_lock_kind
  before update of kind on public.categories
  for each row execute function public.categories_lock_kind();

-- 2c. shopping_items.purchased_on belongs to the 'purchased' state only.
--     Marking purchased without a date defaults to the user's today;
--     leaving the purchased state clears the date.
create or replace function public.shopping_items_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'purchased' then
    new.purchased_on := coalesce(new.purchased_on, public.user_today());
  else
    new.purchased_on := null;
  end if;
  return new;
end;
$$;

create trigger trg_shopping_items_normalize
  before insert or update on public.shopping_items
  for each row execute function public.shopping_items_normalize();


-- ---------------------------------------------------------------------
-- 3. kpi_progress view
--    security_invoker -> the caller's RLS on kpis/kpi_records applies.
-- ---------------------------------------------------------------------

create view public.kpi_progress
with (security_invoker = true)
as
select
  k.id,
  k.user_id,
  k.name,
  k.description,
  k.unit,
  k.target_value,
  k.current_value,
  k.start_date,
  k.end_date,
  k.status,
  round(k.current_value / k.target_value * 100, 1)                         as progress_percent,
  case when k.end_date is not null then k.end_date - public.user_today() end as days_left,
  (select max(r.recorded_on) from public.kpi_records r where r.kpi_id = k.id) as last_recorded_on,
  (select count(*)           from public.kpi_records r where r.kpi_id = k.id) as record_count,
  k.created_at,
  k.updated_at
from public.kpis k;


-- ---------------------------------------------------------------------
-- 4. Dashboard
-- ---------------------------------------------------------------------

create or replace function public.get_dashboard_summary()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tz         text := public.current_user_timezone();
  v_today      date := (now() at time zone v_tz)::date;
  v_ws         smallint;
  v_week_start date;
  v_month      date := date_trunc('month', v_today)::date;
  v_prev_month date := (date_trunc('month', v_today) - interval '1 month')::date;
  v_tasks      jsonb;
  v_time       jsonb;
  v_running    jsonb;
  v_money      jsonb;
  v_kpis       jsonb;
  v_shopping   jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;

  select p.week_starts_on into v_ws from public.profiles p where p.id = v_uid;
  v_week_start := v_today - ((extract(dow from v_today)::int - coalesce(v_ws, 1) + 7) % 7);

  select jsonb_build_object(
           'open',                count(*) filter (where t.status in ('todo', 'in_progress')),
           'in_progress',         count(*) filter (where t.status = 'in_progress'),
           'due_today',           count(*) filter (where t.status in ('todo', 'in_progress') and t.due_date = v_today),
           'overdue',             count(*) filter (where t.status in ('todo', 'in_progress') and t.due_date < v_today),
           'completed_today',     count(*) filter (where (t.completed_at at time zone v_tz)::date = v_today),
           'completed_this_week', count(*) filter (where (t.completed_at at time zone v_tz)::date >= v_week_start),
           'completed_this_month',count(*) filter (where (t.completed_at at time zone v_tz)::date >= v_month))
    into v_tasks
    from public.tasks t
   where t.user_id = v_uid;

  -- running segments count up to "now" so the numbers move with the timer
  select jsonb_build_object(
           'today_minutes', coalesce(round(sum(secs) filter (where day = v_today) / 60.0), 0),
           'week_minutes',  coalesce(round(sum(secs) filter (where day >= v_week_start) / 60.0), 0))
    into v_time
    from (
      select (te.started_at at time zone v_tz)::date as day,
             coalesce(te.duration_seconds, extract(epoch from now() - te.started_at)) as secs
        from public.time_entries te
       where te.user_id = v_uid
         and te.started_at >= ((v_week_start - 1)::timestamp at time zone v_tz)
    ) s
   where day >= v_week_start;

  select jsonb_build_object(
           'id', te.id, 'task_id', te.task_id, 'task_title', t.title,
           'description', te.description, 'started_at', te.started_at)
    into v_running
    from public.time_entries te
    left join public.tasks t on t.id = te.task_id
   where te.user_id = v_uid and te.ended_at is null;

  select jsonb_build_object(
           'month',            v_month,
           'month_total',      coalesce(sum(e.amount) filter (where e.spent_on >= v_month), 0),
           'month_count',      count(*)             filter (where e.spent_on >= v_month),
           'today_total',      coalesce(sum(e.amount) filter (where e.spent_on = v_today), 0),
           'prev_month_total', coalesce(sum(e.amount) filter (where e.spent_on < v_month), 0),
           'budget_total',     (select b.amount from public.budgets b
                                 where b.user_id = v_uid and b.category_id is null
                                   and b.effective_month <= v_month
                                 order by b.effective_month desc limit 1))
    into v_money
    from public.expenses e
   where e.user_id = v_uid
     and e.spent_on >= v_prev_month
     and e.spent_on <= v_today;

  select jsonb_build_object(
           'active',               count(*) filter (where k.status = 'active'),
           'completed',            count(*) filter (where k.status = 'completed'),
           'avg_progress_percent', coalesce(round(avg(least(k.current_value / k.target_value * 100, 100))
                                                  filter (where k.status = 'active'), 1), 0))
    into v_kpis
    from public.kpis k
   where k.user_id = v_uid;

  select jsonb_build_object(
           'wishlist',      count(*) filter (where s.status = 'wishlist'),
           'planned',       count(*) filter (where s.status = 'planned'),
           'planned_total', coalesce(sum(s.total_price) filter (where s.status = 'planned'), 0),
           'must_buy',      count(*) filter (where s.status in ('wishlist', 'planned') and s.priority = 'must_buy'))
    into v_shopping
    from public.shopping_items s
   where s.user_id = v_uid;

  return jsonb_build_object(
    'today',      v_today,
    'week_start', v_week_start,
    'timezone',   v_tz,
    'tasks',      v_tasks,
    'time',       v_time || jsonb_build_object('running', v_running),
    'expenses',   v_money,
    'kpis',       v_kpis,
    'shopping',   v_shopping);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Budgets (carry-forward resolution)
--    The budget for month M = row with the greatest effective_month <= M,
--    per category (NULL category = overall). One row per category that has
--    a budget or spending in M, plus the overall row (category_id NULL).
-- ---------------------------------------------------------------------

create or replace function public.get_budget_status(p_month date default null)
returns table (
  category_id   uuid,
  category_name text,
  color         text,
  budget_amount numeric,
  spent         numeric,
  remaining     numeric,
  percent_used  numeric
)
language sql
stable
set search_path = ''
as $$
  with m as (
    select date_trunc('month', coalesce(p_month, public.user_today()))::date as month_start,
           (date_trunc('month', coalesce(p_month, public.user_today())) + interval '1 month')::date as month_end
  ),
  b as (
    select distinct on (bg.category_id) bg.category_id, bg.amount
      from public.budgets bg, m
     where bg.user_id = (select auth.uid())
       and bg.effective_month <= m.month_start
     order by bg.category_id, bg.effective_month desc
  ),
  sp as (
    select e.category_id, sum(e.amount) as total
      from public.expenses e, m
     where e.user_id = (select auth.uid())
       and e.spent_on >= m.month_start and e.spent_on < m.month_end
     group by e.category_id
  ),
  all_rows as (
    select null::uuid as category_id, null::text as category_name, null::text as color,
           (select b.amount from b where b.category_id is null) as budget_amount,
           coalesce((select sum(sp.total) from sp), 0) as spent,
           -1 as sort_order
    union all
    select c.id, c.name, c.color, b.amount, coalesce(sp.total, 0), c.sort_order
      from public.categories c
      left join b  on b.category_id  = c.id
      left join sp on sp.category_id = c.id
     where c.user_id = (select auth.uid())
       and c.kind = 'expense'
       and (b.amount is not null or sp.total is not null)
  )
  select r.category_id, r.category_name, r.color, r.budget_amount, r.spent,
         r.budget_amount - r.spent,
         case when r.budget_amount > 0 then round(r.spent / r.budget_amount * 100, 1) end
    from all_rows r
   order by r.sort_order, r.category_name;
$$;


-- ---------------------------------------------------------------------
-- 6. Reports
-- ---------------------------------------------------------------------

create or replace function public.get_expense_by_category(p_from date, p_to date)
returns table (
  category_id   uuid,
  category_name text,
  color         text,
  total         numeric,
  tx_count      bigint,
  share_percent numeric
)
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.assert_date_range(p_from, p_to);
  return query
    with s as (
      select e.category_id, sum(e.amount) as total, count(*) as tx_count
        from public.expenses e
       where e.user_id = (select auth.uid())
         and e.spent_on between p_from and p_to
       group by e.category_id
    )
    select s.category_id, c.name, c.color, s.total, s.tx_count,
           round(s.total / nullif(sum(s.total) over (), 0) * 100, 1)
      from s
      left join public.categories c on c.id = s.category_id
     order by s.total desc;
end;
$$;

create or replace function public.get_daily_expenses(p_from date, p_to date)
returns table (day date, total numeric, tx_count bigint)
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.assert_date_range(p_from, p_to);
  return query
    select d::date, coalesce(sum(e.amount), 0), count(e.id)
      from generate_series(p_from, p_to, interval '1 day') d
      left join public.expenses e
        on e.user_id = (select auth.uid()) and e.spent_on = d::date
     group by d
     order by d;
end;
$$;

create or replace function public.get_task_stats(p_from date, p_to date)
returns table (day date, created_count bigint, completed_count bigint)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := public.current_user_timezone();
begin
  perform public.assert_date_range(p_from, p_to);
  return query
    with t as (
      select (x.created_at at time zone v_tz)::date   as created_day,
             (x.completed_at at time zone v_tz)::date as completed_day
        from public.tasks x
       where x.user_id = (select auth.uid())
    )
    select d::date,
           (select count(*) from t where t.created_day   = d::date),
           (select count(*) from t where t.completed_day = d::date)
      from generate_series(p_from, p_to, interval '1 day') d
     order by d;
end;
$$;

-- Finished segments only (a running timer is shown live by the dashboard).
create or replace function public.get_time_by_day(p_from date, p_to date)
returns table (day date, minutes integer, entry_count bigint)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := public.current_user_timezone();
begin
  perform public.assert_date_range(p_from, p_to);
  return query
    with te as (
      select (x.started_at at time zone v_tz)::date as day, x.duration_seconds
        from public.time_entries x
       where x.user_id = (select auth.uid())
         and x.ended_at is not null
         and x.started_at >= (p_from::timestamp at time zone v_tz)
         and x.started_at <  ((p_to + 1)::timestamp at time zone v_tz)
    )
    select d::date,
           coalesce(round(sum(te.duration_seconds) / 60.0), 0)::integer,
           count(te.day)
      from generate_series(p_from, p_to, interval '1 day') d
      left join te on te.day = d::date
     group by d
     order by d;
end;
$$;

-- Time per task category; category_id NULL = entries without a task or
-- whose task has no category.
create or replace function public.get_time_by_category(p_from date, p_to date)
returns table (category_id uuid, category_name text, color text, minutes integer, share_percent numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := public.current_user_timezone();
begin
  perform public.assert_date_range(p_from, p_to);
  return query
    with s as (
      select t.category_id, sum(x.duration_seconds) as secs
        from public.time_entries x
        left join public.tasks t on t.id = x.task_id
       where x.user_id = (select auth.uid())
         and x.ended_at is not null
         and x.started_at >= (p_from::timestamp at time zone v_tz)
         and x.started_at <  ((p_to + 1)::timestamp at time zone v_tz)
       group by t.category_id
    )
    select s.category_id, c.name, c.color,
           round(s.secs / 60.0)::integer,
           round(s.secs / nullif(sum(s.secs) over (), 0) * 100, 1)
      from s
      left join public.categories c on c.id = s.category_id
     order by s.secs desc;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. Timer
--    start_timer: closes any running segment, opens a new one, and moves a
--    'todo' task to 'in_progress'. Closed tasks cannot be timed.
--    stop_timer: closes the running segment (returns NULL if none).
-- ---------------------------------------------------------------------

create or replace function public.start_timer(p_task_id uuid default null, p_description text default null)
returns public.time_entries
language plpgsql
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_status text;
  v_row    public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;

  if p_task_id is not null then
    select t.status into v_status from public.tasks t where t.id = p_task_id and t.user_id = v_uid;
    if v_status is null then
      raise exception using errcode = 'P0002', message = 'task not found';
    end if;
    if v_status in ('completed', 'cancelled') then
      raise exception using errcode = '22023', message = 'cannot start a timer on a closed task';
    end if;
  end if;

  update public.time_entries
     set ended_at = greatest(now(), started_at + interval '1 second')
   where user_id = v_uid and ended_at is null;

  insert into public.time_entries (user_id, task_id, description, source)
  values (v_uid, p_task_id, nullif(btrim(p_description), ''), 'timer')
  returning * into v_row;

  if v_status = 'todo' then
    update public.tasks set status = 'in_progress' where id = p_task_id;
  end if;

  return v_row;
end;
$$;

create or replace function public.stop_timer()
returns public.time_entries
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.time_entries;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;
  update public.time_entries
     set ended_at = greatest(now(), started_at + interval '1 second')
   where user_id = v_uid and ended_at is null
  returning * into v_row;
  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. Shopping -> expense
--    Marks an item purchased and (by default) records the money once, in
--    `expenses`, linked through shopping_items.expense_id. Atomic, so the
--    item can never be "purchased" with the expense half-written.
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

  if p_create_expense and v_item.total_price > 0 then
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
-- 9. Privileges
--    Supabase grants EXECUTE on new public functions to anon by default:
--    revoke it everywhere, then grant only what the signed-in app calls.
-- ---------------------------------------------------------------------

revoke execute on function
  public.current_user_timezone(),
  public.user_today(),
  public.assert_date_range(date, date),
  public.profiles_validate_timezone(),
  public.enforce_category_kind(),
  public.categories_lock_kind(),
  public.shopping_items_normalize(),
  public.get_dashboard_summary(),
  public.get_budget_status(date),
  public.get_expense_by_category(date, date),
  public.get_daily_expenses(date, date),
  public.get_task_stats(date, date),
  public.get_time_by_day(date, date),
  public.get_time_by_category(date, date),
  public.start_timer(uuid, text),
  public.stop_timer(),
  public.purchase_shopping_item(uuid, date, text, boolean)
  from public, anon;

-- Trigger functions are never called directly.
revoke execute on function
  public.profiles_validate_timezone(),
  public.enforce_category_kind(),
  public.categories_lock_kind(),
  public.shopping_items_normalize()
  from authenticated;

grant execute on function
  public.current_user_timezone(),
  public.user_today(),
  public.assert_date_range(date, date),
  public.get_dashboard_summary(),
  public.get_budget_status(date),
  public.get_expense_by_category(date, date),
  public.get_daily_expenses(date, date),
  public.get_task_stats(date, date),
  public.get_time_by_day(date, date),
  public.get_time_by_category(date, date),
  public.start_timer(uuid, text),
  public.stop_timer(),
  public.purchase_shopping_item(uuid, date, text, boolean)
  to authenticated;

revoke all on public.kpi_progress from anon, authenticated;
grant select on public.kpi_progress to authenticated;
