import { defineConfig, devices } from '@playwright/test';
import { pureSoakMinutes } from './pure-soak.js';
export default defineConfig({
  testDir: '.',
  testMatch: [
    'pure-captions.spec.ts',
    'translation-archive.spec.ts',
    'deployment-boundaries.spec.ts',
  ],
  globalSetup: './pure-captions-server.ts',
  workers: 2,
  fullyParallel: true,
  projects: [{ name: 'chrome' }],
  timeout: pureSoakMinutes * 60000 + 150000,
  retries: 0,
  forbidOnly: true,
  outputDir: pureSoakMinutes ? '../../.cache/pure-soak-results' : '../../.cache/pure-e2e-results',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: pureSoakMinutes ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
