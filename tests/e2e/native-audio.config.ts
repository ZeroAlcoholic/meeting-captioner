import { defineConfig, devices } from '@playwright/test';
import { nativeSoakMinutes } from './native-soak.js';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'native-audio.spec.ts',
    'native-webrtc.spec.ts',
    'meeting-preflight.spec.ts',
    'capture-health.spec.ts',
    'capture-device.spec.ts',
    'capture-recovery.spec.ts',
    'offline-capture-retry.spec.ts',
    'pure-recovery-policy.spec.ts',
  ],
  globalSetup: './native-audio-server.ts',
  workers: nativeSoakMinutes ? 2 : 1,
  projects: nativeSoakMinutes
    ? [
        { name: 'gemini', testMatch: 'native-audio.spec.ts' },
        {
          name: 'openai',
          testMatch: 'native-webrtc.spec.ts',
          use: { baseURL: 'http://127.0.0.1:5210' },
        },
      ]
    : undefined,
  grep: nativeSoakMinutes
    ? /transient=false, rate=16000, delayed=false|candidate closes=false/
    : undefined,
  timeout: nativeSoakMinutes ? nativeSoakMinutes * 60_000 + 60_000 : 30_000,
  globalTimeout: nativeSoakMinutes ? nativeSoakMinutes * 60_000 + 120_000 : undefined,
  forbidOnly: true,
  retries: 0,
  outputDir: nativeSoakMinutes
    ? '../../.cache/native-soak-results'
    : '../../.cache/native-audio-results',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    actionTimeout: 10_000,
    baseURL: 'http://127.0.0.1:5208',
    trace: nativeSoakMinutes ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
