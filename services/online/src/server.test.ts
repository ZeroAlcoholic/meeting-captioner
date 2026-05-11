import { describe, expect, it, vi } from 'vitest';

const mockSessionCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ client_secret: { value: 'tok', expires_at: 9999 } }),
);
const mockApiKey = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    beta: { realtime: { sessions: { create: mockSessionCreate } } },
  })),
}));

vi.mock('./config.js', () => ({
  config: {
    get OPENAI_API_KEY() {
      return mockApiKey.value;
    },
    ONLINE_PORT: 8787,
    ONLINE_CORS_ORIGIN: 'http://localhost:5173',
  },
}));

import { buildApp } from './server.js';

describe('online service', () => {
  it('GET /healthz returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; service: string }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('online');
    await app.close();
  });

  it('GET /session/info returns hasApiKey boolean', async () => {
    mockApiKey.value = undefined;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hasApiKey: boolean }>().hasApiKey).toBe(false);
    await app.close();
  });

  it('POST /session returns 503 when OPENAI_API_KEY absent', async () => {
    mockApiKey.value = undefined;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
