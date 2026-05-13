import { Converter } from 'opencc-js';
import type {
  AudioLevelEvent,
  HealthComponent,
  HealthEvent,
  HealthState,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import type { AudioSource, CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';

// gpt-realtime-translate only outputs 'zh' (Simplified). Convert to Traditional Chinese (Taiwan).
const s2tw = Converter({ from: 'cn', to: 'tw' });

const OPENAI_TRANSLATION_CALLS_URL = 'https://api.openai.com/v1/realtime/translations/calls';

const SEGMENT_FLUSH_MS = 1000;
const ICE_RESTART_DELAY_MS = 3000;
const AUDIO_LEVEL_INTERVAL_MS = 100;
const PEAK_HOLD_MS = 2000;
const PEAK_DECAY_DB_PER_TICK = 0.1;

function iso(): string {
  return new Date().toISOString();
}

interface DCEvent {
  type: string;
  delta?: string;
  elapsed_ms?: number;
  error?: { message?: string };
}

const LANG_PAIR_META: Record<string, { src: string; tgt: string }> = {
  'en→zh-TW': { src: 'en', tgt: 'zh-TW' },
  'zh-TW→en': { src: 'zh-TW', tgt: 'en' },
};
const DEFAULT_META = { src: 'en', tgt: 'zh-TW' };

export class OpenAIRealtimeProvider implements CaptionProvider {
  readonly name = 'openai-realtime';

  private _status: ProviderStatus = 'idle';
  private pc: RTCPeerConnection | null = null;
  private readonly mic: AudioSource;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private segmentFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private inputAcc = '';
  private outputAcc = '';
  private currentSegmentId = '';
  private startMs = 0;

  constructor(
    private readonly sessionUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    private readonly langPair: string = 'en→zh-TW',
    mic?: AudioSource,
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider();
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';
    this.newSegment();

    try {
      // Step 1: get mic + AnalyserNode
      const stream = await this.mic.acquire(this.handlers.onHealth);

      // Step 2: POST our server session endpoint → client_secret
      this.emitHealth('transport', 'connecting');
      const sessionRes = await fetch(this.sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ langPair: this.langPair }),
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

      // Step 4: SDP exchange with OpenAI gpt-realtime-translate
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdpRes = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
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

      // Step 5: audio level polling
      this.startLevelPolling();
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
    this.flushSegment();
    this.cleanup();
    this.emitHealth('audio', 'stopped');
    this.emitHealth('transport', 'stopped');
  }

  private cleanup(): void {
    if (this.levelInterval !== null) clearInterval(this.levelInterval);
    if (this.segmentFlushTimer !== null) clearTimeout(this.segmentFlushTimer);
    this.levelInterval = null;
    this.segmentFlushTimer = null;
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
      case 'session.created':
        // OpenAI confirmed the translation session is active — already emitted connected on SDP
        break;

      case 'session.input_transcript.delta': {
        if (!ev.delta) break;
        this.inputAcc += ev.delta;
        const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
        // Whisper transcribes Mandarin as Simplified Chinese — convert to Traditional for zh-TW source
        const transcriptText = meta.src === 'zh-TW' ? s2tw(this.inputAcc) : this.inputAcc;
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: 'microphone',
          segmentId: this.currentSegmentId,
          status: 'partial',
          text: transcriptText,
          startMs: this.startMs,
        };
        this.handlers.onTranscript(t);
        this.resetSegmentFlushTimer();
        break;
      }

      case 'session.output_transcript.delta': {
        if (!ev.delta) break;
        this.outputAcc += ev.delta;
        const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
        // Convert accumulated simplified Chinese to Traditional Chinese (Taiwan)
        const targetText = meta.tgt === 'zh-TW' ? s2tw(this.outputAcc) : this.outputAcc;
        const tr: TranslationEvent = {
          kind: 'translation',
          provider: 'openai-realtime',
          mode: 'online_full',
          sourceSegmentId: this.currentSegmentId,
          status: 'draft',
          sourceText: this.inputAcc,
          targetText,
          sourceLanguage: meta.src,
          targetLanguage: meta.tgt,
          updatedAt: iso(),
        };
        this.handlers.onTranslation(tr);
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

  private resetSegmentFlushTimer(): void {
    if (this.segmentFlushTimer !== null) clearTimeout(this.segmentFlushTimer);
    this.segmentFlushTimer = setTimeout(() => {
      if (this._status === 'running') this.flushSegment();
    }, SEGMENT_FLUSH_MS);
  }

  private flushSegment(): void {
    if (!this.inputAcc && !this.outputAcc) return;
    const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
    // Apply Traditional Chinese conversion to transcript text when source is zh-TW
    const transcriptText = meta.src === 'zh-TW' ? s2tw(this.inputAcc) : this.inputAcc;

    const t: TranscriptEvent = {
      kind: 'transcript',
      provider: 'openai-realtime',
      mode: 'online_full',
      source: 'microphone',
      segmentId: this.currentSegmentId,
      status: 'final',
      text: transcriptText,
      startMs: this.startMs,
      endMs: Date.now(),
    };
    this.handlers.onTranscript(t);

    if (this.outputAcc) {
      const targetText = meta.tgt === 'zh-TW' ? s2tw(this.outputAcc) : this.outputAcc;
      const tr: TranslationEvent = {
        kind: 'translation',
        provider: 'openai-realtime',
        mode: 'online_full',
        sourceSegmentId: this.currentSegmentId,
        status: 'final',
        sourceText: transcriptText,
        targetText,
        sourceLanguage: meta.src,
        targetLanguage: meta.tgt,
        updatedAt: iso(),
      };
      this.handlers.onTranslation(tr);
    }

    this.newSegment();
  }

  private newSegment(): void {
    this.inputAcc = '';
    this.outputAcc = '';
    this.currentSegmentId = `seg-${Date.now()}`;
    this.startMs = Date.now();
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

  private emitHealth(component: HealthComponent, state: HealthState, message?: string): void {
    const ev: HealthEvent = { kind: 'health', component, state, timestamp: iso() };
    if (message !== undefined) ev.message = message;
    this.handlers.onHealth(ev);
  }
}
