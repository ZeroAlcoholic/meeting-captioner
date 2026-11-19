import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const mockConfig = vi.hoisted(() => ({
  GEMINI_API_KEY: undefined as string | undefined,
  OPENAI_TIMEOUT_MS: 1000,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED: false,
}));
vi.mock('../config.js', () => ({ config: mockConfig }));
import { registerGeminiTranscription } from './gemini-transcription.js';
import { _resetRateLimitForTests, isRateLimited } from './session.js';
import { MEETING_KEYWORDS } from '@meeting-audio/contracts';

const apps: ReturnType<typeof Fastify>[] = [];
beforeEach(() => {
  _resetRateLimitForTests();
  mockConfig.GEMINI_API_KEY = 'server-only-test-key';
  mockConfig.OPENAI_TIMEOUT_MS = 1000;
  mockConfig.SESSION_RATE_LIMIT_PER_MIN = 30;
  mockConfig.GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED = false;
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function app() {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await registerGeminiTranscription(instance);
  return instance;
}
const request = {
  method: 'POST' as const,
  url: '/session/gemini/transcription',
  payload: { inputLanguages: ['zh-tw', 'en'], micDistance: 'meeting' },
};

describe('dedicated Gemini transcription broker', () => {
  it.each([false, true])(
    'returns server-qualified concurrent renewal=%s and bounded renewal advice',
    async (allowed) => {
      mockConfig.GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED = allowed;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ name: 'auth_tokens/opaque' }))),
      );
      const response = await (await app()).inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        concurrent_renewal_allowed: allowed,
        session_renewal_recommended_ms: 480000,
      });
    },
  );
  it('requires server credentials without making an upstream request', async () => {
    mockConfig.GEMINI_API_KEY = undefined;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await (await app()).inject(request)).statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('mints one constrained TEXT/verbatim/autodetect/manual-VAD token using the documented REST body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: 'auth_tokens/opaque' })));
    vi.stubGlobal('fetch', fetch);
    const response = await (await app()).inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      token: 'auth_tokens/opaque',
      model: 'models/gemini-3.5-transcribe-live',
    });
    expect(response.json().expiresAt).toBeGreaterThan(Date.now());
    expect(response.json().expiresAt).toBeLessThanOrEqual(Date.now() + 120000);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'server-only-test-key' });
    const body = JSON.parse(String(init.body));
    expect(body.uses).toBe(1);
    expect(body).not.toHaveProperty('liveConnectConstraints');
    expect(body.bidiGenerateContentSetup).toEqual({
      model: 'models/gemini-3.5-transcribe-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: {
        languageCodes: [],
        mode: 'VERBATIM',
        customVocabulary: [...MEETING_KEYWORDS],
      },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    });
    expect(JSON.stringify(body)).not.toContain('translationConfig');
    expect(response.body).not.toContain('server-only-test-key');
  });
  it.each([
    { inputLanguages: ['ja'] },
    { model: 'arbitrary' },
    { upstreamUrl: 'https://other.invalid' },
    { micDistance: 'invalid' },
    { inputLanguages: [] },
  ])('rejects unapproved request settings %j', async (payload) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await (await app()).inject({ ...request, payload })).statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shares the existing session limit instead of granting a new purpose another allowance', async () => {
    mockConfig.SESSION_RATE_LIMIT_PER_MIN = 1;
    expect(isRateLimited('127.0.0.1', 1)).toBe(false);
    const response = await (await app()).inject(request);
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });
  it.each([401, 403, 429, 500])(
    'sanitizes upstream %s without reading or logging its body',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('private upstream body server-only-test-key', {
            status,
            headers: { 'Retry-After': '17' },
          }),
        ),
      );
      const response = await (await app()).inject(request);
      expect(response.statusCode).toBe(status >= 500 ? 502 : status);
      expect(response.body).not.toContain('private');
      expect(response.body).not.toContain('server-only-test-key');
      if (status === 429) expect(response.headers['retry-after']).toBe('17');
    },
  );
  it('includes stalled response-body reading in the total deadline', async () => {
    mockConfig.OPENAI_TIMEOUT_MS = 20;
    const response = new Response(new ReadableStream());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await (await app()).inject(request);
    expect(result.statusCode).toBe(504);
  });
  it('sanitizes network failure and malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('private server-only-test-key'))
        .mockResolvedValueOnce(new Response('{')),
    );
    const instance = await app();
    const failed = await instance.inject(request);
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('server-only-test-key');
    expect((await instance.inject(request)).statusCode).toBe(502);
  });
  it('cancels token minting when the browser request is aborted', async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            upstreamSignal = init.signal as AbortSignal;
            upstreamSignal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    );
    const instance = await app();
    instance.addHook('onRequest', async (req) => {
      setTimeout(() => req.raw.emit('aborted'), 5);
    });
    const result = await instance.inject(request);
    expect(result.statusCode).toBe(504);
    expect(upstreamSignal?.aborted).toBe(true);
  });
  it.each([
    {},
    { name: 'not-a-token' },
    { name: 'auth_tokens/x', newSessionExpireTime: '2000-01-01T00:00:00Z' },
  ])('rejects invalid or expired token response %j', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    expect((await (await app()).inject(request)).statusCode).toBe(502);
  });
});
