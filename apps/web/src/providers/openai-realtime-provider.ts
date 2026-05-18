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
const AUDIO_LEVEL_INTERVAL_MS = 100;
const PEAK_HOLD_MS = 2000;
const PEAK_DECAY_DB_PER_TICK = 0.1;
// Fallback if /session reply omits the renewal hint. Matches server default.
const DEFAULT_SESSION_RENEW_MS = 25 * 60 * 1000;
// Bounded ICE-restart strategy: 3 attempts, 3 s → 6 s → 12 s.
const ICE_RESTART_DELAYS_MS = [3000, 6000, 12000];
// Persistent renewal-retry backoff: 5, 10, 20 then 30-min cap forever.
// A long business meeting that hits OpenAI flakiness mid-stream must heal
// itself without operator intervention — the previous single-shot 5-min
// retry could leave a 90-min meeting silently dead after one bad transient.
const RENEWAL_RETRY_BACKOFF_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  20 * 60 * 1000,
  30 * 60 * 1000,
];

// Stale-data detection. If we observe RMS above the silence floor for a
// stretch AND no DataChannel deltas have arrived in the last threshold,
// the upstream session is wedged (DC open, no events) — force a renewal.
// Without this, OpenAI hiccups manifest as a frozen caption area with
// "Connected" health, with no way for the user to know.
const STALE_DATA_THRESHOLD_MS = 30_000;
const STALE_AUDIO_ACTIVE_DB = -40;

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
  client_secret: { value: string };
  session_renewal_recommended_ms?: number;
}

export class OpenAIRealtimeProvider implements CaptionProvider {
  readonly name = 'openai-realtime';

  private _status: ProviderStatus = 'idle';
  private pc: RTCPeerConnection | null = null;
  private readonly mic: AudioSource;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private segmentFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewScheduledAtMs = 0;
  private renewDelayMs = DEFAULT_SESSION_RENEW_MS;
  private iceRestartAttempt = 0;
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalRetryAttempt = 0;
  // Stale-data detection state.
  private lastDcEventAt = 0;
  private lastAudioActiveAt = 0;
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

  /** Milliseconds remaining before the next scheduled session renewal, or null when no renewal is pending. */
  getRenewalEtaMs(): number | null {
    if (this.renewTimer === null || this.renewScheduledAtMs === 0) return null;
    const due = this.renewScheduledAtMs + this.renewDelayMs;
    return Math.max(0, due - Date.now());
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone unavailable';
      // mic.acquire already emitted health.audio.failed; surface the error and stop.
      this.emitHealth('audio', 'failed', message);
      this._status = 'stopped';
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
        } catch {
          // malformed event — ignore
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

      this.startLevelPolling();
      this.scheduleRenewal(this.renewDelayMs);
    } catch (err) {
      if (aborted()) return; // user already stopped; don't surface a misleading error
      const message = err instanceof Error ? err.message : 'Unknown error starting Realtime';
      this.emitHealth('transport', 'api_error', message);
      this._status = 'stopped';
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
    this._status = 'stopped';
    this.flushSegment();
    this.cleanup();
    this.emitHealth('audio', 'stopped');
    this.emitHealth('transport', 'stopped');
  }

  private cleanup(): void {
    if (this.levelInterval !== null) clearInterval(this.levelInterval);
    if (this.segmentFlushTimer !== null) clearTimeout(this.segmentFlushTimer);
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    if (this.iceRestartTimer !== null) clearTimeout(this.iceRestartTimer);
    if (this.renewalRetryTimer !== null) clearTimeout(this.renewalRetryTimer);
    this.levelInterval = null;
    this.segmentFlushTimer = null;
    this.renewTimer = null;
    this.iceRestartTimer = null;
    this.renewalRetryTimer = null;
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
    this._status = 'idle';
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
    const minutes = Math.round(delay / 60_000);
    const detail = reason ? `${reason}; ` : '';
    this.emitHealth(
      'transport',
      'failed',
      `${detail}auto-retry in ${minutes} min (attempt #${this.renewalRetryAttempt})`,
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
    if (state === 'disconnected') {
      this.emitHealth('transport', 'reconnecting');
      this.attemptIceRestart();
    } else if (state === 'failed') {
      this.emitHealth('transport', 'failed', 'ICE connection failed');
      this.stop();
    } else if (state === 'connected' || state === 'completed') {
      // Healthy ICE — reset backoff so a future blip starts fresh.
      this.iceRestartAttempt = 0;
    }
  }

  private handleConnectionState(): void {
    const state = this.pc?.connectionState;
    // connectionState aggregates ICE+DTLS. 'failed' is more authoritative
    // than iceConnectionState alone; act on it immediately.
    if (state === 'failed') {
      this.emitHealth('transport', 'failed', 'Peer connection failed');
      this.stop();
    }
  }

  private attemptIceRestart(): void {
    if (this.iceRestartTimer !== null) return; // restart already pending
    if (this.iceRestartAttempt >= ICE_RESTART_DELAYS_MS.length) {
      this.emitHealth('transport', 'failed', 'ICE restart attempts exhausted');
      this.stop();
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

      // Stale-data detection. Track when audio was last "loud" so we can
      // distinguish "user is silent" (no DC events expected) from "user
      // is speaking but upstream session is wedged" (force renewal).
      if (rmsDb > STALE_AUDIO_ACTIVE_DB) {
        this.lastAudioActiveAt = nowMs;
      }
      if (
        this.lastDcEventAt > 0 &&
        this.lastAudioActiveAt > this.lastDcEventAt &&
        nowMs - this.lastDcEventAt > STALE_DATA_THRESHOLD_MS
      ) {
        this.emitHealth(
          'transport',
          'degraded',
          'No transcript for 30 s while audio active — auto-renewing session',
        );
        // Reset to suppress double-fire while renewSession runs (it will
        // tear down and re-init, resetting lastDcEventAt on success).
        this.lastDcEventAt = 0;
        void this.renewSession();
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
