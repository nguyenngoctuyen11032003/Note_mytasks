// Shared helpers for the database scripts (Node only — never bundled by Vite).
//
// Reads DATABASE_URL (and DEMO_* for the seed) from the environment or the
// local, git-ignored `.env`. Secrets are never printed: errors show the host only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CA_FILE = path.join(ROOT, 'supabase/certs/supabase-root-2021-ca.crt');

export function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...env, ...process.env };
}

export function readSql(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

export function migrationFiles() {
  const dir = path.join(ROOT, 'supabase/migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// Connects with full TLS verification against Supabase's public root CA.
// Local databases (localhost) connect without TLS.
export async function connect() {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (put it in .env — never in a VITE_ variable)');
  }
  const url = new URL(env.DATABASE_URL);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(k);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: local ? false : { ca: fs.readFileSync(CA_FILE, 'utf8'), rejectUnauthorized: true },
    application_name: 'note-mytasks-scripts',
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`cannot connect to ${url.hostname}:${url.port || 5432} — ${err.message}`);
  }
  return { client, host: url.hostname };
}

export function formatPgError(err) {
  const parts = [err.message];
  if (err.code) parts.push(`(SQLSTATE ${err.code})`);
  if (err.where) parts.push(`\n  at ${err.where.split('\n')[0]}`);
  return parts.join(' ');
}
