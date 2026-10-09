-- Security housekeeping found by the data-contract audit
-- (scripts/db/contract.mjs offline, scripts/db/preflight.mjs read-only against the
-- hosted database). Idempotent; a no-op re-run is safe.
--
-- 1. Drop public.close_running_time_entry(uuid).
--    The hosted database still carries this helper from an early draft of 000300;
--    it is in no migration file, nothing calls it (not the app, not a function, not
--    a trigger) and its logic now lives in start_timer / stop_timer. It is SECURITY
--    INVOKER, so RLS already limited it to the caller's rows, but it was still an
--    unreviewed endpoint at /rpc/close_running_time_entry for every signed-in user.
--
-- 2. profiles.avatar_url / profiles.locale had no CHECK.
--    avatar_url is meant to be rendered as an <img src>, so only http(s) URLs of a
--    sane length are accepted (blocks javascript:/data: payloads stored through the
--    API, whatever the client does). locale feeds Intl APIs, which throw on garbage.
--    Added NOT VALID (never blocks the push), then validated when existing rows
--    comply; otherwise the constraint still guards every new write.

drop function if exists public.close_running_time_entry(uuid);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'profiles_avatar_url_check' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles
      add constraint profiles_avatar_url_check
      check (avatar_url is null or (avatar_url ~* '^https?://[^[:space:]]+$' and char_length(avatar_url) <= 2048))
      not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'profiles_locale_check' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles
      add constraint profiles_locale_check
      check (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$')
      not valid;
  end if;

  begin
    alter table public.profiles validate constraint profiles_avatar_url_check;
  exception when check_violation then
    raise notice 'profiles_avatar_url_check left NOT VALID: existing rows violate it';
  end;
  begin
    alter table public.profiles validate constraint profiles_locale_check;
  exception when check_violation then
    raise notice 'profiles_locale_check left NOT VALID: existing rows violate it';
  end;
end;
$$;
