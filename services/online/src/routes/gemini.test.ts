import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  GEMINI_API_KEY: undefined as string | undefined,
  GEMINI_LIVE_MODEL: 'gemini-3.5-live-translate-preview',
  OPENAI_TIMEOUT_MS: 10_000,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  SESSION_RENEW_MS: 25 * 60 * 1000,
}));

vi.mock('../config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import Fastify from 'fastify';
import { _resetGeminiRateLimitForTests, registerGemini } from './gemini.js';
import { registerSession, _resetRateLimitForTests } from './session.js';

beforeEach(() => {
  _resetGeminiRateLimitForTests();
  _resetRateLimitForTests();
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.GEMINI_API_KEY = undefined;
  mockConfig.GEMINI_LIVE_MODEL = 'gemini-3.5-live-translate-preview';
  mockConfig.SESSION_RATE_LIMIT_PER_MIN = 30;
});

afterEach(() => vi.restoreAllMocks());

describe('POST /session/gemini', () => {
  it('503 when GEMINI_API_KEY not configured', async () => {
    const app = Fastify({ logger: false });
    await registerGemini(app);
    const res = await app.inject({ method: 'POST', url: '/session/gemini' });
    expect(res.statusCode).toBe(503);
  });

  it('mints an ephemeral token and returns token + prefixed model', async () => {
    mockConfig.GEMINI_API_KEY = 'gk-test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'auth_tokens/abc123' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const app = Fastify({ logger: false });
    await registerGemini(app);
    const res = await app.inject({ method: 'POST', url: '/session/gemini' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; model: string }>();
    expect(body.token).toBe('auth_tokens/abc123');
    expect(body.model).toBe('models/gemini-3.5-live-translate-preview');

    // Upstream request used the key in the URL and minted a single-use,
    // unconstrained token (locking the model caused a Live WS 1011 — verified).
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('auth_tokens');
    expect(url).toContain('key=gk-test');
    const sentBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentBody.uses).toBe(1);
    expect(sentBody.expireTime).toBeTruthy();
    expect(sentBody.newSessionExpireTime).toBeTruthy();
    expect(sentBody.liveConnectConstraints).toBeUndefined();
    expect(sentBody.bidiGenerateContentSetup).toBeUndefined();
  });

  it('sanitizes a 401 upstream rejection', async () => {
    mockConfig.GEMINI_API_KEY = 'gk-bad';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('nope', { status: 401 })));
    const app = Fastify({ logger: false });
    await registerGemini(app);
    const res = await app.inject({ method: 'POST', url: '/session/gemini' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toMatch(/rejected the Gemini API key/);
  });

  it('502 when upstream response lacks a token name', async () => {
    mockConfig.GEMINI_API_KEY = 'gk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })),
    );
    const app = Fastify({ logger: false });
    await registerGemini(app);
    const res = await app.inject({ method: 'POST', url: '/session/gemini' });
    expect(res.statusCode).toBe(502);
  });
});

describe('GET /session/info — availableProviders', () => {
  it('lists gemini when GEMINI_API_KEY is set', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    mockConfig.GEMINI_API_KEY = 'gk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    const body = res.json<{ availableProviders: string[]; hasGeminiKey: boolean }>();
    expect(body.availableProviders).toContain('openai');
    expect(body.availableProviders).toContain('gemini');
    expect(body.hasGeminiKey).toBe(true);
  });

  it('omits gemini when GEMINI_API_KEY is absent', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    const body = res.json<{ availableProviders: string[]; hasGeminiKey: boolean }>();
    expect(body.availableProviders).toEqual(['openai']);
    expect(body.hasGeminiKey).toBe(false);
  });
});
