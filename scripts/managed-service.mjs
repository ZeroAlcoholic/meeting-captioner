import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const SERVICE = 'meeting-audio';
const PROTOCOL = 1;

async function savedOriginPort(root, workspaceId) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read saved service origin; preserve runtime.json for recovery', {
      cause: error,
    });
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('Invalid saved service origin receipt');
  if (!receipt.url && receipt.originPort == null) return null;
  if (
    receipt.service !== SERVICE ||
    receipt.protocol !== PROTOCOL ||
    receipt.workspaceId !== workspaceId
  )
    throw new Error('Saved service origin belongs to an unrecognized workspace');
  let port = receipt.originPort;
  if (port == null) {
    const url = new URL(receipt.url);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid saved service origin');
    port = Number(url.port);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid saved service origin port');
  return port;
}

async function address(root) {
  // Windows named pipes disappear with their owning process, including crashes.
  // Do not pretend filesystem sockets have the same stale-owner semantics.
  if (process.platform !== 'win32') throw new Error('Managed service requires Windows named pipes');
  const canonical = await realpath(root);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const workspaceId = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return {
    workspaceId,
    pipe: `\\\\.\\pipe\\meeting-audio-${workspaceId}`,
  };
}

// IPC is authoritative. runtime.json is a human-readable receipt, never a PID lock.
export async function requestService(root, message = { command: 'status' }) {
  let location;
  try {
    location = await address(root);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(location.pipe);
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('Service control timeout')));
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('error', (error) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(null);
      else reject(error);
    });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16_384) return socket.destroy(new Error('Invalid service control reply'));
      if (!data.includes('\n')) return;
      try {
        const state = JSON.parse(data.split('\n')[0]);
        if (
          state.service !== SERVICE ||
          state.protocol !== PROTOCOL ||
          state.workspaceId !== location.workspaceId
        )
          throw new Error('Service identity mismatch');
        resolve(state);
        socket.destroy();
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.on('end', () => {
      if (!data.includes('\n')) reject(new Error('Incomplete control reply'));
    });
  });
}

export async function runService({
  root,
  preferredPort = 43871,
  portWasExplicit = false,
  prepare,
  createApp,
  launchChild,
}) {
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535)
    throw new Error('Service port must be an integer from 0 to 65535');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const location = await address(root);
  const originPort = await savedOriginPort(root, location.workspaceId);
  if (portWasExplicit && originPort !== null && preferredPort !== originPort)
    throw new Error(
      `Origin migration required: retained port ${originPort}; pending data on the old origin is unknown until recovered. No port change was applied.`,
    );
  const state = {
    service: SERVICE,
    protocol: PROTOCOL,
    workspaceId: location.workspaceId,
    instanceId: randomUUID(),
    pid: process.pid,
    phase: 'building',
    startedAt: new Date().toISOString(),
    preferredPort,
    originPort,
    url: null,
    buildId: null,
    portFallback: false,
    restartIntent: true,
    restartCount: 0,
    childInstanceId: null,
    childPid: null,
    lastExit: null,
  };
  let app;
  const preparationAbort = new AbortController();
  let preparation = Promise.resolve();
  let child;
  let restartTimer;
  let wakeRestart;
  let monitor;
  let stopped = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const clients = new Set();
  let receiptWrite = Promise.resolve();
  const persist = () => {
    const receipt = JSON.stringify(state, null, 2) + '\n';
    // Stop and a child exit can arrive together. Publish receipts in order,
    // and let Stop await its final write before releasing the named pipe.
    receiptWrite = receiptWrite
      .catch(() => {})
      .then(async () => {
        const temporary = join(root, `runtime-${state.instanceId}.tmp`);
        await writeFile(temporary, receipt, { mode: 0o600 });
        await rename(temporary, join(root, 'runtime.json'));
      });
    return receiptWrite;
  };
  const control = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(2000, () => socket.destroy());
    socket.setEncoding('utf8');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) return socket.destroy();
      if (!data.includes('\n')) return;
      socket.removeAllListeners('data');
      let message;
      try {
        message = JSON.parse(data.split('\n')[0]);
        if (
          !message ||
          typeof message !== 'object' ||
          Array.isArray(message) ||
          !['status', 'stop'].includes(message.command)
        )
          throw new Error('Invalid command');
      } catch {
        socket.end(JSON.stringify({ ...state, error: 'Invalid command' }) + '\n');
        return;
      }
      if (message.command === 'status') socket.end(JSON.stringify(state) + '\n');
      else if (message.command === 'stop' && message.instanceId === state.instanceId && !stopped) {
        socket.end(JSON.stringify({ ...state, phase: 'stopping' }) + '\n', () => {
          void stop();
        });
      } else
        socket.end(
          JSON.stringify({ ...state, error: 'Identity mismatch or service is stopping' }) + '\n',
        );
    });
  });
  try {
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(location.pipe, () => {
        control.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
  async function stop() {
    if (stopped) return closed;
    stopped = true;
    preparationAbort.abort();
    state.restartIntent = false;
    clearTimeout(restartTimer);
    wakeRestart?.();
    clearInterval(monitor);
    if (state.phase !== 'failed') state.phase = 'stopping';
    await preparation.catch(() => {});
    await child?.stop();
    if (app) {
      const timer = setTimeout(() => app.server.closeAllConnections(), 5000);
      try {
        await app.close();
      } finally {
        clearTimeout(timer);
      }
    }
    if (state.phase !== 'failed') state.phase = 'stopped';
    // Persist before releasing ownership, so an old instance cannot overwrite a new receipt.
    try {
      await persist();
    } finally {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => control.close(resolve));
      resolveClosed();
    }
  }
  const ready = (async () => {
    try {
      await persist();
      if (stopped) return closed.then(() => ({ ...state }));
      preparation = Promise.resolve().then(() =>
        prepare(state.instanceId, preparationAbort.signal),
      );
      const prepared = await preparation;
      if (stopped) return closed.then(() => ({ ...state }));
      state.buildId = prepared.buildId;
      if (launchChild) {
        return await new Promise((resolve, reject) => {
          void supervise(prepared, resolve).catch(reject);
        });
      }
      app = await createApp(prepared);
      if (stopped) {
        await app.close();
        app = undefined;
        return closed.then(() => ({ ...state }));
      }
      app.get('/_meeting-audio/instance', (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { ...state };
      });
      try {
        await app.listen({ host: '127.0.0.1', port: state.originPort ?? preferredPort });
      } catch (error) {
        if (state.originPort !== null && ['EADDRINUSE', 'EACCES'].includes(error.code)) {
          const failure = new Error(
            `Saved service origin port ${state.originPort} is unavailable; no alternate origin was started`,
            { cause: error },
          );
          failure.code = 'STABLE_ORIGIN_UNAVAILABLE';
          throw failure;
        }
        if (!['EADDRINUSE', 'EACCES'].includes(error.code) || preferredPort === 0) throw error;
        state.portFallback = true;
        await app.listen({ host: '127.0.0.1', port: 0 });
      }
      if (stopped) return closed.then(() => ({ ...state }));
      state.url = `http://127.0.0.1:${app.server.address().port}`;
      state.originPort = app.server.address().port;
      state.phase = 'ready';
      await persist();
      return { ...state };
    } catch (error) {
      if (stopped) return closed.then(() => ({ ...state }));
      state.phase = 'failed';
      state.error =
        error.code === 'STABLE_ORIGIN_UNAVAILABLE'
          ? error.message
          : 'Build/start failed; see service.log';
      await stop();
      throw error;
    }
  })();
  return { ready, closed, stop };

  async function supervise(prepared, firstReady) {
    const restarts = [];
    while (!stopped && state.restartIntent) {
      state.childInstanceId = randomUUID();
      state.phase = state.restartCount ? 'restarting' : 'starting';
      const owned = launchChild({
        prepared,
        identity: { ...state },
        port: state.originPort ?? preferredPort,
        allowPortFallback: state.originPort === null,
      });
      child = owned;
      state.childPid = owned.pid;
      await persist();
      let lastExit;
      try {
        const listening = await owned.ready;
        if (stopped) break;
        state.originPort = listening.port;
        state.url = listening.url;
        state.portFallback = listening.portFallback;
        const response = await fetch(state.url + '/_meeting-audio/instance', {
          signal: AbortSignal.timeout(3000),
        });
        const identity = await response.json();
        if (
          !response.ok ||
          identity.instanceId !== state.instanceId ||
          identity.workspaceId !== state.workspaceId ||
          identity.buildId !== state.buildId ||
          identity.childInstanceId !== state.childInstanceId
        )
          throw new Error('Managed child HTTP identity mismatch');
        if (stopped) break;
        state.phase = 'ready';
        await persist();
        firstReady({ ...state });
        let checking = false;
        monitor = setInterval(async () => {
          if (checking || stopped) return;
          checking = true;
          try {
            if (!(await owned.ping())) await owned.stop();
          } finally {
            checking = false;
          }
        }, 2000);
        lastExit = await owned.exited;
      } catch (error) {
        await owned.stop();
        lastExit = { ...(await owned.exited), error: error.code ?? 'CHILD_START_FAILED' };
      } finally {
        clearInterval(monitor);
      }
      if (stopped) break;
      state.lastExit = { ...lastExit, at: new Date().toISOString() };
      state.childPid = null;
      const now = Date.now();
      while (restarts.length && restarts[0] <= now - 60_000) restarts.shift();
      if (restarts.length >= 3) {
        state.restartIntent = false;
        state.phase = 'failed';
        state.error =
          'Service recovery limit reached (3 restarts/60 seconds); stop and start explicitly to retry';
        await persist();
        firstReady({ ...state });
        return;
      }
      restarts.push(now);
      state.restartCount++;
      state.phase = 'restarting';
      await persist();
      await new Promise((resolve) => {
        wakeRestart = resolve;
        restartTimer = setTimeout(resolve, 1000);
      });
      wakeRestart = undefined;
    }
    firstReady({ ...state });
  }
}
