import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import geminiGolden from '../../../../tests/fixtures/upstream-contracts/gemini-live-translate.json' with { type: 'json' };
import type { AudioSource } from './types.js';
import {
  __resetRecoveryFailuresForTests,
  recoveryHttpError,
  recoveryFailureFor,
} from './recovery-attempt.js';
afterEach(() => __resetRecoveryFailuresForTests());
import {
  __resetAudioEngineForTests,
  ensureCaptureWorklet,
  getCaptureContext,
  resumeCaptureContext,
} from './audio-engine.js';
import {
  GeminiLiveProvider,
  prewarmGeminiSession,
  cancelGeminiPrewarm,
  __resetWarmGeminiForTests,
  floatTo16BitPCM,
  arrayBufferToBase64,
} from './gemini-live-provider.js';

function makeHandlers() {
  const transcripts: TranscriptEvent[] = [];
  const translations: TranslationEvent[] = [];
  const health: HealthEvent[] = [];
  return {
    handlers: {
      onTranscript: (e: TranscriptEvent) => transcripts.push(e),
      onTranslation: (e: TranslationEvent) => translations.push(e),
      onHealth: (e: HealthEvent) => health.push(e),
      onAudioLevel: vi.fn(),
    },
    transcripts,
    translations,
    health,
  };
}

function makeProvider(langPair = 'en→zh-TW') {
  const h = makeHandlers();
  // No real mic needed: handleServerObject never touches audio capture.
  const provider = new GeminiLiveProvider(
    'http://localhost/session/gemini',
    h.handlers,
    undefined,
    langPair,
  );
  return { provider, ...h };
}

describe('GeminiLiveProvider — message mapping', () => {
  it('does not publish whitespace-only turns but preserves spaces inside real content', () => {
    const { provider, transcripts, translations } = makeProvider();
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: ' ' }, outputTranscription: { text: ' ' } },
    });
    expect(transcripts).toEqual([]);
    expect(translations).toEqual([]);
    provider.handleServerObject({ serverContent: { turnComplete: true } });
    expect(transcripts).toEqual([]);
    expect(translations).toEqual([]);
    for (const text of ['Hello', ' ', 'world'])
      provider.handleServerObject({ serverContent: { inputTranscription: { text } } });
    expect(transcripts.at(-1)?.text).toBe('Hello world');
  });
  it('setupComplete → transport connected health', () => {
    const { provider, health } = makeProvider();
    provider.handleServerObject({ setupComplete: {} });
    expect(health.at(-1)).toMatchObject({ component: 'transport', state: 'connected' });
  });

  it('accumulates input transcription into a partial source transcript', () => {
    const { provider, transcripts } = makeProvider();
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello' } } });
    provider.handleServerObject({ serverContent: { inputTranscription: { text: ' world' } } });
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatchObject({
      status: 'partial',
      text: 'Hello',
      provider: 'gemini-live',
      mode: 'online_full',
    });
    expect(transcripts[1]).toMatchObject({ status: 'partial', text: 'Hello world' });
    // Same turn → same segment id.
    expect(transcripts[0]!.segmentId).toBe(transcripts[1]!.segmentId);
    expect(transcripts[0]!.startMs).toBeGreaterThan(0);
  });

  it('accumulates output transcription into a draft translation (繁中 target)', () => {
    const { provider, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '你好' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '世界' } } });
    expect(translations.at(-1)).toMatchObject({
      status: 'draft',
      sourceText: 'Hello',
      targetText: '你好世界',
      sourceLanguage: 'en',
      targetLanguage: 'zh-TW',
    });
  });

  it('anchors output-first Gemini translation deltas to the live caption path', () => {
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');

    provider.handleServerObject({ serverContent: { outputTranscription: { text: '即時字幕' } } });

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ status: 'partial', text: '' });
    expect(translations).toHaveLength(1);
    expect(translations[0]).toMatchObject({ status: 'draft', targetText: '即時字幕' });
    expect(translations[0]!.sourceSegmentId).toBe(transcripts[0]!.segmentId);
  });

  it('turnComplete finalizes both transcript and translation, next content is a new segment', () => {
    const { provider, transcripts, translations } = makeProvider();
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'One' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '一' } } });
    provider.handleServerObject({ serverContent: { turnComplete: true } });

    const finalT = transcripts.filter((t) => t.status === 'final');
    const finalX = translations.filter((t) => t.status === 'final');
    expect(finalT).toHaveLength(1);
    expect(finalT[0]).toMatchObject({ status: 'final', text: 'One' });
    expect(finalX[0]).toMatchObject({ status: 'final', targetText: '一' });

    const firstId = finalT[0]!.segmentId;
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Two' } } });
    const next = transcripts.at(-1)!;
    expect(next.segmentId).not.toBe(firstId);
  });

  it('server frames are JSON carried over BINARY (regression: onmessage must decode, not drop)', () => {
    // Gemini Live sends serverContent as binary WS frames (ArrayBuffer), NOT
    // text. The provider decodes UTF-8 → JSON before routing. This guards the
    // bug where `typeof ev.data !== 'string'` silently dropped every frame.
    const { provider, translations } = makeProvider('en→zh-TW');
    const json = JSON.stringify({
      serverContent: { inputTranscription: { text: 'hi' }, outputTranscription: { text: '嗨' } },
    });
    const buf = new TextEncoder().encode(json).buffer;
    const decoded = JSON.parse(new TextDecoder().decode(buf));
    provider.handleServerObject(decoded);
    expect(translations.at(-1)).toMatchObject({ targetText: '嗨', targetLanguage: 'zh-TW' });
  });

  it('continuous translate stream: finalizes a segment on a sentence boundary (no turnComplete)', () => {
    // gemini-3.5-live-translate streams continuously and never sends turnComplete.
    // A translation ending in a sentence terminator (。！？) WITH matching source
    // text must auto-finalize so history populates and the live line is bounded.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Hello everyone.' } },
    });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '大家好。' } } });
    // No turnComplete sent — finalize must have fired on the 。
    expect(translations.some((t) => t.status === 'final' && t.targetText === '大家好。')).toBe(
      true,
    );
    expect(transcripts.some((t) => t.status === 'final')).toBe(true);
    // Next sentence (source + translation) becomes a NEW segment id.
    const firstFinal = translations.find((t) => t.status === 'final')!;
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Welcome.' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '歡迎參加。' } } });
    const second = translations.find((t) => t.status === 'final' && t.targetText === '歡迎參加。');
    expect(second).toBeTruthy();
    expect(second!.sourceSegmentId).not.toBe(firstFinal.sourceSegmentId);
  });

  it('does NOT finalize a sentence-ending translation while the source transcript is still empty (orphan guard)', () => {
    // If the translation completes a sentence BEFORE any input transcription
    // arrived, finalizing would emit a final translation whose segment never
    // exists in the store → invisible forever. It must wait for the source.
    const { provider, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '大家好。' } } });
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
    // Source arrives → next output delta (or source sentence end) can finalize.
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Hello everyone.' } },
    });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '' } } });
    // Drive one more output delta to trigger the check with both present.
    provider.handleServerObject({ serverContent: { outputTranscription: { text: ' ' } } });
    const finals = translations.filter((t) => t.status === 'final');
    expect(finals.length).toBeGreaterThan(0);
    expect(finals[0]!.targetText.trim()).toBe('大家好。');
  });

  it('echo-silent: source already in target language finalizes transcript-only on sentence end', () => {
    // echoTargetLanguage:false → speaker already speaks the target language →
    // no translation will EVER arrive. Detected via inputTranscription.languageCode;
    // the source line must self-finalize instead of growing unbounded.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW'); // target zh
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: '我們直接說中文。', languageCode: 'cmn-Hant' } },
    });
    const finalT = transcripts.filter((t) => t.status === 'final');
    expect(finalT).toHaveLength(1);
    expect(finalT[0]!.text).toBe('我們直接說中文。');
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
  });

  it('does NOT finalize source-only sentence when input language differs from target (translation pending)', () => {
    // English speech, zh target: source completes its sentence before the
    // translation arrives — finalizing now would orphan the upcoming
    // translation onto the next segment. Must wait.
    const { provider, transcripts } = makeProvider('en→zh-TW');
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Hello everyone.', languageCode: 'en' } },
    });
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);
  });

  it('stop() finalizes the in-flight turn so the last words survive Pause/Stop', () => {
    // Without this, text spoken right before Pause/Stop never reaches history,
    // is missing from Export, and the board keeps a stale pulsing partial.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Final words' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '最後的話' } } });
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);
    provider.stop();
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(transcripts.at(-1)).toMatchObject({ status: 'final', text: 'Final words' });
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(translations.at(-1)).toMatchObject({ status: 'final', targetText: '最後的話' });
  });

  it('does not split a sentence at a decimal point ("3." mid-number)', () => {
    const { provider, translations } = makeProvider('zh-TW→en');
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: '營收成長三點五個百分點。' } },
    });
    provider.handleServerObject({
      serverContent: { outputTranscription: { text: 'Revenue grew by 3.' } },
    });
    // "3." must NOT finalize — the rest of the number is still streaming.
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '5 percent.' } } });
    const finals = translations.filter((t) => t.status === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.targetText).toBe('Revenue grew by 3.5 percent.');
  });

  it('GoAway outside a running session does not create a phantom outage or finalize text', () => {
    const { provider, health, transcripts } = makeProvider();
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Half spoken' } } });
    provider.handleServerObject({ goAway: { timeLeft: '5s' } });
    expect(health).toEqual([]);
    expect(transcripts.filter((event) => event.status === 'final')).toHaveLength(0);
  });

  it('zh-TW→en sets reversed language tags', () => {
    const { provider, translations } = makeProvider('zh-TW→en');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: '你好' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: 'Hello' } } });
    expect(translations.at(-1)).toMatchObject({
      sourceLanguage: 'zh-TW',
      targetLanguage: 'en',
      targetText: 'Hello',
    });
  });
});

describe('GeminiLiveProvider — PCM helpers', () => {
  it('floatTo16BitPCM clamps and converts to little-endian int16', () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]));
    const dv = new DataView(buf);
    expect(buf.byteLength).toBe(10);
    expect(dv.getInt16(0, true)).toBe(0);
    expect(dv.getInt16(2, true)).toBe(32767); // 1 → max
    expect(dv.getInt16(4, true)).toBe(-32768); // -1 → min
    expect(dv.getInt16(6, true)).toBe(32767); // clamp >1
    expect(dv.getInt16(8, true)).toBe(-32768); // clamp <-1
  });

  it('arrayBufferToBase64 round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0, 1, 2, 254, 255, 128]);
  });
});

// ── Reconnect + wedge harness (#16) ─────────────────────────────────────────
// These tests drive the FULL start() path, so they need a fake WebSocket,
// AudioContext, AudioWorkletNode and mic. Kept in their own describe block with
// scoped global stubs so the pure message-mapping tests above stay untouched.

let wsAutoOpen = true; // when true a new socket opens on a microtask
let wsEmitSetup = true; // when true the opened socket also emits setupComplete
let wsAutoCloseAfterOpen = false; // when true the socket closes right after opening (connect-then-drop)

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  binaryType = '';
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: Partial<CloseEvent>) => void) | null = null;
  closeCount = 0;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (wsAutoOpen) {
      // Resolve connect()'s onopen on a microtask (after connect() wires the
      // handlers synchronously), then deliver setupComplete to arm the wedge
      // detector — exactly what a live socket does.
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
        if (wsEmitSetup) this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
        if (wsAutoCloseAfterOpen) this.close();
      });
    }
  }

  send(d: string): void {
    this.sent.push(d);
  }

  close(): void {
    this.closeCount += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  port = { onmessage: null as ((e: MessageEvent) => void) | null, close: vi.fn() };
  options: AudioWorkletNodeOptions | undefined;

  constructor(_ctx?: AudioContext, _name?: string, options?: AudioWorkletNodeOptions) {
    this.options = options;
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(): void {}
  disconnect(): void {}
}

function makeFakeAudioContextClass() {
  return class {
    readonly sampleRate = 16_000;
    readonly state = 'running';
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    destination = {};
    createMediaStreamSource() {
      return { connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  } as unknown as typeof AudioContext;
}

/** Mic that always returns an ACTIVE level (≈ -26 dB ≫ the -48 dB threshold). */
function makeActiveMic(): AudioSource {
  const buf = new Float32Array(2048).fill(0.05);
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData: (out: Float32Array) => out.set(buf),
  } as unknown as AnalyserNode;
  return {
    analyser,
    acquire: vi.fn().mockImplementation(async (onHealth: (e: HealthEvent) => void) => {
      onHealth({ kind: 'health', component: 'audio', state: 'connected', timestamp: '' });
      return {
        getAudioTracks: () => [],
        getTracks: () => [{ stop: vi.fn() }],
      } as unknown as MediaStream;
    }),
    release: vi.fn(),
  } as unknown as AudioSource;
}

function tokenResponse(model = 'models/gemini-3.5-live-translate-preview'): Response {
  return new Response(JSON.stringify({ token: 'ephemeral', model }), { status: 200 });
}

describe('GeminiLiveProvider — reconnect + wedge detection (#16)', () => {
  beforeEach(() => {
    __resetWarmGeminiForTests();
    wsAutoOpen = true;
    wsEmitSetup = true;
    wsAutoCloseAfterOpen = false;
    FakeWebSocket.instances = [];
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('AudioContext', makeFakeAudioContextClass());
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
  });

  afterEach(() => {
    __resetWarmGeminiForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeHarness() {
    const transcripts: TranscriptEvent[] = [];
    const translations: TranslationEvent[] = [];
    const health: HealthEvent[] = [];
    const audioLevels: AudioLevelEvent[] = [];
    const handlers = {
      onTranscript: (e: TranscriptEvent) => transcripts.push(e),
      onTranslation: (e: TranslationEvent) => translations.push(e),
      onHealth: (e: HealthEvent) => health.push(e),
      onAudioLevel: (e: AudioLevelEvent) => audioLevels.push(e),
    };
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      handlers,
      makeActiveMic(),
      'en→zh-TW',
      'meeting',
    );
    return { provider, transcripts, translations, health, audioLevels };
  }

  it('reports even one dropped frame and transport recovery without claiming content recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse()),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    const socket = FakeWebSocket.instances[0]!;
    const node = FakeAudioWorkletNode.instances.at(-1)!;
    const push = () =>
      node.port.onmessage?.({ data: new Float32Array(512).fill(0.1).buffer } as MessageEvent);
    health.length = 0;
    socket.bufferedAmount = 2_000_000;
    push();
    expect(health).toContainEqual(
      expect.objectContaining({
        component: 'transport',
        state: 'degraded',
        message: expect.stringContaining('audio frames dropped'),
      }),
    );
    for (let i = 0; i < 8; i++) push();
    expect(health.filter((e) => e.component === 'transport')).toHaveLength(1);
    expect(socket.sent).toHaveLength(1); // setup only
    socket.bufferedAmount = 0;
    push();
    expect(socket.sent).toHaveLength(2);
    expect(health.at(-1)).toMatchObject({ component: 'transport', state: 'connected' });
    socket.bufferedAmount = 2_000_000;
    push();
    expect(
      health.filter((e) => e.component === 'transport' && e.state === 'degraded'),
    ).toHaveLength(2);
    provider.stop();
  });

  it('settles Stop only after the final drain event has been delivered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(tokenResponse())),
    );
    const { provider, transcripts, translations, health } = makeHarness();
    await provider.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit({ serverContent: { inputTranscription: { text: 'tail' } } });
    provider.stop();
    let settled = false;
    const stopped = provider.waitForStop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const stoppedHealth = [...health];
    socket.emit({ setupComplete: {} });
    socket.emit({ goAway: { timeLeft: '0s' } });
    socket.emit({
      serverContent: {
        inputTranscription: { text: ' end' },
        outputTranscription: { text: '完整尾文' },
        turnComplete: true,
      },
    });
    // No drain-cap time advances: the completion frame must settle Stop now.
    await Promise.resolve();
    expect(settled).toBe(true);
    await stopped;
    expect(transcripts.at(-1)).toMatchObject({ text: 'tail end', status: 'final' });
    expect(translations.at(-1)).toMatchObject({ targetText: '完整尾文', status: 'final' });
    expect(health).toEqual(stoppedHealth);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    socket.emit({ serverContent: { inputTranscription: { text: ' late' } } });
    expect(transcripts.at(-1)?.text).toBe('tail end');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a previously warm token bypass a later permanent refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(tokenResponse())),
    );
    prewarmGeminiSession('http://localhost/session/gemini');
    await new Promise((resolve) => setTimeout(resolve, 0));
    recoveryHttpError(new Response(null, { status: 401 }), 'gemini', 'translation');
    const { provider } = makeHarness();
    await provider.start();
    expect(provider.status).toBe('stopped');
    expect(FakeWebSocket.instances).toHaveLength(0);
    provider.stop();
  });

  it('reports an active protocol auth refusal with normalized recovery evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.emit({ error: { code: 401, status: 'UNAUTHENTICATED' } });
    expect(health.at(-1)).toMatchObject({
      state: 'failed',
      recoveryFailure: { kind: 'auth', provider: 'gemini' },
    });
    provider.stop();
  });

  it.each([
    [401, 'auth'],
    [429, 'rate-limit'],
    [404, 'unsupported'],
  ] as const)(
    'preserves translation HTTP %s classification across adapter replacement',
    async (status, kind) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status, headers: { 'Retry-After': '60' } }));
      vi.stubGlobal('fetch', fetchMock);
      const first = makeHarness();
      await first.provider.start();
      expect(first.health).toContainEqual(
        expect.objectContaining({
          recoveryFailure: expect.objectContaining({
            kind,
            provider: 'gemini',
            purpose: 'translation',
          }),
        }),
      );
      const next = makeHarness();
      await next.provider.start();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      next.provider.stop();
    },
  );

  it('PCM delivery freeze reports capture failure without the receive watchdog reconnecting', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const { provider, health } = makeHarness();
    await provider.start();
    const callback = FakeAudioWorkletNode.instances[0]!.port.onmessage!;
    callback({ data: new Float32Array(512).buffer } as MessageEvent);
    await vi.advanceTimersByTimeAsync(2000);
    expect(health.some((event) => event.reason === 'capture_stalled')).toBe(true);
    await vi.advanceTimersByTimeAsync(40000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    provider.stop();
    provider.stop();
    const count = health.length;
    callback({ data: new Float32Array(512).buffer } as MessageEvent);
    await vi.advanceTimersByTimeAsync(3000);
    expect(health).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['connecting', 'reconnecting', 'rotation'] as const)(
    'Stop from a synchronous %s health subscriber cannot create later work',
    async (stage) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
      vi.stubGlobal('fetch', fetchMock);
      const mic = makeActiveMic();
      const h = makeHandlers();
      const provider = new GeminiLiveProvider(
        'http://localhost/session/gemini',
        {
          ...h.handlers,
          onHealth: (event) => {
            h.handlers.onHealth(event);
            if (
              event.component === 'transport' &&
              ((stage === 'connecting' && event.state === 'connecting') ||
                (stage !== 'connecting' && event.state === 'reconnecting'))
            )
              provider.stop();
          },
        },
        mic,
      );
      await provider.start();
      if (stage === 'reconnecting') FakeWebSocket.instances[0]!.close();
      if (stage === 'rotation') {
        FakeWebSocket.instances[0]!.emit({ goAway: { timeLeft: '5s' } });
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(provider.status).toBe('stopped');
      expect(vi.getTimerCount()).toBe(0);
      expect(FakeWebSocket.instances).toHaveLength(stage === 'connecting' ? 0 : 1);
      if (stage === 'connecting') {
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mic.acquire).not.toHaveBeenCalled();
      }
    },
  );

  it('one recovery budget covers mint and setup rather than resetting at each stage', async () => {
    vi.useFakeTimers();
    let resolveToken!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            resolveToken = resolve;
          }),
        ),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    wsEmitSetup = false;
    await vi.advanceTimersByTimeAsync(8_000);
    resolveToken(tokenResponse());
    await vi.advanceTimersByTimeAsync(4_001);
    expect(
      health.some((event) => event.component === 'transport' && event.state === 'failed'),
    ).toBe(true);
    expect(FakeWebSocket.instances[1]!.readyState).toBe(3);
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['seconds', 'date'])(
    'respects token Retry-After %s before the next Gemini attempt',
    async (retryAfter) => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
          'performance',
        ],
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response('quota', {
              status: 429,
              headers: {
                'Retry-After':
                  retryAfter === 'seconds' ? '8' : new Date(Date.now() + 8_000).toUTCString(),
              },
            }),
          ),
        )
        .mockImplementation(() => Promise.resolve(tokenResponse()));
      vi.stubGlobal('fetch', fetchMock);
      const { provider, health } = makeHarness();
      await provider.start();
      FakeWebSocket.instances[0]!.close();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(health.at(-1)?.message).toMatch(/quota|429/i);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      provider.stop();
      provider.stop();
    },
  );

  it('Stop and a new provider or prewarm cannot bypass endpoint quota cooldown', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('quota', {
          status: 429,
          headers: { 'Retry-After': '8' },
        }),
      )
      .mockImplementation(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const first = makeHarness();
    await first.provider.start();
    first.provider.stop();
    const second = makeHarness();
    await second.provider.start();
    prewarmGeminiSession('http://localhost/session/gemini');
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.provider.status).toBe('stopped');
    expect(second.health.some((event) => event.message?.includes('429'))).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    await second.provider.start();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.provider.stop();
    second.provider.stop();
  });

  it('cancelGeminiPrewarm aborts the speculative request without a timer leak', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise(() => {});
      }),
    );
    prewarmGeminiSession('http://localhost/session/gemini');
    await vi.advanceTimersByTimeAsync(1);
    cancelGeminiPrewarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports safe close code without raw reason and does not infer resume rejection from 1008', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'resume-secret' } });
    old.emit({ sessionResumptionUpdate: { resumable: false } });
    old.readyState = 3;
    old.onclose?.({ code: 1008, reason: 'token-sensitive-raw-error' });
    expect(health.at(-1)?.message).toContain('1008');
    expect(JSON.stringify(health)).not.toContain('token-sensitive');
    expect(JSON.stringify(health)).not.toContain('resume-secret');
    await vi.advanceTimersByTimeAsync(1_001);
    const setup = JSON.parse(FakeWebSocket.instances[1]!.sent[0]!).setup;
    expect(setup.sessionResumption.handle).toBe('resume-secret');
    provider.stop();
    provider.stop();
  });

  it('after two failed resumed setups tries a fresh session once and never reuses the suspect handle', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health, transcripts } = makeHarness();
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'old-handle' } });
    old.emit({ serverContent: { inputTranscription: { text: 'Earlier meeting text.' } } });
    wsEmitSetup = false;
    wsAutoCloseAfterOpen = true;
    old.close();
    await vi.advanceTimersByTimeAsync(15_001);
    const attempts = FakeWebSocket.instances
      .slice(1)
      .map((socket) => JSON.parse(socket.sent[0]!).setup.sessionResumption);
    expect(attempts.slice(0, 2)).toEqual([{ handle: 'old-handle' }, { handle: 'old-handle' }]);
    expect(attempts.slice(2)).toEqual([{}, {}]);
    expect(health.some((event) => event.message?.includes('context may be interrupted'))).toBe(
      true,
    );
    expect(transcripts.some((event) => event.text === 'Earlier meeting text.')).toBe(true);
    provider.stop();
  });

  it('token failures do not count as resumed setup rejections', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
        .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
        .mockImplementation(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.emit({
      sessionResumptionUpdate: { resumable: true, newHandle: 'still-valid' },
    });
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(7_001);
    const setup = JSON.parse(FakeWebSocket.instances[1]!.sent[0]!).setup;
    expect(setup.sessionResumption.handle).toBe('still-valid');
    provider.stop();
    provider.stop();
  });

  it('a successful resumed setup resets the consecutive failure counter', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.emit({
      sessionResumptionUpdate: { resumable: true, newHandle: 'valid-handle' },
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      wsEmitSetup = false;
      wsAutoCloseAfterOpen = true;
      FakeWebSocket.instances.at(-1)!.close();
      await vi.advanceTimersByTimeAsync(1_001);
      wsEmitSetup = true;
      wsAutoCloseAfterOpen = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        JSON.parse(FakeWebSocket.instances.at(-1)!.sent[0]!).setup.sessionResumption.handle,
      ).toBe('valid-handle');
    }
    provider.stop();
    provider.stop();
  });

  it('Stop clears old resumption state before a new start on the same provider', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.emit({
      sessionResumptionUpdate: { resumable: true, newHandle: 'old-meeting' },
    });
    provider.stop();
    provider.stop();
    await provider.start();
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!).setup.sessionResumption).toEqual({});
    provider.stop();
    provider.stop();
  });

  it('a new start from the old final transcript callback keeps its newly acquired capture alive', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const tracks: Array<{ readyState: string; stop: () => void }> = [];
    let current: { readyState: string; stop: () => void } | null = null;
    const mic: AudioSource = {
      analyser: null,
      acquire: async () => {
        const track = {
          readyState: 'live',
          stop: () => {
            track.readyState = 'ended';
          },
        };
        current = track;
        tracks.push(track);
        return { getAudioTracks: () => [], getTracks: () => [track] } as unknown as MediaStream;
      },
      release: () => {
        current?.stop();
        current = null;
      },
    };
    const h = makeHandlers();
    let restarting: Promise<void> | undefined;
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      {
        ...h.handlers,
        onTranscript: (event) => {
          h.handlers.onTranscript(event);
          if (event.status === 'final' && !restarting) restarting = provider.start();
        },
      },
      mic,
    );
    await provider.start();
    FakeWebSocket.instances[0]!.emit({
      serverContent: { inputTranscription: { text: 'Old meeting tail' } },
    });
    provider.stop();
    provider.stop();
    await restarting;
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.readyState).toBe('ended');
    expect(tracks[1]!.readyState).toBe('live');
    expect(FakeWebSocket.instances[0]!.readyState).toBe(3);
    expect(provider.status).toBe('running');
    provider.stop();
    provider.stop();
  });

  it('final transcript callbacks cannot erase a newly arriving turn', () => {
    const h = makeHandlers();
    let nested = false;
    const provider = new GeminiLiveProvider('http://localhost/session/gemini', {
      ...h.handlers,
      onTranscript: (event) => {
        h.handlers.onTranscript(event);
        if (event.status === 'final' && !nested) {
          nested = true;
          provider.handleServerObject({
            serverContent: { inputTranscription: { text: 'New words' } },
          });
        }
      },
    });
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Old words' } } });
    provider.handleServerObject({ serverContent: { turnComplete: true } });
    provider.handleServerObject({ serverContent: { inputTranscription: { text: ' continue' } } });
    expect(h.transcripts.at(-1)?.text).toBe('New words continue');
    const previous = h.transcripts.find((event) => event.status === 'final')!;
    expect(h.transcripts.at(-1)?.segmentId).not.toBe(previous.segmentId);
  });

  it('Stop cannot drain a replacement started by its stopped health subscriber', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const h = makeHandlers();
    let restarted = false;
    let restarting: Promise<void> | undefined;
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      {
        ...h.handlers,
        onHealth: (event) => {
          h.handlers.onHealth(event);
          if (event.component === 'audio' && event.state === 'stopped' && !restarted) {
            restarted = true;
            restarting = provider.start();
          }
        },
      },
      makeActiveMic(),
    );
    await provider.start();
    provider.stop();
    await restarting;
    await vi.advanceTimersByTimeAsync(3_001);
    expect(provider.status).toBe('running');
    expect(FakeWebSocket.instances.at(-1)!.readyState).toBe(1);
    expect(h.health.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'connected',
    );
    provider.stop();
    provider.stop();
  });

  it('does not carry the remainder of a drained frame into a synchronously restarted session', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const h = makeHandlers();
    let restarting: Promise<void> | undefined;
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      {
        ...h.handlers,
        onTranscript: (event) => {
          h.handlers.onTranscript(event);
          if (event.status === 'final' && !restarting) restarting = provider.start();
        },
      },
      makeActiveMic(),
    );
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.emit({ serverContent: { outputTranscription: { text: '不要。' } } });
    provider.stop();
    old.emit({
      serverContent: {
        inputTranscription: { text: 'Do not.' },
        outputTranscription: { text: '舊場尾文' },
        turnComplete: true,
      },
    });
    await restarting;
    expect(provider.status).toBe('running');
    expect(h.transcripts.some((event) => event.text.includes('舊場尾文'))).toBe(false);
    expect(h.translations.some((event) => event.targetText.includes('舊場尾文'))).toBe(false);
    FakeWebSocket.instances
      .at(-1)!
      .emit({ serverContent: { inputTranscription: { text: 'New meeting' } } });
    expect(h.transcripts.at(-1)?.text).toBe('New meeting');
    expect(FakeWebSocket.instances).toHaveLength(2);
    provider.stop();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a start during drain adopts the start already triggered by the final callback', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const h = makeHandlers();
    let restarting: Promise<void> | undefined;
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      {
        ...h.handlers,
        onTranscript: (event) => {
          h.handlers.onTranscript(event);
          if (event.status === 'final' && !restarting) restarting = provider.start();
        },
      },
      makeActiveMic(),
    );
    await provider.start();
    FakeWebSocket.instances[0]!.emit({ serverContent: { inputTranscription: { text: 'Tail' } } });
    provider.stop();
    await provider.start();
    await restarting;
    expect(
      h.health.filter((event) => event.component === 'transport' && event.state === 'connecting'),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    provider.stop();
    provider.stop();
  });

  it('downsamples 48kHz fallback capture to 16kHz and scales worklet chunkSize', async () => {
    __resetAudioEngineForTests();
    const requestedRates: Array<number | undefined> = [];
    vi.stubGlobal(
      'AudioContext',
      class {
        readonly sampleRate = 48_000;
        readonly state = 'running';
        audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
        destination = {};
        constructor(options?: AudioContextOptions) {
          requestedRates.push(options?.sampleRate);
          if (options?.sampleRate) throw new Error('Explicit capture rate unsupported');
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        resume() {
          return Promise.resolve();
        }
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    try {
      await provider.start();
      const worklet = FakeAudioWorkletNode.instances.at(-1)!;
      expect(worklet.options?.processorOptions?.chunkSize).toBe(1536);
      worklet.port.onmessage?.({
        data: new Float32Array(1536).fill(0.25).buffer,
      } as MessageEvent);
      const audio = JSON.parse(FakeWebSocket.instances.at(-1)!.sent.at(-1)!).realtimeInput.audio;
      expect(requestedRates).toEqual([16_000, undefined]);
      expect(audio.mimeType).toBe('audio/pcm;rate=16000');
      expect(atob(audio.data)).toHaveLength(512 * 2);
    } finally {
      provider.stop();
      provider.stop();
      __resetAudioEngineForTests();
    }
  });

  it('a queued old worklet callback cannot send PCM into a replacement meeting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    await provider.start();
    const oldCallback = FakeAudioWorkletNode.instances.at(-1)!.port.onmessage!;
    provider.stop();
    provider.stop();
    await provider.start();
    const current = FakeWebSocket.instances.at(-1)!;
    const before = current.sent.length;
    oldCallback({ data: new Float32Array(512).buffer } as MessageEvent);
    expect(current.sent).toHaveLength(before);
    FakeAudioWorkletNode.instances.at(-1)!.port.onmessage?.({
      data: new Float32Array(512).buffer,
    } as MessageEvent);
    expect(current.sent).toHaveLength(before + 1);
    provider.stop();
    provider.stop();
  });

  it.each(['worklet', 'resume'] as const)(
    'Stop cancels pending capture %s immediately without cancelling another shared caller',
    async (stage) => {
      vi.useFakeTimers();
      __resetAudioEngineForTests();
      let resolveNative!: () => void;
      const native = new Promise<void>((resolve) => {
        resolveNative = resolve;
      });
      const addModule = vi.fn(() => (stage === 'worklet' ? native : Promise.resolve()));
      vi.stubGlobal(
        'AudioContext',
        class {
          sampleRate = 16_000;
          state: AudioContextState = stage === 'resume' ? 'suspended' : 'running';
          audioWorklet = { addModule };
          destination = {};
          createMediaStreamSource() {
            return { connect() {} };
          }
          async resume() {
            await native;
            this.state = 'running';
          }
        },
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(tokenResponse())),
      );
      const { provider } = makeHarness();
      let finished = false;
      const starting = provider.start().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      let otherFinished = false;
      const shared = (
        stage === 'worklet' ? ensureCaptureWorklet(getCaptureContext()!) : resumeCaptureContext()
      ).then(() => {
        otherFinished = true;
      });
      provider.stop();
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(finished).toBe(true);
        expect(otherFinished).toBe(false);
        const nodesAfterStop = FakeAudioWorkletNode.instances.length;
        resolveNative();
        await Promise.all([starting, shared]);
        expect(FakeAudioWorkletNode.instances).toHaveLength(nodesAfterStop);
        expect(otherFinished).toBe(true);
        expect(addModule).toHaveBeenCalledOnce();
        provider.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        resolveNative();
        await Promise.all([starting, shared]);
        provider.stop();
        __resetAudioEngineForTests();
      }
    },
  );

  it('does not send PCM or fail over while the replacement setup is pending', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    wsEmitSetup = false;
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(3_000);
    const replacement = FakeWebSocket.instances[1]!;
    const capture = FakeAudioWorkletNode.instances.at(-1)!;
    capture.port.onmessage?.({ data: new Float32Array(512).buffer } as MessageEvent);
    expect(replacement.sent.map((frame) => Object.keys(JSON.parse(frame))[0])).toEqual(['setup']);
    expect(health.some((event) => event.state === 'failed')).toBe(false);
    replacement.emit({ setupComplete: {} });
    capture.port.onmessage?.({ data: new Float32Array(512).buffer } as MessageEvent);
    expect(replacement.sent).toHaveLength(2);
    provider.stop();
    provider.stop();
  });

  it('GoAway retains audio and captions during token preparation and rotates without waiting for close', async () => {
    vi.useFakeTimers();
    let resolveToken!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            resolveToken = resolve;
          }),
        ),
    );
    const { provider, transcripts } = makeHarness();
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.close = () => {
      old.readyState = 2;
      old.closeCount += 1;
    };
    old.emit({ goAway: { timeLeft: '50s' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(old.readyState).toBe(1);
    old.emit({ serverContent: { inputTranscription: { text: 'Still listening' } } });
    expect(transcripts.at(-1)?.text).toBe('Still listening');
    FakeAudioWorkletNode.instances.at(-1)!.port.onmessage?.({
      data: new Float32Array(512).buffer,
    } as MessageEvent);
    expect(old.sent).toHaveLength(2);
    resolveToken(tokenResponse());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    old.emit({ serverContent: { inputTranscription: { text: ' before cutover' } } });
    await vi.advanceTimersByTimeAsync(7_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(old.closeCount).toBe(1);
    expect(
      transcripts.some(
        (event) => event.status === 'final' && event.text === 'Still listening before cutover',
      ),
    ).toBe(true);
    provider.stop();
    provider.stop();
  });

  it.each(['malformed', 'unsupported'] as const)(
    'rotation credential %s follows its failure policy',
    async (kind) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(
            kind === 'unsupported'
              ? tokenResponse('models/not-a-translation-model')
              : new Response('{}'),
          )
          .mockImplementation(() => Promise.resolve(tokenResponse())),
      );
      const { provider, health } = makeHarness();
      await provider.start();
      FakeWebSocket.instances[0]!.emit({ goAway: { timeLeft: '18s' } });
      await vi.advanceTimersByTimeAsync(5_001);
      if (kind === 'unsupported') {
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(recoveryFailureFor('gemini', 'translation')?.kind).toBe('unsupported');
        expect(fetch).toHaveBeenCalledTimes(2);
      } else {
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(health.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
          'connected',
        );
      }
      provider.stop();
      provider.stop();
    },
  );

  it('short GoAway grace keeps the old session until its prepared token is ready', async () => {
    vi.useFakeTimers();
    let resolveToken!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveToken = resolve;
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { provider } = makeHarness();
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.emit({ goAway: { timeLeft: '5s' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(old.readyState).toBe(1);
    resolveToken(tokenResponse());
    await vi.advanceTimersByTimeAsync(1);
    expect(old.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    provider.stop();
    provider.stop();
  });

  it('GoAway with a hung token still rotates by the announced deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue(tokenResponse()),
    );
    const { provider } = makeHarness();
    await provider.start();
    const old = FakeWebSocket.instances[0]!;
    old.close = () => {
      old.readyState = 2;
      old.closeCount += 1;
    };
    old.emit({ goAway: { timeLeft: '5s' } });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(old.closeCount).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    provider.stop();
    provider.stop();
  });

  it.each(['control', 'input', 'output'])(
    '%s traffic without visible text cannot conceal a caption wedge',
    async (kind) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(tokenResponse())),
      );
      const { provider, health } = makeHarness();
      await provider.start();
      const old = FakeWebSocket.instances[0]!;
      for (let i = 0; i < 7; i++) {
        old.emit(
          kind === 'control'
            ? { sessionResumptionUpdate: { newHandle: 'handle', resumable: true } }
            : {
                serverContent: {
                  [kind === 'input' ? 'inputTranscription' : 'outputTranscription']: {
                    text: ' \n\t',
                  },
                },
              },
        );
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(
        health.some((event) => event.state === 'degraded' && event.message?.includes('Wedged')),
      ).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(2);
      provider.stop();
      provider.stop();
    },
  );

  it('bounds a hung token request and Stop aborts it immediately', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return new Promise(() => {});
      }),
    );
    const first = makeHarness();
    const starting = first.provider.start();
    await vi.advanceTimersByTimeAsync(13_000);
    await starting;
    expect(first.provider.status).toBe('stopped');
    expect(requestSignal?.aborted).toBe(true);
    const second = makeHarness();
    const restarting = second.provider.start();
    await vi.advanceTimersByTimeAsync(1);
    second.provider.stop();
    await restarting;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('translate model setup uses the official AUDIO + transcription side-channel path', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = makeHarness();
    await provider.start();

    const setupFrame = FakeWebSocket.instances.at(-1)!.sent[0];
    expect(setupFrame).toBeTruthy();
    // Exact equality keeps the provider request anchored to the setup frame
    // accepted by the real upstream probe. This also guards the top-level
    // transcription placement and dedicated translate-model identity.
    expect(JSON.parse(setupFrame!)).toEqual(geminiGolden.clientFrame);

    provider.stop();
  });

  it('does not start audio capture before setupComplete', async () => {
    wsEmitSetup = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider } = makeHarness();
    const start = provider.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    FakeWebSocket.instances[0]!.emit({ setupComplete: {} });
    await start;
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);

    provider.stop();
  });

  it('fails without starting capture when the socket closes before setupComplete', async () => {
    wsEmitSetup = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, health } = makeHarness();
    const start = provider.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]!.close();
    await start;

    expect(provider.status).toBe('stopped');
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(health).toContainEqual(
      expect.objectContaining({ component: 'transport', state: 'api_error' }),
    );
  });

  it('fails without starting capture when setupComplete times out', async () => {
    vi.useFakeTimers();
    wsEmitSetup = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, health } = makeHarness();
    const start = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await start;

    expect(provider.status).toBe('stopped');
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(health).toContainEqual(
      expect.objectContaining({
        component: 'transport',
        state: 'api_error',
        message: expect.stringMatching(/timed out/i),
      }),
    );
  });

  it('stop() during the setup handshake settles it silently — no phantom timeout later', async () => {
    vi.useFakeTimers();
    wsEmitSetup = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, health } = makeHarness();
    const start = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // User presses Stop while the handshake is still open.
    provider.stop();
    await start;

    // Well past the 15 s setup deadline: the abandoned handshake must be dead,
    // not sitting on a timer that fires an api_error onto the next session.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(provider.status).toBe('stopped');
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(health.filter((e) => e.state === 'api_error')).toHaveLength(0);
    expect(health.filter((e) => e.state === 'failed')).toHaveLength(0);
    expect(health).toContainEqual(
      expect.objectContaining({ component: 'transport', state: 'stopped' }),
    );
  });

  it('stop() during a RECONNECT handshake does not re-arm the ladder or emit reconnecting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, health } = makeHarness();
    await provider.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Drop the live socket so the reconnect ladder arms, then let it dial out
    // with setupComplete withheld so the new handshake stays open.
    wsEmitSetup = false;
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const healthBefore = health.length;
    provider.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    // No third socket, and nothing after the stop pair claims the transport is
    // reconnecting or broken.
    expect(FakeWebSocket.instances).toHaveLength(2);
    const after = health.slice(healthBefore);
    expect(after.filter((e) => e.state === 'reconnecting')).toHaveLength(0);
    expect(after.filter((e) => e.state === 'api_error')).toHaveLength(0);
    expect(after.filter((e) => e.state === 'failed')).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'an initial token settling after restart cannot replace or stop the current session (%s)',
    async (outcome) => {
      vi.useFakeTimers();
      let resolveToken!: (value: Response) => void;
      let rejectToken!: (reason: Error) => void;
      const pendingToken = new Promise<Response>((resolve, reject) => {
        resolveToken = resolve;
        rejectToken = reject;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValueOnce(pendingToken).mockResolvedValue(tokenResponse()),
      );
      const { provider, health } = makeHarness();
      const abandonedStart = provider.start();
      await vi.advanceTimersByTimeAsync(1);
      provider.stop();
      await provider.start();
      const currentSocket = FakeWebSocket.instances[0]!;
      const healthBeforeOldToken = health.length;
      if (outcome === 'resolve') resolveToken(tokenResponse());
      else rejectToken(new Error('old token failed'));
      await abandonedStart;

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(currentSocket.readyState).toBe(FakeWebSocket.OPEN);
      expect(provider.status).toBe('running');
      expect(health.slice(healthBeforeOldToken)).toEqual([]);
      provider.stop();
      provider.stop();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'Stop while reconnect token is pending ignores its late %s',
    async (outcome) => {
      vi.useFakeTimers();
      let resolveToken!: (value: Response) => void;
      let rejectToken!: (reason: Error) => void;
      const pendingToken = new Promise<Response>((resolve, reject) => {
        resolveToken = resolve;
        rejectToken = reject;
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockReturnValueOnce(pendingToken);
      vi.stubGlobal('fetch', fetchMock);
      const { provider, health } = makeHarness();
      await provider.start();
      FakeWebSocket.instances[0]!.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      provider.stop();
      const healthAfterStop = health.length;
      if (outcome === 'resolve') resolveToken(tokenResponse());
      else rejectToken(new Error('token request failed after Stop'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(health.slice(healthAfterStop)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('a late reconnect token cannot replace the socket of a restarted session', async () => {
    vi.useFakeTimers();
    let resolveToken!: (value: Response) => void;
    const pendingToken = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockReturnValueOnce(pendingToken)
        .mockResolvedValue(tokenResponse()),
    );
    const { provider, transcripts } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    provider.stop();
    await provider.start();
    const currentSocket = FakeWebSocket.instances[1]!;
    resolveToken(tokenResponse());
    await vi.advanceTimersByTimeAsync(1);

    expect(FakeWebSocket.instances).toHaveLength(2);
    currentSocket.emit({ serverContent: { inputTranscription: { text: 'Current meeting' } } });
    expect(transcripts.at(-1)?.text).toBe('Current meeting');
    provider.stop();
    provider.stop();
  });

  it('a mic grant after Stop is released without opening a socket', async () => {
    vi.useFakeTimers();
    let resolveMic!: (stream: MediaStream) => void;
    const pendingMic = new Promise<MediaStream>((resolve) => {
      resolveMic = resolve;
    });
    const stopTrack = vi.fn();
    let granted = false;
    const source = {
      acquire: vi.fn(() => pendingMic),
      release: vi.fn(() => {
        if (granted) stopTrack();
      }),
      analyser: null,
    } as unknown as AudioSource;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const h = makeHandlers();
    const provider = new GeminiLiveProvider('http://localhost/session/gemini', h.handlers, source);
    const starting = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    provider.stop();
    granted = true;
    resolveMic({
      getAudioTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(provider.status).toBe('stopped');
  });

  it('restart during a pending mic grant adopts one acquisition without leaking or replacing capture', async () => {
    vi.useFakeTimers();
    __resetAudioEngineForTests();
    let resolveMic!: (stream: MediaStream) => void;
    const pendingMic = new Promise<MediaStream>((resolve) => {
      resolveMic = resolve;
    });
    const stopTrack = vi.fn();
    const grantedStream = {
      getAudioTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const unexpectedStream = {
      getAudioTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const acquire = vi
      .fn()
      .mockImplementationOnce(async (onHealth: (event: HealthEvent) => void) => {
        const stream = await pendingMic;
        onHealth({ kind: 'health', component: 'audio', state: 'connected', timestamp: '' });
        return stream;
      })
      .mockResolvedValue(unexpectedStream);
    let granted = false;
    const release = vi.fn(() => {
      if (granted) stopTrack();
    });
    const source = { acquire, release, analyser: null } as unknown as AudioSource;
    const createMediaStreamSource = vi.fn(() => ({ connect() {} }));
    vi.stubGlobal(
      'AudioContext',
      class {
        readonly state = 'running';
        audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
        destination = {};
        createMediaStreamSource = createMediaStreamSource;
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const h = makeHandlers();
    const provider = new GeminiLiveProvider('http://localhost/session/gemini', h.handlers, source);
    const oldStart = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    provider.stop();
    const newStart = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    granted = true;
    resolveMic(grantedStream);
    await Promise.all([oldStart, newStart]);

    expect(acquire).toHaveBeenCalledOnce();
    expect(createMediaStreamSource).toHaveBeenCalledOnce();
    expect(createMediaStreamSource).toHaveBeenCalledWith(grantedStream);
    expect(stopTrack).not.toHaveBeenCalled();
    expect(provider.status).toBe('running');
    expect(h.health).toContainEqual(
      expect.objectContaining({ component: 'audio', state: 'connected' }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    provider.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
    provider.stop();
    __resetAudioEngineForTests();
  });

  it('Stop during worklet loading does not recreate capture nodes or polling later', async () => {
    vi.useFakeTimers();
    __resetAudioEngineForTests();
    let resolveModule!: () => void;
    const addModule = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveModule = resolve;
        }),
    );
    const createMediaStreamSource = vi.fn(() => ({ connect() {} }));
    vi.stubGlobal(
      'AudioContext',
      class {
        readonly state = 'running';
        audioWorklet = { addModule };
        destination = {};
        createMediaStreamSource = createMediaStreamSource;
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health } = makeHarness();
    const starting = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(addModule).toHaveBeenCalledOnce();
    provider.stop();
    const healthAfterStop = health.length;
    resolveModule();
    await starting;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(createMediaStreamSource).not.toHaveBeenCalled();
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(health.slice(healthAfterStop)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    __resetAudioEngineForTests();
  });

  it('rejects a non-translate Gemini model before opening a socket or audio worklet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse('models/gemini-2.5-flash-native-audio-preview'))),
    );

    const { provider, health } = makeHarness();
    await provider.start();

    expect(provider.status).toBe('stopped');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(recoveryFailureFor('gemini', 'translation')?.kind).toBe('unsupported');
    expect(health).toContainEqual(
      expect.objectContaining({
        component: 'transport',
        state: 'api_error',
        message: expect.stringMatching(/unsupported Gemini model/i),
      }),
    );
  });

  it('does not classify capture permission refusal as a cloud failure', async () => {
    const { handlers, health } = makeHandlers();
    const mic = makeActiveMic();
    vi.mocked(mic.acquire).mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const provider = new GeminiLiveProvider('http://localhost/session/gemini', handlers, mic);
    await provider.start();
    expect(recoveryFailureFor('gemini', 'translation')).toBeUndefined();
    expect(health).toContainEqual(expect.objectContaining({ component: 'audio', state: 'failed' }));
    expect(provider.status).toBe('stopped');
  });

  it('events report the capture that actually ran, not always the microphone', async () => {
    // C3. Every event used to claim 'microphone' regardless, so a session
    // captioning a shared screen produced a transcript log that disagreed with
    // the 🔊 chip on the same screen. Anything reading the events back — export,
    // field-test history — inherited the wrong answer with no way to notice.
    const h = makeHandlers();
    const provider = new GeminiLiveProvider(
      'http://localhost/session/gemini',
      h.handlers,
      undefined,
      'en→zh-TW',
      'off',
      'browser_system',
    );

    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Shared screen audio.' } },
    });

    expect(h.transcripts.at(-1)!.source).toBe('browser_system');
  });

  it.each(['timeout', 'rejection'] as const)(
    'a recoverable worklet %s preserves automatic retry eligibility',
    async (failure) => {
      vi.useFakeTimers();
      __resetAudioEngineForTests();
      let resolveModule!: () => void;
      const addModule = vi
        .fn()
        .mockImplementationOnce(() =>
          failure === 'timeout'
            ? new Promise<void>((resolve) => {
                resolveModule = resolve;
              })
            : Promise.reject(new Error('worklet module temporarily unavailable')),
        )
        .mockImplementationOnce(() =>
          failure === 'rejection'
            ? Promise.reject(new Error('worklet retry unavailable'))
            : Promise.resolve(),
        )
        .mockResolvedValue(undefined);
      vi.stubGlobal(
        'AudioContext',
        class {
          readonly state = 'running';
          readonly sampleRate = 16000;
          audioWorklet = { addModule };
          destination = {};
          createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
          }
        },
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(tokenResponse())),
      );
      const { provider, health } = makeHarness();
      const starting = provider.start();
      await vi.advanceTimersByTimeAsync(5_001);
      await starting;
      expect(provider.status).toBe('stopped');
      expect(health.filter((event) => event.component === 'audio').at(-1)?.state).toBe('degraded');
      expect(recoveryFailureFor('gemini', 'translation')).toBeUndefined();
      expect(health).not.toContainEqual(
        expect.objectContaining({ component: 'audio', state: 'failed' }),
      );
      expect(health.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
        'api_error',
      );
      if (failure === 'timeout') {
        resolveModule();
        await vi.advanceTimersByTimeAsync(1_500);
      }
      expect(health.filter((event) => event.component === 'transport').at(-1)).toMatchObject({
        recoveryFailure: { layer: 'audio', provider: 'gemini', purpose: 'translation' },
      });
      // The meeting controller can retry; no new native module load is needed after a late success.
      await provider.start();
      expect(provider.status).toBe('running');
      const ws = FakeWebSocket.instances.at(-1)!;
      FakeAudioWorkletNode.instances.at(-1)!.port.onmessage?.({
        data: new Float32Array(512).buffer,
      } as MessageEvent);
      expect(ws.sent.some((frame) => JSON.parse(frame).realtimeInput?.audio)).toBe(true);
      expect(addModule).toHaveBeenCalledTimes(failure === 'timeout' ? 1 : 3);
      provider.stop();
      provider.stop();
      __resetAudioEngineForTests();
    },
  );

  it('a capture graph that cannot start reports failed, not degraded', async () => {
    // C3. 'degraded' means worse; this is off. With no AudioContext no audio is
    // ever sent, so the session sat there looking connected and captioning
    // nothing — a silent failure, which the reliability rules forbid outright.
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    __resetAudioEngineForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, health } = makeHarness();
    await provider.start();

    const audio = health.filter((e) => e.component === 'audio');
    expect(audio.at(-1)!.state).toBe('failed');
    expect(audio.at(-1)!.message).toMatch(/cannot capture audio/i);
    expect(provider.status).toBe('stopped');

    provider.stop();
  });

  it('Stop signals end-of-audio and keeps the socket open long enough to land the tail', async () => {
    // A4. Gemini keeps translating for seconds after the last audio frame, so
    // closing on the Stop click drops the final sentence of the meeting.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider, translations } = makeHarness();
    await provider.start();
    const ws = FakeWebSocket.instances.at(-1)!;

    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'And that concludes the update' } },
    });
    provider.handleServerObject({
      serverContent: { outputTranscription: { text: '以上就是報告' } },
    });

    provider.stop();

    // The server is told the microphone went off, so it flushes rather than
    // discarding what it is still holding.
    const sentEnd = ws.sent.some((frame) => {
      const parsed = JSON.parse(frame) as { realtimeInput?: { audioStreamEnd?: boolean } };
      return parsed.realtimeInput?.audioStreamEnd === true;
    });
    expect(sentEnd).toBe(true);
    // Still open to receive that flush…
    expect(ws.readyState).toBe(1);
    // …but the session already reads as stopped to the rest of the app.
    expect(provider.status).toBe('stopped');

    // The tail arrives after the click and must still reach history.
    provider.handleServerObject({
      serverContent: { outputTranscription: { text: '，謝謝大家。' } },
    });
    const finals = translations.filter((t) => t.status === 'final');
    expect(finals.at(-1)!.targetText).toContain('謝謝大家');

    // The drain is bounded — the socket does not linger past the cap.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ws.readyState).toBe(3);
  });

  it('a second Stop ends the drain instead of leaving the socket open', async () => {
    // The hook builds a NEW provider on every start, so the drain guard inside
    // start() never sees the old instance. What the hook can reach is stop(),
    // and it calls it on the previous provider — which already reads as
    // stopped. If that call did nothing, the old socket would stay open and
    // deliver the previous meeting's tail into the new one, after the board
    // had been cleared for a fresh session.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );

    const { provider } = makeHarness();
    await provider.start();
    const ws = FakeWebSocket.instances.at(-1)!;

    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Last words.' } },
    });
    provider.stop();
    expect(ws.readyState).toBe(1); // draining

    // This is the call the hook makes before starting the next session.
    provider.stop();
    expect(ws.readyState).toBe(3);

    // And nothing is left on a timer to fire into whatever runs next.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a replacement that closes immediately after setup still schedules another attempt', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider } = makeHarness();
    await provider.start();
    wsAutoCloseAfterOpen = true;
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_001);
    wsAutoCloseAfterOpen = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(FakeWebSocket.instances).toHaveLength(3);
    provider.stop();
    provider.stop();
  });

  it('late setup from a timed-out socket cannot restore connected health', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    wsEmitSetup = false;
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_001);
    const candidate = FakeWebSocket.instances[1]!;
    candidate.close = () => {
      candidate.readyState = 2;
    };
    await vi.advanceTimersByTimeAsync(15_000);
    const count = health.length;
    candidate.emit({ setupComplete: {} });
    expect(health.slice(count)).toEqual([]);
    provider.stop();
  });

  it('clears failed health when the next retry starts its handshake', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockReturnValueOnce(new Promise(() => {})),
    );
    const { provider, health } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(health.filter((event) => event.component === 'transport').at(-1)?.state).toBe('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(health.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'reconnecting',
    );
    provider.stop();
  });

  it('reports a completed failed attempt, then keeps retrying automatically', async () => {
    // The previous 2s clock interrupted a still-pending setup handshake.
    // Failed now means an actual attempt failed, not simply that time elapsed.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementation(() => Promise.resolve(new Response('upstream gone', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);
    const { provider, health } = makeHarness();
    await provider.start();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(health.some((event) => event.state === 'failed')).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(health.filter((event) => event.component === 'transport').at(-1)?.state).toBe('failed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
    expect(provider.status).toBe('running');
    provider.stop();
  });

  it('persistent reconnect: keeps retrying past 5 attempts and surfaces a failed health state (never gives up / never stop()s)', async () => {
    vi.useFakeTimers();
    // Initial mint OK (so start connects), every subsequent mint fails so each
    // reconnect attempt fails fast and the backoff keeps climbing.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValue(new Response('upstream gone', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { provider, health } = makeHarness();
    await provider.start();
    expect(provider.status).toBe('running');

    // Drop the live socket → triggers the reconnect ladder.
    FakeWebSocket.instances.at(-1)!.close();

    // Walk well past every rung of the capped backoff (1,2,4,8,16,30s).
    await vi.advanceTimersByTimeAsync(120_000);

    // A 'failed' transport health (the failover affordance) must have appeared…
    const failed = health.filter((e) => e.component === 'transport' && e.state === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.at(-1)!.message).toMatch(/switch backend/);
    // …yet the provider is STILL running (auto-heal never gave up / never stopped).
    expect(provider.status).toBe('running');
    // And it really kept minting tokens (≫ the old 5-attempt cap).
    expect(fetchMock.mock.calls.length).toBeGreaterThan(6);

    provider.stop();
  });

  it('connect-then-wedge loop STILL escalates to failed (attempt counter resets on setupComplete, not raw onopen)', async () => {
    // Regression: if reconnectAttempts reset on ws.onopen, a socket that opens
    // then immediately drops (never reaching setupComplete) would oscillate
    // 0↔1 forever and never surface 'failed' → the cross-model failover banner
    // could never appear. The reset must happen on setupComplete (proven live).
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { provider, health } = makeHarness();
    await provider.start();

    // The initial session was proven live. Every reconnect opens, never reaches
    // setupComplete, and drops immediately; those failed reconnects must keep
    // climbing the attempt counter.
    wsEmitSetup = false;
    wsAutoCloseAfterOpen = true;
    FakeWebSocket.instances.at(-1)!.close();

    // Drive many connect-then-drop cycles through the capped backoff.
    await vi.advanceTimersByTimeAsync(120_000);

    const failed = health.filter((e) => e.component === 'transport' && e.state === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(provider.status).toBe('running'); // still retrying, never gave up

    provider.stop();
  });

  it('reconnect succeeds → resets the attempt counter (no premature failed state)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { provider, health } = makeHarness();
    await provider.start();

    // Drop the socket once; the reconnect should re-open (wsAutoOpen) and heal.
    FakeWebSocket.instances.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(2_000);

    // A single transient drop must NOT escalate to 'failed'.
    expect(health.some((e) => e.component === 'transport' && e.state === 'failed')).toBe(false);
    // It reconnected (a second socket was created) and is connected again.
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(health.filter((e) => e.state === 'connected').length).toBeGreaterThanOrEqual(2);

    provider.stop();
  });

  it('receive-side wedge: OPEN socket but no server content while audio is active → forces a reconnect', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { provider, health } = makeHarness();
    await provider.start();
    expect(provider.status).toBe('running');

    const firstSocket = FakeWebSocket.instances.at(-1)!;
    // No further server messages — the socket is wedged. Audio stays active
    // (mic returns -26 dB every 100 ms tick). After 30 s DC silence + ≥100
    // active samples the detector must fire.
    await vi.advanceTimersByTimeAsync(35_000);

    const wedged = health.find(
      (e) => e.component === 'transport' && e.state === 'degraded' && e.message?.includes('Wedged'),
    );
    expect(wedged).toBeDefined();
    expect(wedged!.message).toMatch(/no server content while audio active/);
    // The wedged socket was closed and a fresh one opened (reconnect).
    expect(firstSocket.closeCount).toBeGreaterThan(0);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(provider.status).toBe('running');

    provider.stop();
  });

  it('wedge detector does NOT fire while server content keeps arriving', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { provider, health } = makeHarness();
    await provider.start();
    const socket = FakeWebSocket.instances.at(-1)!;

    // Emit a server message every 5 s for 60 s — well within the 30 s window,
    // so the detector clock keeps resetting and never trips.
    for (let i = 0; i < 12; i++) {
      socket.emit({ serverContent: { inputTranscription: { text: `chunk ${i} ` } } });
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(health.some((e) => e.state === 'degraded' && e.message?.includes('Wedged'))).toBe(false);
    // Only the initial socket — no reconnect happened.
    expect(FakeWebSocket.instances.length).toBe(1);

    provider.stop();
  });

  it('two hours of simulated meeting time rotate repeatedly without extra capture or leftover timers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tokenResponse())),
    );
    const { provider, health, translations } = makeHarness();
    await provider.start();
    let sequence = 0;
    const speech = setInterval(() => {
      sequence += 1;
      FakeWebSocket.instances.at(-1)!.emit({
        serverContent: {
          inputTranscription: { text: `Meeting item ${sequence}.` },
          outputTranscription: { text: `會議項目 ${sequence}。` },
          turnComplete: true,
        },
      });
      FakeAudioWorkletNode.instances[0]!.port.onmessage?.({
        data: new Float32Array(512).buffer,
      } as MessageEvent);
    }, 10_000);
    try {
      for (let rotation = 0; rotation < 24; rotation += 1) {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        FakeWebSocket.instances.at(-1)!.emit({ goAway: { timeLeft: '50s' } });
      }
      await vi.advanceTimersByTimeAsync(30_001);
      expect(FakeWebSocket.instances).toHaveLength(25);
      expect(FakeWebSocket.instances.filter((socket) => socket.readyState === 1)).toHaveLength(1);
      expect(FakeAudioWorkletNode.instances).toHaveLength(1);
      expect(translations.filter((event) => event.status === 'final')).toHaveLength(sequence);
      expect(health.some((event) => event.state === 'failed')).toBe(false);
      expect(provider.status).toBe('running');
    } finally {
      clearInterval(speech);
      provider.stop();
      provider.stop();
    }
    expect(FakeWebSocket.instances.filter((socket) => socket.readyState === 1)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);

  it('stop() halts the reconnect ladder (no further sockets / no leaked timers)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValue(new Response('gone', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = makeHarness();
    await provider.start();
    FakeWebSocket.instances.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(3_000);

    provider.stop();
    const callsAfterStop = fetchMock.mock.calls.length;
    const socketsAfterStop = FakeWebSocket.instances.length;

    // Advance far past every backoff — a stopped provider must not reconnect.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
    expect(FakeWebSocket.instances.length).toBe(socketsAfterStop);
    expect(provider.status).toBe('stopped');
  });
});
