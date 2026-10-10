-- =====================================================================
-- Fitora images in Supabase Storage (contract: Fitora/docs/PLAN.md §2).
--
--     fitora/<auth.uid()>/meals/<uuid>.webp       meal photos (AI scan)
--     fitora/<auth.uid()>/progress/<uuid>.webp    body progress photos
--
-- Security (modelled on 001200 avatars / 001300 note-media)
--   * PRIVATE bucket: no public URL; the app shows images through short-lived
--     signed URLs created by the owner (createSignedUrl needs SELECT).
--   * select / insert / update / delete only inside the caller's own top folder.
--   * 5 MB limit, raster images only (no SVG = no script in images).
-- Purely additive and idempotent: bucket upserted, fitora_* policies re-created.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fitora', 'fitora', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists fitora_select_own on storage.objects;
drop policy if exists fitora_insert_own on storage.objects;
drop policy if exists fitora_update_own on storage.objects;
drop policy if exists fitora_delete_own on storage.objects;

create policy fitora_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'fitora' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy fitora_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fitora' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy fitora_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'fitora' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'fitora' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy fitora_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'fitora' and (storage.foldername(name))[1] = (select auth.uid())::text);
