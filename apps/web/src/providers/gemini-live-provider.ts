import type {
  AudioLevelEvent,
  AudioSourceKind,
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
import {
  getCaptureContext,
  ensureCaptureWorklet,
  pcmChunkSizeForRate,
  resamplePcm,
  resumeCaptureContext,
  type ResampleState,
} from './audio-engine.js';
import { monitorCaptureHealth } from './capture-health.js';
import { WarmTokenCache } from './token-prewarm.js';
import { serviceFetch } from './service-fetch.js';
import {
  createRecoveryAttempt,
  assertRecoveryAllowed,
  recoveryHttpError,
  normalizeRecoveryError,
  permanentRecoveryFailure,
  recoveryFailureFor,
  RecoveryError,
  recoveryError,
  protocolRecoveryKind,
  RECOVERY_ATTEMPT_TIMEOUT_MS,
  type RecoveryAttempt,
} from './recovery-attempt.js';

// AudioWorklet PCM capture (shared with the offline path), at a smaller chunk
// than the offline default of 4096 (256 ms). Chunk size is front-of-pipe
// latency in principle — audio waits to fill the buffer before it leaves the
// browser — which is the reasoning that drove this down to 512 (32 ms).
//
// That reasoning has not survived measurement. The 2026-07-28 audit observed
// the 32 ms configuration arriving SLOWER end to end than a 100 ms one
// (3927 ms vs 3313 ms). One observation of an uncontrolled input is not a
// verdict, and it is not enough to change the value on — but it is enough that
// this comment must not go on asserting the opposite. The earlier claims that
// smaller frames cost no ASR/MT quality, and that this is the last meaningful
// client-side lever, were likewise never measured.
//
// Current standing: 512 is retained pending the screening comparison in the
// manual session (docs/GOAL_PHASE_2.md, D2). A verdict either way needs a fixed
// audio-replay fixture so both runs see the same input.
const GEMINI_PCM_CHUNK_SIZE = 512; // 32 ms @ 16 kHz

// Gemini Live API (Developer API) WebSocket, ephemeral-token / "Constrained"
// variant. The browser connects directly with the short-lived token minted by
// our /session/gemini route — the raw GEMINI_API_KEY never reaches the client.
const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const PROVIDER = 'gemini-live';
const GEMINI_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

// Sentinel for "the setup handshake was torn down on purpose" (Stop / restart
// before setupComplete). It travels the same rejection path as a real setup
// failure but must NOT be reported as one: cleanup() has already run and the
// user asked for this. See connect()/start().
class SetupAbortedError extends Error {
  constructor() {
    super('Gemini Live setup aborted by teardown');
    this.name = 'SetupAbortedError';
  }
}

// ── Receive-side wedge detection (parity with OpenAIRealtimeProvider) ─────────
// A Gemini WS can stay OPEN while the server silently stops emitting
// serverContent — captions freeze with a "connected" health state and no error.
// Detect it by counting cumulative audio-active level-poll ticks since the last
// caption text: when audio is clearly flowing IN but nothing comes back OUT
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
// backoff — auto-heal never stops.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

// A pending handshake must not be cancelled by a shorter failover clock.
// Only completed failed attempts emit 'failed'; the coordinator owns outage budgets.

// ── Stop drain ────────────────────────────────────────────────────────────────
// Gemini keeps translating after the last audio frame — roughly 2-3 s of lag is
// structural to the model (measured 2026-07-02; there is no parameter to tune).
// Closing the socket the instant Stop is pressed therefore throws away the tail,
// and the tail is the last thing anyone said in the meeting.
//
// audioStreamEnd tells the server the microphone went off so it flushes what it
// is holding (Live API reference: BidiGenerateContentRealtimeInput.
// audioStreamEnd, bool — valid while automatic activity detection is enabled,
// which we never disable). The cap bounds how long we wait for that flush; the
// dedicated translate model streams continuously and rarely sends turnComplete,
// so in practice this cap is what ends the drain, not the server.
const STOP_DRAIN_CAP_MS = 3_000;

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
    throw recoveryError('unsupported', 'gemini', 'translation', 'Unsupported Gemini model');
  }
}

// ── Minimal shapes of the Gemini server messages we consume ──────────────────
interface GeminiServerMessage {
  error?: unknown;
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

class GeminiSocketCloseError extends Error {
  constructor(readonly code: number) {
    super(`Gemini socket closed before setupComplete (code ${code})`);
  }
}

async function postGeminiToken(url: string, signal: AbortSignal): Promise<GeminiToken> {
  if (signal.aborted) throw signal.reason;
  assertRecoveryAllowed('gemini', 'translation');
  const res = await serviceFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  if (signal.aborted) throw signal.reason;
  if (!res.ok) {
    throw recoveryHttpError(res, 'gemini', 'translation');
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
export function prewarmGeminiSession(url: string, refreshIfOlderThanMs?: number): void {
  void warmGemini.prewarm(
    url,
    async (signal) => {
      const attempt = createRecoveryAttempt({
        parentSignal: signal,
        generation: 0,
        isCurrent: () => !signal.aborted,
        label: 'Gemini token prewarm',
      });
      try {
        return await attempt.run((requestSignal) => postGeminiToken(url, requestSignal));
      } finally {
        attempt.dispose();
      }
    },
    () => null,
    refreshIfOlderThanMs,
  );
}

/** Cancel speculative work when meeting intent or online mode ends. */
export function cancelGeminiPrewarm(): void {
  warmGemini.clear();
}

/** Test hook: drop any pre-warmed Gemini token so it can't leak across tests. */
export function __resetWarmGeminiForTests(): void {
  warmGemini.clear();
}

export class GeminiLiveProvider implements CaptionProvider {
  readonly name = PROVIDER;

  private _status: ProviderStatus = 'idle';
  // Async work from a previous start must never adopt a socket or capture graph
  // after Stop, even if this same provider has already been started again.
  private generation = 0;
  private captureController: AbortController | null = null;
  private readonly mic: AudioSource;
  // A restart while the permission/device request is pending must share that
  // acquisition. Acquiring twice through the same lease would claim it twice
  // while release() can return only one claim.
  private pendingMic: Promise<MediaStream> | null = null;
  private ws: WebSocket | null = null;
  // Shared capture context (owned by audio-engine; never closed here).
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private captureHealth: ReturnType<typeof monitorCaptureHealth> | null = null;
  private stream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private setupReady = false;
  private attempt: RecoveryAttempt | null = null;
  private reconnectInFlight = false;
  private rotation: { timer: ReturnType<typeof setTimeout> } | null = null;
  // Post-Stop drain: capture is already released, the socket is held open only
  // to collect the tail the server still owes us.
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private stopComplete: Promise<void> = Promise.resolve();
  private resolveStop: (() => void) | null = null;
  // Settles the in-flight setup handshake, if any. cleanup() must call this:
  // closing the socket alone leaves connect()'s promise pending behind the
  // stale-socket guard, and the attempt deadline then fires a phantom timeout
  // that lands on whatever session is running by then.
  private settleSetupOnTeardown: (() => void) | null = null;

  // Receive-side wedge detector state. `lastServerContentAt === 0` means the
  // detector is DISABLED (not connected yet / between reconnects); it arms on
  // setupComplete and re-arms on caption progress. audioActiveSamplesSince
  // Content accumulates level-poll ticks above the mic-distance threshold and
  // resets whenever caption text proves the upstream is progressing.
  private lastServerContentAt = 0;
  private audioActiveSamplesSinceContent = 0;

  // Session-resumption handle (lets a reconnect continue the same Gemini
  // session across the ~10-min connection / GoAway boundaries in a long meeting).
  private resumptionHandle: string | null = null;
  private resumedSetupFailures = 0;
  private freshSessionFallback = false;

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
    // Stamped onto every event so downstream consumers know what was actually
    // captured. It has to be passed in: the provider cannot infer it, and
    // guessing from micDistance would be wrong the moment someone picks the
    // 'off' profile for an actual microphone.
    private readonly sourceKind: AudioSourceKind = 'microphone',
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider(micDistance);
    this.langs = langCodes(langPair);
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    // A restart cancels any drain still in flight. Left running, its timer
    // would fire finishStop() into the NEW session and tear down a live socket.
    if (this.draining) this.finishStop();
    // A final-caption subscriber may already have started the replacement.
    if (this.status === 'running') return;
    this._status = 'running';
    const generation = ++this.generation;
    const captureController = new AbortController();
    this.captureController = captureController;
    let phase: 'capture' | 'network' | 'audio' = 'capture';
    try {
      this.emitHealth('transport', 'connecting');
      if (!this.isCurrentGeneration(generation)) return;
      // Permission waiting is not network recovery time. Warm tokens still hide
      // the normal mint RTT, and the 12s attempt starts after capture is granted.
      const acquisition =
        this.pendingMic ??
        this.mic.acquire((event) => {
          // A later start may share this pending acquisition, so health belongs
          // to the current owner rather than the generation that requested it.
          if (this._status === 'running') this.handlers.onHealth(event);
        });
      this.pendingMic = acquisition;
      let stream: MediaStream;
      try {
        stream = await acquisition;
      } finally {
        if (this.pendingMic === acquisition) this.pendingMic = null;
      }
      if (!this.isCurrentGeneration(generation)) {
        // Stop with no replacement still owns the eventual grant and must
        // release it. A newer running start owns the shared grant instead.
        if (this._status !== 'running') this.mic.release();
        return;
      }
      this.stream = stream;
      phase = 'network';
      await this.connectAttempt(generation);
      if (!this.isCurrentGeneration(generation)) return;
      phase = 'audio';
      await this.startAudioCapture(generation, captureController.signal);
      if (!this.isCurrentGeneration(generation)) return;
      this.startLevelPolling();
    } catch (err) {
      // Teardown-initiated abort is not a failure: stop() already set the status
      // and ran cleanup(). Reporting it would paint a false api_error — possibly
      // onto a session the user has already restarted.
      if (err instanceof SetupAbortedError || !this.isCurrentGeneration(generation)) return;
      const message = err instanceof Error ? err.message : 'Unknown error starting Gemini Live';
      if (phase === 'capture') {
        this.emitHealth('audio', 'failed', '無法取得音源，請檢查收音權限與裝置。');
      } else {
        // Worklet setup already emits local audio health. Preserve its existing
        // retryable behavior without recording a cloud/network failure.
        const failure =
          phase === 'network' ? normalizeRecoveryError(err, 'gemini', 'translation') : undefined;
        this.emitHealth(
          'transport',
          'api_error',
          message,
          failure?.failure ?? {
            layer: 'audio',
            kind: 'stalled',
            provider: 'gemini',
            purpose: 'translation',
            attemptId: crypto.randomUUID(),
          },
        );
      }
      if (!this.isCurrentGeneration(generation)) return;
      this._status = 'stopped';
      this.cleanup();
    }
  }

  stop(): void {
    // Already stopped but still draining: a second Stop, or a new session
    // starting, means the tail has run out of time. Close it out now rather
    // than leaving a socket that will emit into whatever comes next.
    if (this._status === 'stopped') {
      if (this.draining) this.finishStop();
      return;
    }
    this._status = 'stopped';
    const stoppedGeneration = ++this.generation;
    this.cancelRotation();
    this.attempt?.cancel(new SetupAbortedError());

    // The microphone goes off NOW. Whatever the socket still owes us, Stop has
    // to mean stopped from the user's point of view.
    this.stopCapture();
    // Install the drain/finish ownership before publishing stopped. A health
    // subscriber may synchronously Start; it must find and retire the old drain.
    if (this.sendAudioStreamEnd()) {
      this.draining = true;
      this.stopComplete = new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
      this.drainTimer = setTimeout(() => this.finishStop(), STOP_DRAIN_CAP_MS);
    } else {
      this.finishStop();
    }
    if (this.generation !== stoppedGeneration) return;
    this.emitHealth('audio', 'stopped');
    if (this.generation !== stoppedGeneration) return;
    this.emitHealth('transport', 'stopped');
  }

  /**
   * Signal end-of-audio so the server flushes its buffer instead of discarding
   * it when we close. Returns whether the frame actually went out — with no
   * live socket there is nothing to drain and Stop completes immediately.
   */
  private sendAudioStreamEnd(): boolean {
    // A setup handshake still in flight is not a session that can flush
    // anything. Worse, draining would postpone cleanup() — and with it the
    // teardown settle that resolves connect()'s promise — so Stop would hang
    // instead of returning.
    if (this.settleSetupOnTeardown !== null) return false;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close out a stopped session: tear down, then commit whatever the drain
   * produced. finalizeTurn runs LAST, not before the drain — committing first would
   * split the final sentence across two segments, with the half that arrived
   * during the drain orphaned in a segment nothing else references.
   */
  private finishStop(): void {
    const resolveStop = this.resolveStop;
    this.resolveStop = null;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.draining = false;
    // Release the old resources before final-caption subscribers can Start.
    // cleanup does not clear turn text; finalizeTurn snapshots and commits it.
    this.cleanup();
    this.finalizeTurn();
    resolveStop?.();
  }

  /** Settles after the existing bounded Stop drain has emitted its final events. */
  waitForStop(): Promise<void> {
    return this.stopComplete;
  }

  private newAttempt(generation: number, label: string): RecoveryAttempt {
    this.attempt?.cancel(new SetupAbortedError());
    const attempt = createRecoveryAttempt({
      generation,
      isCurrent: (value) => this.isCurrentGeneration(value),
      label,
    });
    this.attempt = attempt;
    return attempt;
  }

  private finishAttempt(attempt: RecoveryAttempt): void {
    attempt.dispose();
    if (this.attempt === attempt) this.attempt = null;
  }

  private mintToken(attempt: RecoveryAttempt): Promise<GeminiToken> {
    return attempt.run((signal) => {
      assertRecoveryAllowed('gemini', 'translation');
      const warm = warmGemini.consume(this.tokenUrl);
      return warm ? Promise.resolve(warm) : postGeminiToken(this.tokenUrl, signal);
    });
  }

  private async connectAttempt(generation: number, prepared?: GeminiToken): Promise<void> {
    const attempt = this.newAttempt(generation, 'Gemini recovery');
    try {
      attempt.assertActive();
      assertRecoveryAllowed('gemini', 'translation');
      if (this.freshSessionFallback) this.finalizeTurn();
      const token = prepared ?? (await this.mintToken(attempt));
      await attempt.run((signal) => this.connect(token.token, token.model, signal));
    } finally {
      this.finishAttempt(attempt);
    }
  }

  private async connect(token: string, model: string, signal: AbortSignal): Promise<void> {
    assertTranslateModel(model);
    const resuming = this.resumptionHandle !== null;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${GEMINI_WS_BASE}?access_token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.setupReady = false;

      let settled = false;
      let setupReady = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        setupReady = true;
        this.setupReady = true;
        signal.removeEventListener('abort', abort);
        this.settleSetupOnTeardown = null;
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        this.settleSetupOnTeardown = null;
        if (this.ws === ws) {
          this.ws = null;
          this.setupReady = false;
        }
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(error);
      };
      // Intentional teardown (Stop / provider switch) while the handshake is
      // still open: settle now with the sentinel so the attempt dies with it.
      this.settleSetupOnTeardown = () => fail(new SetupAbortedError());
      const handleText = (text: string) => {
        if (this.ws !== ws || (this._status !== 'running' && !this.draining)) return;
        let message: GeminiServerMessage;
        try {
          message = JSON.parse(text) as GeminiServerMessage;
        } catch {
          return;
        }
        // Stop releases capture immediately, but the current socket still owns
        // a bounded tail. Only content may flow during that drain; setup,
        // resumption and GoAway must not revive health or schedule recovery.
        if (this.draining) {
          if (message.error) this.finishStop();
          else if (message.serverContent)
            this.handleServerObject({ serverContent: message.serverContent });
          return;
        }
        if (message.error) {
          const kind = protocolRecoveryKind(message.error);
          const failure = recoveryError(
            kind,
            'gemini',
            'translation',
            'Gemini Live protocol failure',
            kind === 'rate-limit' ? performance.now() + 15_000 : undefined,
          );
          if (!setupReady) fail(failure);
          else {
            this.ws = null;
            this.setupReady = false;
            ws.close();
            this.retryAfterFailure(failure);
          }
          return;
        }
        this.handleServerObject(message);
        if (message.setupComplete !== undefined) succeed();
      };
      const abort = () =>
        fail(signal.reason instanceof Error ? signal.reason : new SetupAbortedError());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }

      ws.onopen = () => {
        if (this.ws !== ws || this._status !== 'running') return;
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

      ws.onclose = (event: CloseEvent) => {
        if (this.ws !== ws) return;
        this.setupReady = false;
        this.lastServerContentAt = 0;
        this.cancelRotation();
        if (!setupReady) {
          // A bounded recovery policy, not a claim that this close code proves
          // the handle invalid. Only actual resumed setup closes count.
          if (resuming) {
            this.resumedSetupFailures += 1;
            if (this.resumedSetupFailures >= 2) {
              this.resumptionHandle = null;
              this.freshSessionFallback = true;
            }
          }
          const code = Number.isInteger(event?.code) ? event.code : 1006;
          fail(new GeminiSocketCloseError(code));
          return;
        }
        // setupComplete resolves asynchronously: close may arrive before the
        // attempt promise clears its in-flight flag.
        this.reconnectInFlight = false;
        if (this._status === 'running') {
          const code = Number.isInteger(event?.code) ? event.code : 1006;
          this.scheduleReconnect(0, `Gemini socket closed (code ${code})`);
        }
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
    const generation = this.generation;
    // Only actual caption progress resets the wedge detector. Resumption/control
    // frames can continue arriving even while translation is stuck.
    if (
      this.lastServerContentAt > 0 &&
      (msg.serverContent?.inputTranscription?.text?.trim() ||
        msg.serverContent?.outputTranscription?.text?.trim())
    ) {
      this.lastServerContentAt = Date.now();
      this.audioActiveSamplesSinceContent = 0;
    }
    if (msg.setupComplete !== undefined) {
      const message = this.freshSessionFallback
        ? 'Connected with a new Gemini session; context may be interrupted'
        : undefined;
      this.resumedSetupFailures = 0;
      this.freshSessionFallback = false;
      this.reconnectAttempts = 0;
      this.lastServerContentAt = Date.now();
      this.audioActiveSamplesSinceContent = 0;
      // State is committed before subscribers can Stop or replace this session.
      this.emitHealth('transport', 'connected', message);
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      this.prepareRotation(msg.goAway.timeLeft);
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
      if (this.srcText.trim()) this.handlers.onTranscript(this.transcript('partial', this.srcText));
      if (generation !== this.generation) return;
      // Source-side check too — covers the echo-silent case where no
      // translation deltas will ever arrive to drive finalization.
      this.maybeFinalizeOnSentence();
      if (generation !== this.generation) return;
    }
    if (sc.outputTranscription?.text) {
      this.ensureTurn();
      this.tgtText += sc.outputTranscription.text;
      if (this.tgtText.trim()) {
        this.emitLiveAnchor();
        if (generation !== this.generation) return;
        this.handlers.onTranslation(this.translation('draft', source, target));
        if (generation !== this.generation) return;
      }
      // The dedicated translate model streams continuously and never sends
      // turnComplete, so finalize segments ourselves on sentence boundaries —
      // otherwise one live line grows unbounded and history never populates.
      this.maybeFinalizeOnSentence();
      if (generation !== this.generation) return;
    }
    // Honour explicit turn markers defensively if the service emits them.
    if (sc.turnComplete || sc.generationComplete) {
      this.finalizeTurn();
      if (generation !== this.generation) return;
      // If we are draining after Stop, that marker IS the flush completing —
      // close out now instead of holding the socket for the rest of the cap.
      if (this.draining) this.finishStop();
    }
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
    const transcript = srcOut.trim() ? this.transcript('final', srcOut) : null;
    const translation = this.tgtText.trim() ? this.translation('final', source, target) : null;
    const generation = this.generation;
    // Detach the old turn before callbacks. Nested input belongs to a new turn.
    this.curId = null;
    this.srcText = '';
    this.tgtText = '';
    if (transcript) this.handlers.onTranscript(transcript);
    if (generation !== this.generation) return;
    if (translation) this.handlers.onTranslation(translation);
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
      source: this.sourceKind,
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

  /** Retire locally before close: browser close events have no bounded latency. */
  private retireSocket(): void {
    const old = this.ws;
    this.ws = null;
    this.setupReady = false;
    this.lastServerContentAt = 0;
    this.settleSetupOnTeardown?.();
    try {
      old?.close();
    } catch {
      /* already gone */
    }
    this.finalizeTurn();
  }

  private cancelRotation(): void {
    if (!this.rotation) return;
    clearTimeout(this.rotation.timer);
    this.rotation = null;
    this.attempt?.cancel(new SetupAbortedError());
  }

  private prepareRotation(timeLeft?: string): void {
    if (this._status !== 'running' || !this.ws || this.rotation) return;
    const generation = this.generation;
    const seconds = timeLeft?.match(/^(\d+(?:\.\d+)?)s$/);
    // Reserve the 12s recovery budget + 2s margin within the announced grace period.
    // Cap preparation at 30s so a single-use ephemeral token is not held indefinitely.
    // Invalid/missing durations rotate immediately.
    const graceMs = seconds ? Number(seconds[1]) * 1000 : 0;
    const shortGrace = graceMs <= RECOVERY_ATTEMPT_TIMEOUT_MS + 2_000;
    const remaining = shortGrace
      ? Math.max(0, graceMs - 1_000)
      : Math.min(30_000, graceMs - RECOVERY_ATTEMPT_TIMEOUT_MS - 2_000);
    let prepared: GeminiToken | null = null;
    const rotate = () => {
      if (this.rotation !== rotation || !this.isCurrentGeneration(generation)) return;
      this.cancelRotation();
      this.retireSocket();
      if (!this.isCurrentGeneration(generation)) return;
      this.emitHealth('transport', 'reconnecting', 'Gemini session rotating (GoAway)');
      if (!this.isCurrentGeneration(generation)) return;
      if (!prepared) {
        this.scheduleReconnect();
        return;
      }
      this.reconnectInFlight = true;
      void this.connectAttempt(generation, prepared).then(
        () => {
          if (this.isCurrentGeneration(generation)) this.reconnectInFlight = false;
        },
        (error: unknown) => {
          if (!this.isCurrentGeneration(generation)) return;
          this.reconnectInFlight = false;
          if (error instanceof SetupAbortedError) return;
          this.retryAfterFailure(error);
        },
      );
    };
    const rotation = { timer: setTimeout(rotate, remaining) };
    this.rotation = rotation;
    // Pre-mint while the original session continues receiving and sending.
    // Use its most recent resumption handle only at the planned cutover.
    const preparation = this.newAttempt(generation, 'Gemini rotation preparation');
    void this.mintToken(preparation)
      .then((token) => {
        if (this.rotation === rotation && this.isCurrentGeneration(generation)) {
          prepared = token;
          if (shortGrace) rotate();
        }
      })
      .catch(() => {
        // The old socket remains useful; the deadline owns eventual recovery.
      })
      .finally(() => this.finishAttempt(preparation));
  }

  private forceReconnect(): void {
    const generation = this.generation;
    this.cancelRotation();
    this.retireSocket();
    if (this.isCurrentGeneration(generation)) this.scheduleReconnect();
  }

  /** Persistent bounded retries; a failed attempt never stops the meeting. */
  private scheduleReconnect(minimumDelay = 0, reason = 'WS dropped'): void {
    if (this._status !== 'running' || this.reconnectTimer !== null || this.reconnectInFlight)
      return;
    const generation = this.generation;
    const idx = Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const delayMs = Math.min(2_147_483_647, Math.max(RECONNECT_BACKOFF_MS[idx]!, minimumDelay));
    this.reconnectAttempts += 1;
    this.emitHealth(
      'transport',
      'reconnecting',
      `${this.freshSessionFallback ? 'Gemini resumption could not connect; trying a new session (context may be interrupted)' : reason} — retry ${this.reconnectAttempts} in ${delayMs / 1000}s`,
    );
    if (!this.isCurrentGeneration(generation)) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      this.reconnectInFlight = true;
      this.emitHealth(
        'transport',
        'reconnecting',
        this.freshSessionFallback
          ? 'Trying a new Gemini session; context may be interrupted'
          : 'Gemini reconnect handshake in progress',
      );
      if (!this.isCurrentGeneration(generation)) return;
      this.connectAttempt(generation)
        .then(() => {
          if (this.isCurrentGeneration(generation)) this.reconnectInFlight = false;
        })
        .catch((error: unknown) => {
          if (!this.isCurrentGeneration(generation)) return;
          this.reconnectInFlight = false;
          if (error instanceof SetupAbortedError) return;
          this.retryAfterFailure(error);
        });
    }, delayMs);
  }

  private retryAfterFailure(error: unknown): void {
    const generation = this.generation;
    if (!this.isCurrentGeneration(generation)) return;
    const failure = normalizeRecoveryError(error, 'gemini', 'translation');
    const gate = recoveryFailureFor('gemini', 'translation');
    const retryDelay = Math.max(0, (gate?.retryNotBeforeMs ?? 0) - performance.now());
    if (!permanentRecoveryFailure(gate)) this.scheduleReconnect(retryDelay);
    if (!this.isCurrentGeneration(generation)) return;
    const detail = this.freshSessionFallback
      ? 'Gemini resumed setup failed; trying a new session (context may be interrupted)'
      : error instanceof RecoveryError
        ? error.message
        : error instanceof GeminiSocketCloseError
          ? error.message
          : 'Gemini reconnect attempt failed';
    this.emitHealth(
      'transport',
      'failed',
      `${detail} — ${permanentRecoveryFailure(gate) ? '請修正服務設定後手動重試' : 'retry scheduled — you can switch backend'}`,
      failure.failure,
    );
  }

  private isCurrentGeneration(generation: number): boolean {
    return this._status === 'running' && this.generation === generation;
  }

  private async startAudioCapture(generation: number, signal: AbortSignal): Promise<void> {
    if (!this.stream) return;
    // The shared context is engine-owned; a provider must never close it.
    const ctx = getCaptureContext();
    if (!ctx) {
      const error = new Error('AudioContext unavailable — cannot capture audio');
      this.emitHealth('audio', 'failed', error.message);
      throw error;
    }
    try {
      this.audioCtx = ctx;
      await ensureCaptureWorklet(ctx, signal);
      if (!this.isCurrentGeneration(generation) || !this.stream) return;
      this.sourceNode = ctx.createMediaStreamSource(this.stream);
      const source = this.sourceNode;
      const targetSampleRate = ctx.sampleRate > 16_000 ? 16_000 : ctx.sampleRate;
      const resampleState: ResampleState = { pos: 0, last: 0 };
      this.workletNode = new AudioWorkletNode(ctx, 'pcm-worklet', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { chunkSize: pcmChunkSizeForRate(ctx.sampleRate, GEMINI_PCM_CHUNK_SIZE) },
      });
      const captureHealth = (this.captureHealth = monitorCaptureHealth({
        context: ctx,
        stream: this.stream,
        onHealth: (event) => {
          if (this.isCurrentGeneration(generation)) this.handlers.onHealth(event);
        },
      }));
      this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (!this.isCurrentGeneration(generation)) return;
        captureHealth.frame(ev.data.byteLength / 4);
        if (
          !this.isCurrentGeneration(generation) ||
          !this.setupReady ||
          !this.ws ||
          this.ws.readyState !== WebSocket.OPEN
        )
          return;
        // Backpressure guard (mirrors OfflineSTTProvider): a stalled-but-OPEN
        // socket would otherwise grow the browser send buffer without bound
        // over a long meeting. Drop frames above the threshold, surface the
        // symptom, and force a reconnect on sustained backpressure.
        if (this.ws.bufferedAmount > GeminiLiveProvider.WS_BACKPRESSURE_THRESHOLD) {
          this.wsBackpressureDropCount += 1;
          this.wsBackpressureConsecutiveDrops += 1;
          if (
            this.wsBackpressureConsecutiveDrops === 1 ||
            this.wsBackpressureDropCount % 50 === 0
          ) {
            this.emitHealth(
              'transport',
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
            this.forceReconnect();
          }
          return;
        }
        const resumingDelivery = this.wsBackpressureConsecutiveDrops > 0;
        const rawSamples = new Float32Array(ev.data);
        const samples =
          ctx.sampleRate > 16_000
            ? resamplePcm(rawSamples, ctx.sampleRate, targetSampleRate, resampleState)
            : rawSamples;
        if (samples.length === 0) return;
        const pcm16 = floatTo16BitPCM(samples);
        const b64 = arrayBufferToBase64(pcm16);
        this.ws.send(
          JSON.stringify({
            realtimeInput: { audio: { data: b64, mimeType: `audio/pcm;rate=${targetSampleRate}` } },
          }),
        );
        this.wsBackpressureConsecutiveDrops = 0;
        if (resumingDelivery)
          this.emitHealth(
            'transport',
            'connected',
            'Audio delivery resumed; waiting for new content',
          );
      };
      source.connect(this.workletNode);
      this.workletNode.connect(ctx.destination);
      await resumeCaptureContext(signal);
    } catch (err) {
      if (!this.isCurrentGeneration(generation)) return;
      // A live source can outlast a slow/rejected local graph initialization.
      // Keep automatic meeting recovery eligible; start() reports the failed
      // attempt and cleans up. Source permission/ended failures remain fatal.
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.emitHealth('audio', 'degraded', `Audio capture could not start — ${detail}`);
      throw err;
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
      // the last caption text; if audio is clearly flowing in but the server
      // has gone silent past the threshold, the session is wedged — force a
      // reconnect. lastServerContentAt === 0 means the detector is disarmed
      // (not yet connected, or already reconnecting), so we skip it then.
      if (this.captureHealth && !this.captureHealth.healthy) {
        this.lastServerContentAt = now;
        this.audioActiveSamplesSinceContent = 0;
      } else if (rmsDb > audioActiveDb) this.audioActiveSamplesSinceContent += 1;
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
            {
              layer: 'provider',
              kind: 'stalled',
              provider: 'gemini',
              purpose: 'translation',
              attemptId: crypto.randomUUID(),
            },
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
        source: this.sourceKind,
        rmsDb,
        peakDb,
        timestamp: iso(),
      };
      this.handlers.onAudioLevel(ev);
    }, 100);
  }

  /**
   * Release everything on the capture side. Split out of cleanup() because Stop
   * has to cut the microphone immediately while the socket stays open a moment
   * longer to collect the tail — Stop must mean the OS mic indicator goes out
   * now, not in three seconds. Idempotent: cleanup() calls it again.
   */
  private stopCapture(): void {
    this.captureHealth?.dispose();
    this.captureHealth = null;
    this.captureController?.abort(new SetupAbortedError());
    this.captureController = null;
    if (this.levelInterval !== null) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.sourceNode?.disconnect?.();
    // Do NOT close the context — it is the shared engine context reused next
    // session. Closing it would force a cold rebuild + worklet recompile.
    this.workletNode = null;
    this.sourceNode = null;
    this.audioCtx = null;
    this.mic.release();
    this.stream = null;
  }

  private cleanup(): void {
    // Settle any pending handshake BEFORE dropping the socket reference — after
    // `this.ws = null` the onclose stale-socket guard can no longer settle it.
    this.settleSetupOnTeardown?.();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Cancel pending rotation/token work so it cannot outlive this session.
    this.cancelRotation();
    this.attempt?.cancel(new SetupAbortedError());
    this.attempt = null;
    this.reconnectInFlight = false;
    this.setupReady = false;
    this.reconnectAttempts = 0;
    this.resumedSetupFailures = 0;
    this.freshSessionFallback = false;
    this.resumptionHandle = null;
    this.lastServerContentAt = 0;
    this.audioActiveSamplesSinceContent = 0;
    this.wsBackpressureDropCount = 0;
    this.wsBackpressureConsecutiveDrops = 0;
    this.stopCapture();
    this.ws?.close();
    this.ws = null;
  }

  private emitHealth(
    component: string,
    state: string,
    message?: string,
    recoveryFailure?: HealthEvent['recoveryFailure'],
  ): void {
    const ev: HealthEvent = {
      kind: 'health',
      component: component as HealthEvent['component'],
      state: state as HealthEvent['state'],
      timestamp: iso(),
    };
    if (message !== undefined) ev.message = message;
    if (recoveryFailure !== undefined) ev.recoveryFailure = recoveryFailure;
    this.handlers.onHealth(ev);
  }
}
