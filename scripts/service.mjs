import { spawn } from 'node:child_process';
import { open, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { requestService, runService } from './managed-service.mjs';
import { prepareService } from './service-build.mjs';
import { launchServiceChild } from './service-child.mjs';

const script = fileURLToPath(import.meta.url);
if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) {
  console.error('The managed launcher requires Windows and Node.js 22 or newer.');
  process.exit(1);
}
const repo = await realpath(join(dirname(script), '..'));
const root = join(repo, '.cache', 'meeting-service');
const command = process.argv[2] ?? 'status';
const portArg = process.argv.slice(3).find((arg) => arg.startsWith('--port='));
const port = portArg ? Number(portArg.slice(7)) : 43871;
if (
  !Number.isInteger(port) ||
  port < 0 ||
  port > 65535 ||
  process.argv.slice(3).some((arg) => arg !== portArg)
) {
  console.error('Usage: node scripts/service.mjs start|status|stop [--port=43871]');
  process.exit(1);
}
const print = (state) => console.log(JSON.stringify(state, null, 2));

async function main() {
  if (command === 'host') {
    const service = await runService({
      root,
      preferredPort: port,
      portWasExplicit: !!portArg,
      prepare: (instanceId, signal) => prepareService(repo, root, instanceId, signal),
      launchChild: launchServiceChild,
    });
    if (!service) return; // Another host already owns this workspace, including its build.
    const state = await service.ready;
    print(state);
    process.once('SIGINT', () => {
      void service.stop();
    });
    process.once('SIGTERM', () => {
      void service.stop();
    });
    await service.closed;
    return;
  }
  if (!['start', 'status', 'stop'].includes(command))
    throw new Error('Expected start, status or stop');
  let state = await requestService(root);
  if (command === 'status') {
    print(state ?? { service: 'meeting-audio', phase: 'stopped' });
    return;
  }
  if (command === 'stop') {
    if (!state) {
      print({ service: 'meeting-audio', phase: 'stopped' });
      return;
    }
    const reply = await requestService(root, { command: 'stop', instanceId: state.instanceId });
    if (reply?.error) throw new Error(reply.error);
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      const current = await requestService(root);
      if (!current || current.instanceId !== state.instanceId) {
        print({ service: 'meeting-audio', instanceId: state.instanceId, phase: 'stopped' });
        return;
      }
      await delay(100);
    }
    throw new Error('Stop not confirmed; no unrelated PID was terminated');
  }
  const reused = !!state;
  let child;
  let exited = false;
  if (!state) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const log = await open(join(root, 'service.log'), 'a', 0o600);
    try {
      child = spawn(process.execPath, [script, 'host', ...(portArg ? [portArg] : [])], {
        cwd: repo,
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      child.on('exit', () => {
        exited = true;
      });
      child.on('error', () => {
        exited = true;
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    state = await requestService(root);
    if (state?.phase === 'failed')
      throw new Error(state.error ?? 'Managed service recovery failed');
    if (state?.phase === 'ready') {
      const response = await fetch(state.url + '/_meeting-audio/instance', {
        signal: AbortSignal.timeout(3000),
      });
      const identity = await response.json();
      if (
        identity.instanceId !== state.instanceId ||
        identity.workspaceId !== state.workspaceId ||
        identity.buildId !== state.buildId
      )
        throw new Error('HTTP service identity mismatch');
      print({ ...state, reused });
      return;
    }
    if (!state && exited)
      throw new Error('Service startup failed; see .cache/meeting-service/service.log');
    await delay(200);
  }
  throw new Error(
    'Service startup deadline exceeded; inspect status and .cache/meeting-service/service.log',
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
