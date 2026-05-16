import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_TIMEOUT_MS: 10_000,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  SESSION_RENEW_MS: 25 * 60 * 1000,
  ONLINE_PORT: 8787,
  ONLINE_CORS_ORIGIN: 'http://localhost:5173',
}));

vi.mock('../config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import Fastify from 'fastify';
import { _resetHealthForTests } from './healthz.js';
import { _resetRateLimitForTests, registerSession } from './session.js';

const FAKE_SECRET = { value: 'ephemeral-token-xyz', expires_at: 9999999999 };

function stubFetchOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    ),
  );
}

beforeEach(() => {
  _resetRateLimitForTests();
  _resetHealthForTests();
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.OPENAI_TIMEOUT_MS = 10_000;
  mockConfig.SESSION_RATE_LIMIT_PER_MIN = 30;
});

afterEach(() => vi.restoreAllMocks());

describe('GET /session/info', () => {
  it('returns hasApiKey false when no key configured', async () => {
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      hasApiKey: boolean;
      sessionRenewalRecommendedMs: number;
      supportedLangPairs: string[];
    }>();
    expect(body.hasApiKey).toBe(false);
    expect(body.sessionRenewalRecommendedMs).toBe(25 * 60 * 1000);
    expect(body.supportedLangPairs).toEqual(['en→zh-TW', 'zh-TW→en']);
  });

  it('returns hasApiKey true when key is configured', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test-key';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.json<{ hasApiKey: boolean }>().hasApiKey).toBe(true);
  });
});

describe('POST /session', () => {
  it('returns 503 when no API key configured', async () => {
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toContain('OPENAI_API_KEY');
  });

  it('returns client_secret + renewal hint, never exposing the raw API key', async () => {
    stubFetchOk();
    mockConfig.OPENAI_API_KEY = 'sk-real-secret-do-not-leak';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      client_secret: typeof FAKE_SECRET;
      session_renewal_recommended_ms: number;
    }>();
    expect(body.client_secret).toEqual(FAKE_SECRET);
    expect(body.session_renewal_recommended_ms).toBe(25 * 60 * 1000);
    expect(JSON.stringify(body)).not.toContain('sk-real-secret-do-not-leak');
  });

  it('calls /v1/realtime/translations/client_secrets with gpt-realtime-translate model', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({ method: 'POST', url: '/session' });

    expect(mockFn).toHaveBeenCalledOnce();
    const [url, init] = mockFn.mock.calls[0] as [
      string,
      { body: string; signal?: AbortSignal },
    ];
    expect(url).toContain('/v1/realtime/translations/client_secrets');
    const body = JSON.parse(init.body) as {
      session: { model: string; audio: { output: { language: string } } };
    };
    expect(body.session.model).toBe('gpt-realtime-translate');
    expect(body.session.audio.output.language).toBe('zh');
    // B2: timeout signal must be attached
    expect(init.signal).toBeDefined();
  });

  it('includes transcription:gpt-realtime-whisper by default (bilingual)', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({ method: 'POST', url: '/session' });

    const [, init] = mockFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      session: { audio: { input: Record<string, unknown> } };
    };
    expect(body.session.audio.input.transcription).toEqual({ model: 'gpt-realtime-whisper' });
    expect(body.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
  });

  it('omits transcription when includeSourceTranscript=false (translation-only)', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({
      method: 'POST',
      url: '/session',
      payload: { includeSourceTranscript: false },
    });

    const [, init] = mockFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      session: { audio: { input: Record<string, unknown> } };
    };
    expect(body.session.audio.input.transcription).toBeUndefined();
    expect(body.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
  });

  it('sets output language "en" when langPair is zh-TW→en', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({
      method: 'POST',
      url: '/session',
      payload: { langPair: 'zh-TW→en' },
    });

    const [, init] = mockFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      session: { audio: { output: { language: string } } };
    };
    expect(body.session.audio.output.language).toBe('en');
  });

  it('returns 400 on malformed body (unknown key)', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/session',
      payload: { unexpected: 'value' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Invalid');
  });

  it('returns 400 on invalid langPair value', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/session',
      payload: { langPair: 'jp→en' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 504 when upstream times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      }),
    );
    mockConfig.OPENAI_API_KEY = 'sk-test';
    mockConfig.OPENAI_TIMEOUT_MS = 1;
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(504);
    expect(res.json<{ error: string }>().error).toMatch(/timed out/i);
  });

  it('returns 502 on upstream network error (non-timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')),
    );
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(502);
  });

  it('sanitizes upstream non-2xx — never forwards raw OpenAI body', async () => {
    const upstreamLeak = 'org_abc123 quota exceeded plan_pro_monthly';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(upstreamLeak, { status: 429 }),
      ),
    );
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(429);
    const text = res.body;
    expect(text).not.toContain('org_abc123');
    expect(text).not.toContain('plan_pro_monthly');
    expect(res.json<{ error: string }>().error).toMatch(/rate-limited/i);
  });

  it('rate-limits after SESSION_RATE_LIMIT_PER_MIN requests', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    mockConfig.SESSION_RATE_LIMIT_PER_MIN = 3;
    vi.stubGlobal(
      'fetch',
      // Return a fresh Response per call — Response.body is single-use.
      vi.fn().mockImplementation(
        () =>
          Promise.resolve(new Response(JSON.stringify(FAKE_SECRET), { status: 200 })),
      ),
    );
    const app = Fastify({ logger: false });
    await registerSession(app);
    const ok1 = await app.inject({ method: 'POST', url: '/session' });
    const ok2 = await app.inject({ method: 'POST', url: '/session' });
    const ok3 = await app.inject({ method: 'POST', url: '/session' });
    const limited = await app.inject({ method: 'POST', url: '/session' });
    expect(ok1.statusCode).toBe(200);
    expect(ok2.statusCode).toBe(200);
    expect(ok3.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
  });
});
