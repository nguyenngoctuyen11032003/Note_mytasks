-- recurrence_next_date is declared IMMUTABLE, but used date_trunc('month', <date>),
-- which implicitly casts date -> timestamptz (depends on the session TimeZone, i.e.
-- only STABLE). Flagged by `supabase db lint`. Same results, now truly immutable:
-- date + interval yields timestamp WITHOUT time zone, and make_date is immutable.
-- Signature, return type and grants are unchanged.

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
