import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecoveryAttempt,
  recoveryHttpError,
  assertRecoveryAllowed,
  clearRecoveryRefusal,
  recoveryFailureFor,
  normalizeRecoveryError,
  protocolRecoveryKind,
  __resetRecoveryFailuresForTests,
} from './recovery-attempt.js';

afterEach(() => {
  vi.useRealTimers();
  __resetRecoveryFailuresForTests();
});

describe('recovery attempt', () => {
  it.each([
    [{ code: 'invalid_api_key' }, 'auth'],
    [{ status: 'PERMISSION_DENIED' }, 'auth'],
    [{ code: 'RESOURCE_EXHAUSTED' }, 'rate-limit'],
    [{ status: 429 }, 'rate-limit'],
    [{ code: 'model_not_found' }, 'unsupported'],
    [{ status: 'UNIMPLEMENTED' }, 'unsupported'],
    [{ code: 'unknown', message: 'auth failed' }, 'network'],
    [{ code: 429, status: 'RESOURCE_EXHAUSTED' }, 'rate-limit'],
    [{ code: 401, status: 'UNAUTHENTICATED' }, 'auth'],
    [{ code: 429 }, 'rate-limit'],
  ])('classifies structured protocol evidence, not human message strings', (value, kind) => {
    expect(protocolRecoveryKind(value)).toBe(kind);
  });
  it('does not weaken a permanent refusal or a longer cooldown with a late network failure', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    recoveryHttpError(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
      'openai',
      'translation',
    );
    recoveryHttpError(new Response(null, { status: 401 }), 'openai', 'translation');
    normalizeRecoveryError(new TypeError('network'), 'openai', 'translation');
    expect(recoveryFailureFor('openai', 'translation')).toMatchObject({
      kind: 'auth',
      retryNotBeforeMs: 60000,
    });
    clearRecoveryRefusal('openai', 'translation');
    expect(recoveryFailureFor('openai', 'translation')).toMatchObject({
      kind: 'rate-limit',
      retryNotBeforeMs: 60000,
    });
    expect(() => assertRecoveryAllowed('openai', 'translation')).toThrow();
  });
  it('preserves a 429 monotonic deadline across attempts and manual retry', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout'] });
    const error = recoveryHttpError(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
      'openai',
      'transcription',
    );
    expect(error.failure).toMatchObject({
      kind: 'rate-limit',
      provider: 'openai',
      retryNotBeforeMs: 60_000,
    });
    clearRecoveryRefusal('openai', 'transcription');
    vi.setSystemTime(Date.now() + 3600_000);
    expect(() => assertRecoveryAllowed('openai', 'transcription')).toThrow();
    expect(() => assertRecoveryAllowed('gemini', 'transcription')).not.toThrow();
    vi.advanceTimersByTime(60_000);
    expect(() => assertRecoveryAllowed('openai', 'transcription')).not.toThrow();
  });
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [400, 'unsupported'],
    [404, 'unsupported'],
    [409, 'network'],
    [425, 'network'],
    [502, 'network'],
  ] as const)('classifies HTTP %s without exposing response bodies', (status, kind) => {
    const error = recoveryHttpError(new Response('SECRET', { status }), 'gemini', 'translation');
    expect(error.failure.kind).toBe(kind);
    expect(error.message).not.toContain('SECRET');
    if (kind !== 'network') {
      expect(() => assertRecoveryAllowed('gemini', 'translation')).toThrow();
      clearRecoveryRefusal('gemini', 'translation');
      expect(() => assertRecoveryAllowed('gemini', 'translation')).not.toThrow();
    }
  });
  it('converts HTTP-date Retry-After to monotonic time once', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    vi.setSystemTime('2026-10-15T00:00:00.000Z');
    const error = recoveryHttpError(
      new Response(null, {
        status: 429,
        headers: { 'Retry-After': 'Thu, 15 Oct 2026 00:01:00 GMT' },
      }),
      'gemini',
      'transcription',
    );
    expect(error.failure.retryNotBeforeMs).toBe(60_000);
  });
  it('shares one deadline across operations and aborts a noncooperative wait', async () => {
    vi.useFakeTimers();
    const attempt = createRecoveryAttempt({ generation: 1, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(8_000);
    await attempt.run(async () => 'first');
    const pending = attempt.run(() => new Promise<string>(() => {}));
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(4_000);
    await rejected;
    expect(attempt.signal.aborted).toBe(true);
    attempt.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an old generation result and never enters another operation', async () => {
    let generation = 1;
    const attempt = createRecoveryAttempt({
      generation: 1,
      isCurrent: (value) => value === generation,
    });
    let resolve!: (value: string) => void;
    const pending = attempt.run(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    generation = 2;
    resolve('stale');
    await expect(pending).rejects.toThrow(/superseded/);
    const next = vi.fn(async () => 'new side effect');
    await expect(attempt.run(next)).rejects.toThrow(/superseded/);
    expect(next).not.toHaveBeenCalled();
    attempt.dispose();
  });

  it('propagates parent cancellation and releases listeners and timers', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const attempt = createRecoveryAttempt({
      parentSignal: parent.signal,
      generation: 1,
      isCurrent: () => true,
    });
    const pending = attempt.run(() => new Promise<void>(() => {}));
    parent.abort(new Error('Stopped'));
    await expect(pending).rejects.toThrow('Stopped');
    attempt.dispose();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
