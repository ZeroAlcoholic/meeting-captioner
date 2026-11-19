import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  CommitReceipt,
  FinalizeInput,
  MeetingEnvelope,
  MeetingManifest,
  MeetingMetadata,
  MeetingSnapshot,
  MeetingPage,
  MeetingRevisionPage,
  MeetingListing,
} from '@meeting-audio/contracts';
import type { ExportFormat, ExportVariant } from './meeting-export.js';

/** Stable across working directories and release upgrades. */
export function meetingDataDir(): string {
  return join(process.env['LOCALAPPDATA'] || join(homedir(), '.local', 'share'), 'MeetingAudio');
}

export class MeetingRepository {
  private readonly dataDir: string;
  private readonly worker: Worker;
  private sequence = 0;
  private closed = false;
  private closing = false;
  private restoring = false;
  private importing = false;
  private closePromise: Promise<void> | undefined;
  private terminationReason: Error | null = null;
  private readonly requestTimeoutMs: number;
  private diagnosticFailure: string | null = null;
  private failure: Error | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(options: { dataDir?: string; workerPath: string | URL; requestTimeoutMs?: number }) {
    const dataDir = options.dataDir ?? meetingDataDir();
    this.dataDir = dataDir;
    if (!isAbsolute(dataDir)) throw new Error('ARCHIVE_PATH_MUST_BE_ABSOLUTE');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 1)
      throw new Error('INVALID_ARCHIVE_TIMEOUT');
    this.worker = new Worker(options.workerPath, { workerData: { dataDir } });
    this.worker.on(
      'message',
      (message: { id: number; value?: unknown; error?: string; diagnosticError?: string }) => {
        if ('diagnosticError' in message) this.diagnosticFailure = message.diagnosticError ?? null;
        const request = this.pending.get(message.id);
        if (!request) return;
        if (message.error === 'ARCHIVE_RESTORE_RECOVERY_REQUIRED') {
          this.failure = new Error(message.error);
          void this.worker.terminate();
        }
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
      },
    );
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(this.failure);
      }
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () =>
      fail(this.terminationReason ?? new Error('ARCHIVE_WRITER_EXITED')),
    );
  }
  get failed(): boolean {
    return this.failure !== null;
  }
  get diagnosticError(): string | null {
    return this.diagnosticFailure;
  }
  private call<T>(method: string, args: unknown): Promise<T> {
    if (this.restoring && method !== 'restoreBackup')
      return Promise.reject(new Error('ARCHIVE_RESTORING'));
    if (this.failure || this.closed || (this.closing && method !== 'close'))
      return Promise.reject(this.failure ?? new Error('ARCHIVE_CLOSED'));
    if (this.pending.size >= 64) return Promise.reject(new Error('ARCHIVE_BUSY'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.terminationReason ??= new Error('ARCHIVE_TIMEOUT');
          // Reject only on exit: a caller may safely replace this writer afterwards.
          void this.worker.terminate();
        },
        method === 'close' ? Math.min(3000, this.requestTimeoutMs) : this.requestTimeoutMs,
      );
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  createMeeting(metadata: MeetingMetadata): Promise<MeetingMetadata> {
    return this.call('createMeeting', metadata);
  }
  commitEvents(events: MeetingEnvelope[]): Promise<CommitReceipt> {
    return this.call('commitEvents', events);
  }
  snapshot(meetingId: string): Promise<MeetingSnapshot> {
    return this.call('snapshot', meetingId);
  }
  listMeetings(): Promise<MeetingListing[]> {
    return this.call('listMeetings', null);
  }
  readPage(meetingId: string, offset = 0, limit = 100): Promise<MeetingPage> {
    return this.call('readPage', { meetingId, offset, limit });
  }
  readRevisions(meetingId: string, offset = 0, limit = 200): Promise<MeetingRevisionPage> {
    return this.call('readRevisions', { meetingId, offset, limit });
  }
  finalize(meetingId: string, input: FinalizeInput): Promise<MeetingManifest> {
    return this.call('finalize', { meetingId, input });
  }
  backup(): Promise<string> {
    return this.call('backup', null);
  }
  async importBackup(source: Readable, manifest: string): Promise<string> {
    if (this.importing || this.restoring) throw new Error('ARCHIVE_BUSY');
    if (Buffer.byteLength(manifest) > 4096) throw new Error('ARCHIVE_BACKUP_MANIFEST_INVALID');
    const importId = 'import-' + randomUUID();
    const root = join(this.dataDir, importId);
    const directory = join(root, 'backup-' + importId.slice(7));
    let bytes = 0;
    this.importing = true;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'manifest.json'), manifest, { flag: 'wx', flush: true });
      const path = join(directory, 'meetings.sqlite');
      await pipeline(
        source,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(
              bytes > 512 * 1024 * 1024 ? new Error('ARCHIVE_BACKUP_TOO_LARGE') : null,
              chunk,
            );
          },
        }),
        createWriteStream(path, { flags: 'wx' }),
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!bytes) throw new Error('ARCHIVE_BACKUP_EMPTY');
      const file = await open(path, 'r+');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      return await this.call('importBackup', importId);
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        this.importing = false;
      }
    }
  }
  archiveGeneration(): Promise<string | null> {
    return this.call('archiveGeneration', null);
  }
  backupFile(backupId: string, file: 'meetings.sqlite' | 'manifest.json'): Promise<string> {
    return this.call('backupFile', { backupId, file });
  }
  async restoreBackup(
    backupId: string,
    generation?: string,
  ): Promise<{ safetyBackupPath: string }> {
    if (this.restoring || this.importing || this.pending.size > 0) throw new Error('ARCHIVE_BUSY');
    this.restoring = true;
    try {
      return await this.call('restoreBackup', { backupId, generation });
    } finally {
      this.restoring = false;
    }
  }
  export(meetingId: string, variant: ExportVariant, format: ExportFormat): Promise<string> {
    return this.call('export', { meetingId, variant, format });
  }
  refreshExports(meetingId: string): Promise<void> {
    return this.call('refreshExports', meetingId);
  }
  close(): Promise<void> {
    this.closePromise ??= this.closeWriter();
    return this.closePromise;
  }
  private async closeWriter(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      if (!this.failure) await this.call('close', null);
    } catch {
      /* Shutdown still terminates a failed or timed-out writer. */
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
  }
}
