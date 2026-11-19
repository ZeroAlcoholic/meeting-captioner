import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startSessionInfoPolling } from './session-info-polling.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('includes a stalled response body in the deadline and ignores its late result', async () => {
  let resolveBody!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    }),
  );
  const available = vi.fn();
  const unavailable = vi.fn();
  const stop = startSessionInfoPolling('/session/info', available, unavailable);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(unavailable).toHaveBeenCalledTimes(1);
  resolveBody({ hasApiKey: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(available).not.toHaveBeenCalled();
  stop();
});
it('treats HTTP errors as unavailable, then recovers on a successful retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: vi.fn() })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ hasApiKey: true }) }),
  );
  const available = vi.fn();
  const unavailable = vi.fn();
  const stop = startSessionInfoPolling('/session/info', available, unavailable);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(unavailable).toHaveBeenCalledTimes(1);
  expect(available).toHaveBeenCalledWith({ hasApiKey: true });
  stop();
});
