import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingRecovery, type RecoverySnapshot } from './meeting-recovery.js';

describe('meeting recovery ownership', () => {
  let state: RecoverySnapshot;
  let recovery: MeetingRecovery;
  const execute = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    execute.mockReset();
    state = {
      online: true,
      sessionRunning: true,
      sourceBlocked: false,
      selectedBackend: 'gemini',
      runningBackend: 'gemini',
      anyProviderRunning: true,
      transportState: 'reconnecting',
      available: { gemini: true, openai: true },
    };
    recovery = new MeetingRecovery(() => Date.now());
    recovery.begin();
  });
  afterEach(() => {
    recovery.cancel();
    vi.useRealTimers();
  });
  const update = () => recovery.update(state, () => state, execute);
  it.each([true, false])(
    'uses the existing handoff delay only for a different service after the old owner ended (alternate=%s)',
    (alternate) => {
      state.runningBackend = null;
      state.anyProviderRunning = false;
      state.transportState = 'failed';
      state.available.openai = alternate;
      update();
      vi.advanceTimersByTime(999);
      expect(execute).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      if (alternate) expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'openai' });
      else {
        expect(execute).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'gemini' });
      }
    },
  );
  it('retries the selected backend for a local audio setup failure without crossing vendors', () => {
    Object.assign(state, { sourceRetryOnly: true });
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'api_error';
    update();
    vi.advanceTimersByTime(2000);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'gemini' });
  });

  it('does not hand off a running backend for a local audio setup failure', () => {
    Object.assign(state, { sourceRetryOnly: true });
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(60000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a local audio retry on its selected backend while that service is cooling down', () => {
    Object.assign(state, { sourceRetryOnly: true });
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'api_error';
    state.failures = {
      gemini: {
        layer: 'provider',
        kind: 'rate-limit',
        provider: 'gemini',
        purpose: 'translation',
        attemptId: 'cooling',
        retryNotBeforeMs: 30000,
      },
    };
    update();
    vi.advanceTimersByTime(29999);
    expect(execute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'gemini' });
  });
  it('caps each timer without shortening a large server cooldown', () => {
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'failed';
    state.available.openai = false;
    state.failures = {
      gemini: {
        layer: 'provider',
        kind: 'rate-limit',
        provider: 'gemini',
        purpose: 'translation',
        attemptId: 'long',
        retryNotBeforeMs: 9_999_999_000,
      },
    };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    update();
    expect(timer.mock.calls.at(-1)?.[1]).toBe(2_147_483_647);
    vi.advanceTimersByTime(2_147_483_647);
    expect(execute).not.toHaveBeenCalled();
    expect(timer.mock.calls.at(-1)?.[1]).toBe(2_147_483_647);
    timer.mockRestore();
  });
  it('chooses the provider whose cooldown expires first when both are cooling down', () => {
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'failed';
    state.failures = {
      gemini: {
        layer: 'provider',
        kind: 'rate-limit',
        provider: 'gemini',
        purpose: 'translation',
        attemptId: 'g',
        retryNotBeforeMs: 30000,
      },
      openai: {
        layer: 'provider',
        kind: 'rate-limit',
        provider: 'openai',
        purpose: 'translation',
        attemptId: 'o',
        retryNotBeforeMs: 5000,
      },
    };
    update();
    vi.advanceTimersByTime(5000);
    expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'openai' });
  });

  it('refuses the permanent target without disabling the other provider', () => {
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'failed';
    state.failures = {
      openai: {
        layer: 'provider',
        kind: 'auth',
        provider: 'openai',
        purpose: 'translation',
        attemptId: 'a',
      },
    };
    update();
    vi.advanceTimersByTime(2000);
    expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'gemini' });
  });
  it('does not reset Retry-After when the meeting scheduler restarts', () => {
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'failed';
    state.available.openai = false;
    state.failures = {
      gemini: {
        layer: 'provider',
        kind: 'rate-limit',
        provider: 'gemini',
        purpose: 'translation',
        attemptId: 'a',
        retryNotBeforeMs: 60_000,
      },
    };
    update();
    vi.advanceTimersByTime(10_000);
    recovery.cancel();
    recovery.begin();
    update();
    vi.advanceTimersByTime(49_999);
    expect(execute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledWith({ kind: 'retry', target: 'gemini' });
  });

  it('counts one outage budget while allowing a pending attempt to finish', () => {
    update();
    vi.advanceTimersByTime(25_000);
    expect(execute).not.toHaveBeenCalled();
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(1_000);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenLastCalledWith({ kind: 'handoff', from: 'gemini', target: 'openai' });
  });

  it('gives the same vendor a head start, then brings the standby up', () => {
    // The failing backend reconnects on its own where it can, so the standby is
    // held back long enough for one same-vendor attempt. Beyond that the room is
    // the one paying: 數字① (docs/GOAL_PHASE_2.md) budgets 3 s for captions to
    // return, and a wait measured in tens of seconds spends it before anything
    // has even been tried.
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(999);
    expect(execute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenLastCalledWith({ kind: 'handoff', from: 'gemini', target: 'openai' });
  });

  it('rechecks transport at the deadline before React has rendered a new handshake', () => {
    // The first handoff is immediate, so the backed-off second attempt is where
    // a queued timer can outlive the state that scheduled it.
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(1_000);
    expect(execute).toHaveBeenCalledOnce();
    update();
    vi.advanceTimersByTime(3_999);
    state.transportState = 'reconnecting';
    vi.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledOnce();
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(4_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['source', 'stop', 'backend', 'offline'] as const)(
    'rejects stale action after %s changes',
    (change) => {
      state.transportState = 'failed';
      update();
      if (change === 'source') state.sourceBlocked = true;
      if (change === 'stop') state.sessionRunning = false;
      if (change === 'backend') state.selectedBackend = 'openai';
      if (change === 'offline') state.online = false;
      vi.advanceTimersByTime(20_000);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('connected ends the outage and returns the next one to an immediate handoff', () => {
    state.transportState = 'failed';
    update();
    vi.advanceTimersByTime(1_000);
    expect(execute).toHaveBeenCalledOnce();
    state.transportState = 'connected';
    update();
    state.transportState = 'failed';
    update();
    // Reset, so this outage is served from the start of the ladder rather than
    // inheriting the previous one's backoff.
    vi.advanceTimersByTime(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'retries idle backends with capped backoff without extending deadlines on rerender (alternate=%s)',
    (alternate) => {
      state.runningBackend = null;
      state.anyProviderRunning = false;
      state.transportState = 'api_error';
      state.available.openai = alternate;
      for (const delay of [alternate ? 1_000 : 2_000, 4_000, 8_000, 15_000, 15_000]) {
        update();
        vi.advanceTimersByTime(delay - 1);
        update();
        expect(vi.getTimerCount()).toBe(1);
        const calls = execute.mock.calls.length;
        vi.advanceTimersByTime(1);
        expect(execute).toHaveBeenCalledTimes(calls + 1);
        expect(execute).toHaveBeenLastCalledWith({
          kind: 'retry',
          target: alternate ? 'openai' : 'gemini',
        });
      }
    },
  );

  it('revalidates backend availability before an idle retry fires', () => {
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'api_error';
    update();
    state.available = { gemini: false, openai: false };
    vi.advanceTimersByTime(2_000);
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a second provider while an existing provider owns recovery', () => {
    state.transportState = 'failed';
    state.available.openai = false;
    update();
    vi.advanceTimersByTime(90_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Stop invalidates asynchronous completions and clears the timer synchronously', () => {
    state.transportState = 'failed';
    update();
    const generation = recovery.generation;
    recovery.cancel();
    expect(recovery.isCurrent(generation)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(90_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('beginning a new meeting resets backoff and invalidates old work', () => {
    const generation = recovery.generation;
    recovery.begin(true);
    expect(recovery.isCurrent(generation)).toBe(false);
    state.runningBackend = null;
    state.anyProviderRunning = false;
    state.transportState = 'api_error';
    update();
    vi.advanceTimersByTime(2_000);
    expect(execute).toHaveBeenCalledOnce();
  });
});
