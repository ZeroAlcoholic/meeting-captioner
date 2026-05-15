import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { registerHealthz } from './routes/healthz.js';
import { registerSession } from './routes/session.js';

export async function buildApp(): Promise<FastifyInstance> {
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

const SHUTDOWN_GRACE_MS = 5_000;

function installShutdownHandlers(app: FastifyInstance): void {
  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown signal received — closing server');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown exceeded timeout — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref?.();

    app.close().then(
      () => {
        app.log.info('server closed cleanly');
        clearTimeout(force);
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        clearTimeout(force);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const app = await buildApp();
  installShutdownHandlers(app);
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
