import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionSession, type SessionProvider } from './transcription-session.js';
import type { CaptionProviderHandlers } from './types.js';
import { recoveryHttpError, __resetRecoveryFailuresForTests } from './recovery-attempt.js';
afterEach(() => {
  vi.useRealTimers();
  __resetRecoveryFailuresForTests();
});
function setup(eta: number | null = null, concurrent = false, prepare = async () => {}) {
  const events: unknown[] = [];
  const providers: { p: SessionProvider; h: CaptionProviderHandlers }[] = [];
  const factory = (h: CaptionProviderHandlers) => {
    const p: SessionProvider = {
      status: 'idle',
      start: vi.fn(async () => {
        p.status = 'running';
      }),
      prepare: vi.fn(prepare),
      isPrepared: () => true,
      activate: vi.fn(() => {
        p.status = 'running';
      }),
      stop: vi.fn(async () => {
        p.status = 'stopped';
      }),
      dispose: vi.fn(),
      getRenewalEtaMs: () => eta,
      allowsConcurrentRenewal: () => concurrent,
    };
    providers.push({ p, h });
    return p;
  };
  const s = new TranscriptionSession(
    factory,
    {
      onTranscript: (e) => events.push(e),
      onTranslation: () => {},
      onAudioLevel: () => {},
      onHealth: () => {},
    },
    () => 'openai',
  );
  return { s, providers, events };
}
describe('pure caption session ownership', () => {
  it('isolates microphone failure and Stop from the remote session and its finals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const mic = setup(),
      remote = setup();
    await Promise.all([mic.s.start(), remote.s.start()]);
    mic.providers[0]!.h.onHealth({
      kind: 'health',
      component: 'audio',
      state: 'failed',
      reason: 'track_ended',
      timestamp: new Date().toISOString(),
    });
    expect(mic.s.getSnapshot().phase).toBe('failed');
    expect(remote.s.getSnapshot().phase).toBe('running');
    expect(remote.providers[0]!.p.dispose).not.toHaveBeenCalled();
    await mic.s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mic.providers).toHaveLength(1);
    expect(remote.providers).toHaveLength(1);
    const event = {
      kind: 'transcript' as const,
      provider: 'openai-transcription',
      mode: 'online_full' as const,
      source: 'browser_system' as const,
      segmentId: 'remote-after-local-stop',
      status: 'final' as const,
      text: '遠端仍持續',
      startMs: 1,
    };
    remote.providers[0]!.h.onTranscript(event);
    expect(remote.events).toEqual([event]);
    expect(mic.events).toEqual([]);
    expect(remote.providers[0]!.p.stop).not.toHaveBeenCalled();
    await remote.s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a recovered same-service line when a cancelled renewal candidate becomes ready late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    let ready!: () => void;
    const { s, providers, events } = setup(
      1000,
      true,
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    await s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(providers).toHaveLength(2);
    const candidate = providers[1]!;
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      timestamp: new Date().toISOString(),
    });
    expect(candidate.p.dispose).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(providers).toHaveLength(3);
    expect(s.getSnapshot().phase).toBe('running');
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(candidate.p.activate).not.toHaveBeenCalled();
    expect(providers[2]!.p.stop).not.toHaveBeenCalled();
    const final = {
      kind: 'transcript' as const,
      provider: 'openai-transcription',
      mode: 'online_full' as const,
      source: 'microphone' as const,
      segmentId: 'recovered-line',
      status: 'final' as const,
      text: '原服務已恢復',
      startMs: 1,
    };
    candidate.h.onTranscript({ ...final, segmentId: 'cancelled-candidate' });
    providers[2]!.h.onTranscript(final);
    expect(events).toEqual([final]);
    await s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps synchronous Stop during candidate connected notification in stopping phase without rearming renewal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    let drain!: () => void;
    const draining = new Promise<void>((resolve) => {
      drain = resolve;
    });
    let stopped: Promise<void> | undefined;
    const session = new TranscriptionSession(
      (handlers) => {
        const provider: SessionProvider = {
          status: 'idle',
          start: async () => {
            provider.status = 'running';
          },
          prepare: async () => {},
          isPrepared: () => true,
          activate: () => {
            provider.status = 'running';
            handlers.onHealth({
              kind: 'health',
              component: 'transport',
              state: 'connected',
              timestamp: new Date().toISOString(),
            });
          },
          stop: () => draining,
          dispose: () => {
            provider.status = 'stopped';
          },
          getRenewalEtaMs: () => 1000,
          allowsConcurrentRenewal: () => true,
        };
        return provider;
      },
      {
        onTranscript: () => {},
        onTranslation: () => {},
        onAudioLevel: () => {},
        onHealth: (event) => {
          if (event.state === 'connected') stopped = session.stop();
        },
      },
    );
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBeDefined();
    expect(session.getSnapshot().phase).toBe('stopping');
    expect(vi.getTimerCount()).toBe(0);
    drain();
    await stopped;
    expect(session.getSnapshot().phase).toBe('stopped');
  });
  it.each(['running', 'failed', 'reconnected'])(
    'accepts retiring finals while new line is %s but rejects stale partials',
    async (state) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const { s, providers, events } = setup(1000, true);
      await s.start();
      let drained!: () => void;
      providers[0]!.p.stop = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            drained = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      const event = {
        kind: 'transcript' as const,
        provider: 'openai-transcription',
        mode: 'online_full' as const,
        source: 'microphone' as const,
        segmentId: 'old-turn',
        status: 'final' as const,
        text: '不能付款',
        startMs: 1,
      };
      providers[0]!.h.onTranscript({ ...event, status: 'partial' });
      providers[1]!.h.onTranscript({
        ...event,
        segmentId: 'new-turn',
        status: 'partial',
        text: '下一項',
      });
      if (state !== 'running') {
        providers[1]!.h.onHealth({
          kind: 'health',
          component: 'transport',
          state: 'failed',
          timestamp: new Date().toISOString(),
        });
        if (state === 'reconnected') await vi.advanceTimersByTimeAsync(2000);
      }
      providers[0]!.h.onTranscript(event);
      expect(events).toEqual([
        { ...event, segmentId: 'new-turn', status: 'partial', text: '下一項' },
        event,
      ]);
      drained();
      await vi.advanceTimersByTimeAsync(0);
      providers[0]!.h.onTranscript({ ...event, segmentId: 'stale' });
      expect(events).toHaveLength(2);
      await s.stop();
    },
  );
  it('keeps the incumbent sending until a qualified renewal candidate is prepared', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const order: string[] = [];
    let ready!: () => void;
    const providers: SessionProvider[] = [];
    const session = new TranscriptionSession(
      () => {
        const index = providers.length;
        const provider: SessionProvider = {
          status: 'idle',
          start: vi.fn(async () => {
            provider.status = 'running';
          }),
          prepare: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                ready = resolve;
              }),
          ),
          isPrepared: () => true,
          activate: vi.fn(() => {
            order.push('activate');
            provider.status = 'running';
          }),
          stop: vi.fn(async () => {
            order.push(`stop:${index}`);
            provider.status = 'stopped';
          }),
          dispose: vi.fn(),
          getRenewalEtaMs: () => 1000,
          allowsConcurrentRenewal: () => true,
        };
        providers.push(provider);
        return provider;
      },
      {
        onTranscript: () => {},
        onTranslation: () => {},
        onHealth: (event) => {
          if (event.state === 'reconnecting') order.push('gap');
        },
        onAudioLevel: () => {},
      },
      () => 'openai',
    );
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(providers).toHaveLength(2);
    expect(providers[0]!.stop).not.toHaveBeenCalled();
    expect(providers[0]!.status).toBe('running');
    expect(providers[1]!.activate).not.toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(order.slice(0, 3)).toEqual(['stop:0', 'gap', 'activate']);
    expect(session.getSnapshot().phase).toBe('running');
    await session.stop();
  });

  it.each(['refused', 'lost-readiness'])(
    'a %s renewal candidate does not dispose the healthy incumbent',
    async (failure) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const providers: SessionProvider[] = [];
      const session = new TranscriptionSession(
        () => {
          const provider: SessionProvider = {
            status: 'idle',
            start: vi.fn(async () => {
              provider.status = 'running';
            }),
            prepare: vi.fn(async () => {
              if (failure === 'refused') throw new Error('candidate refused');
            }),
            isPrepared: () => false,
            activate: vi.fn(),
            stop: vi.fn(async () => {
              provider.status = 'stopped';
            }),
            dispose: vi.fn(),
            getRenewalEtaMs: () => 1000,
            allowsConcurrentRenewal: () => true,
          };
          providers.push(provider);
          return provider;
        },
        {
          onTranscript: () => {},
          onTranslation: () => {},
          onHealth: () => {},
          onAudioLevel: () => {},
        },
        () => 'gemini',
      );
      await session.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(providers).toHaveLength(2);
      expect(providers[0]!.stop).not.toHaveBeenCalled();
      expect(providers[0]!.dispose).not.toHaveBeenCalled();
      expect(providers[1]!.dispose).toHaveBeenCalledOnce();
      expect(session.getSnapshot().phase).toBe('running');
      await session.stop();
    },
  );

  it('Stop cancels both incumbent and pending candidate and rejects late readiness', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    let ready!: () => void;
    const providers: SessionProvider[] = [];
    const session = new TranscriptionSession(
      () => {
        const provider: SessionProvider = {
          status: 'idle',
          start: vi.fn(async () => {
            provider.status = 'running';
          }),
          prepare: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                ready = resolve;
              }),
          ),
          isPrepared: () => true,
          activate: vi.fn(),
          stop: vi.fn(async () => {
            provider.status = 'stopped';
          }),
          dispose: vi.fn(),
          getRenewalEtaMs: () => 1000,
          allowsConcurrentRenewal: () => true,
        };
        providers.push(provider);
        return provider;
      },
      {
        onTranscript: () => {},
        onTranslation: () => {},
        onHealth: () => {},
        onAudioLevel: () => {},
      },
      () => 'openai',
    );
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    await session.stop();
    expect(providers[1]!.dispose).toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(10000);
    expect(providers[1]!.activate).not.toHaveBeenCalled();
    expect(providers).toHaveLength(2);
    expect(session.getSnapshot().phase).toBe('stopped');
  });
  it('stops automatic retries for auth but admits an explicit manual retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const { s, providers } = setup();
    await s.start();
    const error = recoveryHttpError(new Response(null, { status: 401 }), 'openai', 'transcription');
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      timestamp: new Date().toISOString(),
      recoveryFailure: error.failure,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(providers).toHaveLength(1);
    expect(s.getSnapshot().phase).toBe('failed');
    await s.start();
    expect(providers).toHaveLength(2);
    await s.stop();
  });
  it('keeps a Retry-After deadline across explicit Stop/Start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const { s, providers } = setup();
    await s.start();
    const error = recoveryHttpError(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
      'openai',
      'transcription',
    );
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      timestamp: new Date().toISOString(),
      recoveryFailure: error.failure,
    });
    await s.stop();
    await s.start();
    await vi.advanceTimersByTimeAsync(59999);
    expect(providers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(providers).toHaveLength(2);
    await s.stop();
  });
  it('cancels a pending new provider immediately when Stop arrives during renewal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const providers: SessionProvider[] = [];
    let finish!: () => void;
    const session = new TranscriptionSession(
      () => {
        const index = providers.length;
        const p: SessionProvider = {
          status: 'idle',
          start: vi.fn(async () => {
            if (index)
              await new Promise<void>((r) => {
                finish = r;
              });
            p.status = 'running';
          }),
          stop: vi.fn(async () => {
            p.status = 'stopped';
          }),
          dispose: vi.fn(),
          getRenewalEtaMs: () => 1000,
        };
        providers.push(p);
        return p;
      },
      {
        onTranscript: () => {},
        onTranslation: () => {},
        onHealth: () => {},
        onAudioLevel: () => {},
      },
    );
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(providers).toHaveLength(2);
    const stopped = session.stop();
    await Promise.resolve();
    expect(providers[1]!.stop).toHaveBeenCalledOnce();
    finish();
    await stopped;
    expect(session.getSnapshot().phase).toBe('stopped');
  });
  it('drains and renews the same transcription service, with an explicit interruption', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const { s, providers } = setup(1000);
    await s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(providers[0]!.p.stop).toHaveBeenCalledOnce();
    expect(providers).toHaveLength(2);
    await s.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(providers).toHaveLength(2);
  });
  it('retries only the same transcription factory and Stop cancels future attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const { s, providers } = setup();
    await s.start();
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      message: 'network',
      timestamp: new Date().toISOString(),
    });
    expect(s.getSnapshot().phase).toBe('recovering');
    await vi.advanceTimersByTimeAsync(2000);
    expect(providers).toHaveLength(2);
    await s.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(providers).toHaveLength(2);
    expect(s.getSnapshot().phase).toBe('stopped');
  });
  it('retains tail transcripts while stopping but ignores callbacks after disposal', async () => {
    const { s, providers, events } = setup();
    await s.start();
    let finish!: () => void;
    providers[0]!.p.stop = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const stopping = s.stop();
    const e = {
      kind: 'transcript' as const,
      provider: 'openai-transcription',
      mode: 'online_full' as const,
      source: 'microphone' as const,
      segmentId: 'tail',
      status: 'final' as const,
      text: '不能付款',
      startMs: 1,
    };
    providers[0]!.h.onTranscript(e);
    expect(events).toHaveLength(1);
    finish();
    await stopping;
    providers[0]!.h.onTranscript(e);
    expect(events).toHaveLength(1);
  });
  it('does not auto-reopen a microphone after permission/audio failure', async () => {
    vi.useFakeTimers();
    const { s, providers } = setup();
    await s.start();
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'audio',
      state: 'failed',
      message: 'permission denied',
      timestamp: new Date().toISOString(),
    });
    providers[0]!.h.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      message: 'capture ended',
      timestamp: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(providers).toHaveLength(1);
    expect(s.getSnapshot().phase).toBe('failed');
    await s.stop();
  });
});
