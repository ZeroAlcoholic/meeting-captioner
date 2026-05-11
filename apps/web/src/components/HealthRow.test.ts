import { describe, expect, it } from 'vitest';
import { bucketOf } from './HealthRow.js';

describe('bucketOf — every CLAUDE.md health state is mapped', () => {
  const cases: Array<[Parameters<typeof bucketOf>[0], ReturnType<typeof bucketOf>]> = [
    ['idle', 'idle'],
    ['stopped', 'idle'],
    ['connecting', 'loading'],
    ['model_loading', 'loading'],
    ['connected', 'ok'],
    ['requesting_permission', 'warn'],
    ['reconnecting', 'warn'],
    ['silence_detected', 'warn'],
    ['degraded', 'degraded'],
    ['failed', 'error'],
    ['no_audio_track', 'error'],
    ['offline_engine_unavailable', 'error'],
    ['api_error', 'error'],
  ];

  for (const [state, expected] of cases) {
    it(`${state} → ${expected}`, () => {
      expect(bucketOf(state)).toBe(expected);
    });
  }
});
