import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { recordOpenAIReachability } from './healthz.js';

const TRANSLATION_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/translations/client_secrets';

// Maps our langPair key to OpenAI output language code.
// NOTE: gpt-realtime-translate does NOT accept session.audio.input.transcription.language —
// the API auto-detects source language. Adding a "language" field returns 400 Bad Request.
const LANG_OUTPUT: Record<string, string> = {
  'en→zh-TW': 'zh',
  'zh-TW→en': 'en',
};

const DEFAULT_LANG_PAIR = 'en→zh-TW';

const SessionBodySchema = z
  .object({
    langPair: z.enum(['en→zh-TW', 'zh-TW→en']).optional(),
    /**
     * When true (default), the upstream session payload requests
     * `audio.input.transcription: { model: 'gpt-realtime-whisper' }` so
     * OpenAI emits source-language transcript deltas alongside the
     * translation. When false, the field is omitted and OpenAI returns
     * only translated text — saves the incremental whisper cost.
     */
    includeSourceTranscript: z.boolean().optional(),
  })
  .strict();

// /v1/realtime/translations/client_secrets returns a flat object (not nested under client_secret)
interface ClientSecretResponse {
  value: string;
  expires_at: number;
}

// In-memory rolling-window rate limiter keyed by remote IP.
// Single-process only; for multi-instance deployments swap for Redis.
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

// Bound the map so a flood of unique IPs can't grow it forever.
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

// Test seam — vitest can call this between cases.
export function _resetRateLimitForTests(): void {
  rateState.clear();
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.get('/session/info', async () => ({
    hasApiKey: Boolean(config.OPENAI_API_KEY),
    sessionRenewalRecommendedMs: config.SESSION_RENEW_MS,
    supportedLangPairs: Object.keys(LANG_OUTPUT),
  }));

  app.post('/session', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.OPENAI_API_KEY) {
      return reply.status(503).send({ error: 'OPENAI_API_KEY not configured on server' });
    }

    if (isRateLimited(req.ip, config.SESSION_RATE_LIMIT_PER_MIN)) {
      return reply
        .status(429)
        .send({ error: 'Too many session requests; retry in a minute' });
    }

    // Parse body permissively — empty body is allowed and means defaults.
    const raw = req.body ?? {};
    const parsed = SessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
      });
    }

    const langPair = parsed.data.langPair ?? DEFAULT_LANG_PAIR;
    const outputLanguage = LANG_OUTPUT[langPair] ?? 'zh';
    const includeSourceTranscript = parsed.data.includeSourceTranscript ?? true;

    // Build the audio.input config conditionally so we don't request the
    // `gpt-realtime-whisper` source transcription stream when the client
    // opted into translation-only mode. `noise_reduction` stays in either
    // mode because it gates how aggressively OpenAI cleans the mic signal.
    const audioInput: Record<string, unknown> = {
      noise_reduction: { type: 'near_field' },
    };
    if (includeSourceTranscript) {
      audioInput.transcription = { model: 'gpt-realtime-whisper' };
    }

    let res: Response;
    try {
      res = await fetch(TRANSLATION_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            model: 'gpt-realtime-translate',
            audio: {
              input: audioInput,
              output: { language: outputLanguage },
            },
          },
        }),
        signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'TimeoutError';
      const message = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: message }, 'OpenAI client_secrets fetch failed');
      recordOpenAIReachability('degraded');
      if (isAbort) {
        return reply.status(504).send({ error: 'OpenAI session bring-up timed out' });
      }
      return reply.status(502).send({ error: 'Upstream session bring-up failed' });
    }

    if (!res.ok) {
      // Log full upstream body server-side for diagnosis but never forward it
      // to the browser — it can carry org id, billing detail, or quota numbers.
      const bodyText = await res.text().catch(() => '<unreadable>');
      req.log.warn(
        { upstream_status: res.status, upstream_body: bodyText.slice(0, 2_000) },
        'OpenAI client_secrets non-2xx',
      );
      recordOpenAIReachability('degraded');
      const sanitized =
        res.status === 401
          ? 'Upstream rejected the API key'
          : res.status === 429
            ? 'Upstream rate-limited; retry shortly'
            : `Upstream returned ${res.status}`;
      return reply.status(res.status).send({ error: sanitized });
    }

    const data = (await res.json()) as ClientSecretResponse;
    recordOpenAIReachability('ok');
    // NEVER expose OPENAI_API_KEY — return only the ephemeral client_secret.
    return {
      client_secret: { value: data.value, expires_at: data.expires_at },
      session_renewal_recommended_ms: config.SESSION_RENEW_MS,
    };
  });
}
