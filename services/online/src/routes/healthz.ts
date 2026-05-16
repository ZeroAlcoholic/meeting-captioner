import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// Version is injected at build time by esbuild's `define` so the release
// bundle does not depend on a runtime package.json lookup (which fails
// inside a single-file CJS bundle). Dev / tests rely on the fallback.
declare const __APP_VERSION__: string;
const VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

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
    const apiKey = config.OPENAI_API_KEY ? 'configured' : 'missing';
    // ok = the service can plausibly broker a session right now.
    // 'unknown' is treated as ok (no calls made yet); 'degraded' is not.
    const ok = apiKey === 'configured' && openaiReachability !== 'degraded';
    return {
      ok,
      service: 'online',
      version: VERSION,
      timestamp: new Date().toISOString(),
      components: {
        apiKey,
        openai_reachability: openaiReachability,
        openai_last_change_at: new Date(lastReachabilityChangeMs).toISOString(),
        uptime_sec: Math.round((Date.now() - STARTUP_MS) / 1000),
      },
    };
  });
}
