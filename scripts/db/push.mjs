// Applies pending supabase/migrations to the database in DATABASE_URL (.env).
//
//   npm run db:push               -> apply pending migrations
//   npm run db:push -- --dry-run  -> only list what would be applied
//
// Wraps `supabase db push --db-url` so the URL (it contains the password)
// never has to be typed, and scrubs it from the CLI output.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, loadEnv } from './lib.mjs';

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env');
  process.exit(1);
}

// Run npm's npx through node itself — no shell, so the URL's characters
// (&, ^, %, @ …) are passed verbatim instead of being parsed by cmd.exe.
const npxCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
const args = [npxCli, '-y', 'supabase@2.120.0', 'db', 'push', '--db-url', env.DATABASE_URL, '--workdir', ROOT,
  ...process.argv.slice(2)];
const res = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  input: 'y\n',                       // answer the CLI's confirmation prompt
});
if (res.error) {
  console.error(`cannot start the Supabase CLI: ${res.error.message}`);
  process.exit(1);
}

const scrub = (s) => (s || '').split(env.DATABASE_URL).join('<DATABASE_URL>')
  .replace(/postgres(ql)?:\/\/\S+/g, '<DATABASE_URL>')
  .split('\n').filter((l) => !l.includes('does not exist, skipping')).join('\n');
process.stdout.write(scrub(res.stdout));
process.stderr.write(scrub(res.stderr));
process.exitCode = res.status ?? 1;
