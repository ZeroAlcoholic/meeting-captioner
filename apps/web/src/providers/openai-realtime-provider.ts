import { Converter } from 'opencc-js';
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
import { OpenAIWsOpenError, OpenAIWsTransport } from './openai-ws-transport.js';
import type {
  AudioSource,
  CaptionProvider,
  CaptionProviderHandlers,
  ProviderStatus,
} from './types.js';

// gpt-realtime-translate only outputs 'zh' (Simplified). Convert to Traditional Chinese (Taiwan).
const s2tw = Converter({ from: 'cn', to: 'tw' });

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
const AUDIO_LEVEL_INTERVAL_MS = 100;
const PEAK_HOLD_MS = 2000;
const PEAK_DECAY_DB_PER_TICK = 0.1;
// Fallback if /session reply omits the renewal hint. Matches server default.
const DEFAULT_SESSION_RENEW_MS = 25 * 60 * 1000;
// Bounded ICE-restart strategy: 3 attempts, 3 s → 6 s → 12 s.
const ICE_RESTART_DELAYS_MS = [3000, 6000, 12000];
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
  return new SdpExchangeError(res.status, code, detail);
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
  rejectedSlot?: OpenAIKeySlot,
): Promise<SessionResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rejectedSlot === undefined ? body : { ...body, rejectedSlot }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/session failed (${res.status}): ${text || res.statusText}`);
  }
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
    () => postSession(url, body),
    sessionExpiryMs,
    refreshIfOlderThanMs,
  );
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
) => Promise<OpenAIWsTransport>;

let wsOpener: WsOpener = (token, stream, handlers) =>
  OpenAIWsTransport.open(token, stream, handlers);

/** Test hooks: swap the WebSocket transport and clear the per-slot block. */
export function __setOpenAIWsOpenerForTests(opener: WsOpener | null): void {
  wsOpener = opener ?? ((t, st, h) => OpenAIWsTransport.open(t, st, h));
}
export function __resetOpenAITransportBlocksForTests(): void {
  webrtcBlockedUntil.clear();
}

export class OpenAIRealtimeProvider implements CaptionProvider {
  readonly name = 'openai-realtime';

  private _status: ProviderStatus = 'idle';
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
  private readonly mic: AudioSource;
  // The acquired mic MediaStream, persisted ACROSS renewals. Make-before-break
  // renewal re-uses these exact tracks for the new peer connection instead of
  // releasing + re-acquiring the device — no OS mic-indicator blink, no
  // getUserMedia re-prompt, and no transient capture failure every 25 minutes.
  // Released only on full stop()/cleanup().
  private stream: MediaStream | null = null;
  // Re-entrancy guard: a renewal can be triggered concurrently by the 25-min
  // timer, an ICE/connection failure, a session.closed event, the stale
  // detector, and the retry backoff. Only one make-before-break swap may run at
  // a time, or two new peers would race to become this.pc.
  private renewing = false;
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
  private iceRestartAttempt = 0;
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
    for (const fn of this.statusListeners) {
      try {
        fn(s);
      } catch {
        /* listener errors must not corrupt provider state */
      }
    }
  }

  /** Milliseconds remaining before the next scheduled session renewal, or null when no renewal is pending. */
  getRenewalEtaMs(): number | null {
    if (this.renewTimer === null || this.renewScheduledAtMs === 0) return null;
    const due = this.renewScheduledAtMs + this.renewDelayMs;
    return Math.max(0, due - Date.now());
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this.setStatus('running');
    this.iceRestartAttempt = 0;
    this.newSegment();

    // Robustness: each await can yield control. If the caller invokes stop()
    // between awaits, cleanup() nulls this.pc and the next line would NPE.
    // This guard short-circuits the bring-up so partial state never reaches
    // user-visible UI events or the dc handler attachment. Read through the
    // public getter so TS does not narrow _status to a literal that defeats
    // the check.
    const aborted = (): boolean => this.status !== 'running';

    // Kick the token-broker fetch off CONCURRENTLY with mic acquisition. The two
    // are independent (the token doesn't need the mic, the mic doesn't need the
    // token), so overlapping them shaves a full network RTT (~0.3-0.6 s) off
    // time-to-first-caption — and on a cold start the fetch completes while the
    // user is still reading the permission dialog. Settle-wrapped so a mic
    // denial can't turn the in-flight fetch into an unhandled rejection; a token
    // minted-but-unused on the rare mic-denied path is a negligible cost.
    this.emitHealth('transport', 'connecting');
    const tokenPromise = this.fetchSessionToken().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Step 1: mic acquisition. Failures here are AUDIO failures, not transport.
    let stream: MediaStream;
    try {
      stream = await this.mic.acquire(this.handlers.onHealth);
    } catch {
      // Provider contract: AudioSource.acquire() MUST emit its own precise
      // health event before throwing (MicrophoneAudioProvider emits 'failed';
      // DisplayMediaAudioProvider distinguishes 'failed' from 'no_audio_track'
      // for the "user picked a window without system audio" case). We
      // deliberately do NOT re-emit here — the previous emit('failed') was
      // clobbering DisplayMediaAudioProvider's more specific 'no_audio_track'
      // state, losing the actionable distinction the UI needs to coach the
      // user to tick the "Share audio" checkbox.
      this.setStatus('stopped');
      this.cleanup();
      void tokenPromise; // settled-wrapped: nothing to surface, just don't dangle
      return;
    }
    if (aborted()) {
      // User pressed Stop while mic dialog was open. mic.acquire returned a
      // stream but we never used it — release tracks so the OS mic indicator
      // turns off.
      stream.getTracks().forEach((t) => t.stop());
      void tokenPromise;
      return;
    }
    // Persist for make-before-break renewal — re-used, not re-acquired.
    this.stream = stream;

    // Step 2+: peer build + SDP exchange. TRANSPORT failures.
    try {
      // Build the local offer NOW — it needs only the mic, not the token — so
      // ICE candidate gathering runs IN PARALLEL with the still-in-flight token
      // mint. By the time the token arrives, localDescription carries the STUN
      // candidates gathered during that window, so exchangeSdp POSTs a
      // candidate-enriched offer at zero added latency.
      const conn = await this.createLocalOffer(this.stream);
      if (conn === null || aborted()) {
        conn?.pc.close();
        void tokenPromise;
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
          void this.renewSession();
          return;
        }
      }

      const outcome = await this.connectSession(sessionData, conn);
      if (outcome.kind === 'aborted' || aborted()) {
        if (outcome.kind === 'webrtc') outcome.pc.close();
        if (outcome.kind === 'websocket') outcome.transport.close();
        return;
      }
      if (outcome.kind === 'webrtc') {
        this.pc = outcome.pc;
        this.wirePeer(outcome.pc, outcome.dc);
      } else {
        this.wsTransport = outcome.transport;
      }
      this.emitHealth('transport', 'connected');

      // Bring-up succeeded — any prior renewal-retry backoff state is now
      // moot. Reset the counter so a fresh failure later starts at 30 s,
      // not at whatever the previous failure escalated to.
      this.renewalRetryAttempt = 0;
      this.resetStaleBaselines();

      this.startLevelPolling();
      this.scheduleRenewal(this.renewDelayMs);
      this.startDiagnosticDump();
    } catch (err) {
      if (aborted()) return; // user already stopped; don't surface a misleading error
      const message = err instanceof Error ? err.message : 'Unknown error starting Realtime';
      this.emitHealth('transport', 'api_error', message);
      this.setStatus('stopped');
      this.cleanup();
    }
  }

  /**
   * POST /session for a fresh ephemeral token. Returns null if the provider was
   * stopped mid-flight; throws on a non-2xx response (transport failure).
   */
  private async fetchSessionToken(): Promise<SessionResponse | null> {
    const body = sessionRequestBody(this.langPair, this.includeSourceTranscript, this.micDistance);
    // Use a pre-warmed token if one was minted for this EXACT request and is
    // still fresh (single-use; consume clears it so a renewal mints fresh).
    const warm = warmSession.consume(warmKey(this.sessionUrl, body));
    if (warm) {
      // Honour the abort contract even on the fast path.
      return this.status === 'running' ? warm : null;
    }
    const session = await postSession(this.sessionUrl, body);
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
  ): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; offerSdp: string } | null> {
    const aborted = (): boolean => this.status !== 'running';
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
    // Display capture requires a video track for browser permission UX, but
    // this provider is audio-only. Keep video out of the OpenAI SDP.
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    const offer = await pc.createOffer();
    if (aborted()) {
      pc.close();
      return null;
    }
    await pc.setLocalDescription(offer); // ICE candidate gathering starts here
    if (aborted()) {
      pc.close();
      return null;
    }
    return { pc, dc, offerSdp: offer.sdp ?? '' };
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
  ): Promise<boolean> {
    const aborted = (): boolean => this.status !== 'running';
    // localDescription accrues ICE candidates after setLocalDescription — prefer
    // it so the offer we send is as complete as it can be by now.
    const sdp = pc.localDescription?.sdp ?? offerSdp;
    const sdpRes = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretValue}`, 'Content-Type': 'application/sdp' },
      body: sdp,
    });
    if (aborted()) return false;
    if (!sdpRes.ok) throw await readSdpError(sdpRes);
    const sdpText = await sdpRes.text();
    if (aborted()) return false;
    await pc.setRemoteDescription({ type: 'answer', sdp: sdpText });
    if (aborted()) return false;
    return true;
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
    offer: { pc: RTCPeerConnection; dc: RTCDataChannel; offerSdp: string } | null,
  ): Promise<
    | { kind: 'webrtc'; pc: RTCPeerConnection; dc: RTCDataChannel }
    | { kind: 'websocket'; transport: OpenAIWsTransport }
    | { kind: 'aborted' }
  > {
    const aborted = (): boolean => this.status !== 'running';
    const slotA = sessionData.key_slot ?? 'unknown';
    let firstError: Error | null = null;

    // 1. WebRTC, current key.
    if (offer !== null && !isWebRtcBlockedFor(slotA)) {
      try {
        const ok = await this.exchangeSdp(
          offer.pc,
          offer.offerSdp,
          sessionData.client_secret.value,
        );
        if (!ok) {
          offer.pc.close();
          return { kind: 'aborted' };
        }
        return { kind: 'webrtc', pc: offer.pc, dc: offer.dc };
      } catch (err) {
        if (!(err instanceof SdpExchangeError) || !err.isAuthRejection) {
          offer.pc.close();
          throw err;
        }
        firstError = err;
        blockWebRtcFor(slotA);
        this.emitHealth(
          'transport',
          'reconnecting',
          `${err.message} - switching to the WebSocket transport`,
        );
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
      const transport = await this.openWsTransport(sessionData.client_secret.value);
      offer?.pc.close(); // the WebRTC peer is surplus now
      return { kind: 'websocket', transport };
    } catch (err) {
      firstError ??= err instanceof Error ? err : new Error(String(err));
      wsAuthRejected = err instanceof OpenAIWsOpenError && err.isAuthRejection;
    }
    if (aborted()) {
      offer?.pc.close();
      return { kind: 'aborted' };
    }

    // 3-4. Alternate key, both transports. Reachable when this key failed on
    //      BOTH transports, or when the WebSocket transport is unavailable in
    //      this environment at all.
    const rejectedSlot = sessionData.key_slot;
    if (rejectedSlot === undefined) {
      offer?.pc.close();
      throw firstError ?? new Error('OpenAI session could not be established');
    }
    this.emitHealth(
      'transport',
      'reconnecting',
      wsAuthRejected
        ? `OpenAI refused the ${rejectedSlot} key on both transports - retrying with the alternate key`
        : `OpenAI rejected the ${rejectedSlot} key - retrying with the alternate key`,
    );
    // Any pre-warmed token was minted from the slot that just failed.
    warmSession.clear();
    const body = sessionRequestBody(this.langPair, this.includeSourceTranscript, this.micDistance);
    const retrySession = await postSession(this.sessionUrl, body, rejectedSlot);
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
        );
        if (!ok) {
          offer.pc.close();
          return { kind: 'aborted' };
        }
        return { kind: 'webrtc', pc: offer.pc, dc: offer.dc };
      } catch (err) {
        if (!(err instanceof SdpExchangeError) || !err.isAuthRejection) {
          offer.pc.close();
          throw err;
        }
        blockWebRtcFor(slotB);
      }
    }
    try {
      const transport = await this.openWsTransport(retrySession.client_secret.value);
      offer?.pc.close();
      return { kind: 'websocket', transport };
    } catch (err) {
      offer?.pc.close();
      throw firstError ?? (err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Open the WebSocket transport over the already-acquired mic stream. Server
   * events are fed to the SAME handler the DataChannel uses - the event
   * contract is identical, so segmentation, the wedge detector and the health
   * ladder all stay transport-agnostic.
   */
  private async openWsTransport(token: string): Promise<OpenAIWsTransport> {
    const stream = this.stream;
    if (stream === null) throw new Error('No audio stream to send to OpenAI');
    return await wsOpener(token, stream, {
      onEvent: (ev) => this.handleDCEvent(ev as DCEvent),
      onClosed: (reason) => {
        if (this._status !== 'running') return;
        this.emitHealth('transport', 'reconnecting', `OpenAI WebSocket dropped - ${reason}`);
        void this.renewSession();
      },
      onAudioTrouble: (state, message) => this.emitHealth('audio', state, message),
    });
  }

  /** Attach the live event/state handlers to a freshly-built peer. */
  private wirePeer(pc: RTCPeerConnection, dc: RTCDataChannel): void {
    dc.onmessage = (ev: MessageEvent<string>) => {
      try {
        this.handleDCEvent(JSON.parse(ev.data) as DCEvent);
      } catch (err) {
        console.warn('[openai-rt] DC event error:', err, 'raw:', ev.data.slice(0, 200));
      }
    };
    pc.oniceconnectionstatechange = () => this.handleIceState();
    pc.onconnectionstatechange = () => this.handleConnectionState();
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

  stop(): void {
    if (this._status === 'stopped') {
      // The provider is already in the 'stopped' resting state, but the
      // persistent renewal-retry timer set in scheduleRenewalRetry() can
      // still be pending — if we returned here without cleanup() the OLD
      // instance would later fire start() in parallel with a newer one
      // the user manually created, opening a duplicate mic + WebRTC
      // session. Always cancel pending work before returning.
      this.cleanup();
      return;
    }
    this.setStatus('stopped');
    this.flushSegment();
    this.cleanup();
    this.emitHealth('audio', 'stopped');
    this.emitHealth('transport', 'stopped');
  }

  private cleanup(): void {
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
    this.wsTransport?.close();
    this.wsTransport = null;
    // Releasing the mic stops the shared MediaStream tracks (this.stream points
    // at the same object the mic holds), so the OS capture indicator turns off.
    this.mic.release();
    this.stream = null;
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
   * then swap atomically — so a scheduled 25-min renewal costs ZERO caption gap
   * and never re-acquires the mic. For a failure-driven renewal (ICE/connection
   * failed, session.closed, wedge) the old peer is already dead, so there's no
   * gap to save, but reusing the mic and not tearing down the level/diagnostic
   * loops still keeps recovery clean.
   *
   * On failure the OLD peer is left untouched (a healthy scheduled renewal stays
   * live; a dead failure-driven one stays dead) and a persistent retry is
   * scheduled. Status stays 'running' throughout so the UI shows auto-recovery
   * (+ the cross-model failover affordance) rather than a dead Start button.
   */
  private async renewSession(): Promise<void> {
    if (this._status !== 'running') return;
    if (this.renewing) return; // one swap at a time
    if (!this.stream) return; // no mic to reuse — should not happen while running
    this.renewing = true;
    this.emitHealth('transport', 'reconnecting', 'Renewing OpenAI session (zero-gap)');
    try {
      const sessionData = await this.fetchSessionToken();
      if (sessionData === null || this._status !== 'running') return;
      this.renewDelayMs = sessionData.session_renewal_recommended_ms ?? this.renewDelayMs;
      // Build a fresh local offer unless WebRTC is known-blocked for this key
      // (then the ladder goes straight to the WebSocket transport and the peer
      // would be dead weight). Re-probing WebRTC here is deliberate and free:
      // the OLD session keeps captioning until the swap below, so a failed
      // probe costs latency on a background renewal, never a caption gap.
      const slot = sessionData.key_slot ?? 'unknown';
      let offer: { pc: RTCPeerConnection; dc: RTCDataChannel; offerSdp: string } | null = null;
      if (!isWebRtcBlockedFor(slot)) {
        offer = await this.createLocalOffer(this.stream);
        if (offer === null || this._status !== 'running') {
          offer?.pc.close();
          return;
        }
      }
      const outcome = await this.connectSession(sessionData, offer);
      if (outcome.kind === 'aborted' || this._status !== 'running') {
        if (outcome.kind === 'webrtc') outcome.pc.close();
        if (outcome.kind === 'websocket') outcome.transport.close();
        return;
      }

      // ── Atomic make-before-break swap ──
      // Finalize the OLD session's in-flight text first so the last line is
      // neither lost nor duplicated, then detach + close the old peer and
      // promote the new one. The new DataChannel handler is wired only HERE
      // (buildPeer left it unwired), so the new session's deltas can't
      // double-render alongside the old during the overlap window.
      this.flushSegment();
      const oldPc = this.pc;
      if (oldPc) {
        oldPc.oniceconnectionstatechange = null;
        oldPc.onconnectionstatechange = null;
        oldPc.ontrack = null;
        oldPc.close();
      }
      // Same contract for the WebSocket transport: detach first so the dying
      // socket cannot deliver a late event (or a close-driven renewal) into
      // the session that just replaced it.
      const oldWs = this.wsTransport;
      if (oldWs) {
        oldWs.detach();
        oldWs.close();
      }
      this.pc = null;
      this.wsTransport = null;
      if (outcome.kind === 'webrtc') {
        this.pc = outcome.pc;
        this.wirePeer(outcome.pc, outcome.dc);
      } else {
        this.wsTransport = outcome.transport;
      }

      // A stale ICE-restart timer from the old peer would call restartIce on the
      // NEW one — clear it and reset the backoff for a clean slate.
      if (this.iceRestartTimer !== null) {
        clearTimeout(this.iceRestartTimer);
        this.iceRestartTimer = null;
      }
      this.iceRestartAttempt = 0;
      this.resetStaleBaselines();
      this.renewalRetryAttempt = 0;
      this.scheduleRenewal(this.renewDelayMs);
      // Level polling + diagnostics persist across a normal swap (mic reused).
      // Start them if this renewal IS the bring-up (token-near-expiry-at-start).
      if (this.levelInterval === null) this.startLevelPolling();
      if (this.diagInterval === null) this.startDiagnosticDump();
      this.emitHealth('transport', 'connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Session renewal failed';
      if (this._status === 'running') this.scheduleRenewalRetry(message);
    } finally {
      this.renewing = false;
    }
  }

  /**
   * Schedule the next renewal retry using the persistent backoff sequence.
   * Called from renewSession's catch AND from the retry timer's own callback
   * when its renewSession() attempt also fails. The recursion is what makes the
   * long-meeting auto-recovery actually persist — it never gives up. cleanup()
   * cancels the pending timer on user-initiated stop.
   */
  private scheduleRenewalRetry(reason?: string): void {
    // Disarm the stale-data detector while we're in retry mode: the retry timer
    // is now the single driver of recovery. Left armed, the level-poll detector
    // would independently fire more renewSession() calls during the backoff
    // window (no DC events arrive on a dead/renewing session), racing the timer
    // and escalating the backoff faster than intended. resetStaleBaselines()
    // re-arms it on the next successful connection.
    this.lastDcEventAt = 0;
    this.audioActiveSamplesSinceDc = 0;
    const idx = Math.min(this.renewalRetryAttempt, RENEWAL_RETRY_BACKOFF_MS.length - 1);
    const delay = RENEWAL_RETRY_BACKOFF_MS[idx]!;
    this.renewalRetryAttempt += 1;
    // Format "30 sec" for sub-minute delays, "N min" for the rest. Operator
    // confidence drops if we report "auto-retry in 0 min" for a 30 s delay.
    const humanDelay =
      delay < 60_000 ? `${Math.round(delay / 1000)} sec` : `${Math.round(delay / 60_000)} min`;
    const detail = reason ? `${reason}; ` : '';
    this.emitHealth(
      'transport',
      'failed',
      `${detail}auto-retry in ${humanDelay} (attempt #${this.renewalRetryAttempt})`,
    );
    this.renewalRetryTimer = setTimeout(() => {
      this.renewalRetryTimer = null;
      if (this._status !== 'running') return;
      // renewSession's own catch re-schedules the NEXT retry if this one fails.
      void this.renewSession();
    }, delay);
  }

  private handleIceState(): void {
    const state = this.pc?.iceConnectionState;
    // Diagnostic: every transition logged. Surfaces wedged-DC scenarios
    // where iceConnectionState='connected' but DC events stopped.
    console.info('[openai-rt] iceConnectionState →', state);
    if (state === 'disconnected') {
      this.emitHealth('transport', 'reconnecting');
      this.attemptIceRestart();
    } else if (state === 'failed') {
      // ICE truly dead. Don't stop() — that leaves the user with a frozen
      // caption area and a manual Start button to click, defeating the
      // self-healing premise. Renew the whole session (fresh SDP + ICE)
      // and let the renewal-retry backoff escalate if it also fails.
      this.emitHealth('transport', 'reconnecting', 'ICE failed — rebuilding session');
      void this.renewSession();
    } else if (state === 'connected' || state === 'completed') {
      // Healthy ICE — reset backoff so a future blip starts fresh.
      this.iceRestartAttempt = 0;
    }
  }

  private handleConnectionState(): void {
    const state = this.pc?.connectionState;
    console.info('[openai-rt] connectionState →', state);
    // connectionState aggregates ICE+DTLS. 'failed' means the transport
    // can't recover via ICE restart alone — go straight to a full session
    // renewal (same self-heal premise as ICE failure above). 'disconnected'
    // is transient (browser waits ~30s before promoting to 'failed') so we
    // surface it but don't tear down — let ICE restart or the stale
    // detector handle recovery.
    if (state === 'failed') {
      this.emitHealth('transport', 'reconnecting', 'Peer connection failed — rebuilding session');
      void this.renewSession();
    } else if (state === 'disconnected') {
      this.emitHealth(
        'transport',
        'reconnecting',
        'Peer connection disconnected — waiting for recovery',
      );
    }
  }

  private attemptIceRestart(): void {
    if (this.iceRestartTimer !== null) return; // restart already pending
    if (this.iceRestartAttempt >= ICE_RESTART_DELAYS_MS.length) {
      // ICE restart didn't bring the connection back. Escalate to a full
      // session renewal instead of giving up — the renewal-retry backoff
      // takes over from there so the meeting heals without operator
      // intervention.
      this.emitHealth('transport', 'reconnecting', 'ICE restart exhausted — rebuilding session');
      void this.renewSession();
      return;
    }
    const delay = ICE_RESTART_DELAYS_MS[this.iceRestartAttempt];
    this.iceRestartAttempt += 1;
    this.iceRestartTimer = setTimeout(() => {
      this.iceRestartTimer = null;
      if (this.pc?.iceConnectionState === 'disconnected') {
        this.pc.restartIce();
      }
    }, delay);
  }

  private handleDCEvent(ev: DCEvent): void {
    // Any DC event proves the upstream session is alive — feed the
    // stale-data detector so we don't false-positive while events flow.
    this.lastDcEventAt = Date.now();
    this.dcEventCount += 1;
    // Reset the per-DC audio-active counter: each DC event "consumes" the
    // accumulated audio evidence, so the next stale window starts fresh.
    this.audioActiveSamplesSinceDc = 0;
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
        // OpenAI confirmed the translation session is active — already emitted connected on SDP
        break;

      case 'session.closed':
        // OpenAI closed the session (likely 30-min cap hit before our 25-min renewal,
        // or upstream policy). Renew transparently — captionStore is preserved.
        if (this._status === 'running') {
          void this.renewSession();
        }
        break;

      case 'session.input_transcript.delta': {
        if (!ev.delta) break;
        this.inputDeltaCount += 1;
        this.inputAcc += ev.delta;
        const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
        // Whisper transcribes Mandarin as Simplified Chinese — convert to Traditional for zh-TW source
        const transcriptText = meta.src === 'zh-TW' ? s2tw(this.inputAcc) : this.inputAcc;
        const t: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: this.sourceKind,
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
        this.outputDeltaCount += 1;
        this.outputAcc += ev.delta;
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
        const srcSoFar = meta.src === 'zh-TW' ? s2tw(this.inputAcc) : this.inputAcc;
        const synth: TranscriptEvent = {
          kind: 'transcript',
          provider: 'openai-realtime',
          mode: 'online_full',
          source: this.sourceKind,
          segmentId: this.currentSegmentId,
          status: 'partial',
          text: srcSoFar,
          startMs: this.startMs,
        };
        this.handlers.onTranscript(synth);

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
    // Arm the absolute deadline only on the FIRST delta of a segment —
    // resetting it on every delta would defeat the purpose (the bug we're
    // fixing). flushSegment() clears it so the next segment can arm a fresh one.
    if (this.segmentDeadlineTimer === null) {
      this.segmentDeadlineTimer = setTimeout(() => {
        this.segmentDeadlineTimer = null;
        if (this._status === 'running') this.flushSegment();
      }, MAX_SEGMENT_DURATION_MS);
    }
  }

  private flushSegment(): void {
    // Clear the deadline whether or not there's text to flush — if a stray
    // empty flush fires we still want the next segment to start with a fresh
    // deadline window, not inherit the old one.
    if (this.segmentDeadlineTimer !== null) {
      clearTimeout(this.segmentDeadlineTimer);
      this.segmentDeadlineTimer = null;
    }
    if (!this.inputAcc && !this.outputAcc) return;
    const meta = LANG_PAIR_META[this.langPair] ?? DEFAULT_META;
    // Apply Traditional Chinese conversion to transcript text when source is zh-TW
    const transcriptText = meta.src === 'zh-TW' ? s2tw(this.inputAcc) : this.inputAcc;

    const t: TranscriptEvent = {
      kind: 'transcript',
      provider: 'openai-realtime',
      mode: 'online_full',
      source: this.sourceKind,
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
    this.currentSegmentId = crypto.randomUUID();
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

      // Stale-data detection. Count cumulative audio-active ticks since the
      // last DC event — this tolerates natural sentence-boundary pauses
      // (silent ticks just don't increment) while still requiring meaningful
      // evidence that the user IS speaking. The previous stretch-based
      // detector reset on every >1 s pause, so a presenter who spoke in
      // 5-second sentences with 1-2 s gaps NEVER accumulated enough stretch
      // to trip the threshold even when DC was wedged for minutes.
      const audioActiveDb = STALE_AUDIO_ACTIVE_DB_BY_MIC[this.micDistance];
      if (rmsDb > audioActiveDb) {
        this.lastAudioActiveAt = nowMs;
        this.audioActiveSamplesSinceDc += 1;
        // Speech resumed after silence — recover the health state.
        if (this.silenceEmitted) {
          this.silenceEmitted = false;
          this.emitHealth('audio', 'connected');
        }
      }

      // Silence detection: user has not spoken for SILENCE_DETECT_MS.
      // Only fire once per silence window (silenceEmitted gate) and only
      // after we have observed at least one active audio sample since the
      // session started (lastAudioActiveAt > 0) — so we don't alarm on the
      // brief quiet window between mic grant and the user's first word.
      const SILENCE_DETECT_MS = 30_000;
      if (
        !this.silenceEmitted &&
        this.lastAudioActiveAt > 0 &&
        nowMs - this.lastAudioActiveAt > SILENCE_DETECT_MS
      ) {
        this.silenceEmitted = true;
        this.emitHealth('audio', 'silence_detected');
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
          );
          // Reset to suppress double-fire while renewSession runs (it will
          // tear down and re-init, resetting lastDcEventAt on success).
          this.lastDcEventAt = 0;
          this.audioActiveSamplesSinceDc = 0;
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

  private emitHealth(component: HealthComponent, state: HealthState, message?: string): void {
    const ev: HealthEvent = { kind: 'health', component, state, timestamp: iso() };
    if (message !== undefined) ev.message = message;
    this.handlers.onHealth(ev);
  }
}
