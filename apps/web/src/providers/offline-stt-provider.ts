import type {
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

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    mic?: AudioSource,
    private readonly langPair: string = 'en→zh-TW',
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
      this.stream = await this.mic.acquire(this.handlers.onHealth);
      this.emitHealth('transport', 'connecting');
      await this.connectWebSocket();
      await this.startAudioCapture();
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
        // Send start control message — services/offline pipeline speaks our protocol
        ws.send(JSON.stringify({ type: 'start', langPair: this.langPair }));
        clearTimeout(timeout);
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
        if (this._status === 'running') {
          this.emitHealth('transport', 'failed');
          this.stop();
        }
      };
    });
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
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-worklet');

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

  private cleanup(): void {
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    void this.audioCtx?.close();
    this.workletNode = null;
    this.audioCtx = null;
    this.ws?.close();
    this.ws = null;
    this.mic.release();
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
