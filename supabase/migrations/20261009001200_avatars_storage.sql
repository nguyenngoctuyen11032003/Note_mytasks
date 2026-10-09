-- =====================================================================
-- Avatar images in Supabase Storage.
--
-- profiles.avatar_url only accepts http(s) URLs (000900, profiles_avatar_url_check),
-- so images are NOT stored inline. The browser resizes the picture to a small
-- square WebP/JPEG and uploads it to:
--
--     avatars/<auth.uid()>/avatar.<ext>
--
-- then saves the bucket's public URL in profiles.avatar_url.
--
-- Security
--   * Public bucket = anyone with the URL can view the image (normal for avatars;
--     the path is the user's UUID, so it is not enumerable).
--   * Writes (insert / update / delete) only inside the caller's own folder.
--   * 512 KB limit and raster image types only (no SVG = no script in images).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_select_own on storage.objects;
drop policy if exists avatars_insert_own on storage.objects;
drop policy if exists avatars_update_own on storage.objects;
drop policy if exists avatars_delete_own on storage.objects;

-- SELECT is needed by the API for upsert / remove on the caller's own files;
-- public reads go through the public URL and need no policy.
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
