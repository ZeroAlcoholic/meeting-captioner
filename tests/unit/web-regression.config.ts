import { defineConfig } from 'vitest/config';

// Restrict discovery to the affected TypeScript source trees. The default
// workspace scan can enter unrelated, unreadable Python caches on Windows.
export default defineConfig({
  test: {
    include: ['apps/web/src/**/*.test.{ts,tsx}', 'packages/contracts/src/**/*.test.ts'],
    setupFiles: ['./apps/web/src/test-setup.ts'],
  },
});
