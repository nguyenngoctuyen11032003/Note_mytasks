// Integration tests run against a LOCAL Supabase stack only (`npx supabase start`):
// real Postgres + PostgREST + GoTrue, real supabase-js — never the hosted project.
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

function localStatus() {
  if (process.env.IT_SUPABASE_URL && process.env.IT_ANON_KEY && process.env.IT_SERVICE_KEY) {
    return { url: process.env.IT_SUPABASE_URL, anon: process.env.IT_ANON_KEY, service: process.env.IT_SERVICE_KEY };
  }
  let out;
  try {
    out = execSync('npx supabase status -o json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error('Local Supabase is not running. Start it with: npx supabase start');
  }
  const s = JSON.parse(out.slice(out.indexOf('{')));
  const st = { url: s.API_URL, anon: s.ANON_KEY, service: s.SERVICE_ROLE_KEY };
  if (!st.url || !st.anon || !st.service) {
    throw new Error(`Unexpected \`supabase status\` output (keys: ${Object.keys(s).join(', ')}). Set IT_SUPABASE_URL, IT_ANON_KEY, IT_SERVICE_KEY.`);
  }
  Object.assign(process.env, { IT_SUPABASE_URL: st.url, IT_ANON_KEY: st.anon, IT_SERVICE_KEY: st.service });
  return st;
}

export const LOCAL = localStatus();
const host = new URL(LOCAL.url).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error(`Refusing to run integration tests against non-local Supabase (${host})`);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** service_role client — test setup/inspection only, bypasses RLS. */
export const admin = createClient(LOCAL.url, LOCAL.service, opts);

/** Fresh anon client (signed out). */
export const anonClient = () => createClient(LOCAL.url, LOCAL.anon, opts);

/**
 * Create a confirmed user and return a signed-in anon-key client for it — exactly what
 * the browser has after login. { client, user, email, password }
 */
export async function newUser({ displayName } = {}) {
  const email = `it-${randomUUID().slice(0, 12)}@example.test`;
  const password = 'Test-pass-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: displayName ? { display_name: displayName } : {},
  });
  if (error) throw error;
  const client = anonClient();
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { client, user: data.user, email, password };
}

export async function deleteUser(user) {
  if (user?.id) await admin.auth.admin.deleteUser(user.id);
}

/** Today in Asia/Ho_Chi_Minh (the default profile timezone). */
export const todayVN = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
