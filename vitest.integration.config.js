import { defineConfig } from 'vitest/config';

// Real Supabase stack (local Docker). Run: npx supabase start && npm run test:integration
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    setupFiles: ['tests/integration/setup.js'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
    // keep .env (hosted project) out of import.meta.env for these tests
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'local' },
  },
});
