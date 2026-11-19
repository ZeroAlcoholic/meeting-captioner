import { describe, it, expect, vi } from 'vitest';
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

  it('online-only distinguishes missing offline STT from missing dual capture', async () => {
    vi.resetModules();
    vi.doMock('./deployment.js', () => ({ IS_ONLINE_ONLY: true }));
    try {
      const settings = await import('./settings/settings-store.js');
      const hybridMeeting = settings.SCENARIO_OPTIONS.find((s) => s.id === 'hybrid');
      const hybridPrivacy = settings.MODE_OPTIONS.find((m) => m.id === 'hybrid_privacy');
      expect(hybridMeeting?.enabled).toBe(false);
      expect(hybridMeeting?.hint).toContain('雙軌');
      expect(hybridPrivacy?.enabled).toBe(false);
      expect(hybridPrivacy?.hint).toContain('offline STT');
      const store = settings.createSettingsStore();
      store.getState().setScenario('online_meeting_box');
      store.getState().setScenario('hybrid');
      expect(store.getState().scenarioId).toBe('online_meeting_box');
      expect(store.getState().audioSource).toBe('system');
    } finally {
      vi.doUnmock('./deployment.js');
      vi.resetModules();
    }
  });
});
