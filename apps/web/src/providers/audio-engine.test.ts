import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAudioEngineForTests,
  ensureCaptureWorklet,
  getCaptureContext,
  prewarmCapture,
  resumeCaptureContext,
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
});
