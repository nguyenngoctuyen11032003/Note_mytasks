import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
  },
});
