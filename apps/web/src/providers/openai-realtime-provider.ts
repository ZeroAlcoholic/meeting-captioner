import type {
  AudioLevelEvent,
  AudioSourceKind,
  HealthComponent,
  HealthEvent,
  HealthState,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import { WarmTokenCache } from './token-prewarm.js';
import { serviceFetch } from './service-fetch.js';
import {
  createRecoveryAttempt,
  type RecoveryAttempt,
  assertRecoveryAllowed,
  recoveryHttpError,
  normalizeRecoveryError,
  recoveryFailureFor,
  permanentRecoveryFailure,
  recoveryError,
  protocolRecoveryKind,
} from './recovery-attempt.js';
import { OpenAIWsOpenError, OpenAIWsTransport } from './openai-ws-transport.js';
import { monitorWebRtcCapture } from './capture-health.js';
// gpt-realtime-translate only outputs 'zh' (Simplified); captions are Taiwanese.
import { loadTranscriptNormalizer, toTaiwanese } from './transcript-normalization.js';
import type {
  AudioSource,
  CaptionProvider,
  CaptionProviderHandlers,
  ProviderStatus,
} from './types.js';

const OPENAI_TRANSLATION_CALLS_URL = 'https://api.openai.com/v1/realtime/translations/calls';

const SEGMENT_FLUSH_MS = 1000;
// Absolute upper bound on a single segment's duration. Without this a
// continuous monologue (no >1 s gap between deltas) NEVER hits the
// debounce-based flush above, so no `final` ever lands → segments[] stays
// empty → HistoryStream is permanently blank → LiveCaption shows a single
// unbounded partial that visually "freezes" on whatever scrolled off the
// screen first. 12 s gives natural paragraph rhythm for both presenter
// monologues and rapid Q&A, and bounds the live partial's text length
// so the rendering cost per delta stays flat.
const MAX_SEGMENT_DURATION_MS = 12_000;
const RENEWAL_PEER_READY_TIMEOUT_MS = 10_000;
const RETIRED_DRAIN_CAP_MS = 10_000;
const RETIRED_DRAIN_GRACE_MS = 250;

class RenewalCancelledError extends Error {}
const AUDIO_LEVEL_INTERVAL_MS = 100;
const PEAK_HOLD_MS = 2000;
const PEAK_DECAY_DB_PER_TICK = 0.1;
// Fallback if /session reply omits the renewal hint. Matches server default.
const DEFAULT_SESSION_RENEW_MS = 25 * 60 * 1000;
// A transient ICE disconnect may recover without negotiation. If it persists,
// rebuild the complete negotiated session; restartIce() alone sends no SDP.
const ICE_RECOVERY_GRACE_MS = 3_000;
// Persistent renewal-retry backoff: 1s → 3s → 8s → 20s → 1m → 3m → 5m → 10m
// cap forever.
//
// The first rung is the one that matters. Most renewal failures are a blip —
// upstream is fine again seconds later — and until we retry, captions are dark.
// So the first rung IS the outage length for the common case. It has come down
// twice: 5 min, then 30 s, and 30 s was still thirty seconds of a frozen board
// caused entirely by our own schedule rather than by anything upstream
// (measured: 30031 ms, see docs/FAILOVER_BASELINE_2026-08-12.md).
//
// The tail still climbs steeply, so a genuine outage — rate limit, hard down —
// is not hammered: five attempts in the first half-minute, then minutes apart.
const RENEWAL_RETRY_BACKOFF_MS = [
  1000,
  3000,
  8000,
  20 * 1000,
  60 * 1000,
  3 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
];

// Stale-data detection. If we observe RMS above the silence floor for a
// stretch AND no DataChannel deltas have arrived in the last threshold,
// the upstream session is wedged (DC open, no events) — force a renewal.
// Without this, OpenAI hiccups manifest as a frozen caption area with
// "Connected" health, with no way for the user to know.
const STALE_DATA_THRESHOLD_MS = 30_000;
// Per-micDistance audio-active threshold. A flat -40 dB was tuned for
// close/headset mics (typical RMS ~-25 dB) but completely missed Far-field
// mics (~-42 dB) and Raw signal (~-48 dB) — the wedge detector silently
// did nothing for those configurations because no sample ever counted as
// "audio active". Loosening with micDistance makes detection consistent
// across the three capture modes.
const STALE_AUDIO_ACTIVE_DB_BY_MIC: Record<'meeting' | 'close' | 'far' | 'off', number> = {
  // 'meeting' is raw multi-speaker room audio (no AGC) — similar low RMS to
  // far-field, so use the same loosened threshold.
  meeting: -48,
  close: -40,
  far: -48,
  off: -52,
};

function iso(): string {
  return new Date().toISOString();
}

interface DCEvent {
  type: string;
  delta?: string;
  elapsed_ms?: number;
  error?: { message?: string };
}

interface SegmentSnapshot {
  segmentId: string;
  startMs: number;
  endMs: number;
  input: string;
  output: string;
  continuationOf?: string;
}

const LANG_PAIR_META: Record<string, { src: string; tgt: string }> = {
  'en→zh-TW': { src: 'en', tgt: 'zh-TW' },
  'zh-TW→en': { src: 'zh-TW', tgt: 'en' },
};
const DEFAULT_META = { src: 'en', tgt: 'zh-TW' };

/** Which server-side OpenAI key minted a token. Names only — never key material. */
export type OpenAIKeySlot = 'primary' | 'audio';

interface SessionResponse {
  client_secret: { value: string; expires_at?: number };
  session_renewal_recommended_ms?: number;
  /** Slot that minted this token, so a downstream rejection can name it. */
  key_slot?: OpenAIKeySlot;
}

// Plain-language hints for the SDP-exchange failures we have actually observed,
// keyed by OpenAI's own error code. A bare "(401)" sent a diagnosis down the
// wrong path once already: the mint had succeeded, so every key/env check
// looked healthy, and the real cause — an org IP allowlist that covers the
// realtime MEDIA endpoint but not the mint endpoint — was invisible until the
// response body was read. Never throw away that body again.
const SDP_FAILURE_HINTS: Record<string, string> = {
  ip_not_authorized:
    "this network's egress IP is not on the OpenAI organisation's allowlist for the realtime call endpoint — the key can still mint tokens, which is why /session succeeded",
  invalid_api_key: 'the ephemeral token was not accepted — it may have expired before the exchange',
  session_expired: 'the ephemeral token expired before the SDP exchange completed',
};

/** Carries OpenAI's own status + error code so the UI can state the real cause. */
export class SdpExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null,
    readonly retryAfter: string | null = null,
  ) {
    const parts = [`OpenAI SDP exchange failed (${status}${code ? ` ${code}` : ''})`];
    if (detail) parts.push(detail);
    const hint = code !== null ? SDP_FAILURE_HINTS[code] : undefined;
    if (hint) parts.push(hint);
    super(parts.join(' — '));
    this.name = 'SdpExchangeError';
  }

  /** 401/403 = permission failure: worth retrying with the other server key. */
  get isAuthRejection(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Pull OpenAI's `error.code` / `error.message` out of a failed SDP response. */
async function readSdpError(res: Response): Promise<SdpExchangeError> {
  const raw = await res.text().catch(() => '');
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code ?? null;
    detail = parsed.error?.message ?? null;
  } catch {
    detail = raw.trim().slice(0, 200) || null;
  }
  return new SdpExchangeError(res.status, code, detail, res.headers.get('Retry-After'));
}

/** Classify only after the existing transport/key choices have been exhausted. */
function finalTransportFailure(error: unknown) {
  if (error instanceof SdpExchangeError) {
    return recoveryHttpError(
      new Response(null, {
        status: error.status,
        headers: error.retryAfter === null ? {} : { 'Retry-After': error.retryAfter },
      }),
      'openai',
      'translation',
    );
  }
  if (error instanceof OpenAIWsOpenError && error.isAuthRejection) {
    return recoveryError(
      'auth',
      'openai',
      'translation',
      'OpenAI rejected the connection credentials',
    );
  }
  return normalizeRecoveryError(error, 'openai', 'translation');
}

export interface SessionRequestBody {
  langPair: string;
  includeSourceTranscript: boolean;
  micDistance: 'meeting' | 'close' | 'far' | 'off';
}

/** The exact /session POST body — shared by the live provider and the pre-mint
 * path so a pre-warmed token's request key matches the real Start request. */
export function sessionRequestBody(
  langPair: string,
  includeSourceTranscript: boolean,
  micDistance: 'meeting' | 'close' | 'far' | 'off',
): SessionRequestBody {
  return { langPair, includeSourceTranscript, micDistance };
}

async function postSession(
  url: string,
  body: SessionRequestBody,
  /**
   * Slot whose token was just rejected downstream. The server demotes it and
   * mints from the other key. Deliberately NOT part of SessionRequestBody:
   * the warm-token cache keys on that object, and a retry must not be able to
   * collide with (or evict) the normal pre-warmed entry.
   */
  rejectedSlot: OpenAIKeySlot | undefined,
  signal: AbortSignal,
): Promise<SessionResponse> {
  signal.throwIfAborted();
  assertRecoveryAllowed('openai', 'translation');
  const res = await serviceFetch(url, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rejectedSlot === undefined ? body : { ...body, rejectedSlot }),
  });
  signal.throwIfAborted();
  if (!res.ok) throw recoveryHttpError(res, 'openai', 'translation');
  return (await res.json()) as SessionResponse;
}

function sessionExpiryMs(r: SessionResponse): number | null {
  return r.client_secret.expires_at !== undefined ? r.client_secret.expires_at * 1000 : null;
}

// Process-wide warm cache (single live session at a time → one entry is enough).
const warmSession = new WarmTokenCache<SessionResponse>();
const warmKey = (url: string, body: SessionRequestBody): string => `${url}|${JSON.stringify(body)}`;

/**
 * Pre-mint a /session token for `body` into the warm cache while the app is idle,
 * so the next matching Start skips the token round-trip. Best-effort + single-use
 * (see WarmTokenCache). Online-only caller (the hook gates on apiKeyStatus).
 */
export function prewarmOpenAISession(
  url: string,
  body: SessionRequestBody,
  refreshIfOlderThanMs?: number,
): void {
  void warmSession.prewarm(
    warmKey(url, body),
    async (signal) => {
      const attempt = createRecoveryAttempt({
        parentSignal: signal,
        generation: 0,
        isCurrent: () => true,
        label: 'OpenAI token prewarm',
      });
      try {
        return await attempt.run((requestSignal) =>
          postSession(url, body, undefined, requestSignal),
        );
      } finally {
        attempt.dispose();
      }
    },
    sessionExpiryMs,
    refreshIfOlderThanMs,
  );
}

export function cancelOpenAIPrewarm(): void {
  warmSession.clear();
}

/** Test hook: drop any pre-warmed token so it can't leak across tests. */
export function __resetWarmSessionForTests(): void {
  warmSession.clear();
}

// ── Transport selection ──────────────────────────────────────────────────────
//
// OpenAI exposes the SAME realtime translation session over two transports, and
// they are not equally available: on 2026-08-20 the corporate service-account
// key was refused at `POST /v1/realtime/**/calls` (WebRTC) with
// `401 ip_not_authorized` while the WebSocket transport accepted it and
// produced captions normally. WebRTC stays the default — it owns jitter
// buffering, loss concealment and its own congestion control, which a
// TCP WebSocket cannot match on a lossy link — but a refusal now costs one
// switch instead of the whole meeting.
//
// The block is per KEY SLOT (the refusal is a property of the credential's
// organisation, not of this machine) and time-boxed, so WebRTC is re-probed
// once the upstream fault is fixed. Make-before-break renewal means that
// re-probe never interrupts live captions.
const WEBRTC_BLOCK_TTL_MS = 30 * 60 * 1000;
const webrtcBlockedUntil = new Map<string, number>();

function isWebRtcBlockedFor(slot: string): boolean {
  const until = webrtcBlockedUntil.get(slot);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    webrtcBlockedUntil.delete(slot);
    return false;
  }
  return true;
}

function blockWebRtcFor(slot: string): void {
  webrtcBlockedUntil.set(slot, Date.now() + WEBRTC_BLOCK_TTL_MS);
}

type WsOpener = (
  token: string,
  stream: MediaStream,
  handlers: Parameters<typeof OpenAIWsTransport.open>[2],
  signal?: AbortSignal,
) => Promise<OpenAIWsTransport>;

let wsOpener: WsOpener = (token, stream, handlers, signal) =>
  OpenAIWsTransport.open(token, stream, handlers, signal);

/** Test hooks: swap the WebSocket transport and clear the per-slot block. */
export function __setOpenAIWsOpenerForTests(opener: WsOpener | null): void {
  wsOpener = opener ?? ((t, st, h, signal) => OpenAIWsTransport.open(t, st, h, signal));
}
export function __resetOpenAITransportBlocksForTests(): void {
  webrtcBlockedUntil.clear();
}

interface LocalPeer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  offerSdp: string;
  terminalError: Error | null;
  onTerminal: ((error: Error) => void) | null;
  sessionCreated: boolean;
  onSessionCreated: (() => void) | null;
}

function assertPeerUsable(peer: LocalPeer): void {
  if (peer.terminalError) {
    peer.pc.close();
    throw peer.terminalError;
  }
  if (peer.dc.readyState === 'closing' || peer.dc.readyState === 'closed') {
    peer.pc.close();
    throw new Error('OpenAI caption data channel closed before activation');
  }
}

export class OpenAIRealtimeProvider implements CaptionProvider {
  private captureHealth: Awaited<ReturnType<typeof monitorWebRtcCapture>> | null = null;
  readonly name = 'openai-realtime';

  private _status: ProviderStatus = 'idle';
  private lifecycle = new AbortController();
  private generation = 0;
  private activeSessionUsable = false;
  private activeSessionClosed = false;
  // Subscribers notified whenever _status transitions. The hook uses this
  // to keep React state in sync with the provider's internal lifecycle —
  // critical during renewal: the provider may transition running → idle →
  // running (transparent renewal) or running → stopped (entered retry
  // backoff) without the consumer ever calling stop(), and the UI must
  // reflect those changes or it shows "running" over dead captions.
  private statusListeners: Set<(s: ProviderStatus) => void> = new Set();
  private pc: RTCPeerConnection | null = null;
  // Set instead of `pc` when the session runs over the WebSocket transport.
  // Exactly one of the two is non-null while connected.
  private wsTransport: OpenAIWsTransport | null = null;
  private dc: RTCDataChannel | null = null;
  private retired: { finish: (emit?: boolean) => SegmentSnapshot | undefined } | null = null;
  private stopComplete: Promise<void> = Promise.resolve();
  private readonly mic: AudioSource;
  // The acquired mic MediaStream, persisted ACROSS renewals. Make-before-break
  // renewal re-uses these exact tracks for the new peer connection instead of
  // releasing + re-acquiring the device — no OS mic-indicator blink, no
  // getUserMedia re-prompt, and no transient capture failure every 25 minutes.
  // Released only on full stop()/cleanup().
  private stream: MediaStream | null = null;
  private pendingAcquisition: Promise<MediaStream> | null = null;
  // Re-entrancy guard: a renewal can be triggered concurrently by the 25-min
  // timer, an ICE/connection failure, a session.closed event, the stale
  // detector, and the retry backoff. Only one make-before-break swap may run at
  // a time, or two new peers would race to become this.pc.
  private renewing = false;
  private renewalAttempt = 0;
  private cancelPendingRenewalPeer: (() => void) | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private segmentFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  // Absolute-deadline timer paired with segmentFlushTimer. Set on the first
  // delta of a segment, never reset on subsequent deltas — guarantees the
  // segment flushes after MAX_SEGMENT_DURATION_MS even under continuous
  // speech. Cleared in flushSegment() so the next segment starts fresh.
  private segmentDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private renewScheduledAtMs = 0;
  private renewDelayMs = DEFAULT_SESSION_RENEW_MS;
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalRetryAttempt = 0;
  // Stale-data detection state.
  private lastDcEventAt = 0;
  private lastAudioActiveAt = 0;
  // Cumulative count of audio-active samples (>STALE_AUDIO_ACTIVE_DB)
  // observed SINCE the last DC event. The 100 ms polling tick means each
  // tick is one sample; 100 samples ≈ 10 s of cumulative active speech.
  // Natural sentence pauses (silent ticks) don't subtract — they just
  // don't add. This is the fix for the previous stretch-based detector
  // that reset on every >1 s pause and consequently never fired during
  // real meeting speech (which has natural micro-pauses every few seconds).
  private audioActiveSamplesSinceDc = 0;
  // Silence-detection state. Emits 'silence_detected' after the user has
  // been quiet for SILENCE_DETECT_MS; emits 'connected' when speech resumes.
  // Guards with silenceEmitted so we only emit once per silence window, not
  // on every 100 ms tick while the user is still quiet.
  private silenceEmitted = false;
  // Diagnostic counters — surfaced via periodic console dump so silent
  // WebRTC wedges leave forensic evidence in DevTools. inputDeltaCount /
  // outputDeltaCount let a field operator confirm the suspected asymmetry:
  // if outputDeltaCount climbs while inputDeltaCount stays ~0, the source
  // whisper transcript is lagging/absent — the live-anchor path is what
  // keeps captions visible in that case.
  private dcEventCount = 0;
  private inputDeltaCount = 0;
  private outputDeltaCount = 0;
  private diagInterval: ReturnType<typeof setInterval> | null = null;
  private inputAcc = '';
  private outputAcc = '';
  private currentSegmentId = '';
  private continuationOf: string | undefined;
  private startMs = 0;

  constructor(
    private readonly sessionUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    private readonly langPair: string = 'en→zh-TW',
    mic?: AudioSource,
    /**
     * Forwarded verbatim to the /session POST body. When false, the server
     * omits `audio.input.transcription` from the upstream OpenAI payload,
     * so only translation deltas arrive (no `session.input_transcript.delta`).
     */
    private readonly includeSourceTranscript: boolean = true,
    /**
     * 'meeting' | 'close' | 'far' | 'off' — drives both getUserMedia AGC and
     * the upstream noise_reduction config (kept in lockstep so the audio
     * path is internally consistent).
     */
    private readonly micDistance: 'meeting' | 'close' | 'far' | 'off' = 'meeting',
    /**
     * Stamped onto every event so downstream consumers know what was actually
     * captured. It has to be passed in: the provider cannot infer it, and
     * guessing from micDistance would be wrong the moment someone picks the
     * 'off' profile for an actual microphone.
     */
    private readonly sourceKind: AudioSourceKind = 'microphone',
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider();
  }

  get status(): ProviderStatus {
    return this._status;
  }

  /**
   * Subscribe to provider status transitions. Returns an unsubscribe function.
   * Used by the React hook to keep its useState in lockstep with the provider
   * so the UI can't display "running" while the provider has fallen into
   * retry-backoff stopped state behind its back.
   */
  onStatus(fn: (s: ProviderStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: ProviderStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.notifyStatus(s);
  }

  private notifyStatus(s: ProviderStatus): void {
    for (const fn of this.statusListeners) {
      if (this._status !== s) return;
      try {
        fn(s);
      } catch {
        /* listener errors must not corrupt provider state */
      }
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation && this._status === 'running';
  }

  /** Milliseconds remaining before the next scheduled session renewal, or null when no renewal is pending. */
  getRenewalEtaMs(): number | null {
    if (this.renewTimer === null || this.renewScheduledAtMs === 0) return null;
    const due = this.renewScheduledAtMs + this.renewDelayMs;
    return Math.max(0, due - Date.now());
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    const previousGeneration = this.generation;
    this.retired?.finish();
    // Final-caption subscribers can synchronously start the successor.
    if (this.generation !== previousGeneration) return;
    this.lifecycle.abort(new RenewalCancelledError('Superseded by Start'));
    this.lifecycle = new AbortController();
    const generation = ++this.generation;
    this.setStatus('running');
    if (!this.isCurrentGeneration(generation)) return;
    this.activeSessionUsable = false;
    this.activeSessionClosed = false;
    this.newSegment();
    // Runs alongside the permission prompt and the mint; awaited before the
    // session can carry text, so no caption is ever published unconverted.
    const normalizer = loadTranscriptNormalizer();
    normalizer.catch(() => {});

    // Robustness: each await can yield control. If the caller invokes stop()
    // between awaits, cleanup() nulls this.pc and the next line would NPE.
    // This guard short-circuits the bring-up so partial state never reaches
    // user-visible UI events or the dc handler attachment. Read through the
    // public getter so TS does not narrow _status to a literal that defeats
    // the check.
    const aborted = (): boolean => this.status !== 'running' || generation !== this.generation;

    this.emitHealth('transport', 'connecting');
    if (aborted()) return;

    // Step 1: mic acquisition. Failures here are AUDIO failures, not transport.
    let stream: MediaStream;
    try {
      // Share within the current start only. Stop invalidates the lease's
      // pending permission request; its late stream must never serve a new start.
      this.pendingAcquisition ??= this.mic.acquire(this.handlers.onHealth);
      stream = await this.pendingAcquisition;
    } catch {
      if (this.status !== 'running') this.pendingAcquisition = null;
      if (aborted()) return;
      this.pendingAcquisition = null;
      // Provider contract: AudioSource.acquire() MUST emit its own precise
      // health event before throwing (MicrophoneAudioProvider emits 'failed';
      // DisplayMediaAudioProvider distinguishes 'failed' from 'no_audio_track'
      // for the "user picked a window without system audio" case). We
      // deliberately do NOT re-emit here — the previous emit('failed') was
      // clobbering DisplayMediaAudioProvider's more specific 'no_audio_track'
      // state, losing the actionable distinction the UI needs to coach the
      // user to tick the "Share audio" checkbox.
      this.finishSession(false);
      return;
    }
    if (aborted()) {
      // Release only this source's lease, never shared tracks. A newer Start
      // owns an independent request on this lease and must not be released here.
      if (this.status !== 'running') {
        this.pendingAcquisition = null;
        this.mic.release();
      }
      return;
    }
    this.pendingAcquisition = null;
    // Persist for make-before-break renewal — re-used, not re-acquired.
    this.stream = stream;

    try {
      await normalizer;
    } catch {
      if (aborted()) return;
      this.emitHealth('transport', 'failed', '繁體字典載入失敗，字幕無法以台灣用詞顯示');
      this.finishSession(false);
      return;
    }
    if (aborted()) return;

    // Permission waits do not consume the network attempt budget.
    const attempt = this.createAttempt();
    const tokenPromise = this.fetchSessionToken(attempt).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // Step 2+: peer build + SDP exchange. TRANSPORT failures.
    try {
      // Build the local offer NOW — it needs only the mic, not the token — so
      // ICE candidate gathering runs IN PARALLEL with the still-in-flight token
      // mint. By the time the token arrives, localDescription carries the STUN
      // candidates gathered during that window, so exchangeSdp POSTs a
      // candidate-enriched offer at zero added latency.
      const conn = await this.createLocalOffer(this.stream, attempt);
      if (conn === null || aborted()) {
        conn?.pc.close();
        return;
      }

      const token = await tokenPromise;
      if (token.ok === false) {
        conn.pc.close();
        throw token.error instanceof Error ? token.error : new Error('Session token fetch failed');
      }
      const sessionData = token.value;
      if (sessionData === null || aborted()) {
        conn.pc.close();
        return;
      }
      const { client_secret } = sessionData;
      this.renewDelayMs = sessionData.session_renewal_recommended_ms ?? DEFAULT_SESSION_RENEW_MS;

      // Guard against an already-expired or imminently-expiring token.
      // expires_at is Unix seconds; if less than 60 s remain, skip SDP
      // and go straight to renewSession() which will fetch a fresh token.
      // This handles clock drift and the edge case where a cached /session
      // response is replayed after the tab sleeps through the 25-min mark.
      // Status stays 'running' (mic is already acquired into this.stream) so
      // renewSession's make-before-break path brings the session up against a
      // null old peer — recovering cleanly instead of stalling in 'idle'.
      if (client_secret.expires_at !== undefined) {
        const remainingMs = client_secret.expires_at * 1000 - Date.now();
        if (remainingMs < 60_000) {
          conn.pc.close(); // discard the un-exchanged peer; renewSession rebuilds
          this.emitHealth(
            'transport',
            'reconnecting',
            'Session token near expiry — refreshing before connect',
          );
          await this.renewSession(attempt);
          if (aborted()) return;
          if (!this.isPrimaryHealthy())
            throw new Error('Session refresh did not establish a ready transport');
          return;
        }
      }

      const outcome = await this.connectSession(sessionData, conn, attempt);
      if (outcome.kind === 'aborted' || aborted()) {
        if (outcome.kind === 'webrtc') outcome.pc.close();
        if (outcome.kind === 'websocket') outcome.transport.close();
        return;
      }
      if (outcome.kind === 'webrtc') {
        await this.waitForRenewalPeer(outcome, attempt);
        if (aborted()) {
          outcome.pc.close();
          return;
        }
        assertPeerUsable(outcome);
        if (outcome.pc.connectionState !== 'connected') {
          outcome.pc.close();
          throw new Error('Initial peer lost readiness before activation');
        }
        this.activeSessionUsable = true;
        this.activeSessionClosed = false;
        this.pc = outcome.pc;
        this.wirePeer(outcome.pc, outcome.dc);
      } else {
        this.activeSessionUsable = true;
        this.activeSessionClosed = false;
        this.wsTransport = outcome.transport;
        outcome.transport.activate();
      }
      // SDP acceptance precedes ICE/DTLS readiness. Keep the startup cue at
      // "connecting" until media can flow, so the user is not told to speak
      // while the opening words would still be discarded.
      if (outcome.kind === 'websocket' || outcome.pc.connectionState === 'connected') {
        this.emitHealth('transport', 'connected');
      }

      if (aborted()) return;
      // Bring-up succeeded — any prior renewal-retry backoff state is now
      // moot. Reset the counter so a fresh failure later starts at 30 s,
      // not at whatever the previous failure escalated to.
      this.renewalRetryAttempt = 0;
      this.resetStaleBaselines();

      if (outcome.kind === 'webrtc' && this.stream) {
        try {
          const monitor = await monitorWebRtcCapture(
            this.stream,
            (event) => {
              if (!aborted() && this.pc && !this.wsTransport) this.handlers.onHealth(event);
            },
            this.lifecycle.signal,
          );
          if (aborted()) {
            monitor.dispose();
            return;
          }
          this.captureHealth = monitor;
        } catch (error) {
          if (aborted()) return;
          const generation = this.finishSession(false);
          if (this.generation === generation)
            this.emitHealth(
              'audio',
              'failed',
              error instanceof Error ? error.message : '收音監測無法啟動，請重新開始收音。',
            );
          return;
        }
      }
      if (aborted()) return;
      this.startLevelPolling();
      this.scheduleRenewal(this.renewDelayMs);
      this.startDiagnosticDump();
    } catch (err) {
      if (aborted()) return; // user already stopped; don't surface a misleading error
      const message = err instanceof Error ? err.message : 'Unknown error starting Realtime';
      const failure = finalTransportFailure(err);
      const finishedGeneration = this.finishSession(false);
      if (finishedGeneration === this.generation)
        this.emitHealth('transport', 'api_error', message, failure.failure);
    } finally {
      attempt.dispose();
    }
  }

  private createAttempt(): RecoveryAttempt {
    return createRecoveryAttempt({
      parentSignal: this.lifecycle.signal,
      generation: this.generation,
      isCurrent: (generation) => this.isCurrentGeneration(generation),
      label: 'OpenAI connection attempt',
    });
  }

  /**
   * POST /session for a fresh ephemeral token. Returns null if the provider was
   * stopped mid-flight; throws on a non-2xx response (transport failure).
   */
  private async fetchSessionToken(attempt: RecoveryAttempt): Promise<SessionResponse | null> {
    attempt.assertActive();
    assertRecoveryAllowed('openai', 'translation');
    const body = sessionRequestBody(this.langPair, this.includeSourceTranscript, this.micDistance);
    // Use a pre-warmed token if one was minted for this EXACT request and is
    // still fresh (single-use; consume clears it so a renewal mints fresh).
    const warm = warmSession.consume(warmKey(this.sessionUrl, body));
    if (warm) {
      // Honour the abort contract even on the fast path.
      return this.status === 'running' ? warm : null;
    }
    const session = await attempt.run((signal) =>
      postSession(this.sessionUrl, body, undefined, signal),
    );
    if (this.status !== 'running') return null;
    return session;
  }

  /**
   * Phase 1 of peer setup: build the RTCPeerConnection + DataChannel + local
   * offer over the GIVEN mic stream. Needs ONLY the mic — NOT the session token —
   * so the caller can run this in PARALLEL with the token mint. Crucially this
   * also starts ICE candidate gathering immediately (setLocalDescription), so
   * server-reflexive (STUN) candidates accrue DURING the token RTT and land in
   * localDescription. The SDP we later POST is then candidate-enriched at zero
   * added latency, which speeds the ICE/DTLS connect on NAT / corporate networks.
   * The DataChannel handler is left UNWIRED (see wirePeer) so make-before-break
   * can swap atomically. Returns null if stopped mid-flight (peer closed).
   */
  private async createLocalOffer(
    stream: MediaStream,
    attempt: RecoveryAttempt,
    candidate = false,
  ): Promise<LocalPeer | null> {
    attempt.assertActive();
    const signal = attempt.signal;
    const aborted = (): boolean => this.status !== 'running' || signal.aborted;
    // Configure ICE servers so corporate / strict-firewall networks can gather
    // server-reflexive candidates and complete the WebRTC handshake. Browsers'
    // built-in default works on home/open Wi-Fi but typically fails on
    // enterprise NAT. Google's public STUN is fine; the OpenAI session itself
    // still flows over the negotiated path.
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    // Caption-only UX: stop any incoming translated-voice track immediately so
    // the browser doesn't buffer PCM in memory.
    pc.ontrack = (ev: RTCTrackEvent) => {
      for (const track of ev.streams[0]?.getTracks() ?? []) track.stop();
    };
    const dc = pc.createDataChannel('oai-events');
    const peer: LocalPeer = {
      pc,
      dc,
      offerSdp: '',
      terminalError: null,
      onTerminal: null,
      sessionCreated: false,
      onSessionCreated: null,
    };
    dc.onmessage = (message: MessageEvent<string>) => {
      let event: DCEvent;
      try {
        event = JSON.parse(message.data) as DCEvent;
      } catch {
        return;
      }
      if (event.type === 'session.created') {
        peer.sessionCreated = true;
        peer.onSessionCreated?.();
        return;
      }
      if (event.type !== 'session.closed' && event.type !== 'error') return;
      const error = new Error(
        event.error?.message ?? 'OpenAI candidate session closed before activation',
      );
      peer.terminalError = error;
      peer.onTerminal?.(error);
    };
    // Display capture requires a video track for browser permission UX, but
    // this provider is audio-only. Keep video out of the OpenAI SDP.
    if (candidate) {
      // Negotiate an audio sender without duplicating live meeting input.
      stream
        .getAudioTracks()
        .forEach(() => pc.addTransceiver('audio', { direction: 'sendrecv', streams: [stream] }));
    } else stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    try {
      return await attempt.run(async (offerSignal) => {
        const offer = await pc.createOffer();
        if (aborted() || offerSignal.aborted) {
          pc.close();
          return null;
        }
        await pc.setLocalDescription(offer); // ICE candidate gathering starts here
        if (aborted() || offerSignal.aborted) {
          pc.close();
          return null;
        }
        assertPeerUsable(peer);
        peer.offerSdp = offer.sdp ?? '';
        return peer;
      });
    } catch (error) {
      pc.close();
      throw error;
    }
  }

  /**
   * Phase 2 of peer setup: exchange SDP with OpenAI using the session token.
   * POSTs the candidate-enriched localDescription (falling back to the original
   * offer SDP when localDescription is unavailable, e.g. test mocks) and applies
   * the answer. Returns false if stopped mid-flight; throws on a non-2xx SDP
   * exchange. The caller owns closing `pc` on failure/early-out.
   */
  private async exchangeSdp(
    pc: RTCPeerConnection,
    offerSdp: string,
    secretValue: string,
    attempt: RecoveryAttempt,
  ): Promise<boolean> {
    const signal = attempt.signal;
    const aborted = (): boolean => this.status !== 'running' || signal.aborted;
    return attempt.run(async (requestSignal) => {
      // localDescription accrues ICE candidates after setLocalDescription — prefer
      // it so the offer we send is as complete as it can be by now.
      const sdp = pc.localDescription?.sdp ?? offerSdp;
      const sdpRes = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
        signal: requestSignal,
        method: 'POST',
        headers: { Authorization: `Bearer ${secretValue}`, 'Content-Type': 'application/sdp' },
        body: sdp,
      });
      if (aborted() || requestSignal.aborted) return false;
      if (!sdpRes.ok) throw await readSdpError(sdpRes);
      const sdpText = await sdpRes.text();
      if (aborted() || requestSignal.aborted) return false;
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpText });
      if (aborted() || requestSignal.aborted) return false;
      return true;
    });
  }

  /**
   * Bring the session up, trying every combination that can still work, in the
   * order that preserves the most: transport quality first, then the
   * organisation the credential belongs to, and only then the credential
   * itself.
   *
   *   1. WebRTC with the token we already hold  (best media path)
   *   2. WebSocket with the SAME token          (keeps the corporate org)
   *   3. WebRTC with the alternate key          (reuses the built peer)
   *   4. WebSocket with the alternate key
   *
   * Why this order and not "switch keys first": the failure that put this here
   * is a refusal of the WebRTC *call* endpoint for one organisation's key,
   * while every other endpoint - including the WebSocket transport - accepts
   * it. Switching keys first would silently move corporate meeting audio into
   * the personal account that owns the alternate key. Switching TRANSPORT
   * first keeps the meeting where it belongs, and the other key is reached for
   * only when the credential itself is the problem.
   *
   * Steps 3-4 reuse the peer built for step 1: a rejected SDP exchange sets no
   * remote description, so the same offer can be re-POSTed with a fresh token
   * instead of paying for another createOffer + ICE gathering round.
   */
  private async connectSession(
    sessionData: SessionResponse,
    offer: LocalPeer | null,
    attempt: RecoveryAttempt,
  ): Promise<
    | ({ kind: 'webrtc' } & LocalPeer)
    | { kind: 'websocket'; transport: OpenAIWsTransport }
    | { kind: 'aborted' }
  > {
    const aborted = (): boolean => this.status !== 'running' || attempt.signal.aborted;
    attempt.assertActive();
    const slotA = sessionData.key_slot ?? 'unknown';
    let firstError: Error | null = null;

    // 1. WebRTC, current key.
    if (offer !== null && !isWebRtcBlockedFor(slotA)) {
      try {
        const ok = await this.exchangeSdp(
          offer.pc,
          offer.offerSdp,
          sessionData.client_secret.value,
          attempt,
        );
        if (!ok) {
          offer.pc.close();
          return { kind: 'aborted' };
        }
        assertPeerUsable(offer);
        return Object.assign(offer, { kind: 'webrtc' as const });
      } catch (err) {
        if (attempt.signal.aborted) {
          offer.pc.close();
          throw attempt.signal.reason;
        }
        if (!(err instanceof SdpExchangeError) || !err.isAuthRejection) {
          offer.pc.close();
          throw err;
        }
        firstError = err;
        blockWebRtcFor(slotA);
        this.emitRecoveryProgress(`${err.message} - switching to the WebSocket transport`);
      }
    }
    if (aborted()) {
      offer?.pc.close();
      return { kind: 'aborted' };
    }

    // 2. WebSocket, SAME key - this is what keeps a refused WebRTC session
    //    inside its own organisation instead of failing over to another one.
    let wsAuthRejected = false;
    try {
      const transport = await this.openWsTransport(sessionData.client_secret.value, attempt);
      offer?.pc.close(); // the WebRTC peer is surplus now
      return { kind: 'websocket', transport };
    } catch (err) {
      if (aborted()) {
        offer?.pc.close();
        throw attempt.signal.reason;
      }
      attempt.assertActive();
      const wsError = err instanceof Error ? err : new Error(String(err));
      const priorError = firstError;
      firstError ??= wsError;
      wsAuthRejected = err instanceof OpenAIWsOpenError && err.isAuthRejection;
      // A network, timeout, or local capture failure says nothing about the
      // credential. Reporting rejectedSlot here would globally demote this key
      // and could move meeting audio to an alternate account without evidence.
      if (!wsAuthRejected) {
        offer?.pc.close();
        if (priorError !== null) {
          throw new Error(
            `${priorError.message} - WebSocket fallback also failed: ${wsError.message}`,
          );
        }
        throw wsError;
      }
    }
    if (aborted()) {
      offer?.pc.close();
      return { kind: 'aborted' };
    }

    // 3-4. Alternate key, both transports. Reachable only when this credential
    //      was rejected for an auth/permission reason on BOTH transports.
    //      Network, timeout, and local capture failures do not justify moving
    //      meeting audio to a different account.
    const rejectedSlot = sessionData.key_slot;
    if (rejectedSlot === undefined) {
      offer?.pc.close();
      throw firstError ?? new Error('OpenAI session could not be established');
    }
    attempt.assertActive();
    this.emitRecoveryProgress(
      wsAuthRejected
        ? `OpenAI refused the ${rejectedSlot} key on both transports - retrying with the alternate key`
        : `OpenAI rejected the ${rejectedSlot} key - retrying with the alternate key`,
    );
    attempt.assertActive();
    // Any pre-warmed token was minted from the slot that just failed.
    warmSession.clear();
    const body = sessionRequestBody(this.langPair, this.includeSourceTranscript, this.micDistance);
    let retrySession: SessionResponse;
    try {
      retrySession = await attempt.run((signal) =>
        postSession(this.sessionUrl, body, rejectedSlot, signal),
      );
    } catch (error) {
      offer?.pc.close();
      throw error;
    }
    if (aborted()) {
      offer?.pc.close();
      return { kind: 'aborted' };
    }
    // Server had no alternate key to switch to - surface the ORIGINAL,
    // concrete failure rather than an identical second one.
    if (retrySession.key_slot === rejectedSlot) {
      offer?.pc.close();
      throw firstError ?? new Error('OpenAI session could not be established');
    }
    this.renewDelayMs = retrySession.session_renewal_recommended_ms ?? this.renewDelayMs;
    const slotB = retrySession.key_slot ?? 'unknown';

    if (offer !== null && !isWebRtcBlockedFor(slotB)) {
      try {
        const ok = await this.exchangeSdp(
          offer.pc,
          offer.offerSdp,
          retrySession.client_secret.value,
          attempt,
        );
        if (!ok) {
          offer.pc.close();
          return { kind: 'aborted' };
        }
        assertPeerUsable(offer);
        return Object.assign(offer, { kind: 'webrtc' as const });
      } catch (err) {
        if (attempt.signal.aborted) {
          offer.pc.close();
          throw attempt.signal.reason;
        }
        if (!(err instanceof SdpExchangeError) || !err.isAuthRejection) {
          offer.pc.close();
          throw err;
        }
        blockWebRtcFor(slotB);
      }
    }
    try {
      const transport = await this.openWsTransport(retrySession.client_secret.value, attempt);
      offer?.pc.close();
      return { kind: 'websocket', transport };
    } catch (err) {
      offer?.pc.close();
      // The alternate credential's final result determines eligibility. A
      // primary auth rejection cannot turn an alternate network fault permanent.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Open the WebSocket transport over the already-acquired mic stream. Server
   * events are fed to the SAME handler the DataChannel uses - the event
   * contract is identical, so segmentation, the wedge detector and the health
   * ladder all stay transport-agnostic.
   */
  private async openWsTransport(
    token: string,
    attempt: RecoveryAttempt,
  ): Promise<OpenAIWsTransport> {
    const stream = this.stream;
    if (stream === null) throw new Error('No audio stream to send to OpenAI');
    return await attempt.run(() =>
      wsOpener(
        token,
        stream,
        {
          onEvent: (ev) => this.handleDCEvent(ev as DCEvent),
          onClosed: (reason) => {
            if (!this.isCurrentGeneration(attempt.generation)) return;
            this.activeSessionUsable = false;
            this.emitHealth('transport', 'reconnecting', `OpenAI WebSocket dropped - ${reason}`);
            if (this.isCurrentGeneration(attempt.generation)) void this.renewSession();
          },
          onAudioTrouble: (state, message, component = 'audio') =>
            this.emitHealth(component, state, message),
          onCaptureHealth: (event) => {
            if (this.isCurrentGeneration(attempt.generation)) this.handlers.onHealth(event);
          },
        },
        attempt.signal,
      ).then((transport) => {
        try {
          attempt.assertActive();
          return transport;
        } catch (error) {
          transport.close();
          throw error;
        }
      }),
    );
  }

  /** Attach the live event/state handlers to a freshly-built peer. */
  private wirePeer(pc: RTCPeerConnection, dc: RTCDataChannel): void {
    const generation = this.generation;
    const owned = () => this.isCurrentGeneration(generation) && this.pc === pc;
    this.dc = dc;
    const channelUnavailable = () => {
      if (!owned() || !this.activeSessionUsable) return;
      this.activeSessionUsable = false;
      this.emitHealth(
        'transport',
        'reconnecting',
        'Caption data channel unavailable — rebuilding session',
      );
      if (owned()) void this.renewSession();
    };
    dc.onclose = channelUnavailable;
    dc.onerror = channelUnavailable;
    dc.onmessage = (ev: MessageEvent<string>) => {
      if (!owned()) return;
      try {
        this.handleDCEvent(JSON.parse(ev.data) as DCEvent);
      } catch (err) {
        console.warn('[openai-rt] DC event error:', err, 'raw:', ev.data.slice(0, 200));
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (owned()) this.handleIceState();
    };
    pc.onconnectionstatechange = () => {
      if (owned()) this.handleConnectionState();
    };
  }

  /**
   * Reset the stale-data detector + silence baselines so the 30 s grace period
   * starts now, not at whatever a previous connection left behind. Called on
   * every successful bring-up and make-before-break swap.
   */
  private resetStaleBaselines(): void {
    this.lastDcEventAt = Date.now();
    this.lastAudioActiveAt = 0;
    this.audioActiveSamplesSinceDc = 0;
    this.silenceEmitted = false;
  }

  // User Stop waits for the tail; teardown/replacement can force it closed.
  stop(options?: { drain?: boolean }): void {
    const alreadyStopped = this._status === 'stopped';
    const generation = this.finishSession(
      !alreadyStopped,
      !alreadyStopped && options?.drain === true,
    );
    if (alreadyStopped || generation !== this.generation) return;
    this.emitHealth('audio', 'stopped');
    if (generation !== this.generation) return;
    this.emitHealth('transport', 'stopped');
  }

  /** Resolves after the bounded translation tail has emitted its final events. */
  waitForStop(): Promise<void> {
    return this.stopComplete;
  }

  /** Complete the old generation before any observer can start its successor. */
  private finishSession(flush: boolean, drain = false): number {
    const changed = this._status !== 'stopped';
    const tail = flush ? this.snapshotSegment() : null;
    const pc = drain && this.activeSessionUsable ? this.pc : null;
    const dc = pc ? this.dc : null;
    const ws = drain && this.activeSessionUsable ? this.wsTransport : null;
    // Cleanup cancels attempts/timers and releases capture, while the detached
    // transport can only update its own bounded snapshot, never a new session.
    if (pc) {
      this.pc = null;
      this.dc = null;
    }
    if (ws) this.wsTransport = null;
    this._status = 'stopped';
    const retiredTail = this.cleanup();
    this.newSegment();
    const generation = this.generation;
    if (tail && (pc || ws)) {
      this.stopComplete = new Promise<void>((resolve) => {
        this.retireTransport(pc, dc, ws, { ...tail }, resolve);
      });
    }
    if (tail) this.emitSegmentFinal(tail);
    if (generation !== this.generation) return generation;
    if (retiredTail) this.emitSegmentFinal(retiredTail);
    if (generation !== this.generation) return generation;
    if (changed) this.notifyStatus('stopped');
    return generation;
  }

  private cleanup(): SegmentSnapshot | undefined {
    this.pendingAcquisition = null;
    this.captureHealth?.dispose();
    this.captureHealth = null;
    this.generation += 1;
    this.lifecycle.abort(new RenewalCancelledError('Stopped'));
    this.activeSessionUsable = false;
    const retiredTail = this.retired?.finish(false);
    this.renewalAttempt += 1;
    this.cancelPendingRenewalPeer?.();
    if (this.levelInterval !== null) clearInterval(this.levelInterval);
    if (this.segmentFlushTimer !== null) clearTimeout(this.segmentFlushTimer);
    if (this.segmentDeadlineTimer !== null) clearTimeout(this.segmentDeadlineTimer);
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    if (this.iceRestartTimer !== null) clearTimeout(this.iceRestartTimer);
    if (this.renewalRetryTimer !== null) clearTimeout(this.renewalRetryTimer);
    if (this.diagInterval !== null) clearInterval(this.diagInterval);
    this.levelInterval = null;
    this.segmentFlushTimer = null;
    this.segmentDeadlineTimer = null;
    this.renewTimer = null;
    this.iceRestartTimer = null;
    this.renewalRetryTimer = null;
    this.diagInterval = null;
    this.renewScheduledAtMs = 0;
    this.renewing = false;
    this.pc?.close();
    this.pc = null;
    if (this.dc) this.dc.onmessage = null;
    this.dc = null;
    this.wsTransport?.close();
    this.wsTransport = null;
    // Releasing the mic stops the shared MediaStream tracks (this.stream points
    // at the same object the mic holds), so the OS capture indicator turns off.
    this.mic.release();
    this.stream = null;
    return retiredTail;
  }

  private scheduleRenewal(delayMs: number): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewScheduledAtMs = Date.now();
    this.renewDelayMs = delayMs;
    this.renewTimer = setTimeout(() => this.renewSession(), delayMs);
  }

  /**
   * Make-before-break session renewal. Build a brand-new peer connection over
   * the EXISTING mic stream while the current one keeps delivering captions,
   * then swap only after the replacement media connection is ready, without
   * re-acquiring the mic. This preserves transport availability; model output
   * can still pause during renewal. For a failure-driven renewal (ICE/connection
   * failed, session.closed, wedge) the old peer is already dead, so there's no
   * gap to save, but reusing the mic and not tearing down the level/diagnostic
   * loops still keeps recovery clean.
   *
   * On failure the OLD peer is left untouched (a healthy scheduled renewal stays
   * live; a dead failure-driven one stays dead) and a persistent retry is
   * scheduled. Status stays 'running' throughout so the UI shows auto-recovery
   * (+ the cross-model failover affordance) rather than a dead Start button.
   */
  private async renewSession(existingAttempt?: RecoveryAttempt): Promise<void> {
    if (this._status !== 'running') return;
    if (this.renewing) return; // one swap at a time
    if (!this.stream) return; // no mic to reuse — should not happen while running
    this.renewing = true;
    if (this.renewalRetryTimer !== null) {
      clearTimeout(this.renewalRetryTimer);
      this.renewalRetryTimer = null;
    }
    const renewalId = ++this.renewalAttempt;
    const attempt = existingAttempt ?? this.createAttempt();
    const aborted = () => this._status !== 'running' || renewalId !== this.renewalAttempt;
    this.emitRecoveryProgress('Renewing OpenAI session');
    try {
      const sessionData = await this.fetchSessionToken(attempt);
      if (sessionData === null || aborted()) return;
      this.renewDelayMs = sessionData.session_renewal_recommended_ms ?? this.renewDelayMs;
      // Build a fresh local offer unless WebRTC is known-blocked for this key
      // (then the ladder goes straight to the WebSocket transport and the peer
      // would be dead weight). Re-probing WebRTC here is deliberate and free:
      // the OLD session keeps captioning until the swap below, so a failed
      // probe does not require closing the existing media connection.
      const slot = sessionData.key_slot ?? 'unknown';
      let offer: LocalPeer | null = null;
      if (!isWebRtcBlockedFor(slot)) {
        offer = await this.createLocalOffer(this.stream, attempt, true);
        if (offer === null || aborted()) {
          offer?.pc.close();
          return;
        }
      }
      const outcome = await this.connectSession(sessionData, offer, attempt);
      if (outcome.kind === 'aborted' || aborted()) {
        if (outcome.kind === 'webrtc') outcome.pc.close();
        if (outcome.kind === 'websocket') outcome.transport.close();
        return;
      }

      // SDP acceptance is not media readiness. Keep the old peer and its
      // caption handlers active while the candidate finishes ICE/DTLS.
      if (outcome.kind === 'webrtc') {
        await this.waitForRenewalPeer(outcome, attempt);
        if (aborted()) {
          outcome.pc.close();
          return;
        }
        const tracks = this.stream.getAudioTracks();
        try {
          await attempt.run(() =>
            Promise.all(
              outcome.pc
                .getSenders()
                .map((sender, index) => sender.replaceTrack(tracks[index] ?? null)),
            ),
          );
        } catch (error) {
          outcome.pc.close();
          throw error;
        }
        if (aborted()) {
          outcome.pc.close();
          return;
        }
        assertPeerUsable(outcome);
        // Readiness may have changed after resolving the wait but before this
        // continuation ran. Never detach the old peer for a dead candidate.
        if (outcome.pc.connectionState !== 'connected' || outcome.dc.readyState !== 'open') {
          outcome.pc.close();
          throw new Error('Renewal peer lost readiness before activation');
        }
      }

      // Validate the ready-but-silent candidate before touching the healthy
      // old session. Browser events cannot interleave between this synchronous
      // check and activate(), so a candidate that closed during the promise
      // hand-off cannot replace a healthy old transport with a dead candidate.
      if (outcome.kind === 'websocket' && !outcome.transport.isOpen) {
        outcome.transport.close();
        throw new OpenAIWsOpenError('Renewal WebSocket closed before activation', false);
      }

      // ── Atomic make-before-break swap ──
      // Finalize the OLD session's in-flight text first so the last line is
      // neither lost nor duplicated, then detach + close the old peer and
      // promote the new one. The new DataChannel handler is wired only HERE
      // (buildPeer left it unwired), so the new session's deltas can't
      // double-render alongside the old during the overlap window.
      const retiredSegment = this.snapshotSegment();
      this.flushSegment();
      if (aborted()) {
        if (outcome.kind === 'webrtc') outcome.pc.close();
        else outcome.transport.close();
        return;
      }
      // Empty accumulators still belong to the retiring transport. Reserve a
      // distinct id before new events arrive, so a late old tail cannot overwrite them.
      if (this.currentSegmentId === retiredSegment.segmentId) this.newSegment();
      const oldPc = this.pc;
      const oldDc = this.dc;
      if (oldPc) {
        oldPc.oniceconnectionstatechange = null;
        oldPc.onconnectionstatechange = null;
        oldPc.ontrack = null;
      }
      // Same contract for the WebSocket transport: detach first so the dying
      // socket cannot deliver a late event (or a close-driven renewal) into
      // the session that just replaced it.
      const oldWs = this.wsTransport;
      if (oldWs) {
        oldWs.detach();
      }
      this.pc = null;
      this.dc = null;
      this.wsTransport = null;
      let retired = false;
      try {
        this.activeSessionUsable = true;
        this.activeSessionClosed = false;
        if (outcome.kind === 'webrtc') {
          this.pc = outcome.pc;
          this.wirePeer(outcome.pc, outcome.dc);
        } else {
          this.wsTransport = outcome.transport;
          // open() returns a ready-but-silent WebSocket. Activate only after
          // the old segment was finalized and the old transport was detached,
          // so queued new-session deltas start in a fresh segment.
          outcome.transport.activate();
        }
        this.retireTransport(oldPc, oldDc, oldWs, retiredSegment);
        retired = true;
      } catch (err) {
        if (outcome.kind === 'websocket') outcome.transport.close();
        this.pc = null;
        this.wsTransport = null;
        throw err;
      } finally {
        if (!retired) {
          oldPc?.close();
          oldWs?.close();
        }
      }

      if (aborted()) return;
      // A stale ICE-restart timer from the old peer would call restartIce on the
      // NEW one — clear it and reset the backoff for a clean slate.
      if (this.iceRestartTimer !== null) {
        clearTimeout(this.iceRestartTimer);
        this.iceRestartTimer = null;
      }
      this.resetStaleBaselines();
      if (outcome.kind === 'websocket') {
        this.captureHealth?.dispose();
        this.captureHealth = null;
      } else if (!this.captureHealth && this.stream) {
        const generation = this.generation;
        try {
          const monitor = await monitorWebRtcCapture(
            this.stream,
            (event) => {
              if (this.isCurrentGeneration(generation) && this.pc && !this.wsTransport)
                this.handlers.onHealth(event);
            },
            this.lifecycle.signal,
          );
          if (aborted()) {
            monitor.dispose();
            return;
          }
          this.captureHealth = monitor;
        } catch (error) {
          if (aborted()) return;
          this.emitHealth(
            'audio',
            'failed',
            error instanceof Error ? error.message : '收音監測無法啟動',
          );
          return;
        }
      }
      this.renewalRetryAttempt = 0;
      this.scheduleRenewal(this.renewDelayMs);
      // Level polling + diagnostics persist across a normal swap (mic reused).
      // Start them if this renewal IS the bring-up (token-near-expiry-at-start).
      if (this.levelInterval === null) this.startLevelPolling();
      if (this.diagInterval === null) this.startDiagnosticDump();
      if (outcome.kind === 'websocket' || outcome.pc.connectionState === 'connected') {
        this.emitHealth('transport', 'connected');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Session renewal failed';
      if (!aborted() && !(err instanceof RenewalCancelledError)) {
        const failure = finalTransportFailure(err);
        this.scheduleRenewalRetry(message, failure.failure);
      }
    } finally {
      if (!existingAttempt) attempt.dispose();
      if (renewalId === this.renewalAttempt) this.renewing = false;
    }
  }

  private waitForRenewalPeer(peer: LocalPeer, attempt: RecoveryAttempt): Promise<void> {
    attempt.assertActive();
    assertPeerUsable(peer);
    const { pc, dc } = peer;
    // DTLS and SCTP can connect before the translation service accepts the
    // session. The documented first server event is session.created; waiting
    // for it keeps a healthy primary until the candidate can carry captions.
    const ready = () =>
      pc.connectionState === 'connected' && dc.readyState === 'open' && peer.sessionCreated;
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const previousHandler = pc.onconnectionstatechange;
      const previousOpen = dc.onopen;
      const previousClose = dc.onclose;
      const previousError = dc.onerror;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.onconnectionstatechange = previousHandler;
        dc.onopen = previousOpen;
        dc.onclose = previousClose;
        dc.onerror = previousError;
        peer.onTerminal = null;
        peer.onSessionCreated = null;
        attempt.signal.removeEventListener('abort', cancel);
        if (this.cancelPendingRenewalPeer === cancel) this.cancelPendingRenewalPeer = null;
        if (error) {
          pc.close();
          reject(error);
        } else resolve();
      };
      const cancel = () =>
        finish(
          attempt.signal.reason instanceof Error
            ? attempt.signal.reason
            : new RenewalCancelledError('Renewal cancelled'),
        );
      const timer = setTimeout(() => {
        finish(new Error('Renewal peer connection readiness timed out'));
      }, RENEWAL_PEER_READY_TIMEOUT_MS);
      this.cancelPendingRenewalPeer = cancel;
      peer.onTerminal = finish;
      peer.onSessionCreated = () => {
        if (ready()) finish();
      };
      attempt.signal.addEventListener('abort', cancel, { once: true });
      pc.onconnectionstatechange = () => {
        if (ready()) finish();
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          finish(new Error(`Renewal peer connection ${pc.connectionState} before readiness`));
        }
      };
      dc.onopen = () => {
        if (ready()) finish();
      };
      dc.onclose = () => finish(new Error('Renewal caption data channel closed before readiness'));
      dc.onerror = () => finish(new Error('Renewal caption data channel failed before readiness'));
      // Cover a terminal transition that happened before the listener was installed.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        finish(new Error(`Renewal peer connection ${pc.connectionState} before readiness`));
      }
    });
  }

  /**
   * Schedule the next renewal retry using the persistent backoff sequence.
   * Called from renewSession's catch AND from the retry timer's own callback
   * when its renewSession() attempt also fails. The recursion is what makes the
   * long-meeting auto-recovery actually persist — it never gives up. cleanup()
   * cancels the pending timer on user-initiated stop.
   */
  private scheduleRenewalRetry(
    reason?: string,
    recoveryFailure?: HealthEvent['recoveryFailure'],
  ): void {
    // Disarm the stale-data detector only when the primary is unavailable:
    // the retry timer then becomes the single driver of recovery. Left armed, the level-poll detector
    // would independently fire more renewSession() calls during the backoff
    // window (no DC events arrive on a dead/renewing session), racing the timer
    // and escalating the backoff faster than intended. resetStaleBaselines()
    // re-arms it on the next successful connection.
    const primaryHealthy = this.isPrimaryHealthy();
    const gate = recoveryFailureFor('openai', 'translation');
    if (permanentRecoveryFailure(gate)) {
      this.emitHealth(
        'transport',
        primaryHealthy ? 'connected' : 'failed',
        `${reason ?? '服務拒絕'}；請修正服務設定後手動重試`,
        recoveryFailure,
      );
      return;
    }
    if (!primaryHealthy) {
      this.lastDcEventAt = 0;
      this.audioActiveSamplesSinceDc = 0;
    }
    const idx = Math.min(this.renewalRetryAttempt, RENEWAL_RETRY_BACKOFF_MS.length - 1);
    const delay = Math.max(
      RENEWAL_RETRY_BACKOFF_MS[idx]!,
      (gate?.retryNotBeforeMs ?? 0) - performance.now(),
    );
    this.renewalRetryAttempt += 1;
    // Format "30 sec" for sub-minute delays, "N min" for the rest. Operator
    // confidence drops if we report "auto-retry in 0 min" for a 30 s delay.
    const humanDelay =
      delay < 60_000 ? `${Math.round(delay / 1000)} sec` : `${Math.round(delay / 60_000)} min`;
    const detail = reason ? `${reason}; ` : '';
    const generation = this.generation;
    this.emitHealth(
      'transport',
      primaryHealthy ? 'connected' : 'failed',
      `${primaryHealthy ? 'Background renewal failed; primary remains live. ' : ''}${detail}auto-retry in ${humanDelay} (attempt #${this.renewalRetryAttempt})`,
      recoveryFailure,
    );
    if (this.status !== 'running' || generation !== this.generation) return;
    this.renewalRetryTimer = setTimeout(
      () => {
        this.renewalRetryTimer = null;
        if (this._status !== 'running') return;
        // renewSession's own catch re-schedules the NEXT retry if this one fails.
        void this.renewSession();
      },
      Math.min(2_147_483_647, delay),
    );
  }

  private isPrimaryHealthy(): boolean {
    if (!this.activeSessionUsable) return false;
    if (this.wsTransport) return this.wsTransport.isOpen;
    return (
      this.pc?.connectionState === 'connected' &&
      this.dc?.readyState === 'open' &&
      this.pc.iceConnectionState !== 'failed' &&
      this.pc.iceConnectionState !== 'disconnected'
    );
  }

  private emitRecoveryProgress(message: string): void {
    this.emitHealth('transport', this.isPrimaryHealthy() ? 'connected' : 'reconnecting', message);
  }

  private handleIceState(): void {
    const generation = this.generation;
    if (this._status !== 'running') return;
    const state = this.pc?.iceConnectionState;
    // Diagnostic: every transition logged. Surfaces wedged-DC scenarios
    // where iceConnectionState='connected' but DC events stopped.
    console.info('[openai-rt] iceConnectionState →', state);
    if (state === 'disconnected') {
      this.emitHealth('transport', 'reconnecting');
      if (this.isCurrentGeneration(generation)) this.scheduleIceRecovery();
    } else if (state === 'failed') {
      // ICE truly dead. Don't stop() — that leaves the user with a frozen
      // caption area and a manual Start button to click, defeating the
      // self-healing premise. Renew the whole session (fresh SDP + ICE)
      // and let the renewal-retry backoff escalate if it also fails.
      this.emitHealth('transport', 'reconnecting', 'ICE failed — rebuilding session');
      if (this.isCurrentGeneration(generation)) void this.renewSession();
    } else if (state === 'connected' || state === 'completed') {
      if (this.iceRestartTimer !== null) clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
      if (this.isPrimaryHealthy()) this.emitHealth('transport', 'connected');
    }
  }

  private handleConnectionState(): void {
    const generation = this.generation;
    if (this._status !== 'running') return;
    const state = this.pc?.connectionState;
    console.info('[openai-rt] connectionState →', state);
    // connectionState aggregates ICE+DTLS. 'failed' means the transport
    // can't recover via ICE restart alone — go straight to a full session
    // renewal (same self-heal premise as ICE failure above). 'disconnected'
    // is transient (browser waits ~30s before promoting to 'failed') so we
    // give it one grace window, then rebuild the negotiated session.
    if (state === 'connected') {
      this.emitHealth('transport', 'connected');
    } else if (state === 'failed') {
      this.emitHealth('transport', 'reconnecting', 'Peer connection failed — rebuilding session');
      if (this.isCurrentGeneration(generation)) void this.renewSession();
    } else if (state === 'disconnected') {
      this.scheduleIceRecovery();
      this.emitHealth(
        'transport',
        'reconnecting',
        'Peer connection disconnected — waiting for recovery',
      );
    }
  }

  private scheduleIceRecovery(): void {
    if (this._status !== 'running') return;
    const generation = this.generation;
    if (this.iceRestartTimer !== null) return;
    const peer = this.pc;
    this.iceRestartTimer = setTimeout(() => {
      this.iceRestartTimer = null;
      if (this._status !== 'running' || this.pc !== peer) return;
      if (peer?.iceConnectionState === 'disconnected' || peer?.connectionState === 'disconnected') {
        this.emitHealth(
          'transport',
          'reconnecting',
          'ICE disconnection persisted — rebuilding session',
        );
        if (this.isCurrentGeneration(generation)) void this.renewSession();
      }
    }, ICE_RECOVERY_GRACE_MS);
  }

  private handleDCEvent(ev: DCEvent): void {
    const generation = this.generation;
    if (!this.isCurrentGeneration(generation)) return;
    this.dcEventCount += 1;
    // Control traffic proves connectivity, not caption progress. Source-only
    // deltas count too: target-language speech need not produce a translation.
    const captionProgress =
      Boolean(ev.delta?.trim()) &&
      (ev.type === 'session.input_transcript.delta' ||
        ev.type === 'session.output_transcript.delta');
    if (captionProgress) {
      this.lastDcEventAt = Date.now();
      this.audioActiveSamplesSinceDc = 0;
      if (!this.activeSessionClosed && !this.activeSessionUsable) {
        this.activeSessionUsable = true;
        if (this.isPrimaryHealthy()) this.emitHealth('transport', 'connected');
      }
    }
    if (!this.isCurrentGeneration(generation)) return;
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
        // Reflect session control only while the active media path remains
        // usable. Control traffic cannot revive a closed or stalled session.
        if (this._status === 'running' && this.isPrimaryHealthy())
          this.emitHealth('transport', 'connected');
        break;

      case 'session.closed':
        // OpenAI closed the session (likely 30-min cap hit before our 25-min renewal,
        // or upstream policy). Renew transparently — captionStore is preserved.
        if (this._status === 'running') {
          this.activeSessionUsable = false;
          this.activeSessionClosed = true;
          void this.renewSession();
        }
        break;

      case 'session.input_transcript.delta': {
        if (!ev.delta) break;
        this.inputDeltaCount += 1;
        this.inputAcc += ev.delta;
        if (!this.inputAcc.trim()) break;
        const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
        // Whisper transcribes Mandarin as Simplified Chinese — convert to Traditional for zh-TW source
        const transcriptText = meta.src === 'zh-TW' ? toTaiwanese(this.inputAcc) : this.inputAcc;
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: this.sourceKind,
          segmentId: this.currentSegmentId,
          ...(this.continuationOf ? { continuationOf: this.continuationOf } : {}),
          status: 'partial',
          text: transcriptText,
          startMs: this.startMs,
        };
        this.handlers.onTranscript(t);
        if (!this.isCurrentGeneration(generation)) return;
        this.resetSegmentFlushTimer();
        break;
      }

      case 'session.output_transcript.delta': {
        if (!ev.delta) break;
        this.outputDeltaCount += 1;
        this.outputAcc += ev.delta;
        if (!this.outputAcc.trim()) break;
        const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;

        // Anchor the live caption from the TRANSLATION stream — in BOTH modes.
        //
        // The translated transcript (`output_transcript.delta`) streams
        // continuously, but the optional source transcript
        // (`input_transcript.delta`, gpt-realtime-whisper) LAGS — whisper
        // typically only emits near utterance end, not per word. Without a
        // `livePartial` anchored to this segment, the store's
        // `applyTranslation` routes every draft into the finalized
        // `translations` map, and `LiveCaption` (which renders only
        // `liveTranslation`) stays blank for the whole utterance — captions
        // appear to never show, lurching forward once per 1 s flush. That is
        // the dominant "OpenAI 無法顯示字幕" failure, and it bites the DEFAULT
        // bilingual mode hardest because that's where whisper runs and lags.
        //
        // Emit a partial transcript carrying the source text we have SO FAR
        // (`inputAcc` — empty in translation-only mode, the real running
        // source once whisper catches up). Using `inputAcc` rather than a
        // bare '' is what makes this safe in bilingual mode: it can never
        // clobber a real input_transcript.delta with empty text (the race the
        // previous bilingual-skip guarded against), it just keeps the live
        // segment anchored so the draft translation streams live. Same
        // segmentId on both sides lets the store bind the draft to
        // `liveTranslation`. Redundant partials are coalesced at 50 ms.
        const srcSoFar = meta.src === 'zh-TW' ? toTaiwanese(this.inputAcc) : this.inputAcc;
        const synth: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: this.sourceKind,
          segmentId: this.currentSegmentId,
          ...(this.continuationOf ? { continuationOf: this.continuationOf } : {}),
          status: 'partial',
          text: srcSoFar,
          startMs: this.startMs,
        };
        this.handlers.onTranscript(synth);
        if (!this.isCurrentGeneration(generation)) return;

        // Convert accumulated simplified Chinese to Traditional Chinese (Taiwan)
        const targetText = meta.tgt === 'zh-TW' ? toTaiwanese(this.outputAcc) : this.outputAcc;
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
        if (!this.isCurrentGeneration(generation)) return;
        // Translation-only mode: input deltas never fire, so the segment
        // flush has to be driven from here too — otherwise nothing ever
        // finalizes and the live caption sticks on a partial forever.
        this.resetSegmentFlushTimer();
        break;
      }

      // Utterance-completion signals. Different OpenAI Realtime endpoints
      // emit slightly different completion event names; we listen for the
      // documented patterns + the .completed/.done variants the Translation
      // endpoint uses. Any of them means "this utterance is finalized" — we
      // commit immediately rather than waiting for the 1 s debounce or 12 s
      // deadline. Unknown event types still fall through harmlessly.
      case 'session.input_transcript.completed':
      case 'session.input_transcript.done':
      case 'session.output_transcript.completed':
      case 'session.output_transcript.done':
      case 'response.output_audio_transcript.done':
      case 'response.done':
      case 'conversation.item.input_audio_transcription.completed':
        if (this._status === 'running') this.flushSegment();
        break;

      case 'error': {
        const msg = ev.error?.message ?? 'OpenAI Realtime error';
        const kind = protocolRecoveryKind(ev.error);
        const failure = recoveryError(
          kind,
          'openai',
          'translation',
          msg,
          kind === 'rate-limit' ? performance.now() + 15_000 : undefined,
        );
        this.emitHealth(
          'transport',
          permanentRecoveryFailure(failure.failure) ? 'failed' : 'api_error',
          msg,
          failure.failure,
        );
        break;
      }

      default:
        break;
    }
  }

  private resetSegmentFlushTimer(): void {
    if (this._status !== 'running') return;
    if (this.segmentFlushTimer !== null) clearTimeout(this.segmentFlushTimer);
    this.segmentFlushTimer = setTimeout(() => {
      if (this._status === 'running') this.flushSegment();
    }, SEGMENT_FLUSH_MS);
    // Arm the absolute deadline only on the FIRST delta of a segment —
    // resetting it on every delta would defeat the purpose (the bug we're
    // fixing). flushSegment() clears it so the next segment can arm a fresh one.
    if (this.segmentDeadlineTimer === null) {
      this.segmentDeadlineTimer = setTimeout(() => {
        this.segmentDeadlineTimer = null;
        if (this._status === 'running') this.flushSegment('deadline');
      }, MAX_SEGMENT_DURATION_MS);
    }
  }

  private flushSegment(reason: 'boundary' | 'deadline' = 'boundary'): void {
    // Clear the deadline whether or not there's text to flush — if a stray
    // empty flush fires we still want the next segment to start with a fresh
    // deadline window, not inherit the old one.
    if (this.segmentDeadlineTimer !== null) {
      clearTimeout(this.segmentDeadlineTimer);
      this.segmentDeadlineTimer = null;
    }
    if (!this.inputAcc && !this.outputAcc) {
      // A natural pause after an exact deadline still ends the utterance,
      // even if no tail arrived in the newly opened storage segment.
      if (reason === 'boundary') this.continuationOf = undefined;
      return;
    }
    const generation = this.generation;
    this.emitSegmentFinal(this.snapshotSegment());
    if (!this.isCurrentGeneration(generation)) return;
    this.newSegment(reason === 'deadline' ? this.currentSegmentId : undefined);
  }

  /**
   * Stop feeding the retired session, but allow its buffered translation to
   * finish. Only one bounded snapshot survives a swap; it never emits partials
   * or touches the new session's live accumulator, timers, or transport health.
   */
  private retireTransport(
    pc: RTCPeerConnection | null,
    dc: RTCDataChannel | null,
    ws: OpenAIWsTransport | null,
    segment: SegmentSnapshot,
    onComplete?: () => void,
  ): void {
    const generation = this.generation;
    this.retired?.finish();
    if (generation !== this.generation || (this._status !== 'running' && !onComplete)) {
      pc?.close();
      ws?.close();
      onComplete?.();
      return;
    }
    if (!pc && !ws) {
      onComplete?.();
      return;
    }
    let finished = false;
    let changed = false;
    let closed = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const finish = (emit = true): SegmentSnapshot | undefined => {
      if (finished) return;
      finished = true;
      clearTimeout(cap);
      if (grace !== null) clearTimeout(grace);
      if (this.retired?.finish === finish) this.retired = null;
      if (dc) dc.onmessage = null;
      pc?.close();
      ws?.close();
      try {
        if (changed) {
          if (emit) this.emitSegmentFinal(segment);
          else return segment;
        }
        return undefined;
      } finally {
        onComplete?.();
      }
    };
    const armGrace = (): void => {
      if (grace !== null) clearTimeout(grace);
      grace = setTimeout(finish, RETIRED_DRAIN_GRACE_MS);
    };
    const receive = (event: DCEvent): void => {
      if (finished) return;
      if (event.type === 'error') {
        finish();
        return;
      }
      if (event.type === 'session.closed') {
        closed = true;
        armGrace();
        return;
      }
      if (!event.delta) return;
      if (event.type === 'session.input_transcript.delta') segment.input += event.delta;
      else if (event.type === 'session.output_transcript.delta') segment.output += event.delta;
      else return;
      changed = true;
      // Real RTC sessions can deliver final source deltas after session.closed.
      if (closed) armGrace();
    };
    // The cap preserves received text, but cannot guarantee a complete tail.
    const cap = setTimeout(finish, RETIRED_DRAIN_CAP_MS);
    this.retired = { finish };
    if (ws) {
      ws.beginDrain(receive, finish);
      return;
    }
    if (!pc || !dc || dc.readyState !== 'open') {
      finish();
      return;
    }
    dc.onmessage = (event: MessageEvent<string>) => {
      try {
        receive(JSON.parse(event.data) as DCEvent);
      } catch {
        // Ignore malformed frames, just as the active data channel does.
      }
    };
    try {
      // Detach old senders before committing its buffered audio. The new live
      // session proceeds independently; Stop cancels any late promise result.
      void Promise.all(pc.getSenders().map((sender) => sender.replaceTrack(null)))
        .then(() => {
          if (!finished) dc.send(JSON.stringify({ type: 'session.close' }));
        })
        .catch(() => finish());
    } catch {
      finish();
    }
  }

  private snapshotSegment(): SegmentSnapshot {
    return {
      segmentId: this.currentSegmentId,
      startMs: this.startMs,
      endMs: Date.now(),
      input: this.inputAcc,
      output: this.outputAcc,
      ...(this.continuationOf ? { continuationOf: this.continuationOf } : {}),
    };
  }

  private emitSegmentFinal(segment: SegmentSnapshot): void {
    const generation = this.generation;
    if (!segment.input.trim() && !segment.output.trim()) return;
    const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
    // Apply Traditional Chinese conversion to transcript text when source is zh-TW
    const transcriptText = meta.src === 'zh-TW' ? toTaiwanese(segment.input) : segment.input;

    const t: TranscriptEvent = {
      kind: 'transcript',
      provider: 'openai-realtime',
      mode: 'online_full',
      source: this.sourceKind,
      segmentId: segment.segmentId,
      ...(segment.continuationOf ? { continuationOf: segment.continuationOf } : {}),
      status: 'final',
      text: transcriptText,
      startMs: segment.startMs,
      endMs: segment.endMs,
    };
    this.handlers.onTranscript(t);
    if (generation !== this.generation) return;

    if (segment.output) {
      const targetText = meta.tgt === 'zh-TW' ? toTaiwanese(segment.output) : segment.output;
      const tr: TranslationEvent = {
        kind: 'translation',
        provider: 'openai-realtime',
        mode: 'online_full',
        sourceSegmentId: segment.segmentId,
        status: 'final',
        sourceText: transcriptText,
        targetText,
        sourceLanguage: meta.src,
        targetLanguage: meta.tgt,
        updatedAt: iso(),
      };
      this.handlers.onTranslation(tr);
    }
  }

  private newSegment(continuationOf?: string): void {
    this.inputAcc = '';
    this.outputAcc = '';
    this.continuationOf = continuationOf;
    this.currentSegmentId = crypto.randomUUID();
    this.startMs = Date.now();
  }

  private startLevelPolling(): void {
    const generation = this.generation;
    const analyser = this.mic.analyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let peakDb = -60;
    let peakHoldUntil = 0;

    this.levelInterval = setInterval(() => {
      if (!this.isCurrentGeneration(generation)) return;
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

      // Stale-data detection. Count cumulative audio-active ticks since the
      // last DC event — this tolerates natural sentence-boundary pauses
      // (silent ticks just don't increment) while still requiring meaningful
      // evidence that the user IS speaking. The previous stretch-based
      // detector reset on every >1 s pause, so a presenter who spoke in
      // 5-second sentences with 1-2 s gaps NEVER accumulated enough stretch
      // to trip the threshold even when DC was wedged for minutes.
      const audioActiveDb = STALE_AUDIO_ACTIVE_DB_BY_MIC[this.micDistance];
      const captureHealthy =
        this.wsTransport?.captureHealthy ?? this.captureHealth?.healthy ?? true;
      if (!captureHealthy) {
        this.lastDcEventAt = nowMs;
        this.audioActiveSamplesSinceDc = 0;
      }
      if (captureHealthy && rmsDb > audioActiveDb) {
        this.lastAudioActiveAt = nowMs;
        this.audioActiveSamplesSinceDc += 1;
        // Speech resumed after silence — recover the health state.
        if (this.silenceEmitted) {
          this.silenceEmitted = false;
          this.emitHealth('audio', 'connected');
          if (!this.isCurrentGeneration(generation)) return;
        }
      }

      // Silence detection: user has not spoken for SILENCE_DETECT_MS.
      // Only fire once per silence window (silenceEmitted gate) and only
      // after we have observed at least one active audio sample since the
      // session started (lastAudioActiveAt > 0) — so we don't alarm on the
      // brief quiet window between mic grant and the user's first word.
      const SILENCE_DETECT_MS = 30_000;
      if (
        captureHealthy &&
        !this.silenceEmitted &&
        this.lastAudioActiveAt > 0 &&
        nowMs - this.lastAudioActiveAt > SILENCE_DETECT_MS
      ) {
        this.silenceEmitted = true;
        this.emitHealth('audio', 'silence_detected');
        if (!this.isCurrentGeneration(generation)) return;
      }

      // Fire when: DC has been silent past the threshold AND we have at least
      // ~10 s of cumulative audio activity since that silence began (100
      // samples × 100 ms tick = 10 s). The cumulative-evidence check is what
      // prevents a false renewal when the user returns from a long silence
      // and OpenAI's first response is still in flight — that first frame
      // alone won't satisfy the 100-sample requirement.
      const STALE_AUDIO_EVIDENCE_SAMPLES = 100;
      if (this.lastDcEventAt > 0) {
        const dcGap = nowMs - this.lastDcEventAt;
        if (
          dcGap > STALE_DATA_THRESHOLD_MS &&
          this.audioActiveSamplesSinceDc >= STALE_AUDIO_EVIDENCE_SAMPLES
        ) {
          this.emitHealth(
            'transport',
            'degraded',
            `Wedged: ${Math.round(dcGap / 1000)}s no DC events while audio active — auto-renewing session`,
            {
              layer: 'provider',
              kind: 'stalled',
              provider: 'openai',
              purpose: 'translation',
              attemptId: crypto.randomUUID(),
            },
          );
          if (!this.isCurrentGeneration(generation)) return;
          // Reset to suppress double-fire while renewSession runs (it will
          // tear down and re-init, resetting lastDcEventAt on success).
          this.lastDcEventAt = 0;
          this.audioActiveSamplesSinceDc = 0;
          this.activeSessionUsable = false;
          void this.renewSession();
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
    }, AUDIO_LEVEL_INTERVAL_MS);
  }

  /**
   * Periodic console.log of provider internals — fires every 10 s while the
   * session is running. Surfaces the silent-wedge scenario where the UI
   * still shows "running" but no DC events arrive: the dump shows DC count
   * frozen, time-since-last-DC growing, pc states, and stale-detector
   * baselines. Reading these in DevTools is how we figure out WHY the
   * stale detector didn't trigger when captions visibly stopped.
   */
  private startDiagnosticDump(): void {
    this.diagInterval = setInterval(() => {
      const now = Date.now();
      const sinceDc = this.lastDcEventAt > 0 ? now - this.lastDcEventAt : -1;
      const sinceAudio = this.lastAudioActiveAt > 0 ? now - this.lastAudioActiveAt : -1;
      console.info('[openai-rt diag]', {
        status: this._status,
        transport: this.pc !== null ? 'webrtc' : this.wsTransport !== null ? 'websocket' : 'none',
        pcConn: this.pc?.connectionState,
        pcIce: this.pc?.iceConnectionState,
        dcEvents: this.dcEventCount,
        inputDeltas: this.inputDeltaCount,
        outputDeltas: this.outputDeltaCount,
        sinceLastDcMs: sinceDc,
        sinceLastAudioMs: sinceAudio,
        // ~100 samples = ~10 s of cumulative speech; threshold for wedge fire.
        audioSamplesSinceDc: this.audioActiveSamplesSinceDc,
        renewalEtaMs: this.getRenewalEtaMs(),
      });
    }, 10_000);
  }

  private emitHealth(
    component: HealthComponent,
    state: HealthState,
    message?: string,
    recoveryFailure?: HealthEvent['recoveryFailure'],
  ): void {
    const ev: HealthEvent = { kind: 'health', component, state, timestamp: iso() };
    if (message !== undefined) ev.message = message;
    if (recoveryFailure !== undefined) ev.recoveryFailure = recoveryFailure;
    this.handlers.onHealth(ev);
  }
}
