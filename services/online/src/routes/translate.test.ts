import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_TIMEOUT_MS: 10_000,
}));

vi.mock('../config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import Fastify from 'fastify';
import { registerTranslate } from './translate.js';

function makeApp() {
  const app = Fastify({ logger: false });
  return registerTranslate(app).then(() => app);
}

beforeEach(() => {
  mockConfig.OPENAI_API_KEY = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('POST /translate', () => {
  it('returns 503 when OPENAI_API_KEY is not set', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { segmentId: 's1', text: 'Hello', sourceLang: 'en', targetLang: 'zh-TW' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/OPENAI_API_KEY/);
  });

  it('returns 400 for missing required fields', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { text: 'Hello' }, // missing segmentId, sourceLang, targetLang
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('Invalid request body');
  });

  it('returns 400 for unknown extra field (strict schema)', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { segmentId: 's1', text: 'Hello', sourceLang: 'en', targetLang: 'zh-TW', extra: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('calls OpenAI and returns targetText on success', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '你好世界' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { segmentId: 's1', text: 'Hello world', sourceLang: 'en', targetLang: 'zh-TW' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ segmentId: string; sourceText: string; targetText: string }>();
    expect(body.segmentId).toBe('s1');
    expect(body.sourceText).toBe('Hello world');
    expect(body.targetText).toBe('你好世界');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('chat/completions');
    const reqBody = JSON.parse(init.body as string);
    expect(reqBody.model).toBe('gpt-4.1-mini');
    expect(reqBody.messages[0].role).toBe('system');
    expect(reqBody.messages[1].content).toBe('Hello world');
  });

  it('returns 502 when OpenAI returns a non-2xx response', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { segmentId: 's1', text: 'Hello', sourceLang: 'en', targetLang: 'zh-TW' },
    });
    expect(res.statusCode).toBe(502);
  });

  it('forwards zh→en direction with correct system prompt', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'The policyholder' } }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/translate',
      payload: { segmentId: 's2', text: '要保人', sourceLang: 'zh', targetLang: 'en' },
    });
    const reqBody = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(reqBody.messages[0].content).toContain('English');
    expect(reqBody.messages[0].content).not.toContain('Traditional Chinese');
  });
});
