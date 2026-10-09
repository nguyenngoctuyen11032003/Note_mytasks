-- Notes: markdown notes with notebooks, tags, colour labels, pin/archive,
-- a soft-delete trash and an optional link to a task.
--
-- Conventions (same as 000100):
--   * user_id default auth.uid(); RLS select/insert/update/delete for
--     `authenticated` only (UPDATE has USING + WITH CHECK); anon revoked.
--   * Cross-table reference is a COMPOSITE FK (task_id, user_id) -> tasks(id, user_id)
--     so a user cannot attach a note to someone else's task. Deleting the task keeps
--     the note and only clears task_id (PG15 `on delete set null (task_id)`).
--   * Enums are text + CHECK. Functions use `set search_path = ''`.
--   * Idempotent: if not exists / drop ... if exists, safe to re-run.
--
-- Search: a stored tsvector (`search`) with the built-in 'simple' configuration
-- (no stemming — right for Vietnamese syllables, needs no extension) over
-- title + tags + content, indexed with GIN. The app combines it with ILIKE on
-- title/content for substring matches.
--
-- Not hooked into activity_logs on purpose: its entity_type CHECK and the shared
-- log_activity() trigger are owned by 000100; notes edits are too frequent
-- (autosave) to be meaningful feed items.

-- ---------------------------------------------------------------------
-- 1. Search document (IMMUTABLE so it can back a generated column)
-- ---------------------------------------------------------------------
create or replace function public.notes_search_document(p_title text, p_tags text[], p_content text)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.to_tsvector(
    'simple'::regconfig,
    coalesce(p_title, '') || ' ' ||
    coalesce(pg_catalog.array_to_string(p_tags, ' '), '') || ' ' ||
    coalesce(p_content, '')
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null default '' check (char_length(title) <= 200),
  content    text not null default '' check (char_length(content) <= 100000),
  notebook   text check (notebook is null or char_length(btrim(notebook)) between 1 and 60),
  tags       text[] not null default '{}' check (cardinality(tags) <= 20),
  color      text check (color ~ '^#[0-9a-fA-F]{6}$'),
  pinned     boolean not null default false,
  archived   boolean not null default false,
  trashed_at timestamptz,                         -- not null = in the trash (soft delete)
  task_id    uuid,
  kind       text not null default 'note' check (kind in ('note', 'checklist', 'journal', 'meeting')),
  search     tsvector generated always as (public.notes_search_document(title, tags, content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint notes_task_fkey foreign key (task_id, user_id)
    references public.tasks (id, user_id) on delete set null (task_id)
);

-- Main list: live notes, pinned first, most recently edited.
create index if not exists notes_user_live_idx
  on public.notes (user_id, pinned desc, updated_at desc) where trashed_at is null;
create index if not exists notes_user_trash_idx
  on public.notes (user_id, trashed_at desc) where trashed_at is not null;
create index if not exists notes_user_notebook_idx
  on public.notes (user_id, notebook) where notebook is not null;
create index if not exists notes_user_task_idx
  on public.notes (user_id, task_id) where task_id is not null;
create index if not exists notes_tags_idx   on public.notes using gin (tags);
create index if not exists notes_search_idx on public.notes using gin (search);

drop trigger if exists trg_notes_updated_at on public.notes;
create trigger trg_notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------
revoke all on public.notes from anon, authenticated;
grant select, insert, update, delete on public.notes to authenticated;

-- The generated column evaluates the function as the writing role, so
-- `authenticated` keeps EXECUTE (it is pure and reads no data).
revoke execute on function public.notes_search_document(text, text[], text) from public, anon;
grant execute on function public.notes_search_document(text, text[], text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------
alter table public.notes enable row level security;

drop policy if exists notes_select_own on public.notes;
drop policy if exists notes_insert_own on public.notes;
drop policy if exists notes_update_own on public.notes;
drop policy if exists notes_delete_own on public.notes;

create policy notes_select_own on public.notes
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notes_insert_own on public.notes
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy notes_update_own on public.notes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notes_delete_own on public.notes
  for delete to authenticated
  using (user_id = (select auth.uid()));
