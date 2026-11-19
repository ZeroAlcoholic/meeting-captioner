import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** One owned process handle; callers never terminate a PID discovered from a file or port. */
export function launchServiceChild(options) {
  const child = fork(fileURLToPath(import.meta.url), ['runtime'], {
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let resolveReady, rejectReady, resolveExit;
  let ended = false;
  let stopping;
  let pingSequence = 0;
  const pings = new Map();
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const deadline = setTimeout(() => {
    rejectReady(new Error('Managed child startup timed out'));
    child.kill();
  }, 30_000);
  function finish(code, signal, error) {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    rejectReady(error ?? new Error('Managed child exited before readiness'));
    for (const finishPing of pings.values()) finishPing(false);
    resolveExit({ code, signal });
  }
  child.once('error', (error) => finish(null, null, error));
  child.once('exit', (code, signal) => finish(code, signal));
  child.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(deadline);
      resolveReady(message);
    } else if (message?.type === 'failed') {
      rejectReady(Object.assign(new Error(message.error), { code: message.code }));
    } else if (message?.type === 'pong') pings.get(message.sequence)?.(true);
  });
  const send = (message) => {
    if (!child.connected || ended) return false;
    child.send(message, (error) => {
      if (error) rejectReady(error);
    });
    return true;
  };
  send({ type: 'start', ...options });
  return {
    pid: child.pid,
    ready,
    exited,
    ping() {
      if (ended || stopping) return Promise.resolve(false);
      return new Promise((resolve) => {
        const sequence = ++pingSequence;
        const finishPing = (healthy) => {
          clearTimeout(timer);
          pings.delete(sequence);
          resolve(healthy);
        };
        const timer = setTimeout(() => finishPing(false), 1000);
        pings.set(sequence, finishPing);
        if (!send({ type: 'ping', sequence })) finishPing(false);
      });
    },
    stop() {
      stopping ??= (async () => {
        if (ended) return;
        send({ type: 'stop' });
        const timer = setTimeout(() => child.kill(), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      })();
      return stopping;
    },
  };
}

async function serveChild() {
  if (!process.send) throw new Error('Managed child requires an owning IPC channel');
  let app;
  let started = false;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const timer = setTimeout(() => process.exit(0), 5000);
    try {
      await app?.close();
    } finally {
      clearTimeout(timer);
      process.exit(process.exitCode ?? 0);
    }
  };
  process.once('disconnect', () => {
    void stop();
  });
  process.on('message', async (message) => {
    if (message?.type === 'stop') return void stop();
    if (message?.type === 'ping')
      return process.send?.({ type: 'pong', sequence: message.sequence });
    if (message?.type !== 'start' || started || stopped) return;
    started = true;
    try {
      const { prepared, identity, port, allowPortFallback } = message;
      process.env.ONLINE_HOST = '127.0.0.1';
      process.env.ONLINE_PORT = String(port || 43871);
      process.env.WEB_DIST_PATH = prepared.web;
      process.env.LOG_FORMAT = 'json';
      const require = createRequire(import.meta.url);
      app = await require(prepared.bundle).buildApp({
        sameOriginOnly: true,
        serviceIdentity: { workspaceId: identity.workspaceId, buildId: identity.buildId },
      });
      if (stopped) return;
      let url;
      app.get('/_meeting-audio/instance', (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { ...identity, phase: 'ready', url, childPid: process.pid };
      });
      let portFallback = false;
      try {
        await app.listen({ host: '127.0.0.1', port });
      } catch (error) {
        if (!allowPortFallback || !['EADDRINUSE', 'EACCES'].includes(error.code) || port === 0)
          throw error;
        portFallback = true;
        await app.listen({ host: '127.0.0.1', port: 0 });
      }
      const actualPort = app.server.address().port;
      url = `http://127.0.0.1:${actualPort}`;
      process.send?.({ type: 'ready', url, port: actualPort, portFallback });
    } catch (error) {
      process.send?.({
        type: 'failed',
        code: error.code,
        error: 'Managed child could not start; inspect service.log',
      });
      await app?.close().catch(() => {});
      process.exitCode = 1;
      process.disconnect();
    }
  });
}

if (process.argv[2] === 'runtime') await serveChild();
