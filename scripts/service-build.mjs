import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { markBuild, pruneBuilds } from './service-build-retention.mjs';

const execute = promisify(execFile);

// Build into an immutable per-instance directory, never the currently served dist.
export async function prepareService(repo, stateDir, instanceId, signal) {
  signal?.throwIfAborted();
  const release = join(stateDir, 'builds', instanceId);
  const web = join(release, 'web');
  const bundle = join(release, 'server.cjs');
  await mkdir(release, { recursive: true });
  const builds = join(stateDir, 'builds');
  const createdAt = await markBuild(builds, instanceId, 'preparing');
  const require = createRequire(join(repo, 'package.json'));
  const webRequire = createRequire(join(repo, 'apps/web/package.json'));
  const tsc = require.resolve('typescript/bin/tsc');
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js');
  const env = { ...process.env, VITE_DEPLOYMENT_MODE: 'online', VITE_ONLINE_SERVICE_URL: '' };
  // Build tools do not need provider credentials.
  for (const name of Object.keys(env)) if (/(KEY|TOKEN|SECRET)/i.test(name)) delete env[name];
  for (const [cwd, args] of [
    [repo, [tsc, '-p', 'packages/contracts/tsconfig.json']],
    [repo, [tsc, '-p', 'apps/web/tsconfig.online.json']],
    [repo, [tsc, '-p', 'apps/web/tsconfig.node.json']],
    [repo, [tsc, '--noEmit', '-p', 'services/online/tsconfig.json']],
    [join(repo, 'apps/web'), [vite, 'build', '--outDir', web]],
    [join(repo, 'services/online'), ['build-bundle.mjs', '--managed-output', bundle]],
  ]) {
    const execution = execute(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    // Abort may reject before the owned process emits close. Do not release
    // workspace build ownership until its process and stdio have closed.
    const closed = new Promise((resolve) => execution.child.once('close', resolve));
    const result = await execution.finally(() => closed);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  const hash = createHash('sha256');
  async function include(path) {
    signal?.throwIfAborted();
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      hash.update(entry.name);
      if (entry.isDirectory()) await include(join(path, entry.name));
      else hash.update(await readFile(join(path, entry.name)));
    }
  }
  await include(release);
  await markBuild(builds, instanceId, 'ready', createdAt);
  try {
    await pruneBuilds(builds, instanceId);
  } catch (error) {
    // Disk retention must never block the caption service from starting.
    process.stderr.write(
      `[service] build retention skipped: ${error.message}. Old builds remain in ${builds}\n`,
    );
  }
  return { web, bundle, buildId: hash.digest('hex') };
}
