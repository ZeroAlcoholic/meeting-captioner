import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import type {
  AudioSource,
  CaptionProvider,
  CaptionProviderHandlers,
  ProviderStatus,
} from './types.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import { getCaptureContext, ensureCaptureWorklet, resumeCaptureContext } from './audio-engine.js';
import { WarmTokenCache } from './token-prewarm.js';

// AudioWorklet PCM capture (shared with the offline path). We request a smaller
// chunk than the offline default (4096 = 256 ms): the chunk size is pure
// front-of-pipe latency — audio waits to fill the buffer before it ever leaves
// the browser — so it sits directly on the realtime translation path, ahead of
// the network and the model. 512 samples @ 16 kHz = 32 ms: half the previous
// 64 ms framing, shaving another ~32 ms off every Gemini caption's felt latency.
// Gemini accumulates audio server-side, so smaller frames don't hurt ASR/MT
// quality; the only cost is ~31 (vs ~16) tiny WS messages/sec — negligible.
// This is the last meaningful CLIENT-side latency lever; the rest of the
// "聽到→上字幕" delay is network RTT to Google + the translate model's own
// chunking, both measurable via window.__latency but not reducible from here.
const GEMINI_PCM_CHUNK_SIZE = 512; // 32 ms @ 16 kHz

// Gemini Live API (Developer API) WebSocket, ephemeral-token / "Constrained"
// variant. The browser connects directly with the short-lived token minted by
// our /session/gemini route — the raw GEMINI_API_KEY never reaches the client.
const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

const PROVIDER = 'gemini-live';
const GEMINI_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

// ── Receive-side wedge detection (parity with OpenAIRealtimeProvider) ─────────
// A Gemini WS can stay OPEN while the server silently stops emitting
// serverContent — captions freeze with a "connected" health state and no error.
// Detect it by counting cumulative audio-active level-poll ticks since the last
// server message: when audio is clearly flowing IN but nothing comes back OUT
// past the threshold, force a reconnect (which resumes the session via
// resumptionHandle). Mirrors the OpenAI stale-data detector so both backends
// self-heal a silent upstream wedge instead of leaving the operator staring at
// a frozen board.
const STALE_DATA_THRESHOLD_MS = 30_000;
const STALE_AUDIO_EVIDENCE_SAMPLES = 100; // 100 × 100 ms level ticks ≈ 10 s of speech
const STALE_AUDIO_ACTIVE_DB_BY_MIC: Record<'meeting' | 'close' | 'far' | 'off', number> = {
  meeting: -48,
  close: -40,
  far: -48,
  off: -52,
};

// ── Persistent reconnect backoff ──────────────────────────────────────────────
// The previous policy gave up PERMANENTLY after 5 attempts (called stop()) —
// unacceptable for a long meeting, and it left no live session for the
// cross-model failover to hand off from. Instead we retry FOREVER with a capped
// backoff; after RECONNECT_FAILED_HEALTH_AFTER quick attempts we surface a
// 'failed' health state so the UI can offer a one-click switch to the other
// backend — while STILL retrying in the background (auto-heal never stops).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const RECONNECT_FAILED_HEALTH_AFTER = 5;

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

function assertTranslateModel(model: string): void {
  if (model !== GEMINI_TRANSLATE_MODEL) {
    throw new Error(`Unsupported Gemini model: ${model}`);
  }
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

// ── Ephemeral-token mint + warm cache ─────────────────────────────────────────
interface GeminiToken {
  token: string;
  model: string;
}

async function postGeminiToken(url: string): Promise<GeminiToken> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini token mint failed (${res.status}): ${text || res.statusText}`);
  }
  const data = (await res.json()) as { token?: string; model?: string };
  if (!data.token || !data.model) throw new Error('Gemini token response incomplete');
  return { token: data.token, model: data.model };
}

// The token-mint response carries no explicit expiry, so the cache relies on its
// freshness TTL alone (expiresAtMs → null). Single-use, so a uses:1 token is
// only ever spent on the first connect; reconnects mint fresh.
const warmGemini = new WarmTokenCache<GeminiToken>();

/** Pre-mint a Gemini token while idle so the next Start skips the mint RTT. */
export function prewarmGeminiSession(url: string): void {
  void warmGemini.prewarm(
    url,
    () => postGeminiToken(url),
    () => null,
  );
}

/** Test hook: drop any pre-warmed Gemini token so it can't leak across tests. */
export function __resetWarmGeminiForTests(): void {
  warmGemini.clear();
}

export class GeminiLiveProvider implements CaptionProvider {
  readonly name = PROVIDER;

  private _status: ProviderStatus = 'idle';
  private readonly mic: AudioSource;
  private ws: WebSocket | null = null;
  // Shared capture context (owned by audio-engine; never closed here).
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Receive-side wedge detector state. `lastServerContentAt === 0` means the
  // detector is DISABLED (not connected yet / between reconnects); it arms on
  // setupComplete and re-arms on every server message. audioActiveSamplesSince
  // Content accumulates level-poll ticks above the mic-distance threshold and
  // resets whenever a server message proves the upstream is alive.
  private lastServerContentAt = 0;
  private audioActiveSamplesSinceContent = 0;

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
    private readonly micDistance: 'meeting' | 'close' | 'far' | 'off' = 'meeting',
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
      this.emitHealth('transport', 'connecting');
      // Mint the ephemeral token CONCURRENTLY with mic acquisition — independent
      // work, so overlapping them shaves a network RTT off time-to-first-caption
      // (the mint completes while the user is still in the permission dialog on a
      // cold start). Settle-wrapped so a mic denial can't orphan the in-flight
      // fetch as an unhandled rejection.
      const tokenPromise = this.mintToken().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      this.stream = await this.mic.acquire(this.handlers.onHealth);
      // User pressed Stop during mic grant. cleanup() releases the just-granted
      // mic (and is idempotent with the stop() that already ran) — without it the
      // late-resolved stream stays live and the OS mic indicator never turns off.
      if (this._status !== 'running') {
        this.cleanup();
        void tokenPromise;
        return;
      }
      const tok = await tokenPromise;
      if (!tok.ok) {
        throw tok.error instanceof Error ? tok.error : new Error('Gemini token mint failed');
      }
      const { token, model } = tok.value;
      if (this._status !== 'running') {
        this.cleanup();
        return;
      }
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
    // Use a pre-warmed token if one is fresh (single-use; reconnects mint fresh).
    const warm = warmGemini.consume(this.tokenUrl);
    if (warm) return warm;
    return postGeminiToken(this.tokenUrl);
  }

  private connect(token: string, model: string): Promise<void> {
    assertTranslateModel(model);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${GEMINI_WS_BASE}?access_token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      let settled = false;
      let setupReady = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        setupReady = true;
        clearTimeout(timeout);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const handleText = (text: string) => {
        let message: GeminiServerMessage;
        try {
          message = JSON.parse(text) as GeminiServerMessage;
        } catch {
          return;
        }
        this.handleServerObject(message);
        if (message.setupComplete !== undefined) succeed();
      };
      const timeout = setTimeout(() => {
        fail(new Error('Gemini Live WebSocket setup timed out'));
        ws.close();
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify(this.buildSetup(model)));
        // reconnectAttempts is reset only after setupComplete proves the
        // session is usable. A raw socket open is not readiness.
      };

      ws.onmessage = (ev: MessageEvent) => {
        // Stale-socket guard: after a reconnect swaps this.ws, late events from
        // the old socket must not mutate state or settle this connection.
        if (this.ws !== ws) return;
        const data: unknown = ev.data;
        if (typeof data === 'string') {
          handleText(data);
        } else if (data instanceof ArrayBuffer) {
          handleText(new TextDecoder().decode(data));
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          void data
            .text()
            .then((text) => {
              if (this.ws === ws) handleText(text);
            })
            .catch(() => {});
        }
      };

      ws.onerror = () => {
        if (!setupReady) fail(new Error('Gemini Live WebSocket error before setupComplete'));
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (!setupReady) {
          fail(new Error('Gemini Live WebSocket closed before setupComplete'));
          return;
        }
        if (this._status === 'running') this.scheduleReconnect();
      };
    });
  }

  private buildSetup(model: string): Record<string, unknown> {
    assertTranslateModel(model);

    return {
      setup: {
        model,
        // Unlimited duration for long meetings; oldest context is rolled off.
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        // Live Translate rejects these fields under generationConfig. The live
        // handshake contract requires both at setup top level.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: translateTargetCode(this.langPair),
            // Stay silent when the speaker is already in the target language;
            // inputTranscription still provides the source text.
            echoTargetLanguage: false,
          },
        },
      },
    };
  }

  /**
   * Map a Gemini server message onto normalized events. Public + side-effecting
   * via handlers so unit tests can drive it without a live socket.
   */
  handleServerObject(msg: GeminiServerMessage): void {
    // Any server message proves the upstream is alive — feed the wedge detector.
    // Only refresh once ARMED (lastServerContentAt > 0, set by setupComplete);
    // the very first setupComplete arms it just below.
    if (this.lastServerContentAt > 0) {
      this.lastServerContentAt = Date.now();
      this.audioActiveSamplesSinceContent = 0;
    }
    if (msg.setupComplete !== undefined) {
      this.emitHealth('transport', 'connected');
      // Session is proven live — NOW reset the reconnect attempt counter (see
      // ws.onopen). Arm the receive-side wedge detector too.
      this.reconnectAttempts = 0;
      this.lastServerContentAt = Date.now();
      this.audioActiveSamplesSinceContent = 0;
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      // Server will close soon — reconnect proactively using the latest handle.
      // Commit the in-flight utterance first so the rotation doesn't orphan it.
      this.emitHealth('transport', 'reconnecting', 'Gemini session rotating (GoAway)');
      this.finalizeTurn();
      try {
        this.ws?.close();
      } catch {
        /* noop */
      }
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
      this.emitLiveAnchor();
      this.handlers.onTranslation(this.translation('draft', source, target));
      // The dedicated translate model streams continuously and never sends
      // turnComplete, so finalize segments ourselves on sentence boundaries —
      // otherwise one live line grows unbounded and history never populates.
      this.maybeFinalizeOnSentence();
    }
    // Honour explicit turn markers defensively if the service emits them.
    if (sc.turnComplete || sc.generationComplete) this.finalizeTurn();
  }

  /**
   * Keep translated deltas on the live caption path even when Gemini's
   * outputTranscription arrives before inputTranscription. The store binds
   * draft translations to LiveCaption only when a matching livePartial exists;
   * this synthetic anchor mirrors the OpenAI realtime provider's low-latency path.
   */
  private emitLiveAnchor(): void {
    this.handlers.onTranscript(this.transcript('partial', this.srcText));
  }

  // Commit the accumulated source + translation as a finalized segment and
  // start a fresh one. Safe to call when no turn is open (no-op).
  private finalizeTurn(): void {
    if (this.curId === null) return;
    const { source, target } = this.langs;
    // A finalized translation is only visible if its SEGMENT exists in the
    // store (the board keys translations off segments). In the rare case we
    // hold target text with no source transcript (for example, an out-of-order
    // completion marker), surface the translation text as the transcript too —
    // an imperfect source column beats an invisible caption.
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

  /**
   * Force-close a wedged-but-OPEN socket so its onclose handler kicks off the
   * normal reconnect (which resumes the session via resumptionHandle). Used by
   * the receive-side wedge detector in the level-polling loop.
   */
  private forceReconnect(): void {
    // Commit the in-flight utterance BEFORE tearing the socket down (parity with
    // OpenAI's flushSegment-before-swap). Otherwise the half-accumulated turn is
    // neither finalized into history nor cleared: the resumed session keeps
    // appending into the same stale curId, mixing pre/post-reconnect text or
    // leaving an orphaned live partial on the board.
    this.finalizeTurn();
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }

  /**
   * Persistent reconnect with capped backoff. NEVER gives up — a long meeting
   * must heal itself even after many consecutive failures. After
   * RECONNECT_FAILED_HEALTH_AFTER quick attempts we flip the health state to
   * 'failed' so the cross-model failover UI can offer a one-click switch, while
   * STILL retrying in the background. The early-return guard prevents a double
   * arm when both ws.onclose AND a failed mint/connect attempt call us in the
   * same tick.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return; // already scheduled
    const idx = Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const delayMs = RECONNECT_BACKOFF_MS[idx]!;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > RECONNECT_FAILED_HEALTH_AFTER) {
      this.emitHealth(
        'transport',
        'failed',
        `Gemini reconnect attempt ${this.reconnectAttempts} (retrying in ${delayMs / 1000}s) — you can switch backend`,
      );
    } else {
      this.emitHealth(
        'transport',
        'reconnecting',
        `WS dropped — retry ${this.reconnectAttempts} in ${delayMs / 1000}s`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._status !== 'running') return;
      // Re-mint a fresh token (uses:1) then reconnect, resuming the session.
      this.mintToken()
        .then(({ token, model }) => this.connect(token, model))
        // Mint/connect failed — continue the backoff. scheduleReconnect emits
        // the user-facing reconnecting/failed state, so no extra emit here.
        .catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.stream) return;
    try {
      // Reuse the shared, pre-warmed 16 kHz capture context + worklet module
      // (the per-start `new AudioContext` + `addModule` rebuild was pure
      // startup latency). The engine owns the context; we never close it.
      const ctx = getCaptureContext();
      if (!ctx) {
        this.emitHealth('audio', 'degraded', 'AudioContext unavailable');
        return;
      }
      this.audioCtx = ctx;
      await ensureCaptureWorklet(ctx);
      this.sourceNode = ctx.createMediaStreamSource(this.stream);
      const source = this.sourceNode;
      this.workletNode = new AudioWorkletNode(ctx, 'pcm-worklet', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { chunkSize: GEMINI_PCM_CHUNK_SIZE },
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
            this.emitHealth(
              'transport',
              'reconnecting',
              'Sustained WS backpressure — forcing reconnect',
            );
            this.wsBackpressureConsecutiveDrops = 0;
            try {
              this.ws.close();
            } catch {
              /* noop */
            }
          }
          return;
        }
        this.wsBackpressureConsecutiveDrops = 0;
        const pcm16 = floatTo16BitPCM(new Float32Array(ev.data));
        const b64 = arrayBufferToBase64(pcm16);
        this.ws.send(
          JSON.stringify({
            realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } },
          }),
        );
      };
      source.connect(this.workletNode);
      this.workletNode.connect(ctx.destination);
      await resumeCaptureContext();
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
    const audioActiveDb = STALE_AUDIO_ACTIVE_DB_BY_MIC[this.micDistance];
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

      // Receive-side wedge detection. Count cumulative audio-active ticks since
      // the last server message; if audio is clearly flowing in but the server
      // has gone silent past the threshold, the session is wedged — force a
      // reconnect. lastServerContentAt === 0 means the detector is disarmed
      // (not yet connected, or already reconnecting), so we skip it then.
      if (rmsDb > audioActiveDb) this.audioActiveSamplesSinceContent += 1;
      if (this.lastServerContentAt > 0) {
        const gap = now - this.lastServerContentAt;
        if (
          gap > STALE_DATA_THRESHOLD_MS &&
          this.audioActiveSamplesSinceContent >= STALE_AUDIO_EVIDENCE_SAMPLES
        ) {
          this.emitHealth(
            'transport',
            'degraded',
            `Wedged: ${Math.round(gap / 1000)}s no server content while audio active — reconnecting`,
          );
          // Disarm until the reconnect re-arms via setupComplete, so this does
          // not double-fire during the reconnect window.
          this.lastServerContentAt = 0;
          this.audioActiveSamplesSinceContent = 0;
          this.forceReconnect();
        }
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
    this.lastServerContentAt = 0;
    this.audioActiveSamplesSinceContent = 0;
    this.wsBackpressureDropCount = 0;
    this.wsBackpressureConsecutiveDrops = 0;
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.sourceNode?.disconnect?.();
    // Do NOT close the context — it is the shared engine context reused next
    // session. Closing it would force a cold rebuild + worklet recompile.
    this.workletNode = null;
    this.sourceNode = null;
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
