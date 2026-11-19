import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { copyFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Worker } from 'node:worker_threads';
import { MeetingRepository } from './meeting-repository.js';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

let workerPath: string;
let workerDir: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  workerDir = await mkdtemp(join(tmpdir(), 'archive-worker-'));
  workerPath = join(workerDir, 'worker.cjs');
  await build({
    entryPoints: ['src/storage/meeting-writer.worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
  });
});
afterAll(async () => {
  await rm(workerDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const meetingId = randomUUID();
const writerId = randomUUID();
function event(text = '原始 approve', revision = 1) {
  return {
    schemaVersion: 1 as const,
    meetingId,
    writerId,
    eventId: randomUUID(),
    connectionId: null,
    observedAt: new Date().toISOString(),
    monotonicMs: 1,
    revision,
    payload: {
      kind: 'transcript' as const,
      provider: 'openai' as const,
      mode: 'online_full' as const,
      source: 'microphone' as const,
      segmentId: 'segment-1',
      status: 'final' as const,
      text,
      rawText: '原始 approve',
      startMs: 0,
      endMs: 1000,
    },
  };
}
async function setup(selectedWorkerPath = workerPath) {
  const dataDir = await mkdtemp(join(tmpdir(), 'meeting-archive-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const repo = new MeetingRepository({ dataDir, workerPath: selectedWorkerPath });
  cleanup.push(() => repo.close());
  await repo.createMeeting({
    meetingId,
    title: '測試',
    createdAt: new Date().toISOString(),
    captionTask: {
      purpose: 'transcription',
      inputLanguages: ['zh-tw', 'en'],
      textPolicy: 'zh-TW-preserve-original',
    },
  });
  return { repo, dataDir };
}
describe('durable meeting archive with actual SQLite worker', () => {
  it('commits a caller restore identity once and never reapplies that identity over later content', async () => {
    const { repo } = await setup();
    await repo.commitEvents([event('saved source')]);
    const backupId = basename(dirname(await repo.backup()));
    const generation = randomUUID();
    await repo.restoreBackup(backupId, generation);
    expect(await repo.archiveGeneration()).toBe(generation);
    await repo.commitEvents([event('later content', 2)]);
    const after = await repo.snapshot(meetingId);
    await expect(repo.restoreBackup(backupId, generation)).rejects.toThrow(
      'ARCHIVE_RESTORE_ALREADY_APPLIED',
    );
    expect(await repo.snapshot(meetingId)).toEqual(after);
    const failedGeneration = randomUUID();
    await expect(repo.restoreBackup('backup-' + randomUUID(), failedGeneration)).rejects.toThrow();
    expect(await repo.archiveGeneration()).toBe(generation);
  });
  it('refuses a second upload and restore while streaming, then admits operations after disconnect', async () => {
    const { repo, dataDir } = await setup();
    let failUpload!: () => void;
    const gate = new Promise<void>((resolve) => {
      failUpload = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stream = Readable.from(
      (async function* () {
        entered();
        yield Buffer.from('partial');
        await gate;
        throw new Error('upload disconnected');
      })(),
    );
    const upload = repo.importBackup(stream, '{}');
    const rejected = expect(upload).rejects.toThrow('upload disconnected');
    try {
      await started;
      await expect(repo.importBackup(Readable.from([]), '{}')).rejects.toThrow('ARCHIVE_BUSY');
      await expect(repo.restoreBackup('backup-' + randomUUID())).rejects.toThrow('ARCHIVE_BUSY');
    } finally {
      failUpload();
      await rejected;
    }
    expect((await readdir(dataDir)).filter((name) => name.startsWith('import-'))).toEqual([]);
    await expect(repo.importBackup(Readable.from([]), '{}')).rejects.toThrow(
      'ARCHIVE_BACKUP_EMPTY',
    );
    await repo.commitEvents([event()]);
    expect((await repo.snapshot(meetingId)).segments).toHaveLength(1);
  });
  it('imports streamed backup artifacts without changing live data and removes rejected uploads', async () => {
    const { repo, dataDir } = await setup();
    await repo.commitEvents([event('backup source')]);
    const path = await repo.backup();
    const manifest = await readFile(join(dirname(path), 'manifest.json'), 'utf8');
    const bytes = await readFile(path);
    await repo.commitEvents([event('live revision', 2)]);
    const live = await repo.snapshot(meetingId);
    const backupId = await repo.importBackup(
      Readable.from([bytes.subarray(0, 32), bytes.subarray(32)]),
      manifest,
    );
    expect(await readFile(await repo.backupFile(backupId, 'meetings.sqlite'))).toEqual(bytes);
    expect(await repo.snapshot(meetingId)).toEqual(live);
    await expect(
      repo.importBackup(Readable.from([Buffer.from('corrupt')]), manifest),
    ).rejects.toThrow('ARCHIVE_BACKUP_HASH_MISMATCH');
    await expect(
      repo.importBackup(
        Readable.from(
          (async function* () {
            yield bytes.subarray(0, 32);
            throw new Error('upload disconnected');
          })(),
        ),
        manifest,
      ),
    ).rejects.toThrow('upload disconnected');
    expect((await readdir(dataDir)).filter((name) => name.startsWith('import-'))).toEqual([]);
    expect(await repo.snapshot(meetingId)).toEqual(live);
    await repo.restoreBackup(backupId);
    expect((await repo.snapshot(meetingId)).segments[0]?.text).toBe('backup source');
    expect(repo.diagnosticError).toBeNull();
  });
  it('records backup and generation operations without false diagnostic failures', async () => {
    const { repo } = await setup();
    const path = await repo.backup();
    const id = basename(dirname(path));
    await repo.backupFile(id, 'manifest.json');
    expect(repo.diagnosticError).toBeNull();
    await repo.restoreBackup(id);
    expect(repo.diagnosticError).toBeNull();
    await repo.archiveGeneration();
    expect(repo.diagnosticError).toBeNull();
  });
  it('keeps permanent storage loss after finalization, later edits and worker restart', async () => {
    const { repo, dataDir } = await setup();
    const gap = {
      gapId: randomUUID(),
      meetingId,
      trackId: 'storage',
      captureEpoch: writerId,
      state: 'unrecoverable' as const,
      alignment: 'estimated' as const,
      cause: 'memory_limit',
      wallClock: { startAt: '2026-10-15T00:00:00.000Z', endAt: '2026-10-15T00:01:00.000Z' },
      storageLoss: { lostCount: 2 },
    };
    const input = { pendingCount: 0, gaps: [gap], unfinishedTurns: [] };
    expect(await repo.finalize(meetingId, input)).toMatchObject({ saved: false, lostCount: 2 });
    await repo.finalize(meetingId, input);
    const { storageLoss: _loss, ...withoutLoss } = gap;
    await repo.finalize(meetingId, { ...input, gaps: [withoutLoss] });
    await repo.commitEvents([event()]);
    await repo.close();
    const reopened = new MeetingRepository({ dataDir, workerPath });
    cleanup.push(() => reopened.close());
    expect(await reopened.finalize(meetingId, { ...input, gaps: [] })).toMatchObject({
      saved: false,
      lostCount: 2,
      unsavedSince: gap.wallClock.startAt,
      unsavedUntil: gap.wallClock.endAt,
    });
    const exported = JSON.parse(await reopened.export(meetingId, 'corrected', 'json'));
    expect(exported.metadata.finalized).toBe(false);
    expect(exported.metadata.manifest.lostCount).toBe(2);
  });
  it('survives restart and idempotently acknowledges immutable event IDs', async () => {
    const { repo, dataDir } = await setup();
    const first = event();
    await repo.commitEvents([first]);
    await repo.close();
    const reopened = new MeetingRepository({ dataDir, workerPath });
    cleanup.push(() => reopened.close());
    expect((await reopened.commitEvents([first])).committedEventIds).toEqual([first.eventId]);
    expect((await reopened.snapshot(meetingId)).events).toHaveLength(1);
    await expect(
      reopened.commitEvents([{ ...first, payload: { ...first.payload, text: 'changed' } }]),
    ).rejects.toThrow('EVENT_ID_CONFLICT');
    const logs = await readdir(join(dataDir, 'diagnostics'));
    const diagnostic = (
      await Promise.all(logs.map((name) => readFile(join(dataDir, 'diagnostics', name), 'utf8')))
    ).join('');
    expect(diagnostic).toContain('commitEvents');
    expect(diagnostic).toContain('EVENT_ID_CONFLICT');
    expect(diagnostic).not.toContain(first.payload.text);
  });
  it('rolls back the whole batch on a stale revision', async () => {
    const { repo } = await setup();
    await repo.commitEvents([event()]);
    await expect(repo.commitEvents([event('next', 2), event('stale', 1)])).rejects.toThrow(
      'REVISION_CONFLICT',
    );
    const snapshot = await repo.snapshot(meetingId);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.segments[0].text).toBe('原始 approve');
  });
  it('preserves originals and rejects stale human edits', async () => {
    const { repo, dataDir } = await setup();
    await repo.commitEvents([event()]);
    const correction = {
      ...event('', 2),
      payload: {
        kind: 'correction' as const,
        segmentId: 'segment-1',
        text: '校訂',
        baseRevision: 1,
        editor: 'user',
        source: 'human' as const,
        editedAt: new Date().toISOString(),
      },
    };
    await repo.commitEvents([correction]);
    await expect(
      repo.commitEvents([{ ...correction, eventId: randomUUID(), revision: 3 }]),
    ).rejects.toThrow('REVISION_CONFLICT');
    const snapshot = await repo.snapshot(meetingId);
    expect(snapshot.segments[0]).toMatchObject({
      text: '校訂',
      originalText: '原始 approve',
      revision: 2,
    });
    expect(snapshot.events[0].payload).toMatchObject({ rawText: '原始 approve' });
    expect(await repo.export(meetingId, 'original', 'txt')).toBe('原始 approve');
    expect(await repo.export(meetingId, 'corrected', 'txt')).toBe('校訂');
    await repo.refreshExports(meetingId);
    expect(await readFile(join(dataDir, 'exports', meetingId, 'corrected.txt'), 'utf8')).toBe(
      '校訂',
    );
    expect(
      (await repo.finalize(meetingId, { pendingCount: 1, gaps: [], unfinishedTurns: [] })).saved,
    ).toBe(false);
    expect(
      (await repo.finalize(meetingId, { pendingCount: 0, gaps: [], unfinishedTurns: [] })).saved,
    ).toBe(true);
  });
  it('rejects oversized batches and restores a consistent backup', async () => {
    const { repo } = await setup();
    await expect(repo.commitEvents(Array.from({ length: 101 }, () => event()))).rejects.toThrow(
      'BATCH_LIMIT',
    );
    await repo.commitEvents([event()]);
    const backupPath = await repo.backup();
    expect(backupPath).toMatch(/\.sqlite$/);
    const manifest = JSON.parse(await readFile(join(dirname(backupPath), 'manifest.json'), 'utf8'));
    expect(manifest).toEqual({
      formatVersion: 1,
      schemaVersion: 1,
      createdAt: expect.any(String),
      databaseSha256: createHash('sha256')
        .update(await readFile(backupPath))
        .digest('hex'),
      meetingCount: 1,
      eventCount: 1,
    });
    expect(Number.isFinite(Date.parse(manifest.createdAt))).toBe(true);
    const before = await repo.snapshot(meetingId);
    await repo.commitEvents([event('備份後修訂', 2)]);
    const restoredDir = await mkdtemp(join(tmpdir(), 'archive-restore-'));
    cleanup.push(() => rm(restoredDir, { recursive: true, force: true }));
    await copyFile(backupPath, join(restoredDir, 'meetings.sqlite'));
    const restored = new MeetingRepository({ dataDir: restoredDir, workerPath });
    cleanup.push(() => restored.close());
    expect(await restored.snapshot(meetingId)).toEqual(before);
  });
  it('preserves both meetings, 20100 segments, translations, revisions and gaps in the backup snapshot', async () => {
    const { repo } = await setup();
    const secondId = randomUUID();
    const originalMetadata = (await repo.snapshot(meetingId)).meeting;
    await repo.createMeeting({ ...originalMetadata, meetingId: secondId, title: '第二場' });
    for (const id of [meetingId, secondId]) {
      for (let offset = 0; offset < 10050; offset += 50) {
        const batch = Array.from({ length: 50 }, (_, index) => {
          const segmentId = 'segment-' + (offset + index);
          const source = event('原稿 ' + segmentId);
          return [
            { ...source, meetingId: id, payload: { ...source.payload, segmentId } },
            {
              ...event(),
              meetingId: id,
              payload: {
                kind: 'translation' as const,
                provider: 'openai' as const,
                mode: 'online_full' as const,
                sourceSegmentId: segmentId,
                sourceText: source.payload.text,
                targetText: '譯文 ' + segmentId,
                sourceLanguage: 'en',
                targetLanguage: 'zh-TW',
                status: 'final' as const,
                updatedAt: new Date().toISOString(),
              },
            },
          ];
        }).flat();
        await repo.commitEvents(batch);
      }
      await repo.commitEvents([{ ...event('校訂文字', 2), meetingId: id }]);
      await repo.finalize(id, {
        pendingCount: 0,
        unfinishedTurns: [],
        gaps: [
          {
            gapId: randomUUID(),
            meetingId: id,
            trackId: 'mic',
            captureEpoch: randomUUID(),
            alignment: 'estimated',
            state: 'unrecoverable',
            cause: 'network',
            wallClock: { startAt: '2026-10-16T01:00:00.000Z', endAt: '2026-10-16T01:00:03.000Z' },
          },
        ],
      });
    }
    const expected = await Promise.all([repo.snapshot(meetingId), repo.snapshot(secondId)]);
    const backupPath = await repo.backup();
    await repo.commitEvents([{ ...event('備份後修訂', 3), meetingId: secondId }]);
    const restoredDir = await mkdtemp(join(tmpdir(), 'archive-full-restore-'));
    cleanup.push(() => rm(restoredDir, { recursive: true, force: true }));
    const backupId = basename(dirname(backupPath));
    await cp(dirname(backupPath), join(restoredDir, backupId), { recursive: true });
    const restored = new MeetingRepository({ dataDir: restoredDir, workerPath });
    cleanup.push(() => restored.close());
    await restored.listMeetings();
    await restored.restoreBackup(backupId);
    for (const snapshot of expected) {
      expect(snapshot.segments).toHaveLength(10050);
      expect(Object.keys(snapshot.translations)).toHaveLength(10050);
      expect(snapshot.manifest?.gaps).toHaveLength(1);
      expect(await restored.snapshot(snapshot.meeting.meetingId)).toEqual(snapshot);
    }
    const manifest = JSON.parse(await readFile(join(dirname(backupPath), 'manifest.json'), 'utf8'));
    expect(manifest.meetingCount).toBe(2);
    expect(manifest.eventCount).toBe(40202);
    expect(manifest.databaseSha256).toBe(
      createHash('sha256')
        .update(await readFile(backupPath))
        .digest('hex'),
    );
  }, 60000);
  it('restores a verified backup and preserves the replaced database in a safety backup', async () => {
    const { repo } = await setup();
    await repo.commitEvents([event()]);
    const before = await repo.snapshot(meetingId);
    const backupPath = await repo.backup();
    await repo.commitEvents([event('還原前的新校訂', 2)]);
    const replaced = await repo.snapshot(meetingId);
    const result = await repo.restoreBackup(basename(dirname(backupPath)));
    expect(await repo.snapshot(meetingId)).toEqual(before);
    const safetyDir = await mkdtemp(join(tmpdir(), 'archive-safety-'));
    cleanup.push(() => rm(safetyDir, { recursive: true, force: true }));
    await copyFile(result.safetyBackupPath, join(safetyDir, 'meetings.sqlite'));
    const safety = new MeetingRepository({ dataDir: safetyDir, workerPath });
    cleanup.push(() => safety.close());
    expect(await safety.snapshot(meetingId)).toEqual(replaced);
    await repo.commitEvents([event('還原後可正常寫入', 2)]);
    expect((await repo.snapshot(meetingId)).segments[0].text).toBe('還原後可正常寫入');
  });
  it('changes the persisted archive generation only on successful restore and reads schema 1 and 2 backups', async () => {
    const { repo, dataDir } = await setup();
    expect(await repo.archiveGeneration()).toBeNull();
    await repo.commitEvents([event()]);
    const original = await repo.snapshot(meetingId);
    const firstBackup = await repo.backup();
    await repo.restoreBackup(basename(dirname(firstBackup)));
    const firstGeneration = await repo.archiveGeneration();
    expect(firstGeneration).toMatch(/^[a-f0-9-]{36}$/);
    const secondBackup = await repo.backup();
    expect(
      JSON.parse(await readFile(join(dirname(secondBackup), 'manifest.json'), 'utf8'))
        .schemaVersion,
    ).toBe(2);
    await repo.commitEvents([event('還原前校訂', 2)]);
    await expect(repo.restoreBackup('../invalid')).rejects.toThrow();
    expect(await repo.archiveGeneration()).toBe(firstGeneration);
    await repo.restoreBackup(basename(dirname(secondBackup)));
    const secondGeneration = await repo.archiveGeneration();
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(await repo.snapshot(meetingId)).toEqual(original);
    await repo.close();
    const restarted = new MeetingRepository({ dataDir, workerPath });
    cleanup.push(() => restarted.close());
    expect(await restarted.archiveGeneration()).toBe(secondGeneration);
    await restarted.restoreBackup(basename(dirname(firstBackup)));
    expect(await restarted.archiveGeneration()).not.toBe(secondGeneration);
    expect(await restarted.snapshot(meetingId)).toEqual(original);
  });
  it('does not publish a failed backup or change the locked source database', async () => {
    const { repo, dataDir } = await setup();
    await repo.commitEvents([event()]);
    const before = await repo.snapshot(meetingId);
    const lock = new DatabaseSync(join(dataDir, 'meetings.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    try {
      await expect(repo.backup()).rejects.toThrow(/locked/);
      expect((await readdir(dataDir)).filter((name) => name.startsWith('backup-'))).toEqual([]);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    expect(await repo.snapshot(meetingId)).toEqual(before);
    expect(await repo.backup()).toMatch(/meetings\.sqlite$/);
  }, 10000);
  it.each(['hash', 'truncated', 'schema', 'count', 'manifest', 'path'] as const)(
    'rejects %s restore input without replacing live data',
    async (fault) => {
      const { repo, dataDir } = await setup();
      await repo.commitEvents([event()]);
      const backupPath = await repo.backup();
      const manifestPath = join(dirname(backupPath), 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (fault === 'hash') manifest.databaseSha256 = '0'.repeat(64);
      if (fault === 'count') manifest.eventCount++;
      if (fault === 'manifest') manifest.formatVersion = 999;
      if (fault === 'truncated')
        await writeFile(backupPath, (await readFile(backupPath)).subarray(0, 100));
      if (fault === 'schema') {
        const copy = new DatabaseSync(backupPath);
        copy.exec('PRAGMA user_version=999');
        copy.close();
        manifest.databaseSha256 = createHash('sha256')
          .update(await readFile(backupPath))
          .digest('hex');
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await repo.commitEvents([event('保留現有校訂', 2)]);
      const before = await repo.snapshot(meetingId);
      const id =
        fault === 'path' ? '../' + basename(dirname(backupPath)) : basename(dirname(backupPath));
      await expect(repo.restoreBackup(id)).rejects.toThrow();
      expect(await repo.snapshot(meetingId)).toEqual(before);
      expect((await readdir(dataDir)).filter((name) => name.startsWith('restore-'))).toEqual([]);
      await repo.commitEvents([event('拒絕後仍能寫入', 3)]);
      expect((await repo.snapshot(meetingId)).segments[0].text).toBe('拒絕後仍能寫入');
    },
  );
  it('excludes concurrent operations during restore and refuses to overtake pending writes', async () => {
    const { repo } = await setup();
    const path = await repo.backup();
    const id = basename(dirname(path));
    const pending = repo.commitEvents([event()]);
    await expect(repo.restoreBackup(id)).rejects.toThrow('ARCHIVE_BUSY');
    await pending;
    const restoring = repo.restoreBackup(id);
    await expect(repo.commitEvents([event('過期寫入', 2)])).rejects.toThrow('ARCHIVE_RESTORING');
    await expect(repo.restoreBackup(id)).rejects.toThrow('ARCHIVE_BUSY');
    await restoring;
    expect((await repo.snapshot(meetingId)).events).toHaveLength(0);
  });
  it('retires the writer if restore rollback cannot reopen a usable database', async () => {
    const script =
      "import { parentPort } from 'node:worker_threads'; parentPort.on('message', ({ id }) => parentPort.postMessage({ id, error: 'ARCHIVE_RESTORE_RECOVERY_REQUIRED' }));";
    const repo = new MeetingRepository({
      workerPath: new URL('data:text/javascript,' + encodeURIComponent(script)),
    });
    cleanup.push(() => repo.close());
    await expect(repo.restoreBackup('backup-' + randomUUID())).rejects.toThrow(
      'ARCHIVE_RESTORE_RECOVERY_REQUIRED',
    );
    expect(repo.failed).toBe(true);
    await expect(repo.listMeetings()).rejects.toThrow('ARCHIVE_RESTORE_RECOVERY_REQUIRED');
  });
  it.runIf(process.platform === 'win32')(
    'preserves the live database when Windows refuses file replacement',
    async () => {
      const { repo, dataDir } = await setup();
      await repo.commitEvents([event()]);
      const backupPath = await repo.backup();
      await repo.commitEvents([event('必須保留的最新資料', 2)]);
      const before = await repo.snapshot(meetingId);
      // SQLite's Windows handle denies deletion/replacement while another connection is open.
      const held = new DatabaseSync(join(dataDir, 'meetings.sqlite'), { readOnly: true });
      try {
        await expect(repo.restoreBackup(basename(dirname(backupPath)))).rejects.toThrow(
          /EPERM|EBUSY|EACCES/,
        );
        expect(repo.failed).toBe(false);
        expect(await repo.snapshot(meetingId)).toEqual(before);
        expect((await readdir(dataDir)).filter((name) => name.startsWith('backup-'))).toHaveLength(
          2,
        );
        expect((await readdir(dataDir)).filter((name) => name.startsWith('restore-'))).toEqual([]);
      } finally {
        held.close();
      }
      await repo.commitEvents([event('解除占用後仍可寫入', 3)]);
      expect((await repo.snapshot(meetingId)).segments[0].text).toBe('解除占用後仍可寫入');
    },
  );
  it.each(['reopen', 'rollback-write'] as const)(
    'recovers the original database after %s failure and restart',
    async (fault) => {
      const wrapperPath = join(workerDir, 'restore-fault-' + randomUUID() + '.cjs');
      await writeFile(
        wrapperPath,
        `
      const sqlite = require('node:sqlite');
      const fs = require('node:fs');
      const { join } = require('node:path');
      const { workerData } = require('node:worker_threads');
      const live = join(workerData.dataDir, 'meetings.sqlite');
      const Original = sqlite.DatabaseSync;
      let opens = 0;
      sqlite.DatabaseSync = new Proxy(Original, { construct(target, args) {
        if (args[0] === live && ++opens === 2) throw new Error('INJECTED_REOPEN_FAILURE');
        return Reflect.construct(target, args);
      }});
      const copy = fs.copyFileSync;
      fs.copyFileSync = (...args) => {
        if (${JSON.stringify(fault)} === 'rollback-write' && opens === 2)
          throw new Error('INJECTED_ROLLBACK_WRITE_FAILURE');
        return copy(...args);
      };
      require(${JSON.stringify(workerPath)});
    `,
      );
      const { repo, dataDir } = await setup(wrapperPath);
      await repo.commitEvents([event()]);
      const backupPath = await repo.backup();
      await repo.commitEvents([event('失敗後必須保留的新資料', 2)]);
      const original = await repo.snapshot(meetingId);
      const originalGeneration = await repo.archiveGeneration();
      await expect(repo.restoreBackup(basename(dirname(backupPath)))).rejects.toThrow(
        fault === 'reopen' ? 'INJECTED_REOPEN_FAILURE' : 'ARCHIVE_RESTORE_RECOVERY_REQUIRED',
      );
      if (fault === 'reopen') expect(await repo.snapshot(meetingId)).toEqual(original);
      else expect(repo.failed).toBe(true);
      await repo.close();
      const restarted = new MeetingRepository({ dataDir, workerPath });
      cleanup.push(() => restarted.close());
      expect(await restarted.snapshot(meetingId)).toEqual(original);
      expect(await restarted.archiveGeneration()).toBe(originalGeneration);
    },
  );
  it.each(['restore-pending.json', 'meetings.sqlite'])(
    'rolls back an interrupted restore after publishing %s',
    async (crashAfter) => {
      const wrapperPath = join(workerDir, 'restore-crash-' + randomUUID() + '.cjs');
      await writeFile(
        wrapperPath,
        `
      const fs = require('node:fs');
      const { join } = require('node:path');
      const { workerData } = require('node:worker_threads');
      const target = join(workerData.dataDir, ${JSON.stringify(crashAfter)});
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        const result = rename(...args);
        if (args[1] === target) process.exit(73);
        return result;
      };
      require(${JSON.stringify(workerPath)});
    `,
      );
      const { repo, dataDir } = await setup(wrapperPath);
      await repo.commitEvents([event()]);
      const backupPath = await repo.backup();
      await repo.commitEvents([event('中斷時仍須保留的新資料', 2)]);
      const original = await repo.snapshot(meetingId);
      const originalGeneration = await repo.archiveGeneration();
      await expect(repo.restoreBackup(basename(dirname(backupPath)))).rejects.toThrow(
        'ARCHIVE_WRITER_EXITED',
      );
      expect(await readdir(dataDir)).toContain('restore-pending.json');
      await repo.close();
      const restarted = new MeetingRepository({ dataDir, workerPath });
      cleanup.push(() => restarted.close());
      expect(await restarted.snapshot(meetingId)).toEqual(original);
      expect(await restarted.archiveGeneration()).toBe(originalGeneration);
      expect(await readdir(dataDir)).not.toContain('restore-pending.json');
      await restarted.commitEvents([event('恢復後繼續寫入', 3)]);
      expect((await restarted.snapshot(meetingId)).segments[0].text).toBe('恢復後繼續寫入');
    },
  );
  it('rejects unsupported schemas and corrupt files without replacing the database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-corrupt-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const db = new DatabaseSync(join(dir, 'meetings.sqlite'));
    db.exec('PRAGMA user_version=999');
    db.close();
    const future = new MeetingRepository({ dataDir: dir, workerPath });
    cleanup.push(() => future.close());
    await expect(future.listMeetings()).rejects.toThrow('ARCHIVE_SCHEMA_TOO_NEW');
    await future.close();
    await writeFile(join(dir, 'meetings.sqlite'), 'not a database');
    const corrupt = new MeetingRepository({ dataDir: dir, workerPath });
    cleanup.push(() => corrupt.close());
    await expect(corrupt.listMeetings()).rejects.toThrow();
  });
  it('recovers every ACK after abrupt writer termination and leaves interrupted batches atomic', async () => {
    const { repo, dataDir } = await setup();
    const acked = event();
    await repo.commitEvents([acked]);
    const batch = Array.from({ length: 100 }, (_, i) => ({
      ...event(),
      payload: { ...event().payload, segmentId: `crash-${i}` },
    }));
    const pending = repo.commitEvents(batch).catch(() => null);
    await (repo as unknown as { worker: Worker }).worker.terminate();
    await pending;
    const restored = new MeetingRepository({ dataDir, workerPath });
    cleanup.push(() => restored.close());
    const snapshot = await restored.snapshot(meetingId);
    expect(snapshot.events.some((e) => e.eventId === acked.eventId)).toBe(true);
    expect([1, 101]).toContain(snapshot.events.length);
    // Simulate a lost ACK: replay the exact immutable batch after process restart.
    await restored.commitEvents(batch);
    expect((await restored.snapshot(meetingId)).events).toHaveLength(101);
  });
  it('keeps more than the 20,000-segment UI cap in the database', async () => {
    const { repo } = await setup();
    for (let offset = 0; offset < 20100; offset += 100) {
      await repo.commitEvents(
        Array.from({ length: 100 }, (_, index) => {
          const value = event('對，對');
          return {
            ...value,
            payload: {
              ...value.payload,
              segmentId: `segment-${offset + index}`,
              startMs: offset + index,
            },
          };
        }),
      );
    }
    const snapshot = await repo.snapshot(meetingId);
    expect(snapshot.events).toHaveLength(20100);
    expect(snapshot.segments).toHaveLength(20100);
    const page = await repo.readPage(meetingId, 20000, 100);
    expect(page.segments).toHaveLength(100);
    expect(page.totalSegments).toBe(20100);
    expect(page.segments[0].segmentId).toBe('segment-20000');
    expect(page).not.toHaveProperty('events');
    await expect(repo.readPage(meetingId, 0, 201)).rejects.toThrow('INVALID_ARCHIVE_INPUT');
    for (const variant of ['original', 'corrected'] as const) {
      const exported = JSON.parse(await repo.export(meetingId, variant, 'json'));
      expect(exported.metadata.segmentCount).toBe(20100);
      expect(exported.segments.map((s: { segmentId: string }) => s.segmentId)).toEqual(
        snapshot.segments.map((s) => s.segmentId),
      );
      expect((await repo.export(meetingId, variant, 'txt')).split('\n')).toEqual(
        snapshot.segments.map((s) => (variant === 'original' ? s.originalText : s.text)),
      );
    }
  }, 30000);
  it('rejects a database lock without a partial commit and succeeds after unlock', async () => {
    const { repo, dataDir } = await setup();
    const lock = new DatabaseSync(join(dataDir, 'meetings.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    try {
      await expect(repo.commitEvents([event()])).rejects.toThrow(/locked/);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    expect((await repo.snapshot(meetingId)).events).toHaveLength(0);
    await repo.commitEvents([event()]);
    expect((await repo.snapshot(meetingId)).events).toHaveLength(1);
  });
  it('retains known gaps and derives unfinished checkpoints in the final manifest', async () => {
    const { repo } = await setup();
    const partial = event();
    await repo.commitEvents([{ ...partial, payload: { ...partial.payload, status: 'partial' } }]);
    const gap = {
      gapId: randomUUID(),
      meetingId,
      trackId: 'microphone',
      captureEpoch: '1',
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      state: 'unrecoverable' as const,
      cause: 'network',
      alignment: 'estimated' as const,
    };
    const manifest = await repo.finalize(meetingId, {
      pendingCount: 0,
      gaps: [gap],
      unfinishedTurns: [],
    });
    expect(manifest.unfinishedTurns).toEqual(['segment-1']);
    expect(manifest.finalCount).toBe(0);
    expect(
      (await repo.finalize(meetingId, { pendingCount: 0, gaps: [], unfinishedTurns: [] })).gaps,
    ).toEqual([gap]);
  });
  it('pages revision counters including translations without source segments', async () => {
    const { repo } = await setup();
    const translation = (id: string, revision: number) => ({
      ...event('', revision),
      payload: {
        kind: 'translation' as const,
        provider: 'openai' as const,
        mode: 'online_full' as const,
        sourceSegmentId: id,
        sourceText: '',
        targetText: 'translation',
        sourceLanguage: 'en',
        targetLanguage: 'zh-TW',
        status: 'final' as const,
        updatedAt: new Date().toISOString(),
      },
    });
    await repo.commitEvents([
      event(),
      translation('orphan', 1),
      translation('orphan', 2),
      translation('segment-1', 1),
    ]);
    const first = await repo.readRevisions(meetingId, 0, 1);
    const second = await repo.readRevisions(meetingId, first.nextOffset!, 1);
    const third = await repo.readRevisions(meetingId, second.nextOffset!, 1);
    expect([...first.revisions, ...second.revisions, ...third.revisions]).toEqual([
      { kind: 'transcript', segmentId: 'segment-1', revision: 1 },
      { kind: 'translation', segmentId: 'orphan', revision: 2 },
      { kind: 'translation', segmentId: 'segment-1', revision: 1 },
    ]);
    expect(third.nextOffset).toBeNull();
    await expect(repo.readRevisions(meetingId, 0, 201)).rejects.toThrow('INVALID_ARCHIVE_INPUT');
  });
  it('returns only the translations for the requested segment page', async () => {
    const { repo } = await setup();
    const source = event();
    await repo.commitEvents([
      source,
      {
        ...event(),
        payload: {
          kind: 'translation',
          provider: 'openai',
          mode: 'online_full',
          sourceSegmentId: 'segment-1',
          sourceText: '原始 approve',
          targetText: 'translated',
          sourceLanguage: 'zh-TW',
          targetLanguage: 'en',
          status: 'final',
          updatedAt: new Date().toISOString(),
        },
      },
    ]);
    expect((await repo.readPage(meetingId, 0, 1)).translations['segment-1'].targetText).toBe(
      'translated',
    );
    expect((await repo.readPage(meetingId, 1, 1)).translations).toEqual({});
  });
  it('terminates an unresponsive writer on deadline and exposes failed state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-hung-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'hung.cjs');
    await writeFile(path, "require('node:worker_threads').parentPort.on('message', () => {});");
    const repo = new MeetingRepository({ dataDir: dir, workerPath: path, requestTimeoutMs: 100 });
    cleanup.push(async () => {
      await (repo as unknown as { worker: Worker }).worker.terminate();
      await repo.close();
    });
    await expect(repo.listMeetings()).rejects.toThrow('ARCHIVE_TIMEOUT');
    expect(repo.failed).toBe(true);
    await expect(repo.close()).resolves.toBeUndefined();
  });
  it('bounds close even when the worker never acknowledges shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-close-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'hung.cjs');
    await writeFile(path, "require('node:worker_threads').parentPort.on('message', () => {});");
    const repo = new MeetingRepository({ dataDir: dir, workerPath: path, requestTimeoutMs: 100 });
    cleanup.push(async () => {
      await (repo as unknown as { worker: Worker }).worker.terminate();
    });
    await Promise.all([repo.close(), repo.close()]);
    expect(repo.failed).toBe(true);
    await expect(repo.listMeetings()).rejects.toThrow();
  });
});
