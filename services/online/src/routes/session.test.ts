import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSessionCreate = vi.hoisted(() => vi.fn());
const mockApiKey = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    beta: { realtime: { sessions: { create: mockSessionCreate } } },
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    get OPENAI_API_KEY() {
      return mockApiKey.value;
    },
  },
}));

import Fastify from 'fastify';
import { registerSession } from './session.js';

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
    const fakeSecret = { value: 'ephemeral-token-xyz', expires_at: 9999999999 };
    mockSessionCreate.mockResolvedValueOnce({ client_secret: fakeSecret });
    mockApiKey.value = 'sk-real-secret-do-not-leak';

    const app = Fastify({ logger: false });
    await registerSession(app);
    const res = await app.inject({ method: 'POST', url: '/session' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ client_secret: { value: string; expires_at: number } }>();
    expect(body.client_secret).toEqual(fakeSecret);
    expect(JSON.stringify(body)).not.toContain('sk-real-secret-do-not-leak');
  });

  it('calls sessions.create with correct model, transcription, and turn_detection config', async () => {
    mockSessionCreate.mockResolvedValueOnce({ client_secret: { value: 'tok', expires_at: 9999 } });
    mockApiKey.value = 'sk-test';

    const app = Fastify({ logger: false });
    await registerSession(app);
    await app.inject({ method: 'POST', url: '/session' });

    expect(mockSessionCreate).toHaveBeenCalledOnce();
    const arg = mockSessionCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg['model']).toBe('gpt-4o-realtime-preview-2024-12-17');
    expect(arg['input_audio_transcription']).toMatchObject({ model: 'whisper-1' });
    expect(arg['turn_detection']).toMatchObject({ type: 'server_vad' });
    expect(arg['modalities']).toContain('audio');
    expect(arg['modalities']).toContain('text');
  });
});
