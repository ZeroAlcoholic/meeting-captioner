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

const PCM_WORKLET_URL = '/pcm-worklet.js';
// 16 kHz: the rate the Gemini/offline PCM worklet expects, and perfectly fine for
// the OpenAI level/wedge analyser (OpenAI's actual audio rides the WebRTC track,
// not this context). createMediaStreamSource resamples the mic into it.
const CAPTURE_SAMPLE_RATE = 16_000;

const REALTIME_PRECONNECT_HOSTS = [
  'https://api.openai.com',
  'https://generativelanguage.googleapis.com',
];

let sharedCtx: AudioContext | null = null;
let workletPromise: Promise<void> | null = null;
let workletForCtx: AudioContext | null = null;
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
  // A brand-new context means any previously-loaded worklet is gone with it.
  if (sharedCtx !== workletForCtx) {
    workletPromise = null;
    workletForCtx = null;
  }
  return sharedCtx;
}

/**
 * Load the PCM worklet module into `ctx` exactly once (cached per context).
 * Idempotent — concurrent callers share the same in-flight promise.
 */
export function ensureCaptureWorklet(ctx: AudioContext): Promise<void> {
  if (workletForCtx === ctx && workletPromise) return workletPromise;
  workletForCtx = ctx;
  const addModule = ctx.audioWorklet?.addModule?.bind(ctx.audioWorklet);
  workletPromise = addModule ? addModule(PCM_WORKLET_URL) : Promise.resolve();
  return workletPromise;
}

/**
 * Resume the shared context. Browsers create an AudioContext SUSPENDED when it
 * is constructed outside a user gesture (the pre-warm path), so a provider must
 * resume it from within the Start click. No-op when already running / absent.
 */
export async function resumeCaptureContext(): Promise<void> {
  const ctx = getCaptureContext();
  if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    try {
      await ctx.resume();
    } catch {
      /* a failed resume must never block capture bring-up */
    }
  }
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
  workletPromise = null;
  workletForCtx = null;
  preconnected = false;
}
