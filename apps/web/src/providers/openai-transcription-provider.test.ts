import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetRecoveryFailuresForTests, recoveryFailureFor } from './recovery-attempt.js';
afterEach(() => __resetRecoveryFailuresForTests());
import { OpenAITranscriptionProvider } from './openai-transcription-provider.js';
import type {
  TranscriptionAudioCallbacks,
  TranscriptionAudioFactory,
} from './transcription-audio.js';

function setup(audioFactory?: TranscriptionAudioFactory) {
  const track = { readyState: 'live' };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
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
  const audioSource = {
    analyser: null,
    acquire: vi.fn(async () => ({ getAudioTracks: () => [track] }) as unknown as MediaStream),
    release: vi.fn(),
  };
  let callbacks: TranscriptionAudioCallbacks;
  const audio = { pause: vi.fn(async () => {}), dispose: vi.fn() };
  const socketFactory = vi.fn(() => socket as unknown as WebSocket);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
      model: 'gpt-live-transcribe',
    }),
  }));
  const provider = new OpenAITranscriptionProvider({
    sessionUrl: '/session/transcription',
    handlers,
    audioSource,
    dependencies: {
      fetch: fetchMock as unknown as typeof fetch,
      socket: socketFactory,
      audio:
        audioFactory ??
        (async (_stream, cb) => {
          callbacks = cb;
          return audio;
        }),
    },
  });
  const event = (body: object) => socket.onmessage?.({ data: JSON.stringify(body) });
  const ready = async (candidate = false) => {
    const started = candidate ? provider.prepare() : provider.start();
    await vi.waitFor(() => expect(socket.onmessage).not.toBeNull());
    event({
      type: 'session.created',
      session: {
        type: 'transcription',
        audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } },
      },
    });
    await started;
  };
  return {
    track,
    provider,
    socket,
    socketFactory,
    handlers,
    audioSource,
    audio,
    fetchMock,
    event,
    ready,
    frame: (p: number, ms: number, range?: import('./meeting-audio-buffer.js').SampleRange) =>
      callbacks.onFrame(new Float32Array(512), p, ms, range),
  };
}

describe('OpenAI candidate boundary', () => {
  it('associates completed committed input with exactly the frames submitted through VAD', async () => {
    const s = setup();
    await s.ready();
    const range = { trackId: 'mic', captureEpoch: 'capture-1', from: 6400, to: 6912 };
    for (let i = 0; i < 23; i++)
      s.frame(i === 0 ? 0.9 : 0, 1000 + i * 32, {
        ...range,
        from: 6400 + i * 512,
        to: 6400 + (i + 1) * 512,
      });
    const sent = s.socket.send.mock.calls.map(([message]) => JSON.parse(message));
    expect(sent.filter((event) => event.type === 'input_audio_buffer.append')).toHaveLength(23);
    expect(sent.at(-1).type).toBe('input_audio_buffer.commit');
    s.event({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    s.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'hello',
    });
    expect(s.handlers.onTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'final',
        inputAudioRange: { ...range, to: 18176, sampleRate: 16000 },
      }),
    );
    s.provider.dispose();
  });

  it('does not publish an input range or final after a wire send fails', async () => {
    const s = setup();
    await s.ready();
    s.socket.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    s.frame(0.9, 1000, { trackId: 'mic', captureEpoch: 'capture-1', from: 0, to: 512 });
    s.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'late',
    });
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
    expect(s.provider.status).toBe('stopped');
    s.provider.dispose();
  });
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
          client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
          model: 'gpt-live-transcribe',
          concurrent_renewal_allowed: value,
        }),
      });
      await s.ready();
      expect(s.provider.allowsConcurrentRenewal()).toBe(value === true);
      s.provider.dispose();
      expect(s.provider.allowsConcurrentRenewal()).toBe(false);
    },
  );
  it('prepares without sending audio or publishing live, then activates synchronously', async () => {
    const s = setup();
    await s.ready(true);
    expect(s.provider.status).not.toBe('running');
    for (let i = 0; i < 8; i++) s.frame(0.9, i * 32);
    expect(s.socket.send).not.toHaveBeenCalled();
    expect(s.handlers.onAudioLevel).not.toHaveBeenCalled();
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
    expect(s.handlers.onHealth).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'connected' }),
    );
    s.provider.activate();
    expect(s.provider.status).toBe('running');
    for (let i = 0; i < 8; i++) s.frame(0.9, 1000 + i * 32);
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
    expect(active.audioSource.release).not.toHaveBeenCalled();
    expect(active.audio.dispose).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i++) active.frame(0.9, i * 32);
    expect(active.socket.send).toHaveBeenCalled();
    active.provider.dispose();
  });
  it('shares pending prepare and does not reacquire or remint on repeated prepare', async () => {
    const s = setup();
    const first = s.ready(true);
    const second = s.provider.prepare();
    await Promise.all([first, second]);
    await s.provider.prepare();
    expect(s.audioSource.acquire).toHaveBeenCalledTimes(1);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    s.provider.dispose();
  });
});

it('classifies a broker-issued unsupported model as permanent unsupported', async () => {
  const s = setup();
  s.fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
      model: 'unsupported-model',
    }),
  });
  await s.provider.start();
  expect(recoveryFailureFor('openai', 'transcription')).toMatchObject({ kind: 'unsupported' });
  expect(s.socketFactory).not.toHaveBeenCalled();
  s.provider.dispose();
});

it('classifies unsupported session-created configuration without switching credentials', async () => {
  const s = setup();
  const starting = s.provider.start();
  await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
  s.event({
    type: 'session.created',
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription: { model: 'gpt-live-transcribe' },
          turn_detection: { type: 'server_vad' },
        },
      },
    },
  });
  await starting;
  expect(recoveryFailureFor('openai', 'transcription')).toMatchObject({ kind: 'unsupported' });
  expect(s.fetchMock).toHaveBeenCalledTimes(1);
  s.provider.dispose();
});

it.each(['before', 'after'] as const)(
  'retains structured protocol rate limiting %s readiness',
  async (phase) => {
    const s = setup();
    let started: Promise<void> | undefined;
    if (phase === 'after') await s.ready();
    else {
      started = s.provider.start();
      await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    }
    s.event({ type: 'error', error: { code: 'rate_limit_exceeded', status: 429 } });
    await started;
    expect(recoveryFailureFor('openai', 'transcription')).toMatchObject({ kind: 'rate-limit' });
    expect(s.handlers.onHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoveryFailure: expect.objectContaining({ kind: 'rate-limit' }) }),
    );
    s.provider.dispose();
  },
);
describe('dedicated transcription lifecycle', () => {
  it('keeps local VAD failures at the audio layer without poisoning provider recovery', async () => {
    const s = setup(async () => {
      throw new Error('local VAD failed');
    });
    const started = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    s.event({
      type: 'session.created',
      session: {
        type: 'transcription',
        audio: {
          input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: null },
        },
      },
    });
    await started;
    expect(s.handlers.onHealth).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'audio', state: 'failed' }),
    );
    expect(recoveryFailureFor('openai', 'transcription')).toBeUndefined();
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
            provider: 'openai',
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
    expect(recoveryFailureFor('openai', 'transcription')).toBeUndefined();
  });
  it('tries one alternate after opaque pre-ready close without reporting it as auth rejection', async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
        model: 'gpt-live-transcribe',
        key_slot: 'primary',
        alternate_key_slot: 'audio',
      }),
    }));
    const starting = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onclose).not.toBeNull());
    const staleMessage = s.socket.onmessage;
    (s.socket.onclose as unknown as (event: { code: number }) => void)({ code: 1006 });
    await vi.waitFor(() => expect(s.fetchMock).toHaveBeenCalledTimes(2));
    const request = (s.fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(request.body))).toMatchObject({
      retryKeySlot: 'audio',
      failedSlot: 'primary',
      failureKind: 'opaque',
    });
    await vi.waitFor(() => expect(s.socketFactory).toHaveBeenCalledTimes(2));
    staleMessage?.({
      data: JSON.stringify({ type: 'error', error: { message: 'private ephemeral' } }),
    });
    s.event({
      type: 'session.created',
      session: {
        type: 'transcription',
        audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } },
      },
    });
    await starting;
    expect(s.provider.status).toBe('running');
    expect(s.audioSource.acquire).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.handlers.onHealth.mock.calls)).not.toContain('ephemeral');
    s.provider.dispose();
  });
  it.each(['ip_not_authorized', 'invalid_api_key'])(
    'retries explicit %s once with auth evidence',
    async (code) => {
      const s = setup();
      s.fetchMock.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
          model: 'gpt-live-transcribe',
          key_slot: 'primary',
          alternate_key_slot: 'audio',
        }),
      }));
      const starting = s.provider.start();
      await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
      s.event({ type: 'error', error: { code, message: 'private ephemeral' } });
      await vi.waitFor(() => expect(s.socketFactory).toHaveBeenCalledTimes(2));
      expect(
        JSON.parse(String((s.fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
          .failureKind,
      ).toBe('auth');
      s.event({ type: 'error', error: { code, message: 'private ephemeral' } });
      await starting;
      expect(s.fetchMock).toHaveBeenCalledTimes(2);
      expect(s.provider.status).toBe('stopped');
      expect(JSON.stringify(s.handlers.onHealth.mock.calls)).not.toContain('ephemeral');
    },
  );
  it('does not switch keys for explicit rate limiting even when close follows', async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
        model: 'gpt-live-transcribe',
        key_slot: 'primary',
        alternate_key_slot: 'audio',
      }),
    }));
    const starting = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    s.event({ type: 'error', error: { code: 'rate_limit_exceeded', status: 429 } });
    (s.socket.onclose as unknown as (event: { code: number }) => void)?.({ code: 1006 });
    await starting;
    expect(s.fetchMock).toHaveBeenCalledOnce();
  });
  it('shares a total 30 second setup deadline across both key probes', async () => {
    const s = setup();
    let requests = 0;
    s.fetchMock.mockImplementation(async () => {
      if (requests++ > 0) await new Promise((resolve) => setTimeout(resolve, 14000));
      return {
        ok: true,
        json: async () => ({
          client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
          model: 'gpt-live-transcribe',
          key_slot: 'primary',
          alternate_key_slot: 'audio',
        }),
      };
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      const starting = s.provider.start();
      await vi.advanceTimersByTimeAsync(14000);
      (s.socket.onclose as unknown as (event: { code: number }) => void)({ code: 1006 });
      await vi.advanceTimersByTimeAsync(14001);
      expect(s.socketFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      await starting;
      expect(s.provider.status).toBe('stopped');
      expect(s.fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('stops after two opaque failures and never turns an unknown close into auth evidence', async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        client_secret: { value: 'ephemeral', expires_at: Date.now() / 1000 + 60 },
        model: 'gpt-live-transcribe',
        key_slot: 'primary',
        alternate_key_slot: 'audio',
      }),
    }));
    const starting = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onclose).not.toBeNull());
    (s.socket.onclose as unknown as (event: { code: number }) => void)({ code: 1006 });
    await vi.waitFor(() => expect(s.socketFactory).toHaveBeenCalledTimes(2));
    (s.socket.onclose as unknown as (event: { code: number }) => void)({ code: 1006 });
    await starting;
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
    expect(s.provider.status).toBe('stopped');
    expect(s.audioSource.release).toHaveBeenCalled();
  });
  it('does not probe when no independent alternate is advertised', async () => {
    const s = setup();
    const starting = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onclose).not.toBeNull());
    (s.socket.onclose as unknown as (event: { code: number }) => void)({ code: 1006 });
    await starting;
    expect(s.fetchMock).toHaveBeenCalledOnce();
    expect(s.provider.status).toBe('stopped');
  });
  it('uses append before commit, stops capture before draining and never translates', async () => {
    const s = setup();
    await s.ready();
    s.frame(0.9, 1000);
    const stop = s.provider.stop();
    await vi.waitFor(() => expect(s.socket.send).toHaveBeenCalledTimes(3));
    expect(s.audio.pause).toHaveBeenCalled();
    expect(s.audioSource.release).toHaveBeenCalled();
    expect(s.socket.send.mock.calls.map((c) => JSON.parse(c[0]).type)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    s.event({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    s.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      content_index: 0,
      transcript: '不是 approve',
    });
    await stop;
    expect(s.handlers.onTranscript).toHaveBeenCalledTimes(1);
    expect(s.handlers.onTranslation).not.toHaveBeenCalled();
    expect(s.provider.status).toBe('stopped');
  });
  it('fails visibly on backpressure and releases capture', async () => {
    const s = setup();
    await s.ready();
    s.socket.bufferedAmount = 1_000_001;
    s.frame(0.9, 1000);
    expect(s.provider.status).toBe('stopped');
    expect(s.audioSource.release).toHaveBeenCalled();
    expect(s.handlers.onHealth.mock.calls.some(([e]) => /gap/.test(e.message ?? ''))).toBe(true);
  });
  it('rejects stale readiness after dispose', async () => {
    const s = setup();
    const started = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    s.provider.dispose();
    await started;
    s.event({ type: 'session.created', session: { type: 'transcription' } });
    expect(s.provider.status).toBe('stopped');
    expect(s.socket.send).not.toHaveBeenCalled();
  });
  it('reports missing final on the bounded stop deadline without fabricating final', async () => {
    const s = setup();
    await s.ready();
    s.frame(0.9, 1000);
    vi.useFakeTimers();
    const stopped = s.provider.stop();
    await vi.advanceTimersByTimeAsync(5001);
    await stopped;
    expect(s.handlers.onTranscript).not.toHaveBeenCalled();
    expect(s.handlers.onHealth.mock.calls.some(([e]) => /unfinished/.test(e.message ?? ''))).toBe(
      true,
    );
    vi.useRealTimers();
  });
  it('treats malformed runtime events as visible failure and releases the lease', async () => {
    const s = setup();
    await s.ready();
    s.socket.onmessage?.({ data: 'not json' });
    expect(s.provider.status).toBe('stopped');
    expect(s.audioSource.release).toHaveBeenCalled();
    expect(s.handlers.onHealth.mock.calls.some(([e]) => e.state === 'failed')).toBe(true);
  });
  it('shows live transcript and sample levels while speech is still in progress', async () => {
    const s = setup();
    await s.ready();
    s.frame(0.9, 1000);
    s.event({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      content_index: 0,
      delta: '正在 speaking',
    });
    expect(s.handlers.onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', text: '正在 speaking', startMs: 1000 }),
    );
    expect(s.handlers.onAudioLevel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio_level', source: 'microphone' }),
    );
    s.provider.dispose();
  });
  it('bounds hung local model setup and prevents late adapter takeover', async () => {
    let resolveAudio!: (audio: { pause: () => Promise<void>; dispose: () => void }) => void;
    const s = setup(
      () =>
        new Promise((resolve) => {
          resolveAudio = resolve;
        }),
    );
    const starting = s.provider.start();
    await vi.waitFor(() => expect(s.socket.onmessage).not.toBeNull());
    vi.useFakeTimers();
    s.event({
      type: 'session.created',
      session: {
        type: 'transcription',
        audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } },
      },
    });
    await vi.advanceTimersByTimeAsync(15001);
    await starting;
    expect(s.provider.status).toBe('stopped');
    const dispose = vi.fn();
    resolveAudio({ pause: async () => {}, dispose });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('does not release capture from an older acquisition while the same owner restarts', async () => {
    const s = setup();
    let complete!: (stream: MediaStream) => void;
    const stream = { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;
    s.audioSource.acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stale = s.provider.start();
    s.provider.dispose();
    const next = s.ready();
    await next;
    const releases = s.audioSource.release.mock.calls.length;
    complete(stream);
    await stale;
    expect(s.audioSource.release).toHaveBeenCalledTimes(releases);
    expect(s.provider.status).toBe('running');
    s.provider.dispose();
  });
  it('bounds token response body parsing, including an uncooperative promise', async () => {
    const s = setup();
    s.fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    vi.useFakeTimers();
    const starting = s.provider.start();
    await vi.advanceTimersByTimeAsync(15001);
    await starting;
    expect(s.provider.status).toBe('stopped');
    expect(s.audioSource.release).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('does not expose a credential when the browser includes a rejected subprotocol in its exception', async () => {
    const s = setup();
    s.socketFactory.mockImplementationOnce(() => {
      throw new Error('Invalid subprotocol openai-insecure-api-key.ephemeral');
    });
    await s.provider.start();
    expect(JSON.stringify(s.handlers.onHealth.mock.calls)).not.toContain('ephemeral');
    expect(s.provider.status).toBe('stopped');
  });
});
