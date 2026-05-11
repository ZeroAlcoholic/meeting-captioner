import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.post('/session', async () => {
    return {
      stub: true,
      message:
        'P0 stub. P2 will issue an OpenAI Realtime client_secret here. ' +
        'OPENAI_API_KEY must remain server-side only.',
      hasApiKey: Boolean(config.OPENAI_API_KEY),
    };
  });
}
