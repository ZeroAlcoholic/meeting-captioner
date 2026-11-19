import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_SUFFIX, markBuild, pruneBuilds } from './service-build-retention.mjs';

const scratch = fileURLToPath(new URL('../.tmp/service-build-retention-test/', import.meta.url));

async function buildsDir(t, name) {
  const dir = join(scratch, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function build(dir, id, state, createdAt) {
  await mkdir(join(dir, id, 'web'), { recursive: true });
  await writeFile(join(dir, id, 'server.cjs'), id);
  if (state) await markBuild(dir, id, state, createdAt);
}

test('keeps the newest ready builds and the current one; removes older ready and abandoned builds', async (t) => {
  const dir = await buildsDir(t, 'prune');
  await build(dir, 'a', 'ready', '2026-11-01T00:00:00.000Z');
  await build(dir, 'b', 'preparing', '2026-11-02T00:00:00.000Z'); // aborted
  await build(dir, 'c', 'ready', '2026-11-03T00:00:00.000Z'); // previous, may still serve
  await build(dir, 'd', 'ready', '2026-11-04T00:00:00.000Z'); // current
  assert.deepEqual(await pruneBuilds(dir, 'd'), ['a', 'b']);
  assert.deepEqual((await readdir(dir)).sort(), [
    'c',
    'c' + MARKER_SUFFIX,
    'd',
    'd' + MARKER_SUFFIX,
  ]);
});

test('never touches unmarked legacy builds (they may be cited as evidence)', async (t) => {
  const dir = await buildsDir(t, 'legacy');
  await build(dir, 'legacy-1', null);
  await build(dir, 'old', 'ready', '2026-11-01T00:00:00.000Z');
  await build(dir, 'prev', 'ready', '2026-11-02T00:00:00.000Z');
  await build(dir, 'now', 'ready', '2026-11-03T00:00:00.000Z');
  assert.deepEqual(await pruneBuilds(dir, 'now'), ['old']);
  assert.ok((await readdir(dir)).includes('legacy-1'));
});

test('a build being prepared is kept even when it is not among the newest ready builds', async (t) => {
  const dir = await buildsDir(t, 'current-preparing');
  await build(dir, 'x', 'ready', '2026-11-05T00:00:00.000Z');
  await build(dir, 'y', 'ready', '2026-11-06T00:00:00.000Z');
  await build(dir, 'cur', 'preparing', '2026-11-04T00:00:00.000Z');
  assert.deepEqual(await pruneBuilds(dir, 'cur'), []);
});

test('fails closed on markers it cannot trust', async (t) => {
  const dir = await buildsDir(t, 'bad');
  await writeFile(join(dir, 'z' + MARKER_SUFFIX), JSON.stringify({ state: 'odd', createdAt: 'x' }));
  await build(dir, 'keepme', 'ready', '2026-11-01T00:00:00.000Z');
  await assert.rejects(pruneBuilds(dir, 'keepme'), /Unknown build state/);
  await rm(join(dir, 'z' + MARKER_SUFFIX));
  await writeFile(join(dir, '..' + MARKER_SUFFIX), '{}');
  await assert.rejects(pruneBuilds(dir, 'keepme'), /Unsafe managed build id/);
  assert.ok((await readdir(dir)).includes('keepme'), 'nothing removed when a marker is rejected');
});

test('rejects unsafe ids and unknown states when marking', async (t) => {
  const dir = await buildsDir(t, 'mark');
  await assert.rejects(markBuild(dir, '../x', 'ready'), /Unsafe managed build id/);
  await assert.rejects(markBuild(dir, 'ok', 'done'), /Unknown build state/);
  assert.deepEqual(await readdir(dir), []);
});
