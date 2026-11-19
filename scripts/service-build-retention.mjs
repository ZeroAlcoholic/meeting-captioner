// Retention for managed-service builds (builds/<instanceId>/).
//
// Each start builds into a new immutable directory and nothing reads an old
// one again, so without retention the directory grows on every start. A marker
// file beside each build (<instanceId>.managed-build) records who created it
// and whether it finished. Retention only touches marked builds: directories
// from before markers existed may be cited as evidence and are never removed.
// The marker sits beside the build, not inside, because prepareService hashes
// the build directory to derive buildId.
//
// Kept: the newest `keep` ready builds (the new one plus the build the previous
// child may still be serving during hand-over) and the build being prepared.
// Removed: older ready builds and abandoned (aborted) preparations.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MARKER_SUFFIX = '.managed-build';
const SAFE_ID = /^[\w-]+$/;

function assertSafeId(instanceId) {
  if (!SAFE_ID.test(instanceId)) throw new Error(`Unsafe managed build id: ${instanceId}`);
}

export async function markBuild(
  buildsDir,
  instanceId,
  state,
  createdAt = new Date().toISOString(),
) {
  assertSafeId(instanceId);
  if (state !== 'preparing' && state !== 'ready') throw new Error(`Unknown build state: ${state}`);
  await writeFile(
    join(buildsDir, instanceId + MARKER_SUFFIX),
    JSON.stringify({ state, createdAt }),
  );
  return createdAt;
}

export async function pruneBuilds(buildsDir, current, keep = 2) {
  assertSafeId(current);
  const markers = [];
  for (const name of await readdir(buildsDir)) {
    if (!name.endsWith(MARKER_SUFFIX)) continue;
    const instanceId = name.slice(0, -MARKER_SUFFIX.length);
    assertSafeId(instanceId);
    const marker = JSON.parse(await readFile(join(buildsDir, name), 'utf8'));
    if (marker.state !== 'preparing' && marker.state !== 'ready')
      throw new Error(`Unknown build state in ${name}: ${marker.state}`);
    if (typeof marker.createdAt !== 'string') throw new Error(`Missing createdAt in ${name}`);
    markers.push({ instanceId, ...marker });
  }
  const ready = markers
    .filter((m) => m.state === 'ready')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = new Set([current, ...ready.slice(0, keep).map((m) => m.instanceId)]);
  const removed = [];
  for (const { instanceId } of markers) {
    if (kept.has(instanceId)) continue;
    // Directory first: a crash in between leaves a marker without a build,
    // which the next prune removes, never a build without a marker.
    await rm(join(buildsDir, instanceId), { recursive: true, force: true });
    await rm(join(buildsDir, instanceId + MARKER_SUFFIX), { force: true });
    removed.push(instanceId);
  }
  return removed.sort();
}
