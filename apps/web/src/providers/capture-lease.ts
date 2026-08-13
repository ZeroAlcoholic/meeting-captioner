import type { HealthEvent } from '@meeting-audio/contracts';
import type { AudioSource } from './types.js';
import { MicrophoneAudioProvider, type MicDistance } from './microphone-audio-provider.js';
import { DisplayMediaAudioProvider } from './display-media-audio-provider.js';

/**
 * ─── Shared capture lease ─────────────────────────────────────────────────────
 *
 * Caption providers used to own their capture outright, so handing a meeting
 * from one backend to the other meant: old provider stops the tracks, new
 * provider calls getUserMedia again. On a real machine that is a device open and
 * — for system audio — a fresh picker dialog the operator has to click through.
 * Seconds of dead air, on precisely the path whose job is to END dead air.
 *
 * The lease lets a handoff keep the capture that is already running.
 *
 * It is deliberately NOT a cache. A plain release stops the tracks immediately,
 * because Stop has to mean the OS microphone indicator goes out now. The stream
 * survives only inside a handoff window that the caller has to arm on purpose,
 * and only for as long as that window lasts.
 */

export type CaptureKind = 'mic' | 'system';

export interface CaptureSpec {
  kind: CaptureKind;
  /** Acoustic profile; ignored for system capture, which is pre-mixed. */
  micDistance: MicDistance;
}

/**
 * How long a released capture stays alive waiting to be picked up again. A
 * handoff is a stop() immediately followed by a start() in the same task, so
 * this only has to cover provider bring-up, not human reaction time. Short
 * enough that an armed window which never gets claimed (the new backend fails
 * to start) still releases the microphone promptly.
 */
const HANDOFF_WINDOW_MS = 2_000;

interface LiveCapture {
  spec: CaptureSpec;
  source: AudioSource;
  stream: MediaStream;
  holders: number;
}

let live: LiveCapture | null = null;
/**
 * An acquisition that has been requested but not yet resolved.
 *
 * Acquiring is async — a permission prompt, a device open, a share dialog — and
 * two starts can overlap while one is pending (a restart on top of a slow
 * start, or a handoff racing a manual switch). Without this, both would see no
 * live capture, both would open a device, and whichever resolved LAST would
 * overwrite the shared slot and then release it: the stream actually feeding
 * the meeting would no longer be tracked, so Stop could not stop it and the
 * microphone would stay live after the meeting ended.
 *
 * Concurrent callers share the in-flight acquisition instead.
 */
let acquiring: { spec: CaptureSpec; promise: Promise<LiveCapture> } | null = null;
let handoffTimer: ReturnType<typeof setTimeout> | null = null;
let handoffArmed = false;

function sameSpec(a: CaptureSpec, b: CaptureSpec): boolean {
  // The acoustic profile is baked into the track's constraints at getUserMedia
  // time, so a different profile genuinely needs a different capture. System
  // capture ignores it — the signal is already mixed by the OS.
  if (a.kind !== b.kind) return false;
  return a.kind === 'system' || a.micDistance === b.micDistance;
}

function createSource(spec: CaptureSpec): AudioSource {
  return spec.kind === 'system'
    ? new DisplayMediaAudioProvider()
    : new MicrophoneAudioProvider(spec.micDistance);
}

function cancelHandoffTimer(): void {
  if (handoffTimer !== null) {
    clearTimeout(handoffTimer);
    handoffTimer = null;
  }
}

function releaseNow(): void {
  cancelHandoffTimer();
  handoffArmed = false;
  if (!live) return;
  live.source.release();
  live = null;
}

/**
 * Arm the next release to hold the capture open briefly instead of stopping it.
 * Call immediately before tearing down the outgoing provider in a handoff. The
 * window closes on its own, so a handoff that never completes cannot strand the
 * microphone open.
 */
export function armCaptureHandoff(): void {
  handoffArmed = true;
}

/**
 * A lease on the shared capture, shaped as an AudioSource so providers need no
 * knowledge of any of this.
 */
export function leaseCapture(spec: CaptureSpec): AudioSource {
  // The exact capture this lease took, so releasing can only ever give back
  // what this lease holds. Comparing against the global slot instead would let
  // a stale release decrement — and stop — a capture that belongs to a session
  // started after it.
  let heldCapture: LiveCapture | null = null;

  const claim = (capture: LiveCapture, onHealth: (e: HealthEvent) => void): MediaStream => {
    cancelHandoffTimer();
    handoffArmed = false;
    capture.holders += 1;
    heldCapture = capture;
    // Report connected so the UI reflects live audio, but never
    // 'requesting_permission' — nothing is being requested.
    onHealth({
      kind: 'health',
      component: 'audio',
      state: 'connected',
      timestamp: new Date().toISOString(),
    });
    return capture.stream;
  };

  return {
    get analyser(): AnalyserNode | null {
      return heldCapture?.source.analyser ?? live?.source.analyser ?? null;
    },

    async acquire(onHealth: (e: HealthEvent) => void): Promise<MediaStream> {
      // Claim the parked capture from a handoff — no device open, no permission
      // round-trip, no picker dialog.
      if (live && sameSpec(live.spec, spec)) return claim(live, onHealth);

      // Someone else is already opening this exact capture. Wait for theirs
      // rather than opening a second device and racing to own the slot.
      if (acquiring && sameSpec(acquiring.spec, spec)) {
        return claim(await acquiring.promise, onHealth);
      }

      // A different capture is parked (the operator changed source or profile
      // between sessions). It cannot serve this request, so let it go now
      // rather than leaving a second device open.
      if (live && live.holders === 0) releaseNow();

      const pending = (async (): Promise<LiveCapture> => {
        const source = createSource(spec);
        const stream = await source.acquire(onHealth);
        const capture: LiveCapture = { spec, source, stream, holders: 0 };
        live = capture;
        return capture;
      })();
      acquiring = { spec, promise: pending };
      try {
        const capture = await pending;
        // holders is incremented by claim(), never here, so an acquisition
        // shared by several callers is counted once per caller.
        return claim(capture, onHealth);
      } finally {
        if (acquiring?.promise === pending) acquiring = null;
      }
    },

    release(): void {
      const capture = heldCapture;
      if (!capture) return;
      heldCapture = null;
      capture.holders = Math.max(0, capture.holders - 1);
      if (capture.holders > 0) return;
      // Superseded by a newer capture: this one is nobody's now, so stop it
      // outright — parking only makes sense for the capture still in the slot.
      if (live !== capture) {
        capture.source.release();
        return;
      }
      if (!handoffArmed) {
        releaseNow();
        return;
      }
      // Park it for the incoming provider, but on a timer: an armed handoff
      // whose destination never starts must not leave the mic live forever.
      cancelHandoffTimer();
      handoffTimer = setTimeout(() => {
        handoffTimer = null;
        if (live && live.holders === 0) releaseNow();
      }, HANDOFF_WINDOW_MS);
    },
  };
}

/** Test hook: drop all lease state so each test starts from nothing held. */
export function __resetCaptureLeaseForTests(): void {
  cancelHandoffTimer();
  handoffArmed = false;
  acquiring = null;
  live = null;
}
