import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { FinalizeInput, MeetingEnvelope, MeetingMetadata } from '@meeting-audio/contracts';
import type {
  ArchivedSegment,
  ArchivedTranslation,
  GapRecord,
  MeetingManifest,
  MeetingSnapshot,
} from '@meeting-audio/contracts';
import { exportMeeting, refreshMeetingExports } from './meeting-export.js';
import { createDiagnosticLog } from './diagnostic-log.js';
import {
  createMeetingBackup,
  stageMeetingRestore,
  recoverInterruptedRestore,
  RESTORE_JOURNAL,
  backupFilePath,
  importMeetingBackup,
  readArchiveGeneration,
} from './meeting-backup.js';

const dataDir = (workerData as { dataDir: string }).dataDir;
let exportWrites: Promise<void> = Promise.resolve();
let diagnostic: ReturnType<typeof createDiagnosticLog> | undefined;
try {
  diagnostic = createDiagnosticLog(dataDir);
} catch {
  /* surfaced with each response */
}
mkdirSync(dataDir, { recursive: true });
recoverInterruptedRestore(dataDir);
let db = new DatabaseSync(join(dataDir, 'meetings.sqlite'));
db.exec('PRAGMA busy_timeout=3000');
const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
if (version > 2) throw new Error('ARCHIVE_SCHEMA_TOO_NEW');
if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok')
  throw new Error('ARCHIVE_CORRUPT');
db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
if (
  db.prepare('PRAGMA journal_mode').get()?.['journal_mode'] !== 'delete' ||
  db.prepare('PRAGMA synchronous').get()?.['synchronous'] !== 2
)
  throw new Error('ARCHIVE_DURABILITY_UNAVAILABLE');
if (version === 0) {
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get()
  )
    throw new Error('ARCHIVE_UNKNOWN_SCHEMA');
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, manifest TEXT);
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, meeting_id TEXT NOT NULL REFERENCES meetings(id), envelope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS segment_revisions (meeting_id TEXT NOT NULL, segment_id TEXT NOT NULL, revision INTEGER NOT NULL, category TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(meeting_id,segment_id,category,revision));
    CREATE TABLE IF NOT EXISTS gaps (meeting_id TEXT NOT NULL, gap_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(meeting_id,gap_id));
    PRAGMA user_version=1; COMMIT;`);
}
readArchiveGeneration(db);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** Loss is irreversible; a stale retry or a generic gap update must not erase it. */
function saveGap(gap: GapRecord): void {
  const row = db
    .prepare('SELECT payload FROM gaps WHERE meeting_id=? AND gap_id=?')
    .get(gap.meetingId, gap.gapId);
  const previous = row ? (JSON.parse(String(row['payload'])) as GapRecord) : undefined;
  if (previous && 'storageLoss' in previous && previous.storageLoss) {
    if (
      !('storageLoss' in gap) ||
      !gap.storageLoss ||
      gap.storageLoss.lostCount <= previous.storageLoss.lostCount
    )
      gap = previous;
  }
  db.prepare(
    'INSERT INTO gaps VALUES(?,?,?) ON CONFLICT(meeting_id,gap_id) DO UPDATE SET payload=excluded.payload',
  ).run(gap.meetingId, gap.gapId, canonical(gap));
}
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    // SQLITE_FULL/IOERR may already roll back the transaction. Preserve its cause.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
function meeting(id: string): MeetingMetadata {
  z.string().uuid().parse(id);
  const row = db.prepare('SELECT metadata FROM meetings WHERE id=?').get(id);
  if (!row) throw new Error('MEETING_NOT_FOUND');
  return MeetingMetadata.parse(JSON.parse(String(row['metadata'])));
}
function snapshot(id: string): MeetingSnapshot {
  const metadata = meeting(id);
  const rows = db
    .prepare('SELECT sequence,envelope FROM events WHERE meeting_id=? ORDER BY sequence')
    .all(id);
  const events = rows.map((row) => MeetingEnvelope.parse(JSON.parse(String(row['envelope']))));
  const segments = db
    .prepare(
      `SELECT r.payload FROM segment_revisions r WHERE meeting_id=? AND category='transcript' AND revision=(SELECT MAX(revision) FROM segment_revisions x WHERE x.meeting_id=r.meeting_id AND x.segment_id=r.segment_id AND x.category=r.category) ORDER BY json_extract(r.payload,'$.startMs'),segment_id`,
    )
    .all(id)
    .map((row) => JSON.parse(String(row['payload'])) as ArchivedSegment);
  const manifest = db.prepare('SELECT manifest FROM meetings WHERE id=?').get(id)?.['manifest'];
  return {
    meeting: metadata,
    events,
    segments,
    translations: translations(id),
    lastSequence: Number(rows.at(-1)?.['sequence'] ?? 0),
    manifest: manifest ? (JSON.parse(String(manifest)) as MeetingManifest) : null,
  };
}
function translations(id: string, segmentIds?: string[]): Record<string, ArchivedTranslation> {
  if (segmentIds?.length === 0) return {};
  const filter = segmentIds ? ` AND segment_id IN (${segmentIds.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT r.segment_id,r.payload FROM segment_revisions r WHERE meeting_id=? AND category='translation'${filter} AND revision=(SELECT MAX(revision) FROM segment_revisions x WHERE x.meeting_id=r.meeting_id AND x.segment_id=r.segment_id AND x.category=r.category)`,
    )
    .all(id, ...(segmentIds ?? []));
  return Object.fromEntries(
    rows.map((row) => [
      String(row['segment_id']),
      JSON.parse(String(row['payload'])) as ArchivedTranslation,
    ]),
  );
}
function commitEvents(input: unknown) {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 100 ||
    Buffer.byteLength(JSON.stringify(input)) > 256 * 1024
  )
    throw new Error('BATCH_LIMIT');
  const events = z.array(MeetingEnvelope).parse(input);
  const id = events[0]!.meetingId;
  if (events.some((e) => e.meetingId !== id)) throw new Error('MIXED_MEETINGS');
  return transaction(() => {
    meeting(id);
    for (const event of events) {
      const serialized = canonical(event);
      const existing = db
        .prepare('SELECT envelope FROM events WHERE event_id=?')
        .get(event.eventId);
      if (existing) {
        if (existing['envelope'] !== serialized) throw new Error('EVENT_ID_CONFLICT');
        continue;
      }
      const payload = event.payload;
      if (payload.kind === 'gap') {
        if (payload.gap.meetingId !== id) throw new Error('MIXED_MEETINGS');
        saveGap(payload.gap);
      } else {
        const category = payload.kind === 'translation' ? 'translation' : 'transcript';
        const segmentId =
          payload.kind === 'translation' ? payload.sourceSegmentId : payload.segmentId;
        const old = db
          .prepare(
            'SELECT revision,payload FROM segment_revisions WHERE meeting_id=? AND segment_id=? AND category=? ORDER BY revision DESC LIMIT 1',
          )
          .get(id, segmentId, category);
        const oldRevision = Number(old?.['revision'] ?? 0);
        if (
          event.revision !== oldRevision + 1 ||
          (payload.kind === 'correction' && payload.baseRevision !== oldRevision)
        )
          throw new Error('REVISION_CONFLICT');
        let projected: unknown = { ...payload, revision: event.revision };
        if (payload.kind === 'transcript')
          projected = { ...payload, revision: event.revision, originalText: payload.text };
        if (payload.kind === 'correction') {
          if (!old) throw new Error('SEGMENT_NOT_FOUND');
          projected = {
            ...JSON.parse(String(old['payload'])),
            text: payload.text,
            revision: event.revision,
          };
        }
        db.prepare('INSERT INTO segment_revisions VALUES(?,?,?,?,?)').run(
          id,
          segmentId,
          event.revision,
          category,
          canonical(projected),
        );
      }
      db.prepare('INSERT INTO events(event_id,meeting_id,envelope) VALUES(?,?,?)').run(
        event.eventId,
        id,
        serialized,
      );
      db.prepare('UPDATE meetings SET manifest=NULL WHERE id=?').run(id);
    }
    return {
      meetingId: id,
      committedEventIds: events.map((e) => e.eventId),
      committedAt: new Date().toISOString(),
    };
  });
}
function dispatch(method: string, args: unknown): unknown {
  if (method === 'archiveGeneration') return readArchiveGeneration(db);
  switch (method) {
    case 'createMeeting': {
      const metadata = MeetingMetadata.parse(args);
      return transaction(() => {
        const existing = db
          .prepare('SELECT metadata FROM meetings WHERE id=?')
          .get(metadata.meetingId);
        if (existing && existing['metadata'] !== canonical(metadata))
          throw new Error('MEETING_METADATA_CONFLICT');
        db.prepare('INSERT OR IGNORE INTO meetings(id,metadata) VALUES(?,?)').run(
          metadata.meetingId,
          canonical(metadata),
        );
        return metadata;
      });
    }
    case 'commitEvents':
      return commitEvents(args);
    case 'snapshot':
      return transaction(() => snapshot(z.string().uuid().parse(args)));
    case 'listMeetings':
      return db
        .prepare('SELECT metadata,manifest FROM meetings ORDER BY rowid DESC')
        .all()
        .map((row) => ({
          ...JSON.parse(String(row['metadata'])),
          manifest: row['manifest'] ? JSON.parse(String(row['manifest'])) : null,
        }));
    case 'readRevisions': {
      const value = z
        .object({
          meetingId: z.string().uuid(),
          offset: z.number().int().nonnegative(),
          limit: z.number().int().min(1).max(200),
        })
        .parse(args);
      meeting(value.meetingId);
      const rows = db
        .prepare(
          `SELECT category AS kind, segment_id AS segmentId, MAX(revision) AS revision
         FROM segment_revisions WHERE meeting_id=? AND category IN ('transcript','translation')
         GROUP BY category,segment_id ORDER BY category,segment_id LIMIT ? OFFSET ?`,
        )
        .all(value.meetingId, value.limit + 1, value.offset);
      return {
        revisions: rows.slice(0, value.limit),
        nextOffset: rows.length > value.limit ? value.offset + value.limit : null,
      };
    }
    case 'readPage': {
      const value = z
        .object({
          meetingId: z.string().uuid(),
          offset: z.number().int().nonnegative(),
          limit: z.number().int().min(1).max(200),
        })
        .parse(args);
      return transaction(() => {
        const metadata = meeting(value.meetingId);
        const manifest = db
          .prepare('SELECT manifest FROM meetings WHERE id=?')
          .get(value.meetingId)?.['manifest'];
        const segments = db
          .prepare(
            `SELECT r.payload FROM segment_revisions r WHERE meeting_id=? AND category='transcript' AND revision=(SELECT MAX(revision) FROM segment_revisions x WHERE x.meeting_id=r.meeting_id AND x.segment_id=r.segment_id AND x.category=r.category) ORDER BY json_extract(r.payload,'$.startMs'),segment_id LIMIT ? OFFSET ?`,
          )
          .all(value.meetingId, value.limit, value.offset)
          .map((row) => JSON.parse(String(row['payload'])));
        const totalSegments = Number(
          db
            .prepare(
              "SELECT COUNT(DISTINCT segment_id) AS n FROM segment_revisions WHERE meeting_id=? AND category='transcript'",
            )
            .get(value.meetingId)?.['n'],
        );
        const lastSequence = Number(
          db
            .prepare('SELECT MAX(sequence) AS n FROM events WHERE meeting_id=?')
            .get(value.meetingId)?.['n'] ?? 0,
        );
        return {
          meeting: metadata,
          segments,
          translations: translations(
            value.meetingId,
            segments.map((segment: ArchivedSegment) => segment.segmentId),
          ),
          manifest: manifest ? JSON.parse(String(manifest)) : null,
          lastSequence,
          totalSegments,
        };
      });
    }
    case 'finalize': {
      const { meetingId, input } = z
        .object({ meetingId: z.string().uuid(), input: FinalizeInput })
        .parse(args);
      return transaction(() => {
        const current = snapshot(meetingId);
        if (input.gaps.some((g) => g.meetingId !== meetingId)) throw new Error('MIXED_MEETINGS');
        for (const gap of input.gaps) saveGap(gap);
        const gaps = db
          .prepare('SELECT payload FROM gaps WHERE meeting_id=?')
          .all(meetingId)
          .map((row) => JSON.parse(String(row['payload'])));
        const storageLosses = gaps.filter((gap) => gap.storageLoss);
        const lostCount = storageLosses.reduce((sum, gap) => sum + gap.storageLoss.lostCount, 0);
        const unfinishedTurns = [
          ...new Set([
            ...input.unfinishedTurns,
            ...current.segments.filter((s) => s.status !== 'final').map((s) => s.segmentId),
          ]),
        ];
        const manifest: MeetingManifest = {
          ...input,
          unfinishedTurns,
          gaps,
          lostCount,
          unsavedSince: storageLosses.length
            ? storageLosses.map((g) => g.wallClock.startAt).sort()[0]
            : null,
          unsavedUntil: storageLosses.length
            ? storageLosses
                .map((g) => g.wallClock.endAt)
                .sort()
                .at(-1)
            : null,
          meetingId,
          lastSequence: current.lastSequence,
          lastRevision: current.events.reduce((max, e) => Math.max(max, e.revision), 0),
          finalCount: current.segments.filter((s) => s.status === 'final').length,
          saved: input.pendingCount === 0 && lostCount === 0,
          finalizedAt: new Date().toISOString(),
        };
        db.prepare('UPDATE meetings SET manifest=? WHERE id=?').run(canonical(manifest), meetingId);
        return manifest;
      });
    }
    case 'backup': {
      return createMeetingBackup(db, dataDir);
    }
    case 'backupFile': {
      const input = z
        .object({ backupId: z.string(), file: z.enum(['meetings.sqlite', 'manifest.json']) })
        .strict()
        .parse(args);
      return backupFilePath(dataDir, input.backupId, input.file);
    }
    case 'importBackup':
      return importMeetingBackup(db, dataDir, String(args));
    case 'restoreBackup': {
      const input = z
        .object({ backupId: z.string(), generation: z.string().uuid().optional() })
        .strict()
        .parse(args);
      const staged = stageMeetingRestore(db, dataDir, input.backupId, input.generation);
      const livePath = join(dataDir, 'meetings.sqlite');
      const journalPath = join(dataDir, RESTORE_JOURNAL);
      const temporaryJournal = join(staged.directory, RESTORE_JOURNAL);
      let closed = false;
      let replaced = false;
      try {
        writeFileSync(
          temporaryJournal,
          JSON.stringify({ safetyBackupId: basename(dirname(staged.safetyBackupPath)) }),
          { encoding: 'utf8', flag: 'wx', flush: true },
        );
        renameSync(temporaryJournal, journalPath);
        db.close();
        closed = true;
        renameSync(staged.databasePath, livePath);
        replaced = true;
        db = new DatabaseSync(livePath);
        db.exec(
          'PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON',
        );
        rmSync(journalPath);
      } catch (error) {
        // Keep the pre-restore database available even when replacement/reopen fails.
        try {
          if (closed) {
            try {
              db.close();
            } catch {
              /* may already be closed */
            }
            if (replaced) {
              copyFileSync(staged.safetyBackupPath, staged.databasePath);
              const restoredFile = openSync(staged.databasePath, 'r+');
              try {
                fsyncSync(restoredFile);
              } finally {
                closeSync(restoredFile);
              }
              renameSync(staged.databasePath, livePath);
            }
            db = new DatabaseSync(livePath);
            db.exec(
              'PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON',
            );
          }
          rmSync(journalPath, { force: true });
        } catch {
          throw new Error('ARCHIVE_RESTORE_RECOVERY_REQUIRED');
        }
        throw error;
      } finally {
        try {
          rmSync(staged.directory, { recursive: true, force: true });
        } catch {
          /* private partial only */
        }
      }
      return { safetyBackupPath: staged.safetyBackupPath };
    }
    case 'export': {
      const value = z
        .object({
          meetingId: z.string().uuid(),
          variant: z.enum(['original', 'corrected']),
          format: z.enum(['txt', 'json', 'srt']),
        })
        .parse(args);
      return exportMeeting(
        transaction(() => snapshot(value.meetingId)),
        value.variant,
        value.format,
      );
    }
    case 'refreshExports': {
      const current = transaction(() => snapshot(z.string().uuid().parse(args)));
      exportWrites = exportWrites
        .catch(() => undefined)
        .then(() => refreshMeetingExports(dataDir, current));
      return exportWrites;
    }
    case 'close':
      return exportWrites.finally(() => db.close());
    default:
      throw new Error('UNKNOWN_ARCHIVE_OPERATION');
  }
}
function logOperation(method: string, args: unknown, error?: string): string | undefined {
  try {
    if (!diagnostic) diagnostic = createDiagnosticLog(dataDir);
    const first = Array.isArray(args) ? (args[0] as unknown) : args;
    const candidate =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && 'meetingId' in first
          ? first.meetingId
          : undefined;
    const meetingId = z.string().uuid().safeParse(candidate);
    const knownErrors = [
      'INVALID_ARCHIVE_INPUT',
      'BATCH_LIMIT',
      'MIXED_MEETINGS',
      'EVENT_ID_CONFLICT',
      'REVISION_CONFLICT',
      'MEETING_NOT_FOUND',
      'MEETING_METADATA_CONFLICT',
    ];
    diagnostic.record({
      method,
      time: new Date().toISOString(),
      ...(meetingId.success ? { meetingId: meetingId.data } : {}),
      ...(Array.isArray(args) ? { eventCount: Math.min(100, args.length) } : {}),
      ...(error ? { errorCode: knownErrors.includes(error) ? error : 'ARCHIVE_FAILURE' } : {}),
    });
    return undefined;
  } catch {
    return 'DIAGNOSTIC_WRITE_FAILED';
  }
}
parentPort!.on(
  'message',
  async ({ id, method, args }: { id: number; method: string; args: unknown }) => {
    try {
      const value = await dispatch(method, args);
      parentPort!.postMessage({ id, value, diagnosticError: logOperation(method, args) });
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? 'INVALID_ARCHIVE_INPUT'
          : error instanceof Error
            ? error.message
            : 'ARCHIVE_FAILURE';
      parentPort!.postMessage({
        id,
        error: message,
        diagnosticError: logOperation(method, args, message),
      });
    }
  },
);
