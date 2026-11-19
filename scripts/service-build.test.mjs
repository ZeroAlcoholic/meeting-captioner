import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareService } from './service-build.mjs';

test('aborting preparation closes the actual build subprocess before settling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-build-cancel-'));
  const abort = new AbortController();
  let preparation;
  t.after(async () => {
    abort.abort();
    await preparation?.catch(() => {});
    assert.ok(root.startsWith(join(tmpdir(), 'meeting-build-cancel-')));
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'build-pid');
  await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true });
  await mkdir(join(root, 'node_modules/vite'), { recursive: true });
  await mkdir(join(root, 'apps/web'), { recursive: true });
  for (const name of ['package.json', 'apps/web/package.json', 'node_modules/vite/package.json'])
    await writeFile(join(root, name), '{}');
  // A real Node subprocess stands in for a build tool; it must terminate via
  // its owned handle, not a discovered PID. The self-exit bounds the red test.
  await writeFile(
    join(root, 'node_modules/typescript/bin/tsc'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => process.exit(2), 3000);`,
  );
  preparation = prepareService(root, join(root, 'state'), 'fixture-build', abort.signal);
  const result = preparation.then(
    () => null,
    (error) => error,
  );
  const deadline = Date.now() + 2000;
  let pid;
  while (!(pid = Number(await readFile(marker, 'utf8').catch(() => '')))) {
    assert.ok(Date.now() < deadline, 'build subprocess must start');
    await delay(20);
  }
  abort.abort();
  const error = await result;
  assert.equal(error?.name, 'AbortError');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
