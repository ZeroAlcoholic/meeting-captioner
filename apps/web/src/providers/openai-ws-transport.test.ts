import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIWsOpenError, OpenAIWsTransport, resampleTo24kHz } from './openai-ws-transport.js';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

interface FakeSocket {
  url: string;
  protocols: string[];
  sent: string[];
  readyState: number;
  bufferedAmount: number;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
}

let lastSocket: FakeSocket | null = null;

function serverSends(ev: unknown): void {
  lastSocket?.onmessage?.({ data: JSON.stringify(ev) });
}
function serverCloses(code: number, reason = ''): void {
  if (lastSocket) lastSocket.readyState = 3;
  lastSocket?.onclose?.({ code, reason });
}

/** The worklet's port, captured so tests can push a PCM chunk through it. */
let workletPort: { onmessage: ((e: { data: ArrayBuffer }) => void) | null; close: () => void } = {
  onmessage: null,
  close: () => {},
};
let workletModulePromise: Promise<void>;
let sourceConnectCalls = 0;
let workletConnectCalls = 0;

function fakeStream(): MediaStream {
  return { getAudioTracks: () => [] } as unknown as MediaStream;
}

beforeEach(() => {
  lastSocket = null;
  workletPort = { onmessage: null, close: () => {} };
  workletModulePromise = Promise.resolve();
  sourceConnectCalls = 0;
  workletConnectCalls = 0;

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: FakeSocket['onmessage'] = null;
    onclose: FakeSocket['onclose'] = null;
    onerror: FakeSocket['onerror'] = null;
    sent: string[] = [];
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      lastSocket = this as unknown as FakeSocket;
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      // Browsers fire onclose after close(); several code paths depend on it.
      this.onclose?.({ code: 1000, reason: '' });
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // Stub the real globals (rather than mocking the audio engine) so the module
  // under test exercises the same capture path production uses. test-setup.ts
  // clears the engine's cached context before every test.
  vi.stubGlobal(
    'AudioContext',
    class {
      state: AudioContextState = 'running';
      audioWorklet = { addModule: vi.fn(() => workletModulePromise) };
      destination = {};
      sampleRate = 16000;
      createMediaStreamSource() {
        return {
          connect() {
            sourceConnectCalls += 1;
          },
          disconnect() {},
        };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = workletPort;
      connect(): void {
        workletConnectCalls += 1;
      }
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenAIWsTransport', () => {
  it('counts active capture frames while a socket is closing without sending them', async () => {
    const onCaptureHealth = vi.fn();
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: vi.fn(),
      onClosed: vi.fn(),
      onAudioTrouble: vi.fn(),
      onCaptureHealth,
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();
    lastSocket!.readyState = 2;
    try {
      const sent = lastSocket!.sent.length;
      workletPort.onmessage?.({ data: new Float32Array(512).buffer });
      expect(onCaptureHealth).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'capture_resumed' }),
      );
      expect(lastSocket!.sent).toHaveLength(sent);
    } finally {
      transport.close();
    }
  });
  it('publishes first-frame recovery only after the candidate is activated', async () => {
    const onCaptureHealth = vi.fn();
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: vi.fn(),
      onClosed: vi.fn(),
      onAudioTrouble: vi.fn(),
      onCaptureHealth,
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    workletPort.onmessage?.({ data: new Float32Array(512).buffer });
    expect(onCaptureHealth).not.toHaveBeenCalled();
    transport.activate();
    workletPort.onmessage?.({ data: new Float32Array(512).buffer });
    expect(onCaptureHealth).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'capture_resumed' }),
    );
    transport.close();
  });
  it('close cancels its worklet wait without leaving an engine deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let loaded!: () => void;
    workletModulePromise = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const pending = OpenAIWsTransport.open(
      'ek',
      fakeStream(),
      {
        onEvent: vi.fn(),
        onClosed: vi.fn(),
        onAudioTrouble: vi.fn(),
      },
      controller.signal,
    ).catch(() => {});
    serverSends({ type: 'session.created' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('Stopped'));
    await pending;
    // The engine's aborted waiter releases its deadline in its async finally.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    loaded();
    await Promise.resolve();
    expect(sourceConnectCalls).toBe(0);
  });

  it('cancels pending setup on Stop without waiting for its timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const handlers = { onEvent: vi.fn(), onClosed: vi.fn(), onAudioTrouble: vi.fn() };
    let outcome: unknown;
    const pending = OpenAIWsTransport.open('ek', fakeStream(), handlers, controller.signal).catch(
      (error: unknown) => {
        outcome = error;
      },
    );
    controller.abort(new Error('Stopped'));
    await Promise.resolve();
    expect(outcome).toBeInstanceOf(Error);
    expect(lastSocket?.readyState).toBe(3);
    expect(handlers.onClosed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  it.each(['session.closed', 'error'])(
    'rejects %s during audio setup without exposing it to the owner',
    async (type) => {
      let finishWorklet!: () => void;
      workletModulePromise = new Promise<void>((resolve) => {
        finishWorklet = resolve;
      });
      const handlers = { onEvent: vi.fn(), onClosed: vi.fn(), onAudioTrouble: vi.fn() };
      const pending = OpenAIWsTransport.open('ek', fakeStream(), handlers);
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      serverSends({ type: 'session.created' });
      serverSends({ type, error: { code: 'session_expired', message: 'Session expired' } });
      finishWorklet();
      expect(await outcome).toBeInstanceOf(OpenAIWsOpenError);
      expect(lastSocket!.readyState).toBe(3);
      expect(handlers.onEvent).not.toHaveBeenCalled();
      expect(handlers.onClosed).not.toHaveBeenCalled();
    },
  );

  it.each(['session.closed', 'error'])(
    'invalidates a ready candidate on %s before activation',
    async (type) => {
      const handlers = { onEvent: vi.fn(), onClosed: vi.fn(), onAudioTrouble: vi.fn() };
      const pending = OpenAIWsTransport.open('ek', fakeStream(), handlers);
      serverSends({ type: 'session.created' });
      const transport = await pending;
      serverSends({ type, error: { code: 'session_expired', message: 'Session expired' } });
      expect(transport.isOpen).toBe(false);
      expect(() => transport.activate()).toThrow(OpenAIWsOpenError);
      workletPort.onmessage?.({ data: new Float32Array(160).fill(0.25).buffer });
      expect(lastSocket!.sent).toEqual([]);
      expect(handlers.onEvent).not.toHaveBeenCalled();
      expect(handlers.onClosed).not.toHaveBeenCalled();
      transport.close();
    },
  );

  it('a ready candidate sends no PCM before activation', async () => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    workletPort.onmessage?.({ data: new Float32Array(160).fill(0.25).buffer });
    expect(lastSocket!.sent).toEqual([]);
    transport.activate();
    workletPort.onmessage?.({ data: new Float32Array(160).fill(0.25).buffer });
    expect(lastSocket!.sent).toHaveLength(1);
    transport.close();
  });

  it('drains retired events without sending more audio or invoking normal recovery', async () => {
    const normal = { onEvent: vi.fn(), onClosed: vi.fn(), onAudioTrouble: vi.fn() };
    const pending = OpenAIWsTransport.open('ek', fakeStream(), normal);
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();
    normal.onEvent.mockClear();
    const drained = vi.fn();
    const closed = vi.fn();
    (
      transport as OpenAIWsTransport & {
        beginDrain?: (event: typeof drained, close: typeof closed) => void;
      }
    ).beginDrain?.(drained, closed);
    expect(lastSocket!.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: 'session.close',
    });
    const sentCount = lastSocket!.sent.length;
    workletPort.onmessage?.({ data: new Float32Array(512).buffer });
    expect(lastSocket!.sent).toHaveLength(sentCount);
    serverSends({ type: 'session.output_transcript.delta', delta: 'tail' });
    serverSends({ type: 'session.closed' });
    expect(drained).toHaveBeenCalledTimes(2);
    expect(normal.onEvent).not.toHaveBeenCalled();
    serverCloses(1000);
    expect(closed).toHaveBeenCalledOnce();
    expect(normal.onClosed).not.toHaveBeenCalled();
    transport.close();
    serverSends({ type: 'session.output_transcript.delta', delta: 'late' });
    expect(drained).toHaveBeenCalledTimes(2);
  });

  it('carries the ephemeral token in the subprotocol, never in a query string', async () => {
    const pending = OpenAIWsTransport.open('ek_test123', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    expect(lastSocket?.url).toBe('wss://api.openai.com/v1/realtime/translations');
    expect(lastSocket?.url).not.toContain('ek_test123');
    expect(lastSocket?.protocols).toEqual(['realtime', 'openai-insecure-api-key.ek_test123']);
    serverSends({ type: 'session.created' });
    await pending;
  });

  it('resolves only after session.created, then replays events in order', async () => {
    const events: string[] = [];
    let resolved = false;
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: (e) => events.push(e.type),
      onClosed: () => {},
      onAudioTrouble: () => {},
    }).then((t) => {
      resolved = true;
      return t;
    });

    // A delta that beats session.created must not be dropped…
    serverSends({ type: 'session.output_transcript.delta', delta: 'x' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(events).toEqual([]);

    serverSends({ type: 'session.created' });
    const transport = await pending;
    expect(events).toEqual([]);
    transport.activate();
    expect(events).toEqual(['session.created', 'session.output_transcript.delta']);
  });

  it('buffers every setup event until the owner atomically activates the transport', async () => {
    let finishWorklet!: () => void;
    workletModulePromise = new Promise<void>((resolve) => {
      finishWorklet = resolve;
    });
    const events: string[] = [];
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: (e) => events.push(e.type),
      onClosed: () => {},
      onAudioTrouble: () => {},
    });

    serverSends({ type: 'session.created' });
    serverSends({ type: 'session.output_transcript.delta', delta: 'new-session text' });
    await Promise.resolve();
    expect(events).toEqual([]);

    finishWorklet();
    const transport = await pending;
    // open() only makes the transport ready. The provider owns the exact
    // make-before-break boundary and must opt in before any new-session event
    // can touch the shared caption accumulators.
    expect(events).toEqual([]);
    transport.activate();
    expect(events).toEqual(['session.created', 'session.output_transcript.delta']);
  });

  it('times out the whole setup and a late worklet completion cannot revive audio or events', async () => {
    vi.useFakeTimers();
    let finishWorklet!: () => void;
    workletModulePromise = new Promise<void>((resolve) => {
      finishWorklet = resolve;
    });
    const events: string[] = [];
    let outcome: unknown;
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: (e) => events.push(e.type),
      onClosed: () => {},
      onAudioTrouble: () => {},
    }).then(
      () => {
        outcome = 'resolved';
      },
      (err: unknown) => {
        outcome = err;
      },
    );

    serverSends({ type: 'session.created' });
    await vi.advanceTimersByTimeAsync(5_001);

    expect(outcome).toBeInstanceOf(OpenAIWsOpenError);
    expect((outcome as Error).message).toContain('AudioWorklet loading timed out');
    expect(lastSocket?.readyState).toBe(3);

    finishWorklet();
    await Promise.resolve();
    await Promise.resolve();
    serverSends({ type: 'session.output_transcript.delta', delta: 'too late' });
    expect(sourceConnectCalls).toBe(0);
    expect(workletConnectCalls).toBe(0);
    expect(events).toEqual([]);
    await pending;
  });

  it('rejects a refused handshake as an AUTH rejection so the ladder can switch keys', async () => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverCloses(4001, 'unauthorized');
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAIWsOpenError);
    expect((err as OpenAIWsOpenError).isAuthRejection).toBe(true);
  });

  it.each([
    ['', false],
    ['invalid audio payload', false],
    ['request 4012 exceeded policy', false],
    ['ip_not_authorized', true],
    ['403 Forbidden', true],
  ])('classifies policy close 1008 using reason %s', async (reason, auth) => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverCloses(1008, reason);
    const error = await pending.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OpenAIWsOpenError);
    expect((error as OpenAIWsOpenError).isAuthRejection).toBe(auth);
  });

  it('rejects a network-shaped close as NOT an auth rejection', async () => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverCloses(1006, '');
    const err = await pending.catch((e: unknown) => e);
    expect((err as OpenAIWsOpenError).isAuthRejection).toBe(false);
  });

  it('surfaces an in-band error event with its code and message', async () => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverSends({
      type: 'error',
      error: { code: 'invalid_api_key', message: 'Your IP is not authorized' },
    });
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).message).toContain('invalid_api_key');
    expect((err as Error).message).toContain('Your IP is not authorized');
    expect((err as OpenAIWsOpenError).isAuthRejection).toBe(true);
  });

  it('streams captured PCM as base64 session.input_audio_buffer.append frames', async () => {
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();

    // 160 samples @ 16 kHz (10 ms) leave as ~240 samples @ 24 kHz. The very
    // first chunk emits 239: the 240th output sample sits between this chunk's
    // last sample and the next chunk's first, so it is produced at the seam
    // rather than invented. Steady state is 240 per chunk.
    workletPort.onmessage?.({ data: new Float32Array(160).fill(0.25).buffer });
    workletPort.onmessage?.({ data: new Float32Array(160).fill(0.25).buffer });

    const frames = lastSocket!.sent.map((f) => JSON.parse(f) as { type: string; audio: string });
    expect(frames[0]!.type).toBe('session.input_audio_buffer.append');
    expect(atob(frames[0]!.audio)).toHaveLength(239 * 2);
    expect(atob(frames[1]!.audio)).toHaveLength(240 * 2);
  });

  it('reports the first backpressure drop and resumes transport health after sending again', async () => {
    const health = vi.fn();
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: health,
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();
    const push = () => workletPort.onmessage?.({ data: new Float32Array(512).fill(0.1).buffer });
    lastSocket!.bufferedAmount = 2_000_000;
    push();
    expect(health).toHaveBeenCalledWith(
      'degraded',
      expect.stringContaining('audio frames dropped'),
      'transport',
    );
    for (let i = 0; i < 8; i++) push();
    expect(health).toHaveBeenCalledTimes(1);
    expect(lastSocket!.sent).toHaveLength(0);
    lastSocket!.bufferedAmount = 0;
    push();
    expect(lastSocket!.sent).toHaveLength(1);
    expect(health).toHaveBeenLastCalledWith('connected', expect.any(String), 'transport');
    lastSocket!.bufferedAmount = 2_000_000;
    push();
    expect(health).toHaveBeenCalledTimes(3);
    transport.detach();
  });

  it('drops frames instead of growing the send buffer without bound', async () => {
    const trouble: string[] = [];
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {},
      onAudioTrouble: (_s, m) => trouble.push(m),
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();
    lastSocket!.bufferedAmount = 2_000_000;

    for (let i = 0; i < 50; i++) workletPort.onmessage?.({ data: new Float32Array([0.1]).buffer });

    expect(lastSocket!.sent).toHaveLength(0);
    expect(trouble.at(-1)).toContain('audio frames dropped');
  });

  it('detach() silences the close callback so a make-before-break swap is clean', async () => {
    let closedCalls = 0;
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: () => {
        closedCalls += 1;
      },
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;

    transport.activate();
    transport.detach();
    serverCloses(1000, 'replaced');

    expect(closedCalls).toBe(0);
  });

  it('reports a post-setup drop so the provider can rebuild the session', async () => {
    const closed: string[] = [];
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: (r) => closed.push(r),
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'session.created' });
    const transport = await pending;
    transport.activate();

    serverCloses(1006, 'abnormal');

    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain('1006');
  });

  it('rejects — and does NOT report a drop — when the socket dies during setup', async () => {
    // Regression: `settled` was standing in for "the session is live", so a
    // socket that died between session.created and the audio pump coming up
    // both resolved a dead transport AND kicked off the provider's renewal
    // ladder in parallel with the caller's own failure handling.
    const closed: string[] = [];
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: (r) => closed.push(r),
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'session.created' });
    serverCloses(1006, 'gone'); // while startAudioPump() is still pending

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAIWsOpenError);
    expect((err as Error).message).toContain('1006');
    expect(closed).toEqual([]);
  });

  it('does not report a drop for a session that never opened (in-band error)', async () => {
    const closed: string[] = [];
    const pending = OpenAIWsTransport.open('ek', fakeStream(), {
      onEvent: () => {},
      onClosed: (r) => closed.push(r),
      onAudioTrouble: () => {},
    });
    serverSends({ type: 'error', error: { code: 'invalid_api_key', message: 'nope' } });
    await pending.catch(() => {});

    expect(closed).toEqual([]);
  });
});

// ── Resampling to the documented 24 kHz ──────────────────────────────────────
//
// `session.input_audio_buffer.append` is specified as 24 kHz PCM16 mono and the
// rate is not configurable. The shared capture context runs at 16 kHz, and
// falls back to the hardware default (commonly 48 kHz) when a browser refuses
// an explicit rate — so the conversion has to be explicit and rate-driven.

describe('resampleTo24kHz', () => {
  const fresh = () => ({ pos: 0, last: 0 });

  it('passes 24 kHz audio through untouched', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleTo24kHz(input, 24000, fresh())).toBe(input);
  });

  it('upsamples 16 kHz by 1.5x and downsamples 48 kHz by half', () => {
    // 2 x 160 samples @16 kHz = 20 ms = 480 samples @24 kHz. Counted across two
    // chunks because one sample per stream start is deferred to the seam.
    const s16 = fresh();
    const first = resampleTo24kHz(new Float32Array(160), 16000, s16).length;
    const second = resampleTo24kHz(new Float32Array(160), 16000, s16).length;
    expect(first).toBe(239);
    expect(first + second).toBe(479); // 480 minus the one still pending at the seam

    // Downsampling lands on exact integer positions, so no sample is deferred.
    expect(resampleTo24kHz(new Float32Array(480), 48000, fresh())).toHaveLength(240);
  });

  it('interpolates rather than repeating samples', () => {
    // A ramp resampled 16 k -> 24 k must stay a ramp, at 2/3 the step.
    const out = resampleTo24kHz(new Float32Array([0, 3, 6, 9]), 16000, fresh());
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(4, 5);
    expect(out[3]).toBeCloseTo(6, 5);
  });

  it('keeps the seam continuous across chunks instead of clicking every chunk', () => {
    const state = fresh();
    // One continuous ramp, split in two. Resampling chunk-by-chunk must give
    // the same samples as resampling the whole thing at once.
    const whole = new Float32Array(64);
    for (let i = 0; i < whole.length; i++) whole[i] = i;
    const oneShot = Array.from(resampleTo24kHz(whole, 16000, fresh()));

    const a = Array.from(resampleTo24kHz(whole.slice(0, 32), 16000, state));
    const b = Array.from(resampleTo24kHz(whole.slice(32), 16000, state));
    const streamed = [...a, ...b];

    expect(streamed).toHaveLength(oneShot.length);
    for (let i = 0; i < oneShot.length; i++) expect(streamed[i]).toBeCloseTo(oneShot[i]!, 5);
  });

  it('never loses or duplicates time across a long run of chunks', () => {
    const state = fresh();
    let produced = 0;
    for (let i = 0; i < 100; i++)
      produced += resampleTo24kHz(new Float32Array(512), 16000, state).length;
    // 100 chunks x 512 samples @16 kHz = 3.2 s -> 76 800 samples @24 kHz.
    expect(Math.abs(produced - 76_800)).toBeLessThanOrEqual(1);
  });

  it('handles an empty chunk without disturbing the seam state', () => {
    const state = { pos: -0.25, last: 0.5 };
    expect(resampleTo24kHz(new Float32Array(0), 16000, state)).toHaveLength(0);
    expect(state).toEqual({ pos: -0.25, last: 0.5 });
  });
});
