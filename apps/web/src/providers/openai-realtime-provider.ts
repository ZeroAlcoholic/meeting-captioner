import type {
  AudioLevelEvent,
  HealthComponent,
  HealthEvent,
  HealthState,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import type { CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';

const OPENAI_REALTIME_URL =
  'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

const SILENCE_TIMEOUT_MS = 5000;
const ICE_RESTART_DELAY_MS = 3000;
const AUDIO_LEVEL_INTERVAL_MS = 100;
const PEAK_HOLD_MS = 2000;
const PEAK_DECAY_DB_PER_TICK = 0.1;

function iso(): string {
  return new Date().toISOString();
}

// Shape of events arriving on the OpenAI Realtime data channel
interface DCEvent {
  type: string;
  item_id?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  error?: { message?: string };
}

export class OpenAIRealtimeProvider implements CaptionProvider {
  readonly name = 'openai-realtime';

  private _status: ProviderStatus = 'idle';
  private pc: RTCPeerConnection | null = null;
  private mic = new MicrophoneAudioProvider();
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInputItemId = '';
  private responseTextAcc = '';
  private startMs = 0;

  constructor(
    private readonly sessionUrl: string,
    private readonly handlers: CaptionProviderHandlers,
  ) {}

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';
    this.startMs = Date.now();

    try {
      // Step 1: get mic + AnalyserNode
      const stream = await this.mic.acquire(this.handlers.onHealth);

      // Step 2: POST our server session endpoint → client_secret
      this.emitHealth('transport', 'connecting');
      const sessionRes = await fetch(this.sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!sessionRes.ok) {
        const text = await sessionRes.text();
        throw new Error(`/session failed (${sessionRes.status}): ${text}`);
      }
      const { client_secret } = (await sessionRes.json()) as {
        client_secret: { value: string };
      };

      // Step 3: set up WebRTC
      this.pc = new RTCPeerConnection();
      const dc = this.pc.createDataChannel('oai-events');
      dc.onmessage = (ev: MessageEvent<string>) => {
        try {
          this.handleDCEvent(JSON.parse(ev.data) as DCEvent);
        } catch {
          // malformed event — ignore
        }
      };
      stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream));
      this.pc.oniceconnectionstatechange = () => this.handleIceState();

      // Step 4: SDP exchange with OpenAI
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdpRes = await fetch(OPENAI_REALTIME_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client_secret.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp!,
      });
      if (!sdpRes.ok) {
        throw new Error(`OpenAI SDP exchange failed (${sdpRes.status})`);
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
      this.emitHealth('transport', 'connected');

      // Step 5: audio level polling + silence watchdog
      this.startLevelPolling();
      this.resetSilenceTimer();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error starting Realtime';
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

  private cleanup(): void {
    if (this.levelInterval !== null) clearInterval(this.levelInterval);
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.levelInterval = null;
    this.silenceTimer = null;
    this.pc?.close();
    this.pc = null;
    this.mic.release();
  }

  private handleIceState(): void {
    const state = this.pc?.iceConnectionState;
    if (state === 'disconnected') {
      this.emitHealth('transport', 'reconnecting');
      setTimeout(() => {
        if (this.pc?.iceConnectionState === 'disconnected') {
          this.pc.restartIce();
        }
      }, ICE_RESTART_DELAY_MS);
    } else if (state === 'failed') {
      this.emitHealth('transport', 'failed');
      this.stop();
    }
  }

  private handleDCEvent(ev: DCEvent): void {
    switch (ev.type) {
      case 'input_audio_buffer.committed':
        if (ev.item_id) this.lastInputItemId = ev.item_id;
        break;

      case 'input_audio_buffer.speech_started':
        this.resetSilenceTimer();
        this.emitHealth('audio', 'connected');
        break;

      case 'conversation.item.input_audio_transcription.delta': {
        if (!ev.item_id || !ev.delta) break;
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: 'microphone',
          segmentId: ev.item_id,
          status: 'partial',
          text: ev.delta,
          startMs: this.startMs,
        };
        this.handlers.onTranscript(t);
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (!ev.item_id || !ev.transcript) break;
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: 'microphone',
          segmentId: ev.item_id,
          status: 'final',
          text: ev.transcript,
          startMs: this.startMs,
          endMs: Date.now(),
        };
        this.handlers.onTranscript(t);
        this.startMs = Date.now();
        break;
      }

      case 'response.text.delta': {
        if (!ev.delta) break;
        this.responseTextAcc += ev.delta;
        const tr: TranslationEvent = {
          kind: 'translation',
          provider: 'openai-realtime',
          mode: 'online_full',
          sourceSegmentId: this.lastInputItemId || 'unknown',
          status: 'draft',
          sourceText: '',
          targetText: this.responseTextAcc,
          sourceLanguage: 'en',
          targetLanguage: 'zh-TW',
          updatedAt: iso(),
        };
        this.handlers.onTranslation(tr);
        break;
      }

      case 'response.text.done': {
        if (!ev.text) break;
        const tr: TranslationEvent = {
          kind: 'translation',
          provider: 'openai-realtime',
          mode: 'online_full',
          sourceSegmentId: this.lastInputItemId || 'unknown',
          status: 'final',
          sourceText: '',
          targetText: ev.text,
          sourceLanguage: 'en',
          targetLanguage: 'zh-TW',
          updatedAt: iso(),
        };
        this.handlers.onTranslation(tr);
        this.responseTextAcc = '';
        break;
      }

      case 'error': {
        const msg = ev.error?.message ?? 'OpenAI Realtime error';
        this.emitHealth('transport', 'api_error', msg);
        break;
      }

      default:
        break;
    }
  }

  private startLevelPolling(): void {
    const analyser = this.mic.analyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let peakDb = -60;
    let peakHoldUntil = 0;

    this.levelInterval = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const sumSq = buf.reduce((s, x) => s + x * x, 0);
      const rms = Math.sqrt(sumSq / buf.length);
      const rmsDb = Math.max(-60, 20 * Math.log10(Math.max(rms, 1e-10)));

      const nowMs = Date.now();
      if (rmsDb > peakDb || nowMs > peakHoldUntil) {
        peakDb = rmsDb;
        peakHoldUntil = nowMs + PEAK_HOLD_MS;
      } else {
        peakDb = Math.max(peakDb - PEAK_DECAY_DB_PER_TICK, rmsDb);
      }

      const ev: AudioLevelEvent = {
        kind: 'audio_level',
        source: 'microphone',
        rmsDb,
        peakDb,
        timestamp: iso(),
      };
      this.handlers.onAudioLevel(ev);
    }, AUDIO_LEVEL_INTERVAL_MS);
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this._status === 'running') {
        this.emitHealth('audio', 'silence_detected');
      }
    }, SILENCE_TIMEOUT_MS);
  }

  private emitHealth(component: HealthComponent, state: HealthState, message?: string): void {
    const ev: HealthEvent = { kind: 'health', component, state, timestamp: iso() };
    if (message !== undefined) ev.message = message;
    this.handlers.onHealth(ev);
  }
}
