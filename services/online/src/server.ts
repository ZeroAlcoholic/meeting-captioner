import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config } from './config.js';
import { registerHealthz } from './routes/healthz.js';
import { registerSession } from './routes/session.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: { target: 'pino-pretty', options: { colorize: true } },
    },
  });

  await app.register(cors, {
    origin: config.ONLINE_CORS_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });

  await registerHealthz(app);
  await registerSession(app);

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: config.ONLINE_PORT, host: '0.0.0.0' });
    app.log.info(`online service ready on :${config.ONLINE_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (isDirectRun) {
  void main();
}
