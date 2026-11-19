import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'assertion-reporting.spec.ts',
  workers: 1,
  timeout: 120_000,
  globalTimeout: 260_000,
  retries: 0,
  forbidOnly: true,
  outputDir: '../../.cache/assertion-reporting-results',
  // Tests request no page/context/browser fixtures and launch no browser.
});
