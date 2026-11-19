// Scratch directories for Playwright fixtures.
//
// Every directory lives under <repo>/.tmp/e2e/run-<runner pid>/. The runner
// and its workers agree on that id because Playwright forks workers from the
// runner (workers carry TEST_WORKER_INDEX; their parent is the runner). The
// first request in each process removes run directories whose runner has
// exited, so the newest finished run stays on disk for post-mortem while older
// runs cannot accumulate. Deleting at the end of a run instead would lose the
// evidence of a failed run and race SQLite workers that still hold files open.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = /^run-(\d+)$/;

export const defaultBase = fileURLToPath(new URL('../../.tmp/e2e/', import.meta.url));

export function currentRunId(env = process.env, pid = process.pid, ppid = process.ppid) {
  return env.TEST_WORKER_INDEX !== undefined ? ppid : pid;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM: the process exists but belongs to someone else.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function createE2eTemp({
  base = defaultBase,
  runId = currentRunId(),
  alive = processAlive,
} = {}) {
  let swept;

  async function sweepFinishedRuns() {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const removed = [];
    for (const entry of entries) {
      const match = entry.isDirectory() ? RUN.exec(entry.name) : null;
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === runId || alive(pid)) continue;
      // Two workers of one run may sweep the same directory at once.
      await rm(join(base, entry.name), { recursive: true, force: true, maxRetries: 3 });
      removed.push(entry.name);
    }
    return removed;
  }

  async function tempDir(prefix) {
    if (!/^[\w-]+$/.test(prefix)) throw new Error(`Invalid E2E temp prefix: ${prefix}`);
    swept ??= sweepFinishedRuns();
    await swept;
    const runDir = join(base, `run-${runId}`);
    await mkdir(runDir, { recursive: true });
    return mkdtemp(join(runDir, prefix));
  }

  return { tempDir, sweepFinishedRuns, runDir: join(base, `run-${runId}`) };
}

const shared = createE2eTemp();

/** Create a fresh scratch directory for the current Playwright run. */
export function e2eTempDir(prefix) {
  return shared.tempDir(prefix);
}
