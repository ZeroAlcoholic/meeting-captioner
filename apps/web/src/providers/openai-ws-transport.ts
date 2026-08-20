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

import { ensureCaptureWorklet, getCaptureContext, resumeCaptureContext } from './audio-engine.js';
import { arrayBufferToBase64, floatTo16BitPCM } from './gemini-live-provider.js';

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

/** Interpolation state carried BETWEEN chunks so the seams stay continuous. */
export interface ResampleState {
  /** Fractional read position, relative to the start of the next chunk. */
  pos: number;
  /** Final sample of the previous chunk — the left anchor across the seam. */
  last: number;
}

/**
 * Linear-interpolate `input` (at `inputRate`) to 24 kHz, carrying `state` so
 * consecutive chunks join without a step discontinuity. Resetting the position
 * every chunk would inject a click at each 32 ms boundary — ~31 clicks per
 * second straight into the ASR front-end.
 *
 * Linear is the right tool here: the payload is speech that has already been
 * band-limited by the capture context, and the alternative (a polyphase FIR)
 * costs main-thread time in a hard-realtime path to fix aliasing the model
 * never hears. Exported for tests.
 */
export function resampleTo24kHz(
  input: Float32Array,
  inputRate: number,
  state: ResampleState,
): Float32Array {
  if (input.length === 0) return input;
  if (inputRate === TARGET_SAMPLE_RATE) {
    state.pos = 0;
    state.last = input[input.length - 1] ?? state.last;
    return input;
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const out = new Float32Array(Math.max(1, Math.ceil((input.length - state.pos) / ratio)));
  let pos = state.pos;
  let n = 0;
  while (pos < input.length) {
    const i = Math.floor(pos);
    const frac = pos - i;
    // i < 0 means this output sample falls between the previous chunk's last
    // sample and this chunk's first — that is the seam the state exists for.
    const a = i < 0 ? state.last : (input[i] ?? 0);
    if (frac === 0) {
      out[n++] = a;
    } else {
      const next = input[i + 1];
      // The right anchor lives in the NEXT chunk; stop and resume there.
      if (next === undefined) break;
      out[n++] = a + (next - a) * frac;
    }
    pos += ratio;
  }
  state.pos = pos - input.length;
  state.last = input[input.length - 1] ?? state.last;
  return out.subarray(0, n);
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
  /** One server event — hand straight to the provider's event handler. */
  onEvent: (ev: OpenAIWsEvent) => void;
  /** The socket closed after coming up (never fires after detach()/close()). */
  onClosed: (reason: string) => void;
  /** Audio-path trouble worth surfacing (backpressure, capture failure). */
  onAudioTrouble: (state: 'degraded' | 'failed', message: string) => void;
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
  if (code === 4001 || code === 4003 || code === 1008) return true;
  return /unauthor|not authorized|invalid_?api_?key|forbidden|401|403/i.test(reason);
}

export class OpenAIWsTransport {
  private constructor(
    private readonly ws: WebSocket,
    private readonly handlers: OpenAIWsTransportHandlers,
  ) {}

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private detached = false;
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
   * during bring-up (deltas can precede the caller's first tick) are replayed
   * to `onEvent` in order once the promise settles.
   */
  static open(
    token: string,
    stream: MediaStream,
    handlers: OpenAIWsTransportHandlers,
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
      let closedDuringSetup: { code: number; reason: string } | null = null;
      const pending: OpenAIWsEvent[] = [];
      const transport = new OpenAIWsTransport(ws, handlers);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(new OpenAIWsOpenError('OpenAI WebSocket session did not start in time', false));
      }, SESSION_OPEN_TIMEOUT_MS);

      ws.onmessage = (m: MessageEvent<string>) => {
        let ev: OpenAIWsEvent;
        try {
          ev = JSON.parse(m.data) as OpenAIWsEvent;
        } catch {
          return;
        }
        if (settled) {
          if (!transport.detached) handlers.onEvent(ev);
          return;
        }
        if (ev.type === 'session.created') {
          settled = true;
          clearTimeout(timer);
          transport
            .startAudioPump(stream)
            .then(() => {
              // The socket can die while the pump is starting. Resolving here
              // would hand back a transport whose socket is already gone — a
              // session that looks connected and produces nothing.
              if (closedDuringSetup !== null) {
                transport.close();
                reject(
                  new OpenAIWsOpenError(
                    `OpenAI WebSocket closed during setup (${closedDuringSetup.code}${
                      closedDuringSetup.reason ? `: ${closedDuringSetup.reason}` : ''
                    })`,
                    looksLikeAuthRejection(closedDuringSetup.code, closedDuringSetup.reason),
                  ),
                );
                return;
              }
              opened = true;
              handlers.onEvent(ev);
              for (const queued of pending) handlers.onEvent(queued);
              resolve(transport);
            })
            .catch((err: unknown) => {
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
        if (ev.type === 'error') {
          settled = true;
          clearTimeout(timer);
          const message = ev.error?.message ?? 'OpenAI rejected the WebSocket session';
          const code = ev.error?.code;
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          reject(
            new OpenAIWsOpenError(
              `OpenAI WebSocket session failed${code ? ` (${code})` : ''}: ${message}`,
              looksLikeAuthRejection(0, `${code ?? ''} ${message}`),
            ),
          );
          return;
        }
        pending.push(ev);
      };

      ws.onclose = (e: CloseEvent) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new OpenAIWsOpenError(
              `OpenAI WebSocket closed during setup (${e.code}${e.reason ? `: ${e.reason}` : ''})`,
              looksLikeAuthRejection(e.code, e.reason ?? ''),
            ),
          );
          return;
        }
        transport.teardownAudio();
        // Settled but never opened: the failure belongs to open()'s rejection
        // path, not to the provider's recovery ladder. Record it so a pump
        // still in flight can reject instead of resolving a dead session.
        if (!opened) {
          closedDuringSetup = { code: e.code, reason: e.reason ?? '' };
          return;
        }
        if (!transport.detached) {
          handlers.onClosed(`WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
        }
      };

      // 'error' always precedes 'close' in the WHATWG spec, so closing is
      // handled above; this only keeps an unhandled-rejection out of the log.
      ws.onerror = () => {};
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Stop delivering events/close callbacks without tearing the socket down
   * yet — the make-before-break swap needs the OLD transport silent while the
   * new one takes over, exactly like detaching the old peer's handlers.
   */
  detach(): void {
    this.detached = true;
  }

  close(): void {
    this.detached = true;
    this.teardownAudio();
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private async startAudioPump(stream: MediaStream): Promise<void> {
    const ctx = getCaptureContext();
    if (!ctx) throw new Error('AudioContext unavailable');
    // Read the REAL rate: the engine asks for 16 kHz but falls back to the
    // hardware default when a browser rejects an explicit rate.
    this.inputSampleRate = ctx.sampleRate;
    await ensureCaptureWorklet(ctx);
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm-worklet', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkSize: PCM_CHUNK_SIZE },
    });
    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.detached || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.ws.bufferedAmount > WS_BACKPRESSURE_THRESHOLD) {
        this.dropCount += 1;
        this.consecutiveDrops += 1;
        if (this.dropCount % 50 === 0) {
          this.handlers.onAudioTrouble(
            'degraded',
            `OpenAI link slow — ${this.dropCount} audio frames dropped`,
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
      this.consecutiveDrops = 0;
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
    };
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(ctx.destination);
    await resumeCaptureContext();
  }

  private teardownAudio(): void {
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
