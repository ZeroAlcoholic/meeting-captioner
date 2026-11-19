import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createE2eTemp, currentRunId, defaultBase, processAlive } from './e2e-temp.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(repo, '.tmp', 'e2e-temp-test');

async function freshBase(t, name) {
  const base = join(scratch, name);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

test('default base stays inside the repository .tmp directory', () => {
  assert.equal(resolve(defaultBase), join(repo, '.tmp', 'e2e'));
});

test('workers share the runner id; the runner uses its own pid', () => {
  assert.equal(currentRunId({ TEST_WORKER_INDEX: '3' }, 10, 7), 7);
  assert.equal(currentRunId({}, 10, 7), 10);
});

test('process probe tells a live process from an exited one', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(deadPid()), false);
});

test('sweep removes runs whose runner exited and keeps live, own and unrelated entries', async (t) => {
  const base = await freshBase(t, 'sweep');
  const dead = deadPid();
  for (const name of [`run-${dead}`, `run-${process.pid}`, 'run-123', 'notes', 'run-abc'])
    await mkdir(join(base, name, 'inner'), { recursive: true });
  await writeFile(join(base, `run-${dead}`, 'inner', 'meetings.sqlite'), 'x');
  const temp = createE2eTemp({ base, runId: 123, alive: (pid) => pid === process.pid });
  assert.deepEqual(await temp.sweepFinishedRuns(), [`run-${dead}`]);
  assert.deepEqual(
    (await readdir(base)).sort(),
    ['notes', 'run-123', 'run-abc', `run-${process.pid}`].sort(),
  );
});

test('tempDir creates unique directories under the current run and sweeps once', async (t) => {
  const base = await freshBase(t, 'create');
  const dead = deadPid();
  await mkdir(join(base, `run-${dead}`), { recursive: true });
  let probes = 0;
  const temp = createE2eTemp({ base, runId: 42, alive: () => (probes++, false) });
  const a = await temp.tempDir('storage-fault-');
  const b = await temp.tempDir('storage-fault-');
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join(base, 'run-42', 'storage-fault-')));
  assert.deepEqual(await readdir(base), ['run-42']);
  assert.equal(probes, 1, 'only the first call sweeps');
});

test('tempDir rejects prefixes that could escape the run directory', async (t) => {
  const base = await freshBase(t, 'reject');
  const temp = createE2eTemp({ base, runId: 1, alive: () => true });
  await assert.rejects(temp.tempDir('../escape-'), /Invalid E2E temp prefix/);
  await assert.rejects(temp.tempDir('a/b-'), /Invalid E2E temp prefix/);
  assert.deepEqual(await readdir(base), []);
});

test('a missing base is not an error for the sweep', async () => {
  const temp = createE2eTemp({
    base: join(scratch, 'does-not-exist'),
    runId: 1,
    alive: () => true,
  });
  assert.deepEqual(await temp.sweepFinishedRuns(), []);
});
