import { describe, expect, it } from 'vitest';
import { buildApp } from './server.js';

describe('online service', () => {
  it('GET /healthz returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('online');
    await app.close();
  });

  it('POST /session returns stub payload', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stub).toBe(true);
    expect(typeof body.hasApiKey).toBe('boolean');
    await app.close();
  });
});
