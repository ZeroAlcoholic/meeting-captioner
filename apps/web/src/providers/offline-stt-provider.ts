import type {
  HealthComponent,
  HealthEvent,
  HealthState,
  TranscriptEvent,
} from '@meeting-audio/contracts';
import type { AudioSource, CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';

const PCM_BUFFER_SIZE = 4096;
const WHL_MODEL = 'small';

function iso(): string {
  return new Date().toISOString();
}

interface WhlSegment {
  start: number;
  end: number;
  text: string;
  completed: boolean;
}

interface WhlMessage {
  uid: string;
  message?: string;
  segments?: WhlSegment[];
}

export class OfflineSTTProvider implements CaptionProvider {
  readonly name = 'offline-stt';

  private _status: ProviderStatus = 'idle';
  private readonly mic: AudioSource;
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private readonly uid: string;

  // Segment tracking — keyed by start time to avoid re-emitting finalized segments
  private finalizedSegmentStarts = new Set<number>();
  private currentSegmentId = '';
  private startMs = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    mic?: AudioSource,
    private readonly language: string = 'en',
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider();
    this.uid = `browser-${Date.now()}`;
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';
    this.newSegment();

    try {
      this.stream = await this.mic.acquire(this.handlers.onHealth);

      this.emitHealth('transport', 'connecting');
      await this.connectWebSocket();

      this.startAudioCapture();
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
        reject(new Error('WhisperLive WebSocket connection timed out'));
      }, 10000);

      ws.onopen = () => {
        // Send client config — WHL expects this before SERVER_READY
        ws.send(
          JSON.stringify({
            uid: this.uid,
            language: this.language,
            task: 'transcribe',
            model: WHL_MODEL,
            use_vad: true,
          }),
        );
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(ev.data) as WhlMessage;
          if (msg.message === 'SERVER_READY') {
            clearTimeout(timeout);
            this.emitHealth('transport', 'connected');
            resolve();
            return;
          }
          if (msg.segments) {
            this.handleSegments(msg.segments);
          }
        } catch {
          // malformed JSON — ignore
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WhisperLive WebSocket error'));
      };

      ws.onclose = () => {
        if (this._status === 'running') {
          this.emitHealth('transport', 'failed');
          this.stop();
        }
      };
    });
  }

  private startAudioCapture(): void {
    if (!this.stream) return;
    try {
      // Request 16 kHz so no manual resampling is needed
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.scriptNode = this.audioCtx.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);

      this.scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (this._status !== 'running' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        // Send raw Float32 PCM directly — WHL expects binary float32 mono 16kHz
        const channelData = ev.inputBuffer.getChannelData(0);
        this.ws.send(channelData.buffer.slice(0) as ArrayBuffer);
      };

      source.connect(this.scriptNode);
      this.scriptNode.connect(this.audioCtx.destination);
    } catch {
      // AudioContext not available in this environment — audio streaming degraded
      this.emitHealth('audio', 'degraded', 'AudioContext unavailable');
    }
  }

  private handleSegments(segments: WhlSegment[]): void {
    for (const seg of segments) {
      if (seg.completed && !this.finalizedSegmentStarts.has(seg.start)) {
        // Emit final event for this segment
        this.finalizedSegmentStarts.add(seg.start);
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'offline-stt',
          mode: 'full_offline',
          source: 'microphone',
          segmentId: `seg-${Math.round(seg.start * 1000)}`,
          status: 'final',
          text: seg.text.trim(),
          startMs: Math.round(seg.start * 1000),
          endMs: Math.round(seg.end * 1000),
        };
        this.handlers.onTranscript(t);
      }
    }

    // Emit partial for the last non-completed segment
    const partial = [...segments].reverse().find((s) => !s.completed);
    if (partial && partial.text.trim()) {
      const t: TranscriptEvent = {
        kind: 'transcript',
        provider: 'offline-stt',
        mode: 'full_offline',
        source: 'microphone',
        segmentId: this.currentSegmentId,
        status: 'partial',
        text: partial.text.trim(),
        startMs: this.startMs,
      };
      this.handlers.onTranscript(t);
    }
  }

  private cleanup(): void {
    this.scriptNode?.disconnect();
    void this.audioCtx?.close();
    this.scriptNode = null;
    this.audioCtx = null;
    this.ws?.close();
    this.ws = null;
    this.mic.release();
    this.stream = null;
  }

  private newSegment(): void {
    this.currentSegmentId = `seg-${Date.now()}`;
    this.startMs = Date.now();
  }

  private emitHealth(component: HealthComponent, state: HealthState, message?: string): void {
    const ev: HealthEvent = { kind: 'health', component, state, timestamp: iso() };
    if (message !== undefined) ev.message = message;
    this.handlers.onHealth(ev);
  }
}
