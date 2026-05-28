import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const TRANSLATE_MODEL = 'gpt-4.1-mini';

const TranslateBodySchema = z
  .object({
    segmentId: z.string().min(1),
    text: z.string().min(1).max(2000),
    sourceLang: z.enum(['en', 'zh']),
    targetLang: z.enum(['zh-TW', 'en']),
  })
  .strict();

function systemPrompt(sourceLang: string, targetLang: string): string {
  if (sourceLang === 'en' && targetLang === 'zh-TW') {
    return (
      'You are a professional translator for insurance and business meetings. ' +
      'Translate the following English text into Traditional Chinese (繁體中文). ' +
      'Preserve domain terminology accurately — e.g. policyholder=要保人, premium=保費, ' +
      'underwriting=核保, beneficiary=受益人, claim=理賠. ' +
      'Output ONLY the translation. No explanations, no alternatives, no punctuation changes.'
    );
  }
  return (
    'You are a professional translator for insurance and business meetings. ' +
    'Translate the following Chinese text into English. ' +
    'Preserve domain terminology accurately. ' +
    'Output ONLY the translation. No explanations, no alternatives.'
  );
}

// Per-IP rate limit for /translate — each call is a chat completion, more
// costly than /session. Cap at 60/min (≈ 1 segment/s, above live speech rate).
const translateRateState = new Map<string, number[]>();

function isRateLimited(ip: string, nowMs = Date.now()): boolean {
  const limit = 60;
  const windowStart = nowMs - 60_000;
  const hits = (translateRateState.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    translateRateState.set(ip, hits);
    return true;
  }
  hits.push(nowMs);
  translateRateState.set(ip, hits);
  return false;
}

setInterval(() => {
  if (translateRateState.size > 10_000) {
    const cutoff = Date.now() - 60_000;
    for (const [ip, hits] of translateRateState) {
      const live = hits.filter((t) => t > cutoff);
      if (live.length === 0) translateRateState.delete(ip);
      else translateRateState.set(ip, live);
    }
  }
}, 60_000).unref?.();

export async function registerTranslate(app: FastifyInstance): Promise<void> {
  app.post('/translate', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.OPENAI_API_KEY) {
      return reply.status(503).send({ error: 'OPENAI_API_KEY not configured on server' });
    }

    if (isRateLimited(req.ip)) {
      return reply.status(429).send({ error: 'Too many translate requests; retry in a minute' });
    }

    const raw = req.body ?? {};
    const parsed = TranslateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
      });
    }

    const { segmentId, text, sourceLang, targetLang } = parsed.data;

    let res: Response;
    try {
      res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: TRANSLATE_MODEL,
          messages: [
            { role: 'system', content: systemPrompt(sourceLang, targetLang) },
            { role: 'user', content: text },
          ],
          temperature: 0.1,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'TimeoutError';
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, '/translate fetch failed');
      if (isAbort) return reply.status(504).send({ error: 'Translation request timed out' });
      return reply.status(502).send({ error: 'Translation upstream failed' });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      req.log.warn({ status: res.status, body: body.slice(0, 500) }, '/translate upstream non-2xx');
      return reply.status(res.status < 500 ? res.status : 502).send({ error: 'Translation upstream error' });
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const targetText = data.choices?.[0]?.message?.content?.trim() ?? '';

    if (!targetText) {
      return reply.status(502).send({ error: 'Empty translation response' });
    }

    return { segmentId, sourceText: text, targetText, sourceLang, targetLang };
  });
}
