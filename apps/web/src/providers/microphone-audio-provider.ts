import type { HealthEvent } from '@meeting-audio/contracts';
import type { AudioSource } from './types.js';

function now(): string {
  return new Date().toISOString();
}

/**
 * Browser mic capture. The `micDistance` constructor arg pairs the
 * client-side AGC setting with the server-side noise_reduction profile
 * the provider also forwards to OpenAI — both must move in lockstep or
 * the audio path becomes internally inconsistent (e.g. AGC compressing
 * the dynamic range while OpenAI's near_field NR aggressively gates the
 * already-flat signal → soft far speakers vanish).
 *
 *   'meeting' — multi-speaker room on one laptop mic: AGC + NS + EC all OFF.
 *               Browser DSP is built for a single 1-on-1 caller — AGC locks
 *               gain to the first/dominant voice and NS gates softer or
 *               different-sounding participants as "noise", so the moment the
 *               speaker changes the new voice is dropped. We hand OpenAI the
 *               raw signal and let its far_field noise_reduction (paired in
 *               session.ts) do speaker-aware cleanup instead.
 *   'close'   — AGC + NS + EC all ON (desktop / headset mic at ~1 m, single
 *               speaker).
 *   'far'     — AGC OFF, NS still ON (let OpenAI's far_field profile do
 *               the heavy lifting); EC ON so speaker echo from the
 *               other end isn't re-transcribed.
 *   'off'     — minimal processing: AGC off, NS off, EC off. Raw signal
 *               for users with already-clean audio chain (mixer, DSP).
 */
export type MicDistance = 'meeting' | 'close' | 'far' | 'off';

function audioConstraints(micDistance: MicDistance): MediaTrackConstraints {
  switch (micDistance) {
    case 'meeting':
      return {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
    case 'far':
      return {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      };
    case 'off':
      return {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
    case 'close':
    default:
      return {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
  }
}

export class MicrophoneAudioProvider implements AudioSource {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  // Browsers (Chrome especially) auto-suspend AudioContext when the tab is hidden.
  // We listen for refocus and resume — otherwise the analyser stops emitting and
  // the user's audio level meter freezes after switching tabs.
  private visibilityHandler: (() => void) | null = null;
  private trackEndedHandler: (() => void) | null = null;

  constructor(private readonly micDistance: MicDistance = 'meeting') {}

  async acquire(onHealth: (e: HealthEvent) => void): Promise<MediaStream> {
    onHealth({ kind: 'health', component: 'audio', state: 'requesting_permission', timestamp: now() });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(this.micDistance),
        video: false,
      });
      this.audioCtx = new AudioContext();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);

      this.visibilityHandler = () => {
        if (!document.hidden && this.audioCtx?.state === 'suspended') {
          void this.audioCtx.resume();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);

      // Detect mic device disconnect mid-session (USB unplug, BT
      // dropout, OS device switch). Without this the WebRTC peer
      // connection stays "connected" but no audio flows and the user
      // sees a frozen caption area with no error. Emit a clear health
      // signal the UI can surface as "Microphone disconnected".
      // Optional chain on addEventListener so simplified test mocks
      // (which expose only {stop}) don't blow up here — real
      // MediaStreamTrack always has the method.
      const audioTrack = this.stream.getTracks()[0];
      if (audioTrack && typeof audioTrack.addEventListener === 'function') {
        this.trackEndedHandler = () => {
          onHealth({
            kind: 'health',
            component: 'audio',
            state: 'failed',
            message: 'Microphone disconnected — check device and restart',
            timestamp: now(),
          });
        };
        audioTrack.addEventListener('ended', this.trackEndedHandler);
      }

      onHealth({ kind: 'health', component: 'audio', state: 'connected', timestamp: now() });
      return this.stream;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone permission denied';
      onHealth({ kind: 'health', component: 'audio', state: 'failed', message, timestamp: now() });
      throw err;
    }
  }

  release(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.trackEndedHandler) {
      const t = this.stream?.getTracks()[0];
      if (t && typeof t.removeEventListener === 'function') {
        t.removeEventListener('ended', this.trackEndedHandler);
      }
      this.trackEndedHandler = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
  }
}
