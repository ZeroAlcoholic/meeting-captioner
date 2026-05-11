import { describe, expect, it } from 'vitest';
import { NormalizedEvent } from './index.js';

describe('NormalizedEvent (discriminated union)', () => {
  it('routes a transcript event by kind', () => {
    const e = NormalizedEvent.parse({
      kind: 'transcript',
      provider: 'p',
      mode: 'full_offline',
      source: 'fake_replay',
      segmentId: 's1',
      status: 'final',
      text: 'hi',
      startMs: 0,
    });
    expect(e.kind).toBe('transcript');
  });

  it('routes a health event by kind', () => {
    const e = NormalizedEvent.parse({
      kind: 'health',
      component: 'transport',
      state: 'reconnecting',
      timestamp: '2026-05-11T10:00:00.000Z',
    });
    expect(e.kind).toBe('health');
  });

  it('rejects an event with an unknown kind', () => {
    expect(() => NormalizedEvent.parse({ kind: 'mystery' })).toThrow();
  });
});
