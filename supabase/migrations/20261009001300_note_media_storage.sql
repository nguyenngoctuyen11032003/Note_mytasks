-- =====================================================================
-- Note media (images, voice recordings) in Supabase Storage.
--
-- Markdown references media with the `nm-media:<path>` scheme; the browser
-- resolves each path to a short-lived signed URL (src/services/noteMedia.js).
--
--     note-media/<auth.uid()>/<note_id>/<uuid>.<ext>
--
-- Security
--   * PRIVATE bucket: no public URL, reads only through signed URLs created by
--     the owner (createSignedUrl needs SELECT on the object).
--   * select / delete: only inside the caller's own top folder. They do NOT
--     require the note to still exist, so media of a permanently deleted note
--     can still be listed and cleaned up.
--   * insert / update (new name): own top folder AND the second folder must be
--     one of the caller's own notes (public.notes is itself RLS-protected, so
--     the sub-select only sees the caller's rows). Uploading into a random /
--     another user's note id is rejected. Notes are always created before the
--     editor opens (pages/notes.js createFrom), so uploads never race the row.
--   * 25 MB limit; raster images (no SVG = no script) and common audio types.
-- Idempotent: bucket upserted, policies dropped and re-created.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-media', 'note-media', false, 26214400, array[
  'image/webp', 'image/jpeg', 'image/png', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'
])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists note_media_select_own on storage.objects;
drop policy if exists note_media_insert_own on storage.objects;
drop policy if exists note_media_update_own on storage.objects;
drop policy if exists note_media_delete_own on storage.objects;

create policy note_media_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'note-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy note_media_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'note-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.notes n
      where n.id::text = (storage.foldername(name))[2]
        and n.user_id = (select auth.uid())
    )
  );

create policy note_media_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'note-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'note-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.notes n
      where n.id::text = (storage.foldername(name))[2]
        and n.user_id = (select auth.uid())
    )
  );

create policy note_media_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'note-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
