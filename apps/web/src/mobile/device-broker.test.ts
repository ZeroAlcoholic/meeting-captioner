import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceBrokerFetch } from './device-broker.js';
import { __resetDeviceKeysForTests, getDeviceKeys, maskKey, setDeviceKey } from './device-keys.js';
import { friendlyError, resolveStartOrder, transcriptText } from './MobileApp.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';

const OPENAI_KEY = 'sk-test-openai-device-key';
const GEMINI_KEY = 'test-gemini-device-key';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  __resetDeviceKeysForTests();
  upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function upstreamJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('device keys', () => {
  it('persists, trims, removes, and never displays more than the tail', () => {
    expect(getDeviceKeys()).toEqual({});
    expect(setDeviceKey('gemini', `  ${GEMINI_KEY}  `)).toBe(true);
    __resetDeviceKeysForTests(); // a later visit reads storage again
    expect(getDeviceKeys()).toEqual({ gemini: GEMINI_KEY });
    expect(maskKey(GEMINI_KEY)).toBe('••••-key');
    expect(maskKey(GEMINI_KEY)).not.toContain('test-gemini');
    setDeviceKey('gemini', '');
    __resetDeviceKeysForTests();
    expect(getDeviceKeys()).toEqual({});
  });

  it('stays usable for the visit when storage refuses to write', () => {
    vi.stubGlobal('localStorage', {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(setDeviceKey('openai', OPENAI_KEY)).toBe(false);
    expect(getDeviceKeys().openai).toBe(OPENAI_KEY);
  });
});

describe('device broker', () => {
  it('reports which providers have a key without contacting anyone', async () => {
    setDeviceKey('gemini', GEMINI_KEY);
    const info = await (await deviceBrokerFetch('/session/info')).json();
    expect(info).toMatchObject({
      hasApiKey: false,
      hasGeminiKey: true,
      availableProviders: ['gemini'],
    });
    expect(JSON.stringify(info)).not.toContain(GEMINI_KEY);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses to mint without a saved key and makes no upstream call', async () => {
    expect((await deviceBrokerFetch('/session', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await deviceBrokerFetch('/session/gemini', { method: 'POST' })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('mints an OpenAI translation secret with the server-identical session shape', async () => {
    setDeviceKey('openai', OPENAI_KEY);
    upstream.mockResolvedValue(upstreamJson(200, { value: 'ek_abc', expires_at: 1234 }));
    const res = await deviceBrokerFetch('/session', {
      method: 'POST',
      body: JSON.stringify({
        langPair: 'en→zh-TW',
        includeSourceTranscript: true,
        micDistance: 'meeting',
      }),
    });
    const body = await res.json();
    expect(body).toEqual({
      client_secret: { value: 'ek_abc', expires_at: 1234 },
      session_renewal_recommended_ms: 25 * 60 * 1000,
    });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/realtime/translations/client_secrets');
    expect(init.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      session: {
        model: 'gpt-realtime-translate',
        audio: {
          input: {
            noise_reduction: { type: 'far_field' },
            transcription: { model: 'gpt-realtime-whisper' },
          },
          output: { language: 'zh' },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(OPENAI_KEY);
  });

  it('omits source transcription and noise reduction when asked', async () => {
    setDeviceKey('openai', OPENAI_KEY);
    upstream.mockResolvedValue(upstreamJson(200, { value: 'ek_abc', expires_at: 1 }));
    await deviceBrokerFetch('/session', {
      method: 'POST',
      body: JSON.stringify({
        langPair: 'zh-TW→en',
        includeSourceTranscript: false,
        micDistance: 'off',
      }),
    });
    expect(JSON.parse(upstream.mock.calls[0]![1].body).session.audio).toEqual({
      input: {},
      output: { language: 'en' },
    });
  });

  it('rejects a malformed OpenAI request before spending a call', async () => {
    setDeviceKey('openai', OPENAI_KEY);
    const res = await deviceBrokerFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ langPair: 'fr→de' }),
    });
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes status and Retry-After through but never the upstream body', async () => {
    setDeviceKey('openai', OPENAI_KEY);
    upstream.mockResolvedValue(
      upstreamJson(
        429,
        { error: { message: `org-secret-detail ${OPENAI_KEY}` } },
        {
          'Retry-After': '7',
        },
      ),
    );
    const res = await deviceBrokerFetch('/session', { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    const text = await res.text();
    expect(text).not.toContain('org-secret-detail');
    expect(text).not.toContain(OPENAI_KEY);
  });

  it('mints a single-use Gemini token with the key in a header, not the URL', async () => {
    setDeviceKey('gemini', GEMINI_KEY);
    upstream.mockResolvedValue(upstreamJson(200, { name: 'auth_tokens/xyz' }));
    const res = await deviceBrokerFetch('/session/gemini', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({
      token: 'auth_tokens/xyz',
      model: 'models/gemini-3.5-live-translate-preview',
    });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(url).not.toContain(GEMINI_KEY);
    expect(init.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    const sent = JSON.parse(init.body);
    expect(sent.uses).toBe(1);
    expect(Date.parse(sent.newSessionExpireTime)).toBeLessThan(Date.parse(sent.expireTime));
  });

  it('maps a rejected Gemini key to 403 and an upstream 5xx to 502', async () => {
    setDeviceKey('gemini', GEMINI_KEY);
    upstream.mockResolvedValueOnce(upstreamJson(403, { error: 'denied' }));
    expect((await deviceBrokerFetch('/session/gemini', { method: 'POST' })).status).toBe(403);
    upstream.mockResolvedValueOnce(upstreamJson(503, {}));
    expect((await deviceBrokerFetch('/session/gemini', { method: 'POST' })).status).toBe(502);
  });

  it('turns a stalled upstream into 504 and aborts the request', async () => {
    vi.useFakeTimers();
    setDeviceKey('gemini', GEMINI_KEY);
    let aborted = false;
    upstream.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const pending = deviceBrokerFetch('/session/gemini', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(504);
    expect(aborted).toBe(true);
  });

  it('propagates a caller abort like a real fetch', async () => {
    setDeviceKey('gemini', GEMINI_KEY);
    upstream.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const pending = deviceBrokerFetch('/session/gemini', {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('answers unsupported service paths locally instead of hitting the network', async () => {
    setDeviceKey('openai', OPENAI_KEY);
    for (const path of ['/session/transcription', '/session/gemini/transcription', '/meetings']) {
      expect((await deviceBrokerFetch(path, { method: 'POST', body: '{}' })).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('transcriptText', () => {
  const segment = (segmentId: string, text: string) => ({ segmentId, text }) as CaptionSegment;
  const translations = {
    a: { targetText: '你好' } as CaptionTranslation,
  };
  it('puts the translation first and keeps untranslated speech', () => {
    const segments = [segment('a', 'Hello'), segment('b', 'No translation yet')];
    expect(transcriptText(segments, translations, true)).toBe('你好\nHello\n\nNo translation yet');
    expect(transcriptText(segments, translations, false)).toBe('你好\n\nNo translation yet');
  });
});

describe('friendlyError', () => {
  it('turns log-style failures into what to do next', () => {
    expect(friendlyError('OpenAI SDP exchange failed (401 ip_not_authorized)')).toContain('白名單');
    expect(friendlyError('gemini: unsupported; automatic retry unavailable')).toContain('金鑰');
    expect(friendlyError('openai translation: auth (HTTP 401)')).toContain('金鑰');
    expect(friendlyError('gemini: rate-limit (HTTP 429); automatic retry unavailable')).toContain(
      '限流',
    );
    expect(friendlyError('NotAllowedError: Permission denied')).toContain('麥克風權限');
    expect(friendlyError('gemini translation: network (HTTP 502)')).toContain('網路');
    expect(friendlyError('something new')).toBe('無法開始：something new');
  });
});

describe('resolveStartOrder', () => {
  it('tries preferred provider first and falls back to the other saved key', () => {
    expect(resolveStartOrder('openai', { openai: OPENAI_KEY, gemini: GEMINI_KEY })).toEqual([
      'openai',
      'gemini',
    ]);
    expect(resolveStartOrder('gemini', { openai: OPENAI_KEY, gemini: GEMINI_KEY })).toEqual([
      'gemini',
      'openai',
    ]);
    expect(resolveStartOrder('openai', { gemini: GEMINI_KEY })).toEqual(['gemini']);
    expect(resolveStartOrder('gemini', {})).toEqual([]);
  });
});
