import { createRecoveryAttempt } from './recovery-attempt.js';

/** Opt-in pcm-worklet message; startFrame uses this AudioContext's native rate. */
export interface CapturedPcmChunk {
  type: 'pcm';
  startFrame: number;
  pcm: ArrayBuffer;
}

/** Interpolation state carried between PCM chunks so seams stay continuous. */
export interface ResampleState {
  /** Fractional read position, relative to the start of the next chunk. */
  pos: number;
  /** Final sample of the previous chunk — the left anchor across the seam. */
  last: number;
}

/**
 * Resample `input` (at `inputRate`) to `targetRate`, carrying `state` so
 * consecutive chunks join without a step discontinuity (no seam clicks).
 * Uses linear interpolation when upsampling (`inputRate <= targetRate`) and
 * boxcar (area-average) anti-aliasing integration when downsampling.
 */
export function resamplePcm(
  input: Float32Array,
  inputRate: number,
  targetRate: number,
  state: ResampleState,
): Float32Array {
  if (input.length === 0) return input;
  if (inputRate === targetRate) {
    state.pos = 0;
    state.last = input[input.length - 1] ?? state.last;
    return input;
  }
  const ratio = inputRate / targetRate;
  const out = new Float32Array(Math.max(1, Math.ceil((input.length - state.pos) / ratio)));
  let pos = state.pos;
  let n = 0;
  if (ratio > 1) {
    // Boxcar anti-aliasing filter for downsampling (e.g. 48 kHz -> 16 kHz / 24 kHz).
    // Averages input energy across each output sample's [start, end) window,
    // placing natural spectral nulls at integer multiples of targetRate.
    while (pos < input.length) {
      const end = Math.min(pos + ratio, input.length);
      let cursor = pos;
      let sum = 0;
      let weight = 0;
      if (cursor < 0) {
        const span = Math.min(0, end) - cursor;
        sum += state.last * span;
        weight += span;
        cursor = 0;
      }
      const firstIdx = Math.floor(cursor);
      const lastIdx = Math.floor(end);
      if (firstIdx === lastIdx) {
        const span = end - cursor;
        if (span > 0 && firstIdx < input.length) {
          sum += (input[firstIdx] ?? 0) * span;
          weight += span;
        }
      } else {
        if (firstIdx < input.length) {
          const firstSpan = firstIdx + 1 - cursor;
          sum += (input[firstIdx] ?? 0) * firstSpan;
          weight += firstSpan;
        }
        for (let idx = firstIdx + 1; idx < lastIdx && idx < input.length; idx++) {
          sum += input[idx] ?? 0;
          weight += 1;
        }
        if (lastIdx < input.length) {
          const lastSpan = end - lastIdx;
          if (lastSpan > 0) {
            sum += (input[lastIdx] ?? 0) * lastSpan;
            weight += lastSpan;
          }
        }
      }
      out[n++] = weight > 0 ? sum / weight : 0;
      pos += ratio;
    }
  } else {
    while (pos < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? state.last : (input[i] ?? 0);
      if (frac === 0) {
        out[n++] = a;
      } else {
        const next = input[i + 1];
        if (next === undefined) break;
        out[n++] = a + (next - a) * frac;
      }
      pos += ratio;
    }
  }
  state.pos = pos - input.length;
  state.last = input[input.length - 1] ?? state.last;
  return out.subarray(0, n);
}

/**
 * True when an AudioContext is paused by the OS/browser. Covers standard
 * 'suspended' as well as iOS Safari's WebKit-specific 'interrupted' state
 * (triggered by lock screen, phone calls, or app switching).
 */
export function isAudioContextPaused(state: AudioContextState | string | undefined): boolean {
  return state === 'suspended' || state === 'interrupted';
}

/** Compute a ~32 ms PCM worklet chunk size for the actual AudioContext rate. */
export function pcmChunkSizeForRate(sampleRate: number, minSamples = 512): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return minSamples;
  return Math.max(minSamples, Math.round(sampleRate * 0.032));
}

// ─── Shared audio-capture engine ─────────────────────────────────────────────
//
// A single long-lived AudioContext + compiled AudioWorklet module, reused across
// every session. Previously each provider did `new AudioContext()` +
// `audioWorklet.addModule()` on every Start and `close()` on every Stop, so the
// entire capture pipeline was rebuilt per meeting — pure startup latency that
// nothing could pre-pay.
//
// The AudioWorklet module is registered PER AudioContext (a module loaded into
// context A is not visible in context B), so pre-warming the worklet is only
// possible if the context itself is shared and persistent — hence one engine.
//
// Privacy: this engine NEVER acquires the microphone. It only owns the context +
// worklet (no audio flows until a provider attaches a MediaStream). The OS mic
// indicator therefore stays off until a real session calls getUserMedia.

// Resolved against the build's base: '/' for the server-backed builds, './'
// for the static phone build, which is served from a project subpath.
const PCM_WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet.js`;
// 16 kHz: the rate the Gemini/offline PCM worklet expects, and perfectly fine for
// the OpenAI level/wedge analyser (OpenAI's actual audio rides the WebRTC track,
// not this context). createMediaStreamSource resamples the mic into it.
const CAPTURE_SAMPLE_RATE = 16_000;

const REALTIME_PRECONNECT_HOSTS = [
  'https://api.openai.com',
  'https://generativelanguage.googleapis.com',
];

let sharedCtx: AudioContext | null = null;
let workletLoads = new WeakMap<AudioContext, Promise<void>>();
let workletLoadAttempts = new WeakMap<AudioContext, number>();
let contextResumes = new WeakMap<AudioContext, Promise<void>>();
let preconnected = false;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as typeof globalThis & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function createContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleRate: CAPTURE_SAMPLE_RATE });
  } catch {
    // Some engines reject an explicit sampleRate — fall back to the default.
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

/**
 * The shared capture AudioContext. Created once (lazily), reused forever, and
 * only re-created if a previous one was closed. Returns null when AudioContext
 * is unavailable (e.g. SSR / a test env without the global).
 */
export function getCaptureContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  sharedCtx = createContext();
  return sharedCtx;
}

/**
 * Native addModule/resume cannot be aborted. Bound this caller's wait without
 * closing the shared context or cancelling another provider's in-flight work.
 */
async function waitForAudioOperation(
  operation: () => Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const attempt = createRecoveryAttempt({
    ...(signal ? { parentSignal: signal } : {}),
    generation: 0,
    isCurrent: () => true,
    timeoutMs,
    label,
  });
  try {
    await attempt.run(operation);
  } finally {
    attempt.dispose();
  }
}

/**
 * Share one native module load per context. Retry one actual rejection; evict
 * only rejected loads. A timed-out caller must not launch a duplicate module
 * registration while the original native operation can still finish.
 */
export function ensureCaptureWorklet(ctx: AudioContext, signal?: AbortSignal): Promise<void> {
  return waitForAudioOperation(
    () => {
      const cached = workletLoads.get(ctx);
      if (cached) return cached;
      const addModule = ctx.audioWorklet?.addModule?.bind(ctx.audioWorklet);
      if (!addModule) throw new Error('AudioWorklet unavailable');
      const load = (): Promise<void> => {
        const attempt = workletLoadAttempts.get(ctx) ?? 0;
        workletLoadAttempts.set(ctx, attempt + 1);
        // Native module maps can cache failed fetches. Retry the same local
        // asset under a new URL, without replacing an otherwise usable context.
        const url = attempt === 0 ? PCM_WORKLET_URL : `${PCM_WORKLET_URL}?attempt=${attempt}`;
        return addModule(url);
      };
      const loading = (async () => {
        try {
          await load();
        } catch {
          await load();
        }
      })();
      const shared = loading.catch((error: unknown) => {
        if (workletLoads.get(ctx) === shared) workletLoads.delete(ctx);
        throw error;
      });
      workletLoads.set(ctx, shared);
      return shared;
    },
    signal,
    5_000,
    'AudioWorklet loading',
  );
}

/**
 * Resume within the initiating gesture. A rejected or stalled resume is a real
 * capture failure, not successful audio. Permission prompts are owned by capture
 * sources and are never included in this deadline.
 */
export function resumeAudioContext(ctx: AudioContext, signal?: AbortSignal): Promise<void> {
  return waitForAudioOperation(
    async () => {
      if (ctx.state === 'running') return;
      let pending = contextResumes.get(ctx);
      if (!pending) {
        const nativeResume = ctx.resume();
        const shared = nativeResume.finally(() => {
          if (contextResumes.get(ctx) === shared) contextResumes.delete(ctx);
        });
        contextResumes.set(ctx, shared);
        pending = shared;
      }
      await pending;
      if ((ctx.state as AudioContextState) !== 'running') {
        throw new Error('AudioContext is not running after resume');
      }
    },
    signal,
    3_000,
    'AudioContext resume',
  );
}

/** Resume the shared capture engine; private display contexts pass themselves above. */
export function resumeCaptureContext(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const ctx = getCaptureContext();
  if (!ctx) return Promise.resolve();
  return resumeAudioContext(ctx, signal);
}

/**
 * One-time TLS/DNS preconnect to the realtime backends so the first /session SDP
 * POST (OpenAI) or WS upgrade (Gemini) skips the connection handshake. ONLINE
 * ONLY — never called in offline mode, preserving the no-cloud-contact guarantee.
 */
export function preconnectRealtimeBackends(): void {
  if (preconnected || typeof document === 'undefined' || !document.head) return;
  preconnected = true;
  for (const href of REALTIME_PRECONNECT_HOSTS) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = href;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
}

/**
 * Warm everything that can be prepared WITHOUT touching the microphone (zero
 * privacy cost): the shared AudioContext (left suspended) + the worklet module
 * compile, plus — online only — backend preconnect. Safe to call repeatedly;
 * idempotent. Call at app mount and again on the first user gesture (a context
 * created pre-gesture is suspended but its worklet still compiles).
 */
export function prewarmCapture(opts: { online: boolean }): void {
  if (opts.online) preconnectRealtimeBackends();
  const ctx = getCaptureContext();
  if (ctx) void ensureCaptureWorklet(ctx).catch(() => {});
}

/** Test hook: drop all cached engine state so each test starts clean. */
export function __resetAudioEngineForTests(): void {
  sharedCtx = null;
  workletLoads = new WeakMap();
  workletLoadAttempts = new WeakMap();
  contextResumes = new WeakMap();
  preconnected = false;
}
