-- Initial Note_mytasks database schema and security policies.
-- Canonical schema source: this migration and subsequent ordered migrations.

-- =====================================================================
-- Personal Management Dashboard — part 1: tables, functions, triggers
--
-- Applied by `supabase db push` in filename order. Demo data (seed.sql) is never part of a migration.
-- Target: Supabase / PostgreSQL 15+  (needs ON DELETE SET NULL (column_list), PG15)
--
-- Design rules
--   * Every user-owned row carries user_id (default auth.uid()) -> RLS in part 2 below.
--   * Cross-table references are COMPOSITE foreign keys (child_id, user_id) ->
--     parent(id, user_id). Foreign-key checks bypass RLS, so a plain FK would let
--     user A attach a row to user B's task/category if A knew the UUID. The composite
--     FK makes that impossible at the database level.
--   * Enums are `text + CHECK` (not CREATE TYPE): cheaper to evolve with migrations.
--   * `date` = a calendar day in the user's own timezone; `timestamptz` = a real instant.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Shared helpers
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 1. profiles  (1:1 with auth.users; profiles.id IS the user id)
--    Deviation from "every table has user_id": a separate user_id column would
--    just duplicate id.
-- ---------------------------------------------------------------------

create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  display_name   text check (char_length(display_name) <= 80),
  avatar_url     text,
  currency       char(3)  not null default 'VND' check (currency ~ '^[A-Z]{3}$'),
  locale         text     not null default 'vi-VN',
  timezone       text     not null default 'Asia/Ho_Chi_Minh',
  week_starts_on smallint not null default 1 check (week_starts_on between 0 and 6), -- 0=Sun, 1=Mon
  theme          text     not null default 'system' check (theme in ('light', 'dark', 'system')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 2. categories  (per-user, editable; seeded with defaults at sign-up)
--    kind = 'task'    -> used by tasks.category_id
--    kind = 'expense' -> used by expenses / budgets / shopping_items
--    (kind match is enforced by the app; not worth a trigger.)
-- ---------------------------------------------------------------------

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('task', 'expense')),
  name       text not null check (char_length(btrim(name)) between 1 and 50),
  color      text check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)                       -- target for composite FKs
);

create unique index categories_user_kind_name_uq
  on public.categories (user_id, kind, lower(name));

create trigger trg_categories_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- Default categories, created for every new user (called from handle_new_user).
create or replace function public.seed_default_categories(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.categories (user_id, kind, name, color, sort_order, is_default)
  values
    -- expense categories (from the product spec)
    (p_user_id, 'expense', 'Ăn uống',   '#E5793B', 10, true),
    (p_user_id, 'expense', 'Đi lại',    '#3B82C4', 20, true),
    (p_user_id, 'expense', 'Nhà ở',     '#7C6BC4', 30, true),
    (p_user_id, 'expense', 'Mua sắm',   '#C45B8E', 40, true),
    (p_user_id, 'expense', 'Giải trí',  '#D4A72C', 50, true),
    (p_user_id, 'expense', 'Công nghệ', '#2FA4A9', 60, true),
    (p_user_id, 'expense', 'Học tập',   '#4F9D5D', 70, true),
    (p_user_id, 'expense', 'Sức khỏe',  '#D9534F', 80, true),
    (p_user_id, 'expense', 'Khác',      '#8A8F98', 90, true),
    -- task categories
    (p_user_id, 'task',    'Công việc', '#3B82C4', 10, true),
    (p_user_id, 'task',    'Cá nhân',   '#7C6BC4', 20, true),
    (p_user_id, 'task',    'Học tập',   '#4F9D5D', 30, true),
    (p_user_id, 'task',    'Sức khỏe',  '#D9534F', 40, true),
    (p_user_id, 'task',    'Khác',      '#8A8F98', 50, true)
  on conflict do nothing;
$$;

-- Sign-up hook: create profile + default categories.
-- SECURITY DEFINER because it writes while no authenticated session exists yet.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    -- left(): an over-long name must not make sign-up fail on the CHECK constraint
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                  split_part(new.email, '@', 1)), 80)
  );
  perform public.seed_default_categories(new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- 3. tasks
-- ---------------------------------------------------------------------

create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  description       text check (char_length(description) <= 5000),
  status            text not null default 'todo'
                      check (status in ('todo', 'in_progress', 'completed', 'cancelled')),
  priority          text not null default 'medium'
                      check (priority in ('low', 'medium', 'high', 'urgent')),
  category_id       uuid,
  tags              text[] not null default '{}' check (cardinality(tags) <= 20),
  due_date          date,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes >= 0),
  -- Cached SUM of time_entries (maintained by trigger below). Never edit directly.
  actual_minutes    integer not null default 0 check (actual_minutes >= 0),
  -- Set/cleared by trigger when status enters/leaves 'completed'. Drives the
  -- "tasks completed per day/week" charts.
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, user_id),
  foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id),
  check ((status = 'completed') = (completed_at is not null))
);

create index tasks_user_status_due_idx  on public.tasks (user_id, status, due_date);
create index tasks_user_created_idx     on public.tasks (user_id, created_at desc);
create index tasks_user_completed_idx   on public.tasks (user_id, completed_at) where completed_at is not null;
create index tasks_user_category_idx    on public.tasks (user_id, category_id);
create index tasks_tags_idx             on public.tasks using gin (tags);

create or replace function public.tasks_set_completed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'completed' then
    -- keep the original timestamp if the task was already completed
    if tg_op = 'UPDATE' and old.status = 'completed' then
      new.completed_at := old.completed_at;
    else
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;       -- reopened / cancelled
  end if;
  return new;
end;
$$;

create trigger trg_tasks_completed_at
  before insert or update on public.tasks
  for each row execute function public.tasks_set_completed_at();

create trigger trg_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 4. time_entries
--    A timer session is a list of *segments*:
--      Start  -> insert segment (ended_at null)
--      Pause  -> set ended_at on the running segment
--      Resume -> insert a new segment for the same task
--      Stop   -> same as Pause (the UI simply doesn't offer Resume afterwards)
--    Totals are plain SUMs, no pause arithmetic. Manual entries have both timestamps.
-- ---------------------------------------------------------------------

create table public.time_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id          uuid,
  description      text check (char_length(description) <= 500),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,                -- null = timer currently running
  duration_seconds integer generated always as (
                     case when ended_at is null then null
                          else extract(epoch from (ended_at - started_at))::integer end
                   ) stored,
  source           text not null default 'timer' check (source in ('timer', 'manual')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  foreign key (task_id, user_id)
    references public.tasks (id, user_id) on delete set null (task_id)  -- keep the time record
);

-- At most ONE running timer per user — enforced by the database, not the UI.
create unique index time_entries_one_running_uq
  on public.time_entries (user_id) where ended_at is null;

create index time_entries_user_started_idx on public.time_entries (user_id, started_at desc);
create index time_entries_user_task_idx    on public.time_entries (user_id, task_id);

create trigger trg_time_entries_updated_at
  before update on public.time_entries
  for each row execute function public.set_updated_at();

-- Keep tasks.actual_minutes = SUM(finished time_entries) for the affected task(s).
create or replace function public.sync_task_actual_minutes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_task_id uuid;
begin
  for v_task_id in
    select distinct t
    from (
      select case when tg_op in ('UPDATE', 'DELETE') then old.task_id end as t
      union all
      select case when tg_op in ('INSERT', 'UPDATE') then new.task_id end
    ) s
    where t is not null
  loop
    update public.tasks
       set actual_minutes = coalesce((
             select round(sum(te.duration_seconds) / 60.0)::integer
               from public.time_entries te
              where te.task_id = v_task_id
           ), 0)
     where id = v_task_id;
  end loop;
  return null;
end;
$$;

create trigger trg_time_entries_sync_task
  after insert or update or delete on public.time_entries
  for each row execute function public.sync_task_actual_minutes();


-- ---------------------------------------------------------------------
-- 5. kpis + kpi_records
--    kpi_records are snapshots of the ACTUAL value at a date (not deltas);
--    kpis.current_value always mirrors the newest record (trigger below).
--    progress % = current_value / target_value  (computed in the app).
-- ---------------------------------------------------------------------

create table public.kpis (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text check (char_length(description) <= 2000),
  unit          text not null default '' check (char_length(unit) <= 20),
  target_value  numeric(18, 2) not null check (target_value > 0),   -- > 0: progress divides by it
  current_value numeric(18, 2) not null default 0,
  start_date    date not null default current_date,
  end_date      date,
  status        text not null default 'active'
                  check (status in ('active', 'completed', 'paused', 'archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, user_id),
  check (end_date is null or end_date >= start_date)
);

create index kpis_user_status_idx on public.kpis (user_id, status);

create trigger trg_kpis_updated_at
  before update on public.kpis
  for each row execute function public.set_updated_at();

create table public.kpi_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kpi_id      uuid not null,
  recorded_on date not null default current_date,
  value       numeric(18, 2) not null,
  note        text check (char_length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (kpi_id, user_id)
    references public.kpis (id, user_id) on delete cascade
);

create index kpi_records_kpi_date_idx on public.kpi_records (kpi_id, recorded_on desc, created_at desc);
create index kpi_records_user_date_idx on public.kpi_records (user_id, recorded_on desc);

create trigger trg_kpi_records_updated_at
  before update on public.kpi_records
  for each row execute function public.set_updated_at();

create or replace function public.sync_kpi_current_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kpi_id uuid := case when tg_op = 'DELETE' then old.kpi_id else new.kpi_id end;
begin
  update public.kpis k
     set current_value = coalesce((
           select r.value
             from public.kpi_records r
            where r.kpi_id = v_kpi_id
            order by r.recorded_on desc, r.created_at desc
            limit 1
         ), 0)
   where k.id = v_kpi_id;
  return null;
end;
$$;

create trigger trg_kpi_records_sync
  after insert or update or delete on public.kpi_records
  for each row execute function public.sync_kpi_current_value();


-- ---------------------------------------------------------------------
-- 6. expenses
-- ---------------------------------------------------------------------

create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  amount         numeric(14, 2) not null check (amount > 0),
  category_id    uuid,
  description    text check (char_length(description) <= 200),
  spent_on       date not null default current_date,
  payment_method text not null default 'cash'
                   check (payment_method in ('cash', 'bank', 'credit_card', 'e_wallet', 'other')),
  note           text check (char_length(note) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, user_id),
  foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id)
);

create index expenses_user_date_idx     on public.expenses (user_id, spent_on desc);
create index expenses_user_category_idx on public.expenses (user_id, category_id, spent_on);

create trigger trg_expenses_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 7. budgets
--    One row = "from this month onwards the budget is X" (carry-forward).
--    Budget that applies to month M = the row with the greatest effective_month <= M.
--    So the user sets it once and it keeps applying until they change it;
--    editing a later month never rewrites history.
--    category_id NULL = overall monthly budget.
-- ---------------------------------------------------------------------

create table public.budgets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  effective_month date not null check (extract(day from effective_month) = 1),  -- first day of month
  category_id     uuid,
  amount          numeric(14, 2) not null check (amount >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete cascade
);

-- NULLs are distinct in a normal UNIQUE, so "overall" and "per-category" need separate indexes.
create unique index budgets_overall_uq
  on public.budgets (user_id, effective_month) where category_id is null;
create unique index budgets_category_uq
  on public.budgets (user_id, effective_month, category_id) where category_id is not null;
create index budgets_user_category_idx on public.budgets (user_id, category_id, effective_month desc);

create trigger trg_budgets_updated_at
  before update on public.budgets
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 8. shopping_items
--    Planning layer, separate from expenses. Money is counted in `expenses` only;
--    when an item is bought the UI may create an expense and store its id in
--    expense_id. The dashboard's "Monthly Expenses" must never add shopping totals
--    on top of expenses (double counting).
-- ---------------------------------------------------------------------

create table public.shopping_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 200),
  category_id   uuid,
  unit_price    numeric(14, 2) not null default 0 check (unit_price >= 0),
  quantity      integer not null default 1 check (quantity between 1 and 9999),
  total_price   numeric(16, 2) generated always as (unit_price * quantity) stored,
  priority      text not null default 'medium'
                  check (priority in ('low', 'medium', 'high', 'must_buy')),
  status        text not null default 'wishlist'
                  check (status in ('wishlist', 'planned', 'purchased', 'cancelled')),
  purchased_on  date,
  url           text check (url is null or url ~* '^https?://'),
  note          text check (char_length(note) <= 1000),
  expense_id    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (status <> 'purchased' or purchased_on is not null),
  foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id),
  foreign key (expense_id, user_id)
    references public.expenses (id, user_id) on delete set null (expense_id)
);

create index shopping_user_status_idx    on public.shopping_items (user_id, status);
create index shopping_user_purchased_idx on public.shopping_items (user_id, purchased_on) where purchased_on is not null;
create index shopping_user_category_idx  on public.shopping_items (user_id, category_id);

create trigger trg_shopping_items_updated_at
  before update on public.shopping_items
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 9. activity_logs  (append-only feed for "Recent activity")
--    Written ONLY by the SECURITY DEFINER trigger below — clients get no INSERT
--    privilege, so the feed can't be forged or forgotten by a buggy UI.
--    No updated_at: rows are immutable. `title` is a snapshot so the entry still
--    reads correctly after the source row is deleted.
-- ---------------------------------------------------------------------

create table public.activity_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  entity_type text not null check (entity_type in ('task', 'expense', 'shopping_item', 'kpi')),
  entity_id   uuid not null,                     -- intentionally not a FK (survives deletes)
  action      text not null check (action in ('created', 'completed', 'updated')),
  title       text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index activity_logs_user_created_idx on public.activity_logs (user_id, created_at desc);

create or replace function public.log_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type   text;
  v_action text;
  v_id     uuid;
  v_title  text;
  v_meta   jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'tasks' then
    v_type := 'task'; v_id := new.id; v_title := new.title;
    if tg_op = 'INSERT' then
      v_action := 'created';
    elsif new.status = 'completed' and old.status is distinct from 'completed' then
      v_action := 'completed';
    else
      return null;                               -- ordinary edits are not logged
    end if;

  elsif tg_table_name = 'expenses' then
    if tg_op <> 'INSERT' then return null; end if;
    v_type := 'expense'; v_action := 'created'; v_id := new.id;
    v_title := coalesce(nullif(new.description, ''), 'Expense');
    v_meta := jsonb_build_object('amount', new.amount);

  elsif tg_table_name = 'shopping_items' then
    v_type := 'shopping_item'; v_id := new.id; v_title := new.name;
    if tg_op = 'INSERT' then
      v_action := 'created';
    elsif new.status = 'purchased' and old.status is distinct from 'purchased' then
      v_action := 'completed';
      v_meta := jsonb_build_object('total', new.total_price);
    else
      return null;
    end if;

  elsif tg_table_name = 'kpi_records' then
    if tg_op <> 'INSERT' then return null; end if;
    v_type := 'kpi'; v_action := 'updated'; v_id := new.kpi_id;
    select k.name into v_title from public.kpis k where k.id = new.kpi_id;
    v_meta := jsonb_build_object('value', new.value);

  else
    return null;
  end if;

  insert into public.activity_logs (user_id, entity_type, entity_id, action, title, metadata)
  values (new.user_id, v_type, v_id, v_action, coalesce(v_title, ''), v_meta);
  return null;
end;
$$;

create trigger trg_tasks_activity
  after insert or update on public.tasks
  for each row execute function public.log_activity();
create trigger trg_expenses_activity
  after insert on public.expenses
  for each row execute function public.log_activity();
create trigger trg_shopping_activity
  after insert or update on public.shopping_items
  for each row execute function public.log_activity();
create trigger trg_kpi_records_activity
  after insert on public.kpi_records
  for each row execute function public.log_activity();

-- Row-level security and grants.
-- =====================================================================
-- Personal Management Dashboard — part 2: grants + row-level security
--
-- Security model
--   1. Browser only ever holds the anon key + the signed-in user's JWT.
--   2. Table GRANTs say which operations a role may attempt at all.
--   3. RLS policies say which ROWS: user_id = auth.uid(), nothing else.
--   4. Composite FKs (part 1) stop cross-user references.
--   5. `anon` (not signed in) has no access to anything.
--   RLS is never disabled and never bypassed from the client.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Table privileges (defence in depth; Supabase grants ALL by default)
-- ---------------------------------------------------------------------

-- The API roles must be able to resolve objects in `public` at all. (On the
-- hosted project USAGE had been revoked; anon stays without it on purpose.)
grant usage on schema public to authenticated, service_role;

-- Scoped to this app's tables: the hosted database also holds another app's
-- objects in `public` (e.g. a TypeORM `migrations` table) that must not be touched.
revoke all on
  public.profiles, public.categories, public.tasks, public.time_entries, public.kpis,
  public.kpi_records, public.expenses, public.budgets, public.shopping_items,
  public.activity_logs
  from anon, authenticated;

grant select, insert, update, delete on
  public.categories, public.tasks, public.time_entries, public.kpis,
  public.kpi_records, public.expenses, public.budgets, public.shopping_items
  to authenticated;

grant select, update on public.profiles      to authenticated;  -- row is created by trigger; removed with auth user
grant select, delete on public.activity_logs to authenticated;  -- rows are created by trigger only

-- Helper / trigger functions must not be callable through the REST API (/rpc/...).
revoke execute on function public.seed_default_categories(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.log_activity()                from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. Enable RLS on every table
-- ---------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.categories     enable row level security;
alter table public.tasks          enable row level security;
alter table public.time_entries   enable row level security;
alter table public.kpis           enable row level security;
alter table public.kpi_records    enable row level security;
alter table public.expenses       enable row level security;
alter table public.budgets        enable row level security;
alter table public.shopping_items enable row level security;
alter table public.activity_logs  enable row level security;


-- ---------------------------------------------------------------------
-- 3. Policies
--    `(select auth.uid())` instead of `auth.uid()`: Postgres evaluates it once per
--    query instead of once per row (Supabase-recommended RLS performance pattern).
-- ---------------------------------------------------------------------

-- 3a. profiles: the row's id is the user id. No INSERT/DELETE policy on purpose.
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 3b. activity_logs: read + clear own feed. No INSERT/UPDATE policy: triggers write it.
drop policy if exists activity_logs_select_own on public.activity_logs;
drop policy if exists activity_logs_delete_own on public.activity_logs;

create policy activity_logs_select_own on public.activity_logs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy activity_logs_delete_own on public.activity_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- 3c. All other user-owned tables share one identical rule set.
--     Generated in a loop so the 8 tables cannot drift apart.
--     UPDATE has USING (which rows I may touch) AND WITH CHECK (what the row may
--     look like afterwards) so user_id can't be reassigned to someone else.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'tasks', 'time_entries', 'kpis',
    'kpi_records', 'expenses', 'budgets', 'shopping_items'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))',
      t || '_delete_own', t);
  end loop;
end;
$$;
