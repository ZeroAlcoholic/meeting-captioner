import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'meeting-recovery.spec.ts',
    'online-keepalive.spec.ts',
    'archive-revisions.spec.ts',
    'origin-recovery.spec.ts',
    'storage-faults.spec.ts',
    'audio-replay-contract.spec.ts',
    'meeting-backup.spec.ts',
    'meeting-restore.spec.ts',
    'archive-generation.spec.ts',
    'service-recovery.spec.ts',
    'separate-tracks.spec.ts',
  ],
  globalSetup: '../../apps/web/test/continuity-server.ts',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  outputDir: '../../.cache/continuity-browser-results',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5207',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
