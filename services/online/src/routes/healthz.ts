import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { activeOpenAIKeySlot, hasAnyOpenAIKey } from '../openai-keys.js';

// Version is injected at build time by esbuild's `define` so the release
// bundle does not depend on a runtime package.json lookup (which fails
// inside a single-file CJS bundle). Dev / tests rely on the fallback.
declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const STARTUP_MS = Date.now();

type Reachability = 'unknown' | 'ok' | 'degraded';
let openaiReachability: Reachability = 'unknown';
let lastReachabilityChangeMs = Date.now();

/**
 * Called from session.ts on every upstream OpenAI call result so /healthz can
 * report whether the path is currently healthy without introducing a separate
 * polling job. 'ok' on success, 'degraded' on timeout / non-2xx / network error.
 */
export function recordOpenAIReachability(state: Reachability): void {
  if (state !== openaiReachability) {
    openaiReachability = state;
    lastReachabilityChangeMs = Date.now();
  }
}

export function _resetHealthForTests(): void {
  openaiReachability = 'unknown';
  lastReachabilityChangeMs = Date.now();
}

export async function registerHealthz(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => {
    const apiKey = hasAnyOpenAIKey() ? 'configured' : 'missing';
    const geminiKey = config.GEMINI_API_KEY ? 'configured' : 'missing';
    // 'unknown' reachability counts as usable (no calls made yet); 'degraded'
    // does not. There is no equivalent signal for Gemini: the browser talks to
    // Google directly over its own WebSocket, so this service never observes
    // whether that path is healthy and must not pretend to.
    const openaiUsable = apiKey === 'configured' && openaiReachability !== 'degraded';
    const geminiUsable = geminiKey === 'configured';
    // ok = the service can broker SOME session right now. It used to mean "can
    // broker an OpenAI session", which reported a perfectly good Gemini-only
    // deployment as broken — its own health check telling the operator to fix
    // something that was working.
    const ok = openaiUsable || geminiUsable;
    return {
      ok,
      service: 'online',
      version: VERSION,
      timestamp: new Date().toISOString(),
      components: {
        apiKey,
        openai_usable: openaiUsable,
        openai_key_slot: activeOpenAIKeySlot(),
        openai_reachability: openaiReachability,
        openai_last_change_at: new Date(lastReachabilityChangeMs).toISOString(),
        gemini_key: geminiKey,
        gemini_usable: geminiUsable,
        uptime_sec: Math.round((Date.now() - STARTUP_MS) / 1000),
      },
    };
  });
}
