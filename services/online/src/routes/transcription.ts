import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { upstreamErrorCode } from '../upstream-error.js';
import {
  alternateOpenAIKeySlot,
  demoteOpenAIKeySlot,
  fetchWithOpenAIKeyFailover,
  fetchWithOpenAIKeySlot,
  hasAnyOpenAIKey,
} from '../openai-keys.js';
import { isRateLimited } from './session.js';
import { recognitionHints } from '../recognition-hints.js';
import { MEETING_KEYWORDS } from '@meeting-audio/contracts';

// The guide documents no count for `keywords`; this is our own budget, chosen
// so a runaway glossary fails here rather than at the upstream.
const OPENAI_KEYWORD_LIMIT = 200;

const RequestBody = z
  .object({
    inputLanguages: z
      .array(z.enum(['zh-tw', 'en']))
      .min(1)
      .max(2)
      .default(['zh-tw', 'en']),
    micDistance: z.enum(['meeting', 'close', 'far', 'off']).default('meeting'),
    retryKeySlot: z.enum(['primary', 'audio']).optional(),
    failedSlot: z.enum(['primary', 'audio']).optional(),
    failureKind: z.enum(['opaque', 'auth']).optional(),
  })
  .strict()
  .refine((body) => {
    const retry =
      body.retryKeySlot !== undefined ||
      body.failedSlot !== undefined ||
      body.failureKind !== undefined;
    return (
      !retry ||
      (body.retryKeySlot !== undefined &&
        body.failedSlot !== undefined &&
        body.failureKind !== undefined &&
        body.retryKeySlot !== body.failedSlot)
    );
  });
const Secret = z.object({ value: z.string().min(1), expires_at: z.number().int().positive() });
export const TRANSCRIPTION_MODEL = 'gpt-live-transcribe';

/** Dedicated transcription credentials. Never accepts a client-selected model or upstream URL. */
export async function registerTranscription(app: FastifyInstance): Promise<void> {
  app.post('/session/transcription', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = RequestBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid transcription settings' });
    if (!hasAnyOpenAIKey())
      return reply.code(503).send({ error: 'Transcription credentials are not configured' });
    if (
      parsed.data.failedSlot !== undefined &&
      alternateOpenAIKeySlot(parsed.data.failedSlot) !== parsed.data.retryKeySlot
    ) {
      return reply.code(400).send({ error: 'Requested transcription alternate is not configured' });
    }
    if (isRateLimited(req.ip, config.SESSION_RATE_LIMIT_PER_MIN)) {
      return reply
        .header('Retry-After', '60')
        .code(429)
        .send({ error: 'Session request limit reached' });
    }
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    req.raw.once('aborted', onAborted);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error('transcription_timeout'));
      }, config.OPENAI_TIMEOUT_MS);
    });
    const { inputLanguages, micDistance } = parsed.data;
    const operation = async () => {
      const input = {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: {
          model: TRANSCRIPTION_MODEL,
          languages: [...new Set(inputLanguages)],
          keywords: recognitionHints(MEETING_KEYWORDS, OPENAI_KEYWORD_LIMIT),
          delay: 'low',
          prompt:
            '台灣華語與英文混合的會議。忠實轉寫原話；中文使用繁體字，保留英文與原文術語，不翻譯、不摘要、不補充未說出的內容。',
        },
        turn_detection: null,
        ...(micDistance === 'off'
          ? {}
          : { noise_reduction: { type: micDistance === 'close' ? 'near_field' : 'far_field' } }),
      };
      const makeRequest = (apiKey: string) =>
        fetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expires_after: { anchor: 'created_at', seconds: 600 },
            session: { type: 'transcription', audio: { input } },
          }),
          signal: controller.signal,
        });
      const { res, slot } = parsed.data.retryKeySlot
        ? await fetchWithOpenAIKeySlot(makeRequest, parsed.data.retryKeySlot)
        : await fetchWithOpenAIKeyFailover(makeRequest, req.log);
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter && (/^\d+$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))) {
          reply.header('Retry-After', retryAfter);
        }
        // Do not log provider body, credentials or meeting text.
        req.log.warn({ upstreamStatus: res.status }, 'Transcription session unavailable');
        await res.body?.cancel();
        return reply
          .code(res.status >= 500 ? 502 : res.status)
          .send({ error: `Transcription service rejected the session (${res.status})` });
      }
      const secret = Secret.safeParse(await res.json());
      if (controller.signal.aborted) throw new Error('transcription_timeout');
      if (!secret.success || secret.data.expires_at * 1000 <= Date.now()) {
        return reply.code(502).send({ error: 'Invalid transcription credential response' });
      }
      if (parsed.data.failedSlot && parsed.data.failureKind === 'auth') {
        demoteOpenAIKeySlot(
          parsed.data.failedSlot,
          'transcription auth/IP rejection reported by browser',
          req.log,
        );
      }
      return {
        client_secret: secret.data,
        model: TRANSCRIPTION_MODEL,
        purpose: 'transcription',
        key_slot: slot,
        alternate_key_slot: alternateOpenAIKeySlot(slot),
        session_renewal_recommended_ms: config.SESSION_RENEW_MS,
        concurrent_renewal_allowed: config.OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED,
      };
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      req.log.warn(
        {
          code: req.raw.aborted
            ? 'CLIENT_ABORTED'
            : controller.signal.aborted
              ? 'UPSTREAM_TIMEOUT'
              : upstreamErrorCode(error),
        },
        'OpenAI transcription session failed',
      );
      return reply.code(controller.signal.aborted ? 504 : 502).send({
        error: controller.signal.aborted
          ? 'Transcription session timed out'
          : 'Transcription session failed',
      });
    } finally {
      clearTimeout(deadline);
      req.raw.off('aborted', onAborted);
    }
  });
}
