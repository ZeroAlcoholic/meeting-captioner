import { describe, expect, it } from 'vitest';
import { HealthEvent, HealthState } from './health-event.js';

describe('HealthEvent', () => {
  const valid = {
    kind: 'health' as const,
    component: 'audio' as const,
    state: 'connected' as const,
    timestamp: '2026-05-11T10:00:00.000Z',
  };

  it('accepts a valid event', () => {
    expect(HealthEvent.parse(valid)).toEqual(valid);
  });

  it('accepts every required state from CLAUDE.md', () => {
    for (const state of HealthState.options) {
      expect(HealthEvent.parse({ ...valid, state })).toMatchObject({ state });
    }
  });

  it('rejects unknown component', () => {
    expect(() => HealthEvent.parse({ ...valid, component: 'mystery' })).toThrow();
  });
});
