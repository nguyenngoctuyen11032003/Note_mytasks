import { defineConfig } from 'vite';

// base './' keeps asset URLs relative so the build works under
// https://<user>.github.io/<repo>/ without hard-coding the repo name.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 700 },
});
