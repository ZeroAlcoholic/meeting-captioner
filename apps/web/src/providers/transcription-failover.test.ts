import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionSession, type SessionProvider } from './transcription-session.js';
import type { CaptionProviderHandlers } from './types.js';
import type { OnlineBackend } from './failover.js';
import { __resetRecoveryFailuresForTests, recoveryHttpError } from './recovery-attempt.js';

afterEach(() => {
  vi.useRealTimers();
  __resetRecoveryFailuresForTests();
});

function fixture(
  preferred: OnlineBackend,
  available = { openai: true, gemini: true },
  starting = async (_backend: OnlineBackend) => {},
  preparing = async (_backend: OnlineBackend) => {},
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const attempts: OnlineBackend[] = [];
  const owners: {
    backend: OnlineBackend;
    handlers: CaptionProviderHandlers;
    provider: SessionProvider;
  }[] = [];
  const transcripts: unknown[] = [];
  const session = new TranscriptionSession(
    (handlers, target = preferred) => {
      attempts.push(target);
      const provider: SessionProvider = {
        status: 'idle',
        start: async () => {
          await starting(target);
          provider.status = 'running';
        },
        stop: vi.fn(async () => {
          provider.status = 'stopped';
        }),
        prepare: async () => preparing(target),
        isPrepared: () => true,
        activate: () => {
          provider.status = 'running';
        },
        dispose: vi.fn(() => {
          provider.status = 'stopped';
        }),
        getRenewalEtaMs: () => null,
      };
      owners.push({ backend: target, handlers, provider });
      return provider;
    },
    {
      onTranscript: (event) => transcripts.push(event),
      onTranslation: () => {},
      onHealth: () => {},
      onAudioLevel: () => {},
    },
    () => preferred,
    () => available,
  );
  const fail = (status?: number) => {
    const owner = owners.at(-1)!;
    const failure =
      status === undefined
        ? undefined
        : recoveryHttpError(
            new Response('', { status, headers: status === 429 ? { 'Retry-After': '60' } : {} }),
            owner.backend,
            'transcription',
          ).failure;
    owner.handlers.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'failed',
      timestamp: new Date().toISOString(),
      recoveryFailure: failure,
    });
  };
  return { session, attempts, owners, transcripts, fail, available };
}

describe('pure transcription cross-provider recovery', () => {
  it('retries after a contentless standby renewal fails during activation', async () => {
    const f = fixture(
      'openai',
      { openai: true, gemini: true },
      async (backend) => {
        if (backend === 'gemini' && f.owners.length === 2) {
          const standby = f.owners[1]!.provider;
          standby.getRenewalEtaMs = () => 1000;
          standby.allowsConcurrentRenewal = () => true;
        }
      },
      async () => {
        f.owners.at(-1)!.provider.activate = () => {
          throw new Error('controlled activation failure');
        };
      },
    );
    await f.session.start();
    f.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.owners[2]!.provider.dispose).toHaveBeenCalled();
    expect(f.session.getSnapshot().phase).toBe('recovering');
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.attempts).toEqual(['openai', 'gemini', 'gemini']);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts).toEqual(['openai', 'gemini', 'gemini', 'openai']);
    await f.session.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['openai', 'gemini'] as const)(
    'automatic source recovery keeps the current service; manual retry returns to preferred %s',
    async (preferred) => {
      const f = fixture(preferred);
      const alternate = preferred === 'openai' ? 'gemini' : 'openai';
      await f.session.start();
      f.fail(401);
      await vi.advanceTimersByTimeAsync(2000);
      await f.session.start(false);
      expect(f.attempts).toEqual([preferred, alternate, alternate]);
      await f.session.start();
      expect(f.attempts).toEqual([preferred, alternate, alternate, preferred]);
      expect(f.session.getSnapshot().backend).toBe(preferred);
      await f.session.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([false, true])(
    'does not call a contentless standby recovered after renewal (concurrent=%s)',
    async (concurrent) => {
      const f = fixture('openai', { openai: true, gemini: true }, async (backend) => {
        if (backend === 'gemini' && f.owners.length === 2) {
          const standby = f.owners[1]!.provider;
          standby.getRenewalEtaMs = () => 1000;
          standby.allowsConcurrentRenewal = () => concurrent;
        }
      });
      await f.session.start();
      f.fail();
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.getSnapshot().phase).toBe('recovering');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.attempts).toEqual(['openai', 'gemini', 'gemini']);
      expect(f.session.getSnapshot().phase).toBe('recovering');
      f.owners[2]!.handlers.onTranscript({
        kind: 'transcript',
        provider: 'gemini-transcription',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'first-effective',
        status: 'partial',
        text: '有效文字',
        startMs: 1,
      });
      expect(f.session.getSnapshot().phase).toBe('running');
      await f.session.stop();
    },
  );
  it('continues bounded recovery when the alternate start rejects before producing content', async () => {
    const f = fixture('openai', { openai: true, gemini: true }, async (backend) => {
      if (backend === 'gemini') throw new Error('controlled start rejection');
    });
    await f.session.start();
    f.fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.attempts).toEqual(['openai', 'gemini', 'openai']);
    await f.session.stop();
  });
  it.each(['openai', 'gemini'] as const)(
    'recovers %s on the other transcription service without changing transcript identity',
    async (preferred) => {
      const f = fixture(preferred);
      const alternate = preferred === 'openai' ? 'gemini' : 'openai';
      await f.session.start();
      f.fail();
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.attempts).toEqual([preferred, alternate]);
      expect(f.session.getSnapshot()).toMatchObject({ phase: 'recovering', backend: alternate });
      const event = {
        kind: 'transcript' as const,
        provider: `${alternate}-transcription`,
        mode: 'online_full' as const,
        source: 'microphone' as const,
        segmentId: 'same-meeting-new-turn',
        status: 'final' as const,
        text: '備援後原文',
        startMs: 10,
      };
      f.owners[0]!.handlers.onTranscript({ ...event, segmentId: 'stale-old-line' });
      f.owners[1]!.handlers.onTranscript(event);
      expect(f.transcripts).toEqual([event]);
      expect(f.session.getSnapshot().phase).toBe('running');
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.attempts).toHaveLength(2);
      await f.session.stop();
    },
  );

  it.each([401, 429])(
    'uses the alternate when the selected service reports HTTP %s',
    async (status) => {
      const f = fixture('openai');
      await f.session.start();
      f.fail(status);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.attempts).toEqual(['openai', 'gemini']);
      await f.session.stop();
      await vi.advanceTimersByTimeAsync(90000);
      expect(f.attempts).toHaveLength(2);
    },
  );

  it('stops automatic attempts when both services permanently refuse', async () => {
    const f = fixture('gemini');
    await f.session.start();
    f.fail(401);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['gemini', 'openai']);
    f.fail(401);
    await vi.advanceTimersByTimeAsync(180000);
    expect(f.attempts).toHaveLength(2);
    expect(f.session.getSnapshot().phase).toBe('failed');
    await f.session.stop();
  });

  it('keeps same-service recovery when the alternate is not configured', async () => {
    const f = fixture('openai', { openai: true, gemini: false });
    await f.session.start();
    f.fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai', 'openai']);
    await f.session.stop();
  });

  it('respects both cooldowns across Stop/Start and selects the earliest legal service', async () => {
    const f = fixture('openai');
    await f.session.start();
    recoveryHttpError(
      new Response('', { status: 429, headers: { 'Retry-After': '10' } }),
      'gemini',
      'transcription',
    );
    f.fail(429);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai']);
    await f.session.stop();
    await f.session.start();
    await vi.advanceTimersByTimeAsync(7999);
    expect(f.attempts).toEqual(['openai']);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    await f.session.stop();
  });

  it('does not carry translation refusal into transcription recovery', async () => {
    const f = fixture('openai');
    recoveryHttpError(new Response('', { status: 403 }), 'gemini', 'translation');
    await f.session.start();
    f.fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    await f.session.stop();
  });

  it('reconsiders new capability but never restarts healthy or stopped capture', async () => {
    const f = fixture('openai', { openai: true, gemini: false });
    await f.session.start();
    f.fail(401);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.attempts).toHaveLength(1);
    f.available.gemini = true;
    f.session.refreshAvailability();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    f.available.gemini = false;
    f.session.refreshAvailability();
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.attempts).toHaveLength(2);
    await f.session.stop();
    f.available.gemini = true;
    f.session.refreshAvailability();
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Stop rejects late cross-provider start, health and transcript callbacks', async () => {
    let ready!: () => void;
    const f = fixture('openai', { openai: true, gemini: true }, (backend) =>
      backend === 'gemini'
        ? new Promise<void>((resolve) => {
            ready = resolve;
          })
        : Promise.resolve(),
    );
    await f.session.start();
    f.fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toEqual(['openai', 'gemini']);
    await f.session.stop();
    ready();
    const late = f.owners[1]!;
    late.handlers.onHealth({
      kind: 'health',
      component: 'transport',
      state: 'connected',
      timestamp: new Date().toISOString(),
    });
    late.handlers.onTranscript({
      kind: 'transcript',
      provider: 'gemini-transcription',
      mode: 'online_full',
      source: 'microphone',
      segmentId: 'cancelled',
      status: 'final',
      text: '不得復活',
      startMs: 1,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.session.getSnapshot().phase).toBe('stopped');
    expect(f.transcripts).toEqual([]);
    expect(f.attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
