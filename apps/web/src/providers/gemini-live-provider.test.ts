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
  GeminiLiveProvider,
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

  it('goAway emits reconnecting health', () => {
    const { provider, health } = makeProvider();
    provider.handleServerObject({ goAway: { timeLeft: '5s' } });
    expect(health.at(-1)).toMatchObject({ component: 'transport', state: 'reconnecting' });
  });

  it('goAway finalizes the in-flight turn so it is not orphaned across the rotation', () => {
    // Regression: a GoAway (and the wedge-driven forceReconnect, which shares
    // finalizeTurn) must commit the half-spoken utterance before closing —
    // otherwise the resumed session keeps appending into the stale curId.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Half spoken' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '說一半' } } });
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);

    provider.handleServerObject({ goAway: { timeLeft: '5s' } });

    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(transcripts.at(-1)).toMatchObject({ status: 'final', text: 'Half spoken' });
    expect(translations.some((t) => t.status === 'final' && t.targetText === '說一半')).toBe(true);
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
  onclose: (() => void) | null = null;
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

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(): void {}
  disconnect(): void {}
}

function makeFakeAudioContextClass() {
  return class {
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
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    }),
    release: vi.fn(),
  } as unknown as AudioSource;
}

function tokenResponse(model = 'models/gemini-3.5-live-translate-preview'): Response {
  return new Response(JSON.stringify({ token: 'ephemeral', model }), { status: 200 });
}

describe('GeminiLiveProvider — reconnect + wedge detection (#16)', () => {
  beforeEach(() => {
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
    expect(health).toContainEqual(
      expect.objectContaining({
        component: 'transport',
        state: 'api_error',
        message: expect.stringMatching(/unsupported Gemini model/i),
      }),
    );
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

    // Walk through more than RECONNECT_FAILED_HEALTH_AFTER (5) attempts. The
    // capped backoff is 1,2,4,8,16,30s — advance generously past all of them.
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
