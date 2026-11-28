import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAudioEngineForTests,
  ensureCaptureWorklet,
  getCaptureContext,
  isAudioContextPaused,
  pcmChunkSizeForRate,
  prewarmCapture,
  resamplePcm,
  resumeCaptureContext,
  resumeAudioContext,
} from './audio-engine.js';

// NOTE: the global beforeEach in test-setup already resets the engine; we also
// reset locally so this file is self-contained if run in isolation.

let addModule: ReturnType<typeof vi.fn>;
let resume: ReturnType<typeof vi.fn>;
let constructed: number;

function installFakeAudioContext(initialState: AudioContextState = 'suspended'): void {
  addModule = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(function (this: { state: string }) {
    this.state = 'running';
    return Promise.resolve();
  });
  constructed = 0;
  class FakeAudioContext {
    state = initialState;
    destination = {};
    audioWorklet = { addModule };
    resume = resume;
    constructor() {
      constructed += 1;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return { fftSize: 2048, connect() {}, disconnect() {} } as unknown as AnalyserNode;
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
}

describe('audio-engine', () => {
  beforeEach(() => {
    __resetAudioEngineForTests();
    installFakeAudioContext();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetAudioEngineForTests();
  });

  it('getCaptureContext returns ONE shared instance (reused across calls)', () => {
    const a = getCaptureContext();
    const b = getCaptureContext();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(constructed).toBe(1); // built once, not per call
  });

  it('re-creates the context only after it was closed', () => {
    const a = getCaptureContext();
    expect(constructed).toBe(1);
    (a as unknown as { close(): void }).close(); // state → 'closed'
    const b = getCaptureContext();
    expect(constructed).toBe(2);
    expect(b).not.toBe(a);
  });

  it('ensureCaptureWorklet loads the module exactly once per context', async () => {
    const ctx = getCaptureContext()!;
    await ensureCaptureWorklet(ctx);
    await ensureCaptureWorklet(ctx);
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith('/pcm-worklet.js');
  });

  it('resumeCaptureContext resumes a suspended context and is a no-op when running', async () => {
    await resumeCaptureContext();
    expect(resume).toHaveBeenCalledTimes(1);
    // Now running → second call must not resume again.
    await resumeCaptureContext();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('prewarmCapture warms the context + worklet, and preconnects ONLY when online', () => {
    const appended: Array<{ rel: string; href: string }> = [];
    vi.stubGlobal('document', {
      head: { appendChild: (l: { rel: string; href: string }) => appended.push(l) },
      createElement: () => ({ rel: '', href: '', crossOrigin: '' }),
    });

    // Offline: no preconnect, but context + worklet still warmed.
    prewarmCapture({ online: false });
    expect(constructed).toBe(1);
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(0);

    // Online: preconnect the two realtime backends.
    prewarmCapture({ online: true });
    expect(appended.map((l) => l.href)).toEqual([
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
    ]);
    // Idempotent: a second online prewarm does not double-append.
    prewarmCapture({ online: true });
    expect(appended).toHaveLength(2);
  });

  it('getCaptureContext returns null when AudioContext is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    __resetAudioEngineForTests();
    expect(getCaptureContext()).toBeNull();
  });
  it('automatically retries one rejected module load and shares the recovered result', async () => {
    addModule.mockRejectedValueOnce(new Error('temporary module download failure'));
    const ctx = getCaptureContext()!;
    await Promise.all([ensureCaptureWorklet(ctx), ensureCaptureWorklet(ctx)]);
    expect(addModule).toHaveBeenCalledTimes(2);
    await ensureCaptureWorklet(ctx);
    expect(addModule).toHaveBeenCalledTimes(2);
  });

  it('does not poison later attempts after both module loads fail', async () => {
    addModule
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'));
    const ctx = getCaptureContext()!;
    await expect(ensureCaptureWorklet(ctx)).rejects.toThrow('second failure');
    await expect(ensureCaptureWorklet(ctx)).resolves.toBeUndefined();
    expect(addModule).toHaveBeenCalledTimes(3);
  });

  it('bounds a hung module wait without starting a duplicate native registration', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    addModule.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const ctx = getCaptureContext()!;
    let failure: unknown;
    void ensureCaptureWorklet(ctx).catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/i);
    const second = ensureCaptureWorklet(ctx);
    expect(addModule).toHaveBeenCalledTimes(1);
    finish();
    await expect(second).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels one module waiter without cancelling another owner or closing the context', async () => {
    let finish!: () => void;
    addModule.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const ctx = getCaptureContext()!;
    const owner = new AbortController();
    let failure: unknown;
    void ensureCaptureWorklet(ctx, owner.signal).catch((error) => {
      failure = error;
    });
    const second = ensureCaptureWorklet(ctx);
    owner.abort(new Error('owner cancelled'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((failure as Error | undefined)?.message).toBe('owner cancelled');
    finish();
    await second;
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(ctx.state).not.toBe('closed');
  });

  it('does not start native work for an already cancelled caller', async () => {
    const owner = new AbortController();
    owner.abort(new Error('cancelled'));
    await expect(ensureCaptureWorklet(getCaptureContext()!, owner.signal)).rejects.toThrow(
      'cancelled',
    );
    await expect(resumeCaptureContext(owner.signal)).rejects.toThrow('cancelled');
    expect(addModule).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('reports an unavailable worklet instead of caching unsupported capture as success', async () => {
    const ctx = getCaptureContext()!;
    Object.defineProperty(ctx, 'audioWorklet', { value: undefined });
    await expect(ensureCaptureWorklet(ctx)).rejects.toThrow(/AudioWorklet unavailable/);
  });

  it('propagates resume failure and permits a later gesture to retry', async () => {
    resume.mockRejectedValueOnce(new Error('autoplay denied'));
    await expect(resumeCaptureContext()).rejects.toThrow('autoplay denied');
    await expect(resumeCaptureContext()).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung resume and shares the still-pending native resume on retry', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    resume.mockImplementation(function (this: { state: string }) {
      return new Promise<void>((resolve) => {
        finish = () => {
          this.state = 'running';
          resolve();
        };
      });
    });
    let failure: unknown;
    void resumeCaptureContext().catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/i);
    const second = resumeCaptureContext();
    expect(resume).toHaveBeenCalledTimes(1);
    finish();
    await second;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not call a suspended context successfully resumed unless it is running', async () => {
    resume.mockResolvedValue(undefined);
    await expect(resumeCaptureContext()).rejects.toThrow(/not running/);
  });
  it('resumes a private display context without touching the shared capture context', async () => {
    const shared = getCaptureContext()!;
    const display = new AudioContext();
    await resumeAudioContext(display);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.contexts[0]).toBe(display);
    expect(display.state).toBe('running');
    expect(shared.state).toBe('suspended');
  });

  it('uses a fresh local module URL after failures without changing a loaded context', async () => {
    addModule
      .mockRejectedValueOnce(new Error('HTTP 503 cached by browser module map'))
      .mockRejectedValueOnce(new Error('HTTP 503 still unavailable'));
    const ctx = getCaptureContext()!;
    await expect(ensureCaptureWorklet(ctx)).rejects.toThrow('HTTP 503 still unavailable');
    await ensureCaptureWorklet(ctx);
    await ensureCaptureWorklet(ctx);
    expect(addModule.mock.calls.map((call) => call[0])).toEqual([
      '/pcm-worklet.js',
      '/pcm-worklet.js?attempt=1',
      '/pcm-worklet.js?attempt=2',
    ]);
    expect(getCaptureContext()).toBe(ctx);
    expect(constructed).toBe(1);
  });

  it('recognizes both suspended and iOS interrupted states as paused', () => {
    expect(isAudioContextPaused('suspended')).toBe(true);
    expect(isAudioContextPaused('interrupted')).toBe(true);
    expect(isAudioContextPaused('running')).toBe(false);
    expect(isAudioContextPaused('closed')).toBe(false);
    expect(isAudioContextPaused(undefined)).toBe(false);
  });

  it('scales PCM chunk size proportionally to sample rate (~32 ms)', () => {
    expect(pcmChunkSizeForRate(16_000)).toBe(512);
    expect(pcmChunkSizeForRate(48_000)).toBe(1536);
    expect(pcmChunkSizeForRate(44_100)).toBe(1411);
    expect(pcmChunkSizeForRate(0)).toBe(512);
  });

  it('downsamples 48kHz PCM to 16kHz seamlessly across chunks', () => {
    const state = { pos: 0, last: 0 };
    const chunkA = new Float32Array(1536).fill(0.5);
    const chunkB = new Float32Array(1536).fill(-0.25);
    const outA = resamplePcm(chunkA, 48_000, 16_000, state);
    const outB = resamplePcm(chunkB, 48_000, 16_000, state);
    expect(outA).toHaveLength(512);
    expect(outB).toHaveLength(512);
    expect(outA[0]).toBeCloseTo(0.5, 5);
    expect(outB[511]).toBeCloseTo(-0.25, 5);
  });

  it('attenuates high-frequency aliasing while preserving speech band during 48kHz -> 16kHz downsampling', () => {
    const totalSamples = 4800; // 100 ms @ 48 kHz
    const speech1kHz = new Float32Array(totalSamples);
    const alias16kHz = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      // 1 kHz speech fundamental + phase offset that would alias to DC under naive point decimation
      speech1kHz[i] = Math.sin((2 * Math.PI * 1000 * i) / 48_000);
      alias16kHz[i] = Math.cos((2 * Math.PI * 16_000 * i) / 48_000);
    }
    const speechOut = resamplePcm(speech1kHz, 48_000, 16_000, { pos: 0, last: 0 });
    const aliasOut = resamplePcm(alias16kHz, 48_000, 16_000, { pos: 0, last: 0 });
    const rms = (arr: Float32Array) =>
      Math.sqrt(arr.reduce((sum, x) => sum + x * x, 0) / arr.length);

    // 1 kHz speech fundamental retains strong energy (~0.676 RMS vs 0.707 original).
    expect(rms(speechOut)).toBeGreaterThan(0.6);
    // 16 kHz interference (which folds straight to 0 Hz DC under naive decimation with RMS=1.0)
    // is completely nulled out by the 3-sample boxcar anti-aliasing filter.
    expect(rms(aliasOut)).toBeLessThan(1e-5);
  });
});
