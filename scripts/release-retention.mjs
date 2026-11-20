// Retention for packaged releases (release/<name>/ + release/<name>.zip).
//
// scripts/package-online.ps1 stages every package in a new timestamped
// directory, zips it and points the `meeting-audio-online` junction at the
// newest stage. Without retention each run adds a stage directory and a zip
// forever. The zip is the distributable artifact; a stage directory is only
// worth keeping while the junction points at it.
//
// A marker beside each package (<name>.release.json) records that this script
// created it. Only marked packages are touched: packages from before markers
// existed may be cited as evidence (docs name specific zips) and are never
// removed.
//
// Kept: the newest `keep` marked zips, and the stage directory of `current`.
// Removed: stage directories of other marked packages; whole packages (stage,
// zip, marker) beyond the newest `keep`.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER_SUFFIX = '.release.json';
// Timestamped package names only; the stable junction name never matches.
const PACKAGE_NAME = /^[\w-]+-\d{8}-\d{6}$/;

function assertPackageName(name) {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Unsafe release package name: ${name}`);
}

export async function markPackage(releaseDir, name, createdAt = new Date().toISOString()) {
  assertPackageName(name);
  await writeFile(join(releaseDir, name + MARKER_SUFFIX), JSON.stringify({ createdAt }));
  return createdAt;
}

export async function prunePackages(releaseDir, current, keep = 3) {
  assertPackageName(current);
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(`keep must be a positive integer: ${keep}`);
  const entries = await readdir(releaseDir);
  const present = new Set(entries);
  const marked = [];
  for (const entry of entries) {
    if (!entry.endsWith(MARKER_SUFFIX)) continue;
    const name = entry.slice(0, -MARKER_SUFFIX.length);
    assertPackageName(name);
    const marker = JSON.parse(await readFile(join(releaseDir, entry), 'utf8'));
    if (typeof marker.createdAt !== 'string') throw new Error(`Missing createdAt in ${entry}`);
    marked.push({ name, createdAt: marker.createdAt });
  }
  if (!marked.some((m) => m.name === current))
    throw new Error(`Current package ${current} has no marker; refusing to prune`);
  marked.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keepZip = new Set(marked.slice(0, keep).map((m) => m.name));
  keepZip.add(current);

  const removedStages = [];
  const removedPackages = [];
  for (const { name } of marked) {
    if (name === current) continue;
    // Stage directory first: a crash afterwards leaves a zip plus marker,
    // which is still a complete package.
    if (present.has(name)) {
      await rm(join(releaseDir, name), { recursive: true, force: true });
      removedStages.push(name);
    }
    if (keepZip.has(name)) continue;
    await rm(join(releaseDir, name + '.zip'), { force: true });
    await rm(join(releaseDir, name + MARKER_SUFFIX), { force: true });
    removedPackages.push(name);
  }
  return { removedStages: removedStages.sort(), removedPackages: removedPackages.sort() };
}

// CLI: node scripts/release-retention.mjs <releaseDir> <currentPackageName>
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [releaseDir, current] = process.argv.slice(2);
  if (!releaseDir || !current) {
    console.error('usage: release-retention.mjs <releaseDir> <currentPackageName>');
    process.exit(2);
  }
  try {
    await markPackage(releaseDir, current);
    const { removedStages, removedPackages } = await prunePackages(releaseDir, current);
    console.log(
      `release retention: removed ${removedStages.length} old stage dir(s), ` +
        `${removedPackages.length} old package(s)`,
    );
  } catch (error) {
    console.error(`release retention failed: ${error.message}`);
    console.error(
      'Nothing else was removed. Check release/*.release.json, then rerun this script.',
    );
    process.exit(1);
  }
}
