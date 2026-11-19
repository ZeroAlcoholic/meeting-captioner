import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launchServiceChild } from './service-child.mjs';
import { runService, requestService } from './managed-service.mjs';

async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail('condition deadline exceeded');
}

for (const outcome of ['stop', 'limit', 'hang', 'occupied', 'startup-crash', 'startup-stop']) {
  test(`workspace owner restarts one child on the same build/origin, then ${outcome}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-owner-test-'));
    let service;
    t.after(async () => {
      await service?.stop();
      assert.ok(root.startsWith(join(tmpdir(), 'meeting-owner-test-')));
      await rm(root, { recursive: true, force: true });
    });
    const require = createRequire(new URL('../services/online/package.json', import.meta.url));
    const bundle = join(root, 'server.cjs');
    await writeFile(
      bundle,
      `exports.buildApp = async () => {
      if (${JSON.stringify(outcome)} === 'startup-crash') process.exit(29);
      if (${JSON.stringify(outcome)} === 'startup-stop') {
        require('node:fs').writeFileSync(${JSON.stringify(join(root, 'starting'))}, 'entered');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const app = require(${JSON.stringify(require.resolve('fastify'))})({logger:false});
      app.get('/crash', async () => { setImmediate(() => process.exit(23)); return 'crash'; });
      app.get('/hang', async () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
      return app;
    };`,
    );
    let builds = 0;
    let launches = 0;
    const options = {
      root,
      preferredPort: 0,
      prepare: async () => {
        builds++;
        return { bundle, web: root, buildId: 'fixed-build' };
      },
      launchChild: (args) => {
        launches++;
        return launchServiceChild(args);
      },
    };
    service = await runService(options);
    if (outcome === 'startup-stop') {
      await until(
        async () => (await readFile(join(root, 'starting'), 'utf8').catch(() => '')) === 'entered',
      );
      const state = await requestService(root);
      assert.equal(state.phase, 'starting');
      await requestService(root, { command: 'stop', instanceId: state.instanceId });
      await service.closed;
      assert.equal((await service.ready).phase, 'stopped');
      await delay(2200);
      assert.equal(launches, 1);
      assert.equal(await requestService(root), null);
      assert.throws(() => process.kill(state.childPid, 0), { code: 'ESRCH' });
      return;
    }
    const first = await service.ready;
    if (outcome === 'startup-crash') {
      assert.equal(first.phase, 'failed');
      assert.equal(first.lastExit.code, 29);
      assert.equal(first.restartCount, 3);
      assert.equal(first.restartIntent, false);
      assert.equal(launches, 4);
      assert.equal(builds, 1);
      assert.equal(first.url, null);
      return;
    }
    assert.equal(first.phase, 'ready');
    assert.equal(await runService(options), null);
    if (outcome === 'hang') {
      const request = fetch(first.url + '/hang', { signal: AbortSignal.timeout(15_000) }).catch(
        () => {},
      );
      const recovered = await until(async () => {
        const state = await requestService(root);
        return state?.phase === 'ready' && state.childInstanceId !== first.childInstanceId
          ? state
          : null;
      }, 15_000);
      await request;
      assert.equal(recovered.url, first.url);
      assert.equal(recovered.buildId, first.buildId);
      assert.equal(recovered.instanceId, first.instanceId);
      assert.equal(recovered.lastExit.signal, 'SIGTERM');
      assert.equal(recovered.restartCount, 1);
      assert.equal(builds, 1);
      assert.equal(launches, 2);
      assert.equal((await fetch(first.url + '/_meeting-audio/instance')).status, 200);
      return;
    }
    if (outcome === 'occupied') {
      await fetch(first.url + '/crash').catch(() => {});
      await until(async () => (await requestService(root))?.phase === 'restarting');
      let requests = 0;
      const foreign = createServer((_request, response) => {
        requests++;
        response.end('foreign');
      });
      t.after(() => new Promise((resolve) => foreign.close(resolve)));
      await new Promise((resolve, reject) => {
        foreign.once('error', reject);
        foreign.listen(first.originPort, '127.0.0.1', resolve);
      });
      const failed = await until(async () => {
        const state = await requestService(root);
        return state?.phase === 'failed' ? state : null;
      });
      assert.equal(failed.url, first.url);
      assert.equal(failed.restartCount, 3);
      assert.equal(failed.lastExit.error, 'EADDRINUSE');
      assert.equal(requests, 0, 'owner must not probe or send data to the foreign listener');
      await service.stop();
      assert.equal(await (await fetch(first.url)).text(), 'foreign');
      assert.equal(builds, 1);
      assert.equal(launches, 4);
      return;
    }
    let current = first;
    for (let crash = 1; crash <= (outcome === 'limit' ? 4 : 2); crash++) {
      await fetch(current.url + '/crash').catch(() => {});
      if (outcome === 'stop' && crash === 2) {
        await until(async () => (await requestService(root))?.phase === 'restarting');
        await requestService(root, { command: 'stop', instanceId: first.instanceId });
        await service.closed;
        const before = launches;
        await delay(1300);
        assert.equal(launches, before);
        assert.equal(await requestService(root), null);
        break;
      }
      const oldChild = current.childInstanceId;
      current = await until(async () => {
        const state = await requestService(root);
        return state?.phase === 'failed' ||
          (state?.phase === 'ready' && state.childInstanceId !== oldChild)
          ? state
          : null;
      });
      assert.equal(current.url, first.url);
      assert.equal(current.buildId, first.buildId);
      assert.equal(current.instanceId, first.instanceId);
      if (crash < 4) assert.equal(current.phase, 'ready');
    }
    if (outcome === 'limit') {
      assert.equal(current.phase, 'failed');
      assert.equal(current.restartCount, 3);
      assert.equal(current.restartIntent, false);
      assert.equal(launches, 4);
    }
    assert.equal(builds, 1);
  });
}

test('healthy HTTP child exits when its owning process dies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-owner-death-'));
  const require = createRequire(new URL('../services/online/package.json', import.meta.url));
  const bundle = join(root, 'server.cjs');
  await writeFile(
    bundle,
    `exports.buildApp = async () => require(${JSON.stringify(require.resolve('fastify'))})({logger:false});`,
  );
  const source = `
    import { runService } from ${JSON.stringify(new URL('./managed-service.mjs', import.meta.url).href)};
    import { launchServiceChild } from ${JSON.stringify(new URL('./service-child.mjs', import.meta.url).href)};
    const service = await runService({ root: ${JSON.stringify(root)}, preferredPort: 0,
      prepare: async () => ({bundle:${JSON.stringify(bundle)},web:${JSON.stringify(root)},buildId:'owner-death'}),
      launchChild: launchServiceChild });
    console.log(JSON.stringify(await service.ready));
  `;
  const entry = join(root, 'owner.mjs');
  await writeFile(entry, source);
  const owner = spawn(process.execPath, [entry], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(owner, 'exit');
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    await exited;
    assert.ok(root.startsWith(join(tmpdir(), 'meeting-owner-death-')));
    await rm(root, { recursive: true, force: true });
  });
  let output = '';
  let errors = '';
  owner.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  owner.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await until(() => output.includes('\n'));
  const state = JSON.parse(output.split('\n')[0]);
  assert.equal(state.phase, 'ready', errors);
  {
    const identity = await (await fetch(state.url + '/_meeting-audio/instance')).json();
    assert.equal(identity.childPid, state.childPid);
  }
  owner.kill();
  await exited;
  await until(() => {
    try {
      process.kill(state.childPid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  });
  assert.equal(await requestService(root), null);
  await assert.rejects(fetch(state.url, { signal: AbortSignal.timeout(1000) }));
});

test('owned HTTP child reports identity, exits on crash and stops a hung event loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-child-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) await child.stop();
    assert.ok(root.startsWith(join(tmpdir(), 'meeting-child-test-')));
    await rm(root, { recursive: true, force: true });
  });
  const require = createRequire(new URL('../services/online/package.json', import.meta.url));
  const bundle = join(root, 'server.cjs');
  await writeFile(
    bundle,
    `
    exports.buildApp = async () => {
      const app = require(${JSON.stringify(require.resolve('fastify'))})({logger:false});
      app.get('/crash', async () => { setImmediate(() => process.exit(23)); return 'crashing'; });
      app.get('/hang', async () => { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'hung'))}, 'entered'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
      return app;
    };
  `,
  );
  const options = {
    prepared: { bundle, web: root, buildId: 'unchanged-build' },
    identity: {
      service: 'meeting-audio',
      protocol: 1,
      workspaceId: 'fixture',
      instanceId: 'owner',
      childInstanceId: 'child-1',
      buildId: 'unchanged-build',
    },
    port: 0,
    allowPortFallback: true,
  };
  const first = launchServiceChild(options);
  children.push(first);
  const ready = await first.ready;
  assert.notEqual(first.pid, process.pid);
  const identity = await (await fetch(ready.url + '/_meeting-audio/instance')).json();
  assert.equal(identity.workspaceId, 'fixture');
  assert.equal(identity.instanceId, 'owner');
  assert.equal(identity.childInstanceId, 'child-1');
  assert.equal(identity.buildId, 'unchanged-build');
  assert.equal(await first.ping(), true);
  await fetch(ready.url + '/crash').catch(() => {});
  assert.equal((await first.exited).code, 23);
  const second = launchServiceChild({
    ...options,
    port: ready.port,
    allowPortFallback: false,
    identity: { ...options.identity, childInstanceId: 'child-2' },
  });
  children.push(second);
  assert.equal((await second.ready).url, ready.url);
  const hung = fetch(ready.url + '/hang', { signal: AbortSignal.timeout(8000) }).catch(() => {});
  const until = Date.now() + 3000;
  while ((await readFile(join(root, 'hung'), 'utf8').catch(() => '')) !== 'entered') {
    assert.ok(Date.now() < until, 'child must enter actual blocking handler');
    await delay(20);
  }
  assert.equal(await second.ping(), false);
  await second.stop();
  await hung;
  assert.equal((await second.exited).signal, 'SIGTERM');
  await assert.rejects(fetch(ready.url, { signal: AbortSignal.timeout(1000) }));
});
