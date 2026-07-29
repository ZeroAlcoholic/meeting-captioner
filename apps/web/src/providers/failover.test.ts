import { describe, expect, it } from 'vitest';
import { computeFailover } from './failover.js';

describe('computeFailover — cross-model failover decision (#21)', () => {
  const base = {
    isOnlineMode: true,
    runningBackend: 'openai' as const,
    paused: false,
    transportState: 'failed',
    availableBackends: { openai: true, gemini: true },
  };

  it('offers a switch to Gemini when a running OpenAI backend has failed', () => {
    const d = computeFailover(base);
    expect(d).toEqual({ show: true, fromLabel: 'OpenAI', toLabel: 'Gemini', target: 'gemini' });
  });

  it('offers a switch to OpenAI when a running Gemini backend has failed', () => {
    const d = computeFailover({ ...base, runningBackend: 'gemini' });
    expect(d).toEqual({ show: true, fromLabel: 'Gemini', toLabel: 'OpenAI', target: 'openai' });
  });

  it('stays hidden while transport is merely reconnecting (self-heal still trying quietly)', () => {
    expect(computeFailover({ ...base, transportState: 'reconnecting' }).show).toBe(false);
    expect(computeFailover({ ...base, transportState: 'connected' }).show).toBe(false);
  });

  it('stays hidden when no online backend is actually running (initial-connect failure → launcher handles it)', () => {
    expect(computeFailover({ ...base, runningBackend: null }).show).toBe(false);
  });

  it('stays hidden while paused (manual Resume/switch owns that case)', () => {
    expect(computeFailover({ ...base, paused: true }).show).toBe(false);
  });

  it('stays hidden outside online mode (offline/hybrid have no second model)', () => {
    expect(computeFailover({ ...base, isOnlineMode: false }).show).toBe(false);
  });

  it('stays hidden when the target backend is unavailable', () => {
    expect(
      computeFailover({ ...base, availableBackends: { openai: true, gemini: false } }),
    ).toEqual({ show: false, fromLabel: '', toLabel: '', target: null });

    expect(
      computeFailover({
        ...base,
        runningBackend: 'gemini',
        availableBackends: { openai: false, gemini: true },
      }),
    ).toEqual({ show: false, fromLabel: '', toLabel: '', target: null });
  });

  it('a hidden decision carries no labels/target (nothing to render or act on)', () => {
    expect(computeFailover({ ...base, transportState: 'connected' })).toEqual({
      show: false,
      fromLabel: '',
      toLabel: '',
      target: null,
    });
  });
});
