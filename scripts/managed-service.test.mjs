import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runService, requestService } from './managed-service.mjs';

const require = createRequire(new URL('../services/online/package.json', import.meta.url));
const Fastify = require('fastify');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'meeting-service-test-'));
  const services = [];
  t.after(async () => {
    for (const service of services) await service.stop();
    assert.ok(root.startsWith(join(tmpdir(), 'meeting-service-test-')));
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    root,
    preferredPort: 0,
    prepare: async () => ({ buildId: 'test-build' }),
    createApp: async () => {
      const app = Fastify({ logger: false });
      app.get('/', () => 'real local HTTP');
      return app;
    },
  };
  return { root, options, track: (service) => services.push(service) };
}

test('concurrent starts have one owner; status and HTTP agree; wrong identity cannot stop it', async (t) => {
  const { root, options, track } = await fixture(t);
  let builds = 0;
  options.prepare = async () => {
    builds++;
    return { buildId: 'test-build' };
  };
  const started = await Promise.all([runService(options), runService(options)]);
  const owned = started.filter(Boolean);
  assert.equal(owned.length, 1);
  const service = owned[0];
  track(service);
  await service.ready;
  assert.equal(builds, 1);
  const state = await requestService(root);
  assert.equal(state.phase, 'ready');
  assert.equal(state.buildId, 'test-build');
  const identity = await (await fetch(state.url + '/_meeting-audio/instance')).json();
  assert.equal(identity.instanceId, state.instanceId);
  assert.equal(identity.workspaceId, state.workspaceId);
  const rejected = await requestService(root, { command: 'stop', instanceId: 'wrong' });
  assert.match(rejected.error, /identity/i);
  assert.equal((await fetch(state.url)).status, 200);
  await requestService(root, { command: 'stop', instanceId: state.instanceId });
  await service.closed;
  assert.equal(await requestService(root), null);
});

for (const stage of ['prepare', 'createApp']) {
  test(`owned Stop during ${stage} prevents a late HTTP service from starting`, async (t) => {
    const { root, options, track } = await fixture(t);
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let listens = 0;
    let closes = 0;
    options.prepare = async (_instanceId, signal) => {
      if (stage === 'prepare') {
        entered();
        assert.ok(signal instanceof AbortSignal);
        await Promise.race([
          gate,
          new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
      }
      return { buildId: 'test-build' };
    };
    options.createApp = async () => {
      const app = Fastify({ logger: false });
      const listen = app.listen.bind(app);
      app.listen = (...args) => {
        listens++;
        return listen(...args);
      };
      app.addHook('onClose', async () => {
        closes++;
      });
      if (stage === 'createApp') {
        entered();
        await gate;
      }
      return app;
    };
    const service = await runService(options);
    track(service);
    try {
      await started;
      const state = await requestService(root);
      assert.equal(state.phase, 'building');
      const reply = await requestService(root, { command: 'stop', instanceId: state.instanceId });
      assert.equal(reply.error, undefined);
      await service.closed;
      release();
      const final = await service.ready;
      assert.equal(final.phase, 'stopped');
      assert.equal(listens, 0);
      assert.equal(closes, stage === 'createApp' ? 1 : 0);
      assert.equal(await requestService(root), null);
      assert.equal(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).phase, 'stopped');
    } finally {
      release();
      await service.ready.catch(() => {});
    }
  });
}

test('occupied preferred port is untouched and OS selects a different port', async (t) => {
  const { root, options, track } = await fixture(t);
  const foreign = createServer((socket) => socket.end('foreign service'));
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  options.preferredPort = foreign.address().port;
  const service = await runService(options);
  track(service);
  await service.ready;
  const state = await requestService(root);
  assert.notEqual(new URL(state.url).port, String(options.preferredPort));
  assert.equal(state.portFallback, true);
  await service.stop();
  assert.equal(foreign.listening, true);
});

test('a stale PID/status file cannot impersonate an owner', async (t) => {
  const { root, options, track } = await fixture(t);
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ pid: process.pid, phase: 'ready' }));
  assert.equal(await requestService(root), null);
  const service = await runService(options);
  track(service);
  await service.ready;
  assert.equal((await requestService(root)).phase, 'ready');
});

test('restart preserves its first origin and refuses an occupied pinned port', async (t) => {
  const { options, track } = await fixture(t);
  const first = await runService(options);
  track(first);
  const initial = await first.ready;
  await first.stop();
  const second = await runService(options);
  track(second);
  assert.equal((await second.ready).url, initial.url);
  await second.stop();
  await assert.rejects(
    runService({ ...options, portWasExplicit: true }),
    /Origin migration required/,
  );
  let foreignConnections = 0;
  const foreign = createServer((socket) => {
    foreignConnections++;
    socket.end();
  });
  await new Promise((resolve) =>
    foreign.listen(Number(new URL(initial.url).port), '127.0.0.1', resolve),
  );
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const blocked = await runService(options);
  track(blocked);
  await assert.rejects(blocked.ready, /origin|port/i);
  await blocked.closed;
  assert.equal(foreign.listening, true);
  assert.equal(foreignConnections, 0);
  await new Promise((resolve) => foreign.close(resolve));
  const recovered = await runService(options);
  track(recovered);
  assert.equal((await recovered.ready).url, initial.url);
});

test('adopts the last legacy URL without treating its PID as ownership', async (t) => {
  const { root, options, track } = await fixture(t);
  const first = await runService(options);
  track(first);
  const initial = await first.ready;
  await first.stop();
  const receipt = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  delete receipt.originPort;
  receipt.pid = -1;
  await writeFile(join(root, 'runtime.json'), JSON.stringify(receipt));
  const adopted = await runService(options);
  track(adopted);
  assert.equal((await adopted.ready).url, initial.url);
});

test('invalid saved origin is preserved instead of silently choosing another URL', async (t) => {
  const { root, options } = await fixture(t);
  const path = join(root, 'runtime.json');
  for (const damaged of ['{damaged receipt', 'null', '[]']) {
    await writeFile(path, damaged);
    await assert.rejects(runService(options), /saved service origin/i);
    assert.equal(await readFile(path, 'utf8'), damaged);
    assert.equal(await requestService(root), null);
  }
});

test('failed preparation releases ownership and a later start succeeds', async (t) => {
  const { root, options, track } = await fixture(t);
  const failed = await runService({
    ...options,
    prepare: async () => {
      throw new Error('build failed');
    },
  });
  await assert.rejects(failed.ready, /build failed/);
  await failed.closed;
  assert.equal(await requestService(root), null);
  const service = await runService(options);
  track(service);
  await service.ready;
  assert.equal((await requestService(root)).phase, 'ready');
});

test('malformed IPC values do not crash an active service', async (t) => {
  const { root, options, track } = await fixture(t);
  const service = await runService(options);
  track(service);
  const state = await service.ready;
  for (const payload of [null, [], 42, 'status', {}]) {
    assert.match((await requestService(root, payload)).error, /Invalid command/);
    assert.equal((await fetch(state.url)).status, 200);
  }
  assert.equal((await requestService(root)).instanceId, state.instanceId);
});

test('Windows releases ownership after a process crash despite its stale manifest', async (t) => {
  const { root, options, track } = await fixture(t);
  const source = `
    import { runService } from ${JSON.stringify(new URL('./managed-service.mjs', import.meta.url).href)};
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(new URL('../services/online/package.json', import.meta.url).href)});
    const service = await runService({
      root: ${JSON.stringify(root)}, preferredPort: 0,
      prepare: async () => ({ buildId: 'crash-fixture' }),
      createApp: async () => require('fastify')({ logger: false })
    });
    console.log(JSON.stringify(await service.ready));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exit;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const old = await requestService(root);
  assert.equal(old.phase, 'ready');
  child.kill();
  await exit;
  assert.equal(await requestService(root), null);
  const replacement = await runService(options);
  track(replacement);
  const current = await replacement.ready;
  assert.notEqual(current.instanceId, old.instanceId);
  assert.equal((await requestService(root.toUpperCase())).instanceId, current.instanceId);
});
