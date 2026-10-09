// Real PostgreSQL (PGlite/WASM) with a minimal Supabase stand-in:
//   auth.users, auth.uid() (reads request.jwt.claim.sub), roles anon/authenticated/service_role.
// Every test file gets a fresh database with ALL supabase/migrations applied in order.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');

const SUPABASE_STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create schema if not exists extensions;
  grant usage on schema auth, public, extensions to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $f$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  -- Supabase grants table privileges in public by default; migrations revoke what they must.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Fresh DB with every migration applied. */
export async function createDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
  return db;
}

/** Create an auth user (fires the sign-up trigger). Returns its uuid. */
export async function createUser(db, { email, displayName } = {}) {
  const id = randomUUID();
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [
    id,
    email || `${id.slice(0, 8)}@test.local`,
    JSON.stringify(displayName ? { display_name: displayName } : {}),
  ]);
  return id;
}

/**
 * Run `fn(tx)` as an authenticated user (role + JWT sub), exactly like a PostgREST request.
 * Rolled back on error; committed otherwise. Use `asAnon` for signed-out requests.
 */
export async function asUser(db, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    return fn(tx);
  });
}

export async function asAnon(db, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role anon`);
    await tx.query(`select set_config('request.jwt.claim.sub', '', true)`);
    return fn(tx);
  });
}

/** Shorthand: rows of a query run as `userId`. */
export async function q(db, userId, sql, params = []) {
  return asUser(db, userId, async (tx) => (await tx.query(sql, params)).rows);
}

/** Category id by kind + name for a user (as superuser). */
export async function categoryId(db, userId, kind, name) {
  const { rows } = await db.query('select id from public.categories where user_id = $1 and kind = $2 and name = $3', [userId, kind, name]);
  return rows[0]?.id;
}
