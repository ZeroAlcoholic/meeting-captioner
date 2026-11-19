import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'native-caption-performance.spec.ts',
  globalSetup: './native-audio-server.ts',
  workers: 1,
  timeout: 180_000,
  globalTimeout: 420_000,
  retries: 0,
  forbidOnly: true,
  outputDir: '../../.cache/native-caption-performance-results',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5208',
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
