import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import type { AudioSource, CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';

// Path to AudioWorklet module served from apps/web/public/
const PCM_WORKLET_URL = '/pcm-worklet.js';

function iso(): string {
  return new Date().toISOString();
}

/** Normalized event union emitted by services/offline /ws */
type OfflineEvent =
  | ({ kind: 'transcript' } & TranscriptEvent)
  | ({ kind: 'translation' } & TranslationEvent)
  | ({ kind: 'health' } & HealthEvent);

export class OfflineSTTProvider implements CaptionProvider {
  readonly name = 'offline-stt';

  private _status: ProviderStatus = 'idle';
  private readonly mic: AudioSource;
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  // Reconnect state — exponential backoff after WS drops while still 'running'.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    mic?: AudioSource,
    private readonly langPair: string = 'en→zh-TW',
    private readonly audioSource: 'mic' | 'system' = 'mic',
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider();
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';

    try {
      if (this.audioSource === 'mic') {
        this.stream = await this.mic.acquire(this.handlers.onHealth);
      }
      this.emitHealth('transport', 'connecting');
      await this.connectWebSocket();
      if (this.audioSource === 'mic') {
        await this.startAudioCapture();
        this.startLevelPolling();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error starting offline STT';
      this.emitHealth('transport', 'api_error', message);
      this._status = 'stopped';
      this.cleanup();
    }
  }

  stop(): void {
    if (this._status === 'stopped') return;
    this._status = 'stopped';
    this.cleanup();
    this.emitHealth('audio', 'stopped');
    this.emitHealth('transport', 'stopped');
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('services/offline WebSocket connection timed out'));
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'start', langPair: this.langPair, source: this.audioSource }));
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        resolve();
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const event = JSON.parse(ev.data) as OfflineEvent;
          this.handleEvent(event);
        } catch {
          // malformed JSON — ignore
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('services/offline WebSocket error'));
      };

      ws.onclose = () => {
        // Only attempt recovery if we're still meant to be running (user didn't click Stop).
        if (this._status !== 'running') return;
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS) {
      this.emitHealth(
        'transport',
        'failed',
        `Auto-reconnect gave up after ${OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      this.stop();
      return;
    }
    const delayMs = Math.min(16000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.emitHealth(
      'transport',
      'reconnecting',
      `WS dropped — retry ${this.reconnectAttempts}/${OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS} in ${delayMs / 1000}s`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._status !== 'running') return;
      this.connectWebSocket().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitHealth('transport', 'reconnecting', `Retry failed: ${msg}`);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private handleEvent(event: OfflineEvent): void {
    switch (event.kind) {
      case 'transcript':
        this.handlers.onTranscript(event as TranscriptEvent);
        break;
      case 'translation':
        this.handlers.onTranslation(event as TranslationEvent);
        break;
      case 'health':
        this.handlers.onHealth(event as HealthEvent);
        break;
    }
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.stream) return;
    try {
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      await this.audioCtx.audioWorklet.addModule(PCM_WORKLET_URL);
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-worklet', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });

      this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (this._status !== 'running' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(ev.data);
      };

      source.connect(this.workletNode);
      // Must connect to destination: Chrome's audio pull model only calls process() when there is
      // a path to AudioDestinationNode. The worklet outputs silence (no samples written to outputs),
      // so nothing plays back through the speakers — but the connection keeps process() alive.
      this.workletNode.connect(this.audioCtx.destination);
      // Resume in case AudioContext was created after async microtask (outside user-gesture window).
      await this.audioCtx.resume();
    } catch {
      // AudioContext/AudioWorklet unavailable (e.g., test environment) — non-fatal
      this.emitHealth('audio', 'degraded', 'AudioWorklet unavailable');
    }
  }

  private startLevelPolling(): void {
    const analyser = (this.mic as MicrophoneAudioProvider).analyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let peakDb = -60;
    let peakHoldUntil = 0;
    this.levelInterval = setInterval(() => {
      if (this._status !== 'running') return;
      analyser.getFloatTimeDomainData(buf);
      const sumSq = buf.reduce((s, x) => s + x * x, 0);
      const rms = Math.sqrt(sumSq / buf.length);
      const rmsDb = Math.max(-60, 20 * Math.log10(Math.max(rms, 1e-10)));
      const now = Date.now();
      if (rmsDb > peakDb || now > peakHoldUntil) {
        peakDb = rmsDb;
        peakHoldUntil = now + 2000;
      }
      const ev: AudioLevelEvent = {
        kind: 'audio_level',
        source: 'microphone',
        rmsDb,
        peakDb,
        timestamp: iso(),
      };
      this.handlers.onAudioLevel(ev);
    }, 100);
  }

  private cleanup(): void {
    if (this.levelInterval !== null) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    void this.audioCtx?.close();
    this.workletNode = null;
    this.audioCtx = null;
    this.ws?.close();
    this.ws = null;
    if (this.audioSource === 'mic') this.mic.release();
    this.stream = null;
  }

  private emitHealth(component: string, state: string, message?: string): void {
    const ev: HealthEvent = {
      kind: 'health',
      component: component as HealthEvent['component'],
      state: state as HealthEvent['state'],
      timestamp: iso(),
    };
    if (message !== undefined) ev.message = message;
    this.handlers.onHealth(ev);
  }
}
