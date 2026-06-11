import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { registerHealthz } from './routes/healthz.js';
import { registerSession } from './routes/session.js';
import { registerTranslate } from './routes/translate.js';
import { registerGemini } from './routes/gemini.js';

// pino-pretty is great for dev console output but causes trouble in the
// bundled slim release (pino loads it via a worker thread that resolves
// modules from the file system, which fails inside an esbuild bundle).
// The release launcher sets LOG_FORMAT=json so the server falls back to
// plain JSON logs (also more parseable for log shipping). Source-run
// (`pnpm dev`) defaults to pretty.
function buildLoggerConfig() {
  const format = (process.env.LOG_FORMAT ?? 'pretty').toLowerCase();
  if (format === 'json') return { level: 'info' };
  return {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } },
  };
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerConfig(),
  });

  // Negotiated response compression. The slim build's web bundle is 1.36 MB
  // raw / ~545 KB gzipped — a 60% saving on every initial page load, which
  // matters once the user puts ONLINE_HOST=0.0.0.0 to caption from a LAN
  // peer. We restrict to gzip + br to keep the bundle small (no need for
  // deflate / identity). The 1 KB threshold skips tiny payloads where the
  // overhead would dominate.
  await app.register(fastifyCompress, {
    encodings: ['br', 'gzip'],
    threshold: 1024,
  });

  await app.register(cors, {
    origin: config.ONLINE_CORS_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });

  await registerHealthz(app);
  await registerSession(app);
  await registerTranslate(app);
  await registerGemini(app);

  // Slim-distribution mode: when WEB_DIST_PATH is set, serve apps/web/dist as
  // static files so the entire stack runs from one process on one port.
  // Skipped during dev — Vite owns the SPA on :5173 and CORS bridges to here.
  if (config.WEB_DIST_PATH) {
    const root = resolvePath(process.cwd(), config.WEB_DIST_PATH);
    if (!existsSync(root)) {
      app.log.warn({ root }, 'WEB_DIST_PATH does not exist — static serving disabled');
    } else {
      await app.register(fastifyStatic, { root, prefix: '/', wildcard: false });
      // SPA fallback so deep links / refresh on a client route still resolve
      // to index.html. Constraints:
      //   - GET only (POST /session must keep its 404 if mistyped)
      //   - Exclude API prefixes (/session, /healthz) — never mask them
      //   - Exclude any path whose final segment has a file extension. This
      //     catches /assets/missing.js, /favicon.ico, /sitemap.xml, etc. —
      //     a missing asset must return a real 404, otherwise the browser
      //     treats the fallback HTML as JS / image / map / etc. and either
      //     SyntaxErrors or shows a warning. Verified in Phase D: previously
      //     /favicon.ico returned 768 bytes of index.html.
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== 'GET') {
          return reply.code(404).send({ error: 'Not found' });
        }
        const urlPath = req.url.split('?', 1)[0] ?? req.url;
        if (urlPath.startsWith('/session') || urlPath.startsWith('/healthz') || urlPath.startsWith('/translate')) {
          return reply.code(404).send({ error: 'Not found' });
        }
        const lastSegment = urlPath.split('/').pop() ?? '';
        const looksLikeStaticFile = /\.[A-Za-z0-9]{1,8}$/.test(lastSegment);
        if (looksLikeStaticFile) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html');
      });
      app.log.info({ root }, 'Static web served at /');
    }
  }

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
    await app.listen({ port: config.ONLINE_PORT, host: config.ONLINE_HOST });
    app.log.info(`online service ready on :${config.ONLINE_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// `import.meta` is only available in ESM; in the bundled CJS release we use
// a build-time flag instead. The detection covers: direct run via tsx (dev),
// `node dist/server.js` (built but not bundled), and the bundled CJS file
// in the release.
declare const __SERVER_BUNDLED__: boolean;
const ranAsBundle = typeof __SERVER_BUNDLED__ !== 'undefined' && __SERVER_BUNDLED__;
const argvScript = process.argv[1] ?? '';
const isDirectRun =
  ranAsBundle ||
  argvScript.endsWith('server.ts') ||
  argvScript.endsWith('server.js') ||
  argvScript.endsWith('server.bundle.cjs');

if (isDirectRun) {
  void main();
}
