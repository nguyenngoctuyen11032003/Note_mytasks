import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stamps dist/sw.js (copied from public/) with a build id and the list of
 * emitted files, so each deploy ships a byte-different service worker (the
 * browser only installs a new worker when sw.js changes) that precaches the
 * whole app shell for offline use. No dependency — plain Rollup hook.
 */
function nmServiceWorker() {
  return {
    name: 'nm-service-worker',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir || 'dist';
      const file = join(outDir, 'sw.js');
      if (!existsSync(file)) return;
      const files = Object.keys(bundle)
        .filter((f) => /\.(js|css|svg|png|woff2?|webmanifest)$/.test(f) && !f.endsWith('.map'))
        .sort();
      const id = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const src = readFileSync(file, 'utf8')
        .replace('__NM_BUILD_ID__', id)
        .replace('/*__NM_PRECACHE__*/', files.map((f) => JSON.stringify('./' + f)).join(','));
      writeFileSync(file, src);
    },
  };
}

// base './' keeps asset URLs relative so the build works under
// https://<user>.github.io/<repo>/ without hard-coding the repo name.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 700 },
  plugins: [nmServiceWorker()],
});
