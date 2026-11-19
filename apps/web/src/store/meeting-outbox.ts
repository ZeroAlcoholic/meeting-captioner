import {
  CommitReceipt,
  type ArchivedSegment,
  type ArchivedTranslation,
  type MeetingEnvelope,
  type MeetingMetadata,
  type GapRecord,
} from '@meeting-audio/contracts';

export type PendingEnvelope = Omit<MeetingEnvelope, 'revision'>;
export type StorageLossGap = Extract<GapRecord, { alignment: 'estimated' }> & {
  storageLoss: { lostCount: number };
};
export type RestoreIntent = {
  backupId: string;
  generation: string;
  previousGeneration: string | null;
};
export interface DurableMeetingStore {
  bindArchiveGeneration(generation: string | null): Promise<void>;
  retireForRestore(generation: string, preservePending?: boolean): Promise<void>;
  exportRetired(): Promise<Blob>;
  readRestoreIntent(): Promise<RestoreIntent | null>;
  saveRestoreIntent(intent: RestoreIntent): Promise<void>;
  clearRestoreIntent(generation: string): Promise<void>;
  saveLoss(gap: StorageLossGap): Promise<void>;
  readLosses(meetingId: string): Promise<StorageLossGap[]>;
  getWriterId(): Promise<string>;
  saveMeeting(meeting: MeetingMetadata): Promise<void>;
  listMeetings(): Promise<MeetingMetadata[]>;
  seedRevisions(
    meetingId: string,
    segments: Pick<ArchivedSegment, 'segmentId' | 'revision'>[],
    translations?: Pick<ArchivedTranslation, 'sourceSegmentId' | 'revision'>[],
  ): Promise<void>;
  append(event: PendingEnvelope): Promise<MeetingEnvelope>;
  readBatch(): Promise<MeetingEnvelope[]>;
  acknowledge(ids: string[]): Promise<void>;
  count(): Promise<number>;
}
export type OutboxStatus = {
  pendingCount: number;
  memoryBytes: number;
  lostCount: number;
  unsavedSince: string | null;
  unsavedUntil: string | null;
  error: string | null;
};
const MAX_MEMORY = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 240 * 1024;
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Separate database: legacy caption retention/reset can never purge this queue. */
export class IndexedDbMeetingStore implements DurableMeetingStore {
  private expectedGeneration: string | null | undefined;
  constructor(private readonly databaseName = 'meeting-audio-outbox') {}
  readRestoreIntent(): Promise<RestoreIntent | null> {
    return this.transaction(['identity'], 'readonly', (tx, result) => {
      const read = tx.objectStore('identity').get('restoreIntent');
      read.onsuccess = () => result(read.result ?? null);
    });
  }
  clearRestoreIntent(generation: string): Promise<void> {
    return this.transaction(['identity'], 'readwrite', (tx, result, fail) => {
      const identity = tx.objectStore('identity');
      const read = identity.get('restoreIntent');
      read.onsuccess = () => {
        if (read.result?.generation !== generation) {
          fail(new Error('ARCHIVE_RESTORE_SUPERSEDED'));
          return;
        }
        identity.delete('restoreIntent');
        result(undefined);
      };
    });
  }
  saveRestoreIntent(intent: RestoreIntent): Promise<void> {
    return this.transaction(['identity'], 'readwrite', (tx, result, fail) => {
      const identity = tx.objectStore('identity');
      const read = identity.get('restoreIntent');
      read.onsuccess = () => {
        if (read.result) {
          fail(new Error('ARCHIVE_RESTORE_PENDING'));
          return;
        }
        identity.put(intent, 'restoreIntent');
        result(undefined);
      };
    });
  }

  async bindArchiveGeneration(generation: string | null): Promise<void> {
    if (generation !== null && !/^[a-f0-9-]{36}$/.test(generation))
      throw new Error('ARCHIVE_GENERATION_INVALID');
    await this.transaction(
      ['identity', 'meetings', 'revisions', 'events'],
      'readwrite',
      (tx, result, fail) => {
        if (generation === this.expectedGeneration) {
          result(undefined);
          return;
        }
        let remaining = 4;
        let empty = true;
        const checked = () => {
          if (--remaining) return;
          if (!empty) {
            fail(new Error('ARCHIVE_GENERATION_MISMATCH'));
            return;
          }
          tx.objectStore('identity').put(generation, 'archiveGeneration');
          result(undefined);
        };
        for (const name of ['meetings', 'revisions', 'events']) {
          const request = tx.objectStore(name).count();
          request.onsuccess = () => {
            empty &&= request.result === 0;
            checked();
          };
        }
        const keys = tx.objectStore('identity').getAllKeys();
        keys.onsuccess = () => {
          empty &&= keys.result.every((key) => key === 'writerId' || key === 'archiveGeneration');
          checked();
        };
      },
    );
    this.expectedGeneration = generation;
  }

  /** Explicit post-restore transition. This instance stays fenced; reopen after reload. */
  async retireForRestore(generation: string, preservePending = false): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('ARCHIVE_GENERATION_INVALID');
    await this.transaction(
      ['identity', 'meetings', 'revisions', 'events'],
      'readwrite',
      (tx, result, fail) => {
        if (generation === this.expectedGeneration) {
          fail(new Error('ARCHIVE_GENERATION_INVALID'));
          return;
        }
        const pending = tx.objectStore('events').count();
        pending.onsuccess = () => {
          if (pending.result && !preservePending) {
            fail(new Error('ARCHIVE_PENDING_DATA'));
            return;
          }
          const identity = tx.objectStore('identity');
          if (preservePending) {
            // Move records in this same transaction. A failed write aborts both
            // retirement and generation change; the original queue stays intact.
            for (const source of ['meetings', 'events']) {
              const read = tx.objectStore(source).openCursor();
              read.onsuccess = () => {
                const item = read.result;
                if (!item) return;
                const value = source === 'events' ? item.value.event : item.value;
                const key =
                  source === 'events' ? `event:${value.eventId}` : `meeting:${value.meetingId}`;
                identity.put(value, `retired:${this.expectedGeneration ?? 'legacy'}:${key}`);
                item.delete();
                item.continue();
              };
            }
          }
          const cursor = identity.openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) {
              if (!preservePending) tx.objectStore('meetings').clear();
              tx.objectStore('revisions').clear();
              identity.put(generation, 'archiveGeneration');
              identity.delete('restoreIntent');
              result(undefined);
              return;
            }
            if (typeof item.key === 'string' && item.key.startsWith('loss:')) {
              identity.put(
                item.value,
                `retired:${this.expectedGeneration ?? 'legacy'}:${item.key}`,
              );
              item.delete();
            }
            item.continue();
          };
        };
      },
    );
  }

  /** Local-only JSON Lines: original identities and envelopes, never replayed into the new archive. */
  exportRetired(): Promise<Blob> {
    return this.transaction(['identity'], 'readonly', (tx, result) => {
      const parts: BlobPart[] = [];
      const request = tx
        .objectStore('identity')
        .openCursor(IDBKeyRange.bound('retired:', 'retired:\uffff'));
      request.onsuccess = () => {
        const item = request.result;
        if (!item) {
          result(new Blob(parts, { type: 'application/x-ndjson' }));
          return;
        }
        parts.push(JSON.stringify({ key: item.key, value: item.value }) + '\n');
        item.continue();
      };
    });
  }

  saveLoss(gap: StorageLossGap): Promise<void> {
    return this.transaction(['identity'], 'readwrite', (tx) => {
      tx.objectStore('identity').put(gap, `loss:${gap.meetingId}:${gap.gapId}`);
    });
  }
  readLosses(meetingId: string): Promise<StorageLossGap[]> {
    return this.transaction(['identity'], 'readonly', (tx, result) => {
      const prefix = `loss:${meetingId}:`;
      const request = tx
        .objectStore('identity')
        .getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => result(request.result as StorageLossGap[]);
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(this.databaseName, 2);
      let failed = false;
      request.onupgradeneeded = (event) => {
        // Version 2 fences old v1 clients without rewriting their queued data.
        if (event.oldVersion !== 0) return;
        const db = request.result;
        db.createObjectStore('identity');
        db.createObjectStore('meetings', { keyPath: 'meetingId' });
        db.createObjectStore('revisions');
        const events = db.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true });
        events.createIndex('eventId', 'event.eventId', { unique: true });
      };
      request.onerror = () => {
        failed = true;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error('IndexedDB upgrade blocked'));
      };
      request.onsuccess = () => {
        if (failed) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void,
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        // Complete, not request.success, is the browser durability boundary.
        const tx = db.transaction(
          [...new Set(['identity', ...stores])],
          mode,
          mode === 'readwrite' ? { durability: 'strict' } : undefined,
        );
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const fail = (error: Error) => {
          tx.abort();
          reject(error);
        };
        const generation = tx.objectStore('identity').get('archiveGeneration');
        generation.onsuccess = () => {
          const actual = (generation.result ?? null) as string | null;
          if (this.expectedGeneration === undefined) this.expectedGeneration = actual;
          if (actual !== this.expectedGeneration) {
            fail(new Error('ARCHIVE_GENERATION_MISMATCH'));
            return;
          }
          try {
            run(
              tx,
              (result) => {
                value = result;
              },
              fail,
            );
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
      });
    } finally {
      db.close();
    }
  }

  getWriterId(): Promise<string> {
    return this.transaction(['identity'], 'readwrite', (tx, result) => {
      const store = tx.objectStore('identity');
      const request = store.get('writerId');
      request.onsuccess = () => {
        const id = (request.result as string | undefined) ?? crypto.randomUUID();
        if (!request.result) store.put(id, 'writerId');
        result(id);
      };
    });
  }
  saveMeeting(meeting: MeetingMetadata): Promise<void> {
    return this.transaction(['meetings'], 'readwrite', (tx) => {
      tx.objectStore('meetings').put(meeting);
    });
  }
  listMeetings(): Promise<MeetingMetadata[]> {
    return this.transaction(['meetings'], 'readonly', (tx, result) => {
      const request = tx.objectStore('meetings').getAll();
      request.onsuccess = () => result(request.result as MeetingMetadata[]);
    });
  }
  seedRevisions(
    meetingId: string,
    segments: Pick<ArchivedSegment, 'segmentId' | 'revision'>[],
    translations: Pick<ArchivedTranslation, 'sourceSegmentId' | 'revision'>[] = [],
  ): Promise<void> {
    return this.transaction(['revisions'], 'readwrite', (tx) => {
      const store = tx.objectStore('revisions');
      const revisions = [
        ...segments.map((segment) => ({
          key: `${meetingId}:transcript:${segment.segmentId}`,
          revision: segment.revision,
        })),
        ...translations.map((translation) => ({
          key: `${meetingId}:translation:${translation.sourceSegmentId}`,
          revision: translation.revision,
        })),
      ];
      for (const { key, revision } of revisions) {
        const request = store.get(key);
        request.onsuccess = () => store.put(Math.max(Number(request.result ?? 0), revision), key);
      }
    });
  }
  append(draft: PendingEnvelope): Promise<MeetingEnvelope> {
    return this.transaction(['events', 'revisions'], 'readwrite', (tx, result) => {
      const p = draft.payload;
      const kind = p.kind === 'correction' ? 'transcript' : p.kind;
      const id =
        p.kind === 'transcript' || p.kind === 'correction'
          ? p.segmentId
          : p.kind === 'translation'
            ? p.sourceSegmentId
            : p.gap.gapId;
      const key = `${draft.meetingId}:${kind}:${id}`;
      const revisions = tx.objectStore('revisions');
      const request = revisions.get(key);
      request.onsuccess = () => {
        const revision =
          Math.max(
            (request.result as number | undefined) ?? 0,
            p.kind === 'correction' ? p.baseRevision : 0,
          ) + 1;
        const event: MeetingEnvelope = { ...draft, revision };
        tx.objectStore('events').add({ event, bytes: byteSize(event) });
        revisions.put(revision, key);
        result(event);
      };
    });
  }
  readBatch(): Promise<MeetingEnvelope[]> {
    return this.transaction(['events'], 'readonly', (tx, result) => {
      const events: MeetingEnvelope[] = [];
      let bytes = 0;
      const request = tx.objectStore('events').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          result(events);
          return;
        }
        const row = cursor.value as { event: MeetingEnvelope; bytes: number };
        if (
          events.length &&
          (events.length >= 100 ||
            bytes + row.bytes > MAX_BATCH_BYTES ||
            events[0]!.meetingId !== row.event.meetingId)
        ) {
          result(events);
          return;
        }
        events.push(row.event);
        bytes += row.bytes;
        cursor.continue();
      };
    });
  }
  acknowledge(ids: string[]): Promise<void> {
    return this.transaction(['events'], 'readwrite', (tx) => {
      const store = tx.objectStore('events');
      for (const id of ids) {
        const request = store.index('eventId').getKey(id);
        request.onsuccess = () => {
          if (request.result !== undefined) store.delete(request.result);
        };
      }
    });
  }
  count(): Promise<number> {
    return this.transaction(['events'], 'readonly', (tx, result) => {
      const request = tx.objectStore('events').count();
      request.onsuccess = () => result(request.result);
    });
  }
}

/** Bounded RAM staging; only durably committed records are returned to HTTP. */
export class MeetingOutbox {
  private selectedMeeting: string | null = null;
  private lossReadPending = false;
  private losses = new Map<string, StorageLossGap>();
  private queue: { event: PendingEnvelope; bytes: number }[] = [];
  private writing: Promise<void> | null = null;
  private ready = false;
  private listeners = new Set<() => void>();
  private status: OutboxStatus = {
    pendingCount: 0,
    memoryBytes: 0,
    lostCount: 0,
    unsavedSince: null,
    unsavedUntil: null,
    error: null,
  };
  constructor(
    readonly store: DurableMeetingStore,
    private readonly maxMemory = MAX_MEMORY,
  ) {}
  async selectMeeting(meetingId: string): Promise<void> {
    this.selectedMeeting = meetingId;
    this.lossReadPending = true;
    this.update({
      lostCount: 0,
      unsavedSince: null,
      unsavedUntil: null,
      error: this.status.error === 'memory_limit' ? null : this.status.error,
    });
    await this.restoreLossStatus(meetingId);
  }
  private async restoreLossStatus(meetingId: string): Promise<void> {
    const gaps = await this.lossGaps(meetingId);
    if (this.selectedMeeting !== meetingId) return;
    this.lossReadPending = false;
    this.update({
      lostCount: gaps.reduce((sum, gap) => sum + gap.storageLoss.lostCount, 0),
      unsavedSince: gaps.length ? gaps.map((g) => g.wallClock.startAt).sort()[0]! : null,
      unsavedUntil: gaps.length
        ? gaps
            .map((g) => g.wallClock.endAt)
            .sort()
            .at(-1)!
        : null,
      ...(gaps.length ? { error: 'memory_limit' } : {}),
    });
  }
  async lossGaps(meetingId: string): Promise<StorageLossGap[]> {
    const stored = await this.store.readLosses(meetingId);
    const pending = this.losses.get(meetingId);
    return [
      ...new Map([...stored, ...(pending ? [pending] : [])].map((g) => [g.gapId, g])).values(),
    ];
  }
  /** Do not open another meeting while a permanent-loss marker exists only in RAM. */
  async settleLosses(): Promise<void> {
    if (this.losses.size) await this.flushToDisk();
  }
  async initialize(): Promise<void> {
    this.update({ pendingCount: (await this.store.count()) + this.queue.length });
    this.ready = true;
  }
  /** Drafts staged during an IDB outage acquire the durable writer before their first commit. */
  assignWriterId(writerId: string): void {
    if (this.ready) return;
    for (const item of this.queue) item.event.writerId = writerId;
  }
  getStatus = (): OutboxStatus => this.status;
  hasVolatileData = (): boolean => this.queue.length > 0 || this.losses.size > 0;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<OutboxStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  enqueue(event: PendingEnvelope): void {
    const bytes = byteSize(event);
    if (bytes > MAX_BATCH_BYTES || bytes + this.status.memoryBytes > this.maxMemory) {
      const previous = this.losses.get(event.meetingId);
      const gap: StorageLossGap = {
        gapId: previous?.gapId ?? crypto.randomUUID(),
        meetingId: event.meetingId,
        trackId: 'storage',
        captureEpoch: event.writerId,
        state: 'unrecoverable',
        alignment: 'estimated',
        cause: 'memory_limit',
        wallClock: {
          startAt: previous
            ? [previous.wallClock.startAt, event.observedAt].sort()[0]!
            : event.observedAt,
          endAt: previous
            ? [previous.wallClock.endAt, event.observedAt].sort().at(-1)!
            : event.observedAt,
        },
        storageLoss: { lostCount: (previous?.storageLoss.lostCount ?? 0) + 1 },
      };
      this.losses.set(event.meetingId, gap);
      if (this.selectedMeeting === null || this.selectedMeeting === event.meetingId)
        this.update({
          lostCount: this.status.lostCount + 1,
          unsavedSince: [this.status.unsavedSince ?? event.observedAt, event.observedAt].sort()[0]!,
          unsavedUntil: [this.status.unsavedUntil ?? event.observedAt, event.observedAt]
            .sort()
            .at(-1)!,
          error: 'memory_limit',
        });
      return;
    }
    this.queue.push({ event: structuredClone(event), bytes });
    this.update({
      pendingCount: this.status.pendingCount + 1,
      memoryBytes: this.status.memoryBytes + bytes,
    });
    if (this.ready)
      void this.flushToDisk().catch(() => {
        /* surfaced in status; client schedules retry */
      });
  }
  flushToDisk(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = this.persist().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }
  private async persist(): Promise<void> {
    try {
      if (this.lossReadPending && this.selectedMeeting)
        await this.restoreLossStatus(this.selectedMeeting);
      while (this.losses.size || this.queue.length) {
        if (this.losses.size) {
          const [meetingId, gap] = this.losses.entries().next().value!;
          await this.store.saveLoss(gap);
          if (this.losses.get(meetingId) === gap) this.losses.delete(meetingId);
          continue;
        }
        const next = this.queue[0]!;
        await this.store.append(next.event);
        this.queue.shift();
        this.update({
          memoryBytes: this.status.memoryBytes - next.bytes,
          error: this.status.lostCount ? 'memory_limit' : null,
        });
      }
      this.update({ error: this.status.lostCount ? 'memory_limit' : null });
    } catch (error) {
      this.update({ error: 'local_storage_unavailable' });
      throw error;
    }
  }
  readBatch(): Promise<MeetingEnvelope[]> {
    return this.store.readBatch();
  }
  async acknowledge(batch: MeetingEnvelope[], receipt: CommitReceipt): Promise<void> {
    const parsed = CommitReceipt.parse(receipt);
    const expected = new Set(batch.map((event) => event.eventId));
    if (
      !batch.length ||
      batch.some((e) => e.meetingId !== parsed.meetingId) ||
      parsed.committedEventIds.length !== expected.size ||
      new Set(parsed.committedEventIds).size !== expected.size ||
      parsed.committedEventIds.some((id) => !expected.has(id))
    )
      throw new Error('Commit receipt does not match batch');
    await this.store.acknowledge(parsed.committedEventIds);
    this.update({ pendingCount: Math.max(0, this.status.pendingCount - batch.length) });
  }
}
