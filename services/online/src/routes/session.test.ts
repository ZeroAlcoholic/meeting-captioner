import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiKey = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('../config.js', () => ({
  config: {
    get OPENAI_API_KEY() {
      return mockApiKey.value;
    },
  },
}));

import Fastify from 'fastify';
import { registerSession } from './session.js';

const FAKE_SECRET = { value: 'ephemeral-token-xyz', expires_at: 9999999999 };

function stubFetchOk() {
  // API returns flat { value, expires_at } — session.ts wraps it into { client_secret: { ... } }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('GET /session/info', () => {
  it('returns hasApiKey false when no key configured', async () => {
    mockApiKey.value = undefined;
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hasApiKey: boolean }>().hasApiKey).toBe(false);
  });

  it('returns hasApiKey true when key is configured', async () => {
    mockApiKey.value = 'sk-test-key';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.json<{ hasApiKey: boolean }>().hasApiKey).toBe(true);
  });
});

describe('POST /session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 503 when no API key configured', async () => {
    mockApiKey.value = undefined;
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toContain('OPENAI_API_KEY');
  });

  it('returns client_secret and never exposes the raw API key', async () => {
    stubFetchOk();
    mockApiKey.value = 'sk-real-secret-do-not-leak';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ client_secret: typeof FAKE_SECRET }>();
    expect(body.client_secret).toEqual(FAKE_SECRET);
    expect(JSON.stringify(body)).not.toContain('sk-real-secret-do-not-leak');
  });

  it('calls /v1/realtime/translations/client_secrets with gpt-realtime-translate model', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockApiKey.value = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({ method: 'POST', url: '/session' });

    expect(mockFn).toHaveBeenCalledOnce();
    const [url, init] = mockFn.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/v1/realtime/translations/client_secrets');
    const body = JSON.parse(init.body) as {
      session: { model: string; audio: { output: { language: string } } };
    };
    expect(body.session.model).toBe('gpt-realtime-translate');
    // default langPair en→zh-TW maps to output language 'zh'
    expect(body.session.audio.output.language).toBe('zh');
  });

  it('sets output language "en" when langPair is zh-TW→en', async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(FAKE_SECRET), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFn);
    mockApiKey.value = 'sk-test';
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

  it('forwards non-200 response from OpenAI back to caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })),
    );
    mockApiKey.value = 'sk-test';
    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(401);
  });
});
