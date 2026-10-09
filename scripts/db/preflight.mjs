// Read-only pre-push check against the database in DATABASE_URL (.env).
//
//   node scripts/db/preflight.mjs
//
// Answers "will `npm run db:push` apply the pending migrations cleanly?" without
// writing anything: the whole session runs inside a READ ONLY transaction.
//
//  1. Lists which local migrations are already recorded in
//     supabase_migrations.schema_migrations and which are pending.
//  2. Builds the expected schema by applying every local migration to an
//     in-memory PGlite, then, for every public function the pending migrations
//     (re)define, compares the live signature with the expected one.
//     `create or replace function` fails when an existing function with the same
//     argument types has different input-parameter names, a different return
//     type / OUT columns, or fewer defaults — any of those is reported as a
//     blocker (the push would roll back as a whole).
//  3. Reports function bodies that differ from the migration files (drift that
//     the pending resync migration will repair) and tables the pending
//     migrations create that are still missing live.
// Secrets are never printed (only the host name).
import { PGlite } from '@electric-sql/pglite';
import { connect, migrationFiles, formatPgError } from './lib.mjs';

const STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const FN_SQL = `
  select p.proname as name,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as ident,
         pg_catalog.pg_get_function_arguments(p.oid)          as args,
         pg_catalog.pg_get_function_result(p.oid)             as result,
         p.pronargdefaults                                    as ndefaults,
         p.prosecdef                                          as definer,
         md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))      as body,
         has_function_privilege('anon', p.oid, 'execute')     as anon
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace`;

// Input-parameter names in declaration order, from "p_a uuid DEFAULT NULL, OUT x int, …".
const inNames = (args) => args.split(/,(?![^()]*\))/).map((a) => a.trim())
  .filter((a) => a && !/^(OUT|TABLE)\b/i.test(a))
  .map((a) => a.replace(/^(IN|INOUT|VARIADIC)\s+/i, '').split(/\s+/)[0]);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

let blockers = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { blockers += 1; console.log(`  ✗ ${m}`); };
const info = (m) => console.log(`  · ${m}`);

// ------------------------------------------------------------------ expected schema
const files = migrationFiles();
const pg = new PGlite();
await pg.exec(STUB);
for (const f of files) await pg.exec(f.sql);
const expected = new Map((await pg.query(FN_SQL)).rows.map((r) => [`${r.name}(${r.ident})`, r]));
const expectedTables = new Set((await pg.query(
  `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v')`)).rows.map((r) => r.relname));
await pg.close();

// ------------------------------------------------------------------ live (read only)
let client;
try {
  ({ client } = await connect().then((c) => { console.log(`▶ Live database ${c.host} (read-only session)`); return c; }));
  await client.query('begin transaction read only');

  const { rows: hist } = await client.query(
    `select version from supabase_migrations.schema_migrations order by version`).catch(() => ({ rows: [] }));
  const applied = new Set(hist.map((h) => String(h.version)));
  const pending = files.filter((f) => !applied.has(f.name.split('_')[0]));
  info(`applied: ${[...applied].join(', ') || 'none'}`);
  info(`pending: ${pending.map((f) => f.name).join(', ') || 'none'}`);

  // Functions (re)defined by the pending migrations.
  const touched = new Set();
  for (const f of pending) {
    for (const m of f.sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)) touched.add(m[1]);
  }
  const live = (await client.query(FN_SQL)).rows;
  const liveByKey = new Map(live.map((r) => [`${r.name}(${r.ident})`, r]));

  console.log('\n▶ Public functions: live vs migration files');
  let drift = 0, missing = 0, same = 0;
  for (const [key, exp] of [...expected].sort()) {
    const willRedefine = touched.has(exp.name);
    const cur = liveByKey.get(key);
    if (!cur) {
      const overloads = live.filter((r) => r.name === exp.name);
      if (!willRedefine) bad(`${key}: missing live and no pending migration creates it`);
      else if (overloads.length) info(`${key}: live has only ${overloads.map((o) => `${o.name}(${o.ident})`).join(', ')} — a new overload will be created (check the app calls the right one)`);
      missing++;
      continue;
    }
    const problems = [];
    if (inNames(cur.args).join(',') !== inNames(exp.args).join(',')) {
      problems.push(`parameter names ${inNames(cur.args).join(',')} → ${inNames(exp.args).join(',')}`);
    }
    if (norm(cur.result) !== norm(exp.result)) problems.push(`return type "${cur.result}" → "${exp.result}"`);
    if (Number(cur.ndefaults) > Number(exp.ndefaults)) problems.push(`would remove parameter defaults (${cur.ndefaults} → ${exp.ndefaults})`);
    if (problems.length && willRedefine) bad(`${key}: create or replace would FAIL — ${problems.join('; ')}`);
    else if (problems.length) bad(`${key}: live signature differs from the migration files — ${problems.join('; ')}`);
    else if (cur.body !== exp.body) {
      drift++;
      if (willRedefine) info(`${key}: body differs from the migration files (re-synced by the push)`);
      else bad(`${key}: body differs from the migration files and no pending migration repairs it`);
    } else same++;
    if (cur.anon && !exp.anon) {
      if (willRedefine) info(`${key}: anon can EXECUTE live; the pending migration revokes it`);
      else bad(`${key}: anon can EXECUTE live (the migration files revoke it)`);
    }
  }
  ok(`${expected.size} expected functions: ${same} identical, ${drift} drifted, ${missing} not yet live`);

  console.log('\n▶ Tables / views');
  const { rows: liveRel } = await client.query(
    `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v')`);
  const liveTables = new Set(liveRel.map((r) => r.relname));
  const absent = [...expectedTables].filter((t) => !liveTables.has(t));
  absent.length ? info(`missing live (created by the push): ${absent.join(', ')}`) : ok('every expected table/view exists live');

  const extra = live.filter((r) => !expected.has(`${r.name}(${r.ident})`));
  if (extra.length) info(`live-only public functions (not in any migration): ${extra.map((r) => `${r.name}(${r.ident})`).join(', ')}`);
  const extraAnon = extra.filter((r) => r.anon);
  extraAnon.forEach((r) => bad(`live-only ${r.name}(${r.ident}) is executable by anon`));

  console.log('\n▶ Live security posture');
  const { rows: noRls } = await client.query(
    `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  noRls.length ? noRls.forEach((r) => bad(`public.${r.relname}: RLS disabled`)) : ok('RLS enabled on every public table');
  const { rows: anonRel } = await client.query(`
    select c.relname from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
  anonRel.length ? anonRel.forEach((r) => bad(`anon has privileges on public.${r.relname}`)) : ok('anon has no table/view privileges');
  const { rows: views } = await client.query(`
    select relname, coalesce(reloptions, '{}') as opts from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'v'`);
  for (const v of views) {
    if (!v.opts.some((o) => /^security_invoker=(true|on|1)$/i.test(o))) bad(`view public.${v.relname} is not security_invoker`);
  }
  if (views.length) ok(`${views.length} view(s) checked for security_invoker`);

  await client.query('rollback');
} catch (err) {
  bad(formatPgError(err));
} finally {
  await client?.end().catch(() => {});
}

console.log(blockers ? `\n${blockers} blocker(s): do NOT push before fixing them.` : '\nNo blockers: the pending migrations should apply cleanly.');
process.exitCode = blockers ? 1 : 0;
