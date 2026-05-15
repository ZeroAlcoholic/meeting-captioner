import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  ONLINE_PORT: 8787,
  ONLINE_CORS_ORIGIN: 'http://localhost:5173',
  OPENAI_TIMEOUT_MS: 10_000,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  SESSION_RENEW_MS: 25 * 60 * 1000,
}));

vi.mock('./config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import { _resetHealthForTests } from './routes/healthz.js';
import { _resetRateLimitForTests } from './routes/session.js';
import { buildApp } from './server.js';

beforeEach(() => {
  _resetHealthForTests();
  _resetRateLimitForTests();
  mockConfig.OPENAI_API_KEY = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('online service', () => {
  it('GET /healthz reports structured components when key present', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      service: string;
      version: string;
      components: { apiKey: string; openai_reachability: string };
    }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('online');
    expect(body.components.apiKey).toBe('configured');
    expect(body.components.openai_reachability).toBe('unknown');
    await app.close();
  });

  it('GET /healthz reports ok=false when key missing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; components: { apiKey: string } }>();
    expect(body.ok).toBe(false);
    expect(body.components.apiKey).toBe('missing');
    await app.close();
  });

  it('GET /session/info returns hasApiKey + renewal hint', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hasApiKey: boolean; sessionRenewalRecommendedMs: number }>();
    expect(body.hasApiKey).toBe(false);
    expect(body.sessionRenewalRecommendedMs).toBeGreaterThan(0);
    await app.close();
  });

  it('POST /session returns 503 when OPENAI_API_KEY absent', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
