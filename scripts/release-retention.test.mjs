import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_SUFFIX, markPackage, prunePackages } from './release-retention.mjs';

const scratch = fileURLToPath(new URL('../.tmp/release-retention-test/', import.meta.url));

async function releaseDir(t, name) {
  const dir = join(scratch, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pkg(dir, name, createdAt) {
  await mkdir(join(dir, name, 'web'), { recursive: true });
  await writeFile(join(dir, name, 'start.bat'), name);
  await writeFile(join(dir, name + '.zip'), name);
  if (createdAt) await markPackage(dir, name, createdAt);
}

const n = (i) => `meeting-audio-online-2026112${i}-120000`;

test('keeps the newest zips and only the current stage; removes older packages', async (t) => {
  const dir = await releaseDir(t, 'prune');
  for (let i = 1; i <= 5; i++) await pkg(dir, n(i), `2026-11-2${i}T12:00:00.000Z`);
  const result = await prunePackages(dir, n(5), 3);
  assert.deepEqual(result.removedPackages, [n(1), n(2)]);
  assert.deepEqual(result.removedStages, [n(1), n(2), n(3), n(4)]);
  assert.deepEqual((await readdir(dir)).sort(), [
    n(3) + MARKER_SUFFIX,
    n(3) + '.zip',
    n(4) + MARKER_SUFFIX,
    n(4) + '.zip',
    n(5),
    n(5) + MARKER_SUFFIX,
    n(5) + '.zip',
  ]);
  // A second run has nothing left to remove and must say so.
  assert.deepEqual(await prunePackages(dir, n(5), 3), { removedStages: [], removedPackages: [] });
});

test('never touches unmarked legacy packages or the stable junction name', async (t) => {
  const dir = await releaseDir(t, 'legacy');
  await pkg(dir, 'meeting-audio-continuity-20261002-162000', null);
  await mkdir(join(dir, 'meeting-audio-online'));
  await pkg(dir, n(1), '2026-11-21T12:00:00.000Z');
  await pkg(dir, n(2), '2026-11-22T12:00:00.000Z');
  await prunePackages(dir, n(2), 1);
  const left = await readdir(dir);
  for (const name of [
    'meeting-audio-continuity-20261002-162000',
    'meeting-audio-continuity-20261002-162000.zip',
    'meeting-audio-online',
  ])
    assert.ok(left.includes(name), `${name} kept`);
  assert.ok(!left.includes(n(1) + '.zip'));
});

test('fails closed: unmarked current, bad marker, unsafe names, bad keep', async (t) => {
  const dir = await releaseDir(t, 'bad');
  await pkg(dir, n(1), '2026-11-21T12:00:00.000Z');
  await pkg(dir, n(2), null);
  await assert.rejects(prunePackages(dir, n(2)), /has no marker/);
  await assert.rejects(prunePackages(dir, n(1), 0), /keep must be/);
  await assert.rejects(prunePackages(dir, '../x'), /Unsafe release package name/);
  await assert.rejects(markPackage(dir, 'meeting-audio-online'), /Unsafe release package name/);
  await writeFile(join(dir, n(3) + MARKER_SUFFIX), '{}');
  await assert.rejects(prunePackages(dir, n(1)), /Missing createdAt/);
  const left = await readdir(dir);
  assert.ok(left.includes(n(1)) && left.includes(n(1) + '.zip'), 'nothing removed on rejection');
});
