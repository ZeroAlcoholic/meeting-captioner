import type { HealthEvent } from '@meeting-audio/contracts';
import type { AudioSource } from './types.js';

function now(): string {
  return new Date().toISOString();
}

export class MicrophoneAudioProvider implements AudioSource {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;

  async acquire(onHealth: (e: HealthEvent) => void): Promise<MediaStream> {
    onHealth({ kind: 'health', component: 'audio', state: 'requesting_permission', timestamp: now() });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.audioCtx = new AudioContext();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);
      onHealth({ kind: 'health', component: 'audio', state: 'connected', timestamp: now() });
      return this.stream;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone permission denied';
      onHealth({ kind: 'health', component: 'audio', state: 'failed', message, timestamp: now() });
      throw err;
    }
  }

  release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
  }
}
