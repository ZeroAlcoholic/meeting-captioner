import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { nativeSoakMinutes } from './native-soak.js';

// Exercise the same bundled server + production web layout as the slim release.
// Build first; no inherited provider credentials and no real upstream requests.
export default async function setup() {
  const stops: Array<() => Promise<void>> = [];
  const stop = async () => {
    await Promise.all(stops.map((close) => close()));
  };
  try {
    // Each parallel browser needs its own real SQLite writer lease. Never
    // bypass the production single-writer guard to run independent meetings.
    stops.push(await startFixture('.cache/native-audio-release', 5208, 5209));
    if (nativeSoakMinutes)
      stops.push(await startFixture('.cache/native-audio-release-openai', 5210, 5211));
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startFixture(directory: string, proxyPort: number, serverPort: number) {
  const root = resolve(directory);
  await mkdir(resolve(root, 'server/dist'), { recursive: true });
  await cp(
    'services/online/dist/server.bundle.cjs',
    resolve(root, 'server/dist/server.bundle.cjs'),
  );
  await cp(
    'services/online/dist/meeting-writer.worker.cjs',
    resolve(root, 'server/dist/meeting-writer.worker.cjs'),
  );
  // Test-only fault injection in the isolated copy, never the shipped bundle.
  const faultFile = resolve(root, 'storage-fault');
  await rm(faultFile, { force: true });
  await rm(faultFile + '.log', { force: true });
  // The directory is fixed so its ports and paths stay stable, but meetings
  // from earlier runs are never read again; keeping them only grows the disk.
  await rm(resolve(root, 'meeting-data'), { recursive: true, force: true });
  const workerPath = resolve(root, 'server/dist/meeting-writer.worker.cjs');
  const banner = `{
    const fs = require('node:fs');
    const sqlite = require('node:sqlite');
    const NativeDatabase = sqlite.DatabaseSync;
    const flag = ${JSON.stringify(faultFile)};
    sqlite.DatabaseSync = class extends NativeDatabase {
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE' && fs.existsSync(flag)) {
          const mode = fs.readFileSync(flag, 'utf8');
          fs.appendFileSync(flag + '.log', JSON.stringify({mode, at: Date.now()}) + '\\n');
          if (mode === 'hang') {
            fs.unlinkSync(flag);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          } else if (mode === 'slow') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          }
        }
        return super.exec(sql);
      }
    };
  }\n`;
  await writeFile(workerPath, banner + (await readFile(workerPath, 'utf8')));
  await cp('apps/web/dist', resolve(root, 'web'), { recursive: true });
  const child = spawn(process.execPath, [resolve(root, 'server/dist/server.bundle.cjs')], {
    cwd: root,
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      ONLINE_HOST: '127.0.0.1',
      ONLINE_PORT: String(serverPort),
      WEB_DIST_PATH: resolve(root, 'web'),
      MEETING_DATA_DIR: resolve(root, 'meeting-data'),
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  let workletRequests = 0;
  let failNextWorklet = false;
  let delayNextWorklet = false;
  // Playwright routing does not intercept Chrome AudioWorklet's module fetch.
  // A loopback-only proxy injects one real HTTP 503 for the selected test.
  const proxy = createServer((req, res) => {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/_native-test/arm-worklet-failure' && req.method === 'POST') {
      workletRequests = 0;
      failNextWorklet = true;
      res.end('armed');
      return;
    }
    if (path === '/_native-test/arm-worklet-delay' && req.method === 'POST') {
      workletRequests = 0;
      delayNextWorklet = true;
      res.end('armed');
      return;
    }
    if (path === '/_native-test/worklet-count') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ requests: workletRequests }));
      return;
    }
    if (path === '/pcm-worklet.js') {
      workletRequests += 1;
      if (failNextWorklet) {
        failNextWorklet = false;
        res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('Injected transient worklet HTTP failure');
        return;
      }
    }
    const forward = () => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    };
    if (path === '/pcm-worklet.js' && delayNextWorklet) {
      delayNextWorklet = false;
      setTimeout(forward, 6_500);
    } else forward();
  });
  const stop = async () => {
    console.info('[native-release] teardown: closing proxy');
    if (proxy.listening) {
      const closed = new Promise<void>((done) => proxy.close(() => done()));
      proxy.closeAllConnections();
      await closed;
    }
    console.info('[native-release] teardown: stopping owned server', child.pid);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    console.info('[native-release] teardown: complete');
  };
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Release server exited: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/healthz`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) break;
      } catch {
        /* wait for the owned child to listen */
      }
      if (Date.now() >= deadline) throw new Error(`Release server did not start: ${output}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    proxy.listen(proxyPort, '127.0.0.1');
    await once(proxy, 'listening');
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}
