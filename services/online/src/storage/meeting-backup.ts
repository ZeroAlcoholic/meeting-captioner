import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Database } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const RESTORE_JOURNAL = 'restore-pending.json';

/** Schema 1 predates restoration fencing; schema 2 adds only this singleton identity. */
export function readArchiveGeneration(db: DatabaseSync): string | null {
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  if (version === 1) return null;
  if (version !== 2) throw new Error('ARCHIVE_SCHEMA_TOO_NEW');
  const rows = db.prepare('SELECT id,generation FROM archive_state').all();
  if (
    rows.length !== 1 ||
    rows[0]?.['id'] !== 1 ||
    !z.string().uuid().safeParse(rows[0]?.['generation']).success
  )
    throw new Error('ARCHIVE_GENERATION_INVALID');
  return String(rows[0]!['generation']);
}

export function backupFilePath(dataDir: string, backupId: string, file: string): string {
  if (!/^backup-[a-f0-9-]{36}$/.test(backupId)) throw new Error('ARCHIVE_BACKUP_ID_INVALID');
  if (file !== 'meetings.sqlite' && file !== 'manifest.json')
    throw new Error('ARCHIVE_BACKUP_FILE_INVALID');
  const directory = join(dataDir, backupId);
  const path = join(directory, file);
  const folderInfo = lstatSync(directory);
  const fileInfo = lstatSync(path);
  if (
    !folderInfo.isDirectory() ||
    folderInfo.isSymbolicLink() ||
    !fileInfo.isFile() ||
    fileInfo.isSymbolicLink()
  )
    throw new Error('ARCHIVE_BACKUP_PATH_INVALID');
  return path;
}

const BackupManifest = z
  .object({
    formatVersion: z.literal(1),
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    createdAt: z.string().datetime(),
    databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    meetingCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
  })
  .strict();

function databaseHash(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const file = openSync(path, 'r');
  try {
    let bytes: number;
    while ((bytes = readSync(file, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
}

/** Runs on the existing writer worker; publishes only a verified, complete directory. */
export function createMeetingBackup(db: DatabaseSync, dataDir: string): string {
  const destination = join(dataDir, 'backup-' + randomUUID());
  const staging = destination + '.partial';
  mkdirSync(staging);
  const databasePath = join(staging, 'meetings.sqlite');
  try {
    db.prepare('VACUUM INTO ?').run(databasePath);
    const copy = new Database(databasePath, { readOnly: true });
    let schemaVersion: number;
    let meetingCount: number;
    let eventCount: number;
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0]?.['integrity_check'] !== 'ok')
        throw new Error('ARCHIVE_BACKUP_CORRUPT');
      schemaVersion = Number(copy.prepare('PRAGMA user_version').get()?.['user_version']);
      if (schemaVersion !== 1 && schemaVersion !== 2)
        throw new Error('ARCHIVE_BACKUP_SCHEMA_UNSUPPORTED');
      readArchiveGeneration(copy);
      meetingCount = Number(
        copy.prepare('SELECT count(*) AS count FROM meetings').get()?.['count'],
      );
      eventCount = Number(copy.prepare('SELECT count(*) AS count FROM events').get()?.['count']);
    } finally {
      copy.close();
    }
    // Bound hashing memory independently of the number or duration of meetings.
    const databaseSha256 = databaseHash(databasePath);
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        schemaVersion,
        createdAt: new Date().toISOString(),
        databaseSha256,
        meetingCount,
        eventCount,
      }) + '\n',
      { encoding: 'utf8', flag: 'wx', flush: true },
    );
    renameSync(staging, destination);
    return join(destination, 'meetings.sqlite');
  } catch (error) {
    // Only this invocation's private staging directory is removed; source is never replaced.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* Keep the original error; a .partial directory is never a published backup. */
    }
    throw error;
  }
}

/** Validate a private copy before touching the live database. Never accept a caller path. */
function stageBackupCopy(dataDir: string, backupId: string, db?: DatabaseSync) {
  const manifestPath = backupFilePath(dataDir, backupId, 'manifest.json');
  const sourceDatabase = backupFilePath(dataDir, backupId, 'meetings.sqlite');
  if (lstatSync(manifestPath).size > 4096) throw new Error('ARCHIVE_BACKUP_MANIFEST_INVALID');
  const manifest = BackupManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const directory = join(dataDir, 'restore-' + randomUUID() + '.partial');
  mkdirSync(directory);
  const databasePath = join(directory, 'meetings.sqlite');
  try {
    copyFileSync(sourceDatabase, databasePath);
    if (databaseHash(databasePath) !== manifest.databaseSha256)
      throw new Error('ARCHIVE_BACKUP_HASH_MISMATCH');
    const copy = new Database(databasePath, { readOnly: true });
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0]?.['integrity_check'] !== 'ok')
        throw new Error('ARCHIVE_BACKUP_CORRUPT');
      if (
        Number(copy.prepare('PRAGMA user_version').get()?.['user_version']) !==
        manifest.schemaVersion
      )
        throw new Error('ARCHIVE_BACKUP_SCHEMA_UNSUPPORTED');
      readArchiveGeneration(copy);
      const schemaQuery =
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'archive_state' ORDER BY name";
      if (
        db &&
        JSON.stringify(copy.prepare(schemaQuery).all()) !==
          JSON.stringify(db.prepare(schemaQuery).all())
      )
        throw new Error('ARCHIVE_BACKUP_SCHEMA_UNSUPPORTED');
      if (
        copy.prepare('PRAGMA foreign_key_check').all().length ||
        Number(copy.prepare('SELECT count(*) AS count FROM meetings').get()?.['count']) !==
          manifest.meetingCount ||
        Number(copy.prepare('SELECT count(*) AS count FROM events').get()?.['count']) !==
          manifest.eventCount
      )
        throw new Error('ARCHIVE_BACKUP_CONTENT_MISMATCH');
    } finally {
      copy.close();
    }
    const file = openSync(databasePath, 'r+');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return { directory, databasePath };
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* private partial only */
    }
    throw error;
  }
}

export function stageMeetingRestore(
  db: DatabaseSync,
  dataDir: string,
  backupId: string,
  generation: string = randomUUID(),
) {
  z.string().uuid().parse(generation);
  if (generation === readArchiveGeneration(db)) throw new Error('ARCHIVE_RESTORE_ALREADY_APPLIED');
  const staged = stageBackupCopy(dataDir, backupId, db);
  try {
    const safetyBackupPath = createMeetingBackup(db, dataDir);
    const copy = new Database(staged.databasePath);
    try {
      copy.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      copy.exec(
        'CREATE TABLE IF NOT EXISTS archive_state (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL)',
      );
      copy
        .prepare(
          'INSERT INTO archive_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation',
        )
        .run(generation);
      copy.exec('PRAGMA user_version=2; COMMIT');
    } finally {
      copy.close();
    }
    return { ...staged, safetyBackupPath };
  } catch (error) {
    try {
      rmSync(staged.directory, { recursive: true, force: true });
    } catch {
      /* private partial only */
    }
    throw error;
  }
}

/** Verify uploaded artifacts on the writer worker before publishing them as a backup. */
export function importMeetingBackup(db: DatabaseSync, dataDir: string, importId: string): string {
  if (!/^import-[a-f0-9-]{36}$/.test(importId)) throw new Error('ARCHIVE_BACKUP_ID_INVALID');
  const backupId = 'backup-' + importId.slice(7);
  const source = join(dataDir, importId);
  const staged = stageBackupCopy(source, backupId, db);
  try {
    writeFileSync(
      join(staged.directory, 'manifest.json'),
      readFileSync(backupFilePath(source, backupId, 'manifest.json')),
      { flag: 'wx', flush: true },
    );
    renameSync(staged.directory, join(dataDir, backupId));
    return backupId;
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

/** An unfinished cutover rolls back before the writer accepts any work. */
export function recoverInterruptedRestore(dataDir: string): void {
  const journalPath = join(dataDir, RESTORE_JOURNAL);
  if (!existsSync(journalPath)) return;
  if (
    !lstatSync(journalPath).isFile() ||
    lstatSync(journalPath).isSymbolicLink() ||
    lstatSync(journalPath).size > 4096
  )
    throw new Error('ARCHIVE_RESTORE_JOURNAL_INVALID');
  const journal = z
    .object({ safetyBackupId: z.string() })
    .strict()
    .parse(JSON.parse(readFileSync(journalPath, 'utf8')));
  const staged = stageBackupCopy(dataDir, journal.safetyBackupId);
  try {
    renameSync(staged.databasePath, join(dataDir, 'meetings.sqlite'));
    rmSync(journalPath);
  } finally {
    try {
      rmSync(staged.directory, { recursive: true, force: true });
    } catch {
      /* private partial only */
    }
  }
}
