import type { FastifyInstance } from 'fastify';

export async function registerHealthz(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    ok: true,
    service: 'online',
    version: '0.0.0',
    timestamp: new Date().toISOString(),
  }));
}
