import { describe, it, expect } from 'vitest';
import { DEPLOYMENT_MODE } from './deployment.js';
import { MODE_OPTIONS, SCENARIO_OPTIONS } from './settings/settings-store.js';

describe('deployment flag', () => {
  it('defaults to "full" when no build-time override is set', () => {
    // vitest does not pass through `define` injections, so DEPLOYMENT_MODE
    // falls back to import.meta.env.VITE_DEPLOYMENT_MODE, which is unset by
    // default → "full".
    expect(DEPLOYMENT_MODE).toBe('full');
  });

  it('full deployment exposes all three meeting modes', () => {
    expect(MODE_OPTIONS.map((m) => m.id)).toEqual([
      'online_full',
      'hybrid_privacy',
      'full_offline',
    ]);
  });

  it('full deployment exposes the hybrid scenario', () => {
    expect(SCENARIO_OPTIONS.some((s) => s.id === 'hybrid')).toBe(true);
  });
});
