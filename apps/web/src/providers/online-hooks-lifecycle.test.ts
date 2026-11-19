import type { CaptionProviderHandlers } from './types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  state: vi.fn(),
  handlerOptions: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  health: vi.fn(),
  restoredHealth: vi.fn(),
  transcript: vi.fn(),
  translation: vi.fn(),
  audioLevel: vi.fn(),
  flush: vi.fn(),
  cancelGemini: vi.fn(),
  cancelOpenAI: vi.fn(),
  providers: [] as Array<{
    handlers: CaptionProviderHandlers;
    stop: ReturnType<typeof vi.fn>;
    finish: () => void;
  }>,
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, harness.state],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock('../settings/use-settings-store.js', () => {
  const state = {
    modeId: 'offline_full',
    onlineProvider: 'gemini',
    langPair: 'en-zh',
    micDistance: 'close',
    audioSource: 'mic',
    applyHealth: harness.restoredHealth,
  };
  return {
    settingsStore: { getState: () => state },
    useSettingsStore: (selector: (s: unknown) => unknown) => selector(state),
  };
});
vi.mock('./capture-lease.js', () => ({ leaseCapture: () => ({}) }));
vi.mock('./coalesce-handlers.js', () => ({
  createStoreBoundHandlers: (options: unknown) => {
    harness.handlerOptions(options);
    return {
      onHealth: harness.health,
      onTranscript: harness.transcript,
      onTranslation: harness.translation,
      onAudioLevel: harness.audioLevel,
      flushPending: harness.flush,
      finish: harness.flush,
    };
  },
}));
vi.mock('./gemini-live-provider.js', () => ({
  GeminiLiveProvider: class {
    status = 'running';
    waitForStop() {
      return Promise.resolve();
    }
    handlers: CaptionProviderHandlers;
    stop = vi.fn(() => {
      this.status = 'stopped';
    });
    finish!: () => void;
    constructor(_url: string, handlers: CaptionProviderHandlers) {
      this.handlers = handlers;
      harness.providers.push(this);
    }
    start() {
      return new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    }
  },
  prewarmGeminiSession: vi.fn(),
  cancelGeminiPrewarm: harness.cancelGemini,
}));
vi.mock('./openai-realtime-provider.js', () => ({
  OpenAIRealtimeProvider: class {
    status = 'running';
    waitForStop() {
      return Promise.resolve();
    }
    handlers: CaptionProviderHandlers;
    stop = vi.fn(() => {
      this.status = 'stopped';
    });
    finish!: () => void;
    constructor(_url: string, handlers: CaptionProviderHandlers) {
      this.handlers = handlers;
      harness.providers.push(this);
    }
    start() {
      return new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    }
    onStatus() {
      return vi.fn();
    }
    getRenewalEtaMs() {
      return null;
    }
  },
  prewarmOpenAISession: vi.fn(),
  cancelOpenAIPrewarm: harness.cancelOpenAI,
  sessionRequestBody: vi.fn(),
}));
import { useGeminiLive } from './use-gemini-live.js';
import { useOpenAIRealtime } from './use-openai-realtime.js';

describe.each([
  ['Gemini', useGeminiLive],
  ['OpenAI', useOpenAIRealtime],
] as const)('%s hook lifecycle', (_name, useHook) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.effects.length = 0;
    harness.providers.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function mount() {
    const hook = useHook();
    const cleanups = harness.effects.map((effect) => effect());
    return { hook, unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
  }
  it('passes the meeting-bound archive writer to provider handlers on start', async () => {
    const { hook, unmount } = mount();
    const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn() };
    const starting = hook.start({ archive });
    harness.providers[0]!.finish();
    expect(await starting).toBe(true);
    expect(harness.handlerOptions).toHaveBeenLastCalledWith({ archive });
    hook.stop();
    unmount();
  });
  it('keeps recovery pending after handshake until current nonempty content arrives', async () => {
    const { hook, unmount } = mount();
    const starting = hook.start({ awaitContent: true });
    const provider = harness.providers[0]!;
    provider.handlers.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'connected',
      timestamp: new Date().toISOString(),
    });
    provider.finish();
    expect(await starting).toBe(true);
    expect(hook.getTransport()).toBe('reconnecting');
    hook.restoreHealth();
    expect(harness.restoredHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'reconnecting' }),
    );
    const event = {
      kind: 'transcript' as const,
      provider: 'test',
      mode: 'online_full' as const,
      source: 'microphone' as const,
      segmentId: 'recovery',
      status: 'partial' as const,
      startMs: 0,
      text: '  ',
    };
    provider.handlers.onTranscript(event);
    expect(hook.getTransport()).toBe('reconnecting');
    provider.handlers.onTranscript({ ...event, text: '有效內容' });
    expect(hook.getTransport()).toBe('connected');
    hook.stop();
    unmount();
  });
  it('does not turn explicit Stop back into idle when pending start settles', async () => {
    const { hook, unmount } = mount();
    const pending = hook.start();
    const provider = harness.providers[0]!;
    hook.stop();
    harness.state.mockClear();
    provider.finish();
    expect(await pending).toBe(false);
    expect(harness.state).not.toHaveBeenCalled();
    unmount();
  });
  it('does not let late content clear a failed or stopped recovery', async () => {
    const { hook, unmount } = mount();
    const pending = hook.start({ awaitContent: true });
    const provider = harness.providers[0]!;
    const health = {
      kind: 'health' as const,
      component: 'transport' as const,
      timestamp: new Date().toISOString(),
    };
    provider.handlers.onHealth({ ...health, state: 'connected' });
    provider.finish();
    await pending;
    provider.handlers.onHealth({ ...health, state: 'failed' });
    const translation = {
      kind: 'translation' as const,
      provider: 'test',
      mode: 'online_full' as const,
      sourceSegmentId: 'recovery',
      status: 'draft' as const,
      sourceText: '',
      targetText: '晚到文字',
      sourceLanguage: 'en',
      targetLanguage: 'zh-TW',
      updatedAt: new Date().toISOString(),
    };
    provider.handlers.onTranslation(translation);
    expect(hook.getTransport()).toBe('failed');
    provider.handlers.onHealth({ ...health, state: 'connected' });
    expect(hook.getTransport()).toBe('reconnecting');
    provider.handlers.onTranslation(translation);
    expect(hook.getTransport()).toBe('connected');
    hook.stop();
    provider.handlers.onTranslation(translation);
    expect(hook.getTransport()).toBe('stopped');
    unmount();
  });
  it('rearms content readiness for provider-owned reconnects after a healthy session', async () => {
    const { hook, unmount } = mount();
    const pending = hook.start();
    const provider = harness.providers[0]!;
    const health = {
      kind: 'health' as const,
      component: 'transport' as const,
      timestamp: new Date().toISOString(),
    };
    provider.handlers.onHealth({ ...health, state: 'connected' });
    provider.finish();
    await pending;
    const transcript = {
      kind: 'transcript' as const,
      provider: 'test',
      mode: 'online_full' as const,
      source: 'microphone' as const,
      segmentId: 'recovery',
      status: 'partial' as const,
      startMs: 0,
      text: '有效內容',
    };
    provider.handlers.onTranscript(transcript);
    for (const state of ['failed', 'reconnecting'] as const) {
      provider.handlers.onHealth({ ...health, state });
      provider.handlers.onHealth({ ...health, state: 'connected' });
      expect(hook.getTransport()).toBe('reconnecting');
      provider.handlers.onTranscript(transcript);
      expect(hook.getTransport()).toBe('connected');
    }
    hook.stop();
    unmount();
  });
  it('cancels warm work on Stop and unmount', () => {
    const { hook, unmount } = mount();
    const cancel = _name === 'Gemini' ? harness.cancelGemini : harness.cancelOpenAI;
    cancel.mockClear();
    hook.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('offers cross-provider recovery after repeated caption stalls despite successful handshakes', async () => {
    const { hook, unmount } = mount();
    const pending = hook.start();
    const provider = harness.providers[0]!;
    const health = {
      kind: 'health' as const,
      component: 'transport' as const,
      timestamp: new Date().toISOString(),
    };
    provider.handlers.onHealth({ ...health, state: 'connected' });
    provider.finish();
    await pending;
    const stalled = {
      ...health,
      state: 'degraded' as const,
      recoveryFailure: {
        layer: 'provider' as const,
        kind: 'stalled' as const,
        provider: _name === 'Gemini' ? ('gemini' as const) : ('openai' as const),
        purpose: 'translation' as const,
        attemptId: 'first-stall',
      },
    };
    for (let i = 0; i < 2; i++) {
      provider.handlers.onHealth({
        ...stalled,
        recoveryFailure: { ...stalled.recoveryFailure, attemptId: String(i) },
      });
      provider.handlers.onHealth({ ...health, state: 'reconnecting' });
      expect(hook.getTransport()).toBe('reconnecting');
      provider.handlers.onHealth({ ...health, state: 'connected' });
      expect(hook.getTransport()).toBe(i === 0 ? 'reconnecting' : 'failed');
    }
    provider.handlers.onTranscript({
      kind: 'transcript',
      provider: 'test',
      mode: 'online_full',
      source: 'microphone',
      segmentId: 'recovery',
      status: 'partial',
      startMs: 0,
      text: '恢復內容',
    });
    expect(hook.getTransport()).toBe('connected');
    provider.handlers.onHealth(stalled);
    provider.handlers.onHealth({ ...health, state: 'connected' });
    expect(hook.getTransport()).toBe('reconnecting');
    hook.stop();
    unmount();
  });
  it('retires a handoff loser without overwriting the winner health', async () => {
    const { hook, unmount } = mount();
    const starting = hook.start();
    const provider = harness.providers[0]!;
    provider.stop.mockImplementation(() => {
      provider.handlers.onHealth({
        kind: 'health',
        component: 'transport',
        state: 'stopped',
        timestamp: new Date().toISOString(),
      });
    });
    harness.health.mockClear();
    hook.stop({ preserveHealth: true });
    expect(harness.health).not.toHaveBeenCalled();
    expect(hook.getTransport()).toBe('stopped');
    provider.finish();
    expect(await starting).toBe(false);
    unmount();
  });
  it('still publishes stopped health for an explicit Stop', async () => {
    const { hook, unmount } = mount();
    const starting = hook.start();
    const provider = harness.providers[0]!;
    provider.stop.mockImplementation(() => {
      provider.handlers.onHealth({
        kind: 'health',
        component: 'transport',
        state: 'stopped',
        timestamp: new Date().toISOString(),
      });
    });
    hook.stop();
    expect(harness.health).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped' }));
    provider.finish();
    await starting;
    unmount();
  });
  it('restores the source failure after synchronous stop health callbacks', async () => {
    const { hook, unmount } = mount();
    const starting = hook.start();
    const provider = harness.providers[0]!;
    provider.stop.mockImplementation(() => {
      provider.handlers.onHealth({
        kind: 'health',
        component: 'audio',
        state: 'stopped',
        timestamp: new Date().toISOString(),
      });
    });
    provider.handlers.onHealth({
      kind: 'health',
      component: 'audio',
      state: 'failed',
      message: 'source ended',
      timestamp: new Date().toISOString(),
    });
    hook.restoreHealth();
    expect(harness.restoredHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        component: 'audio',
        state: 'failed',
        message: 'source ended',
      }),
    );
    provider.finish();
    await starting;
    unmount();
  });
  it('bounds a hung info request and polls again after failure backoff', async () => {
    const { unmount } = mount();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
    unmount();
  });
  it('aborts polling and rejects late provider health after unmount, flushing captions', async () => {
    const { hook, unmount } = mount();
    const starting = hook.start();
    const provider = harness.providers[0]!;
    unmount();
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(harness.flush).toHaveBeenCalledTimes(1);
    provider.handlers.onHealth({
      kind: 'health',
      component: 'audio',
      state: 'failed',
      message: 'late permission result',
      timestamp: new Date().toISOString(),
    });
    expect(harness.health).not.toHaveBeenCalled();
    provider.handlers.onTranscript({} as Parameters<CaptionProviderHandlers['onTranscript']>[0]);
    provider.handlers.onTranslation({} as Parameters<CaptionProviderHandlers['onTranslation']>[0]);
    provider.handlers.onAudioLevel({} as Parameters<CaptionProviderHandlers['onAudioLevel']>[0]);
    expect(harness.transcript).not.toHaveBeenCalled();
    expect(harness.translation).not.toHaveBeenCalled();
    expect(harness.audioLevel).not.toHaveBeenCalled();
    provider.finish();
    expect(await starting).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
