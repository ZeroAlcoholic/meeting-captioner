import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const DiagnosticRecord = z.object({
  method: z.enum([
    'createMeeting',
    'commitEvents',
    'snapshot',
    'readPage',
    'readRevisions',
    'listMeetings',
    'finalize',
    'backup',
    'backupFile',
    'importBackup',
    'restoreBackup',
    'archiveGeneration',
    'export',
    'refreshExports',
    'close',
  ]),
  time: z.string().datetime(),
  meetingId: z.string().uuid().optional(),
  eventCount: z.number().int().min(0).max(100).optional(),
  errorCode: z
    .enum([
      'INVALID_ARCHIVE_INPUT',
      'BATCH_LIMIT',
      'MIXED_MEETINGS',
      'EVENT_ID_CONFLICT',
      'REVISION_CONFLICT',
      'MEETING_NOT_FOUND',
      'MEETING_METADATA_CONFLICT',
      'ARCHIVE_FAILURE',
    ])
    .optional(),
});
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Deliberately accepts unknown input and serializes only the validated whitelist. */
export function createDiagnosticLog(dataDir: string, options: { maxBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_BYTES)
    throw new Error('INVALID_LOG_LIMIT');
  const dir = join(dataDir, 'diagnostics');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let current: string | null = null;
  let currentDay = -1;
  return {
    record(input: unknown): void {
      const line = JSON.stringify(DiagnosticRecord.parse(input)) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) throw new Error('DIAGNOSTIC_RECORD_TOO_LARGE');
      const now = Date.now();
      const day = Math.floor(now / 86400000) * 86400000;
      if (day !== currentDay) {
        current = null;
        currentDay = day;
      }
      const files = readdirSync(dir)
        .filter((name) => /^archive-[0-9a-f-]+\.jsonl$/i.test(name))
        .map((name) => {
          const path = join(dir, name);
          const stat = statSync(path);
          const stamp = Number(name.split('-')[1]);
          return {
            path,
            size: stat.size,
            time: Number.isFinite(stamp) ? stamp : stat.mtimeMs,
            modified: stat.mtimeMs,
          };
        })
        .sort((a, b) => a.modified - b.modified);
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files) {
        if (file.time >= now - MAX_AGE_MS && total + bytes <= maxBytes) continue;
        unlinkSync(file.path);
        total -= file.size;
        if (file.path === current) current = null;
      }
      current ??= join(dir, `archive-${day}-${randomUUID()}.jsonl`);
      const fd = openSync(current, 'a', 0o600);
      try {
        appendFileSync(fd, line, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}
