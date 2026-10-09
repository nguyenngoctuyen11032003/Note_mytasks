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
