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
// Persistent renewal-retry backoff: 30s → 1m → 3m → 5m → 10m cap forever.
// Previous schedule started at 5 min which is unacceptable for live meeting
// service — a transient OpenAI hiccup would leave captions dark for 5
// minutes before the first heal attempt. Starting at 30 s recovers
// transient failures quickly while the longer tail still backs off if
// the failure is persistent (rate limit, hard outage).
const RENEWAL_RETRY_BACKOFF_MS = [
  30 * 1000,
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
const STALE_AUDIO_ACTIVE_DB_BY_MIC: Record<'close' | 'far' | 'off', number> = {
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

interface SessionResponse {
  client_secret: { value: string; expires_at?: number };
  session_renewal_recommended_ms?: number;
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
  private readonly mic: AudioSource;
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
  // WebRTC wedges leave forensic evidence in DevTools.
  private dcEventCount = 0;
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
     * 'close' | 'far' | 'off' — drives both getUserMedia AGC and the
     * upstream noise_reduction config (kept in lockstep so the audio
     * path is internally consistent).
     */
    private readonly micDistance: 'close' | 'far' | 'off' = 'close',
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
      try { fn(s); } catch { /* listener errors must not corrupt provider state */ }
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
      return;
    }
    if (aborted()) {
      // User pressed Stop while mic dialog was open. mic.acquire returned a
      // stream but we never used it — release tracks so the OS mic indicator
      // turns off.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // Step 2+: token broker → SDP exchange. Failures here are TRANSPORT failures.
    try {
      this.emitHealth('transport', 'connecting');
      const sessionRes = await fetch(this.sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          langPair: this.langPair,
          includeSourceTranscript: this.includeSourceTranscript,
          micDistance: this.micDistance,
        }),
      });
      if (aborted()) return;
      if (!sessionRes.ok) {
        const text = await sessionRes.text().catch(() => '');
        throw new Error(`/session failed (${sessionRes.status}): ${text || sessionRes.statusText}`);
      }
      const sessionData = (await sessionRes.json()) as SessionResponse;
      if (aborted()) return;
      const { client_secret } = sessionData;
      this.renewDelayMs =
        sessionData.session_renewal_recommended_ms ?? DEFAULT_SESSION_RENEW_MS;

      // Guard against an already-expired or imminently-expiring token.
      // expires_at is Unix seconds; if less than 60 s remain, skip SDP
      // and go straight to renewSession() which will fetch a fresh token.
      // This handles clock drift and the edge case where a cached /session
      // response is replayed after the tab sleeps through the 25-min mark.
      if (client_secret.expires_at !== undefined) {
        const remainingMs = client_secret.expires_at * 1000 - Date.now();
        if (remainingMs < 60_000) {
          this.emitHealth('transport', 'reconnecting', 'Session token near expiry — refreshing before connect');
          this.setStatus('idle');
          void this.renewSession();
          return;
        }
      }

      // Configure ICE servers so corporate / strict-firewall networks can
      // gather server-reflexive candidates and complete the WebRTC handshake.
      // Browsers' built-in default works on home/open Wi-Fi but typically
      // fails on enterprise NAT — the user just sees "ICE connection failed"
      // with no clue what to do. Google's public STUN is fine for this; the
      // OpenAI session itself still flows over the negotiated path.
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      // We do NOT want the model's translated voice — caption-only UX. Stop
      // any incoming audio track immediately so OpenAI knows we won't
      // consume it and the browser doesn't buffer the PCM stream in memory.
      this.pc.ontrack = (ev: RTCTrackEvent) => {
        for (const track of ev.streams[0]?.getTracks() ?? []) {
          track.stop();
        }
      };
      const dc = this.pc.createDataChannel('oai-events');
      dc.onmessage = (ev: MessageEvent<string>) => {
        try {
          this.handleDCEvent(JSON.parse(ev.data) as DCEvent);
        } catch (err) {
          console.warn('[openai-rt] DC event error:', err, 'raw:', ev.data.slice(0, 200));
        }
      };
      stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream));
      this.pc.oniceconnectionstatechange = () => this.handleIceState();
      this.pc.onconnectionstatechange = () => this.handleConnectionState();

      const offer = await this.pc.createOffer();
      if (aborted() || !this.pc) return;
      await this.pc.setLocalDescription(offer);
      if (aborted() || !this.pc) return;
      const sdpRes = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client_secret.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp!,
      });
      if (aborted() || !this.pc) return;
      if (!sdpRes.ok) {
        throw new Error(`OpenAI SDP exchange failed (${sdpRes.status})`);
      }
      const sdpText = await sdpRes.text();
      if (aborted() || !this.pc) return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpText });
      if (aborted() || !this.pc) return;
      this.emitHealth('transport', 'connected');

      // Bring-up succeeded — any prior renewal-retry backoff state is now
      // moot. Reset the counter so a fresh failure later starts at 5 min,
      // not at whatever the previous failure escalated to.
      this.renewalRetryAttempt = 0;

      // Reset stale-data detector baselines so the 30 s grace period
      // starts now, not at whatever the previous run left behind.
      this.lastDcEventAt = Date.now();
      this.lastAudioActiveAt = 0;
      this.audioActiveSamplesSinceDc = 0;
      this.silenceEmitted = false;

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
    this.pc?.close();
    this.pc = null;
    this.mic.release();
  }

  private scheduleRenewal(delayMs: number): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewScheduledAtMs = Date.now();
    this.renewDelayMs = delayMs;
    this.renewTimer = setTimeout(() => this.renewSession(), delayMs);
  }

  private async renewSession(): Promise<void> {
    if (this._status !== 'running') return;
    // Skip if a connection (re)bring-up is already in flight — avoids double SDP.
    if (this.pc?.connectionState === 'connecting') {
      this.scheduleRenewal(this.renewDelayMs);
      return;
    }
    this.emitHealth('transport', 'reconnecting', 'Renewing OpenAI session before 30-min cap');
    this.flushSegment();
    this.cleanup();
    this.setStatus('idle');
    // Re-enter start(); captionStore is intentionally NOT cleared.
    try {
      await this.start();
      // start() mutates _status; read via .status getter to avoid TS literal narrowing.
      if (this.status !== 'running') {
        throw new Error('renewal start did not reach running');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Session renewal failed';
      // Persistent backoff retry — long meetings must heal themselves even
      // if the first retry also fails. Counter resets to 0 on any
      // successful start(). cleanup() cancels the pending timer if the
      // user manually stops or restarts in the interim.
      if (this.status === 'stopped') {
        this.scheduleRenewalRetry(message);
      }
    }
  }

  /**
   * Schedule the next renewal retry using the persistent backoff sequence.
   * Called from renewSession's catch AND from the retry timer's own
   * callback when its start() attempt also fails. The recursion is what
   * makes the long-meeting auto-recovery actually persist.
   */
  private scheduleRenewalRetry(reason?: string): void {
    const idx = Math.min(this.renewalRetryAttempt, RENEWAL_RETRY_BACKOFF_MS.length - 1);
    const delay = RENEWAL_RETRY_BACKOFF_MS[idx]!;
    this.renewalRetryAttempt += 1;
    // Format "30 sec" for sub-minute delays, "N min" for the rest. Operator
    // confidence drops if we report "auto-retry in 0 min" for a 30 s delay.
    const humanDelay =
      delay < 60_000
        ? `${Math.round(delay / 1000)} sec`
        : `${Math.round(delay / 60_000)} min`;
    const detail = reason ? `${reason}; ` : '';
    this.emitHealth(
      'transport',
      'failed',
      `${detail}auto-retry in ${humanDelay} (attempt #${this.renewalRetryAttempt})`,
    );
    this.renewalRetryTimer = setTimeout(async () => {
      this.renewalRetryTimer = null;
      if (this._status !== 'stopped') return;
      try {
        await this.start();
      } catch {
        // start()'s own catch already runs cleanup + sets _status='stopped';
        // surfaced via api_error event.
      }
      // If the retry attempt itself did not reach running, schedule the
      // NEXT one with the bumped backoff. cleanup() cancels this timer
      // if user manually stops or starts in the interim.
      if (this.status === 'stopped') {
        this.scheduleRenewalRetry();
      }
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
      this.emitHealth('transport', 'reconnecting', 'Peer connection disconnected — waiting for recovery');
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

        // Translation-only mode (includeSourceTranscript=false): OpenAI
        // never emits `session.input_transcript.delta` because no upstream
        // whisper transcription was requested. Without an input-side
        // transcript event the store never sets `livePartial`, so the
        // caption store's `applyTranslation` routes every draft into the
        // finalized `translations` map — and `LiveCaption` only renders
        // `liveTranslation`, leaving the main view blank until the 1 s
        // flush emits a final segment.
        //
        // Synthesize a zero-text partial transcript here to anchor the
        // live segment. The UI hides the (empty) source row anyway via
        // the bilingual gate, so this is invisible to the user but keeps
        // the live caption area updating at draft rate.
        if (!this.includeSourceTranscript) {
          const synth: TranscriptEvent = {
            kind: 'transcript',
            provider: 'openai-realtime',
            mode: 'online_full',
            source: 'microphone',
            segmentId: this.currentSegmentId,
            status: 'partial',
            text: '',
            startMs: this.startMs,
          };
          this.handlers.onTranscript(synth);
        }

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
        source: 'microphone',
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
        pcConn: this.pc?.connectionState,
        pcIce: this.pc?.iceConnectionState,
        dcEvents: this.dcEventCount,
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
