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
