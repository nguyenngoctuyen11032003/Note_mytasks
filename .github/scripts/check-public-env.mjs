// Guard: everything in VITE_* is bundled into public JS. Fail the build if the
// Supabase key is anything other than the public anon / publishable key.
//
// Usage: node .github/scripts/check-public-env.mjs [--strict]
//   --strict  require both values to be set (production deploy)

const strict = process.argv.includes('--strict');
const url = (process.env.VITE_SUPABASE_URL || '').trim();
const key = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const errors = [];

if (!url || !key) {
  if (strict) errors.push('VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY phải được đặt trong GitHub → Settings → Secrets and variables → Actions → Variables.');
} else {
  if (!/^https:\/\/[^/]+$/.test(url.replace(/\/$/, ''))) {
    errors.push('VITE_SUPABASE_URL phải có dạng https://<project-ref>.supabase.co');
  }

  if (key.startsWith('sb_secret_')) {
    errors.push('VITE_SUPABASE_ANON_KEY đang là SECRET key (sb_secret_…). Chỉ dùng publishable/anon key.');
  } else if (key.startsWith('eyJ')) {
    let role;
    try {
      const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      role = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role;
    } catch {
      errors.push('VITE_SUPABASE_ANON_KEY không phải JWT hợp lệ.');
    }
    if (role && role !== 'anon') {
      errors.push(`VITE_SUPABASE_ANON_KEY có role "${role}" — chỉ được dùng key role "anon".`);
    }
  } else if (!key.startsWith('sb_publishable_')) {
    errors.push('VITE_SUPABASE_ANON_KEY không giống anon JWT (eyJ…) hay publishable key (sb_publishable_…).');
  }
}

// Any other VITE_* variable that looks like a secret would also be bundled.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('VITE_') && /SECRET|PASSWORD|SERVICE_ROLE|PRIVATE|DB_URL|DATABASE/i.test(name)) {
    errors.push(`${name} trông giống secret nhưng có tiền tố VITE_ → sẽ bị lộ trong bundle.`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(url && key ? 'Public env OK (anon/publishable key only).' : 'Public env not set — build continues with empty values (non-strict).');
