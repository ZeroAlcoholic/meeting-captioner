import type { HealthEvent } from '@meeting-audio/contracts';
import type { AudioSource } from './types.js';

function now(): string {
  return new Date().toISOString();
}

/**
 * Browser system-audio capture via `getDisplayMedia`. Use this instead of
 * MicrophoneAudioProvider when the user wants to caption an online meeting
 * (Teams, Zoom, Google Meet) running in another window — the system audio
 * is already mixed and free of room noise, so no AGC / noise_reduction is
 * needed on top.
 *
 * Browser quirks worth knowing:
 *
 *   • Chrome / Edge REQUIRE `video: true` in the constraint set to even
 *     surface the system-audio checkbox in the picker UI — passing
 *     `{ audio: true }` alone silently returns audio-only with no track.
 *     We immediately disable the captured video track so the page doesn't
 *     consume CPU decoding frames the user will never see. The track stays
 *     attached to the MediaStream (stopping it would tear down the whole
 *     stream) but is held in the `disabled` state.
 *
 *   • If the user picks "Share a window" (vs entire screen / tab) the OS
 *     usually cannot route the window's audio through, so `audioTracks`
 *     comes back empty. We treat that as a hard "no audio track" failure
 *     and surface it via HealthEvent so the UI can prompt the user to
 *     pick "Entire Screen" + check the "Share system audio" box.
 *
 *   • There is no noise_reduction / AGC negotiation for getDisplayMedia
 *     output — the audio is whatever the OS sends. Pair this provider
 *     with `micDistance: 'off'` on the OpenAI side so the upstream
 *     noise_reduction profile doesn't fight already-clean signal.
 */
export class DisplayMediaAudioProvider implements AudioSource {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private visibilityHandler: (() => void) | null = null;
  private trackEndedHandler: (() => void) | null = null;

  async acquire(onHealth: (e: HealthEvent) => void): Promise<MediaStream> {
    onHealth({
      kind: 'health',
      component: 'audio',
      state: 'requesting_permission',
      timestamp: now(),
    });
    try {
      // video: true is the price of admission for system audio on Chrome.
      // Without it the picker omits the "Share audio" checkbox.
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });

      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // User picked a window without system-audio routing, or unticked
        // the "Share audio" checkbox. Tear down what we got and surface a
        // clear, actionable error — without this the session would proceed
        // with a silent stream and the user would see frozen captions.
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        onHealth({
          kind: 'health',
          component: 'audio',
          state: 'no_audio_track',
          message: 'No system-audio track. Choose "Entire Screen" and tick "Share system audio".',
          timestamp: now(),
        });
        throw new Error('No audio track in display capture — enable "Share system audio".');
      }

      // Disable but don't stop the video tracks. Stopping any track on the
      // stream triggers the whole `ended` event chain (Chrome behaviour),
      // which would prematurely tear down the session. Disabling is enough
      // to silence frame production without releasing the capture.
      for (const v of this.stream.getVideoTracks()) {
        v.enabled = false;
      }

      this.audioCtx = new AudioContext();
      // createMediaStreamSource refuses an empty audio track list; we
      // already early-returned above on that case, so this is safe.
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

      // The user clicking "Stop sharing" in the browser's screen-share
      // banner fires `ended` on every track of the captured stream. Listen
      // on the first audio track and surface a clear health event so the
      // UI can show "system audio stopped" instead of the generic mic-
      // unplugged copy.
      const audioTrack = audioTracks[0];
      if (audioTrack && typeof audioTrack.addEventListener === 'function') {
        this.trackEndedHandler = () => {
          onHealth({
            kind: 'health',
            component: 'audio',
            state: 'failed',
            message: 'System audio capture stopped — click Start to share again',
            timestamp: now(),
          });
        };
        audioTrack.addEventListener('ended', this.trackEndedHandler);
      }

      onHealth({ kind: 'health', component: 'audio', state: 'connected', timestamp: now() });
      return this.stream;
    } catch (err) {
      // Re-emit failed unless we already emitted no_audio_track above.
      const message = err instanceof Error ? err.message : 'System audio permission denied';
      if (!message.includes('No audio track')) {
        onHealth({
          kind: 'health',
          component: 'audio',
          state: 'failed',
          message,
          timestamp: now(),
        });
      }
      throw err;
    }
  }

  release(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.trackEndedHandler) {
      const t = this.stream?.getAudioTracks()[0];
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
