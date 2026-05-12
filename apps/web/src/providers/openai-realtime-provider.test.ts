import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioLevelEvent, HealthEvent, TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import type { CaptionProviderHandlers } from './types.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';

// ── Globals mutated per test ───────────────────────────────────────────────────

let fireDCMessage: (data: string) => void = () => {};
let fakeIceState = 'connected';
let fakeRestartIce: ReturnType<typeof vi.fn>;
let fakePCClose: ReturnType<typeof vi.fn>;

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeFakeRTCPeerConnectionClass() {
  return class FakePeerConnection {
    oniceconnectionstatechange: (() => void) | null = null;

    get iceConnectionState() {
      return fakeIceState;
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
  fireDCMessage = () => {};
  fakeRestartIce = vi.fn();
  fakePCClose = vi.fn();

  const analyser = makeFakeAnalyser();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(makeFakeStream()) },
  });
  vi.stubGlobal('AudioContext', makeFakeAudioContext(analyser));
  vi.stubGlobal('RTCPeerConnection', makeFakeRTCPeerConnectionClass());
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
