// Runs supabase/tests/*.test.sql against the database inside BEGIN ... ROLLBACK.
//
//   npm run db:test                      -> tests against the already-migrated schema
//   npm run db:test -- --with-migrations -> applies supabase/migrations/*.sql first,
//                                           in the same rolled-back transaction
//                                           (dry run of a migration before `db push`)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, connect, migrationFiles, formatPgError } from './lib.mjs';

const withMigrations = process.argv.includes('--with-migrations');
const testDir = path.join(ROOT, 'supabase/tests');
const tests = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.sql')).sort();

const { client, host } = await connect();
console.log(`Connected to ${host} (TLS verified)\n`);

let passed = 0;
let failed = 0;
client.on('notice', (n) => {
  if (n.message.startsWith('ok: ')) {
    passed += 1;
    console.log(`  ✓ ${n.message.slice(4)}`);
  }
});

for (const file of tests) {
  console.log(`▶ ${file}${withMigrations ? '  (with migrations, dry run)' : ''}`);
  try {
    await client.query('begin');
    if (withMigrations) {
      for (const m of migrationFiles()) {
        await client.query(m.sql);
        console.log(`  · applied ${m.name}`);
      }
    }
    await client.query(fs.readFileSync(path.join(testDir, file), 'utf8'));
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${formatPgError(err)}`);
  } finally {
    await client.query('rollback').catch(() => {});
  }
}

await client.end();
console.log(`\n${passed} checks passed, ${failed} file(s) failed — all changes rolled back.`);
process.exitCode = failed ? 1 : 0;
