import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { fetchWithOpenAIKeyFailover, hasAnyOpenAIKey } from '../openai-keys.js';
import { upstreamErrorCode } from '../upstream-error.js';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_SUMMARY_MODEL = 'gpt-5.4-mini';
const GEMINI_SUMMARY_MODEL = 'gemini-3.8-flash';
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SUMMARY_MODEL}:generateContent`;

export const SUMMARY_SYSTEM_PROMPT =
  '你是專業商務會議記錄專家。會議常涉及金融保險（如核保、理賠、保費、法遵）、AI／軟體工程（如模型指標、架構、延遲、部署）或商務決策。' +
  '請嚴格根據提供的逐字稿與時間戳記，以台灣繁體中文慣用語輸出精準摘要（僅針對實際討論內容摘要，未提及之領域切勿套用；嚴禁「討論了…」等空洞描述；所有關鍵金額、百分比、指標、專有名詞與英文縮寫須完整保留並標註 [MM:SS] 時間錨點）：\n' +
  '【一、核心結論與重點】條列具體決議、主張與關鍵數據（附 [MM:SS]）。\n' +
  '【二、待辦事項與下一步】條列「具體行動｜負責方｜時程」（若無則寫「無明確待辦事項」）。\n' +
  '【三、待確認議題與風險】未定案爭議、技術／法規限制或收音中斷缺口（若無則省略；不得跨缺口臆測）。';

const SummarizeBodySchema = z
  .object({
    transcript: z.string().trim().min(1).max(200_000),
    preferredProvider: z.enum(['gemini', 'openai']).optional(),
    gaps: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();

const summarizeRateState = new Map<string, number[]>();

function isRateLimited(ip: string, nowMs = Date.now()): boolean {
  const limit = 20;
  const windowStart = nowMs - 60_000;
  const hits = (summarizeRateState.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    summarizeRateState.set(ip, hits);
    return true;
  }
  hits.push(nowMs);
  summarizeRateState.set(ip, hits);
  return false;
}

setInterval(() => {
  if (summarizeRateState.size > 10_000) {
    const cutoff = Date.now() - 60_000;
    for (const [ip, hits] of summarizeRateState) {
      const live = hits.filter((t) => t > cutoff);
      if (live.length === 0) summarizeRateState.delete(ip);
      else summarizeRateState.set(ip, live);
    }
  }
}, 60_000).unref?.();

export function _resetSummarizeRateLimitForTests(): void {
  summarizeRateState.clear();
}

function buildUserPrompt(transcript: string, gaps?: string[]): string {
  if (gaps && gaps.length > 0) {
    return `已知收音／連線中斷缺口（此區間無紀錄，請於風險段標註並切勿臆測）：${gaps.join('；')}\n\n逐字稿：\n${transcript}`;
  }
  return `逐字稿：\n${transcript}`;
}

interface ProviderAttemptResult {
  ok: true;
  summary: string;
  provider: 'gemini' | 'openai';
  model: string;
}

interface ProviderAttemptFailure {
  ok: false;
  status: number;
  retryAfter?: string | undefined;
  error: string;
}

async function callGeminiSummary(
  userPrompt: string,
  req: FastifyRequest,
): Promise<ProviderAttemptResult | ProviderAttemptFailure> {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: 'GEMINI_API_KEY not configured on server' };
  }
  let res: Response;
  try {
    res = await fetch(GEMINI_GENERATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
      signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'TimeoutError';
    req.log.warn({ code: upstreamErrorCode(err) }, '/summarize Gemini fetch failed');
    return {
      ok: false,
      status: isAbort ? 504 : 502,
      error: isAbort ? 'Gemini summary request timed out' : 'Gemini summary upstream failed',
    };
  }

  if (!res.ok) {
    const retryAfter = res.headers?.get?.('Retry-After') ?? undefined;
    await res.body?.cancel?.().catch(() => {});
    req.log.warn({ status: res.status }, '/summarize Gemini non-2xx');
    return {
      ok: false,
      status: res.status < 500 ? res.status : 502,
      retryAfter,
      error: 'Gemini summary upstream error',
    };
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const summary =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim() ?? '';
  if (!summary) {
    return { ok: false, status: 502, error: 'Empty Gemini summary response' };
  }
  return { ok: true, summary, provider: 'gemini', model: GEMINI_SUMMARY_MODEL };
}

async function callOpenAISummary(
  userPrompt: string,
  req: FastifyRequest,
): Promise<ProviderAttemptResult | ProviderAttemptFailure> {
  if (!hasAnyOpenAIKey()) {
    return { ok: false, status: 503, error: 'OPENAI_API_KEY not configured on server' };
  }
  let res: Response;
  try {
    const outcome = await fetchWithOpenAIKeyFailover(
      (apiKey) =>
        fetch(OPENAI_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OPENAI_SUMMARY_MODEL,
            messages: [
              { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
        }),
      req.log,
    );
    res = outcome.res;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'TimeoutError';
    req.log.warn({ code: upstreamErrorCode(err) }, '/summarize OpenAI fetch failed');
    return {
      ok: false,
      status: isAbort ? 504 : 502,
      error: isAbort ? 'OpenAI summary request timed out' : 'OpenAI summary upstream failed',
    };
  }

  if (!res.ok) {
    const retryAfter = res.headers?.get?.('Retry-After') ?? undefined;
    await res.body?.cancel?.().catch(() => {});
    req.log.warn({ status: res.status }, '/summarize OpenAI non-2xx');
    return {
      ok: false,
      status: res.status < 500 ? res.status : 502,
      retryAfter,
      error: 'OpenAI summary upstream error',
    };
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const summary = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!summary) {
    return { ok: false, status: 502, error: 'Empty OpenAI summary response' };
  }
  return { ok: true, summary, provider: 'openai', model: OPENAI_SUMMARY_MODEL };
}

export async function registerSummarize(app: FastifyInstance): Promise<void> {
  app.post('/summarize', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const hasGemini = Boolean(config.GEMINI_API_KEY);
    const hasOpenAI = hasAnyOpenAIKey();
    if (!hasGemini && !hasOpenAI) {
      return reply.status(503).send({ error: 'No summary AI provider configured on server' });
    }

    if (isRateLimited(req.ip)) {
      return reply
        .header('Retry-After', '60')
        .status(429)
        .send({ error: 'Too many summarize requests; retry in a minute' });
    }

    const parsed = SummarizeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { transcript, preferredProvider = 'gemini', gaps } = parsed.data;
    const order: Array<'gemini' | 'openai'> = [];
    const second: 'gemini' | 'openai' = preferredProvider === 'openai' ? 'gemini' : 'openai';
    if (
      (preferredProvider === 'gemini' && hasGemini) ||
      (preferredProvider === 'openai' && hasOpenAI)
    ) {
      order.push(preferredProvider);
    }
    if ((second === 'gemini' && hasGemini) || (second === 'openai' && hasOpenAI)) {
      order.push(second);
    }

    const userPrompt = buildUserPrompt(transcript, gaps);
    let lastFailure: ProviderAttemptFailure = {
      ok: false,
      status: 503,
      error: 'No summary AI provider configured on server',
    };

    for (let idx = 0; idx < order.length; idx++) {
      const candidate = order[idx]!;
      const outcome =
        candidate === 'gemini'
          ? await callGeminiSummary(userPrompt, req)
          : await callOpenAISummary(userPrompt, req);
      if (outcome.ok) {
        return {
          summary: outcome.summary,
          provider: outcome.provider,
          model: outcome.model,
          fallbackUsed: idx > 0,
        };
      }
      lastFailure = outcome;
    }

    if (lastFailure.retryAfter) {
      reply.header('Retry-After', lastFailure.retryAfter);
    }
    return reply.status(lastFailure.status).send({ error: lastFailure.error });
  });
}
