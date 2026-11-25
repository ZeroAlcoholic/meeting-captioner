// ─── OpenAI Realtime translation over WebSocket ──────────────────────────────
//
// The second transport for the SAME OpenAI realtime translation session. Not a
// second provider: the server event contract is byte-for-byte the one the
// WebRTC DataChannel already delivers (`session.created`,
// `session.input_transcript.delta`, `session.output_transcript.delta`,
// `session.closed`, `error`), so OpenAIRealtimeProvider feeds both transports
// into the same handler and keeps one segmentation / health / renewal path.
//
// WHY IT EXISTS (measured 2026-08-20): the corporate service-account key mints
// tokens, serves inference, and opens THIS transport happily, but
// `POST /v1/realtime/**/calls` — the WebRTC leg — rejects its ephemeral tokens
// with `401 ip_not_authorized`. Falling back to the personal key would move
// corporate meeting audio into a personal OpenAI account; falling back to this
// transport keeps the session inside the corporate organisation. See
// docs/FAILURE_MODES.md.
//
// The two transports differ in exactly one place: WebRTC carries the mic as an
// RTP track, so the browser never touches the samples. Here we pump the audio
// ourselves — the shared AudioWorklet, resampled to 24 kHz, into base64
// `session.input_audio_buffer.append` frames.

import {
  ensureCaptureWorklet,
  getCaptureContext,
  pcmChunkSizeForRate,
  resamplePcm,
  resumeCaptureContext,
  type ResampleState,
} from './audio-engine.js';
import type { HealthEvent } from '@meeting-audio/contracts';
import { monitorCaptureHealth } from './capture-health.js';
import { arrayBufferToBase64, floatTo16BitPCM } from './gemini-live-provider.js';

export type { ResampleState };

const OPENAI_TRANSLATION_WS_URL = 'wss://api.openai.com/v1/realtime/translations';

// The append event is specified as "base64-encoded 24 kHz PCM16 mono
// little-endian raw audio bytes", the rate is NOT configurable (there is no
// `session.audio.input.format` on a translation session — it is rejected as an
// unknown parameter), and unsupported formats are documented to return a
// validation error.
//
// A 16 kHz feed was observed transcribing correctly, so the server evidently
// tolerates more than it promises. We do not build on that: the shared capture
// context runs at 16 kHz, and when a browser refuses an explicit rate the
// engine falls back to the hardware default — usually 48 kHz. Sending 48 kHz
// samples to a decoder expecting 24 kHz is double-speed audio, which is the
// silent-garbage failure this project's rules exist to forbid. Convert
// explicitly instead, from whatever rate the context actually gave us.
const TARGET_SAMPLE_RATE = 24_000;

/**
 * Linear-interpolate `input` (at `inputRate`) to 24 kHz, carrying `state` so
 * consecutive chunks join without a step discontinuity. Exported for tests.
 */
export function resampleTo24kHz(
  input: Float32Array,
  inputRate: number,
  state: ResampleState,
): Float32Array {
  return resamplePcm(input, inputRate, TARGET_SAMPLE_RATE, state);
}

// 512 samples @ 16 kHz = 32 ms of front-of-pipe latency, matching the Gemini
// path. Same caveat as there: smaller is not measurably better end to end.
const PCM_CHUNK_SIZE = 512;

// Give up if the session does not come up in this long — a hung TLS/upgrade
// must not leave the caption board stuck on "connecting" forever.
const SESSION_OPEN_TIMEOUT_MS = 10_000;

// Backpressure: a stalled-but-OPEN socket would grow the browser send buffer
// without bound over a long meeting. Mirrors the Gemini transport.
const WS_BACKPRESSURE_THRESHOLD = 1_000_000;
const WS_FORCE_RECONNECT_DROPS = 100;

/** Server events arrive shaped exactly like the WebRTC DataChannel's. */
export interface OpenAIWsEvent {
  type: string;
  delta?: string;
  error?: { message?: string; code?: string };
}

export interface OpenAIWsTransportHandlers {
  onCaptureHealth?: (event: HealthEvent) => void;
  /** One server event — hand straight to the provider's event handler. */
  onEvent: (ev: OpenAIWsEvent) => void;
  /** The socket closed after coming up (never fires after detach()/close()). */
  onClosed: (reason: string) => void;
  /** Audio-path trouble worth surfacing (backpressure, capture failure). */
  onAudioTrouble: (
    state: 'connected' | 'degraded' | 'failed',
    message: string,
    component?: 'audio' | 'transport',
  ) => void;
}

/**
 * Failure to bring the WebSocket session up. `isAuthRejection` marks the cases
 * where retrying with a different key could plausibly help, so the provider's
 * failover ladder can tell "this key is not allowed" apart from "the network
 * dropped" — the same distinction the WebRTC leg makes on 401/403.
 */
export class OpenAIWsOpenError extends Error {
  constructor(
    message: string,
    readonly isAuthRejection: boolean,
  ) {
    super(message);
    this.name = 'OpenAIWsOpenError';
  }
}

/** Close codes/reasons that mean "these credentials were refused". */
function looksLikeAuthRejection(code: number, reason: string): boolean {
  if (code === 4001 || code === 4003) return true;
  // 1008 is a generic policy violation, not evidence for switching accounts.
  return /unauthor|not[_ ]authorized|invalid_?api_?key|forbidden|\b(?:401|403)\b/i.test(reason);
}

export class OpenAIWsTransport {
  private constructor(
    private readonly ws: WebSocket,
    private readonly handlers: OpenAIWsTransportHandlers,
  ) {}

  private readonly capture = new AbortController();
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private captureHealth: ReturnType<typeof monitorCaptureHealth> | null = null;
  get captureHealthy(): boolean {
    return this.captureHealth?.healthy ?? true;
  }
  private detached = false;
  private activated = false;
  private activationError: OpenAIWsOpenError | null = null;
  private drainSink: { onEvent: (event: OpenAIWsEvent) => void; onClosed: () => void } | null =
    null;
  private readonly pendingEvents: OpenAIWsEvent[] = [];
  private closedBeforeActivation: { code: number; reason: string } | null = null;
  private dropCount = 0;
  private consecutiveDrops = 0;
  /** Whatever rate the shared capture context actually came up at. */
  private inputSampleRate = TARGET_SAMPLE_RATE;
  private readonly resampleState: ResampleState = { pos: 0, last: 0 };

  /**
   * Open a translation session over WebSocket and start streaming `stream`.
   * Resolves only once the server has confirmed `session.created`, so a caller
   * that gets a transport back knows the session is live — no half-open state
   * that looks connected while producing nothing.
   *
   * Rejects with OpenAIWsOpenError on refusal/timeout. Any events that arrive
   * during bring-up (deltas can precede the caller's first tick) stay buffered
   * until the owner calls `activate()`. This gives make-before-break renewal an
   * atomic hand-off point before new-session events touch shared caption state.
   */
  static open(
    token: string,
    stream: MediaStream,
    handlers: OpenAIWsTransportHandlers,
    signal?: AbortSignal,
  ): Promise<OpenAIWsTransport> {
    return new Promise<OpenAIWsTransport>((resolve, reject) => {
      let ws: WebSocket;
      try {
        // The ephemeral token rides the subprotocol — the browser cannot set an
        // Authorization header on a WebSocket. It is short-lived and
        // session-scoped; the raw API key still never leaves the server.
        ws = new WebSocket(OPENAI_TRANSLATION_WS_URL, [
          'realtime',
          `openai-insecure-api-key.${token}`,
        ]);
      } catch (err) {
        reject(new OpenAIWsOpenError(`WebSocket could not be created: ${String(err)}`, false));
        return;
      }

      // `settled` = the open() promise has an outcome. `opened` = the session
      // actually came up and the caller owns it. They are NOT the same: a
      // timeout, an in-band error, or a socket that dies while the audio pump
      // is still starting all settle the promise WITHOUT ever handing over a
      // live session. Reporting those through onClosed would kick the
      // provider's renewal ladder off in parallel with the failure the caller
      // is already handling — two ladders, two token mints, two transports
      // racing to become the live one.
      let settled = false;
      let opened = false;
      let sessionCreated = false;
      const transport = new OpenAIWsTransport(ws, handlers);

      const clearSetup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        clearSetup();
        transport.close();
        reject(new OpenAIWsOpenError('OpenAI WebSocket setup cancelled', false));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearSetup();
        transport.close();
        reject(new OpenAIWsOpenError('OpenAI WebSocket session did not start in time', false));
      }, SESSION_OPEN_TIMEOUT_MS);
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });

      ws.onmessage = (m: MessageEvent<string>) => {
        let ev: OpenAIWsEvent;
        try {
          ev = JSON.parse(m.data) as OpenAIWsEvent;
        } catch {
          return;
        }
        // A socket can stay OPEN after its upstream session has ended. Reject
        // that candidate before the owner detaches a healthy primary.
        if (!transport.activated && (ev.type === 'session.closed' || ev.type === 'error')) {
          const message = ev.error?.message ?? 'OpenAI session closed before activation';
          const code = ev.error?.code;
          const error = new OpenAIWsOpenError(
            `OpenAI WebSocket session failed${code ? ` (${code})` : ''}: ${message}`,
            ev.type === 'error' && looksLikeAuthRejection(0, `${code ?? ''} ${message}`),
          );
          transport.activationError = error;
          if (!settled) {
            settled = true;
            clearSetup();
            transport.close();
            reject(error);
          } else transport.close();
          return;
        }
        if (settled) {
          transport.deliverOrQueue(ev);
          return;
        }
        if (ev.type === 'session.created' && !sessionCreated) {
          sessionCreated = true;
          // The owner decides when this new session may touch its shared
          // caption state. Keep session.created first even if a malformed or
          // unusually eager server sent another event before it.
          transport.queueForActivation(ev, true);
          transport
            .startAudioPump(stream)
            .then(() => {
              // A timeout/error/close may have won while an audio API promise
              // was pending. It already rejected open() and closed the socket;
              // a late completion must not resurrect the transport.
              if (settled) return;
              settled = true;
              opened = true;
              clearSetup();
              resolve(transport);
            })
            .catch((err: unknown) => {
              if (settled) return;
              settled = true;
              clearSetup();
              transport.close();
              reject(
                new OpenAIWsOpenError(
                  `Audio capture could not start: ${err instanceof Error ? err.message : String(err)}`,
                  false,
                ),
              );
            });
          return;
        }
        transport.queueForActivation(ev);
      };

      ws.onclose = (e: CloseEvent) => {
        if (!settled) {
          settled = true;
          clearSetup();
          // A close can win while addModule()/resume() is pending. Mark the
          // transport cancelled and tear down any nodes already created so the
          // late promise continuation cannot revive them.
          transport.close();
          reject(
            new OpenAIWsOpenError(
              `OpenAI WebSocket closed during setup (${e.code}${e.reason ? `: ${e.reason}` : ''})`,
              looksLikeAuthRejection(e.code, e.reason ?? ''),
            ),
          );
          return;
        }
        transport.teardownAudio();
        if (transport.drainSink) {
          transport.drainSink.onClosed();
          return;
        }
        // Settled but never opened belongs to open()'s rejection path. An
        // opened transport is still silent until its owner activates it; if it
        // dies in that hand-off window, activate() reports the failure instead
        // of starting a parallel recovery ladder before ownership is assigned.
        if (!opened) return;
        if (!transport.activated) {
          transport.closedBeforeActivation = { code: e.code, reason: e.reason ?? '' };
        } else if (!transport.detached) {
          handlers.onClosed(`WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
        }
      };

      // 'error' always precedes 'close' in the WHATWG spec, so closing is
      // handled above; this only keeps an unhandled-rejection out of the log.
      ws.onerror = () => {};
    });
  }

  get isOpen(): boolean {
    return this.activationError === null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Atomically hand event delivery to the owner. open() deliberately returns a
   * ready-but-silent transport so make-before-break renewal can finalize and
   * detach the old session before any new-session delta reaches shared state.
   */
  activate(): void {
    if (this.activated) return;
    if (this.activationError) throw this.activationError;
    const closed = this.closedBeforeActivation;
    if (this.detached || closed !== null || !this.isOpen) {
      const code = closed?.code ?? this.ws.readyState;
      const reason = closed?.reason ?? '';
      throw new OpenAIWsOpenError(
        `OpenAI WebSocket closed before activation (${code}${reason ? `: ${reason}` : ''})`,
        looksLikeAuthRejection(code, reason),
      );
    }
    this.activated = true;
    for (const ev of this.pendingEvents.splice(0)) this.handlers.onEvent(ev);
  }

  /**
   * Stop delivering events/close callbacks without tearing the socket down
   * yet — the make-before-break swap needs the OLD transport silent while the
   * new one takes over, exactly like detaching the old peer's handlers.
   */
  detach(): void {
    this.detached = true;
    this.pendingEvents.length = 0;
  }

  close(): void {
    this.drainSink = null;
    this.detached = true;
    this.pendingEvents.length = 0;
    this.teardownAudio();
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  /** Stop input while a retired session finishes its pending translated output. */
  beginDrain(onEvent: (event: OpenAIWsEvent) => void, onClosed: () => void): void {
    this.detached = true;
    this.pendingEvents.length = 0;
    this.teardownAudio();
    this.drainSink = { onEvent, onClosed };
    if (!this.isOpen) {
      onClosed();
      return;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      onClosed();
    }
  }

  private async startAudioPump(stream: MediaStream): Promise<void> {
    const ctx = getCaptureContext();
    if (!ctx) throw new Error('AudioContext unavailable');
    // Read the REAL rate: the engine asks for 16 kHz but falls back to the
    // hardware default when a browser rejects an explicit rate.
    this.inputSampleRate = ctx.sampleRate;
    await ensureCaptureWorklet(ctx, this.capture.signal);
    // The setup timeout or socket close can fire while addModule() is pending.
    // Do not create/connect fresh nodes after that teardown already ran.
    if (this.detached || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket audio setup was cancelled');
    }
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm-worklet', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkSize: pcmChunkSizeForRate(ctx.sampleRate, PCM_CHUNK_SIZE) },
    });
    const captureHealth = (this.captureHealth = monitorCaptureHealth({
      context: ctx,
      stream,
      onHealth: (event) => {
        if (this.activated && !this.detached) this.handlers.onCaptureHealth?.(event);
      },
    }));
    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.detached || !this.activated) return;
      captureHealth.frame(ev.data.byteLength / 4);
      if (this.detached || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.ws.bufferedAmount > WS_BACKPRESSURE_THRESHOLD) {
        this.dropCount += 1;
        this.consecutiveDrops += 1;
        if (this.consecutiveDrops === 1 || this.dropCount % 50 === 0) {
          this.handlers.onAudioTrouble(
            'degraded',
            `OpenAI link slow — ${this.dropCount} audio frames dropped`,
            'transport',
          );
        }
        if (this.consecutiveDrops >= WS_FORCE_RECONNECT_DROPS) {
          this.consecutiveDrops = 0;
          // Closing hands recovery to the provider's renewal ladder, which
          // already knows how to rebuild without dropping the transcript.
          try {
            this.ws.close();
          } catch {
            /* already gone */
          }
        }
        return;
      }
      const resumingDelivery = this.consecutiveDrops > 0;
      const at24k = resampleTo24kHz(
        new Float32Array(ev.data),
        this.inputSampleRate,
        this.resampleState,
      );
      // Downsampling a short chunk can legitimately yield nothing this tick.
      if (at24k.length === 0) return;
      this.ws.send(
        JSON.stringify({
          type: 'session.input_audio_buffer.append',
          audio: arrayBufferToBase64(floatTo16BitPCM(at24k)),
        }),
      );
      this.consecutiveDrops = 0;
      if (resumingDelivery)
        this.handlers.onAudioTrouble(
          'connected',
          'Audio delivery resumed; waiting for new content',
          'transport',
        );
    };
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(ctx.destination);
    await resumeCaptureContext(this.capture.signal);
    if (this.detached || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket audio setup was cancelled');
    }
  }

  private queueForActivation(ev: OpenAIWsEvent, first = false): void {
    if (this.detached) return;
    if (first) this.pendingEvents.unshift(ev);
    else this.pendingEvents.push(ev);
  }

  private deliverOrQueue(ev: OpenAIWsEvent): void {
    if (this.drainSink) {
      this.drainSink.onEvent(ev);
      return;
    }
    if (this.detached) return;
    if (this.activated) this.handlers.onEvent(ev);
    else this.pendingEvents.push(ev);
  }

  private teardownAudio(): void {
    this.captureHealth?.dispose();
    this.captureHealth = null;
    this.capture.abort(new DOMException('WebSocket audio capture stopped', 'AbortError'));
    try {
      this.workletNode?.disconnect();
      this.workletNode?.port.close();
      this.sourceNode?.disconnect();
    } catch {
      /* best effort */
    }
    this.workletNode = null;
    this.sourceNode = null;
  }
}
