// Offline data-contract + security audit (no network, no live database).
//
//   node scripts/db/contract.mjs
//
// 1. Applies every supabase/migrations/*.sql, in order, to an in-memory
//    PostgreSQL (PGlite) with a Supabase stand-in (roles anon / authenticated /
//    service_role, auth.users, auth.uid(), Supabase's default grants).
// 2. Scans src/services/**/*.js and checks that every
//      .from('<table>') ... .select('<cols>') / filters / order
//      rpc('<fn>', { p_arg: … })  and  rpcOr('<fn>', …)
//      *_WRITABLE column whitelists
//    refer to tables, views, columns, functions and argument names that exist,
//    and that every required (no default) argument is passed.
// 3. Security posture of the resulting schema:
//      - RLS enabled on every public table; views are security_invoker
//      - no public function executable by anon
//      - every public function pins search_path
//      - SECURITY DEFINER functions are listed (each must re-check auth.uid())
//      - every RPC the app calls is executable by authenticated
// Exit code 1 on any failure.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, migrationFiles } from './lib.mjs';

const STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create schema if not exists extensions;
  grant usage on schema auth, public, extensions to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures += 1; console.log(`  ✗ ${m}`); };
const info = (m) => console.log(`  · ${m}`);

// ------------------------------------------------------------------ 1. schema
console.log('▶ Migrations (PGlite)');
const db = new PGlite();
await db.exec(STUB);
for (const { name, sql } of migrationFiles()) {
  try { await db.exec(sql); } catch (e) { bad(`${name}: ${e.message}`); process.exit(1); }
}
ok(`${migrationFiles().length} migrations applied`);

const rel = new Map(); // name -> Set(columns)
for (const r of (await db.query(`
  select c.relname, a.attname from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')`)).rows) {
  if (!rel.has(r.relname)) rel.set(r.relname, new Set());
  rel.get(r.relname).add(r.attname);
}
// fn name -> [{ args: [{name, hasDefault}], anon, auth }]
const fns = new Map();
for (const r of (await db.query(`
  select p.proname, p.oid, coalesce(p.proargnames, '{}') as names, p.proargmodes as modes,
         p.pronargs, p.pronargdefaults,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as auth
    from pg_proc p where p.pronamespace = 'public'::regnamespace`)).rows) {
  const inNames = r.names.filter((_, i) => !r.modes || ['i', 'b', 'v'].includes(r.modes[i])).slice(0, r.pronargs);
  const args = inNames.map((n, i) => ({ name: n, hasDefault: i >= r.pronargs - r.pronargdefaults }));
  if (!fns.has(r.proname)) fns.set(r.proname, []);
  fns.get(r.proname).push({ args, anon: r.anon, auth: r.auth });
}

// ------------------------------------------------------------------ 2. services
console.log('\n▶ Service ↔ schema contract');
const SRC = path.join(ROOT, 'src/services');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
  }
})(SRC);

/** Top-level string constants of a file: NAME = '…' ('+' '…')* | `…${NAME}…` */
function constants(src) {
  const out = {};
  const re = /(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*=\s*((?:'[^']*'|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|`[^`]*`))*)/g;
  for (const m of src.matchAll(re)) {
    out[m[1]] = [...m[2].matchAll(/'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2]).join('');
  }
  for (let i = 0; i < 3; i++) {
    for (const k of Object.keys(out)) out[k] = out[k].replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, n) => out[n] ?? `\${${n}}`);
  }
  return out;
}
const resolveArg = (arg, consts) => {
  arg = arg.trim();
  const lit = /^'([^']*)'$|^`([^`]*)`$/.exec(arg);
  if (lit) return (lit[1] ?? lit[2]).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, n) => consts[n] ?? '');
  if (/^[A-Z_][A-Z0-9_]*$/.test(arg)) return consts[arg] ?? null;
  return null;
};

/** Split a PostgREST select list at top-level commas. */
function splitTop(s) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Validate a select list against `table`; embedded resources `alias:table(cols)` recurse. */
function checkSelect(table, list, where, problems) {
  const cols = rel.get(table);
  if (!cols) { problems.push(`${where}: unknown table/view '${table}'`); return; }
  for (const part of splitTop(list)) {
    if (part === '*' || part === '') continue;
    const emb = /^(?:(\w+):)?(\w+)(?:!\w+)?\((.*)\)$/s.exec(part);
    if (emb) { checkSelect(emb[2], emb[3], where, problems); continue; }
    const col = part.replace(/^\w+:/, '').replace(/::\w+$/, '').trim();
    if (!cols.has(col)) problems.push(`${where}: column '${table}.${col}' does not exist`);
  }
}

const FILTERS = 'eq|neq|gt|gte|lt|lte|is|in|like|ilike|contains|containedBy|overlaps|order|not|textSearch';
const calledRpcs = new Set();
const problems = [];
let checkedSelects = 0, checkedFilters = 0, checkedRpcs = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel_ = path.relative(ROOT, file).replace(/\\/g, '/');
  const consts = constants(src);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  // .from('table') … up to the end of the statement (';' or a blank line)
  for (const m of src.matchAll(/\.from\(\s*'(\w+)'\s*\)/g)) {
    const table = m[1];
    const where = `${rel_}:${lineOf(m.index)}`;
    if (!rel.has(table)) { problems.push(`${where}: unknown table/view '${table}'`); continue; }
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/;|\n\s*\n|\.from\(/);
    const chain = end < 0 ? rest : rest.slice(0, end);
    for (const s of chain.matchAll(/\.select\(\s*('[^']*'|`[^`]*`|[A-Z_][A-Z0-9_]*)\s*[,)]/g)) {
      const list = resolveArg(s[1], consts);
      if (list == null) continue;
      checkedSelects++;
      checkSelect(table, list, where, problems);
    }
    for (const f of chain.matchAll(new RegExp(`\\.(?:${FILTERS})\\(\\s*'([\\w.]+)'`, 'g'))) {
      const col = f[1];
      if (col.includes('.')) continue; // embedded-resource filter
      checkedFilters++;
      if (!rel.get(table).has(col)) problems.push(`${where}: filter/order column '${table}.${col}' does not exist`);
    }
  }

  // rpc('name', { p_a: …, p_b }) / rpcOr('name', {…}, fallback)
  for (const m of src.matchAll(/\brpc(?:Or)?\(\s*'(\w+)'\s*(?:,\s*(\{|undefined|\w+))?/g)) {
    const name = m[1];
    const where = `${rel_}:${lineOf(m.index)}`;
    calledRpcs.add(name);
    checkedRpcs++;
    const defs = fns.get(name);
    if (!defs) { problems.push(`${where}: RPC '${name}' does not exist`); continue; }
    // Keys of the object literal starting at src[start] === '{' (depth 1 only).
    const objectKeys = (start) => {
      let depth = 0, body = '';
      for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) break; }
        body += ch;
      }
      let d = 0, flat = '';
      for (const ch of body.slice(1)) { if ('{(['.includes(ch)) d++; if ('})]'.includes(ch)) d--; flat += d === 0 ? ch : ' '; }
      return [...flat.matchAll(/(?:^|,)\s*(\w+)\s*(?=[:,]|$)/g)].map((x) => x[1]);
    };
    let passed = [];
    if (m[2] === '{') passed = objectKeys(m.index + m[0].length - 1);
    else if (m[2] && m[2] !== 'undefined') {
      // rpc('fn', args) with `const args = { … }` declared earlier in the same file
      const decl = [...src.slice(0, m.index).matchAll(new RegExp(`(?:const|let)\\s+${m[2]}\\s*=\\s*\\{`, 'g'))].pop();
      if (decl) passed = objectKeys(decl.index + decl[0].length - 1);
      else { info(`${where}: rpc '${name}' args '${m[2]}' not resolvable statically — skipped`); continue; }
    }
    const fits = defs.some((def) => passed.every((p) => def.args.some((a) => a.name === p))
      && def.args.every((a) => a.hasDefault || passed.includes(a.name)));
    if (!fits) {
      problems.push(`${where}: rpc '${name}' called with {${passed.join(', ')}} but signature is `
        + defs.map((d) => `(${d.args.map((a) => a.name + (a.hasDefault ? '?' : '')).join(', ')})`).join(' | '));
    }
  }

  // { table: 'x', …, cols: ['a', 'b'] } descriptors (backup.js)
  for (const m of src.matchAll(/\{\s*table:\s*'(\w+)'[^}]*?cols:\s*(\[[^\]]*\]|null)/g)) {
    const where = `${rel_}:${lineOf(m.index)}`;
    if (!rel.has(m[1])) { problems.push(`${where}: unknown table '${m[1]}'`); continue; }
    for (const c of [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])) {
      if (!rel.get(m[1]).has(c)) problems.push(`${where}: column '${m[1]}.${c}' does not exist`);
    }
  }

  // *_WRITABLE whitelists → table of the file
  const WRITABLE_TABLE = {
    TASK_WRITABLE: 'tasks', EXPENSE_WRITABLE: 'expenses', CATEGORY_WRITABLE: 'categories',
    KPI_WRITABLE: 'kpis', RECORD_WRITABLE: 'kpi_records', NOTE_WRITABLE: 'notes',
    PROFILE_WRITABLE: 'profiles', SHOP_WRITABLE: 'shopping_items', ENTRY_WRITABLE: 'time_entries',
  };
  for (const m of src.matchAll(/const\s+(\w+_WRITABLE)\s*=\s*\[([^\]]*)\]/g)) {
    const table = WRITABLE_TABLE[m[1]];
    if (!table) { info(`${rel_}: ${m[1]} has no known table — skipped`); continue; }
    for (const c of [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])) {
      if (!rel.get(table)?.has(c)) problems.push(`${rel_}:${lineOf(m.index)}: ${m[1]} column '${table}.${c}' does not exist`);
    }
  }
}
if (problems.length) problems.forEach(bad);
else ok(`${checkedSelects} select lists, ${checkedFilters} filters, ${checkedRpcs} RPC calls, all *_WRITABLE lists match the schema`);

// ------------------------------------------------------------------ 3. security
console.log('\n▶ Security posture');
const { rows: noRls } = await db.query(`
  select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
noRls.length ? noRls.forEach((r) => bad(`table public.${r.relname} has RLS disabled`)) : ok('RLS enabled on every public table');

const { rows: views } = await db.query(`
  select c.relname, coalesce(c.reloptions, '{}') as opts from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'`);
for (const v of views) {
  v.opts.some((o) => /^security_invoker=(true|on|1)$/i.test(o))
    ? ok(`view public.${v.relname} is security_invoker`)
    : bad(`view public.${v.relname} is NOT security_invoker (would bypass RLS)`);
}

const { rows: anonTables } = await db.query(`
  select c.relname from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
       or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
anonTables.length ? anonTables.forEach((r) => bad(`anon has privileges on public.${r.relname}`)) : ok('anon has no table/view privileges in public');

const { rows: fnRows } = await db.query(`
  select p.oid::regprocedure::text as sig, p.prosecdef as definer, p.proconfig as cfg,
         p.prorettype = 'trigger'::regtype as is_trigger,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('public', p.oid, 'execute') as pub
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`);
const anonFns = fnRows.filter((f) => f.anon && !f.is_trigger);
anonFns.length ? anonFns.forEach((f) => bad(`anon can EXECUTE ${f.sig}`)) : ok(`no non-trigger function executable by anon (${fnRows.length} functions)`);
const anonTrig = fnRows.filter((f) => f.anon && f.is_trigger);
if (anonTrig.length) info(`${anonTrig.length} trigger function(s) keep default EXECUTE (not callable via /rpc: PostgREST hides trigger functions)`);
const noPath = fnRows.filter((f) => !(f.cfg || []).some((c) => c.startsWith('search_path=')));
noPath.length ? noPath.forEach((f) => bad(`${f.sig} has no pinned search_path`)) : ok('every public function pins search_path');
const definers = fnRows.filter((f) => f.definer);
info(`SECURITY DEFINER functions (${definers.length}): ${definers.map((f) => f.sig).join(', ') || 'none'}`);

for (const name of [...calledRpcs].sort()) {
  const defs = fns.get(name) || [];
  if (defs.length && !defs.some((d) => d.auth)) bad(`authenticated cannot EXECUTE ${name}() but the app calls it`);
}
ok(`${calledRpcs.size} RPCs called by the app checked for authenticated EXECUTE`);

console.log(failures ? `\n${failures} problem(s).` : '\nContract and security checks passed.');
await db.close();
process.exitCode = failures ? 1 : 0;
