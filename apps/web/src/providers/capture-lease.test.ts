import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent } from '@meeting-audio/contracts';
import { armCaptureHandoff, leaseCapture, __resetCaptureLeaseForTests } from './capture-lease.js';

/**
 * The lease exists so a cross-model handoff does not re-open the capture
 * device mid-meeting. The tension it has to hold: reuse across a handoff, but
 * never at the cost of a microphone that outlives Stop.
 */

let getUserMediaCalls = 0;
let getDisplayMediaCalls = 0;
let stoppedTracks = 0;

function fakeStream(): MediaStream {
  const track = {
    kind: 'audio',
    readyState: 'live',
    stop: () => {
      stoppedTracks += 1;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

const noHealth = (): void => {};

beforeEach(() => {
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetCaptureLeaseForTests();
});

const MIC = { kind: 'mic', micDistance: 'meeting' } as const;

describe('capture lease', () => {
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
});
