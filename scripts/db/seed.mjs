// Creates (or refreshes) the DEMO account and rebuilds its data from supabase/seed.sql.
//
//   npm run db:seed
//
// Account: DEMO_EMAIL (default demo@example.com) / DEMO_PASSWORD from .env.
// If DEMO_PASSWORD is missing, a random one is generated and appended to the
// local, git-ignored .env — it is never printed.
// The account is flagged raw_app_meta_data.demo_account = true; seed.sql refuses
// to touch any account without that flag, so real users are never overwritten.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, connect, readSql, formatPgError } from './lib.mjs';

const env = loadEnv();
const email = (env.DEMO_EMAIL || 'demo@example.com').toLowerCase();
let password = env.DEMO_PASSWORD;
if (!password) {
  password = crypto.randomBytes(12).toString('base64url');
  const envFile = path.join(ROOT, '.env');
  const prefix = fs.existsSync(envFile) && !fs.readFileSync(envFile, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(envFile, `${prefix}\n# Demo account created by npm run db:seed\nDEMO_EMAIL=${email}\nDEMO_PASSWORD=${password}\n`);
  console.log('Generated a demo password and saved it to .env (DEMO_PASSWORD).');
}

const { client, host } = await connect();
console.log(`Connected to ${host} (TLS verified)`);
client.on('notice', (n) => console.log(`  ${n.message}`));

try {
  await client.query('begin');

  const { rows } = await client.query(
    `select id, coalesce((raw_app_meta_data ->> 'demo_account')::boolean, false) as demo
       from auth.users where lower(email) = $1`, [email]);

  if (rows.length && !rows[0].demo) {
    throw new Error(`${email} exists and is NOT a demo account — refusing to seed it`);
  }

  if (!rows.length) {
    const id = crypto.randomUUID();
    await client.query(
      `insert into auth.users (
         id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         email_change_token_current, phone_change, phone_change_token, reauthentication_token)
       values (
         $1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
         extensions.crypt($3, extensions.gen_salt('bf', 10)), now() - interval '100 days',
         '{"provider":"email","providers":["email"],"demo_account":true}',
         '{"display_name":"Nguyễn Minh Anh","email_verified":true}',
         now() - interval '100 days', now(),
         '', '', '', '', '', '', '', '')`,
      [id, email, password]);
    await client.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1::text, $1::uuid,
               jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true, 'phone_verified', false),
               'email', null, now() - interval '100 days', now())`,
      [id, email]);
    console.log(`Created demo account ${email}`);
  } else {
    await client.query(
      `update auth.users
          set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 10)),
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              updated_at = now()
        where id = $1`, [rows[0].id, password]);
    console.log(`Demo account ${email} exists — password synced with .env, data will be rebuilt`);
  }

  await client.query(`select set_config('app.demo_email', $1, true)`, [email]);
  await client.query(readSql('supabase/seed.sql'));

  const { rows: [c] } = await client.query(
    `select
       (select count(*) from public.tasks          t where t.user_id = u.id) as tasks,
       (select count(*) from public.time_entries   t where t.user_id = u.id) as time_entries,
       (select count(*) from public.expenses       t where t.user_id = u.id) as expenses,
       (select count(*) from public.budgets        t where t.user_id = u.id) as budgets,
       (select count(*) from public.shopping_items t where t.user_id = u.id) as shopping_items,
       (select count(*) from public.kpis           t where t.user_id = u.id) as kpis,
       (select count(*) from public.kpi_records    t where t.user_id = u.id) as kpi_records,
       (select count(*) from public.categories     t where t.user_id = u.id) as categories,
       (select count(*) from public.activity_logs  t where t.user_id = u.id) as activity_logs
     from auth.users u where lower(u.email) = $1`, [email]);

  const { rows: [{ has_notes: hasNotes }] } = await client.query(
    `select to_regclass('public.notes') is not null as has_notes`);
  if (hasNotes) {
    const { rows: [n] } = await client.query(
      `select count(*) as notes from public.notes t join auth.users u on u.id = t.user_id where lower(u.email) = $1`,
      [email]);
    c.notes = n.notes;
  }

  await client.query('commit');
  console.log('\nSeeded rows:');
  console.table(c);
  console.log(`Sign in with ${email} and DEMO_PASSWORD from .env`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`Seed failed, nothing changed: ${formatPgError(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
