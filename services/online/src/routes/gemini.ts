import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

// Gemini Developer API — ephemeral token (auth_tokens) endpoint. The browser
// must NEVER hold the raw GEMINI_API_KEY, so the server mints a short-lived
// token bound to the Live model and hands only that to the client, mirroring
// the OpenAI client_secrets pattern used by /session.
//
// Verified live against the running v1alpha API (2026-06-09):
//   POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=KEY
//   { uses, expireTime, newSessionExpireTime }  → { name: "auth_tokens/…" }
//   (the `name` is the WS access_token).
//
// NOTE: we mint an UNCONSTRAINED token and let the browser send the full
// BidiGenerateContentSetup. Locking the model via `bidiGenerateContentSetup`
// in the token was verified to make the Live WS close with 1011 "Internal
// error" once the client also sends a setup — so locking is intentionally NOT
// used. Blast radius is bounded by uses:1 + the short newSession window.
const GEMINI_AUTH_TOKENS_URL =
  'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

// Token lifetimes. `newSessionExpireTime` bounds how long the browser has to
// OPEN the session; `expireTime` bounds the token's total validity. Generous
// enough to cover a slow page → first-Start, tight enough to limit blast radius.
const NEW_SESSION_WINDOW_MS = 2 * 60 * 1000; // 2 min to start the session
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min total token validity

// Reuse the same simple per-IP rolling-window limiter shape as /session.
const rateState = new Map<string, number[]>();
function isRateLimited(ip: string, limitPerMin: number, nowMs = Date.now()): boolean {
  const windowStart = nowMs - 60_000;
  const hits = (rateState.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= limitPerMin) {
    rateState.set(ip, hits);
    return true;
  }
  hits.push(nowMs);
  rateState.set(ip, hits);
  return false;
}
const RATE_STATE_MAX_KEYS = 10_000;
setInterval(() => {
  if (rateState.size > RATE_STATE_MAX_KEYS) {
    const cutoff = Date.now() - 60_000;
    for (const [ip, hits] of rateState) {
      const live = hits.filter((t) => t > cutoff);
      if (live.length === 0) rateState.delete(ip);
      else rateState.set(ip, live);
    }
  }
}, 60_000).unref?.();

/** Test seam. */
export function _resetGeminiRateLimitForTests(): void {
  rateState.clear();
}

function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

interface AuthTokenResponse {
  name?: string;
}

export async function registerGemini(app: FastifyInstance): Promise<void> {
  app.post('/session/gemini', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.GEMINI_API_KEY) {
      return reply.status(503).send({ error: 'GEMINI_API_KEY not configured on server' });
    }
    if (isRateLimited(req.ip, config.SESSION_RATE_LIMIT_PER_MIN)) {
      return reply.status(429).send({ error: 'Too many session requests; retry in a minute' });
    }

    const now = Date.now();
    const body = {
      uses: 1,
      expireTime: new Date(now + TOKEN_TTL_MS).toISOString(),
      newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
    };

    let res: Response;
    try {
      res = await fetch(`${GEMINI_AUTH_TOKENS_URL}?key=${encodeURIComponent(config.GEMINI_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'TimeoutError';
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gemini auth_tokens fetch failed');
      if (isAbort) return reply.status(504).send({ error: 'Gemini token mint timed out' });
      return reply.status(502).send({ error: 'Gemini token mint failed' });
    }

    if (!res.ok) {
      // Log upstream detail server-side only; never forward (may carry quota/project hints).
      const bodyText = await res.text().catch(() => '<unreadable>');
      req.log.warn({ status: res.status, body: bodyText.slice(0, 1_000) }, 'Gemini auth_tokens non-2xx');
      const sanitized =
        res.status === 401 || res.status === 403
          ? 'Upstream rejected the Gemini API key'
          : res.status === 429
            ? 'Gemini rate-limited; retry shortly'
            : `Gemini returned ${res.status}`;
      return reply.status(res.status < 500 ? res.status : 502).send({ error: sanitized });
    }

    const data = (await res.json()) as AuthTokenResponse;
    if (!data.name) {
      return reply.status(502).send({ error: 'Gemini token response missing name' });
    }
    // Return ONLY the ephemeral token + the model the client should request.
    // The browser opens the Live WS directly with this token.
    return {
      token: data.name,
      model: modelPath(config.GEMINI_LIVE_MODEL),
    };
  });
}
