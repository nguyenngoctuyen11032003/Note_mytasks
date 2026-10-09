-- Notes search ignores Vietnamese diacritics.
--
-- Before: notes.search = to_tsvector('simple', title || tags || content), so typing
-- "bao cao" (the common way to type fast, or on a keyboard without Telex/VNI) never
-- found "Báo cáo". Now the document holds BOTH the original words and their
-- accent-folded form (public.vi_normalize, migration 000400 — IMMUTABLE), so:
--   "báo cáo" -> matches (original words)
--   "bao cao" -> matches (folded words)
-- The client (src/services/notes.js) queries each word as (original:* | folded:*).
--
-- notes.search is a STORED generated column: replacing the function alone would not
-- recompute existing rows, so the column (and its GIN index) is re-created. Signature,
-- privileges and column name are unchanged.

create or replace function public.notes_search_document(p_title text, p_tags text[], p_content text)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.to_tsvector('simple'::regconfig, d.doc)
      || pg_catalog.to_tsvector('simple'::regconfig, public.vi_normalize(d.doc))
    from (select coalesce(p_title, '') || ' ' ||
                 coalesce(pg_catalog.array_to_string(p_tags, ' '), '') || ' ' ||
                 coalesce(p_content, '') as doc) d;
$$;

alter table public.notes drop column if exists search;
alter table public.notes
  add column search tsvector generated always as (public.notes_search_document(title, tags, content)) stored;
create index if not exists notes_search_idx on public.notes using gin (search);

revoke execute on function public.notes_search_document(text, text[], text) from public, anon;
grant  execute on function public.notes_search_document(text, text[], text) to authenticated;
