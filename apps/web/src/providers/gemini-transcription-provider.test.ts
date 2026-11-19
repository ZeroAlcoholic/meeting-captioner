import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeminiTranscriptionProvider } from './gemini-transcription-provider.js';
import { __resetRecoveryFailuresForTests, recoveryFailureFor } from './recovery-attempt.js';
import type { TranscriptionAudioCallbacks } from './transcription-audio.js';

function setup() {
  const track = { readyState: 'live' };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as (() => void) | null,
    onmessage: null as ((e: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null,
  };
  const handlers = {
    onTranscript: vi.fn(),
    onTranslation: vi.fn(),
    onHealth: vi.fn(),
    onAudioLevel: vi.fn(),
  };
  const source = {
    analyser: null,
    acquire: vi.fn(async () => ({ getAudioTracks: () => [track] }) as unknown as MediaStream),
    release: vi.fn(),
  };
  let callbacks!: TranscriptionAudioCallbacks;
  const audio = { pause: vi.fn(async () => {}), dispose: vi.fn() };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      token: 'temporary-token',
      model: 'gemini-3.5-transcribe-live',
      expiresAt: Date.now() + 60000,
    }),
  }));
  const socketFactory = vi.fn((_url: string) => socket as unknown as WebSocket);
  const provider = new GeminiTranscriptionProvider({
    sessionUrl: '/session/gemini/transcription',
    handlers,
    audioSource: source,
    dependencies: {
      fetch: fetchMock as unknown as typeof fetch,
      socket: socketFactory,
      audio: async (_stream, cb) => {
        callbacks = cb;
        return audio;
      },
    },
  });
  const event = (body: object) => socket.onmessage?.({ data: JSON.stringify(body) });
  const ready = async (candidate = false) => {
    const started = candidate ? provider.prepare() : provider.start();
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    socket.onopen?.();
    event({ setupComplete: {} });
    await started;
  };
  const frame = (ms: number, p = 0.9) => callbacks.onFrame(new Float32Array(512).fill(0.1), p, ms);
  const endTurn = (start: number) => {
    for (let i = 0; i < 22; i++) frame(start + i * 32, 0);
  };
  return {
    track,
    provider,
    socket,
    handlers,
    source,
    audio,
    fetchMock,
    socketFactory,
    event,
    ready,
    frame,
    endTurn,
  };
}

describe('Gemini candidate boundary', () => {
  it('rejects activation cancelled synchronously by a running status Stop listener without publishing connected', async () => {
    const s = setup();
    await s.ready(true);
    let stopped: Promise<void> | undefined;
    s.provider.onStatus((status) => {
      if (status === 'running') stopped = s.provider.stop();
    });
    expect(() => s.provider.activate()).toThrow();
    expect(s.handlers.onHealth).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'connected' }),
    );
    await stopped;
    expect(s.provider.status).toBe('stopped');
  });
  it.each([undefined, false, true, 'true', 1])(
    'admits concurrent renewal only for minted boolean true (%s)',
    async (value) => {
      const s = setup();
      expect(s.provider.allowsConcurrentRenewal()).toBe(false);
      s.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'temporary-token',
          model: 'gemini-3.5-transcribe-live',
          expiresAt: Date.now() + 60000,
          concurrent_renewal_allowed: value,
        }),
      });
      await s.ready();
      expect(s.provider.allowsConcurrentRenewal()).toBe(value === true);
      s.provider.dispose();
      expect(s.provider.allowsConcurrentRenewal()).toBe(false);
    },
  );
  it.each([
    [10000, 10000],
    [900000, 480000],
    [0, 480000],
    [-1, 480000],
    ['10000', 480000],
    [undefined, 480000],
  ])('uses bounded broker renewal advice %s', async (value, expected) => {
    const s = setup();
    s.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'temporary-token',
        model: 'gemini-3.5-transcribe-live',
        expiresAt: Date.now() + 60000,
        session_renewal_recommended_ms: value,
      }),
    });
    await s.ready();
    expect(s.provider.getRenewalEtaMs()).toBeLessThanOrEqual(expected as number);
    expect(s.provider.getRenewalEtaMs()).toBeGreaterThan((expected as number) - 500);
    s.provider.dispose();
  });
  it('prepares without sending audio or publishing live, then activates synchronously', async () => {
    const s = setup();
    await s.ready(true);
    expect(s.provider.status).not.toBe('running');
    s.socket.send.mockClear();
    for (let i = 0; i < 8; i++) s.frame(i * 32);
    expect(s.socket.send).not.toHaveBeenCalled();
    expect(s.handlers.onAudioLevel).not.toHaveBeenCalled();
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
    expect(s.handlers.onHealth).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'connected' }),
    );
    s.provider.activate();
    expect(s.provider.status).toBe('running');
    for (let i = 0; i < 8; i++) s.frame(1000 + i * 32);
    expect(s.socket.send).toHaveBeenCalled();
    expect(s.handlers.onAudioLevel).toHaveBeenCalled();
    s.provider.dispose();
  });
  it.each(['stop', 'closed', 'ended'] as const)(
    'rejects activation after prepared candidate is %s',
    async (reason) => {
      const s = setup();
      await s.ready(true);
      expect(s.provider.isPrepared()).toBe(true);
      if (reason === 'stop') await s.provider.stop();
      else if (reason === 'closed') s.socket.readyState = 3;
      else s.track.readyState = 'ended';
      expect(s.provider.isPrepared()).toBe(false);
      expect(() => s.provider.activate()).toThrow();
      expect(s.audio.pause).not.toHaveBeenCalled();
      s.provider.dispose();
    },
  );
  it('rejects preparation failure while start retains its resolving failure contract', async () => {
    const s = setup();
    s.fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(s.provider.prepare()).rejects.toThrow();
    expect(s.provider.isPrepared()).toBe(false);
    await expect(s.provider.start()).resolves.toBeUndefined();
    expect(s.handlers.onHealth).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
  });
  it('disposing a candidate leaves the other adapter capture owner and PCM running', async () => {
    const active = setup();
    const candidate = setup();
    await active.ready();
    await candidate.ready(true);
    candidate.provider.dispose();
    expect(active.source.release).not.toHaveBeenCalled();
    expect(active.audio.dispose).not.toHaveBeenCalled();
    active.socket.send.mockClear();
    for (let i = 0; i < 8; i++) active.frame(i * 32);
    expect(active.socket.send).toHaveBeenCalled();
    active.provider.dispose();
  });
  it('shares pending prepare and does not reacquire or remint on repeated prepare', async () => {
    const s = setup();
    const first = s.ready(true);
    const second = s.provider.prepare();
    await Promise.all([first, second]);
    await s.provider.prepare();
    expect(s.source.acquire).toHaveBeenCalledTimes(1);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    s.provider.dispose();
  });
});

it('classifies a broker-issued unsupported model as permanent unsupported', async () => {
  const s = setup();
  s.fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      token: 'ephemeral',
      model: 'unsupported-model',
      expiresAt: Date.now() + 60000,
    }),
  });
  await s.provider.start();
  expect(recoveryFailureFor('gemini', 'transcription')).toMatchObject({ kind: 'unsupported' });
  expect(s.socketFactory).not.toHaveBeenCalled();
  s.provider.dispose();
});

it.each(['before', 'after'] as const)(
  'retains structured protocol refusal %s readiness',
  async (phase) => {
    const s = setup();
    let started: Promise<void> | undefined;
    if (phase === 'after') await s.ready();
    else {
      started = s.provider.start();
      await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    }
    s.event({ error: { status: 'PERMISSION_DENIED' } });
    await started;
    expect(recoveryFailureFor('gemini', 'transcription')).toMatchObject({ kind: 'auth' });
    expect(s.handlers.onHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoveryFailure: expect.objectContaining({ kind: 'auth' }) }),
    );
    s.provider.dispose();
  },
);
afterEach(() => {
  vi.useRealTimers();
  __resetRecoveryFailuresForTests();
});
describe('Gemini dedicated transcription', () => {
  it('does not restart the network deadline after a slow credential request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const s = setup();
    s.fetchMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      return {
        ok: true,
        json: async () => ({
          token: 'temporary-token',
          model: 'gemini-3.5-transcribe-live',
          expiresAt: Date.now() + 60000,
        }),
      };
    });
    const started = s.provider.start();
    await vi.advanceTimersByTimeAsync(12_001);
    expect(s.socketFactory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    await started;
    expect(s.provider.status).toBe('stopped');
    expect(s.handlers.onHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryFailure: expect.objectContaining({ kind: 'network' }),
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [401, 'auth'],
    [429, 'rate-limit'],
    [404, 'unsupported'],
  ] as const)(
    'normalizes HTTP %s and preserves its gate across a replacement adapter',
    async (status, kind) => {
      const first = setup();
      first.fetchMock.mockImplementationOnce(
        async () => new Response(null, { status, headers: { 'Retry-After': '60' } }) as never,
      );
      await first.provider.start();
      expect(first.handlers.onHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          recoveryFailure: expect.objectContaining({
            provider: 'gemini',
            purpose: 'transcription',
            kind,
          }),
        }),
      );
      first.provider.dispose();
      const next = setup();
      await next.provider.start();
      expect(next.fetchMock).not.toHaveBeenCalled();
      next.provider.dispose();
    },
  );
  it('ignores a late refusal after Stop instead of blocking a later meeting', async () => {
    const s = setup();
    let resolve!: (response: never) => void;
    s.fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = s.provider.start();
    await vi.waitFor(() => expect(s.fetchMock).toHaveBeenCalled());
    s.provider.dispose();
    resolve(new Response(null, { status: 401 }) as never);
    await pending;
    expect(recoveryFailureFor('gemini', 'transcription')).toBeUndefined();
  });
  it('replays the captured real-cloud generation sequence without gaps or missing finals', async () => {
    const report = JSON.parse(
      readFileSync(
        new URL('../../../../docs/evals/2026-10-08-real-cloud.json', import.meta.url),
        'utf8',
      ),
    );
    const recorded = report.results.findLast(
      (entry: { provider: string; completed: boolean }) =>
        entry.provider === 'gemini' && entry.completed,
    );
    expect(recorded.transcripts).toHaveLength(6);
    const timeline = [
      ...recorded.activities.map((entry: { type: string; at: number }) => ({
        at: entry.at,
        activity: entry.type,
      })),
      ...recorded.serverContent.map((entry: { at: number }) => ({ at: entry.at, content: entry })),
    ].sort((a, b) => a.at - b.at);
    const s = setup();
    await s.ready();
    for (const entry of timeline) {
      if (entry.activity === 'start') s.frame(entry.at);
      else if (entry.activity === 'end') s.endTurn(entry.at - 704);
      else s.event({ serverContent: entry.content });
    }
    await s.provider.stop();
    const finals = s.handlers.onTranscript.mock.calls
      .map(([e]) => e)
      .filter((e) => e.status === 'final');
    // rawText is intentionally omitted when script normalization changes nothing.
    expect(finals.map((e) => e.rawText ?? e.text)).toEqual(recorded.transcripts);
    expect(finals.every((e) => e.endMs > e.startMs)).toBe(true);
    expect(
      s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'degraded' || e.state === 'failed'),
    ).toBe(false);
  });
  it('uses constrained WS, VERBATIM TEXT setup, manual VAD and renewal before10min', async () => {
    const s = setup();
    await s.ready();
    expect(s.socketFactory.mock.calls[0]?.[0]).toContain(
      'BidiGenerateContentConstrained?access_token=',
    );
    expect(JSON.parse(s.socket.send.mock.calls[0]![0])).toEqual({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
    expect(s.provider.getRenewalEtaMs()).toBeGreaterThan(479000);
    expect(s.provider.getRenewalEtaMs()).toBeLessThanOrEqual(480000);
    s.provider.dispose();
  });
  it('accepts the canonical models/ resource returned by the real broker', async () => {
    const s = setup();
    s.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'temporary-token',
        model: 'models/gemini-3.5-transcribe-live',
        expiresAt: Date.now() + 60000,
      }),
    });
    await s.ready();
    expect(s.provider.status).toBe('running');
    s.provider.dispose();
  });
  it('replaces interim hypotheses, preserves raw Chinese, repeats valid finals and estimates from capture', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.event({ serverContent: { interimInputTranscription: { text: '会议 API' } } });
    s.event({ serverContent: { interimInputTranscription: { text: '会议 API pending' } } });
    s.endTurn(1032);
    s.event({ serverContent: { inputTranscription: { text: '会议 API pending' } } });
    s.event({ serverContent: { generationComplete: true } });
    s.frame(2000);
    s.endTurn(2032);
    s.event({ serverContent: { inputTranscription: { text: '会议 API pending' } } });
    const events = s.handlers.onTranscript.mock.calls.map(([e]) => e);
    expect(events.map((e) => e.text)).toEqual([
      '會議 API',
      '會議 API pending',
      '會議 API pending',
      '會議 API pending',
    ]);
    expect(events.filter((e) => e.status === 'final').map((e) => e.startMs)).toEqual([1000, 2000]);
    expect(events[2].segmentId).not.toBe(events[3].segmentId);
    expect(events[2]).toMatchObject({
      rawText: '会议 API pending',
      timingBasis: 'capture-estimated',
    });
    expect(events[2]).not.toHaveProperty('confidence');
    expect(events[2]).not.toHaveProperty('speaker');
    expect(s.handlers.onTranslation).not.toHaveBeenCalled();
    s.event({ serverContent: { generationComplete: true } });
    await s.provider.stop();
  });
  it('sends activityStart before PCM, activityEnd after tail and drains Stop final', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    const stopping = s.provider.stop();
    await vi.waitFor(() => expect(s.socket.send).toHaveBeenCalledTimes(4));
    const sent = s.socket.send.mock.calls.slice(1).map(([raw]) => JSON.parse(raw).realtimeInput);
    expect(sent[0]).toEqual({ activityStart: {} });
    expect(sent[1].audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(sent[2]).toEqual({ activityEnd: {} });
    expect(s.source.release).toHaveBeenCalled();
    s.event({ serverContent: { inputTranscription: { text: 'yes' } } });
    s.event({ serverContent: { generationComplete: true } });
    await stopping;
    expect(s.handlers.onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'final', text: 'yes', startMs: 1000, endMs: 1032 }),
    );
  });
  it('holds the next activity until the previous generation completes, then sends its PCM in order', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.endTurn(1032);
    const before = s.socket.send.mock.calls.length;
    s.frame(2000);
    expect(s.socket.send).toHaveBeenCalledTimes(before);
    s.event({ serverContent: { inputTranscription: { text: '第一句' } } });
    expect(s.socket.send).toHaveBeenCalledTimes(before);
    s.event({ serverContent: { generationComplete: true } });
    const next = s.socket.send.mock.calls
      .slice(before)
      .map(([raw]) => JSON.parse(raw).realtimeInput);
    expect(next[0]).toEqual({ activityStart: {} });
    expect(next.slice(1).every((message) => message.audio?.data)).toBe(true);
    s.provider.dispose();
  });
  it('reports an audio gap when a stalled generation exhausts the bounded queue', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.endTurn(1032);
    const before = s.socket.send.mock.calls.length;
    for (let i = 0; i < 257; i++) s.frame(2000 + i * 32);
    expect(s.provider.status).toBe('stopped');
    expect(s.socket.send).toHaveBeenCalledTimes(before);
    expect(s.handlers.onHealth.mock.calls.some(([e]) => /gap/.test(e.message ?? ''))).toBe(true);
    expect(s.source.release).toHaveBeenCalled();
  });
  it('keeps multiple finals on the sent activity while the next activity is queued', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.endTurn(1032);
    s.frame(3000);
    s.endTurn(3032);
    s.event({ serverContent: { inputTranscription: { text: 'A first' } } });
    s.event({ serverContent: { inputTranscription: { text: 'A second' } } });
    const events = s.handlers.onTranscript.mock.calls.map(([e]) => e);
    expect(events[1].endMs).toBe(1736);
    expect(events[1].startMs).toBeLessThan(events[1].endMs);
    expect(events[1].segmentId).not.toBe(events[0].segmentId);
    s.event({ serverContent: { generationComplete: true } });
    s.event({ serverContent: { inputTranscription: { text: 'B' } } });
    expect(s.handlers.onTranscript.mock.calls.at(-1)![0].startMs).toBe(3000);
    s.provider.dispose();
  });
  it('waits for generation completion and retains a delayed second final during Stop', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.event({ serverContent: { inputTranscription: { text: 'first' } } });
    vi.useFakeTimers();
    let stopped = false;
    const stopping = s.provider.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(stopped).toBe(false);
    s.event({ serverContent: { inputTranscription: { text: 'delayed tail' } } });
    s.event({ serverContent: { generationComplete: true } });
    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    expect(s.handlers.onTranscript.mock.calls.map(([e]) => e.text)).toEqual([
      'first',
      'delayed tail',
    ]);
    expect(s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'degraded')).toBe(false);
  });
  it('does not invent an unfinished segment from silence after an early final', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.event({ serverContent: { inputTranscription: { text: 'done' } } });
    s.endTurn(1032);
    s.event({ serverContent: { generationComplete: true } });
    vi.useFakeTimers();
    let stopped = false;
    const stopping = s.provider.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(stopped).toBe(true);
    await stopping;
    expect(s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'degraded')).toBe(false);
  });
  it('retains partial text and reports a gap if generation completes without final text', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.endTurn(1032);
    s.event({ serverContent: { interimInputTranscription: { text: '尚未確認' } } });
    s.event({ serverContent: { generationComplete: true } });
    await s.provider.stop();
    expect(s.handlers.onTranscript.mock.calls.map(([e]) => e.status)).toEqual(['partial']);
    expect(s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'degraded')).toBe(true);
  });
  it('reports a gap when final text arrives but the generation never completes', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    vi.useFakeTimers();
    const stopping = s.provider.stop();
    await vi.advanceTimersByTimeAsync(1);
    s.event({ serverContent: { inputTranscription: { text: 'first final' } } });
    await vi.advanceTimersByTimeAsync(5001);
    await stopping;
    expect(s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'degraded')).toBe(true);
    expect(s.handlers.onTranscript).toHaveBeenCalledTimes(1);
  });
  it('marks unfinished stop on deadline without inventing final', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    vi.useFakeTimers();
    const stopping = s.provider.stop();
    await vi.advanceTimersByTimeAsync(5001);
    await stopping;
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
    expect(s.handlers.onHealth.mock.calls.some(([e]) => /unfinished/.test(e.message ?? ''))).toBe(
      true,
    );
  });
  it('ignores stale ready and transcript after dispose', async () => {
    const s = setup();
    const started = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onopen).not.toBeNull());
    const receive = s.socket.onmessage;
    s.provider.dispose();
    await started;
    receive?.({
      data: JSON.stringify({
        setupComplete: {},
        serverContent: { inputTranscription: { text: 'stale' } },
      }),
    });
    expect(s.provider.status).toBe('stopped');
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
  });
  it('fails visibly on backpressure and sanitized upstream error', async () => {
    const s = setup();
    await s.ready();
    s.socket.bufferedAmount = 1000001;
    s.frame(1000);
    expect(s.provider.status).toBe('stopped');
    expect(s.source.release).toHaveBeenCalled();
    expect(s.handlers.onHealth.mock.calls.some(([e]) => /gap/.test(e.message ?? ''))).toBe(true);
    const t = setup();
    await t.ready();
    t.event({ error: { message: 'temporary-token secret' } });
    expect(t.provider.status).toBe('stopped');
    expect(JSON.stringify(t.handlers.onHealth.mock.calls)).not.toContain('temporary-token');
  });
  it('keeps silence silent and every legitimate early final even within one manual activity', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000, 0);
    expect(s.socket.send).toHaveBeenCalledTimes(1);
    s.frame(1032);
    s.event({ serverContent: { inputTranscription: { text: 'yes' } } });
    s.frame(1064);
    s.event({ serverContent: { inputTranscription: { text: 'yes' } } });
    expect(s.handlers.onTranscript.mock.calls.map(([e]) => e.text)).toEqual(['yes', 'yes']);
    expect(s.handlers.onTranscript.mock.calls[1]![0]).toMatchObject({ startMs: 1064, endMs: 1096 });
    s.provider.dispose();
  });
  it('rejects expired credentials and does not leak constructor errors', async () => {
    const s = setup();
    s.fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        token: 'temporary-token',
        model: 'gemini-3.5-transcribe-live',
        expiresAt: Date.now() - 1,
      }),
    }));
    await s.provider.start();
    expect(s.socketFactory).not.toHaveBeenCalled();
    expect(s.source.release).toHaveBeenCalled();
    const t = setup();
    t.socketFactory.mockImplementationOnce(() => {
      throw new Error('temporary-token');
    });
    await t.provider.start();
    expect(JSON.stringify(t.handlers.onHealth.mock.calls)).not.toContain('temporary-token');
  });
  it('bounds incomplete setup and malformed transcript fails visibly', async () => {
    const s = setup();
    vi.useFakeTimers();
    const started = s.provider.start();
    await vi.advanceTimersByTimeAsync(15001);
    await started;
    expect(s.provider.status).toBe('stopped');
    expect(s.source.release).toHaveBeenCalled();
    vi.useRealTimers();
    const t = setup();
    await t.ready();
    t.frame(1000);
    t.event({ serverContent: { inputTranscription: { text: 42 } } });
    expect(t.provider.status).toBe('stopped');
    expect(t.handlers.onTranscript).not.toHaveBeenCalled();
  });
  it('keeps a stable local ID for revised server fragments after an earlier final', async () => {
    const s = setup();
    await s.ready();
    s.frame(1000);
    s.endTurn(1032);
    s.event({ serverContent: { inputTranscription: { text: 'first' } } });
    s.event({ serverContent: { interimInputTranscription: { text: 'next' } } });
    s.event({ serverContent: { interimInputTranscription: { text: 'next word' } } });
    s.event({ serverContent: { inputTranscription: { text: 'next word' } } });
    const events = s.handlers.onTranscript.mock.calls.map(([e]) => e);
    expect(events[1].segmentId).toBe(events[2].segmentId);
    expect(events[2].segmentId).toBe(events[3].segmentId);
    expect(events[0].segmentId).not.toBe(events[1].segmentId);
    s.provider.dispose();
  });
});
