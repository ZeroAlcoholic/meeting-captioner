// Capacity gate for generated workspace directories.
//
// Scratch, evidence and packages used to grow unnoticed until the workspace
// held gigabytes (docs/disk_bloat_audit_2026-11-19.md, R7). Each budgeted
// directory has a byte limit; going over fails the gate with the largest
// entries listed, so the growth is seen when it happens.
//
// Links are not followed: release/meeting-audio-online is a junction to a stage
// directory that is already counted, and following links could leave the
// workspace. A directory that does not exist counts as empty; any other read
// error fails the gate instead of reporting a smaller number.
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MB = 1024 * 1024;

export const BUDGETS = {
  // Evidence runs (--output=.cache/<name>) keep failure traces of 10-25 MB each.
  '.cache': 400 * MB,
  // E2E scratch keeps the newest finished run (tests/e2e/e2e-temp.mjs).
  '.tmp': 1024 * MB,
  // Retention keeps three package zips and the current stage directory.
  release: 200 * MB,
};

async function sizeOf(path) {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return { bytes: 0, files: 0, traces: 0, traceBytes: 0 };
  if (!st.isDirectory()) {
    const trace = path.endsWith('trace.zip');
    return { bytes: st.size, files: 1, traces: trace ? 1 : 0, traceBytes: trace ? st.size : 0 };
  }
  const total = { bytes: 0, files: 0, traces: 0, traceBytes: 0 };
  for (const name of await readdir(path)) {
    const sub = await sizeOf(join(path, name));
    for (const key of Object.keys(total)) total[key] += sub[key];
  }
  return total;
}

export async function measureDir(dir, topN = 5) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: 0, files: 0, traces: 0, traceBytes: 0, top: [] };
    throw error;
  }
  const total = { bytes: 0, files: 0, traces: 0, traceBytes: 0 };
  const children = [];
  for (const name of names) {
    const sub = await sizeOf(join(dir, name));
    for (const key of Object.keys(total)) total[key] += sub[key];
    children.push({ name, bytes: sub.bytes });
  }
  children.sort((a, b) => b.bytes - a.bytes);
  return { ...total, top: children.slice(0, topN) };
}

export async function checkCapacity(root, budgets = BUDGETS) {
  const rows = [];
  for (const [rel, budget] of Object.entries(budgets)) {
    if (!Number.isFinite(budget) || budget <= 0)
      throw new Error(`Invalid budget for ${rel}: ${budget}`);
    const m = await measureDir(resolve(root, rel));
    rows.push({ dir: rel, budget, ...m, over: m.bytes > budget });
  }
  return { ok: rows.every((r) => !r.over), rows };
}

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

export function formatReport({ ok, rows }) {
  const lines = [];
  for (const r of rows) {
    lines.push(
      `${r.over ? 'OVER' : 'ok  '} ${r.dir.padEnd(8)} ${mb(r.bytes).padStart(10)} / ${mb(r.budget)}` +
        ` (${r.files} files${r.traces ? `, ${r.traces} trace.zip = ${mb(r.traceBytes)}` : ''})`,
    );
    if (r.over)
      for (const c of r.top) lines.push(`       ${mb(c.bytes).padStart(10)}  ${r.dir}/${c.name}`);
  }
  if (!ok)
    lines.push(
      '',
      'Workspace capacity exceeded. Do this instead of raising the budget:',
      '  - .cache: once a run has its verdict, delete its trace.zip files; keep logs, JSON and screenshots.',
      '  - .tmp: remove finished scratch; E2E keeps only the newest run (tests/e2e/e2e-temp.mjs).',
      '  - release: rerun scripts/release-retention.mjs, or remove unmarked old packages nobody cites.',
      '  Check that docs do not cite a path before deleting it. See docs/RUNBOOK.md (workspace capacity).',
    );
  return lines.join('\n');
}

// CLI: node scripts/workspace-capacity.mjs [repoRoot]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
  try {
    const result = await checkCapacity(root);
    console.log(formatReport(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`workspace capacity check failed: ${error.message}`);
    process.exit(2);
  }
}
