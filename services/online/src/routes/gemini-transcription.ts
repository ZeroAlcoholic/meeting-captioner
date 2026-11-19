import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { upstreamErrorCode } from '../upstream-error.js';
import { isRateLimited } from './session.js';
import { recognitionHints } from '../recognition-hints.js';
import { MEETING_KEYWORDS } from '@meeting-audio/contracts';

/** Documented ceiling for `custom_vocabulary` in the Live Transcribe guide. */
const GEMINI_VOCABULARY_LIMIT = 1000;

export const GEMINI_TRANSCRIPTION_MODEL = 'models/gemini-3.5-transcribe-live';
const AUTH_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const NEW_SESSION_WINDOW_MS = 120000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const RequestBody = z
  .object({
    inputLanguages: z
      .array(z.enum(['zh-tw', 'en']))
      .min(1)
      .max(2)
      .default(['zh-tw', 'en']),
    micDistance: z.enum(['meeting', 'close', 'far', 'off']).default('meeting'),
  })
  .strict();
const TokenResponse = z.object({
  name: z.string().regex(/^auth_tokens\/\S+$/),
  expireTime: z.string().datetime({ offset: true }).optional(),
  newSessionExpireTime: z.string().datetime({ offset: true }).optional(),
});

/** Dedicated REST constraints follow the Live Transcribe guide; never mint a fallback translation token. */
export async function registerGeminiTranscription(app: FastifyInstance): Promise<void> {
  app.post('/session/gemini/transcription', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!RequestBody.safeParse(req.body ?? {}).success)
      return reply.code(400).send({ error: 'Invalid transcription settings' });
    const apiKey = config.GEMINI_API_KEY;
    if (!apiKey)
      return reply.code(503).send({ error: 'Gemini transcription credentials are not configured' });
    if (isRateLimited(req.ip, config.SESSION_RATE_LIMIT_PER_MIN))
      return reply
        .header('Retry-After', '60')
        .code(429)
        .send({ error: 'Session request limit reached' });

    const now = Date.now();
    const newSessionExpiresAt = now + NEW_SESSION_WINDOW_MS;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    req.raw.once('aborted', aborted);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('token_timeout'));
      }, config.OPENAI_TIMEOUT_MS);
    });
    const operation = async () => {
      const response = await fetch(AUTH_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(now + TOKEN_TTL_MS).toISOString(),
          newSessionExpireTime: new Date(newSessionExpiresAt).toISOString(),
          // REST AuthToken uses the wire setup schema, not the SDK's
          // liveConnectConstraints/config wrapper (rejected with HTTP 400).
          bidiGenerateContentSetup: {
            model: GEMINI_TRANSCRIPTION_MODEL,
            generationConfig: { responseModalities: ['TEXT'] },
            // The official supported hints do not include zh-tw. Auto-detection
            // preserves mixed-language input; display normalization is client-side.
            inputAudioTranscription: {
              languageCodes: [],
              mode: 'VERBATIM',
              customVocabulary: recognitionHints(MEETING_KEYWORDS, GEMINI_VOCABULARY_LIMIT),
            },
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
        }),
      });
      if (controller.signal.aborted) throw new Error('token_aborted');
      if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After');
        if (
          response.status === 429 &&
          retryAfter &&
          (/^\d{1,5}$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))
        )
          reply.header('Retry-After', retryAfter);
        // Raw upstream errors can include project details or credentials.
        req.log.warn({ upstreamStatus: response.status }, 'Gemini transcription token rejected');
        await response.body?.cancel();
        if (controller.signal.aborted) throw new Error('token_aborted');
        return reply.code(response.status >= 500 ? 502 : response.status).send({
          error: `Gemini transcription service rejected the session (${response.status})`,
        });
      }
      const parsed = TokenResponse.safeParse(await response.json());
      if (controller.signal.aborted) throw new Error('token_aborted');
      if (!parsed.success)
        return reply.code(502).send({ error: 'Invalid Gemini transcription credential response' });
      const expiresAt = Math.min(
        newSessionExpiresAt,
        parsed.data.newSessionExpireTime
          ? Date.parse(parsed.data.newSessionExpireTime)
          : newSessionExpiresAt,
        parsed.data.expireTime ? Date.parse(parsed.data.expireTime) : now + TOKEN_TTL_MS,
      );
      if (expiresAt <= Date.now())
        return reply.code(502).send({ error: 'Expired Gemini transcription credential response' });
      return {
        token: parsed.data.name,
        model: GEMINI_TRANSCRIPTION_MODEL,
        expiresAt,
        concurrent_renewal_allowed: config.GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED,
        session_renewal_recommended_ms: 8 * 60000,
      };
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      req.log.warn(
        {
          code: req.raw.aborted
            ? 'CLIENT_ABORTED'
            : controller.signal.aborted
              ? 'UPSTREAM_TIMEOUT'
              : upstreamErrorCode(error),
        },
        'Gemini transcription session failed',
      );
      return reply.code(controller.signal.aborted ? 504 : 502).send({
        error: controller.signal.aborted
          ? 'Gemini transcription session timed out'
          : 'Gemini transcription session failed',
      });
    } finally {
      clearTimeout(timer);
      req.raw.off('aborted', aborted);
    }
  });
}
