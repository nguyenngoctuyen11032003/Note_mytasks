-- =====================================================================
-- ONE-TIME maintenance: delete ALL Note_mytasks data + ALL Auth accounts.
--
-- NOT a migration, NOT a seed. Never run automatically.
-- Target project: rypeaimdkvojnbhydvfz (Note_mytasks) ONLY.
--
-- Order: run AFTER the initial migration has been applied (the second guard
-- below checks that this is the Note_mytasks database).
--
-- Guard: refuses to run unless, in the SAME session, you first execute
--   select set_config('app.confirm_full_reset', 'DELETE_ALL_NOTE_MYTASKS_DATA', false);
--
-- Deleting auth.users cascades to every app table through the
-- user_id -> auth.users(id) ON DELETE CASCADE foreign keys.
-- Schema, policies, functions and triggers are kept.
-- =====================================================================

begin;

do $$
begin
  if coalesce(current_setting('app.confirm_full_reset', true), '') <> 'DELETE_ALL_NOTE_MYTASKS_DATA' then
    raise exception 'Refusing to run: app.confirm_full_reset guard not set';
  end if;
  -- Second guard: this must be the Note_mytasks database, not another project.
  if to_regclass('public.tasks') is null or to_regclass('public.kpi_records') is null then
    raise exception 'Refusing to run: Note_mytasks tables not found in this database';
  end if;
end;
$$;

delete from auth.users;

-- Leftover from an earlier, abandoned schema attempt (not used by this schema,
-- which stores priority as text + CHECK). Dropped only if nothing references it.
do $$
begin
  if to_regtype('public.tasks_priority_enum') is not null
     and not exists (select 1 from pg_attribute where atttypid = 'public.tasks_priority_enum'::regtype) then
    drop type public.tasks_priority_enum;
  end if;
end;
$$;

-- Verify: everything user-owned must now be empty (cascade worked).
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'profiles', 'categories', 'tasks', 'time_entries', 'kpis', 'kpi_records',
    'expenses', 'budgets', 'shopping_items', 'activity_logs'
  ]
  loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'public.% still has % rows after cleanup', t, n;
    end if;
  end loop;
end;
$$;

commit;
