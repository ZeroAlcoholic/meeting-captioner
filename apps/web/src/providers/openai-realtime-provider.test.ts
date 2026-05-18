import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioLevelEvent, HealthEvent, TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import type { CaptionProviderHandlers } from './types.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';

// ── Globals mutated per test ───────────────────────────────────────────────────

let fireDCMessage: (data: string) => void = () => {};
let fakeIceState = 'connected';
let fakeConnectionState = 'connected';
let fakeRestartIce: ReturnType<typeof vi.fn>;
let fakePCClose: ReturnType<typeof vi.fn>;
let lastPC: { fireIce: () => void; fireConn: () => void } | null = null;

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeFakeRTCPeerConnectionClass() {
  return class FakePeerConnection {
    oniceconnectionstatechange: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    constructor() {
      lastPC = {
        fireIce: () => this.oniceconnectionstatechange?.(),
        fireConn: () => this.onconnectionstatechange?.(),
      };
    }

    get iceConnectionState() {
      return fakeIceState;
    }
    get connectionState() {
      return fakeConnectionState;
    }

    createDataChannel() {
      const dc = { onmessage: null as ((e: MessageEvent<string>) => void) | null };
      fireDCMessage = (data: string) => dc.onmessage?.({ data } as MessageEvent<string>);
      return dc;
    }

    addTrack() {}
    async createOffer() {
      return { type: 'offer', sdp: 'mock-offer-sdp' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    restartIce = fakeRestartIce;
    close = fakePCClose;
  };
}

function makeFakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function makeFakeAnalyser() {
  const buf = new Float32Array(2048).fill(0.05);
  return {
    fftSize: 2048,
    getFloatTimeDomainData: (out: Float32Array) => out.set(buf),
  } as unknown as AnalyserNode;
}

function makeFakeAudioContext(analyser: AnalyserNode) {
  return class {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return analyser; }
    close() { return Promise.resolve(); }
  } as unknown as typeof AudioContext;
}

function mockFetch(clientSecretValue = 'test-ephemeral-token') {
  vi.stubGlobal(
    'fetch',
    vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_secret: { value: clientSecretValue } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 })),
  );
}

function makeHandlers() {
  const transcripts: TranscriptEvent[] = [];
  const translations: TranslationEvent[] = [];
  const healthEvents: HealthEvent[] = [];
  const audioLevels: AudioLevelEvent[] = [];
  const handlers: CaptionProviderHandlers = {
    onTranscript: (e) => transcripts.push(e),
    onTranslation: (e) => translations.push(e),
    onHealth: (e) => healthEvents.push(e),
    onAudioLevel: (e) => audioLevels.push(e),
  };
  return { handlers, transcripts, translations, healthEvents, audioLevels };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  fakeIceState = 'connected';
  fakeConnectionState = 'connected';
  fireDCMessage = () => {};
  fakeRestartIce = vi.fn();
  fakePCClose = vi.fn();
  lastPC = null;

  const analyser = makeFakeAnalyser();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(makeFakeStream()) },
  });
  vi.stubGlobal('AudioContext', makeFakeAudioContext(analyser));
  vi.stubGlobal('RTCPeerConnection', makeFakeRTCPeerConnectionClass());
  // MicrophoneAudioProvider attaches a visibilitychange listener on `document`
  // to resume the AudioContext after tab refocus. Stub a minimal document so
  // node-environment tests can exercise the full acquire/release cycle.
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenAIRealtimeProvider', () => {
  it('start() emits health: audio requesting_permission→connected, transport connecting→connected', async () => {
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    const pairs = healthEvents.map((e) => `${e.component}:${e.state}`);
    expect(pairs).toContain('audio:requesting_permission');
    expect(pairs).toContain('audio:connected');
    expect(pairs).toContain('transport:connecting');
    expect(pairs).toContain('transport:connected');
    provider.stop();
  });

  it('stop() emits stopped events and sets status to stopped', async () => {
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    provider.stop();

    expect(provider.status).toBe('stopped');
    expect(healthEvents.some((e) => e.state === 'stopped')).toBe(true);
  });

  it('session.input_transcript.delta → onTranscript with accumulated text and status:partial', async () => {
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }));
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: ' world' }));

    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]!.status).toBe('partial');
    expect(transcripts[0]!.text).toBe('Hello');
    expect(transcripts[1]!.text).toBe('Hello world');
    // same segmentId for both deltas within one segment
    expect(transcripts[0]!.segmentId).toBe(transcripts[1]!.segmentId);
    provider.stop();
  });

  it('translation-only mode synthesizes a zero-text partial transcript on each output delta', async () => {
    // Regression guard (Codex P1): without this synthetic transcript the
    // caption store sees no livePartial in translation-only mode, so
    // applyTranslation routes drafts into the history map and LiveCaption
    // shows blank until the 1 s flush. The provider must anchor the live
    // segment by emitting an empty partial transcript alongside the
    // translation event.
    mockFetch();
    const { handlers, transcripts, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider(
      'http://localhost:8787/session',
      handlers,
      'en→zh-TW',
      undefined,
      false, // includeSourceTranscript
    );

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));

    // Exactly one synthetic transcript paired with the translation.
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.status).toBe('partial');
    expect(transcripts[0]!.text).toBe('');
    expect(translations).toHaveLength(1);
    expect(translations[0]!.targetText).toBe('你好');
    // Same segmentId on both sides — that's what lets applyTranslation
    // route the draft into liveTranslation.
    expect(transcripts[0]!.segmentId).toBe(translations[0]!.sourceSegmentId);

    provider.stop();
  });

  it('bilingual mode does NOT synthesize a partial transcript on output deltas', async () => {
    // Negative case: when source transcription is enabled OpenAI sends its
    // own input_transcript.delta — synthesizing a second partial would
    // race the real one and corrupt inputAcc display.
    mockFetch();
    const { handlers, transcripts, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider(
      'http://localhost:8787/session',
      handlers,
      'en→zh-TW',
      undefined,
      true, // includeSourceTranscript (default)
    );

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));

    expect(transcripts).toHaveLength(0);
    expect(translations).toHaveLength(1);

    provider.stop();
  });

  it('session.output_transcript.delta → onTranslation with accumulated targetText and status:draft', async () => {
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '，世界' }));

    expect(translations).toHaveLength(2);
    expect(translations[0]!.status).toBe('draft');
    expect(translations[0]!.targetText).toBe('你好');
    expect(translations[1]!.targetText).toBe('你好，世界');
    provider.stop();
  });

  it('segment flush timer emits final transcript and translation after SEGMENT_FLUSH_MS', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, transcripts, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello ' }));
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'world.' }));
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好，世界。' }));

    // only partial/draft so far
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);

    // advance past flush timer
    vi.advanceTimersByTime(1001);

    const finals = transcripts.filter((t) => t.status === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('Hello world.');

    const finalTrans = translations.filter((t) => t.status === 'final');
    expect(finalTrans).toHaveLength(1);
    expect(finalTrans[0]!.targetText).toBe('你好，世界。');

    provider.stop();
  });

  it('flush timer resets on each new input delta (debounce)', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'part1 ' }));
    vi.advanceTimersByTime(800); // not flushed yet
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'part2' }));
    vi.advanceTimersByTime(800); // not flushed (timer reset)
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);
    vi.advanceTimersByTime(300); // now past 1000ms since last delta
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(transcripts.filter((t) => t.status === 'final')[0]!.text).toBe('part1 part2');

    provider.stop();
  });

  it('absolute deadline finalizes continuous speech every ~12s even without a >1s gap', async () => {
    // Critical UX regression guard: a presenter who talks continuously
    // (no >1 s pauses) would previously NEVER hit the debounce flush, so
    // segments[] stayed empty, HistoryStream was blank, and LiveCaption
    // showed a single unbounded growing partial that visually "froze" on
    // the first few words once the text overflowed. The deadline timer
    // forces a finalization regardless of inter-delta gaps.
    vi.useFakeTimers();
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    // Pump a delta every 500 ms for 13 s — well under the 1 s debounce so
    // the segmentFlushTimer would NEVER fire on its own.
    for (let i = 0; i < 26; i++) {
      fireDCMessage(
        JSON.stringify({ type: 'session.input_transcript.delta', delta: `word${i} ` }),
      );
      await vi.advanceTimersByTimeAsync(500);
    }

    // At t=13 s with deltas at 500 ms cadence, we should have hit the
    // 12 s deadline exactly once → 1 final emitted.
    const finals = transcripts.filter((t) => t.status === 'final');
    expect(finals.length).toBeGreaterThanOrEqual(1);
    // The final should contain SOME of the accumulated text — the exact
    // boundary depends on when within the 500 ms window the deadline lands.
    expect(finals[0]!.text.length).toBeGreaterThan(0);
    expect(finals[0]!.text).toMatch(/^word/);

    provider.stop();
  });

  it('session.input_transcript.completed event triggers immediate finalization', async () => {
    // When OpenAI tells us an utterance is done, we shouldn't wait the
    // 1 s debounce — commit instantly so the next sentence starts in a
    // fresh segment with a fresh segmentId.
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello world' }));
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);

    // OpenAI signals utterance complete — no waiting on debounce.
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.completed' }));

    const finals = transcripts.filter((t) => t.status === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('Hello world');

    provider.stop();
  });

  it('flush produces new segment — subsequent deltas use a new segmentId', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'first' }));
    const seg1 = transcripts[0]!.segmentId;
    vi.advanceTimersByTime(1001);
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'second' }));
    const seg2 = transcripts.at(-1)!.segmentId;

    expect(seg1).not.toBe(seg2);
    provider.stop();
  });

  it('zh-TW→en langPair emits correct source/target language metadata', async () => {
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers, 'zh-TW→en');

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'hello' }));

    expect(translations[0]!.sourceLanguage).toBe('zh-TW');
    expect(translations[0]!.targetLanguage).toBe('en');
    provider.stop();
  });

  it('error event → health api_error emitted with message', async () => {
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'error', error: { message: 'Rate limit exceeded' } }));

    const errorEvent = healthEvents.find((e) => e.state === 'api_error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toBe('Rate limit exceeded');
    provider.stop();
  });

  it('/session returning 503 → health api_error emitted, status becomes stopped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('no key', { status: 503 })));
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(provider.status).toBe('stopped');
    expect(healthEvents.find((e) => e.state === 'api_error')).toBeDefined();
  });

  it('stop() called between fetch and SDP exchange short-circuits cleanly (no NPE, no misleading api_error)', async () => {
    // Robustness: races where the user clicks Stop during the multi-await
    // bring-up must not throw or emit a 'connected' health event after the
    // stop. We block the SDP fetch on a never-resolving promise, call stop()
    // mid-flight, then resolve to let start() see status !== 'running'.
    let resolveSdp: ((r: Response) => void) | null = null;
    const sdpPromise = new Promise<Response>((r) => { resolveSdp = r; });
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'tok' } }), { status: 200 }),
        )
        .mockReturnValueOnce(sdpPromise),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    const startPromise = provider.start();
    // Yield enough microtasks for /session fetch to resolve and SDP fetch to be issued.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    provider.stop();
    // Now let the SDP promise resolve — the abort guard must take over.
    resolveSdp!(new Response('mock-sdp', { status: 200 }));
    await startPromise;

    expect(provider.status).toBe('stopped');
    // We must NOT see 'transport: connected' after stop() — that would
    // indicate the bring-up completed in spite of the abort.
    const connectedAfterStop = healthEvents
      .filter((e) => e.component === 'transport')
      .map((e) => e.state)
      .includes('connected');
    expect(connectedAfterStop).toBe(false);
  });

  it('mic acquire failure → emits health.audio.failed (not transport.api_error) and stops', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValueOnce(new Error('Permission denied')),
      },
    });
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(provider.status).toBe('stopped');
    const audioFails = healthEvents.filter(
      (e) => e.component === 'audio' && e.state === 'failed',
    );
    const transportFails = healthEvents.filter(
      (e) => e.component === 'transport' && e.state === 'api_error',
    );
    expect(audioFails.length).toBeGreaterThan(0);
    // The transport never even started — should NOT see transport api_error.
    expect(transportFails).toHaveLength(0);
  });

  it('renewal failure schedules persistent retry backoff (30s → 1m → 3m → 5m → 10m cap)', async () => {
    // Long-meeting robustness: the persistent backoff must keep climbing
    // 30s → 1m → 3m → 5m → 10m → 10m (cap) on each consecutive failure,
    // AND the renewalRetryTimer must be set every time so cleanup() can
    // cancel it on user-initiated stop. The schedule was originally
    // 5/10/20/30 min — too long for a live meeting; tightened so transient
    // OpenAI hiccups recover in under a minute.
    vi.useFakeTimers();

    // First /session succeeds (initial start). Every subsequent /session
    // fetch fails so each renewal attempt fails too.
    const fetchMock = vi.fn();
    // Initial bring-up: /session OK + SDP OK
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client_secret: { value: 'tok' },
          session_renewal_recommended_ms: 1000, // 1s renewal so we can test quickly
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 }));
    // Every subsequent /session fails (renewal attempts).
    fetchMock.mockResolvedValue(new Response('upstream gone', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    expect(provider.status).toBe('running');

    // Extract retry-delay (seconds or minutes) from the latest 'failed' health message.
    const lastRetrySec = (): number | null => {
      const last = healthEvents
        .filter((e) => e.component === 'transport' && e.state === 'failed')
        .at(-1);
      const min = last?.message?.match(/auto-retry in (\d+) min/);
      if (min) return Number(min[1]) * 60;
      const sec = last?.message?.match(/auto-retry in (\d+) sec/);
      if (sec) return Number(sec[1]);
      return null;
    };

    // 1) Trigger first renewal at the recommended interval (1s).
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(30);

    // 2) Advance 30 s → next failure schedules 1 min.
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(60);

    // 3) Advance 1 min → 3 min.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(180);

    // 4) Advance 3 min → 5 min.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(300);

    // 5) Advance 5 min → 10 min (cap).
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(600);

    // 6) Cap holds.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastRetrySec()).toBe(600);

    provider.stop();
  });

  it('stop() cancels the pending renewal-retry timer even when already stopped', async () => {
    // Regression guard (Codex P1): after a renewal failure the instance
    // settles into _status='stopped' WITH a renewalRetryTimer pending.
    // If the user manually starts a new session, the hook calls stop()
    // on the prior provider — that stop() must run cleanup() even though
    // status is already 'stopped', otherwise the orphan timer fires later
    // and opens a parallel session.
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client_secret: { value: 'tok' },
          session_renewal_recommended_ms: 1000,
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 }));
    // All subsequent /session fail → renewal kicks into retry backoff.
    fetchMock.mockResolvedValue(new Response('gone', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    expect(provider.status).toBe('running');

    // Trigger the first renewal (which will fail and schedule a 5-min retry).
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.status).toBe('stopped');
    // Retry timer is now armed.

    // Snapshot how many fetch calls were made before stop().
    const callsBeforeStop = fetchMock.mock.calls.length;

    // Now: manual stop() while still in 'stopped'. Must cancel retry timer.
    provider.stop();

    // Advance well past the 5-min retry threshold. If the timer wasn't
    // cancelled the provider would call /session again on its own.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeStop);
  });

  it('connectionState=failed → triggers session renewal (not stop)', async () => {
    // Business-meeting reliability: a peer connection failure must self-heal
    // via a fresh session bring-up rather than dropping the user back to a
    // manual "click Start" state. The renewal path runs cleanup+start; the
    // event itself must be a non-terminal 'reconnecting' (not 'failed' +
    // stop) so the UI surfaces a recovery state rather than a dead session.
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    fakeConnectionState = 'failed';
    lastPC?.fireConn();
    // Microtask flush so the void renewSession() chain starts.
    await Promise.resolve();

    // Health is 'reconnecting' with the rebuild message — NOT a terminal
    // 'failed' that would leave the user staring at a stopped session.
    expect(
      healthEvents.some(
        (e) =>
          e.component === 'transport' &&
          e.state === 'reconnecting' &&
          e.message?.includes('rebuilding session'),
      ),
    ).toBe(true);
    // No terminal 'failed' for the peer-connection failure itself.
    expect(
      healthEvents.filter(
        (e) =>
          e.component === 'transport' &&
          e.state === 'failed' &&
          e.message?.includes('Peer connection failed'),
      ),
    ).toHaveLength(0);
    provider.stop();
  });

  it('ICE disconnected → backoff schedules restartIce with 3s/6s/12s, then triggers session renewal', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    fakeIceState = 'disconnected';

    // Attempt 1 — fires after 3 s
    lastPC?.fireIce();
    expect(fakeRestartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(fakeRestartIce).toHaveBeenCalledTimes(1);

    // Attempt 2 — fires after 6 s
    lastPC?.fireIce();
    vi.advanceTimersByTime(6000);
    expect(fakeRestartIce).toHaveBeenCalledTimes(2);

    // Attempt 3 — fires after 12 s
    lastPC?.fireIce();
    vi.advanceTimersByTime(12_000);
    expect(fakeRestartIce).toHaveBeenCalledTimes(3);

    // Attempt 4 — exhausted, escalates to full session renewal (not stop).
    lastPC?.fireIce();
    await Promise.resolve();
    expect(
      healthEvents.some(
        (e) =>
          e.component === 'transport' &&
          e.state === 'reconnecting' &&
          e.message?.includes('rebuilding session'),
      ),
    ).toBe(true);
    // No terminal 'failed' for ICE exhaustion — renewal is in flight.
    expect(
      healthEvents.filter(
        (e) =>
          e.component === 'transport' &&
          e.state === 'failed' &&
          e.message?.includes('ICE restart attempts exhausted'),
      ),
    ).toHaveLength(0);
    provider.stop();
  });

  it('ICE returning to connected resets the backoff counter', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    fakeIceState = 'disconnected';
    lastPC?.fireIce();
    vi.advanceTimersByTime(3000);
    fakeIceState = 'connected';
    lastPC?.fireIce();

    // After recovery a new disconnect should restart from 3 s, not 6 s.
    fakeIceState = 'disconnected';
    lastPC?.fireIce();
    vi.advanceTimersByTime(2999);
    expect(fakeRestartIce).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    expect(fakeRestartIce).toHaveBeenCalledTimes(2);

    provider.stop();
  });

  it('getRenewalEtaMs() returns null before start, positive after start, null after stop', async () => {
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    expect(provider.getRenewalEtaMs()).toBeNull();
    await provider.start();
    const eta = provider.getRenewalEtaMs();
    expect(eta).not.toBeNull();
    expect(eta!).toBeGreaterThan(0);
    expect(eta!).toBeLessThanOrEqual(25 * 60 * 1000);
    provider.stop();
    expect(provider.getRenewalEtaMs()).toBeNull();
  });

  it('honors session_renewal_recommended_ms from /session response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              client_secret: { value: 'tok' },
              session_renewal_recommended_ms: 60_000,
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 })),
    );
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    const eta = provider.getRenewalEtaMs();
    expect(eta).not.toBeNull();
    expect(eta!).toBeLessThanOrEqual(60_000);
    expect(eta!).toBeGreaterThan(50_000);
    provider.stop();
  });

  it('audio level polling emits AudioLevelEvents at ~100ms intervals', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, audioLevels } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();
    vi.advanceTimersByTime(350);

    expect(audioLevels.length).toBeGreaterThanOrEqual(3);
    expect(audioLevels[0]!.source).toBe('microphone');
    expect(typeof audioLevels[0]!.rmsDb).toBe('number');
    expect(typeof audioLevels[0]!.peakDb).toBe('number');

    provider.stop();
  });
});
