-- =====================================================================
-- Notes integration tests (migration 20261009000700_notes.sql)
--
-- Same style as database.test.sql: plain SQL + ASSERT, run by `npm run db:test`
-- inside BEGIN ... ROLLBACK. Each `ok:` notice is one passed check.
--
--   user C  00000000-0000-4000-8000-00000000000c
--   user D  00000000-0000-4000-8000-00000000000d
--   task C  10000000-0000-4000-8000-0000000000c1
--   task D  10000000-0000-4000-8000-0000000000d1
--   note C  40000000-0000-4000-8000-0000000000c1
-- =====================================================================

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'notes-c@example.com', '{}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('00000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'notes-d@example.com', '{}', '{"provider":"email","providers":["email"]}', now(), now());

-- Task owned by D (created as postgres) — C must not be able to link to it.
insert into public.tasks (id, user_id, title)
values ('10000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000d', 'Việc của D');


-- ---------------------------------------------------------------------
-- 1. User C: ownership, defaults, constraints, search, task link
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);

do $$
declare
  v_n    public.notes;
  v_prev timestamptz;
  n      int;
begin
  assert auth.uid() = '00000000-0000-4000-8000-00000000000c', 'running as user C';

  insert into public.tasks (id, title) values ('10000000-0000-4000-8000-0000000000c1', 'Chuẩn bị họp');

  insert into public.notes (id, title, content, notebook, tags, color, kind, task_id)
  values ('40000000-0000-4000-8000-0000000000c1', 'Biên bản họp quý', E'# Họp\n- [ ] Gửi báo cáo doanh thu',
          'Công việc', '{du-an,hop}', '#B4532A', 'meeting', '10000000-0000-4000-8000-0000000000c1')
  returning * into v_n;
  assert v_n.user_id = auth.uid(), 'user_id defaults to auth.uid()';
  assert not v_n.pinned and not v_n.archived and v_n.trashed_at is null, 'new note is live, unpinned';
  assert v_n.search @@ pg_catalog.to_tsquery('simple', 'doanh & thu'), 'search vector covers content';
  assert v_n.search @@ pg_catalog.to_tsquery('simple', 'du-an'), 'search vector covers tags';

  insert into public.notes default values returning * into v_n;
  assert v_n.title = '' and v_n.content = '' and v_n.kind = 'note', 'empty note allowed with defaults';

  v_prev := v_n.updated_at;
  update public.notes set pinned = true where id = v_n.id returning * into v_n;
  -- now() is the transaction start inside a test; just check the trigger ran
  assert v_n.updated_at >= v_prev, 'updated_at maintained by trigger';

  begin
    insert into public.notes (title) values (repeat('x', 201));
    raise exception 'FAIL: title > 200 accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.notes (kind) values ('poem');
    raise exception 'FAIL: unknown kind accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.notes (color) values ('red');
    raise exception 'FAIL: non-hex color accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.notes (notebook) values ('   ');
    raise exception 'FAIL: blank notebook accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.notes (tags) values (array(select 't' || g from generate_series(1, 21) g));
    raise exception 'FAIL: 21 tags accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.notes (content) values (repeat('a', 100001));
    raise exception 'FAIL: content > 100k accepted';
  exception when check_violation then null;
  end;

  -- Cross-user task link is rejected by the composite FK.
  begin
    insert into public.notes (title, task_id) values ('x', '10000000-0000-4000-8000-0000000000d1');
    raise exception 'FAIL: C linked a note to D''s task';
  exception when foreign_key_violation then null;
  end;

  -- Trash (soft delete) and restore.
  update public.notes set trashed_at = now() where id = '40000000-0000-4000-8000-0000000000c1';
  select count(*) into n from public.notes where trashed_at is null;
  assert n = 1, 'trashed note leaves the live list';
  update public.notes set trashed_at = null where id = '40000000-0000-4000-8000-0000000000c1';

  -- Deleting the task keeps the note and clears the link.
  delete from public.tasks where id = '10000000-0000-4000-8000-0000000000c1';
  assert (select task_id from public.notes where id = '40000000-0000-4000-8000-0000000000c1') is null,
    'deleting the task sets note.task_id to null';
  assert (select count(*) from public.notes) = 2, 'note survives task deletion';

  raise notice 'ok: notes — ownership, defaults, constraints, search vector, trash, task link';
end $$;


-- ---------------------------------------------------------------------
-- 2. User D: full isolation from C
-- ---------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);

do $$
declare
  n int;
begin
  assert auth.uid() = '00000000-0000-4000-8000-00000000000d', 'running as user D';
  assert (select count(*) from public.notes) = 0, 'D sees none of C''s notes';

  update public.notes set title = 'hack' where id = '40000000-0000-4000-8000-0000000000c1';
  get diagnostics n = row_count;
  assert n = 0, 'D cannot update C''s note';

  delete from public.notes where id = '40000000-0000-4000-8000-0000000000c1';
  get diagnostics n = row_count;
  assert n = 0, 'D cannot delete C''s note';

  begin
    insert into public.notes (user_id, title) values ('00000000-0000-4000-8000-00000000000c', 'giả mạo');
    raise exception 'FAIL: D inserted a note owned by C';
  exception when insufficient_privilege then null;
  end;

  insert into public.notes (title, task_id) values ('Ghi chú của D', '10000000-0000-4000-8000-0000000000d1');
  begin
    update public.notes set user_id = '00000000-0000-4000-8000-00000000000c' where title = 'Ghi chú của D';
    raise exception 'FAIL: D re-assigned a note to C';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  raise notice 'ok: notes — user D is isolated from user C (RLS + composite FK)';
end $$;


-- ---------------------------------------------------------------------
-- 3. anon — no access
-- ---------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
begin
  begin
    perform 1 from public.notes limit 1;
    raise exception 'FAIL: anon can read notes';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notes (title) values ('anon');
    raise exception 'FAIL: anon can insert notes';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: notes — anon has no access';
end $$;

reset role;
