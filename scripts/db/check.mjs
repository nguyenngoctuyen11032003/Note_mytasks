// Connection + health check for the Note_mytasks database.
//
//   npm run db:check
//
// 1. PostgreSQL (DATABASE_URL, TLS verified): schema objects, RLS, migration
//    history, row counts.
// 2. Supabase API exactly as the browser uses it (VITE_SUPABASE_URL + anon key):
//    anon is blocked; the demo account (DEMO_EMAIL / DEMO_PASSWORD) can sign in,
//    read its own rows through RLS and call the RPCs.
import { createClient } from '@supabase/supabase-js';
import { loadEnv, connect, formatPgError } from './lib.mjs';

const TABLES = ['profiles', 'categories', 'tasks', 'time_entries', 'kpis', 'kpi_records',
  'expenses', 'budgets', 'shopping_items', 'activity_logs'];
const RPCS = ['get_dashboard_summary', 'get_budget_status', 'get_expense_by_category', 'get_daily_expenses',
  'get_task_stats', 'get_time_by_day', 'get_time_by_category', 'start_timer', 'stop_timer',
  'purchase_shopping_item', 'user_today', 'current_user_timezone'];

const env = loadEnv();
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  ✗ ${msg}`); };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : bad(detail ? `${msg} — ${detail}` : msg));

// ------------------------------------------------------------------ 1. PostgreSQL
console.log('▶ PostgreSQL');
let pgClient;
try {
  const t0 = Date.now();
  const { client, host } = await connect();
  pgClient = client;
  const { rows: [v] } = await client.query(`select current_setting('server_version') as version, now() as now`);
  ok(`connected to ${host} — PostgreSQL ${v.version}, TLS verified, ${Date.now() - t0} ms`);

  const { rows: tables } = await client.query(
    `select c.relname, c.relrowsecurity as rls,
            (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1)`,
    [TABLES]);
  check(tables.length === TABLES.length, `${tables.length}/${TABLES.length} tables present`,
    `missing: ${TABLES.filter((t) => !tables.some((r) => r.relname === t)).join(', ')}`);
  const noRls = tables.filter((t) => !t.rls);
  check(noRls.length === 0, 'RLS enabled on every table', noRls.map((t) => t.relname).join(', '));
  const policies = tables.reduce((n, t) => n + Number(t.policies), 0);
  check(policies === 36, `${policies} RLS policies (expected 36)`);

  const { rows: fns } = await client.query(
    `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [RPCS]);
  const missing = RPCS.filter((f) => !fns.some((r) => r.proname === f));
  check(missing.length === 0, `${RPCS.length - missing.length}/${RPCS.length} RPC functions present`, `missing: ${missing.join(', ')}`);

  const { rows: [g] } = await client.query(
    `select has_schema_privilege('authenticated', 'public', 'USAGE') as auth_usage,
            has_schema_privilege('anon', 'public', 'USAGE') as anon_usage,
            to_regclass('public.kpi_progress') is not null as view_ok,
            (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where c.relnamespace = 'public'::regnamespace and not t.tgisinternal) as triggers,
            (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled = 'D') as disabled_triggers`);
  check(g.auth_usage, 'authenticated has USAGE on schema public');
  console.log(`  · anon USAGE on schema public: ${g.anon_usage} (table/RPC access is revoked either way)`);
  check(g.view_ok, 'view kpi_progress present');
  check(Number(g.disabled_triggers) === 0, `${g.triggers} triggers, all enabled`, `${g.disabled_triggers} disabled`);

  const { rows: hist } = await client.query(
    `select version, name from supabase_migrations.schema_migrations order by version`).catch(() => ({ rows: [] }));
  check(hist.length > 0, `migration history: ${hist.map((h) => h.version).join(', ') || 'none'}`);

  const counts = await client.query(
    `select ${TABLES.map((t) => `(select count(*) from public.${t}) as ${t}`).join(', ')},
            (select count(*) from auth.users) as auth_users`);
  console.log('  row counts:');
  console.table(counts.rows[0]);
} catch (err) {
  bad(`PostgreSQL: ${formatPgError(err)}`);
} finally {
  await pgClient?.end().catch(() => {});
}

// ------------------------------------------------------------------ 2. Supabase API
console.log('\n▶ Supabase API (as the browser app)');
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  bad('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
} else {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const anon = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, opts);

  const t0 = Date.now();
  const { data: anonRows, error: anonErr } = await anon.from('tasks').select('id').limit(1);
  check(anonErr || (anonRows ?? []).length === 0, `anon cannot read tasks (${Date.now() - t0} ms, ${anonErr ? anonErr.code : 'empty'})`);

  if (!env.DEMO_EMAIL || !env.DEMO_PASSWORD) {
    console.log('  · DEMO_EMAIL / DEMO_PASSWORD not set — run npm run db:seed to create the demo account');
  } else {
    const user = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, opts);
    const { data: auth, error: signErr } = await user.auth.signInWithPassword({
      email: env.DEMO_EMAIL, password: env.DEMO_PASSWORD });
    check(!signErr && auth?.session, `demo account signs in (${env.DEMO_EMAIL})`, signErr?.message);

    if (auth?.session) {
      const uid = auth.user.id;
      const { data: profile, error: pErr } = await user.from('profiles').select('display_name, timezone').single();
      check(!pErr && profile, `profile: ${profile?.display_name} (${profile?.timezone})`, pErr?.message);

      const { count, error: tErr } = await user.from('tasks').select('id', { count: 'exact', head: true });
      check(!tErr && count > 0, `RLS read: ${count} own tasks`, tErr?.message);

      const { data: foreign } = await user.from('tasks').select('id').neq('user_id', uid).limit(1);
      check((foreign ?? []).length === 0, 'RLS: no rows of other users visible');

      const { data: dash, error: dErr } = await user.rpc('get_dashboard_summary');
      check(!dErr && dash?.tasks, `RPC get_dashboard_summary: ${dash?.tasks?.open} open tasks, `
        + `${Number(dash?.expenses?.month_total ?? 0).toLocaleString('vi-VN')} ₫ this month`, dErr?.message);

      const { data: budget, error: bErr } = await user.rpc('get_budget_status');
      check(!bErr && Array.isArray(budget), `RPC get_budget_status: ${budget?.length} rows`, bErr?.message);

      const { data: kpis, error: kErr } = await user.from('kpi_progress').select('name, progress_percent');
      check(!kErr && kpis?.length > 0, `view kpi_progress: ${kpis?.length} KPIs`, kErr?.message);

      const { error: forge } = await user.from('activity_logs')
        .insert({ user_id: uid, entity_type: 'task', entity_id: uid, action: 'created', title: 'x' });
      check(forge, 'activity_logs cannot be written by the client', 'insert was accepted');

      await user.auth.signOut();
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exitCode = failures ? 1 : 0;
