import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  globalSetup: '../../apps/web/test/continuity-server.ts',
  // These suites use their own production-bundle or no-browser configuration.
  // The dev-server suite has neither their server setup nor their time budgets.
  testIgnore: [
    'native-audio.spec.ts',
    'native-webrtc.spec.ts',
    'meeting-preflight.spec.ts',
    'native-caption-performance.spec.ts',
    'assertion-reporting.spec.ts',
    'pure-captions.spec.ts',
    'pure-recovery-policy.spec.ts',
    // A measurement run against a named corpus, not a regression.
    'caption-eval.spec.ts',
    'deployment-boundaries.spec.ts',
  ],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5207',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.platform === 'win32' ? 'chrome' : undefined,
      },
    },
  ],
});
