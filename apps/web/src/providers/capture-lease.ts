import type { HealthEvent } from '@meeting-audio/contracts';
import type { AudioSource } from './types.js';
import { MicrophoneAudioProvider, type MicDistance } from './microphone-audio-provider.js';
import { DisplayMediaAudioProvider } from './display-media-audio-provider.js';
import { createCaptureAudioRetention } from './capture-audio-retention.js';
import type { BufferRead, SampleRange } from './meeting-audio-buffer.js';

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
 * survives inside an explicitly armed handoff window or while an active meeting
 * retains it for cloud recovery. Stop/Pause releases that meeting retention.
 */

export type CaptureKind = 'mic' | 'system';

export interface CaptureSpec {
  kind: CaptureKind;
  /** Acoustic profile; ignored for system capture, which is pre-mixed. */
  micDistance: MicDistance;
  /** Empty or omitted uses the OS default only for the initial acquisition. */
  deviceId?: string | undefined;
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
  parkedFrom: number | null;
  parkedGap: { id: string; reportedTo: number } | null;
  retention: Awaited<ReturnType<typeof createCaptureAudioRetention>>;
  retentionAbort: AbortController;
  spec: CaptureSpec;
  source: AudioSource;
  stream: MediaStream;
  deviceId?: string | undefined;
  owners: Set<symbol>;
  healthListeners: Map<symbol, (event: HealthEvent) => void>;
}

/** One capture ownership scope. Separate meeting tracks use independent scopes; no registry. */
export function createCaptureLeaseOwner() {
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
  type PendingCapture = {
    retentionAbort: AbortController;
    spec: CaptureSpec;
    source: AudioSource;
    promise: Promise<LiveCapture>;
    healthListeners: Map<symbol, (event: HealthEvent) => void>;
  };
  let acquiring: PendingCapture | null = null;
  let handoffTimer: ReturnType<typeof setTimeout> | null = null;
  let handoffArmed = false;
  let recoveryHealth: ((event: HealthEvent) => void) | null = null;
  let recoverMicrophone: (() => void) | undefined;
  let recoveryGeneration = 0;
  let removeDeviceListener: (() => void) | null = null;
  let recoveryMic: { spec: CaptureSpec; deviceId: string; waiting: boolean } | null = null;

  function concreteDeviceId(id: string | undefined): id is string {
    return Boolean(id && id !== 'default' && id !== 'communications');
  }

  async function microphoneDevicesChanged(): Promise<void> {
    const target = recoveryMic;
    const admitted = recoveryGeneration;
    if (!target?.waiting || !recoverMicrophone) return;
    try {
      // Automatic recovery must never open another permission prompt. Browsers
      // without a microphone permission query retain the manual recovery action.
      const permission = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      if (admitted !== recoveryGeneration || recoveryMic !== target) return;
      if (permission.state !== 'granted') {
        target.waiting = false;
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (admitted !== recoveryGeneration || recoveryMic !== target || !target.waiting) return;
      if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === target.deviceId)) return;
      target.waiting = false;
      recoverMicrophone?.();
    } catch {
      if (admitted === recoveryGeneration && recoveryMic === target) target.waiting = false;
    }
  }

  function sameSpec(a: CaptureSpec, b: CaptureSpec): boolean {
    // The acoustic profile is baked into the track's constraints at getUserMedia
    // time, so a different profile genuinely needs a different capture. System
    // capture ignores it — the signal is already mixed by the OS.
    if (a.kind !== b.kind) return false;
    return (
      a.kind === 'system' ||
      (a.micDistance === b.micDistance && (a.deviceId ?? '') === (b.deviceId ?? ''))
    );
  }

  function captureIsLive(capture: LiveCapture): boolean {
    const tracks = capture.stream.getAudioTracks();
    return tracks.length > 0 && tracks.every((track) => track.readyState !== 'ended');
  }

  function createSource(spec: CaptureSpec): AudioSource {
    return spec.kind === 'system'
      ? new DisplayMediaAudioProvider()
      : new MicrophoneAudioProvider(
          spec.micDistance,
          recoveryMic && sameSpec(recoveryMic.spec, spec) ? recoveryMic.deviceId : spec.deviceId,
        );
  }

  function cancelHandoffTimer(): void {
    if (handoffTimer !== null) {
      clearTimeout(handoffTimer);
      handoffTimer = null;
    }
  }

  function reportParkedGap(capture: LiveCapture, flush = false): void {
    if (capture.parkedFrom !== null) {
      const from = capture.parkedFrom;
      const range = capture.retention.buffer.retainedRange;
      if (range && from < range.from) {
        const previous = capture.parkedGap;
        // One stable archive gap, at most one update per second of captured PCM.
        // Stop/reclaim flush the final partial second without adding a timer.
        if (
          previous &&
          (range.from === previous.reportedTo ||
            (!flush && range.from - previous.reportedTo < 16000))
        )
          return;
        const gap = { id: previous?.id ?? crypto.randomUUID(), reportedTo: range.from };
        capture.parkedGap = gap;
        recoveryHealth?.({
          kind: 'health',
          component: 'audio',
          state: 'connected',
          timestamp: new Date().toISOString(),
          retentionGap: {
            gapId: gap.id,
            trackId: range.trackId,
            captureEpoch: range.captureEpoch,
            from,
            to: range.from,
            sampleRate: 16000,
          },
        });
      }
    }
  }

  function flushParkedGap(capture: LiveCapture): void {
    reportParkedGap(capture, true);
    capture.parkedFrom = null;
    capture.parkedGap = null;
  }

  function releaseNow(): void {
    cancelHandoffTimer();
    handoffArmed = false;
    if (!live) return;
    flushParkedGap(live);
    live.retentionAbort.abort();
    live.source.release();
    live = null;
  }

  /** Read-only access for the active capture; stale streams cannot read a new epoch. */
  function retainedCaptureRange(stream: MediaStream): SampleRange | null {
    return live?.stream === stream ? live.retention.buffer.retainedRange : null;
  }
  function readCapturedAudio(stream: MediaStream, range: SampleRange): BufferRead {
    return live?.stream === stream
      ? live.retention.buffer.read(range)
      : { frames: [], missing: range.to > range.from ? [{ ...range }] : [] };
  }

  function captureRangeForNativeFrames(
    stream: MediaStream,
    context: AudioContext,
    from: number,
    to: number,
  ): SampleRange | null {
    return live?.stream === stream ? live.retention.rangeForNativeFrames(context, from, to) : null;
  }

  /** The running meeting, not a cloud attempt, owns capture during recovery. */
  function retainCaptureForRecovery(
    onHealth: (event: HealthEvent) => void,
    onMicrophoneAvailable?: () => void,
  ): void {
    recoveryHealth = onHealth;
    recoverMicrophone = onMicrophoneAvailable;
    if (!removeDeviceListener && typeof navigator.mediaDevices?.addEventListener === 'function') {
      const devices = navigator.mediaDevices;
      const changed = () => {
        void microphoneDevicesChanged();
      };
      devices.addEventListener('devicechange', changed);
      removeDeviceListener = () => devices.removeEventListener('devicechange', changed);
    }
    cancelHandoffTimer();
  }

  /** Call before releasing providers on Stop/Pause; no capture survives the last holder. */
  function releaseCaptureRecovery(): void {
    if (live) flushParkedGap(live);
    recoveryHealth = null;
    recoverMicrophone = undefined;
    recoveryMic = null;
    recoveryGeneration += 1;
    removeDeviceListener?.();
    removeDeviceListener = null;
    handoffArmed = false;
    cancelHandoffTimer();
    if (live && live.owners.size === 0) releaseNow();
  }

  /**
   * Arm the next release to hold the capture open briefly instead of stopping it.
   * Call immediately before tearing down the outgoing provider in a handoff. The
   * window closes on its own, so a handoff that never completes cannot strand the
   * microphone open.
   */
  function armCaptureHandoff(): void {
    handoffArmed = true;
  }

  /**
   * A lease on the shared capture, shaped as an AudioSource so providers need no
   * knowledge of any of this.
   */
  function leaseCapture(spec: CaptureSpec): AudioSource {
    // The exact capture this lease took, so releasing can only ever give back
    // what this lease holds. Comparing against the global slot instead would let
    // a stale release decrement — and stop — a capture that belongs to a session
    // started after it.
    let heldCapture: LiveCapture | null = null;
    let pendingCapture: PendingCapture | null = null;
    let generation = 0;
    const owner = Symbol('capture lease');

    const claim = (capture: LiveCapture, onHealth: (e: HealthEvent) => void): MediaStream => {
      if (!captureIsLive(capture)) {
        onHealth({
          kind: 'health',
          component: 'audio',
          state: 'failed',
          message: 'Audio capture ended — restart capture to continue this meeting',
          reason: 'track_ended',
          timestamp: new Date().toISOString(),
        });
        if (capture.owners.size === 0) {
          if (live === capture) releaseNow();
          else capture.source.release();
        }
        throw new Error('Audio capture ended');
      }
      cancelHandoffTimer();
      handoffArmed = false;
      capture.owners.add(owner);
      capture.healthListeners.set(owner, onHealth);
      heldCapture = capture;
      flushParkedGap(capture);
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
        const admitted = generation;
        const claimCurrent = (capture: LiveCapture): MediaStream => {
          if (admitted !== generation)
            throw new DOMException('Capture lease released', 'AbortError');
          return claim(capture, onHealth);
        };
        if (heldCapture) return claim(heldCapture, onHealth);
        // Claim the parked capture from a handoff — no device open, no permission
        // round-trip, no picker dialog.
        if (live && !captureIsLive(live)) {
          releaseNow();
          onHealth({
            kind: 'health',
            component: 'audio',
            state: 'failed',
            message: 'Audio capture ended — retry to share audio again',
            reason: 'track_ended',
            timestamp: new Date().toISOString(),
          });
          throw new Error('Audio capture ended');
        }
        if (live && sameSpec(live.spec, spec)) return claim(live, onHealth);

        // Someone else is already opening this exact capture. Wait for theirs
        // rather than opening a second device and racing to own the slot.
        if (acquiring && sameSpec(acquiring.spec, spec)) {
          acquiring.healthListeners.set(owner, onHealth);
          const pending = (pendingCapture = acquiring);
          try {
            return claimCurrent(await pending.promise);
          } finally {
            if (pendingCapture === pending) pendingCapture = null;
          }
        }

        // A different capture is parked (the operator changed source or profile
        // between sessions). It cannot serve this request, so let it go now
        // rather than leaving a second device open.
        if (live && live.owners.size === 0) releaseNow();

        const healthListeners = new Map([[owner, onHealth]]);
        const source = createSource(spec);
        const retentionAbort = new AbortController();
        const recoveryAtAcquire = recoveryGeneration;
        const microphoneAtAcquire = recoveryMic;
        const pending = (async (): Promise<LiveCapture> => {
          // Sources retain this dispatcher, not the outgoing provider callback.
          // Releasing a lease removes its listener; a handoff attaches the new owner.
          let capture: LiveCapture | null = null;
          let stream: MediaStream;
          let retention: Awaited<ReturnType<typeof createCaptureAudioRetention>>;
          try {
            stream = await source.acquire((event) => {
              // Observe before provider callbacks: a pure-caption failure can
              // synchronously release its lease. Identity must survive that release.
              if (
                capture &&
                recoveryHealth &&
                recoveryGeneration === recoveryAtAcquire &&
                spec.kind === 'mic' &&
                event.reason === 'track_ended'
              ) {
                const deviceId = capture.deviceId;
                recoveryMic = concreteDeviceId(deviceId) ? { spec, deviceId, waiting: true } : null;
                queueMicrotask(() => {
                  if (recoveryGeneration === recoveryAtAcquire) void microphoneDevicesChanged();
                });
              }
              for (const listener of [...healthListeners.values()]) listener(event);
              if (
                capture &&
                capture.owners.size === 0 &&
                recoveryHealth &&
                (event.state === 'failed' || event.state === 'no_audio_track')
              ) {
                const notifyMeeting = recoveryHealth;
                // No provider owns this parked source, but the meeting must still
                // see ended immediately. Never retain a dead display/video stream.
                if (live === capture) releaseNow();
                else {
                  retentionAbort.abort();
                  source.release();
                }
                notifyMeeting(event);
              }
            });
            retention = await createCaptureAudioRetention(
              stream,
              spec.kind,
              retentionAbort.signal,
              () => {
                if (capture) reportParkedGap(capture);
              },
              () => {
                const event: HealthEvent = {
                  kind: 'health',
                  component: 'audio',
                  state: 'degraded',
                  timestamp: new Date().toISOString(),
                  message: '音訊模組載入逾時，正在原音源重試一次；尚未開始送音。',
                };
                for (const listener of [...healthListeners.values()]) listener(event);
              },
            );
            retentionAbort.signal.throwIfAborted();
          } catch (error) {
            if (
              recoveryGeneration === recoveryAtAcquire &&
              recoveryMic === microphoneAtAcquire &&
              error instanceof DOMException
            ) {
              // A device may disappear between enumeration and opening it. Wait
              // for a later devicechange, never loop or request another prompt.
              if (recoveryMic) recoveryMic.waiting = error.name === 'NotFoundError';
            }
            retentionAbort.abort();
            source.release();
            throw error;
          }
          capture = {
            parkedFrom: null,
            parkedGap: null,
            retention,
            retentionAbort,
            spec,
            source,
            stream,
            owners: new Set(),
            healthListeners,
            deviceId: stream.getAudioTracks()[0]?.getSettings?.().deviceId,
          };
          if (healthListeners.size === 0) {
            retentionAbort.abort();
            source.release();
            throw new DOMException('Capture lease released', 'AbortError');
          }
          live = capture;
          return capture;
        })();
        const acquisition = { spec, source, promise: pending, healthListeners, retentionAbort };
        acquiring = pendingCapture = acquisition;
        try {
          const capture = await pending;
          // An owner can claim repeatedly, but releases exactly one ownership.
          return claimCurrent(capture);
        } finally {
          if (acquiring?.promise === pending) acquiring = null;
          if (pendingCapture === acquisition) pendingCapture = null;
        }
      },

      captureRangeForNativeFrames(context, from, to) {
        return heldCapture?.retention.rangeForNativeFrames(context, from, to) ?? null;
      },
      release(): void {
        generation += 1;
        if (pendingCapture) {
          pendingCapture.healthListeners.delete(owner);
          if (pendingCapture.healthListeners.size === 0) {
            pendingCapture.retentionAbort.abort();
            pendingCapture.source.release();
            if (acquiring === pendingCapture) acquiring = null;
          }
          pendingCapture = null;
        }
        const capture = heldCapture;
        if (!capture) return;
        heldCapture = null;
        capture.healthListeners.delete(owner);
        capture.owners.delete(owner);
        if (capture.owners.size > 0) return;
        // Superseded by a newer capture: this one is nobody's now, so stop it
        // outright — parking only makes sense for the capture still in the slot.
        if (live !== capture) {
          capture.retentionAbort.abort();
          capture.source.release();
          return;
        }
        if (recoveryHealth && captureIsLive(capture)) {
          capture.parkedFrom ??= capture.retention.buffer.retainedRange?.to ?? 0;
          cancelHandoffTimer();
          return;
        }
        if (!handoffArmed || !captureIsLive(capture)) {
          releaseNow();
          return;
        }
        // Park it for the incoming provider, but on a timer: an armed handoff
        // whose destination never starts must not leave the mic live forever.
        cancelHandoffTimer();
        handoffTimer = setTimeout(() => {
          handoffTimer = null;
          if (live && live.owners.size === 0) releaseNow();
        }, HANDOFF_WINDOW_MS);
      },
    };
  }

  /** Test hook: drop all lease state so each test starts from nothing held. */
  function __resetCaptureLeaseForTests(): void {
    acquiring?.retentionAbort.abort();
    releaseNow();
    releaseCaptureRecovery();
    cancelHandoffTimer();
    handoffArmed = false;
    acquiring = null;
    live = null;
  }

  return {
    captureRangeForNativeFrames,
    retainedCaptureRange,
    readCapturedAudio,
    retainCaptureForRecovery,
    releaseCaptureRecovery,
    armCaptureHandoff,
    leaseCapture,
    __resetCaptureLeaseForTests,
  };
}

// Existing single-source callers retain the same shared default owner.
export const {
  captureRangeForNativeFrames,
  retainedCaptureRange,
  readCapturedAudio,
  retainCaptureForRecovery,
  releaseCaptureRecovery,
  armCaptureHandoff,
  leaseCapture,
  __resetCaptureLeaseForTests,
} = createCaptureLeaseOwner();
