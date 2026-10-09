-- =====================================================================
-- Database integration tests — Note_mytasks
--
-- Plain SQL + plpgsql ASSERT (no pgTAP needed). Run with `npm run db:test`,
-- which wraps this file in BEGIN ... ROLLBACK: nothing is left behind.
-- Each `ok:` notice is one passed check; the first failure aborts the run.
--
-- Users are simulated the way PostgREST does it: `set local role` +
-- request.jwt.claims, so auth.uid(), GRANTs and RLS behave as in production.
-- =====================================================================

-- Fixed ids so later blocks (running under other roles) can refer to them.
--   user A  00000000-0000-4000-8000-00000000000a
--   user B  00000000-0000-4000-8000-00000000000b
--   task 1  10000000-0000-4000-8000-000000000001   (A)
--   task 2  10000000-0000-4000-8000-000000000002   (A)
--   item 1  20000000-0000-4000-8000-000000000001   (A, shopping)
--   kpi 1   30000000-0000-4000-8000-000000000001   (A)


-- ---------------------------------------------------------------------
-- 0. Sign-up trigger (as postgres)
-- ---------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'test-a@example.com', '{"display_name":"Người dùng A"}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('00000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'test-b@example.com', '{}', '{"provider":"email","providers":["email"]}', now(), now());

do $$
declare n int;
begin
  select count(*) into n from public.profiles
   where id in ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b');
  assert n = 2, 'profiles created for both users';
  assert (select display_name from public.profiles where id = '00000000-0000-4000-8000-00000000000a') = 'Người dùng A',
    'display_name taken from sign-up metadata';
  assert (select display_name from public.profiles where id = '00000000-0000-4000-8000-00000000000b') = 'test-b',
    'display_name falls back to email prefix';
  select count(*) into n from public.categories where user_id = '00000000-0000-4000-8000-00000000000a';
  assert n = 14, format('14 default categories (got %s)', n);
  select count(*) into n from public.categories where user_id = '00000000-0000-4000-8000-00000000000a' and kind = 'expense';
  assert n = 9, '9 expense categories';
  raise notice 'ok: sign-up creates profile + 14 default categories';
end $$;


-- ---------------------------------------------------------------------
-- 1. User A
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

-- 1a. tasks: ownership default, completed_at trigger, category kind
do $$
declare
  v_work  uuid := (select id from public.categories where kind = 'task' and name = 'Công việc');
  v_food  uuid := (select id from public.categories where kind = 'expense' and name = 'Ăn uống');
  v_t     public.tasks;
begin
  assert auth.uid() = '00000000-0000-4000-8000-00000000000a', 'running as user A';
  assert (select count(*) from public.categories) = 14, 'A sees only own categories';

  insert into public.tasks (id, title, category_id, priority, estimated_minutes, due_date)
  values ('10000000-0000-4000-8000-000000000001', 'Viết báo cáo tuần', v_work, 'high', 120, current_date)
  returning * into v_t;
  assert v_t.user_id = auth.uid(), 'user_id defaults to auth.uid()';
  assert v_t.status = 'todo' and v_t.completed_at is null, 'new task is todo, not completed';

  insert into public.tasks (id, title, category_id)
  values ('10000000-0000-4000-8000-000000000002', 'Ôn tập SQL', v_work);

  update public.tasks set status = 'completed' where id = '10000000-0000-4000-8000-000000000002' returning * into v_t;
  assert v_t.completed_at is not null, 'completing sets completed_at';
  update public.tasks set completed_at = '2000-01-01' where id = v_t.id returning * into v_t;
  assert v_t.completed_at > '2020-01-01', 'client cannot rewrite completed_at';
  update public.tasks set status = 'todo' where id = v_t.id returning * into v_t;
  assert v_t.completed_at is null, 'reopening clears completed_at';

  begin
    insert into public.tasks (title, category_id) values ('Sai loại', v_food);
    raise exception 'FAIL: expense category accepted on a task';
  exception when check_violation then null;
  end;

  begin
    insert into public.tasks (title) values ('   ');
    raise exception 'FAIL: blank title accepted';
  exception when check_violation then null;
  end;

  begin
    update public.categories set kind = 'expense' where id = v_work;
    raise exception 'FAIL: kind of a used category changed';
  exception when check_violation then null;
  end;
  raise notice 'ok: tasks — ownership, completed_at trigger, category kind, constraints';
end $$;

-- 1b. timer RPCs + actual_minutes cache
do $$
declare
  v_e public.time_entries;
  n   int;
begin
  v_e := public.start_timer('10000000-0000-4000-8000-000000000001', 'Soạn dàn ý');
  assert v_e.ended_at is null and v_e.source = 'timer', 'start_timer opens a running segment';
  assert (select status from public.tasks where id = '10000000-0000-4000-8000-000000000001') = 'in_progress',
    'start_timer moves todo -> in_progress';

  v_e := public.start_timer('10000000-0000-4000-8000-000000000002', null);
  select count(*) into n from public.time_entries where ended_at is null;
  assert n = 1, 'starting a new timer closes the previous one';

  begin
    insert into public.time_entries (task_id) values ('10000000-0000-4000-8000-000000000001');
    raise exception 'FAIL: second running timer accepted';
  exception when unique_violation then null;
  end;

  v_e := public.stop_timer();
  assert v_e.ended_at is not null, 'stop_timer closes the running segment';
  assert public.stop_timer() is null, 'stop_timer with nothing running returns null';

  insert into public.time_entries (task_id, started_at, ended_at, source, description)
  values ('10000000-0000-4000-8000-000000000001', now() - interval '3 hours', now() - interval '90 minutes',
          'manual', 'Nhập tay');
  assert (select actual_minutes from public.tasks where id = '10000000-0000-4000-8000-000000000001') = 90,
    'actual_minutes = SUM(time_entries)';

  begin
    insert into public.time_entries (started_at, ended_at, source) values (now(), now() - interval '1 minute', 'manual');
    raise exception 'FAIL: ended_at before started_at accepted';
  exception when check_violation then null;
  end;

  update public.tasks set status = 'completed' where id = '10000000-0000-4000-8000-000000000002';
  begin
    perform public.start_timer('10000000-0000-4000-8000-000000000002', null);
    raise exception 'FAIL: timer started on a completed task';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'ok: timer — start/stop, single running timer, actual_minutes sync';
end $$;

-- 1c. KPI snapshots + progress view
do $$
declare v_p record;
begin
  insert into public.kpis (id, name, unit, target_value, start_date, end_date)
  values ('30000000-0000-4000-8000-000000000001', 'Đọc sách', 'cuốn', 20, current_date - 30, current_date + 30);
  insert into public.kpi_records (kpi_id, recorded_on, value) values
    ('30000000-0000-4000-8000-000000000001', current_date - 10, 4),
    ('30000000-0000-4000-8000-000000000001', current_date - 2, 6);
  insert into public.kpi_records (kpi_id, recorded_on, value)
  values ('30000000-0000-4000-8000-000000000001', current_date - 20, 1);   -- back-filled older snapshot
  assert (select current_value from public.kpis where id = '30000000-0000-4000-8000-000000000001') = 6,
    'current_value = newest snapshot, not the last inserted';

  select * into v_p from public.kpi_progress where id = '30000000-0000-4000-8000-000000000001';
  assert v_p.progress_percent = 30.0, format('progress 30%% (got %s)', v_p.progress_percent);
  assert v_p.record_count = 3 and v_p.last_recorded_on = current_date - 2, 'view exposes record stats';

  begin
    insert into public.kpis (name, target_value) values ('Sai', 0);
    raise exception 'FAIL: target_value 0 accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok: KPI — snapshot sync + kpi_progress view';
end $$;

-- 1d. budgets: carry-forward resolution + spending
do $$
declare
  v_food uuid := (select id from public.categories where kind = 'expense' and name = 'Ăn uống');
  v_work uuid := (select id from public.categories where kind = 'task' and name = 'Công việc');
  v_r    record;
begin
  insert into public.budgets (effective_month, category_id, amount) values
    ('2026-01-01', null,   1000000),
    ('2026-03-01', null,   2000000),
    ('2026-01-01', v_food,  500000);
  insert into public.expenses (amount, category_id, description, spent_on, payment_method) values
    (200000, v_food, 'Ăn trưa', '2026-02-10', 'cash'),
    (700000, v_food, 'Liên hoan', '2026-04-05', 'bank'),
    (100000, null,   'Không phân loại', '2026-04-06', 'e_wallet');

  select * into v_r from public.get_budget_status('2026-02-01') where category_id is null;
  assert v_r.budget_amount = 1000000 and v_r.spent = 200000, 'Feb overall uses the Jan budget';
  select * into v_r from public.get_budget_status('2026-02-01') where category_id = v_food;
  assert v_r.percent_used = 40.0, 'Feb food 40%';

  select * into v_r from public.get_budget_status('2026-04-15') where category_id is null;
  assert v_r.budget_amount = 2000000 and v_r.spent = 800000, 'Apr overall uses the Mar budget and counts uncategorised';
  select * into v_r from public.get_budget_status('2026-04-15') where category_id = v_food;
  assert v_r.remaining = -200000 and v_r.percent_used = 140.0, 'Apr food over budget (carried from Jan)';

  begin
    insert into public.budgets (effective_month, amount) values ('2026-05-15', 1);
    raise exception 'FAIL: mid-month effective_month accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.budgets (effective_month, category_id, amount) values ('2026-05-01', v_work, 1);
    raise exception 'FAIL: task category accepted on a budget';
  exception when check_violation then null;
  end;
  begin
    insert into public.budgets (effective_month, amount) values ('2026-01-01', 5);
    raise exception 'FAIL: duplicate overall budget for a month accepted';
  exception when unique_violation then null;
  end;
  raise notice 'ok: budgets — carry-forward, per-category status, constraints';
end $$;

-- 1e. shopping -> expense, activity feed
do $$
declare
  v_shop uuid := (select id from public.categories where kind = 'expense' and name = 'Mua sắm');
  v_i    public.shopping_items;
  v_amt  numeric;
begin
  insert into public.shopping_items (id, name, category_id, unit_price, quantity, priority, status)
  values ('20000000-0000-4000-8000-000000000001', 'Pin sạc dự phòng', v_shop, 150000, 2, 'high', 'planned')
  returning * into v_i;
  assert v_i.total_price = 300000, 'total_price = unit_price * quantity';

  v_i := public.purchase_shopping_item(v_i.id, current_date, 'e_wallet');
  assert v_i.status = 'purchased' and v_i.purchased_on = current_date and v_i.expense_id is not null,
    'purchase marks item and links an expense';
  select amount into v_amt from public.expenses where id = v_i.expense_id;
  assert v_amt = 300000, 'expense amount = item total';

  begin
    perform public.purchase_shopping_item(v_i.id);
    raise exception 'FAIL: item purchased twice';
  exception when invalid_parameter_value then null;
  end;

  update public.shopping_items set status = 'planned' where id = v_i.id returning * into v_i;
  assert v_i.purchased_on is null, 'leaving purchased clears purchased_on';
  update public.shopping_items set status = 'purchased' where id = v_i.id returning * into v_i;
  assert v_i.purchased_on is not null, 'purchased without date defaults to today';

  assert exists (select 1 from public.activity_logs where entity_type = 'shopping_item' and action = 'completed'),
    'activity: shopping purchased';
  assert exists (select 1 from public.activity_logs where entity_type = 'expense' and (metadata ->> 'amount')::numeric = 300000),
    'activity: expense created';
  assert exists (select 1 from public.activity_logs where entity_type = 'task' and action = 'completed'),
    'activity: task completed';
  assert exists (select 1 from public.activity_logs where entity_type = 'kpi' and action = 'updated'),
    'activity: kpi updated';

  begin
    insert into public.activity_logs (user_id, entity_type, entity_id, action, title)
    values (auth.uid(), 'task', gen_random_uuid(), 'created', 'giả mạo');
    raise exception 'FAIL: client forged an activity log';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: shopping purchase -> expense, activity feed is trigger-only';
end $$;

-- 1f. reports + dashboard + profile
do $$
declare
  v_d jsonb;
  n   int;
begin
  select count(*) into n from public.get_daily_expenses('2026-04-01', '2026-04-30');
  assert n = 30, 'daily expenses returns one row per day';
  assert (select total from public.get_daily_expenses('2026-04-01', '2026-04-30') where day = '2026-04-05') = 700000,
    'daily total is correct';
  assert (select share_percent from public.get_expense_by_category('2026-04-01', '2026-04-30')
           where category_name = 'Ăn uống') = 87.5, 'category share 700k / 800k';
  assert (select sum(completed_count) from public.get_task_stats(current_date - 1, current_date + 1)) = 1,
    'task stats counts the completed task';
  assert (select sum(minutes) from public.get_time_by_day(current_date - 1, current_date + 1)) >= 90,
    'time by day includes the manual entry';
  assert (select count(*) from public.get_time_by_category(current_date - 1, current_date + 1)) >= 1,
    'time by category returns rows';

  begin
    perform public.get_daily_expenses('2026-05-01', '2026-04-01');
    raise exception 'FAIL: reversed range accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_daily_expenses('2024-01-01', '2026-01-01');
    raise exception 'FAIL: over-long range accepted';
  exception when invalid_parameter_value then null;
  end;

  v_d := public.get_dashboard_summary();
  assert v_d ? 'tasks' and v_d ? 'time' and v_d ? 'expenses' and v_d ? 'kpis' and v_d ? 'shopping', 'dashboard sections';
  assert (v_d -> 'tasks' ->> 'open')::int = 1, 'dashboard open tasks';
  assert (v_d -> 'kpis' ->> 'active')::int = 1, 'dashboard active KPIs';

  begin
    update public.profiles set timezone = 'Mars/Olympus' where id = auth.uid();
    raise exception 'FAIL: invalid timezone accepted';
  exception when check_violation then null;
  end;
  update public.profiles set timezone = 'Asia/Bangkok', theme = 'dark' where id = auth.uid();

  begin
    update public.tasks set user_id = '00000000-0000-4000-8000-00000000000b'
     where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'FAIL: task handed over to another user';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: reports, dashboard, profile validation, user_id cannot be reassigned';
end $$;


-- ---------------------------------------------------------------------
-- 2. User B — isolation
-- ---------------------------------------------------------------------
-- remember one of A's category ids (only A can read it) for the cross-user test
select set_config('test.a_category', (select id::text from public.categories where kind = 'task' limit 1), true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);

do $$
declare
  n int;
begin
  assert auth.uid() = '00000000-0000-4000-8000-00000000000b', 'running as user B';

  assert (select count(*) from public.tasks) = 0,          'B sees no tasks of A';
  assert (select count(*) from public.expenses) = 0,       'B sees no expenses of A';
  assert (select count(*) from public.activity_logs) = 0,  'B sees no activity of A';
  assert (select count(*) from public.profiles) = 1,       'B sees only own profile';
  assert (select count(*) from public.kpi_progress) = 0,   'view respects RLS';

  update public.tasks set title = 'hack' where id = '10000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'B cannot update A''s task';
  delete from public.shopping_items where id = '20000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'B cannot delete A''s item';

  begin
    insert into public.time_entries (task_id, started_at, ended_at, source)
    values ('10000000-0000-4000-8000-000000000001', now() - interval '1 hour', now(), 'manual');
    raise exception 'FAIL: B attached time to A''s task';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.tasks (title, category_id) values ('x', current_setting('test.a_category')::uuid);
    raise exception 'FAIL: B used A''s category';
  exception when foreign_key_violation then null;
  end;

  begin
    perform public.purchase_shopping_item('20000000-0000-4000-8000-000000000001');
    raise exception 'FAIL: B purchased A''s item';
  exception when no_data_found then null;
  end;
  begin
    perform public.start_timer('10000000-0000-4000-8000-000000000001');
    raise exception 'FAIL: B timed A''s task';
  exception when no_data_found then null;
  end;

  assert ((public.get_dashboard_summary()) -> 'tasks' ->> 'open')::int = 0, 'B dashboard is empty';
  assert (select count(*) from public.get_budget_status() where category_id is not null) = 0, 'B has no budgets';
  raise notice 'ok: user B is fully isolated from user A (RLS + composite FKs + RPC checks)';
end $$;


-- ---------------------------------------------------------------------
-- 3. anon — no access at all
-- ---------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'categories', 'tasks', 'time_entries', 'kpis', 'kpi_records',
    'expenses', 'budgets', 'shopping_items', 'activity_logs', 'kpi_progress'
  ] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'FAIL: anon can read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;

  begin
    perform public.get_dashboard_summary();
    raise exception 'FAIL: anon can call get_dashboard_summary';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.start_timer();
    raise exception 'FAIL: anon can call start_timer';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: anon has no table, view or RPC access';
end $$;

reset role;
