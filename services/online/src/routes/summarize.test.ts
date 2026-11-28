import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_API_KEY_AUDIO: undefined as string | undefined,
  GEMINI_API_KEY: undefined as string | undefined,
  OPENAI_TIMEOUT_MS: 10_000,
}));

vi.mock('../config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import Fastify from 'fastify';
import { _resetOpenAIKeysForTests } from '../openai-keys.js';
import { _resetSummarizeRateLimitForTests, registerSummarize } from './summarize.js';

function makeApp() {
  const app = Fastify({ logger: false });
  return registerSummarize(app).then(() => app);
}

beforeEach(() => {
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.OPENAI_API_KEY_AUDIO = undefined;
  mockConfig.GEMINI_API_KEY = undefined;
  _resetOpenAIKeysForTests();
  _resetSummarizeRateLimitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /summarize', () => {
  it('returns 503 when neither GEMINI_API_KEY nor OPENAI_API_KEY is configured', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: { transcript: '[00:05] Policyholder premium is $1,200.' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 on empty transcript or unknown fields', async () => {
    mockConfig.GEMINI_API_KEY = 'gm-secret-key';
    const app = await makeApp();
    const empty = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: { transcript: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const extra = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: { transcript: '[00:01] Hello', unknownField: true },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('summarizes with gemini-3.8-flash using x-goog-api-key header and thinkingLevel low without temperature', async () => {
    mockConfig.GEMINI_API_KEY = 'gm-secret-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '【一、核心結論與重點】\n- [00:05] 保費定為 $1,200。' }],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: {
        transcript: '[00:05] Policyholder premium is $1,200.\n要保人保費為 1,200 美元。',
        preferredProvider: 'gemini',
        gaps: ['01:10–01:25 麥克風中斷'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      summary: string;
      provider: string;
      model: string;
      fallbackUsed: boolean;
    }>();
    expect(body).toEqual({
      summary: '【一、核心結論與重點】\n- [00:05] 保費定為 $1,200。',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      fallbackUsed: false,
    });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(url).not.toContain('gm-secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gm-secret-key');
    const sent = JSON.parse(init.body as string);
    expect(sent.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: 'low' },
    });
    expect(sent.generationConfig.temperature).toBeUndefined();
    expect(sent.contents[0].parts[0].text).toContain('01:10–01:25 麥克風中斷');
  });

  it('automatically fails over to gemini-3.8-flash when OpenAI key is rejected (401/403 IP restriction) or times out', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-corp-restricted';
    mockConfig.GEMINI_API_KEY = 'gm-backup-key';
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => 'ip_not_authorized',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '【一、核心結論與重點】\n- [00:12] AI 核保模型 p95 延遲 320ms。' }],
              },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: {
        transcript: '[00:12] AI underwriting p95 latency is 320ms.',
        preferredProvider: 'openai',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      summary: string;
      provider: string;
      model: string;
      fallbackUsed: boolean;
    }>();
    expect(body.provider).toBe('gemini');
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.fallbackUsed).toBe(true);
    expect(body.summary).toContain('320ms');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses gpt-5.4-mini when OpenAI is preferred and reachable', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-working';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: '【一、核心結論與重點】\n- [00:01] 決議通過。' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/summarize',
      payload: {
        transcript: '[00:01] Approved.',
        preferredProvider: 'openai',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      summary: string;
      provider: string;
      model: string;
      fallbackUsed: boolean;
    }>();
    expect(body).toEqual({
      summary: '【一、核心結論與重點】\n- [00:01] 決議通過。',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      fallbackUsed: false,
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(init.body as string).model).toBe('gpt-5.4-mini');
  });
});
