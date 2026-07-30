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

// Path to AudioWorklet module served from apps/web/public/

function iso(): string {
  return new Date().toISOString();
}

/** Normalized event union emitted by services/offline /ws */
type OfflineEvent =
  | ({ kind: 'transcript' } & TranscriptEvent)
  | ({ kind: 'translation' } & TranslationEvent)
  | ({ kind: 'health' } & HealthEvent);

export class OfflineSTTProvider implements CaptionProvider {
  readonly name = 'offline-stt';

  private _status: ProviderStatus = 'idle';
  private readonly mic: AudioSource;
  private ws: WebSocket | null = null;
  // Shared capture context (owned by audio-engine; never closed here).
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  // Wall-clock anchor for the CURRENT WebSocket connection. WHL emits startMs
  // relative to audio position and RESETS it to 0 on every connection — so
  // without rebasing, segments from a reconnect or Pause→Resume would carry
  // startMs≈0 and sort to the FRONT of the caption history (upsertSorted orders
  // by startMs), corrupting chronology; and export / time-gutter elapsed
  // (startMs − sessionStartMs, where sessionStartMs is Date.now()) would clamp
  // to 0:00 for every offline segment. Adding this anchor converts the
  // connection-relative timeline into a wall-clock-absolute one, unifying
  // offline timestamps with the online providers (which already use Date.now()).
  // Re-stamped on every (re)connect so the timeline stays monotonic across drops.
  private connectionAnchorMs = 0;
  // Reconnect state — exponential backoff after WS drops while still 'running'.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  // Backpressure: count of PCM frames dropped because ws.bufferedAmount
  // exceeded the threshold. Surfaced as a degraded-audio health event
  // every 50 drops so the user sees the symptom instead of a silent gap.
  private wsBackpressureDropCount = 0;
  // Consecutive (run-length) drops — separate from the cumulative count.
  // Reset on every successful send. Once we've dropped this many in a
  // row, the WS is effectively dead even though readyState says OPEN
  // (sustained backpressure, no recovery in sight). Force-close so the
  // existing onclose → scheduleReconnect machinery takes over.
  private wsBackpressureConsecutiveDrops = 0;
  // 1 MB ≈ 16 s of 16 kHz mono Float32 — plenty of headroom for a
  // transient WHL stall (model load, MT pause) without inviting an
  // unbounded memory leak across a long meeting.
  private static readonly WS_BACKPRESSURE_THRESHOLD = 1_000_000;
  // 100 consecutive drops at typical AudioWorklet cadence (60–100 Hz)
  // = ~1–1.7 s of nonstop drops. Long enough to ride out a brief MT
  // executor stall; short enough that a truly wedged WS triggers a
  // reconnect within ~2 s instead of dropping audio forever.
  private static readonly WS_BACKPRESSURE_FORCE_RECONNECT_DROPS = 100;

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: CaptionProviderHandlers,
    mic?: AudioSource,
    private readonly langPair: string = 'en→zh-TW',
    private readonly audioSource: 'mic' | 'system' = 'mic',
    private readonly translate: boolean = true,
  ) {
    this.mic = mic ?? new MicrophoneAudioProvider();
  }

  get status(): ProviderStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') return;
    this._status = 'running';

    try {
      if (this.audioSource === 'mic') {
        this.stream = await this.mic.acquire(this.handlers.onHealth);
      }
      this.emitHealth('transport', 'connecting');
      await this.connectWebSocket();
      if (this.audioSource === 'mic') {
        await this.startAudioCapture();
        this.startLevelPolling();
      }
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
        reject(new Error('services/offline WebSocket connection timed out'));
      }, 15000);

      ws.onopen = () => {
        // Anchor this connection's relative timeline onto wall-clock NOW, so a
        // reconnect / Resume continues monotonically instead of restarting at 0.
        this.connectionAnchorMs = Date.now();
        ws.send(
          JSON.stringify({
            type: 'start',
            langPair: this.langPair,
            source: this.audioSource,
            translate: this.translate,
          }),
        );
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        resolve();
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const event = JSON.parse(ev.data) as OfflineEvent;
          this.handleEvent(event);
        } catch {
          // malformed JSON — ignore
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('services/offline WebSocket error'));
      };

      ws.onclose = () => {
        // Only attempt recovery if we're still meant to be running (user didn't click Stop).
        if (this._status !== 'running') return;
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS) {
      this.emitHealth(
        'transport',
        'failed',
        `Auto-reconnect gave up after ${OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      this.stop();
      return;
    }
    const delayMs = Math.min(16000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.emitHealth(
      'transport',
      'reconnecting',
      `WS dropped — retry ${this.reconnectAttempts}/${OfflineSTTProvider.MAX_RECONNECT_ATTEMPTS} in ${delayMs / 1000}s`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._status !== 'running') return;
      this.connectWebSocket().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitHealth('transport', 'reconnecting', `Retry failed: ${msg}`);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private handleEvent(event: OfflineEvent): void {
    switch (event.kind) {
      case 'transcript':
        this.handlers.onTranscript(this.rebaseTranscript(event as TranscriptEvent));
        break;
      case 'translation':
        // Translations key by sourceSegmentId (no time field) → no rebase needed.
        this.handlers.onTranslation(event as TranslationEvent);
        break;
      case 'health':
        this.handlers.onHealth(event as HealthEvent);
        break;
    }
  }

  /**
   * Shift a connection-relative transcript onto the wall-clock timeline using
   * this connection's anchor (see `connectionAnchorMs`). Partials and their
   * eventual final share the same start_key + anchor, so livePartial→final
   * promotion still lines up. Returns the event unchanged if no anchor is set
   * yet (defensive — should not happen, since onopen always sets it first).
   */
  private rebaseTranscript(e: TranscriptEvent): TranscriptEvent {
    if (this.connectionAnchorMs === 0) return e;
    const out: TranscriptEvent = { ...e, startMs: this.connectionAnchorMs + e.startMs };
    if (e.endMs !== undefined) out.endMs = this.connectionAnchorMs + e.endMs;
    return out;
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.stream) return;
    try {
      // Reuse the shared, pre-warmed 16 kHz capture context + worklet module
      // (the per-start rebuild was pure startup latency). Engine owns the ctx.
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
      });

      this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (this._status !== 'running' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        // Backpressure guard: if the WS send buffer is growing (services/offline
        // CPU-bound, model loading, MT executor stalled), unbounded `send()`
        // calls let the browser-side buffer grow forever — long meetings would
        // OOM the tab. Drop frames above the threshold and surface the symptom.
        if (this.ws.bufferedAmount > OfflineSTTProvider.WS_BACKPRESSURE_THRESHOLD) {
          this.wsBackpressureDropCount += 1;
          this.wsBackpressureConsecutiveDrops += 1;
          if (this.wsBackpressureDropCount % 50 === 0) {
            this.emitHealth(
              'audio',
              'degraded',
              `Offline service slow — ${this.wsBackpressureDropCount} PCM frames dropped (buffer ${Math.round(this.ws.bufferedAmount / 1024)} KB)`,
            );
          }
          // Sustained backpressure — the WS is dead in everything but name.
          // Force-close so onclose triggers scheduleReconnect; otherwise the
          // session would silently drop audio indefinitely while the readyState
          // stays OPEN.
          if (
            this.wsBackpressureConsecutiveDrops >=
            OfflineSTTProvider.WS_BACKPRESSURE_FORCE_RECONNECT_DROPS
          ) {
            this.emitHealth(
              'transport',
              'reconnecting',
              `Sustained WS backpressure (${this.wsBackpressureConsecutiveDrops} consecutive drops) — forcing reconnect`,
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
        // Successful send — buffer is draining, reset the consecutive counter.
        this.wsBackpressureConsecutiveDrops = 0;
        this.ws.send(ev.data);
      };

      source.connect(this.workletNode);
      // Must connect to destination: Chrome's audio pull model only calls process() when there is
      // a path to AudioDestinationNode. The worklet outputs silence (no samples written to outputs),
      // so nothing plays back through the speakers — but the connection keeps process() alive.
      this.workletNode.connect(ctx.destination);
      // Resume in case the shared context was pre-warmed (created suspended,
      // outside a user-gesture window) before this Start.
      await resumeCaptureContext();
    } catch {
      // AudioContext/AudioWorklet unavailable (e.g., test environment) — non-fatal
      this.emitHealth('audio', 'degraded', 'AudioWorklet unavailable');
    }
  }

  private startLevelPolling(): void {
    const analyser = (this.mic as MicrophoneAudioProvider).analyser;
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
    this.connectionAnchorMs = 0;
    this.wsBackpressureDropCount = 0;
    this.wsBackpressureConsecutiveDrops = 0;
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.sourceNode?.disconnect?.();
    // Do NOT close the context — shared engine context, reused next session.
    this.workletNode = null;
    this.sourceNode = null;
    this.audioCtx = null;
    this.ws?.close();
    this.ws = null;
    if (this.audioSource === 'mic') this.mic.release();
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
