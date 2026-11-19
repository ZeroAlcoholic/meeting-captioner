import Fastify from 'fastify';
import { MEETING_KEYWORDS } from '@meeting-audio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  OPENAI_API_KEY: 'test-private-key',
  OPENAI_API_KEY_AUDIO: undefined as string | undefined,
  OPENAI_TIMEOUT_MS: 100,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  SESSION_RENEW_MS: 1500000,
  OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED: false,
}));
vi.mock('../config.js', () => ({ config: cfg }));
import { _resetOpenAIKeysForTests, openAIKeyDemotion } from '../openai-keys.js';
import { _resetRateLimitForTests, registerSession } from './session.js';
import { registerTranscription } from './transcription.js';

beforeEach(() => {
  _resetOpenAIKeysForTests();
  _resetRateLimitForTests();
  cfg.OPENAI_API_KEY = 'test-private-key';
  cfg.OPENAI_API_KEY_AUDIO = undefined;
  cfg.SESSION_RATE_LIMIT_PER_MIN = 30;
  cfg.OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function app() {
  const a = Fastify({ logger: false });
  await registerSession(a);
  await registerTranscription(a);
  return a;
}
function success() {
  return new Response(JSON.stringify({ value: 'ephemeral-only', expires_at: 9999999999 }));
}
describe('pure transcription broker', () => {
  it.each([false, true])('returns only server-qualified concurrent renewal=%s', async (allowed) => {
    cfg.OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED = allowed;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => success()),
    );
    const a = await app();
    const response = await a.inject({ method: 'POST', url: '/session/transcription', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().concurrent_renewal_allowed).toBe(allowed);
    await a.close();
  });
  it('probes the alternate only once without demoting an opaque rejected slot', async () => {
    cfg.OPENAI_API_KEY_AUDIO = 'private-audio';
    const f = vi.fn(async () => success());
    vi.stubGlobal('fetch', f);
    const a = await app();
    const initial = await a.inject({ method: 'POST', url: '/session/transcription', payload: {} });
    expect(initial.json().alternate_key_slot).toBe('audio');
    f.mockClear();
    const retry = await a.inject({
      method: 'POST',
      url: '/session/transcription',
      payload: {
        retryKeySlot: 'audio',
        failedSlot: 'primary',
        failureKind: 'opaque',
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().key_slot).toBe('audio');
    expect(f).toHaveBeenCalledOnce();
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: 'Bearer private-audio',
    });
    expect(openAIKeyDemotion()).toBeNull();
    expect(retry.body).not.toContain('private-audio');
    await a.close();
  });
  it('demotes explicit auth rejection only when alternate mint succeeds', async () => {
    cfg.OPENAI_API_KEY_AUDIO = 'private-audio';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => success()),
    );
    const a = await app();
    const r = await a.inject({
      method: 'POST',
      url: '/session/transcription',
      payload: {
        retryKeySlot: 'audio',
        failedSlot: 'primary',
        failureKind: 'auth',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(openAIKeyDemotion()?.slot).toBe('primary');
    await a.close();
  });
  it('does not advertise duplicate credentials as an alternate and rejects a missing alternate', async () => {
    cfg.OPENAI_API_KEY_AUDIO = cfg.OPENAI_API_KEY;
    const f = vi.fn(async () => success());
    vi.stubGlobal('fetch', f);
    const a = await app();
    const initial = await a.inject({ method: 'POST', url: '/session/transcription', payload: {} });
    expect(initial.json().alternate_key_slot).toBeUndefined();
    f.mockClear();
    const retry = await a.inject({
      method: 'POST',
      url: '/session/transcription',
      payload: { retryKeySlot: 'audio', failedSlot: 'primary', failureKind: 'opaque' },
    });
    expect(retry.statusCode).toBe(400);
    expect(f).not.toHaveBeenCalled();
    expect(openAIKeyDemotion()).toBeNull();
    await a.close();
  });
  it('never bounces an alternate probe back to the failed key on 401 or 429', async () => {
    cfg.OPENAI_API_KEY_AUDIO = 'private-audio';
    const a = await app();
    for (const status of [401, 429]) {
      const f = vi.fn(async () => new Response('{}', { status }));
      vi.stubGlobal('fetch', f);
      const r = await a.inject({
        method: 'POST',
        url: '/session/transcription',
        payload: {
          retryKeySlot: 'audio',
          failedSlot: 'primary',
          failureKind: 'auth',
        },
      });
      expect(r.statusCode).toBe(status);
      expect(f).toHaveBeenCalledOnce();
      expect(openAIKeyDemotion()).toBeNull();
    }
    await a.close();
  });
  it.each([
    { retryKeySlot: 'audio' },
    { retryKeySlot: 'primary', failedSlot: 'primary', failureKind: 'opaque' },
    { retryKeySlot: 'arbitrary', failedSlot: 'primary', failureKind: 'auth' },
  ])('rejects malformed retry selection %j', async (payload) => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const a = await app();
    expect(
      (await a.inject({ method: 'POST', url: '/session/transcription', payload })).statusCode,
    ).toBe(400);
    expect(f).not.toHaveBeenCalled();
    await a.close();
  });
  it('mints only a transcription session and returns only the short lived secret', async () => {
    const fetchMock = vi.fn(async () => success());
    vi.stubGlobal('fetch', fetchMock);
    const a = await app();
    const r = await a.inject({
      method: 'POST',
      url: '/session/transcription',
      payload: { inputLanguages: ['zh-tw', 'en'], micDistance: 'meeting' },
    });
    expect(r.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    const payload = JSON.parse(String(init.body));
    expect(payload.session.type).toBe('transcription');
    expect(payload.session.audio.input.transcription).toMatchObject({
      model: 'gpt-live-transcribe',
      languages: ['zh-tw', 'en'],
      keywords: [...MEETING_KEYWORDS],
    });
    expect(payload.session.audio.input.turn_detection).toBeNull();
    expect(payload.session.audio.output).toBeUndefined();
    expect(r.json().client_secret.value).toBe('ephemeral-only');
    expect(r.body).not.toContain(cfg.OPENAI_API_KEY);
    expect(r.headers['cache-control']).toBe('no-store');
    await a.close();
  });
  it.each([{ model: 'arbitrary' }, { langPair: 'en→zh-TW' }, { inputLanguages: ['xx'] }])(
    'rejects unsupported input %j before contacting upstream',
    async (payload) => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      const a = await app();
      expect(
        (await a.inject({ method: 'POST', url: '/session/transcription', payload })).statusCode,
      ).toBe(400);
      expect(f).not.toHaveBeenCalled();
      await a.close();
    },
  );
  it('does not claim account verified merely because a key exists', async () => {
    const a = await app();
    const info = (await a.inject('/session/info')).json();
    expect(info.taskCapabilities).toContainEqual({
      provider: 'openai',
      purpose: 'transcription',
      configured: true,
      verified: false,
    });
    await a.close();
  });
  it('fails visibly without credentials', async () => {
    cfg.OPENAI_API_KEY = '';
    const a = await app();
    expect(
      (await a.inject({ method: 'POST', url: '/session/transcription', payload: {} })).statusCode,
    ).toBe(503);
    await a.close();
  });
  it('shares quota with translation instead of doubling the token budget', async () => {
    cfg.SESSION_RATE_LIMIT_PER_MIN = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => success()),
    );
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/session', payload: {} })).statusCode).toBe(200);
    expect(
      (await a.inject({ method: 'POST', url: '/session/transcription', payload: {} })).statusCode,
    ).toBe(429);
    await a.close();
  });
  it.each(['12', 'Wed, 21 Oct 2026 07:28:00 GMT'])(
    'sanitizes upstream error bodies and preserves retry-after %s',
    async (retryAfter) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('private upstream detail', {
              status: 429,
              headers: { 'retry-after': retryAfter },
            }),
        ),
      );
      const a = await app();
      const r = await a.inject({ method: 'POST', url: '/session/transcription', payload: {} });
      expect(r.statusCode).toBe(429);
      expect(r.headers['retry-after']).toBe(retryAfter);
      expect(r.body).not.toContain('private upstream');
      await a.close();
    },
  );
  it('rejects malformed or expired token responses instead of showing ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ value: 'x', expires_at: 1 }))),
    );
    const a = await app();
    expect(
      (await a.inject({ method: 'POST', url: '/session/transcription', payload: {} })).statusCode,
    ).toBe(502);
    await a.close();
  });
  it('bounds response body reads as well as fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })),
    );
    const a = await app();
    const r = await a.inject({ method: 'POST', url: '/session/transcription', payload: {} });
    expect(r.statusCode).toBe(504);
    await a.close();
  });
});
