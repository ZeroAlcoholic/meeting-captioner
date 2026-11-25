import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent } from '@meeting-audio/contracts';
import { createCaptureAudioRetention } from './capture-audio-retention.js';
vi.mock('./capture-audio-retention.js', async () => {
  const { MeetingAudioBuffer } = await import('./meeting-audio-buffer.js');
  return {
    createCaptureAudioRetention: vi.fn(
      async (_stream: MediaStream, _track: string, signal: AbortSignal) => {
        const buffer = new MeetingAudioBuffer(8);
        const dispose = () => buffer.clear();
        signal.addEventListener('abort', dispose, { once: true });
        return { buffer, dispose };
      },
    ),
  };
});
import {
  armCaptureHandoff,
  leaseCapture,
  retainedCaptureRange,
  retainCaptureForRecovery,
  releaseCaptureRecovery,
  __resetCaptureLeaseForTests,
  createCaptureLeaseOwner,
} from './capture-lease.js';

/**
 * The lease exists so a cross-model handoff does not re-open the capture
 * device mid-meeting. The tension it has to hold: reuse across a handoff, but
 * never at the cost of a microphone that outlives Stop.
 */

let getUserMediaCalls = 0;
let getDisplayMediaCalls = 0;
let stoppedTracks = 0;

function fakeStream(): MediaStream {
  const listeners = new Set<() => void>();
  const track = {
    kind: 'audio',
    getSettings: () => ({ deviceId: 'usb-original' }),
    readyState: 'live',
    stop: () => {
      stoppedTracks += 1;
      track.readyState = 'ended';
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'ended') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'ended') listeners.delete(listener);
    },
    dispatchEvent: () => {
      track.readyState = 'ended';
      for (const listener of listeners) listener();
      return true;
    },
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

const noHealth = (): void => {};

describe('independent meeting track capture owners', () => {
  it('keeps mic and remote recovery/Stop independent while reusing each track', async () => {
    const mic = createCaptureLeaseOwner();
    const remote = createCaptureLeaseOwner();
    try {
      mic.retainCaptureForRecovery(noHealth);
      remote.retainCaptureForRecovery(noHealth);
      const localLease = mic.leaseCapture({ kind: 'mic', micDistance: 'off' });
      const remoteLease = remote.leaseCapture({ kind: 'system', micDistance: 'off' });
      const localStream = await localLease.acquire(noHealth);
      const remoteStream = await remoteLease.acquire(noHealth);
      localLease.release();
      remoteLease.release();
      expect(stoppedTracks).toBe(0);
      mic.releaseCaptureRecovery();
      expect(localStream.getAudioTracks()[0]!.readyState).toBe('ended');
      expect(remoteStream.getAudioTracks()[0]!.readyState).toBe('live');
      const replacement = remote.leaseCapture({ kind: 'system', micDistance: 'off' });
      expect(await replacement.acquire(noHealth)).toBe(remoteStream);
      expect(getUserMediaCalls).toBe(1);
      expect(getDisplayMediaCalls).toBe(1);
      remote.releaseCaptureRecovery();
      replacement.release();
      expect(remoteStream.getAudioTracks()[0]!.readyState).toBe('ended');
      expect(stoppedTracks).toBe(2);
    } finally {
      mic.__resetCaptureLeaseForTests();
      remote.__resetCaptureLeaseForTests();
    }
  });

  it('a rejected remote picker does not release the microphone', async () => {
    const mic = createCaptureLeaseOwner();
    const remote = createCaptureLeaseOwner();
    try {
      const localLease = mic.leaseCapture({ kind: 'mic', micDistance: 'off' });
      const stream = await localLease.acquire(noHealth);
      vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockRejectedValue(
        new DOMException('cancelled', 'NotAllowedError'),
      );
      await expect(
        remote.leaseCapture({ kind: 'system', micDistance: 'off' }).acquire(noHealth),
      ).rejects.toThrow();
      expect(stream.getAudioTracks()[0]!.readyState).toBe('live');
      expect(stoppedTracks).toBe(0);
      localLease.release();
      expect(stoppedTracks).toBe(1);
    } finally {
      mic.__resetCaptureLeaseForTests();
      remote.__resetCaptureLeaseForTests();
    }
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  getUserMediaCalls = 0;
  getDisplayMediaCalls = 0;
  stoppedTracks = 0;
  __resetCaptureLeaseForTests();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        getUserMediaCalls += 1;
        return Promise.resolve(fakeStream());
      },
      getDisplayMedia: () => {
        getDisplayMediaCalls += 1;
        return Promise.resolve(fakeStream());
      },
    },
  });
  // Minimal AudioContext — the sources build an analyser graph on acquire, and
  // none of that is what this module is about.
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createAnalyser() {
        return { fftSize: 2048, connect() {}, disconnect() {} };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal('document', {
    addEventListener: () => {},
    removeEventListener: () => {},
    hidden: false,
  });
});

afterEach(() => {
  __resetCaptureLeaseForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const MIC = { kind: 'mic', micDistance: 'meeting' } as const;

describe('capture lease', () => {
  it('reports parked overflow while recovery waits, bounds updates, and flushes the last range', async () => {
    const health = vi.fn();
    retainCaptureForRecovery(health);
    const lease = leaseCapture(MIC);
    await lease.acquire(noHealth);
    const retention = await vi.mocked(createCaptureAudioRetention).mock.results[0]!.value;
    const notify = vi.mocked(createCaptureAudioRetention).mock.calls[0]![3];
    const append = (startSample: number, length = 12) => {
      retention.buffer.append({
        trackId: 'mic',
        captureEpoch: 'test',
        startSample,
        sampleRate: 16000,
        pcm: new Float32Array(length),
      });
      notify?.();
    };
    append(0);
    expect(health).not.toHaveBeenCalled();
    lease.release();
    append(12);
    expect(health).toHaveBeenCalledTimes(1);
    append(24);
    expect(health).toHaveBeenCalledTimes(1);
    append(36, 16000);
    expect(health).toHaveBeenCalledTimes(2);
    append(16036);
    expect(health).toHaveBeenCalledTimes(2);
    releaseCaptureRecovery();
    expect(health).toHaveBeenCalledTimes(3);
    const gaps = health.mock.calls.map(([event]) => event.retentionGap);
    expect(gaps.map((gap) => [gap.from, gap.to])).toEqual([
      [12, 16],
      [12, 16028],
      [12, 16040],
    ]);
    expect(new Set(gaps.map((gap) => gap.gapId)).size).toBe(1);
    releaseCaptureRecovery();
    expect(health).toHaveBeenCalledTimes(3);
  });
  it.each(['reclaim', 'stop'] as const)(
    'reports overwritten unowned PCM once on %s',
    async (action) => {
      const health = vi.fn();
      retainCaptureForRecovery(health);
      const first = leaseCapture(MIC);
      await first.acquire(noHealth);
      const retained = await vi.mocked(createCaptureAudioRetention).mock.results[0]!.value;
      const append = (startSample: number) =>
        retained.buffer.append({
          trackId: 'mic',
          captureEpoch: 'test',
          startSample,
          sampleRate: 16000,
          pcm: new Float32Array(12),
        });
      append(0); // Normal eviction while a provider holds capture is not a loss claim.
      await first.acquire(noHealth);
      expect(health).not.toHaveBeenCalled();
      first.release();
      append(12);
      const next = leaseCapture(MIC);
      if (action === 'reclaim') await next.acquire(noHealth);
      else releaseCaptureRecovery();
      expect(health).toHaveBeenCalledTimes(1);
      expect(health.mock.calls[0]![0]).toMatchObject({
        retentionGap: { trackId: 'mic', captureEpoch: 'test', from: 12, to: 16, sampleRate: 16000 },
      });
      await next.acquire(noHealth);
      expect(health).toHaveBeenCalledTimes(1);
      releaseCaptureRecovery();
      next.release();
    },
  );
  it('keeps one audio retention owner across parked recovery and clears it on Stop', async () => {
    retainCaptureForRecovery(noHealth);
    const first = leaseCapture(MIC);
    const stream = await first.acquire(noHealth);
    expect(createCaptureAudioRetention).toHaveBeenCalledTimes(1);
    const retained = await vi.mocked(createCaptureAudioRetention).mock.results[0]!.value;
    retained.buffer.append({
      trackId: 'mic',
      captureEpoch: 'test',
      startSample: 0,
      sampleRate: 16000,
      pcm: new Float32Array([1, 2]),
    });
    first.release();
    expect(stoppedTracks).toBe(0);
    expect(retained.buffer.retainedRange?.to).toBe(2);
    const next = leaseCapture(MIC);
    expect(await next.acquire(noHealth)).toBe(stream);
    expect(createCaptureAudioRetention).toHaveBeenCalledTimes(1);
    releaseCaptureRecovery();
    next.release();
    expect(retained.buffer.retainedRange).toBeNull();
    expect(stoppedTracks).toBe(1);
  });
  it('waits for another devicechange if the original mic vanishes between enumeration and acquire', async () => {
    const devices = new EventTarget();
    Object.assign(navigator.mediaDevices, {
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb-original' }]),
    });
    Object.assign(navigator, {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    const resume = vi.fn();
    retainCaptureForRecovery(noHealth, resume);
    const lease = leaseCapture(MIC);
    const stream = await lease.acquire(noHealth);
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    lease.release();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException('removed again', 'NotFoundError'));
    const next = leaseCapture(MIC);
    await expect(next.acquire(noHealth)).rejects.toThrow('removed again');
    expect(resume).toHaveBeenCalledTimes(1);
    devices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    releaseCaptureRecovery();
    next.release();
  });
  it.each(['', 'default', 'communications'])(
    'does not automatically recover unidentified mic %s',
    async (deviceId) => {
      const devices = new EventTarget();
      const query = vi.fn().mockResolvedValue({ state: 'granted' });
      Object.assign(navigator.mediaDevices, {
        addEventListener: devices.addEventListener.bind(devices),
        removeEventListener: devices.removeEventListener.bind(devices),
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId }]),
      });
      Object.assign(navigator, { permissions: { query } });
      const stream = fakeStream();
      stream.getAudioTracks()[0]!.getSettings = () => ({ deviceId });
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(stream);
      const resume = vi.fn();
      retainCaptureForRecovery(noHealth, resume);
      const lease = leaseCapture(MIC);
      await lease.acquire(noHealth);
      stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
      devices.dispatchEvent(new Event('devicechange'));
      await Promise.resolve();
      expect(query).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      releaseCaptureRecovery();
      lease.release();
    },
  );

  it.each(['prompt', 'denied'])(
    'revokes automatic recovery when permission is %s',
    async (state) => {
      const devices = new EventTarget();
      const query = vi.fn().mockResolvedValue({ state });
      Object.assign(navigator.mediaDevices, {
        addEventListener: devices.addEventListener.bind(devices),
        removeEventListener: devices.removeEventListener.bind(devices),
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb-original' }]),
      });
      Object.assign(navigator, { permissions: { query } });
      const resume = vi.fn();
      retainCaptureForRecovery(noHealth, resume);
      const lease = leaseCapture(MIC);
      const stream = await lease.acquire(noHealth);
      stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      query.mockResolvedValue({ state: 'granted' });
      devices.dispatchEvent(new Event('devicechange'));
      await Promise.resolve();
      expect(resume).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      releaseCaptureRecovery();
      lease.release();
    },
  );

  it('retains successful device identity when ended clears settings and devicechange came first', async () => {
    const devices = new EventTarget();
    Object.assign(navigator.mediaDevices, {
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb-original' }]),
    });
    Object.assign(navigator, {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    const resume = vi.fn();
    retainCaptureForRecovery(noHealth, resume);
    const lease = leaseCapture(MIC);
    const stream = await lease.acquire(noHealth);
    devices.dispatchEvent(new Event('devicechange'));
    stream.getAudioTracks()[0]!.getSettings = () => ({});
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    releaseCaptureRecovery();
    lease.release();
  });

  it('a cancelled old permission rejection cannot revoke a new meeting recovery', async () => {
    const devices = new EventTarget();
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    Object.assign(navigator.mediaDevices, {
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
      enumerateDevices,
    });
    Object.assign(navigator, {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    let reject!: (error: Error) => void;
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_ok, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(fakeStream());
    retainCaptureForRecovery(noHealth, vi.fn());
    const old = leaseCapture(MIC);
    const pending = old.acquire(noHealth);
    const rejected = expect(pending).rejects.toThrow();
    releaseCaptureRecovery();
    old.release();
    const resume = vi.fn();
    retainCaptureForRecovery(noHealth, resume);
    const next = leaseCapture(MIC);
    const stream = await next.acquire(noHealth);
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    reject(new DOMException('old rejected', 'NotAllowedError'));
    await rejected;
    enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb-original' }]);
    devices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    releaseCaptureRecovery();
    next.release();
  });
  it('recovers only the original concrete mic after devicechange with retained permission', async () => {
    const devices = new EventTarget();
    const enumerateDevices = vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'other' }]);
    Object.assign(navigator.mediaDevices, {
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
      enumerateDevices,
    });
    Object.assign(navigator, {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    const resume = vi.fn();
    retainCaptureForRecovery(noHealth, resume);
    const lease = leaseCapture(MIC);
    const stream = await lease.acquire(noHealth);
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    lease.release();
    devices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    expect(resume).not.toHaveBeenCalled();
    enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb-original' }]);
    devices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    devices.dispatchEvent(new Event('devicechange'));
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const next = leaseCapture(MIC);
    await next.acquire(noHealth);
    expect(getUserMedia.mock.calls[0]?.[0]?.audio).toMatchObject({
      deviceId: { exact: 'usb-original' },
    });
    releaseCaptureRecovery();
    next.release();
  });

  it('Stop revokes devicechange recovery even while enumeration is pending', async () => {
    const devices = new EventTarget();
    let resolve!: (value: unknown[]) => void;
    const enumerateDevices = vi.fn(
      () =>
        new Promise<unknown[]>((done) => {
          resolve = done;
        }),
    );
    Object.assign(navigator.mediaDevices, {
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
      enumerateDevices,
    });
    Object.assign(navigator, {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    const resume = vi.fn();
    retainCaptureForRecovery(noHealth, resume);
    const lease = leaseCapture(MIC);
    const stream = await lease.acquire(noHealth);
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    lease.release();
    devices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    releaseCaptureRecovery();
    resolve([{ kind: 'audioinput', deviceId: 'usb-original' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled();
  });
  it('never reuses a different selected microphone during handoff', async () => {
    const first = leaseCapture({ ...MIC, deviceId: 'first-mic' });
    const second = leaseCapture({ ...MIC, deviceId: 'second-mic' });
    await first.acquire(noHealth);
    armCaptureHandoff();
    first.release();
    await second.acquire(noHealth);
    expect(getUserMediaCalls).toBe(2);
    second.release();
  });
  it('cancelled permission cannot replace a newer different-source capture', async () => {
    let resolve!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise<MediaStream>((done) => {
        resolve = done;
      });
    const old = leaseCapture(MIC);
    const health = vi.fn();
    const pending = old.acquire(health);
    old.release();
    health.mockClear();
    const current = leaseCapture({ kind: 'system', micDistance: 'meeting' });
    const stream = await current.acquire(noHealth);
    const late = fakeStream();
    resolve(late);
    await expect(pending).rejects.toThrow();
    expect(late.getAudioTracks()[0]!.readyState).toBe('ended');
    expect(health).not.toHaveBeenCalled();
    const next = leaseCapture({ kind: 'system', micDistance: 'meeting' });
    expect(await next.acquire(noHealth)).toBe(stream);
    expect(getDisplayMediaCalls).toBe(1);
    next.release();
    expect(stream.getAudioTracks()[0]!.readyState).toBe('live');
    current.release();
    expect(stream.getAudioTracks()[0]!.readyState).toBe('ended');
  });

  it('cancelling one pending claimant leaves the other owner intact', async () => {
    let resolve!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise<MediaStream>((done) => {
        resolve = done;
      });
    const a = leaseCapture(MIC),
      b = leaseCapture(MIC);
    const first = a.acquire(noHealth),
      second = b.acquire(noHealth);
    a.release();
    const stream = fakeStream();
    resolve(stream);
    await expect(first).rejects.toThrow();
    expect(await second).toBe(stream);
    expect(stream.getAudioTracks()[0]!.readyState).toBe('live');
    b.release();
    expect(stream.getAudioTracks()[0]!.readyState).toBe('ended');
  });
  it('a handoff reuses the running capture — no second device open', async () => {
    const outgoing = leaseCapture(MIC);
    const first = await outgoing.acquire(noHealth);
    expect(getUserMediaCalls).toBe(1);

    armCaptureHandoff();
    outgoing.release();
    expect(stoppedTracks).toBe(0);

    const incoming = leaseCapture(MIC);
    const second = await incoming.acquire(noHealth);

    expect(getUserMediaCalls).toBe(1);
    expect(second).toBe(first);
  });

  it('the reuse path never claims a permission prompt happened', async () => {
    const outgoing = leaseCapture(MIC);
    await outgoing.acquire(noHealth);
    armCaptureHandoff();
    outgoing.release();

    const events: HealthEvent[] = [];
    const incoming = leaseCapture(MIC);
    await incoming.acquire((e) => events.push(e));

    // 'requesting_permission' would be a lie — nothing was requested — and the
    // operator would see a permission state flash mid-meeting for no reason.
    expect(events.map((e) => e.state)).toEqual(['connected']);
  });

  it('a plain release stops the tracks immediately', async () => {
    const lease = leaseCapture(MIC);
    await lease.acquire(noHealth);

    lease.release();

    // Stop has to mean the OS microphone indicator goes out now. Parking the
    // capture "just in case" would keep it live for seconds after the user
    // pressed Stop.
    expect(stoppedTracks).toBe(1);
  });

  it('an armed handoff that never completes releases the capture on its own', async () => {
    vi.useFakeTimers();
    const outgoing = leaseCapture(MIC);
    await outgoing.acquire(noHealth);

    armCaptureHandoff();
    outgoing.release();
    expect(stoppedTracks).toBe(0);

    // The incoming backend failed to start. The window closes and the
    // microphone is released rather than left open indefinitely.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stoppedTracks).toBe(1);
  });

  it('a different capture spec is not reused', async () => {
    const outgoing = leaseCapture(MIC);
    await outgoing.acquire(noHealth);
    armCaptureHandoff();
    outgoing.release();

    // System audio is a different device entirely; handing back the microphone
    // would caption the wrong source.
    const incoming = leaseCapture({ kind: 'system', micDistance: 'off' });
    await incoming.acquire(noHealth);

    expect(getDisplayMediaCalls).toBe(1);
    // …and the parked microphone was let go rather than left open alongside it.
    expect(stoppedTracks).toBe(1);
  });

  it('a changed acoustic profile is not reused', async () => {
    const outgoing = leaseCapture(MIC);
    await outgoing.acquire(noHealth);
    armCaptureHandoff();
    outgoing.release();

    // The profile is baked into the track constraints at getUserMedia time, so
    // reusing it would silently ignore the operator's new setting.
    const incoming = leaseCapture({ kind: 'mic', micDistance: 'close' });
    await incoming.acquire(noHealth);

    expect(getUserMediaCalls).toBe(2);
  });

  it('holders are counted — the capture survives one of two releases', async () => {
    const a = leaseCapture(MIC);
    const b = leaseCapture(MIC);
    await a.acquire(noHealth);
    await b.acquire(noHealth);
    expect(getUserMediaCalls).toBe(1);

    a.release();
    expect(stoppedTracks).toBe(0);

    b.release();
    expect(stoppedTracks).toBe(1);
  });

  it('overlapping starts share one capture instead of racing to own it', async () => {
    // Two starts can overlap while permission is pending — a restart on top of
    // a slow start, or a handoff racing a manual switch. If both opened their
    // own device, whichever resolved LAST would take the shared slot and then
    // release it, leaving the stream actually feeding the meeting untracked:
    // Stop could not stop it and the microphone would outlive the meeting.
    let resolveSecond: ((stream: MediaStream) => void) | null = null;
    let call = 0;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => {
          getUserMediaCalls += 1;
          call += 1;
          if (call === 1) return Promise.resolve(fakeStream());
          return new Promise<MediaStream>((resolve) => {
            resolveSecond = resolve;
          });
        },
      },
    });

    const a = leaseCapture(MIC);
    const b = leaseCapture(MIC);
    const [streamA, streamB] = await Promise.all([a.acquire(noHealth), b.acquire(noHealth)]);

    // One device open, one stream, two holders.
    expect(getUserMediaCalls).toBe(1);
    expect(streamB).toBe(streamA);
    expect(resolveSecond).toBeNull();

    a.release();
    expect(stoppedTracks).toBe(0);
    b.release();
    expect(stoppedTracks).toBe(1);
  });

  it('a stale release cannot stop a capture that replaced it', async () => {
    const old = leaseCapture(MIC);
    await old.acquire(noHealth);

    // The operator switched source, so this acquisition supersedes the first.
    const current = leaseCapture({ kind: 'mic', micDistance: 'close' });
    await current.acquire(noHealth);
    expect(getUserMediaCalls).toBe(2);
    expect(stoppedTracks).toBe(0);

    // The superseded lease lets go late. It takes its OWN capture with it…
    old.release();
    expect(stoppedTracks).toBe(1);

    // …and leaves the live one both running and still tracked, so Stop can
    // still stop it. Before the fix a late release decremented whatever
    // happened to be in the shared slot, which is how the live microphone
    // ended up outliving the meeting.
    current.release();
    expect(stoppedTracks).toBe(2);
  });

  it('releasing a lease that never acquired cannot free someone else capture', async () => {
    const holder = leaseCapture(MIC);
    await holder.acquire(noHealth);

    leaseCapture(MIC).release();

    expect(stoppedTracks).toBe(0);
  });

  it('track-ended health follows the current lease after handoff, never its released owner', async () => {
    const oldEvents: HealthEvent[] = [];
    const newEvents: HealthEvent[] = [];
    const outgoing = leaseCapture(MIC);
    const stream = await outgoing.acquire((e) => oldEvents.push(e));
    armCaptureHandoff();
    outgoing.release();
    const incoming = leaseCapture(MIC);
    await incoming.acquire((e) => newEvents.push(e));
    oldEvents.length = 0;
    newEvents.length = 0;
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    expect(oldEvents).toEqual([]);
    expect(newEvents.map((e) => e.state)).toEqual(['failed']);
    incoming.release();
  });

  it('an ended parked stream fails the handoff; only a later explicit retry opens capture again', async () => {
    const outgoing = leaseCapture(MIC);
    const first = await outgoing.acquire(noHealth);
    armCaptureHandoff();
    outgoing.release();
    first.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    const incoming = leaseCapture(MIC);
    const events: HealthEvent[] = [];
    await expect(incoming.acquire((e) => events.push(e))).rejects.toThrow('Audio capture ended');
    expect(getUserMediaCalls).toBe(1);
    expect(events.map((e) => e.state)).toEqual(['failed']);
    // This separate acquire models the user's explicit Continue/Retry action.
    const second = await incoming.acquire(noHealth);
    expect(second).not.toBe(first);
    expect(getUserMediaCalls).toBe(2);
    expect(second.getAudioTracks()[0]!.readyState).toBe('live');
    incoming.release();
  });

  it('all current holders receive capture failure and released holders receive none', async () => {
    const aEvents: HealthEvent[] = [];
    const bEvents: HealthEvent[] = [];
    const a = leaseCapture(MIC);
    const b = leaseCapture(MIC);
    const stream = await a.acquire((e) => aEvents.push(e));
    await b.acquire((e) => bEvents.push(e));
    aEvents.length = 0;
    bEvents.length = 0;
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    expect(aEvents.map((e) => e.state)).toEqual(['failed']);
    expect(bEvents.map((e) => e.state)).toEqual(['failed']);
    a.release();
    b.release();
  });

  it('meeting recovery retains system capture across repeated failed provider starts', async () => {
    retainCaptureForRecovery(noHealth);
    const spec = { kind: 'system', micDistance: 'off' } as const;
    const first = leaseCapture(spec);
    const stream = await first.acquire(noHealth);
    first.release();
    expect(stoppedTracks).toBe(0);
    for (let i = 0; i < 3; i++) {
      const retry = leaseCapture(spec);
      expect(await retry.acquire(noHealth)).toBe(stream);
      retry.release();
    }
    expect(getDisplayMediaCalls).toBe(1);
    expect(stoppedTracks).toBe(0);
    releaseCaptureRecovery();
    expect(stoppedTracks).toBe(1);
  });

  it('ending recovery intent waits only for existing holders, then stops immediately', async () => {
    retainCaptureForRecovery(noHealth);
    const holder = leaseCapture(MIC);
    await holder.acquire(noHealth);
    releaseCaptureRecovery();
    expect(stoppedTracks).toBe(0);
    holder.release();
    expect(stoppedTracks).toBe(1);
  });

  it('source ended while recovery owns a parked capture reports failure and releases it', async () => {
    const events: HealthEvent[] = [];
    retainCaptureForRecovery((e) => events.push(e));
    const holder = leaseCapture(MIC);
    const stream = await holder.acquire(noHealth);
    holder.release();
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    expect(events.map((e) => e.state)).toEqual(['failed']);
    expect(stoppedTracks).toBe(1);
    releaseCaptureRecovery();
    expect(stoppedTracks).toBe(1);
  });

  it('repeated acquire on one lease holds exactly one ownership claim', async () => {
    const lease = leaseCapture(MIC);
    const stream = await lease.acquire(noHealth);
    expect(await lease.acquire(noHealth)).toBe(stream);
    lease.release();
    expect(stoppedTracks).toBe(1);
  });

  it('concurrent acquire on one lease also holds exactly one ownership claim', async () => {
    const lease = leaseCapture(MIC);
    const [a, b] = await Promise.all([lease.acquire(noHealth), lease.acquire(noHealth)]);
    expect(a).toBe(b);
    expect(getUserMediaCalls).toBe(1);
    lease.release();
    expect(stoppedTracks).toBe(1);
  });

  it('listener ownership is by lease even when two leases use the same callback', async () => {
    const events: HealthEvent[] = [];
    const shared = (event: HealthEvent) => events.push(event);
    const a = leaseCapture(MIC);
    const b = leaseCapture(MIC);
    const stream = await a.acquire(shared);
    await b.acquire(shared);
    a.release();
    events.length = 0;
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
    expect(events.map((event) => event.state)).toEqual(['failed']);
    b.release();
  });

  it('a shared pending permission failure reaches every waiting lease', async () => {
    let reject!: (reason: Error) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((_resolve, fail) => {
            reject = fail;
          }),
      },
    });
    const first: HealthEvent[] = [];
    const second: HealthEvent[] = [];
    const a = leaseCapture(MIC).acquire((event) => first.push(event));
    const b = leaseCapture(MIC).acquire((event) => second.push(event));
    reject(new Error('permission denied'));
    const results = await Promise.allSettled([a, b]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(first.some((event) => event.state === 'failed')).toBe(true);
    expect(second.some((event) => event.state === 'failed')).toBe(true);
  });

  it.each(['mic', 'system'] as const)(
    'releases granted %s tracks when audio setup throws before claim',
    async (kind) => {
      vi.stubGlobal(
        'AudioContext',
        class {
          createMediaStreamSource() {
            throw new Error('audio graph failed');
          }
          close() {
            return Promise.resolve();
          }
        },
      );
      const lease = leaseCapture({ kind, micDistance: 'meeting' });
      await expect(lease.acquire(noHealth)).rejects.toThrow('audio graph failed');
      expect(stoppedTracks).toBe(1);
      lease.release();
      expect(stoppedTracks).toBe(1);
    },
  );

  it('skips audio retention when retainAudio is false (stateless phone build)', async () => {
    vi.mocked(createCaptureAudioRetention).mockClear();
    const lease = leaseCapture({ ...MIC, retainAudio: false });
    const stream = await lease.acquire(noHealth);
    expect(createCaptureAudioRetention).not.toHaveBeenCalled();
    expect(retainedCaptureRange(stream)).toBeNull();
    expect(lease.captureRangeForNativeFrames?.({} as AudioContext, 0, 512)).toBeNull();
    lease.release();
    expect(stoppedTracks).toBe(1);
  });
});
