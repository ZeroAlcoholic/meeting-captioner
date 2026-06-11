import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import type { AudioSource, CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';

// AudioWorklet PCM capture (shared with the offline path). Emits Float32 chunks
// of 4096 samples at 16 kHz; we convert to PCM16 for Gemini's realtimeInput.
const PCM_WORKLET_URL = '/pcm-worklet.js';

// Gemini Live API (Developer API) WebSocket, ephemeral-token / "Constrained"
// variant. The browser connects directly with the short-lived token minted by
// our /session/gemini route — the raw GEMINI_API_KEY never reaches the client.
const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

const PROVIDER = 'gemini-live';

function iso(): string {
  return new Date().toISOString();
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `gemini-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `gemini-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Pure audio helpers (exported for unit tests) ─────────────────────────────

/** Convert Float32 [-1,1] PCM to little-endian 16-bit PCM. */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i++) {
    let s = input[i] ?? 0;
    s = Math.max(-1, Math.min(1, s));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out.buffer;
}

/** Base64-encode an ArrayBuffer (chunked to avoid call-stack limits). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── System instruction (translation is instruction-driven on Gemini) ─────────

function systemInstructionFor(langPair: string): string {
  if (langPair === 'zh-TW→en') {
    return (
      'You are a professional real-time simultaneous interpreter for a business ' +
      'meeting. Translate everything the speaker says from Chinese into English. ' +
      'Output only the translation — do not answer questions, do not add commentary ' +
      'or explanations. Keep pace with the speaker.'
    );
  }
  // Default en → Traditional Chinese (Taiwan).
  return (
    'You are a professional real-time simultaneous interpreter for a business ' +
    'meeting. Translate everything the speaker says from English into Traditional ' +
    'Chinese (繁體中文，台灣用語). Output only the translation — do not answer ' +
    'questions, do not add commentary or explanations. Keep pace with the speaker.'
  );
}

function langCodes(langPair: string): { source: string; target: string } {
  return langPair === 'zh-TW→en'
    ? { source: 'zh-TW', target: 'en' }
    : { source: 'en', target: 'zh-TW' };
}

/**
 * BCP-47 target language for the dedicated translate model's translationConfig.
 * Traditional Chinese is `zh-Hant` per the Gemini Live Translate docs
 * (verified live 2026-06-09); English is `en`.
 */
function translateTargetCode(langPair: string): string {
  return langPair === 'zh-TW→en' ? 'en' : 'zh-Hant';
}

/** The dedicated live-translation models use translationConfig, not prompting. */
function isTranslateModel(model: string): boolean {
  return /translate/i.test(model);
}

// ── Minimal shapes of the Gemini server messages we consume ──────────────────
interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    inputTranscription?: { text?: string; languageCode?: string };
    outputTranscription?: { text?: string; languageCode?: string };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
  };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
}

// Sentence terminators (CJK + ASCII), allowing trailing whitespace. An ASCII
// period only counts when NOT preceded by a digit — otherwise a streaming
// delta ending mid-number ("revenue grew 3." before "5 percent" arrives)
// would split the sentence in half.
const SENTENCE_END = /(?:[。．！？!?]|(?<![0-9])\.)\s*$/;

export class GeminiLiveProvider implements CaptionProvider {
  readonly name = PROVIDER;

  private _status: ProviderStatus = 'idle';
  private readonly mic: AudioSource;
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  // Session-resumption handle (lets a reconnect continue the same Gemini
  // session across the ~10-min connection / GoAway boundaries in a long meeting).
  private resumptionHandle: string | null = null;

  // Per-utterance ("turn") accumulation state. Gemini gives no segment ids, so
  // we mint one per turn; wall-clock startMs keeps captions ordered correctly.
  private readonly uid = uid();
  private turnSeq = 0;
  private curId: string | null = null;
  private curStartMs = 0;
  private srcText = '';
  private tgtText = '';
  // Last languageCode reported on inputTranscription — used to detect the
  // echo-silent case (speaker already in the target language → no translation
  // will arrive, so the source must self-finalize).
  private lastInputLang: string | null = null;

  // WS send backpressure (mirrors OfflineSTTProvider). Without this, a stalled
  // -but-OPEN Gemini socket lets the browser-side send buffer grow unbounded
  // across a long meeting.
  private wsBackpressureDropCount = 0;
  private wsBackpressureConsecutiveDrops = 0;
  private static readonly WS_BACKPRESSURE_THRESHOLD = 1_000_000;
  private static readonly WS_FORCE_RECONNECT_DROPS = 100;

  // Fixed for the provider's lifetime — computed once, read in the hot
  // per-message path instead of re-deriving from langPair on every frame.
  private readonly langs: { source: string; target: string };

  constructor(
    private readonly tokenUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    mic?: AudioSource,
    private readonly langPair: string = 'en→zh-TW',
    micDistance: 'meeting' | 'close' | 'far' | 'off' = 'meeting',
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider(micDistance);
    this.langs = langCodes(langPair);
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';
    try {
      this.stream = await this.mic.acquire(this.handlers.onHealth);
      if (this._status !== 'running') return; // user pressed Stop during mic grant
      this.emitHealth('transport', 'connecting');
      const { token, model } = await this.mintToken();
      if (this._status !== 'running') return;
      await this.connect(token, model);
      await this.startAudioCapture();
      this.startLevelPolling();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error starting Gemini Live';
      this.emitHealth('transport', 'api_error', message);
      this._status = 'stopped';
      this.cleanup();
    }
  }

  stop(): void {
    if (this._status === 'stopped') return;
    this._status = 'stopped';
    // Commit any in-flight utterance BEFORE teardown. Without this, the text
    // spoken right before Pause/Stop (a) never reaches history, (b) is missing
    // from Export, and (c) stays on the board as a stale partial with a
    // pulsing "live" cursor even though nothing is running.
    this.finalizeTurn();
    this.cleanup();
    this.emitHealth('audio', 'stopped');
    this.emitHealth('transport', 'stopped');
  }

  private async mintToken(): Promise<{ token: string; model: string }> {
    const res = await fetch(this.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini token mint failed (${res.status}): ${text || res.statusText}`);
    }
    const data = (await res.json()) as { token?: string; model?: string };
    if (!data.token || !data.model) throw new Error('Gemini token response incomplete');
    return { token: data.token, model: data.model };
  }

  private connect(token: string, model: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${GEMINI_WS_BASE}?access_token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Gemini Live WebSocket connection timed out'));
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify(this.buildSetup(model)));
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        resolve();
      };

      ws.onmessage = (ev: MessageEvent) => {
        // Stale-socket guard: after a reconnect swaps this.ws, late events from
        // the OLD socket must be ignored or they double-process / double-reconnect.
        if (this.ws !== ws) return;
        // Gemini Live delivers its JSON server messages as BINARY frames
        // (ArrayBuffer here, since binaryType='arraybuffer'; Blob in some
        // engines), NOT as text. Decode to UTF-8 before parsing — dropping
        // non-string frames silently swallows every transcript/translation.
        const data: unknown = ev.data;
        if (typeof data === 'string') {
          this.tryHandle(data);
        } else if (data instanceof ArrayBuffer) {
          this.tryHandle(new TextDecoder().decode(data));
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          void data.text().then((t) => this.tryHandle(t)).catch(() => {});
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Gemini Live WebSocket error'));
      };

      ws.onclose = () => {
        if (this.ws !== ws) return; // stale socket — a newer connection owns the session
        if (this._status !== 'running') return;
        this.scheduleReconnect();
      };
    });
  }

  private buildSetup(model: string): Record<string, unknown> {
    // Common top-level fields (verified raw-WS placement 2026-06-09):
    // transcription + contextWindowCompression + sessionResumption are TOP-LEVEL
    // setup fields, NOT inside generationConfig.
    const common = {
      model,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Unlimited duration for long meetings; oldest context is rolled off.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
    };

    if (isTranslateModel(model)) {
      // Dedicated live-translation model (e.g. gemini-3.5-live-translate-preview):
      // continuous streaming, purpose-built translation. No systemInstruction /
      // tools allowed — translation is driven by generationConfig.translationConfig.
      //
      // TEXT modality (verified live 2026-06-11): the translate model accepts
      // it, and the translated text still arrives via outputTranscription in
      // the exact same shape — but the server no longer synthesizes the speech
      // we were discarding, cutting billed output-audio tokens and bandwidth.
      return {
        setup: {
          ...common,
          generationConfig: {
            responseModalities: ['TEXT'],
            translationConfig: {
              targetLanguageCode: translateTargetCode(this.langPair),
              // false = stay silent when the speaker is already in the target
              // language (the source transcript still surfaces via inputTranscription).
              echoTargetLanguage: false,
            },
          },
        },
      };
    }

    // Fallback: native-audio model — translation via system instruction.
    return {
      setup: {
        ...common,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: systemInstructionFor(this.langPair) }] },
      },
    };
  }

  /** Parse a decoded JSON frame and route it; tolerate malformed frames. */
  private tryHandle(text: string): void {
    let obj: GeminiServerMessage;
    try {
      obj = JSON.parse(text) as GeminiServerMessage;
    } catch {
      return;
    }
    this.handleServerObject(obj);
  }

  /**
   * Map a Gemini server message onto normalized events. Public + side-effecting
   * via handlers so unit tests can drive it without a live socket.
   */
  handleServerObject(msg: GeminiServerMessage): void {
    if (msg.setupComplete !== undefined) {
      this.emitHealth('transport', 'connected');
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      // Server will close soon — reconnect proactively using the latest handle.
      this.emitHealth('transport', 'reconnecting', 'Gemini session rotating (GoAway)');
      try { this.ws?.close(); } catch { /* noop */ }
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    const { source, target } = this.langs;

    const inTx = sc.inputTranscription;
    if (inTx?.text) {
      this.ensureTurn();
      this.srcText += inTx.text;
      if (inTx.languageCode) this.lastInputLang = inTx.languageCode.toLowerCase();
      this.handlers.onTranscript(this.transcript('partial', this.srcText));
      // Source-side check too — covers the echo-silent case where no
      // translation deltas will ever arrive to drive finalization.
      this.maybeFinalizeOnSentence();
    }
    if (sc.outputTranscription?.text) {
      this.ensureTurn();
      this.tgtText += sc.outputTranscription.text;
      this.handlers.onTranslation(this.translation('draft', source, target));
      // The dedicated translate model streams continuously and never sends
      // turnComplete, so finalize segments ourselves on sentence boundaries —
      // otherwise one live line grows unbounded and history never populates.
      this.maybeFinalizeOnSentence();
    }
    // Native-audio models DO mark turn ends; honour them too.
    if (sc.turnComplete || sc.generationComplete) this.finalizeTurn();
  }

  // Commit the accumulated source + translation as a finalized segment and
  // start a fresh one. Safe to call when no turn is open (no-op).
  private finalizeTurn(): void {
    if (this.curId === null) return;
    const { source, target } = this.langs;
    // A finalized translation is only visible if its SEGMENT exists in the
    // store (the board keys translations off segments). In the rare case we
    // hold target text with no source transcript (native-audio turnComplete
    // before any inputTranscription), surface the translation text as the
    // transcript too — an imperfect source column beats an invisible caption.
    const srcOut = this.srcText.trim() ? this.srcText : this.tgtText;
    if (srcOut.trim()) this.handlers.onTranscript(this.transcript('final', srcOut));
    if (this.tgtText.trim()) this.handlers.onTranslation(this.translation('final', source, target));
    this.curId = null;
    this.srcText = '';
    this.tgtText = '';
  }

  /** Primary language subtag of the translation target (echo detection). */
  private targetPrimaryLang(): 'en' | 'zh' {
    return this.langPair === 'zh-TW→en' ? 'en' : 'zh';
  }

  // Sentence-rate segmentation for the continuous translate stream (it never
  // sends turnComplete). Three finalize conditions:
  //   1. Translation completed a sentence AND the matching source text exists —
  //      requiring BOTH prevents the orphaned-translation bug (a final
  //      translation emitted before any source partial would reference a
  //      segment that never exists → invisible forever).
  //   2. Echo-silent: the speaker is already in the target language
  //      (echoTargetLanguage:false → no translation will EVER arrive). Detected
  //      via inputTranscription.languageCode; finalize transcript-only on the
  //      source sentence end so the live line doesn't grow unbounded.
  //   3. Length safety cap for run-on speech with no boundary.
  private maybeFinalizeOnSentence(): void {
    if (this.curId === null) return;
    const tgtEnds = SENTENCE_END.test(this.tgtText);
    const srcEnds = SENTENCE_END.test(this.srcText);

    if (this.tgtText && this.srcText && tgtEnds) {
      this.finalizeTurn();
      return;
    }

    if (!this.tgtText && this.srcText && srcEnds) {
      const tp = this.targetPrimaryLang();
      const lang = this.lastInputLang;
      const inputIsTarget =
        lang !== null && (lang.startsWith(tp) || (tp === 'zh' && lang.startsWith('cmn')));
      if (inputIsTarget) {
        this.finalizeTurn();
        return;
      }
    }

    if (this.tgtText.length >= 120 || this.srcText.length >= 300) this.finalizeTurn();
  }

  private ensureTurn(): void {
    if (this.curId !== null) return;
    this.turnSeq += 1;
    this.curId = `${this.uid}-t${this.turnSeq}`;
    this.curStartMs = Date.now();
    this.srcText = '';
    this.tgtText = '';
  }

  private transcript(status: TranscriptEvent['status'], text: string): TranscriptEvent {
    return {
      kind: 'transcript',
      provider: PROVIDER,
      mode: 'online_full',
      source: 'microphone',
      segmentId: this.curId ?? `${this.uid}-t${this.turnSeq}`,
      status,
      text,
      startMs: this.curStartMs,
    };
  }

  private translation(
    status: TranslationEvent['status'],
    source: string,
    target: string,
  ): TranslationEvent {
    return {
      kind: 'translation',
      provider: PROVIDER,
      mode: 'online_full',
      sourceSegmentId: this.curId ?? `${this.uid}-t${this.turnSeq}`,
      status,
      sourceText: this.srcText,
      targetText: this.tgtText,
      sourceLanguage: source,
      targetLanguage: target,
      updatedAt: iso(),
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= GeminiLiveProvider.MAX_RECONNECT_ATTEMPTS) {
      this.emitHealth('transport', 'failed', `Auto-reconnect gave up after ${GeminiLiveProvider.MAX_RECONNECT_ATTEMPTS} attempts`);
      this.stop();
      return;
    }
    const delayMs = Math.min(16000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.emitHealth('transport', 'reconnecting', `WS dropped — retry ${this.reconnectAttempts}/${GeminiLiveProvider.MAX_RECONNECT_ATTEMPTS} in ${delayMs / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._status !== 'running') return;
      // Re-mint a fresh token (uses:1) then reconnect, resuming the session.
      this.mintToken()
        .then(({ token, model }) => this.connect(token, model))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.emitHealth('transport', 'reconnecting', `Retry failed: ${msg}`);
          this.scheduleReconnect();
        });
    }, delayMs);
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
        // Backpressure guard (mirrors OfflineSTTProvider): a stalled-but-OPEN
        // socket would otherwise grow the browser send buffer without bound
        // over a long meeting. Drop frames above the threshold, surface the
        // symptom, and force a reconnect on sustained backpressure.
        if (this.ws.bufferedAmount > GeminiLiveProvider.WS_BACKPRESSURE_THRESHOLD) {
          this.wsBackpressureDropCount += 1;
          this.wsBackpressureConsecutiveDrops += 1;
          if (this.wsBackpressureDropCount % 50 === 0) {
            this.emitHealth(
              'audio',
              'degraded',
              `Gemini link slow — ${this.wsBackpressureDropCount} audio frames dropped`,
            );
          }
          if (this.wsBackpressureConsecutiveDrops >= GeminiLiveProvider.WS_FORCE_RECONNECT_DROPS) {
            this.emitHealth('transport', 'reconnecting', 'Sustained WS backpressure — forcing reconnect');
            this.wsBackpressureConsecutiveDrops = 0;
            try { this.ws.close(); } catch { /* noop */ }
          }
          return;
        }
        this.wsBackpressureConsecutiveDrops = 0;
        const pcm16 = floatTo16BitPCM(new Float32Array(ev.data));
        const b64 = arrayBufferToBase64(pcm16);
        this.ws.send(
          JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }),
        );
      };
      source.connect(this.workletNode);
      this.workletNode.connect(this.audioCtx.destination);
      await this.audioCtx.resume();
    } catch {
      this.emitHealth('audio', 'degraded', 'AudioWorklet unavailable');
    }
  }

  private startLevelPolling(): void {
    // AudioSource interface exposes analyser — works for both the microphone
    // and the display-media (system audio) capture providers.
    const analyser = this.mic.analyser;
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
      const ev: AudioLevelEvent = { kind: 'audio_level', source: 'microphone', rmsDb, peakDb, timestamp: iso() };
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
    this.wsBackpressureDropCount = 0;
    this.wsBackpressureConsecutiveDrops = 0;
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
