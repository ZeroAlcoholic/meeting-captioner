import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCapacity, formatReport, measureDir } from './workspace-capacity.mjs';

const scratch = fileURLToPath(new URL('../.tmp/workspace-capacity-test/', import.meta.url));

async function workspace(t, name) {
  const dir = join(scratch, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function file(path, bytes) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes));
}

test('passes under budget and fails over budget, naming the largest entries', async (t) => {
  const root = await workspace(t, 'budget');
  await file(join(root, '.cache', 'small', 'a.log'), 100);
  await file(join(root, '.cache', 'big', 'run', 'trace.zip'), 5000);
  await file(join(root, 'release', 'x.zip'), 100);

  const under = await checkCapacity(root, { '.cache': 10_000, release: 1000 });
  assert.equal(under.ok, true);

  const over = await checkCapacity(root, { '.cache': 1000, release: 1000 });
  assert.equal(over.ok, false);
  const cache = over.rows.find((r) => r.dir === '.cache');
  assert.equal(cache.over, true);
  assert.equal(cache.traces, 1);
  assert.equal(cache.traceBytes, 5000);
  assert.equal(cache.top[0].name, 'big');
  assert.equal(over.rows.find((r) => r.dir === 'release').over, false);
  assert.match(formatReport(over), /OVER \.cache[\s\S]*\.cache\/big[\s\S]*delete its trace\.zip/);
});

test('a missing directory counts as empty', async (t) => {
  const root = await workspace(t, 'missing');
  const result = await checkCapacity(root, { release: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].bytes, 0);
});

test('does not follow junctions or symlinks', async (t) => {
  const root = await workspace(t, 'links');
  await file(join(root, 'release', 'pkg-1', 'big.bin'), 4000);
  await symlink(join(root, 'release', 'pkg-1'), join(root, 'release', 'latest'), 'junction');
  const m = await measureDir(join(root, 'release'));
  assert.equal(m.bytes, 4000);
  assert.equal(m.files, 1);
});

test('fails closed on invalid budgets and unreadable roots', async (t) => {
  const root = await workspace(t, 'invalid');
  await assert.rejects(checkCapacity(root, { '.cache': 0 }), /Invalid budget/);
  await assert.rejects(checkCapacity(root, { '.cache': Number.NaN }), /Invalid budget/);
  await file(join(root, 'not-a-dir'), 10);
  await assert.rejects(measureDir(join(root, 'not-a-dir')), /ENOTDIR/);
});
