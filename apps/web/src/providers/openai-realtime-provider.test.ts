import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import type { CaptionProviderHandlers } from './types.js';
import { leaseCapture, __resetCaptureLeaseForTests } from './capture-lease.js';
import { OpenAIWsOpenError } from './openai-ws-transport.js';
import { __resetRecoveryFailuresForTests, recoveryHttpError } from './recovery-attempt.js';
afterEach(() => __resetRecoveryFailuresForTests());
import {
  OpenAIRealtimeProvider,
  prewarmOpenAISession,
  sessionRequestBody,
  __resetWarmSessionForTests,
  __resetOpenAITransportBlocksForTests,
  __setOpenAIWsOpenerForTests,
} from './openai-realtime-provider.js';

// ── Globals mutated per test ───────────────────────────────────────────────────

let fireDCMessage: (data: string) => void = () => {};
let fakeIceState = 'connected';
let fakeConnectionState = 'connected';
let fakeRestartIce: ReturnType<typeof vi.fn>;
let fakePCClose: ReturnType<typeof vi.fn>;
let addedTrackKinds: string[] = [];
let lastPC: { fireIce: () => void; fireConn: () => void } | null = null;
let nextPeerState: string | undefined;
let nextDataChannelState: RTCDataChannelState | undefined;
let nextSessionCreated: boolean | undefined;
let peerControls: Array<{
  close: ReturnType<typeof vi.fn>;
  setState: (state: string) => void;
  setDataChannelState: (state: RTCDataChannelState) => void;
  emit: (event: unknown) => void;
  sent: string[];
  replaceTrack: ReturnType<typeof vi.fn>;
  tracks: MediaStreamTrack[];
  transceivers: string[];
  setRemoteDescription: ReturnType<typeof vi.fn>;
}> = [];

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeFakeRTCPeerConnectionClass() {
  return class FakePeerConnection {
    oniceconnectionstatechange: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    private stateOverride = nextPeerState;
    private autoSessionCreated = nextSessionCreated ?? true;
    private dc: {
      onmessage: ((event: MessageEvent<string>) => void) | null;
      readyState: RTCDataChannelState;
      onopen: (() => void) | null;
      onclose: (() => void) | null;
    } | null = null;
    private sent: string[] = [];
    private replaceTrack = vi.fn().mockResolvedValue(undefined);
    private tracks: MediaStreamTrack[] = [];
    private transceivers: string[] = [];

    constructor() {
      nextPeerState = undefined;
      nextSessionCreated = undefined;
      peerControls.push({
        close: this.close,
        sent: this.sent,
        replaceTrack: this.replaceTrack,
        tracks: this.tracks,
        transceivers: this.transceivers,
        setRemoteDescription: this.setRemoteDescription,
        setState: (state) => {
          this.stateOverride = state;
          this.onconnectionstatechange?.();
        },
        setDataChannelState: (state) => {
          if (!this.dc) return;
          this.dc.readyState = state;
          if (state === 'open') this.dc.onopen?.();
          if (state === 'open' && this.autoSessionCreated)
            this.dc.onmessage?.({
              data: JSON.stringify({ type: 'session.created' }),
            } as MessageEvent<string>);
          if (state === 'closed') this.dc.onclose?.();
        },
        emit: (event) =>
          this.dc?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>),
      });
      lastPC = {
        fireIce: () => this.oniceconnectionstatechange?.(),
        fireConn: () => this.onconnectionstatechange?.(),
      };
    }

    get iceConnectionState() {
      return fakeIceState;
    }
    get connectionState() {
      return this.stateOverride ?? fakeConnectionState;
    }

    createDataChannel() {
      const dc = {
        onmessage: null as ((e: MessageEvent<string>) => void) | null,
        readyState: nextDataChannelState ?? ('open' as RTCDataChannelState),
        onopen: null as (() => void) | null,
        onclose: null as (() => void) | null,
        send: (data: string) => this.sent.push(data),
      };
      this.dc = dc;
      nextDataChannelState = undefined;
      fireDCMessage = (data: string) => dc.onmessage?.({ data } as MessageEvent<string>);
      return dc;
    }

    addTrack(track: MediaStreamTrack) {
      addedTrackKinds.push(track.kind);
      this.tracks.push(track);
    }
    addTransceiver(kind: string) {
      this.transceivers.push(kind);
      return { sender: { replaceTrack: this.replaceTrack } };
    }
    getSenders() {
      return [{ replaceTrack: this.replaceTrack }];
    }
    async createOffer() {
      return { type: 'offer', sdp: 'mock-offer-sdp' };
    }
    async setLocalDescription() {}
    setRemoteDescription = vi.fn(async () => {
      if (this.autoSessionCreated && this.dc?.readyState === 'open')
        this.dc.onmessage?.({
          data: JSON.stringify({ type: 'session.created' }),
        } as MessageEvent<string>);
    });
    restartIce = fakeRestartIce;
    close = vi.fn(() => fakePCClose());
  };
}

function makeFakeStream() {
  const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const videoTrack = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [audioTrack, videoTrack],
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
  } as unknown as MediaStream;
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
    state: AudioContextState = 'running';
    sampleRate = 16000;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return analyser;
    }
    close() {
      return Promise.resolve();
    }
  } as unknown as typeof AudioContext;
}

function mockFetch(clientSecretValue = 'test-ephemeral-token') {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_secret: { value: clientSecretValue } }), {
          status: 200,
        }),
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
  // The WebSocket transport is a real network client; unit tests must never
  // reach it. Default to "unavailable" (a NON-auth failure, so the key-failover
  // ladder still behaves as it did before the transport existed); the
  // transport-specific tests below install their own opener.
  __resetOpenAITransportBlocksForTests();
  __resetWarmSessionForTests();
  __setOpenAIWsOpenerForTests(() =>
    Promise.reject(new Error('WebSocket transport unavailable in this test')),
  );
  fakeIceState = 'connected';
  fakeConnectionState = 'connected';
  fireDCMessage = () => {};
  fakeRestartIce = vi.fn();
  fakePCClose = vi.fn();
  addedTrackKinds = [];
  lastPC = null;
  nextPeerState = undefined;
  nextDataChannelState = undefined;
  nextSessionCreated = undefined;
  peerControls = [];

  const analyser = makeFakeAnalyser();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(makeFakeStream()) },
  });
  vi.stubGlobal('AudioContext', makeFakeAudioContext(analyser));
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null, close() {} };
      connect() {}
      disconnect() {}
    },
  );
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
  it('does not let a previously warm token bypass a later permanent refusal', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ client_secret: { value: 'warm', expires_at: Date.now() / 1000 + 3600 } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    prewarmOpenAISession('/session', sessionRequestBody('en→zh-TW', true, 'meeting'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    recoveryHttpError(new Response(null, { status: 401 }), 'openai', 'translation');
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    expect(provider.status).toBe('stopped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      const { handlers, healthEvents } = makeHandlers();
      const first = new OpenAIRealtimeProvider('/session', handlers);
      await first.start();
      expect(healthEvents).toContainEqual(
        expect.objectContaining({
          recoveryFailure: expect.objectContaining({
            kind,
            provider: 'openai',
            purpose: 'translation',
          }),
        }),
      );
      const next = new OpenAIRealtimeProvider('/session', handlers);
      await next.start();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      next.stop();
    },
  );
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

  it.each(['closed', 'cap', 'second Stop'] as const)(
    'preserves the Stop translation tail and settles at %s without restarting capture',
    async (ending) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, transcripts, translations, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      const peer = peerControls[0]!;
      peer.emit({ type: 'session.input_transcript.delta', delta: 'Do not' });
      peer.emit({ type: 'session.output_transcript.delta', delta: '不要' });
      const segmentId = transcripts.at(-1)!.segmentId;
      provider.stop({ drain: true });
      expect(provider.status).toBe('stopped');
      expect(peer.tracks[0]!.stop).toHaveBeenCalled();
      expect(peer.close).not.toHaveBeenCalled();
      let settled = false;
      const stopped = provider.waitForStop().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(peer.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'session.close' });
      const stoppedHealth = [...healthEvents];
      peer.emit({ type: 'session.input_transcript.delta', delta: ' approve.' });
      peer.emit({ type: 'session.output_transcript.delta', delta: '核准。' });
      if (ending === 'closed') {
        peer.emit({ type: 'session.closed' });
        await vi.advanceTimersByTimeAsync(251);
      } else if (ending === 'cap') await vi.advanceTimersByTimeAsync(10_001);
      else provider.stop();
      await stopped;
      expect(transcripts.at(-1)).toMatchObject({
        segmentId,
        text: 'Do not approve.',
        status: 'final',
      });
      expect(translations.at(-1)).toMatchObject({
        sourceSegmentId: segmentId,
        targetText: '不要核准。',
        status: 'final',
      });
      expect(peer.close).toHaveBeenCalledOnce();
      expect(healthEvents).toEqual(stoppedHealth);
      const count = transcripts.length;
      peer.emit({ type: 'session.input_transcript.delta', delta: ' stale' });
      expect(transcripts).toHaveLength(count);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reports an active protocol auth refusal with normalized recovery evidence', async () => {
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'error', error: { code: 'invalid_api_key' } }));
    expect(healthEvents.at(-1)).toMatchObject({
      state: 'failed',
      recoveryFailure: { kind: 'auth', provider: 'openai' },
    });
    provider.stop();
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

  it('does not publish whitespace-only input or output when stopped', async () => {
    mockFetch();
    const { handlers, transcripts, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: ' ' }));
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: ' ' }));
    provider.stop();
    expect(transcripts).toEqual([]);
    expect(translations).toEqual([]);
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

  it('bilingual mode ALSO anchors a live partial on output deltas, carrying the source-so-far', async () => {
    // The dominant "OpenAI 無法顯示字幕" failure: the translation
    // (output_transcript.delta) streams continuously while the source whisper
    // transcript (input_transcript.delta) lags to utterance end. If the
    // provider only anchored livePartial from input deltas, the live
    // translated caption would stay blank for the whole utterance because
    // applyTranslation routes drafts into the finalized map with no live
    // segment to bind to. So bilingual mode anchors a partial too — but
    // carrying the source-so-far (inputAcc), never a bare '' that would
    // clobber a real input delta.
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
    // Real source delta arrives first…
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }));
    // …then the translation streams; the anchor partial must carry 'Hello',
    // not overwrite it with ''.
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));

    const partials = transcripts.filter((t) => t.status === 'partial');
    // One from the input delta, one anchored alongside the output delta.
    expect(partials).toHaveLength(2);
    expect(partials[1]!.text).toBe('Hello'); // source-so-far, not ''
    expect(translations).toHaveLength(1);
    expect(translations[0]!.targetText).toBe('你好');
    // Same segmentId binds the draft to the live segment.
    expect(partials[1]!.segmentId).toBe(translations[0]!.sourceSegmentId);

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
    fireDCMessage(
      JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好，世界。' }),
    );

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
      fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: `word${i} ` }));
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

  it('links a deadline-split date through partial and final, then breaks at idle', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    for (let i = 0; i < 16; i += 1) {
      fireDCMessage(
        JSON.stringify({
          type: 'session.output_transcript.delta',
          delta: i === 15 ? '九月十五' : '背景',
        }),
      );
      vi.advanceTimersByTime(750);
    }
    const preceding = transcripts.filter((event) => event.status === 'final').at(-1)!;
    expect(preceding).toBeDefined();
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '日' }));
    expect(transcripts.at(-1)).toHaveProperty('continuationOf', preceding.segmentId);
    vi.advanceTimersByTime(1_001);
    expect(transcripts.at(-1)).toMatchObject({
      status: 'final',
      continuationOf: preceding.segmentId,
    });
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '新的句子' }));
    expect(transcripts.at(-1)).not.toHaveProperty('continuationOf');
    provider.stop();
  });

  it.each(['idle', 'completed', 'restart', 'renewal'] as const)(
    'clears a pending deadline continuation at %s',
    async (boundary) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, transcripts } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
      await provider.start();
      for (let i = 0; i < 16; i += 1) {
        fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '文字' }));
        vi.advanceTimersByTime(750);
      }
      if (boundary === 'idle') vi.advanceTimersByTime(1_001);
      else if (boundary === 'completed')
        fireDCMessage(JSON.stringify({ type: 'session.output_transcript.completed' }));
      else if (boundary === 'restart') {
        provider.stop();
        mockFetch();
        await provider.start();
      } else {
        mockFetch();
        fireDCMessage(JSON.stringify({ type: 'session.closed' }));
        await vi.advanceTimersByTimeAsync(1);
      }
      fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '另一句' }));
      expect(transcripts.at(-1)).not.toHaveProperty('continuationOf');
      provider.stop();
    },
  );

  it('keeps transport connecting after SDP until the peer connection is ready', async () => {
    fakeConnectionState = 'connecting';
    fakeIceState = 'checking';
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    let ready = false;
    const starting = provider.start().then(() => {
      ready = true;
    });
    await vi.waitFor(() => expect(peerControls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(false);
    const transport = healthEvents.filter((event) => event.component === 'transport');
    expect(transport.some((event) => event.state === 'connected')).toBe(false);
    expect(transport.at(-1)?.state).toBe('connecting');
    fakeConnectionState = 'connected';
    lastPC!.fireConn();
    await starting;
    expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'connected',
    );
    provider.stop();
  });

  it('restores connected health when an established peer recovers from disconnection', async () => {
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    fakeConnectionState = 'disconnected';
    lastPC!.fireConn();
    const beforeRecovery = healthEvents.length;
    fakeConnectionState = 'connected';
    lastPC!.fireConn();
    expect(healthEvents.slice(beforeRecovery)).toContainEqual(
      expect.objectContaining({ component: 'transport', state: 'connected' }),
    );
    provider.stop();
  });

  it('keeps the old peer captioning until the renewal candidate actually connects', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    nextPeerState = 'connecting';
    mockFetch();
    old.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    const candidate = peerControls[1]!;
    expect(old.close).not.toHaveBeenCalled();
    old.emit({ type: 'session.output_transcript.delta', delta: 'still on the old peer' });
    expect(translations.at(-1)?.targetText).toBe('still on the old peer');
    candidate.setState('connected');
    await vi.advanceTimersByTimeAsync(1);
    expect(old.close).not.toHaveBeenCalled();
    old.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(251);
    expect(old.close).toHaveBeenCalledOnce();
    candidate.emit({ type: 'session.output_transcript.delta', delta: 'new peer' });
    expect(translations.at(-1)?.targetText).toBe('new peer');
    provider.stop();
  });

  it.each(['failed', 'closed', 'timeout', 'failed-after-connected'] as const)(
    'retains a healthy old peer when renewal readiness ends in %s',
    async (failure) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, translations, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
      await provider.start();
      const old = peerControls[0]!;
      nextPeerState = 'connecting';
      mockFetch();
      const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
      await vi.advanceTimersByTimeAsync(1);
      const candidate = peerControls[1]!;
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
      else {
        if (failure === 'failed-after-connected') candidate.setState('connected');
        candidate.setState(failure === 'failed-after-connected' ? 'failed' : failure);
        await vi.advanceTimersByTimeAsync(1);
      }
      await renewal;
      expect(old.close).not.toHaveBeenCalled();
      expect(candidate.close).toHaveBeenCalledOnce();
      expect(
        healthEvents.some((event) => event.component === 'transport' && event.state === 'failed'),
      ).toBe(false);
      old.emit({ type: 'session.output_transcript.delta', delta: 'old peer survives' });
      expect(translations.at(-1)?.targetText).toBe('old peer survives');
      expect(healthEvents.at(-1)?.message).toMatch(/retry|renewal/i);
      provider.stop();
    },
  );

  it('Stop cancels a pending renewal candidate and its late readiness cannot revive it', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    nextPeerState = 'connecting';
    mockFetch();
    old.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    const candidate = peerControls[1]!;
    provider.stop();
    expect(old.close).toHaveBeenCalledOnce();
    expect(candidate.close).toHaveBeenCalledOnce();
    const healthAfterStop = healthEvents.length;
    candidate.setState('connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(peerControls).toHaveLength(2);
    expect(healthEvents.slice(healthAfterStop)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retired sender detachment without a late session.close after Stop', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    let detach: (() => void) | undefined;
    old.replaceTrack.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          detach = resolve;
        }),
    );
    mockFetch();
    old.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    expect(old.replaceTrack).toHaveBeenCalledWith(null);
    expect(old.sent).toEqual([]);
    provider.stop();
    expect(old.close).toHaveBeenCalledOnce();
    detach!();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives an empty retired segment its own id and retains at most one retired peer', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    const first = peerControls[0]!;
    mockFetch();
    first.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    const second = peerControls[1]!;
    second.emit({ type: 'session.output_transcript.delta', delta: 'new live' });
    const liveId = translations.at(-1)!.sourceSegmentId;
    first.emit({ type: 'session.output_transcript.delta', delta: 'late old' });
    expect(translations.at(-1)?.targetText).toBe('new live');
    mockFetch();
    second.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    const oldFinal = translations.find((event) => event.targetText === 'late old');
    expect(oldFinal?.status).toBe('final');
    expect(oldFinal?.sourceSegmentId).not.toBe(liveId);
    provider.stop();
    expect(second.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['closed', 'cap', 'stop', 'error'] as const)(
    'keeps retired translation tails isolated and flushes once at %s',
    async (ending) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, translations, transcripts, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
      await provider.start();
      const old = peerControls[0]!;
      old.emit({ type: 'session.input_transcript.delta', delta: 'September fifteenth' });
      old.emit({ type: 'session.output_transcript.delta', delta: '九月十五' });
      const oldId = transcripts.at(-1)!.segmentId;
      mockFetch();
      old.emit({ type: 'session.closed' });
      await vi.advanceTimersByTimeAsync(1);
      const current = peerControls[1]!;
      expect(old.close).not.toHaveBeenCalled();
      expect(old.replaceTrack).toHaveBeenCalledWith(null);
      expect(old.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'session.close' });
      current.emit({ type: 'session.output_transcript.delta', delta: '新會議字幕' });
      old.emit({ type: 'session.output_transcript.delta', delta: '日' });
      expect(translations.at(-1)?.targetText).toBe('新會議字幕');
      const finalCount = translations.filter(
        (event) => event.sourceSegmentId === oldId && event.status === 'final',
      ).length;
      if (ending === 'closed') {
        old.emit({ type: 'session.closed' });
        await vi.advanceTimersByTimeAsync(200);
        old.emit({ type: 'session.input_transcript.delta', delta: '.' });
        await vi.advanceTimersByTimeAsync(200);
        expect(old.close).not.toHaveBeenCalled();
        expect(
          translations.filter(
            (event) => event.sourceSegmentId === oldId && event.status === 'final',
          ),
        ).toHaveLength(finalCount);
        await vi.advanceTimersByTimeAsync(51);
      } else if (ending === 'cap') await vi.advanceTimersByTimeAsync(10_001);
      else if (ending === 'error') old.emit({ type: 'error', error: { message: 'retired error' } });
      else provider.stop();
      expect(old.close).toHaveBeenCalledOnce();
      expect(
        translations.filter((event) => event.sourceSegmentId === oldId && event.status === 'final'),
      ).toHaveLength(finalCount + 1);
      expect(
        translations.filter((event) => event.sourceSegmentId === oldId).at(-1)?.targetText,
      ).toBe('九月十五日');
      if (ending === 'closed')
        expect(transcripts.filter((event) => event.segmentId === oldId).at(-1)?.text).toBe(
          'September fifteenth.',
        );
      const countAfterClose = translations.length;
      const healthAfterClose = healthEvents.length;
      old.emit({ type: 'session.output_transcript.delta', delta: '過期事件' });
      old.emit({ type: 'session.closed' });
      expect(translations).toHaveLength(countAfterClose);
      expect(healthEvents).toHaveLength(healthAfterClose);
      provider.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('adds only audio tracks to the peer connection', async () => {
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(addedTrackKinds).toEqual(['audio']);
    provider.stop();
  });

  it('zh-TW→en langPair emits correct source/target language metadata', async () => {
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider(
      'http://localhost:8787/session',
      handlers,
      'zh-TW→en',
    );

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

  it('initial SDP exchange failure closes the provisional peer connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'tok' } }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('upstream rejected sdp', { status: 500 })),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(provider.status).toBe('stopped');
    expect(fakePCClose).toHaveBeenCalledTimes(1);
    expect(
      healthEvents.find((e) => e.component === 'transport' && e.state === 'api_error'),
    ).toBeDefined();
  });

  it('stop() called between fetch and SDP exchange short-circuits cleanly (no NPE, no misleading api_error)', async () => {
    // Robustness: races where the user clicks Stop during the multi-await
    // bring-up must not throw or emit a 'connected' health event after the
    // stop. We block the SDP fetch on a never-resolving promise, call stop()
    // mid-flight, then resolve to let start() see status !== 'running'.
    let resolveSdp: ((r: Response) => void) | null = null;
    const sdpPromise = new Promise<Response>((r) => {
      resolveSdp = r;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
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
    const audioFails = healthEvents.filter((e) => e.component === 'audio' && e.state === 'failed');
    const transportFails = healthEvents.filter(
      (e) => e.component === 'transport' && e.state === 'api_error',
    );
    expect(audioFails.length).toBeGreaterThan(0);
    // The transport never even started — should NOT see transport api_error.
    expect(transportFails).toHaveLength(0);
  });

  it('renewal failure schedules persistent retry backoff (1s → 3s → 8s → 20s → 1m → 3m → 5m → 10m cap)', async () => {
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

    // This ladder is for a genuinely unavailable primary; candidate-only
    // failures on a healthy primary must not publish failed (covered below).
    fakeConnectionState = 'failed';
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

    const settle = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
      await Promise.resolve();
      await Promise.resolve();
    };

    // Trigger the first renewal at the recommended interval (1s). Each rung is
    // then walked exactly, so a change to the ladder has to be deliberate
    // rather than something a looser assertion would absorb silently.
    await settle(1000);
    expect(lastRetrySec()).toBe(1);

    // The first rung is the outage length for a transient failure, so it is
    // short. The tail climbs steeply enough that a hard outage is not hammered.
    for (const [advanceMs, nextRungSec] of [
      [1000, 3],
      [3000, 8],
      [8000, 20],
      [20 * 1000, 60],
      [60 * 1000, 180],
      [3 * 60 * 1000, 300],
      [5 * 60 * 1000, 600],
      // Cap holds.
      [10 * 60 * 1000, 600],
    ] as const) {
      await settle(advanceMs);
      expect(lastRetrySec()).toBe(nextRungSec);
    }

    provider.stop();
  });

  it('make-before-break renewal reuses the mic stream (single getUserMedia) and never goes idle', async () => {
    // Headline #7 behaviour: a scheduled 25-min renewal must NOT release and
    // re-acquire the mic (no OS-indicator blink / re-prompt), and must NOT drop
    // the provider to 'idle' between tearing down and rebuilding — it builds the
    // new peer over the SAME mic stream, then swaps. The old peer is closed only
    // after the replacement media connection is ready.
    vi.useFakeTimers();
    const getUserMedia = vi.fn().mockResolvedValue(makeFakeStream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const fetchMock = vi
      .fn()
      // Initial bring-up: /session (renew in 1s) + SDP.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_secret: { value: 'tok1' },
            session_renewal_recommended_ms: 1000,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('sdp-1', { status: 200 }))
      // Renewal: fresh /session + SDP.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_secret: { value: 'tok2' },
            session_renewal_recommended_ms: 1000,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(new Response('sdp-2', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const statuses: string[] = [];
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    provider.onStatus((s) => statuses.push(s));

    await provider.start();
    expect(provider.status).toBe('running');
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Fire the scheduled renewal.
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    // Mic was reused — NOT re-acquired.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The retired peer closes after its bounded tail drain, while new media is live.
    expect(peerControls[0]!.close).not.toHaveBeenCalled();
    peerControls[0]!.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(251);
    expect(peerControls[0]!.close).toHaveBeenCalledOnce();
    // Status never dipped to idle/stopped through the renewal.
    expect(statuses).not.toContain('idle');
    expect(provider.status).toBe('running');
    // The NEW datachannel is live (post-swap wiring works) — a delta routes.
    fireDCMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));
    expect(translations.some((t) => t.targetText === '你好')).toBe(true);

    provider.stop();
  });

  it('stop() cancels the pending renewal-retry timer (no orphan reconnect)', async () => {
    // Under make-before-break a renewal FAILURE keeps the provider 'running'
    // (the old session may still be alive, and we keep retrying) with a
    // renewalRetryTimer armed. A manual stop() — e.g. the hook stopping the old
    // provider when the user starts a new session — must cancel that timer, or
    // the orphan fires later and opens a parallel session.
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

    // Trigger the first renewal (fails → schedules a 30s retry). The session
    // stays 'running' (make-before-break keeps the old peer; we keep retrying).
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.status).toBe('running');

    const callsBeforeStop = fetchMock.mock.calls.length;
    provider.stop();
    expect(provider.status).toBe('stopped');

    // Advance well past every backoff — a stopped provider must not reconnect.
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

  // ICE recovery is covered below with one real state transition and a
  // grace-period cancellation; repeated synthetic events cannot drive a fake ladder.

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

  it('onStatus subscribers receive every status transition (including transparent renewals)', async () => {
    // Codex review regression guard: the React hook depends on this
    // callback to keep its useState synced with the provider's internal
    // lifecycle. Without it, a renewal that transitions running → idle →
    // running would never reach React, and the consumer could not
    // distinguish "captions live" from "captions dead, retry timer
    // ticking" — UI shows "running" over a wedged session.
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    const transitions: string[] = [];
    const unsub = provider.onStatus((s) => transitions.push(s));

    await provider.start();
    expect(transitions).toContain('running');
    provider.stop();
    expect(transitions).toContain('stopped');

    // After unsubscribe, no further transitions should be recorded.
    const before = transitions.length;
    unsub();
    // Calling stop() again is a no-op for status (already 'stopped'); we
    // assert the negative via the count.
    provider.stop();
    expect(transitions.length).toBe(before);
  });

  it('onStatus listener errors do not corrupt provider state', async () => {
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    // Subscriber throws every time.
    provider.onStatus(() => {
      throw new Error('subscriber blew up');
    });
    // Despite the throw, start() / stop() must still complete and the
    // _status getter must reflect the correct terminal state.
    await provider.start();
    expect(provider.status).toBe('running');
    provider.stop();
    expect(provider.status).toBe('stopped');
  });

  it('stale-data detector fires renewSession after 30s DC silence with 100+ audio-active samples', async () => {
    // Regression guard: a live OpenAI session can wedge silently — the peer
    // connection stays 'connected' but no DataChannel events arrive for
    // minutes. The stale detector catches this by counting cumulative
    // audio-active level-poll ticks (100 × 100ms = ~10s of speech evidence)
    // since the last DC event, and fires a renewal when BOTH conditions hold:
    //   dcGap > 30s  AND  audioActiveSamplesSinceDc >= 100
    // The fake analyser returns 0.05 amplitude ≈ -26 dB, above the default
    // 'meeting' threshold of -48 dB, so every 100ms tick counts as audio-active.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      // Initial bring-up: /session OK + SDP OK
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_secret: { value: 'tok' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 }))
      // Stale-triggered renewSession → /session fails (we only need evidence it was called)
      .mockResolvedValue(new Response('gone', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    expect(provider.status).toBe('running');

    // No DC events from this point — wedged session simulation.
    // After 35s: dcGap=35s (>30s) AND audioActiveSamplesSinceDc≈350 (≥100).
    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.resolve();
    await Promise.resolve();

    const degraded = healthEvents.find(
      (e) => e.component === 'transport' && e.state === 'degraded' && e.message?.includes('Wedged'),
    );
    expect(degraded).toBeDefined();
    expect(degraded?.message).toMatch(/no DC events while audio active/);
    // Renewal must have been attempted — the 3rd fetch is the renewal /session
    // call. How MANY retries land inside this 35 s window is a property of the
    // retry ladder, which the backoff test above pins rung by rung; asserting
    // an exact count here would make this test fail whenever that schedule
    // changes, for reasons that have nothing to do with wedge detection.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    provider.stop();
  });

  it('stale-data detector resets on each DC event — no false positive while events flow', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_secret: { value: 'tok' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    // Advance 29s — just below the 30s DC silence threshold.
    await vi.advanceTimersByTimeAsync(29_000);
    // Fire a DC event to reset both lastDcEventAt and audioActiveSamplesSinceDc.
    fireDCMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'hello' }));
    // Advance another 29s — detector clock restarts from the DC event; no fire.
    await vi.advanceTimersByTimeAsync(29_000);
    await Promise.resolve();
    await Promise.resolve();

    const degraded = healthEvents.find(
      (e) => e.component === 'transport' && e.state === 'degraded',
    );
    expect(degraded).toBeUndefined();
    // Only initial bring-up fetches — no stale-triggered renewal.
    expect(fetchMock).toHaveBeenCalledTimes(2);

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

  // ── B2: Token expiration pre-check ────────────────────────────────────────

  it('token with < 60s remaining → skips SDP, goes to renewSession immediately', async () => {
    // Guard: if the /session broker returns a token that is already near
    // expiry (clock drift, cached response, or early-expiry policy), the
    // provider must NOT attempt the SDP exchange — that would succeed only
    // to have the datachannel die within the minute. Instead it must renew.
    const nearlyExpired = Math.floor(Date.now() / 1000) + 30; // 30 s from now
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // Initial /session — token expires in 30 s (< 60 s threshold)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ client_secret: { value: 'tok', expires_at: nearlyExpired } }),
            { status: 200 },
          ),
        )
        // Renewal /session attempt — fail so the test stays bounded
        .mockResolvedValue(new Response('rate limited', { status: 429 })),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    // A refresh that fails must not resolve as a running/ready startup.
    await provider.start();
    expect(provider.status).toBe('stopped');

    // Must emit 'reconnecting' for the expiry-triggered renewal.
    // transport:connected must NOT appear (SDP was never attempted).
    // audio:connected from mic acquisition is still expected and OK.
    expect(healthEvents.some((e) => e.state === 'reconnecting')).toBe(true);
    expect(healthEvents.some((e) => e.component === 'transport' && e.state === 'connected')).toBe(
      false,
    );

    provider.stop();
  });

  it('token with > 60s remaining → proceeds with SDP exchange normally', async () => {
    const validToken = Math.floor(Date.now() / 1000) + 3600; // 1 h from now
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ client_secret: { value: 'tok', expires_at: validToken } }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 })),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(healthEvents.some((e) => e.state === 'connected')).toBe(true);
    provider.stop();
  });

  // ── B4: silence_detected ──────────────────────────────────────────────────

  it('silence_detected emitted after 30s of sub-threshold audio; connected emitted when speech resumes', async () => {
    // The fake analyser returns amplitude 0.05 ≈ -26 dB, which is ABOVE the
    // default 'meeting' mic threshold of -48 dB. To simulate silence we swap
    // it to a near-zero amplitude so no tick counts as audio-active.
    vi.useFakeTimers();

    const silentBuf = new Float32Array(2048).fill(0.0001); // ~-80 dB: silent
    const activeBuf = new Float32Array(2048).fill(0.05); // ~-26 dB: active
    let currentBuf = activeBuf;

    const silentAnalyser = {
      fftSize: 2048,
      getFloatTimeDomainData: (out: Float32Array) => out.set(currentBuf),
    } as unknown as AnalyserNode;
    vi.stubGlobal('AudioContext', makeFakeAudioContext(silentAnalyser));

    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    // t=0: audio is active, register lastAudioActiveAt
    await vi.advanceTimersByTimeAsync(200);

    // Switch to silence
    currentBuf = silentBuf;

    // Advance 30.1s — silence_detected should fire (30_000ms is the threshold,
    // need strictly more than that since the condition is >)
    await vi.advanceTimersByTimeAsync(30_100);

    const silenceEvents = healthEvents.filter(
      (e) => e.component === 'audio' && e.state === 'silence_detected',
    );
    expect(silenceEvents).toHaveLength(1);

    // Resume speaking — connected should fire
    currentBuf = activeBuf;
    await vi.advanceTimersByTimeAsync(200);

    // At least one connected after silence_detected. (lastIndexOf on a mapped
    // states array keeps this ES2022-lib clean — Array.findLastIndex is ES2023.)
    const states = healthEvents.map((e) => e.state);
    const resumeIdx = states.lastIndexOf('connected');
    const silenceIdx = states.lastIndexOf('silence_detected');
    expect(resumeIdx).toBeGreaterThan(silenceIdx);

    // silence_detected must not fire again while speaking
    const silenceCount = healthEvents.filter((e) => e.state === 'silence_detected').length;
    expect(silenceCount).toBe(1);

    provider.stop();
  });
});

// ── SDP-exchange rejection: concrete errors + call-stage key failover ─────────
//
// Regression cover for the 2026-08-20 field failure. The corporate
// service-account key minted a token happily (POST /session → 200) and the
// browser's SDP POST came back `401 ip_not_authorized` — the org's IP
// allowlist covers the realtime call endpoint but not the mint endpoint. The
// bare "(401)" the provider used to throw pointed the diagnosis at the server
// key/env, which measured healthy, so the real cause stayed hidden.

describe('OpenAIRealtimeProvider — SDP rejection', () => {
  it('does not poison the alternate key with the original key auth refusal', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new OpenAIWsOpenError('Primary refused', true))
      .mockRejectedValueOnce(new OpenAIWsOpenError('Alternate network unavailable', false));
    __setOpenAIWsOpenerForTests(open);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('primary-token', 'primary'))
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
        .mockResolvedValueOnce(sessionResponse('alternate-token', 'audio'))
        .mockResolvedValueOnce(new Response('{}', { status: 401 })),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();
    expect(open).toHaveBeenCalledTimes(2);
    expect(healthEvents.find((e) => e.state === 'api_error')?.recoveryFailure?.kind).toBe(
      'network',
    );
    provider.stop();
  });
  it.each([401, 429])(
    'classifies final SDP %s after eligible transport fallback',
    async (status) => {
      __setOpenAIWsOpenerForTests(() =>
        Promise.reject(new OpenAIWsOpenError('Credential rejected', true)),
      );
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(sessionResponse('tok'))
          .mockResolvedValueOnce(new Response('{}', { status, headers: { 'Retry-After': '60' } })),
      );
      const { handlers, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
      await provider.start();
      const failure = healthEvents.find((e) => e.state === 'api_error')?.recoveryFailure;
      expect(failure?.kind).toBe(status === 401 ? 'auth' : 'rate-limit');
      if (status === 429)
        expect(failure?.retryNotBeforeMs).toBeGreaterThan(performance.now() + 59000);
      provider.stop();
    },
  );
  const IP_NOT_AUTHORIZED = JSON.stringify({
    error: {
      message: 'Your IP is not authorized to make this request.',
      type: 'invalid_request_error',
      code: 'ip_not_authorized',
      param: '',
    },
  });

  function sessionResponse(value: string, keySlot?: 'primary' | 'audio'): Response {
    return new Response(
      JSON.stringify({ client_secret: { value }, ...(keySlot ? { key_slot: keySlot } : {}) }),
      { status: 200 },
    );
  }

  it("surfaces OpenAI's own status, error code and message instead of a bare (401)", async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('tok'))
        .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 })),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    const err = healthEvents.find((e) => e.component === 'transport' && e.state === 'api_error');
    expect(err?.message).toContain('401');
    expect(err?.message).toContain('ip_not_authorized');
    expect(err?.message).toContain('Your IP is not authorized');
    // …plus the plain-language hint that names where the check actually is.
    expect(err?.message).toContain('allowlist');
  });

  it('retries with the alternate server key when the rejected slot is known', async () => {
    // Key failover is valid only after the same credential is rejected on both
    // transports. A generic WebSocket/network failure must not move meeting
    // audio to the alternate account.
    __setOpenAIWsOpenerForTests(() =>
      Promise.reject(new OpenAIWsOpenError('WebSocket credential rejected', true)),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }))
      .mockResolvedValueOnce(sessionResponse('tok-audio', 'audio'))
      .mockResolvedValueOnce(new Response('mock-answer-sdp', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(provider.status).toBe('running');
    // The re-mint must name the slot that was rejected…
    const retryMint = fetchMock.mock.calls[2] as [string, { body: string }];
    expect(retryMint[0]).toBe('http://localhost:8787/session');
    expect(JSON.parse(retryMint[1].body)).toMatchObject({ rejectedSlot: 'primary' });
    // …and the second SDP POST must carry the NEW token.
    const retrySdp = fetchMock.mock.calls[3] as [string, { headers: Record<string, string> }];
    expect(retrySdp[1].headers.Authorization).toBe('Bearer tok-audio');
    // The failover is visible, not silent.
    expect(
      healthEvents.some(
        (e) => e.state === 'reconnecting' && (e.message ?? '').includes('alternate key'),
      ),
    ).toBe(true);
    // The peer built for the first attempt is REUSED for the alternate-key
    // retry — no second createOffer, no close.
    expect(fakePCClose).not.toHaveBeenCalled();

    provider.stop();
  });

  it('does not retry when the server named no key slot (single-key deployment)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.status).toBe('stopped');
    expect(fakePCClose).toHaveBeenCalledTimes(1);
    expect(healthEvents.find((e) => e.state === 'api_error')?.message).toContain(
      'ip_not_authorized',
    );
  });

  it('does not retry a non-auth SDP failure (500 is not a permission problem)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok', 'primary'))
      .mockResolvedValueOnce(new Response('upstream boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.status).toBe('stopped');
    expect(healthEvents.find((e) => e.state === 'api_error')?.message).toContain('500');
  });
});

// ── WebSocket transport (the fix for `ip_not_authorized` on WebRTC) ──────────
//
// Measured 2026-08-20: the corporate key is refused at
// POST /v1/realtime/**/calls but runs the SAME translation session happily over
// wss://api.openai.com/v1/realtime/translations. Switching TRANSPORT keeps the
// meeting inside the corporate organisation; switching KEY would move it into
// the personal account that owns the alternate key.

describe('OpenAIRealtimeProvider — WebSocket transport failover', () => {
  const IP_NOT_AUTHORIZED = JSON.stringify({
    error: {
      message: 'Your IP is not authorized to make this request.',
      code: 'ip_not_authorized',
      type: 'invalid_request_error',
    },
  });

  function sessionResponse(value: string, keySlot: 'primary' | 'audio'): Response {
    return new Response(JSON.stringify({ client_secret: { value }, key_slot: keySlot }), {
      status: 200,
    });
  }

  /** Records how the transport was opened and lets the test drive its events. */
  function installFakeWs() {
    const opened: Array<{ token: string }> = [];
    let handlers: Parameters<Parameters<typeof __setOpenAIWsOpenerForTests>[0] & object>[2] | null =
      null;
    const handlerSets: Array<
      Parameters<Parameters<typeof __setOpenAIWsOpenerForTests>[0] & object>[2]
    > = [];
    const closed = { count: 0, detached: 0 };
    const activation = { count: 0 };
    const activateQueue: unknown[] = [];
    const nextOpenStates: boolean[] = [];
    __setOpenAIWsOpenerForTests((token, _stream, h) => {
      opened.push({ token });
      handlers = h;
      handlerSets.push(h);
      const isOpen = nextOpenStates.shift() ?? true;
      return Promise.resolve({
        isOpen,
        activate: () => {
          if (!isOpen) {
            throw new OpenAIWsOpenError('WebSocket closed before activation', false);
          }
          activation.count += 1;
          for (const ev of activateQueue.splice(0)) h.onEvent(ev as never);
        },
        beginDrain: (_onEvent: unknown, onClosed: () => void) => {
          onClosed();
        },
        detach: () => {
          closed.detached += 1;
        },
        close: () => {
          closed.count += 1;
        },
      } as unknown as Awaited<
        ReturnType<Parameters<typeof __setOpenAIWsOpenerForTests>[0] & object>
      >);
    });
    return {
      opened,
      closed,
      activation,
      queueOnActivate: (ev: unknown) => activateQueue.push(ev),
      closeNextBeforeActivation: () => nextOpenStates.push(false),
      fire: (ev: unknown) => handlers?.onEvent(ev as never),
      fireAt: (index: number, ev: unknown) => handlerSets[index]?.onEvent(ev as never),
      drop: (r: string) => handlers?.onClosed(r),
      backpressure: (state: 'connected' | 'degraded') =>
        handlers?.onAudioTrouble(state, 'controlled backpressure', 'transport'),
    };
  }

  it('switches to WebSocket with the SAME key when WebRTC is refused', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const ws = installFakeWs();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(provider.status).toBe('running');
    // Same token — no re-mint, so the session stays in the same organisation.
    expect(ws.opened).toEqual([{ token: 'tok-primary' }]);
    expect(ws.activation.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      healthEvents.some(
        (e) => e.state === 'reconnecting' && (e.message ?? '').includes('WebSocket transport'),
      ),
    ).toBe(true);
    expect(healthEvents.some((e) => e.component === 'transport' && e.state === 'connected')).toBe(
      true,
    );
    ws.backpressure('degraded');
    expect(healthEvents.at(-1)).toMatchObject({ component: 'transport', state: 'degraded' });
    ws.backpressure('connected');
    expect(healthEvents.at(-1)).toMatchObject({ component: 'transport', state: 'connected' });
    // The surplus WebRTC peer is released.
    expect(fakePCClose).toHaveBeenCalledTimes(1);

    provider.stop();
  });

  it('does not switch key when same-key WebSocket setup fails for a non-auth reason', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    __setOpenAIWsOpenerForTests(() =>
      Promise.reject(new OpenAIWsOpenError('WebSocket network unavailable', false)),
    );
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);

    await provider.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some((call) => {
        const init = call[1] as RequestInit | undefined;
        return typeof init?.body === 'string' && init.body.includes('rejectedSlot');
      }),
    ).toBe(false);
    expect(provider.status).toBe('stopped');
    expect(healthEvents.find((e) => e.state === 'api_error')?.message).toContain(
      'WebSocket network unavailable',
    );
    expect(healthEvents.find((e) => e.state === 'api_error')?.message).toContain(
      'ip_not_authorized',
    );
  });

  it('activates a replacement WebSocket only after finalizing the old segment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }))
      // Renewal stays on the same key and skips WebRTC because the slot is blocked.
      .mockResolvedValueOnce(sessionResponse('tok-primary-renewed', 'primary'));
    vi.stubGlobal('fetch', fetchMock);
    const ws = installFakeWs();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    ws.fire({ type: 'session.output_transcript.delta', delta: 'old segment' });
    const oldSegmentId = translations.at(-1)?.sourceSegmentId;
    ws.queueOnActivate({ type: 'session.output_transcript.delta', delta: 'new segment' });
    ws.drop('WebSocket closed (1006)');
    await vi.waitFor(() => expect(ws.opened).toHaveLength(2));
    await vi.waitFor(() =>
      expect(translations.some((event) => event.targetText.includes('new segment'))).toBe(true),
    );

    const oldFinal = translations.find(
      (event) => event.sourceSegmentId === oldSegmentId && event.status === 'final',
    );
    const newDraft = translations.find((event) => event.targetText.includes('new segment'));
    expect(oldFinal?.targetText).toBe('old segment');
    expect(newDraft?.sourceSegmentId).not.toBe(oldSegmentId);
    expect(ws.activation.count).toBe(2);
    provider.stop();
  });

  it('keeps the healthy old WebSocket live when a renewal candidate closes before activation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
      .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }))
      // Scheduled make-before-break renewal; the primary slot remains WebRTC-blocked.
      .mockResolvedValueOnce(sessionResponse('tok-primary-renewed', 'primary'));
    vi.stubGlobal('fetch', fetchMock);
    const ws = installFakeWs();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    ws.fireAt(0, { type: 'session.output_transcript.delta', delta: 'old segment' });
    const oldSegmentId = translations.at(-1)?.sourceSegmentId;
    ws.closeNextBeforeActivation();
    await (
      provider as unknown as {
        renewSession(): Promise<void>;
      }
    ).renewSession();

    // Candidate cleanup is allowed; the old transport must remain attached and
    // continue the same in-flight caption segment after the failed hand-off.
    expect(ws.closed.count).toBe(1);
    expect(ws.closed.detached).toBe(0);
    ws.fireAt(0, { type: 'session.output_transcript.delta', delta: ' continues' });
    expect(translations.at(-1)?.targetText).toBe('old segment continues');
    expect(translations.at(-1)?.sourceSegmentId).toBe(oldSegmentId);
    provider.stop();
  });

  it('feeds WebSocket events through the same caption pipeline as the DataChannel', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
        .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 })),
    );
    const ws = installFakeWs();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    ws.fire({ type: 'session.output_transcript.delta', delta: '大家早安' });

    expect(translations.at(-1)?.targetText).toContain('大家早安');
    provider.stop();
  });

  it('skips the doomed WebRTC round trip on the NEXT start for that key', async () => {
    // First start: pays one refusal and records the block for slot 'primary'.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
        .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 })),
    );
    installFakeWs();
    const first = new OpenAIRealtimeProvider(
      'http://localhost:8787/session',
      makeHandlers().handlers,
    );
    await first.start();
    first.stop();

    // Second start: mint only — no SDP POST at all.
    const secondFetch = vi.fn().mockResolvedValueOnce(sessionResponse('tok-primary-2', 'primary'));
    vi.stubGlobal('fetch', secondFetch);
    const ws2 = installFakeWs();
    const second = new OpenAIRealtimeProvider(
      'http://localhost:8787/session',
      makeHandlers().handlers,
    );
    await second.start();

    expect(second.status).toBe('running');
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(ws2.opened).toEqual([{ token: 'tok-primary-2' }]);
    second.stop();
  });

  it('treats a dropped WebSocket as a reconnect, not a dead session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('tok-primary', 'primary'))
        .mockResolvedValueOnce(new Response(IP_NOT_AUTHORIZED, { status: 401 }))
        // renewal after the drop
        .mockResolvedValue(sessionResponse('tok-primary-renewed', 'primary')),
    );
    const ws = installFakeWs();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('http://localhost:8787/session', handlers);
    await provider.start();

    ws.drop('WebSocket closed (1006)');
    await vi.waitFor(() => expect(ws.opened.length).toBeGreaterThan(1));

    expect(provider.status).toBe('running');
    expect(
      healthEvents.some(
        (e) => e.state === 'reconnecting' && (e.message ?? '').includes('WebSocket dropped'),
      ),
    ).toBe(true);
    provider.stop();
  });
});

describe('OpenAI bounded recovery', () => {
  it('a caption channel closing on an otherwise connected peer starts recovery immediately', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    mockFetch();
    old.setDataChannelState('closed');
    await vi.advanceTimersByTimeAsync(1);
    expect(peerControls).toHaveLength(2);
    expect(peerControls[1]!.replaceTrack).toHaveBeenCalled();
    // A late close on the retired peer cannot renew the replacement again.
    old.setDataChannelState('closed');
    await vi.advanceTimersByTimeAsync(1);
    expect(peerControls).toHaveLength(2);
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ack', 'timeout', 'closed'] as const)(
    'requires candidate session.created before activation: %s',
    async (outcome) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, translations } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      const old = peerControls[0]!;
      nextSessionCreated = false;
      mockFetch();
      const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
      await vi.advanceTimersByTimeAsync(1);
      const candidate = peerControls[1]!;
      expect(candidate.replaceTrack).not.toHaveBeenCalled();
      expect(old.sent).not.toContain(JSON.stringify({ type: 'session.close' }));
      if (outcome === 'ack') candidate.emit({ type: 'session.created' });
      else if (outcome === 'closed') candidate.setDataChannelState('closed');
      else await vi.advanceTimersByTimeAsync(10_001);
      await renewal;
      if (outcome === 'ack') expect(candidate.replaceTrack).toHaveBeenCalled();
      else {
        expect(candidate.close).toHaveBeenCalled();
        expect(old.sent).not.toContain(JSON.stringify({ type: 'session.close' }));
        old.emit({ type: 'session.output_transcript.delta', delta: 'primary remains usable' });
        expect(translations.at(-1)?.targetText).toBe('primary remains usable');
      }
      provider.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps a healthy primary until the candidate data channel opens', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    nextDataChannelState = 'connecting';
    mockFetch();
    const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
    await vi.advanceTimersByTimeAsync(1);
    const candidate = peerControls[1]!;
    expect(candidate.replaceTrack).not.toHaveBeenCalled();
    expect(old.sent).not.toContain(JSON.stringify({ type: 'session.close' }));
    old.emit({ type: 'session.output_transcript.delta', delta: 'healthy primary' });
    expect(translations.at(-1)?.targetText).toBe('healthy primary');
    candidate.setDataChannelState('open');
    await renewal;
    expect(candidate.replaceTrack).toHaveBeenCalled();
    provider.stop();
  });

  it('rejects a connected candidate whose data channel closes without a server error', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, translations, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    nextDataChannelState = 'connecting';
    mockFetch();
    const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
    await vi.advanceTimersByTimeAsync(1);
    const candidate = peerControls[1]!;
    candidate.setDataChannelState('closed');
    await renewal;
    expect(candidate.close).toHaveBeenCalled();
    expect(old.sent).not.toContain(JSON.stringify({ type: 'session.close' }));
    old.emit({ type: 'session.output_transcript.delta', delta: 'primary survives closed channel' });
    expect(translations.at(-1)?.targetText).toBe('primary survives closed channel');
    expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'connected',
    );
    provider.stop();
  });

  it('a failed scheduled candidate never marks the healthy primary failed', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents, translations } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const old = peerControls[0]!;
    healthEvents.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await (provider as unknown as { renewSession(): Promise<void> }).renewSession();
    expect(
      healthEvents.some((event) => event.component === 'transport' && event.state === 'failed'),
    ).toBe(false);
    expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'connected',
    );
    old.emit({ type: 'session.output_transcript.delta', delta: 'primary continues' });
    expect(translations.at(-1)?.targetText).toBe('primary continues');
    expect(old.close).not.toHaveBeenCalled();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('initial media readiness has a deadline and does not report success early', async () => {
    vi.useFakeTimers();
    nextPeerState = 'connecting';
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    let settled = false;
    const starting = provider.start().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    await starting;
    expect(provider.status).toBe('stopped');
    expect(
      healthEvents.some(
        (event) => event.state === 'api_error' && /readiness.*timed out/i.test(event.message ?? ''),
      ),
    ).toBe(true);
    expect(peerControls[0]!.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['mint', 'sdp'] as const)(
    'Stop aborts pending %s and settles startup without a false error',
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      if (stage === 'sdp')
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'token' } })),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { handlers, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      let settled = false;
      const starting = provider.start().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'mint' ? 1 : 2);
      provider.stop();
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      await starting;
      expect(healthEvents.some((event) => event.state === 'api_error')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['mint', 'sdp'] as const)(
    'a hung %s expires without a network response',
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      if (stage === 'sdp')
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'token' } })),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { handlers, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      let settled = false;
      const starting = provider.start().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(12_001);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      await starting;
      expect(provider.status).toBe('stopped');
      expect(
        healthEvents.some(
          (event) => event.state === 'api_error' && /timed out/i.test(event.message ?? ''),
        ),
      ).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('one persistent ICE disconnection triggers a complete negotiated replacement', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    mockFetch();
    fakeIceState = 'disconnected';
    lastPC!.fireIce();
    await vi.advanceTimersByTimeAsync(3_001);
    expect(peerControls).toHaveLength(2);
    expect(fakeRestartIce).not.toHaveBeenCalled();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ICE recovery before the grace deadline cancels replacement', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    fakeIceState = 'disconnected';
    lastPC!.fireIce();
    await vi.advanceTimersByTimeAsync(2_000);
    fakeIceState = 'connected';
    lastPC!.fireIce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(peerControls).toHaveLength(1);
    expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'connected',
    );
    expect(fakeRestartIce).not.toHaveBeenCalled();
    provider.stop();
  });
});

describe('OpenAI candidate audio ownership', () => {
  it('a renewal candidate sends no live track until readiness and leaves the original track enabled', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const originalTrack = peerControls[0]!.tracks[0]!;
    nextPeerState = 'connecting';
    mockFetch();
    const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
    await vi.advanceTimersByTimeAsync(1);
    const candidate = peerControls[1]!;
    expect(candidate.tracks).toEqual([]);
    expect(candidate.transceivers).toEqual(['audio']);
    expect(candidate.replaceTrack).not.toHaveBeenCalled();
    expect(originalTrack.enabled).toBe(true);
    expect(originalTrack.stop).not.toHaveBeenCalled();
    candidate.setState('connected');
    await renewal;
    expect(candidate.replaceTrack).toHaveBeenCalledWith(originalTrack);
    expect(originalTrack.stop).not.toHaveBeenCalled();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OpenAI cancellation across startup and renewal', () => {
  it('WebRTC capture probe starvation blocks receive-wedge renewal and stops with its owner', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    const { handlers, healthEvents } = makeHandlers();
    mockFetch();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(healthEvents.some((event) => event.reason === 'capture_stalled')).toBe(true);
    await vi.advanceTimersByTimeAsync(40000);
    expect(peerControls).toHaveLength(1);
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])(
    'late capture respects lease ownership after Stop (same instance restart: %s)',
    async (sameInstance) => {
      __resetCaptureLeaseForTests();
      const stream = makeFakeStream();
      const abandonedStream = makeFakeStream();
      let grant!: (stream: MediaStream) => void;
      let grantNext!: (stream: MediaStream) => void;
      const acquisition = new Promise<MediaStream>((resolve) => {
        grant = resolve;
      });
      const nextAcquisition = new Promise<MediaStream>((resolve) => {
        grantNext = resolve;
      });
      vi.mocked(navigator.mediaDevices.getUserMedia)
        .mockReturnValueOnce(acquisition)
        .mockReturnValueOnce(nextAcquisition);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url === '/session'
            ? new Response(JSON.stringify({ client_secret: { value: 'token' } }))
            : new Response('answer'),
        ),
      );
      const first = new OpenAIRealtimeProvider(
        '/session',
        makeHandlers().handlers,
        'en→zh-TW',
        leaseCapture({ kind: 'mic', micDistance: 'meeting' }),
      );
      const oldStart = first.start();
      first.stop();
      const next = sameInstance
        ? first
        : new OpenAIRealtimeProvider(
            '/session',
            makeHandlers().handlers,
            'en→zh-TW',
            leaseCapture({ kind: 'mic', micDistance: 'meeting' }),
          );
      const nextStart = next.start();
      grant(abandonedStream);
      grantNext(stream);
      await Promise.all([oldStart, nextStart]);
      expect(next.status).toBe('running');
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      for (const track of abandonedStream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1);
      for (const track of stream.getTracks()) expect(track.stop).not.toHaveBeenCalled();
      next.stop();
      for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1);
      __resetCaptureLeaseForTests();
    },
  );

  it('releases a lease granted after Stop when there is no replacement start', async () => {
    __resetCaptureLeaseForTests();
    const stream = makeFakeStream();
    let grant!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    mockFetch();
    const provider = new OpenAIRealtimeProvider(
      '/session',
      makeHandlers().handlers,
      'en→zh-TW',
      leaseCapture({ kind: 'mic', micDistance: 'meeting' }),
    );
    const start = provider.start();
    provider.stop();
    grant(stream);
    await start;
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1);
    provider.stop();
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1);
    __resetCaptureLeaseForTests();
  });

  it('Stop aborts a warm-token startup during SDP without another mint', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi
      .fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ client_secret: { value: 'warm' } })));
    vi.stubGlobal('fetch', fetchMock);
    prewarmOpenAISession('/session', sessionRequestBody('en→zh-TW', true, 'meeting'));
    await vi.advanceTimersByTimeAsync(1);
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    const starting = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/translations/calls');
    provider.stop();
    await starting;
    expect(signal?.aborted).toBe(true);
    expect(healthEvents.some((event) => event.state === 'api_error')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['mint', 'sdp'] as const)(
    'Stop aborts a renewal candidate during %s and preserves stopped state',
    async (stage) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      if (stage === 'sdp')
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'candidate' } })),
        );
      vi.stubGlobal('fetch', fetchMock);
      const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'mint' ? 1 : 2);
      provider.stop();
      const healthCount = healthEvents.length;
      await renewal;
      expect(signal?.aborted).toBe(true);
      expect(provider.status).toBe('stopped');
      expect(healthEvents).toHaveLength(healthCount);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('an already closed primary is failed when its replacement fails, even with connected ICE', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    fireDCMessage(JSON.stringify({ type: 'session.closed' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
      'failed',
    );
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OpenAI late SDP response isolation', () => {
  it('a candidate SDP body arriving after timeout cannot touch the discarded peer', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    let releaseBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => {
      releaseBody = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'candidate' } })),
        )
        .mockResolvedValueOnce({ ok: true, text: () => body }),
    );
    const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
    await vi.advanceTimersByTimeAsync(12_000);
    await renewal;
    const candidate = peerControls[1]!;
    expect(candidate.close).toHaveBeenCalled();
    releaseBody('late-answer');
    await vi.advanceTimersByTimeAsync(1);
    expect(candidate.setRemoteDescription).not.toHaveBeenCalled();
    expect(peerControls[0]!.close).not.toHaveBeenCalled();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OpenAI primary recovers during replacement', () => {
  it.each(['ICE', 'caption'] as const)(
    '%s recovery during a pending replacement prevents candidate failure from killing healthy primary',
    async (recovery) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, healthEvents, translations } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      const primary = peerControls[0]!;
      let rejectMint!: (error: Error) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((_resolve, reject) => {
              rejectMint = reject;
            }),
        ),
      );
      if (recovery === 'ICE') {
        fakeIceState = 'disconnected';
        lastPC!.fireIce();
        await vi.advanceTimersByTimeAsync(3_001);
        fakeIceState = 'connected';
        lastPC!.fireIce();
      } else {
        await vi.advanceTimersByTimeAsync(30_101);
        primary.emit({ type: 'session.input_transcript.delta', delta: 'Recovered source' });
      }
      rejectMint(new Error('candidate network failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(healthEvents.filter((event) => event.component === 'transport').at(-1)?.state).toBe(
        'connected',
      );
      expect(
        healthEvents.some((event) => event.component === 'transport' && event.state === 'failed'),
      ).toBe(false);
      primary.emit({ type: 'session.output_transcript.delta', delta: 'recovered original' });
      expect(translations.at(-1)?.targetText).toBe('recovered original');
      expect(primary.close).not.toHaveBeenCalled();
      provider.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('OpenAI caption progress watchdog', () => {
  it.each(['session.updated', 'session.input_transcript.delta', 'session.output_transcript.delta'])(
    '%s without visible text cannot mask active audio with no caption progress',
    async (type) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve(
          url === '/session'
            ? new Response(JSON.stringify({ client_secret: { value: 'token' } }))
            : new Response('answer'),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { handlers, healthEvents } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      for (let i = 0; i < 7; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
        fireDCMessage(JSON.stringify({ type, delta: ' \n\t' }));
      }
      expect(fetchMock.mock.calls.filter(([url]) => url === '/session')).toHaveLength(2);
      expect(
        healthEvents.some(
          (event) => event.state === 'degraded' && event.message?.includes('Wedged'),
        ),
      ).toBe(true);
      provider.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('source-only progress keeps the session healthy even when repeated target-language speech has no translation', async () => {
    vi.useFakeTimers();
    mockFetch();
    const fetchMock = vi.mocked(fetch);
    const { handlers, transcripts } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    for (let i = 0; i < 7; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      fireDCMessage(
        JSON.stringify({ type: 'session.input_transcript.delta', delta: '已在目標語言' }),
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    provider.stop();
    expect(
      transcripts.filter((event) => event.status === 'final').map((event) => event.text),
    ).toEqual(Array(7).fill('已在目標語言'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OpenAI attempt ownership and total budget', () => {
  it('does not deliver old final translation after its transcript handler restarts', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, translations } = makeHandlers();
    let restarted: Promise<void> | undefined;
    const provider = new OpenAIRealtimeProvider('/session', {
      ...handlers,
      onTranscript: (event) => {
        if (event.status === 'final' && !restarted) {
          mockFetch('new-generation');
          restarted = provider.start();
        }
      },
    });
    await provider.start();
    peerControls[0]!.emit({ type: 'session.output_transcript.delta', delta: 'old meeting' });
    const oldSegment = translations.at(-1)!.sourceSegmentId;
    provider.stop();
    await restarted;
    expect(peerControls).toHaveLength(2);
    expect(
      translations.filter(
        (event) => event.sourceSegmentId === oldSegment && event.status === 'final',
      ),
    ).toEqual([]);
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes old cleanup before a stopped status listener starts again', async () => {
    vi.useFakeTimers();
    mockFetch();
    const provider = new OpenAIRealtimeProvider('/session', makeHandlers().handlers);
    await provider.start();
    let restarted: Promise<void> | undefined;
    const unsubscribe = provider.onStatus((status) => {
      if (status === 'stopped' && !restarted) {
        mockFetch('replacement');
        restarted = provider.start();
      }
    });
    provider.stop();
    await restarted;
    expect(peerControls).toHaveLength(2);
    expect(provider.status).toBe('running');
    unsubscribe();
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['input', 'output-anchor', 'translation'])(
    'does not schedule caption timers after %s handler stops',
    async (kind) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', {
        ...handlers,
        onTranscript: (event) => {
          if (kind !== 'translation' && event.status === 'partial') provider.stop();
        },
        onTranslation: (event) => {
          if (kind === 'translation' && event.status === 'draft') provider.stop();
        },
      });
      await provider.start();
      peerControls[0]!.emit({
        type:
          kind === 'input' ? 'session.input_transcript.delta' : 'session.output_transcript.delta',
        delta: 'words',
      });
      expect(provider.status).toBe('stopped');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not schedule ICE recovery after its health handler stops', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', {
      ...handlers,
      onHealth: (event) => {
        if (event.component === 'transport' && event.state === 'reconnecting') provider.stop();
      },
    });
    await provider.start();
    fakeIceState = 'disconnected';
    lastPC!.fireIce();
    expect(provider.status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recreate startup timers after a connected handler stops the provider', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', {
      ...handlers,
      onHealth: (event) => {
        if (event.component === 'transport' && event.state === 'connected') provider.stop();
      },
    });
    await provider.start();
    expect(provider.status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not clean up a new start requested by the old failure handler', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ client_secret: { value: 'new-token' } })),
        )
        .mockResolvedValueOnce(new Response('answer')),
    );
    let restarted: Promise<void> | undefined;
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', {
      ...handlers,
      onHealth: (event) => {
        if (event.component === 'transport' && event.state === 'api_error' && !restarted) {
          provider.stop();
          restarted = provider.start();
        }
      },
    });
    await provider.start();
    await restarted;
    expect(provider.status).toBe('running');
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule a retry after a failed handler stops the provider', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', {
      ...handlers,
      onHealth: (event) => {
        if (event.component === 'transport' && event.state === 'failed') provider.stop();
      },
    });
    await provider.start();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Outage')));
    peerControls[0]!.emit({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the network budget after a long permission wait', async () => {
    vi.useFakeTimers();
    let grant!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    const fetchMock = vi.fn(async (url: string) =>
      url === '/session'
        ? new Response(JSON.stringify({ client_secret: { value: 'token' } }))
        : new Response('answer'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIRealtimeProvider('/session', makeHandlers().handlers);
    const starting = provider.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).not.toHaveBeenCalled();
    grant(makeFakeStream());
    await starting;
    expect(provider.status).toBe('running');
    provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the whole renewal, not each network stage independently', async () => {
    vi.useFakeTimers();
    mockFetch();
    const { handlers, healthEvents } = makeHandlers();
    const provider = new OpenAIRealtimeProvider('/session', handlers);
    await provider.start();
    const primary = peerControls[0]!;
    let resolveMint!: (response: Response) => void;
    let sdpSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/session')
          return new Promise<Response>((resolve) => {
            resolveMint = resolve;
          });
        sdpSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    let finished = false;
    const renewal = (provider as unknown as { renewSession(): Promise<void> })
      .renewSession()
      .then(() => {
        finished = true;
      });
    await vi.advanceTimersByTimeAsync(8_000);
    resolveMint(new Response(JSON.stringify({ client_secret: { value: 'next' } })));
    await vi.advanceTimersByTimeAsync(4_001);
    expect(finished).toBe(true);
    expect(sdpSignal?.aborted).toBe(true);
    expect(primary.close).not.toHaveBeenCalled();
    expect(healthEvents.at(-1)?.message).toMatch(/timed out/);
    provider.stop();
    await renewal;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['session.closed', 'error'])(
    'rejects a WebRTC candidate receiving %s before ready',
    async (type) => {
      vi.useFakeTimers();
      mockFetch();
      const { handlers, translations } = makeHandlers();
      const provider = new OpenAIRealtimeProvider('/session', handlers);
      await provider.start();
      const primary = peerControls[0]!;
      primary.emit({ type: 'session.output_transcript.delta', delta: 'old' });
      mockFetch('replacement');
      nextPeerState = 'connecting';
      const renewal = (provider as unknown as { renewSession(): Promise<void> }).renewSession();
      await vi.advanceTimersByTimeAsync(1);
      const candidate = peerControls[1]!;
      candidate.emit({ type, error: { message: 'Session ended' } });
      candidate.setState('connected');
      await renewal;
      expect(candidate.close).toHaveBeenCalled();
      expect(primary.close).not.toHaveBeenCalled();
      primary.emit({ type: 'session.output_transcript.delta', delta: ' continues' });
      expect(translations.at(-1)?.targetText).toBe('old continues');
      provider.stop();
    },
  );

  it('never demotes a key from an old auth rejection after Stop and Start', async () => {
    vi.useFakeTimers();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/session') {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({ client_secret: { value: 'token' }, key_slot: 'primary' }),
          );
        }
        return new Response(JSON.stringify({ error: { code: 'ip_not_authorized' } }), {
          status: 401,
        });
      }),
    );
    let rejectOld!: (error: Error) => void;
    let opens = 0;
    __setOpenAIWsOpenerForTests(() => {
      opens += 1;
      if (opens === 1)
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      return Promise.resolve({
        isOpen: true,
        activate: () => {},
        close: () => {},
        detach: () => {},
      } as unknown as import('./openai-ws-transport.js').OpenAIWsTransport);
    });
    const provider = new OpenAIRealtimeProvider('/session', makeHandlers().handlers);
    const oldStart = provider.start();
    await vi.advanceTimersByTimeAsync(1);
    rejectOld(new OpenAIWsOpenError('invalid_api_key', true));
    provider.stop();
    const newStart = provider.start();
    await Promise.all([oldStart, newStart]);
    expect(requests.filter((request) => 'rejectedSlot' in request)).toEqual([]);
    expect(provider.status).toBe('running');
    provider.stop();
  });
});
