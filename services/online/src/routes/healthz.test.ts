import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
}));

vi.mock('../config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import Fastify from 'fastify';
import { _resetHealthForTests, recordOpenAIReachability, registerHealthz } from './healthz.js';

beforeEach(() => {
  _resetHealthForTests();
  mockConfig.OPENAI_API_KEY = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('GET /healthz', () => {
  it('reports apiKey=missing and ok=false when no key configured', async () => {
    const app = Fastify({ logger: false });
    await registerHealthz(app);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      service: string;
      version: string;
      components: { apiKey: string; openai_reachability: string; uptime_sec: number };
    }>();
    expect(body.ok).toBe(false);
    expect(body.service).toBe('online');
    expect(body.version).toMatch(/^\d/);
    expect(body.components.apiKey).toBe('missing');
    expect(body.components.openai_reachability).toBe('unknown');
    expect(body.components.uptime_sec).toBeGreaterThanOrEqual(0);
  });

  it('reports apiKey=configured and ok=true when key present and no failures', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerHealthz(app);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ ok: boolean; components: { apiKey: string } }>();
    expect(body.ok).toBe(true);
    expect(body.components.apiKey).toBe('configured');
  });

  it('flips ok=false when last upstream call was degraded', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerHealthz(app);
    recordOpenAIReachability('degraded');
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{
      ok: boolean;
      components: { openai_reachability: string };
    }>();
    expect(body.ok).toBe(false);
    expect(body.components.openai_reachability).toBe('degraded');
  });

  it('recovers ok=true after a successful call following a degraded one', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = Fastify({ logger: false });
    await registerHealthz(app);
    recordOpenAIReachability('degraded');
    recordOpenAIReachability('ok');
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});
