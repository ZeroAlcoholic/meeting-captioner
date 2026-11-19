import {
  ArchiveServiceIdentity,
  MeetingMetadata as MeetingMetadataSchema,
  type ArchivedSegment,
  type ArchivedTranslation,
  type CommitReceipt,
  type FinalizeInput,
  type GapRecord,
  type HealthEvent,
  type MeetingListing,
  type MeetingManifest,
  type MeetingMetadata,
  type MeetingPayload,
  type MeetingRevisionPage,
  type TranscriptEvent,
  type TranslationEvent,
} from '@meeting-audio/contracts';
import {
  IndexedDbMeetingStore,
  MeetingOutbox,
  type DurableMeetingStore,
  type OutboxStatus,
  type RestoreIntent,
} from './meeting-outbox.js';

export type ArchivePage = {
  meeting: MeetingMetadata;
  segments: ArchivedSegment[];
  translations?: Record<string, ArchivedTranslation>;
  manifest: MeetingManifest | null;
  lastSequence: number;
  totalSegments: number;
};
export type PersistenceStatus = OutboxStatus & {
  state: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'read_only';
  meetingId: string | null;
  dataDirectory: string | null;
  lastSavedAt: string | null;
  finalizing: boolean;
  manifest: MeetingManifest | null;
  exportFailure: boolean;
  retryBlocked: boolean;
  restorePending?: boolean;
};
export class ArchiveRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(`Local archive request failed (${status}${code ? `, ${code}` : ''})`);
  }
}
type Options = { store?: DurableMeetingStore; fetcher?: typeof fetch; baseUrl?: string };
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const PARTIAL_MEMORY = 512 * 1024;

/** Local-only persistence sidecar. Its callbacks never wait on disk or HTTP. */
function isGenerationMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'ARCHIVE_GENERATION_MISMATCH' ||
      (error instanceof ArchiveRequestError && error.code === 'ARCHIVE_GENERATION_MISMATCH'))
  );
}

export class MeetingArchiveClient {
  readonly outbox: MeetingOutbox;
  private readonly store: DurableMeetingStore;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly ownerId = crypto.randomUUID(); // intentionally never sessionStorage (cloned tabs)
  private writerId: string | null = null;
  private token: string | null = null;
  private serviceIdentity: ArchiveServiceIdentity | null = null;
  private archiveGeneration: string | null = null;
  private lease: { leaseToken: string; expiresAt: number } | null = null;
  private meeting: MeetingMetadata | null = null;
  // Losing write authorization must not discard captions from an admitted capture.
  private acceptedMeetingId: string | null = null;
  private initialized: Promise<void> | null = null;
  private localReady: Promise<void> | null = null;
  private pendingMetadata = new Map<string, MeetingMetadata>();
  private flushing: Promise<CommitReceipt[]> | null = null;
  private ownershipRetry: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private partials = new Map<
    string,
    { meetingId: string; event: TranscriptEvent | TranslationEvent }
  >();
  private partialBytes = 0;
  private failures = 0;
  private disposed = false;
  private restoring = false;
  private pendingRestore: RestoreIntent | null = null;
  private registered = new Set<string>();
  private requests = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private unsubscribeOutbox: (() => void) | null = null;
  private correctionChain: Promise<void> = Promise.resolve();
  private finalizationIntents = new Map<string, Partial<FinalizeInput>>();
  private finalizationResults = new Map<string, MeetingManifest>();
  private status: PersistenceStatus = {
    pendingCount: 0,
    memoryBytes: 0,
    lostCount: 0,
    unsavedSince: null,
    unsavedUntil: null,
    error: null,
    state: 'idle',
    meetingId: null,
    dataDirectory: null,
    lastSavedAt: null,
    finalizing: false,
    manifest: null,
    exportFailure: false,
    retryBlocked: false,
  };

  constructor(options: Options = {}) {
    this.store = options.store ?? new IndexedDbMeetingStore();
    this.outbox = new MeetingOutbox(this.store, 16 * 1024 * 1024 - PARTIAL_MEMORY * 2);
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  }
  getStatus = (): PersistenceStatus => this.status;
  /** This is synchronous: page exit cannot wait for IndexedDB or HTTP. */
  beforeUnload = (event: BeforeUnloadEvent): void => {
    this.checkpoint();
    if (this.pendingMetadata.size || this.outbox.hasVolatileData()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  getCurrentMeeting = (): MeetingMetadata | null => this.meeting;
  getArchiveGeneration = (): string | null => this.archiveGeneration;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<PersistenceStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private syncOutbox(): void {
    const box = this.outbox.getStatus();
    this.update({
      ...box,
      pendingCount: box.pendingCount + this.partials.size,
      memoryBytes: box.memoryBytes + this.partialBytes,
      error:
        this.status.state === 'read_only' && this.status.error === 'archive_generation_changed'
          ? this.status.error
          : (box.error ?? this.status.error),
      state:
        this.status.state === 'read_only'
          ? 'read_only'
          : box.error
            ? 'error'
            : box.pendingCount + this.partials.size
              ? 'pending'
              : this.status.state,
    });
  }

  initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.unsubscribeOutbox ??= this.outbox.subscribe(() => this.syncOutbox());
    this.initialized = (async () => {
      await this.prepareLocal();
      if (this.pendingRestore) throw new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH');
      await this.bootstrap();
    })().catch((error) => {
      this.initialized = null;
      this.fail(error);
      throw error;
    });
    return this.initialized;
  }
  /** Fresh local-only availability check; no meeting, writer lease or transcript mutation. */
  async checkPendingRestore(): Promise<void> {
    await this.prepareLocal();
  }
  async checkAvailability(): Promise<void> {
    await this.prepareLocal();
    if (this.pendingRestore) throw new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH');
    const info = await this.request<{
      storageAvailable: boolean;
      archiveGeneration?: string | null;
      serviceIdentity?: unknown;
    }>('/local/bootstrap', {}, false);
    if (!info.storageAvailable) throw new Error('local_storage_unavailable');
    this.acceptServiceIdentity(info.serviceIdentity);
    await this.store.bindArchiveGeneration(info.archiveGeneration ?? null);
  }
  private prepareLocal(): Promise<void> {
    if (this.localReady) return this.localReady;
    this.unsubscribeOutbox ??= this.outbox.subscribe(() => this.syncOutbox());
    this.localReady = (async () => {
      this.writerId = await this.store.getWriterId();
      this.outbox.assignWriterId(this.writerId);
      await this.outbox.initialize();
      this.pendingRestore = await this.store.readRestoreIntent();
      this.update({ restorePending: this.pendingRestore !== null });
    })().catch((error) => {
      this.localReady = null;
      throw error;
    });
    return this.localReady;
  }
  private async persistMetadata(): Promise<void> {
    for (const [id, metadata] of this.pendingMetadata) {
      await this.store.saveMeeting(metadata);
      this.pendingMetadata.delete(id);
    }
  }
  private async bootstrap(): Promise<void> {
    const info = await this.request<{
      token: string;
      dataDirectory: string;
      storageAvailable: boolean;
      archiveGeneration?: string | null;
      serviceIdentity?: unknown;
    }>('/local/bootstrap', {}, false);
    if (!info.token || !info.storageAvailable) throw new Error('local_storage_unavailable');
    this.acceptServiceIdentity(info.serviceIdentity);
    const generation = info.archiveGeneration ?? null;
    try {
      await this.store.bindArchiveGeneration(generation);
    } catch (error) {
      if (isGenerationMismatch(error))
        throw new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH');
      throw error;
    }
    this.archiveGeneration = generation;
    this.token = info.token;
    this.lease = null;
    this.registered.clear();
    this.update({ dataDirectory: info.dataDirectory });
    if (this.status.error === 'service_identity_changed')
      this.update({ error: null, retryBlocked: false });
  }
  private acceptServiceIdentity(value: unknown): void {
    const parsed = ArchiveServiceIdentity.safeParse(value);
    if (
      (value !== undefined && !parsed.success) ||
      (this.serviceIdentity &&
        (!parsed.success ||
          this.serviceIdentity.workspaceId !== parsed.data.workspaceId ||
          this.serviceIdentity.buildId !== parsed.data.buildId))
    ) {
      const error = new ArchiveRequestError(409, 'SERVICE_IDENTITY_MISMATCH');
      this.fail(error);
      throw error;
    }
    if (parsed.success) this.serviceIdentity = parsed.data;
  }
  private async request<T>(
    path: string,
    body?: unknown,
    authorized = true,
    write = false,
    timeoutMs = 5000,
  ): Promise<T> {
    if (this.disposed) throw new Error('Archive client disposed');
    if (write && !this.lease) throw new Error('Writer lease unavailable');
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers();
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (authorized && this.token) headers.set('Authorization', `Bearer ${this.token}`);
      if (authorized && this.serviceIdentity) {
        headers.set('X-Meeting-Workspace', this.serviceIdentity.workspaceId);
        headers.set('X-Meeting-Build', this.serviceIdentity.buildId);
      }
      if (authorized && this.archiveGeneration)
        headers.set('X-Meeting-Generation', this.archiveGeneration);
      if (write && this.lease) headers.set('X-Meeting-Lease', this.lease.leaseToken);
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const known = [
          'WRITER_LEASE_REQUIRED',
          'ANOTHER_TAB_IS_WRITING',
          'REVISION_CONFLICT',
          'EVENT_ID_CONFLICT',
          'MEETING_METADATA_CONFLICT',
          'MEETING_NOT_FOUND',
          'SQLITE_FULL',
          'INVALID_MEETING_EVENTS',
          'ARCHIVE_GENERATION_MISMATCH',
          'SERVICE_IDENTITY_MISMATCH',
        ];
        const code =
          typeof value?.error === 'string' && known.includes(value.error) ? value.error : null;
        const error = new ArchiveRequestError(response.status, code);
        if (code === 'SERVICE_IDENTITY_MISMATCH') this.fail(error);
        throw error;
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
  private async authorizeWriter(explicitRetry = false): Promise<void> {
    if (this.status.state === 'read_only' && !explicitRetry)
      throw new ArchiveRequestError(
        409,
        this.status.error === 'archive_generation_changed' ? 'ARCHIVE_GENERATION_MISMATCH' : null,
      );
    if (!this.token) await this.bootstrap();
    if (this.lease) {
      if (!this.renewTimer) this.scheduleRenewal();
      return;
    }
    try {
      this.lease = await this.request('/meetings/lease', {
        writerId: this.writerId,
        ownerId: this.ownerId,
      });
      this.scheduleRenewal();
    } catch (error) {
      if (error instanceof ArchiveRequestError && error.status === 409)
        this.update({ state: 'read_only', error: 'writer_conflict' });
      throw error;
    }
  }
  private scheduleRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.disposed || !this.lease) return;
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      const leaseToken = this.lease?.leaseToken;
      const token = this.token;
      if (!leaseToken || !token) return;
      void this.request<{ leaseToken: string; expiresAt: number; exportFailure?: boolean }>(
        '/meetings/lease/renew',
        {},
        true,
        true,
      )
        .then((lease) => {
          if (this.token !== token || this.lease?.leaseToken !== leaseToken) return;
          this.lease = { leaseToken: lease.leaseToken || leaseToken, expiresAt: lease.expiresAt };
          if (lease.exportFailure !== undefined) this.updateExportFailure(lease.exportFailure);
          this.scheduleRenewal();
        })
        .catch((error) => {
          if (this.token !== token || this.lease?.leaseToken !== leaseToken) return;
          this.fail(error);
          this.scheduleRetry();
        });
    }, 5000);
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    if (error instanceof ArchiveRequestError && error.code === 'SERVICE_IDENTITY_MISMATCH') {
      this.token = null;
      this.lease = null;
      if (this.retry) clearTimeout(this.retry);
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.retry = this.renewTimer = null;
      this.update({ state: 'error', retryBlocked: true, error: 'service_identity_changed' });
      return;
    }
    if (this.status.error === 'service_identity_changed') return;
    if (isGenerationMismatch(error)) {
      this.lease = null;
      if (this.retry) clearTimeout(this.retry);
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.retry = null;
      this.renewTimer = null;
      this.update({ state: 'read_only', retryBlocked: true, error: 'archive_generation_changed' });
      return;
    }
    if (this.status.state === 'read_only' && this.status.error === 'archive_generation_changed')
      return;
    // Retain the durable queue, but do not repeatedly send an unchanged request
    // that cannot succeed. An explicit flush retries after the service is fixed.
    if (error instanceof ArchiveRequestError && [400, 413, 422].includes(error.status)) {
      this.update({ retryBlocked: true });
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
    }
    if (error instanceof ArchiveRequestError && error.status === 401) {
      this.token = null;
      this.lease = null;
      this.registered.clear();
    }
    if (
      error instanceof ArchiveRequestError &&
      error.status === 409 &&
      (this.status.state === 'read_only' ||
        error.code === 'WRITER_LEASE_REQUIRED' ||
        error.code === 'ANOTHER_TAB_IS_WRITING')
    ) {
      this.lease = null;
      this.update({ state: 'read_only', error: 'writer_conflict' });
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.renewTimer = null;
      return;
    }
    this.update({
      state: 'error',
      error:
        this.outbox.getStatus().error ??
        (error instanceof ArchiveRequestError
          ? (error.code ?? `local_http_${error.status}`)
          : 'local_service_unavailable'),
    });
  }
  private updateExportFailure(exportFailure: boolean): void {
    if (
      this.status.state === 'read_only' ||
      (this.status.error && this.status.error !== 'derived_export_failed')
    ) {
      this.update({ exportFailure });
      return;
    }
    this.update({
      exportFailure,
      ...(exportFailure
        ? ({ state: 'error', error: 'derived_export_failed' } as const)
        : this.status.error === 'derived_export_failed'
          ? ({ error: null, state: this.status.pendingCount ? 'pending' : 'saved' } as const)
          : {}),
    });
  }
  private scheduleRetry(delay?: number): void {
    if (
      this.retry ||
      this.disposed ||
      this.status.retryBlocked ||
      this.status.state === 'read_only'
    )
      return;
    this.retry = setTimeout(
      () => {
        this.retry = null;
        void this.flushPending().catch(() => {
          /* flush schedules its next retry */
        });
      },
      delay ?? RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)],
    );
  }

  async startMeeting(metadata: MeetingMetadata): Promise<void> {
    if (this.restoring || this.pendingRestore) throw new Error('ARCHIVE_RESTORING');
    const next = MeetingMetadataSchema.parse(metadata);
    if (this.meeting?.meetingId !== next.meetingId) {
      this.checkpoint();
      await this.outbox.settleLosses();
    }
    if (this.pendingMetadata.size >= 128 && !this.pendingMetadata.has(next.meetingId))
      throw new Error('Too many meetings awaiting local storage');
    this.meeting = next;
    this.pendingMetadata.set(next.meetingId, next);
    this.update({ meetingId: next.meetingId, manifest: null, finalizing: false });
    try {
      await this.outbox.selectMeeting(next.meetingId);
      await this.prepareLocal();
      await this.initialize();
      await this.persistMetadata();
      await this.authorizeWriter();
      await this.registerMeeting(next);
      this.scheduleRetry(250);
    } catch (error) {
      // Network availability must not prevent durable local metadata capture.
      if (!isGenerationMismatch(error)) await this.persistMetadata().catch(() => {});
      this.fail(error);
      if (
        (error instanceof ArchiveRequestError && error.status === 409) ||
        isGenerationMismatch(error)
      )
        throw error;
      // Local outage never prevents audio start. Metadata is retried with the outbox.
      this.scheduleRetry();
    }
    if (this.meeting?.meetingId === next.meetingId) this.acceptedMeetingId = next.meetingId;
  }
  async continueMeeting(meetingId: string): Promise<MeetingMetadata> {
    // Initial storage failure may leave the admitted meeting only in RAM.
    let metadata = this.pendingMetadata.get(meetingId);
    try {
      metadata ??= (await this.store.listMeetings()).find((m) => m.meetingId === meetingId);
    } catch {
      /* service may still have the archive */
    }
    if (!metadata) metadata = (await this.loadMeeting(meetingId)).meeting;
    // Rebuild the durable counter if browser storage was cleared but the local
    // SQLite archive survived. Pending IDB revisions are retained by max().
    await this.prepareLocal();
    try {
      for await (const page of this.revisionPages(meetingId)) {
        await this.store.seedRevisions(
          meetingId,
          page.revisions.filter((entry) => entry.kind === 'transcript'),
          page.revisions
            .filter((entry) => entry.kind === 'translation')
            .map((entry) => ({ sourceSegmentId: entry.segmentId, revision: entry.revision })),
        );
      }
    } catch (error) {
      // Existing local metadata/revisions allow continuing during a service outage.
      if (
        !this.pendingMetadata.has(meetingId) &&
        !(await this.store.listMeetings()).some((m) => m.meetingId === meetingId)
      )
        throw error;
      this.fail(error);
    }
    await this.startMeeting(metadata);
    return metadata;
  }
  private async *revisionPages(meetingId: string): AsyncGenerator<MeetingRevisionPage> {
    for (let offset = 0; ; ) {
      const page = await this.readAuthorized<MeetingRevisionPage>(
        `/meetings/${encodeURIComponent(meetingId)}/revisions?offset=${offset}&limit=200`,
      );
      yield page;
      if (page.nextOffset === null) return;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
        throw new Error('Invalid revision page cursor');
      offset = page.nextOffset;
    }
  }

  /** Import only missing legacy records; archived edits win and the caller retains its snapshot. */
  async restoreTranslationSnapshot(
    metadata: MeetingMetadata,
    events: Array<TranscriptEvent | TranslationEvent>,
    snapshotGeneration: string | null = null,
  ): Promise<void> {
    if (metadata.captionTask.purpose !== 'translation')
      throw new Error('Translation snapshot required');
    await this.initialize();
    if (snapshotGeneration !== this.archiveGeneration) {
      const error = new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH');
      this.fail(error);
      throw error;
    }
    try {
      await this.continueMeeting(metadata.meetingId);
    } catch (error) {
      if (
        !(
          error instanceof ArchiveRequestError &&
          error.status === 404 &&
          error.code === 'MEETING_NOT_FOUND'
        )
      )
        throw error;
      await this.startMeeting(metadata);
    }
    const writer = this.bindCurrentMeeting();
    // Recover an interrupted import's outbox before deciding which snapshot records are missing.
    this.checkpoint();
    await this.flushPending();
    const missing = new Map(
      events.map((event) => [
        `${event.kind}:${event.kind === 'transcript' ? event.segmentId : event.sourceSegmentId}`,
        event,
      ]),
    );
    for await (const page of this.revisionPages(metadata.meetingId))
      for (const revision of page.revisions)
        missing.delete(`${revision.kind}:${revision.segmentId}`);
    let count = 0;
    for (const event of missing.values()) {
      if (event.kind === 'transcript') writer.recordTranscript(event);
      else writer.recordTranslation(event);
      if (++count % 100 === 0) {
        this.checkpoint();
        await this.flushPending();
      }
    }
    this.checkpoint();
    await this.flushPending();
  }

  private async registerMeeting(meeting: MeetingMetadata): Promise<void> {
    if (this.registered.has(meeting.meetingId)) return;
    await this.request('/meetings', meeting, true, true);
    this.registered.add(meeting.meetingId);
  }

  /** Capture an admitted meeting identity once, so retiring provider tails cannot enter a new meeting. */
  bindCurrentMeeting(): Pick<
    MeetingArchiveClient,
    'recordTranscript' | 'recordTranslation' | 'recordGap'
  > {
    const meetingId = this.meeting?.meetingId;
    if (!meetingId || this.acceptedMeetingId !== meetingId || this.disposed)
      throw new Error('No admitted meeting');
    return {
      recordGap: (gap) => {
        if (gap.meetingId === meetingId) this.enqueue({ kind: 'gap', gap }, meetingId);
      },
      recordTranscript: (event) =>
        this.record(event, event.segmentId, event.status === 'final', meetingId),
      recordTranslation: (event) =>
        this.record(event, event.sourceSegmentId, event.status === 'final', meetingId),
    };
  }

  recordTranscript(event: TranscriptEvent): void {
    this.record(event, event.segmentId, event.status === 'final');
  }
  recordTranslation(event: TranslationEvent): void {
    this.record(event, event.sourceSegmentId, event.status === 'final');
  }
  private record(
    event: TranscriptEvent | TranslationEvent,
    segmentId: string,
    final: boolean,
    meetingId = this.meeting?.meetingId,
  ): void {
    if (
      !meetingId ||
      this.disposed ||
      (this.status.state === 'read_only' && this.acceptedMeetingId !== meetingId)
    )
      return;
    const key = `${meetingId}:${event.kind}:${segmentId}`;
    const previous = this.partials.get(key);
    if (previous) {
      this.partialBytes -= JSON.stringify(previous.event).length * 2;
      this.partials.delete(key);
    }
    if (final) {
      this.enqueue(event, meetingId);
      this.syncOutbox();
      return;
    }
    const bytes = JSON.stringify(event).length * 2;
    if (this.partialBytes + bytes > PARTIAL_MEMORY) this.checkpoint();
    if (bytes > PARTIAL_MEMORY) {
      this.enqueue(event, meetingId);
      return;
    }
    this.partials.set(key, { meetingId, event: structuredClone(event) });
    this.partialBytes += bytes;
    this.syncOutbox();
    if (!this.partialTimer)
      this.partialTimer = setTimeout(() => {
        this.partialTimer = null;
        this.checkpoint();
      }, 500);
  }
  recordRetentionGap(event: HealthEvent, meetingId: string | null): void {
    const gap = event.retentionGap;
    const meeting = this.meeting;
    if (!gap || !meeting || meeting.meetingId !== meetingId) return;
    this.recordGap({
      gapId: gap.gapId,
      meetingId: meeting.meetingId,
      trackId: gap.trackId,
      captureEpoch: gap.captureEpoch,
      startSample: gap.from,
      endSample: gap.to,
      sampleRate: gap.sampleRate,
      state: 'unrecoverable',
      alignment: 'exact_capture_range',
      cause: '未有服務持有收音期間，暫存音訊已覆寫；字幕完整性未確認',
    });
  }

  recordGap(gap: GapRecord): void {
    if (this.meeting?.meetingId !== gap.meetingId) return;
    this.enqueue({ kind: 'gap', gap });
  }
  private enqueue(payload: MeetingPayload, meetingId = this.meeting?.meetingId): void {
    if (
      !meetingId ||
      this.disposed ||
      (this.status.state === 'read_only' && this.acceptedMeetingId !== meetingId)
    )
      return;
    if (meetingId === this.meeting?.meetingId && this.status.manifest)
      this.update({ manifest: null });
    if (!this.writerId) {
      // When IDB is unavailable this identity is RAM-only; status never reports durability.
      this.writerId = crypto.randomUUID();
    }
    this.outbox.enqueue({
      schemaVersion: 1,
      meetingId,
      eventId: crypto.randomUUID(),
      writerId: this.writerId,
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: performance.now(),
      payload,
    });
    this.scheduleRetry(this.outbox.getStatus().pendingCount >= 100 ? 0 : 250);
  }
  checkpoint(): void {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    const partials = [...this.partials.values()];
    this.partials.clear();
    this.partialBytes = 0;
    for (const { event, meetingId } of partials) this.enqueue(event, meetingId);
    this.syncOutbox();
  }
  flushPending(): Promise<CommitReceipt[]> {
    if (this.status.state === 'read_only' && this.status.error === 'archive_generation_changed')
      return Promise.reject(new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH'));
    if (this.flushing) return this.flushing;
    this.update({ retryBlocked: false });
    this.flushing = this.flush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async flush(): Promise<CommitReceipt[]> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    try {
      await this.prepareLocal();
      await this.initialize();
      await this.persistMetadata();
      await this.outbox.flushToDisk();
      await this.authorizeWriter();
      const meetings = await this.store.listMeetings();
      const receipts: CommitReceipt[] = [];
      this.update({ state: 'saving' });
      while (!this.disposed) {
        const batch = await this.outbox.readBatch();
        if (!batch.length) break;
        const metadata = meetings.find((m) => m.meetingId === batch[0]!.meetingId);
        if (!metadata) throw new Error('Meeting metadata missing');
        await this.registerMeeting(metadata);
        const receipt = await this.request<CommitReceipt>(
          `/meetings/${metadata.meetingId}/events`,
          { events: batch },
          true,
          true,
        );
        await this.outbox.acknowledge(batch, receipt);
        receipts.push(receipt);
        this.update({ lastSavedAt: receipt.committedAt });
      }
      for (const [meetingId, input] of this.finalizationIntents) {
        const metadata = meetings.find((m) => m.meetingId === meetingId);
        if (!metadata) throw new Error('Meeting metadata missing');
        await this.registerMeeting(metadata);
        const manifest = await this.request<MeetingManifest & { exportFailure?: boolean }>(
          `/meetings/${meetingId}/finalize`,
          {
            pendingCount: this.status.pendingCount,
            gaps: [...(input.gaps ?? []), ...(await this.outbox.lossGaps(meetingId))],
            unfinishedTurns: input.unfinishedTurns ?? [],
          } satisfies FinalizeInput,
          true,
          true,
        );
        this.finalizationResults.set(meetingId, manifest);
        this.updateExportFailure(manifest.exportFailure ?? false);
        if (this.finalizationResults.size > 128)
          this.finalizationResults.delete(this.finalizationResults.keys().next().value!);
        this.finalizationIntents.delete(meetingId);
        if (this.meeting?.meetingId === meetingId) this.update({ manifest, finalizing: false });
      }
      this.failures = 0;
      this.update({
        state:
          this.status.lostCount || this.status.exportFailure
            ? 'error'
            : this.status.pendingCount
              ? 'pending'
              : 'saved',
        error: this.status.lostCount
          ? 'memory_limit'
          : this.status.exportFailure
            ? 'derived_export_failed'
            : null,
      });
      return receipts;
    } catch (error) {
      if (!isGenerationMismatch(error)) await this.persistMetadata().catch(() => {});
      this.fail(error);
      this.scheduleRetry();
      throw error;
    }
  }

  async finalize(input?: Partial<FinalizeInput>): Promise<MeetingManifest> {
    if (!this.meeting) throw new Error('No active meeting');
    return this.finalizeMeeting(this.meeting.meetingId, input);
  }

  /** A stopped session may finish draining after another meeting has started. */
  async finalizeMeeting(
    meetingId: string,
    input?: Partial<FinalizeInput>,
  ): Promise<MeetingManifest> {
    if (this.meeting?.meetingId === meetingId) this.update({ finalizing: true, manifest: null });
    this.finalizationIntents.set(meetingId, structuredClone(input ?? {}));
    this.checkpoint();
    try {
      await this.flushPending();
      // finalize can join a flush that had already passed its intent loop.
      if (this.finalizationIntents.has(meetingId)) await this.flushPending();
      const result = this.finalizationResults.get(meetingId);
      if (!result) throw new Error('Finalization has not committed');
      if (this.meeting?.meetingId === meetingId)
        this.update({
          manifest: result,
          state: this.status.exportFailure ? 'error' : result.saved ? 'saved' : 'pending',
        });
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      if (this.meeting?.meetingId === meetingId) this.update({ finalizing: false });
    }
  }
  async listMeetings(): Promise<MeetingListing[]> {
    const result = await this.readAuthorized<{
      meetings: MeetingListing[];
      exportFailure?: boolean;
    }>('/meetings');
    if (result.exportFailure !== undefined) this.updateExportFailure(result.exportFailure);
    return result.meetings;
  }
  async loadMeeting(meetingId: string, offset = 0, limit = 200): Promise<ArchivePage> {
    return this.readAuthorized(
      `/meetings/${encodeURIComponent(meetingId)}?offset=${offset}&limit=${limit}`,
    );
  }
  private async readAuthorized<T>(path: string): Promise<T> {
    if (!this.token) await this.bootstrap();
    try {
      return await this.request<T>(path);
    } catch (error) {
      if (!(error instanceof ArchiveRequestError) || error.status !== 401) throw error;
      await this.bootstrap();
      return this.request<T>(path);
    }
  }
  correctTranscript(
    meetingId: string,
    segmentId: string,
    text: string,
    baseRevision: number,
    editor = 'local-user',
  ): Promise<void> {
    const operation = this.correctionChain.then(async () => {
      await this.prepareLocal();
      await this.initialize();
      await this.authorizeWriter();
      if (this.meeting?.meetingId !== meetingId) {
        const metadata = (await this.loadMeeting(meetingId)).meeting;
        await this.store.saveMeeting(metadata);
      }
      await this.flushPending();
      // A stale edit must not poison the durable queue. The single writer lease
      // plus this serialized preflight excludes edits racing within this tab.
      let segment: ArchivedSegment | undefined;
      for (let offset = 0; ; ) {
        const page = await this.loadMeeting(meetingId, offset);
        segment = page.segments.find((s) => s.segmentId === segmentId);
        offset += page.segments.length;
        if (segment || offset >= page.totalSegments || !page.segments.length) break;
      }
      if (!segment || segment.revision !== baseRevision) throw new ArchiveRequestError(409);
      this.enqueue(
        {
          kind: 'correction',
          segmentId,
          text,
          baseRevision,
          editor,
          source: 'human',
          editedAt: new Date().toISOString(),
        },
        meetingId,
      );
      await this.flushPending();
    });
    this.correctionChain = operation.catch(() => {});
    return operation;
  }
  async exportMeeting(
    meetingId: string,
    variant: 'original' | 'corrected',
    format: 'txt' | 'json' | 'srt',
  ): Promise<Blob> {
    // A requested edit can still be acquiring its lease before entering the outbox.
    await this.correctionChain;
    return this.downloadArchiveFile(
      `/meetings/${encodeURIComponent(meetingId)}/export?variant=${variant}&format=${format}`,
    );
  }
  private async downloadArchiveFile(path: string): Promise<Blob> {
    if (!this.token) await this.bootstrap();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new ArchiveRequestError(response.status);
      return await response.blob();
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
  async backup(): Promise<{ path: string; backupId: string }> {
    await this.correctionChain;
    await this.flushPending();
    const result = await this.request<{ path: string; backupId: string }>(
      '/meetings/backup',
      {},
      true,
      true,
    );
    if (!/^backup-[a-f0-9-]{36}$/.test(result.backupId ?? ''))
      throw new Error('ARCHIVE_BACKUP_DOWNLOAD_UNAVAILABLE');
    return result;
  }
  downloadBackupFile(backupId: string, file: 'meetings.sqlite' | 'manifest.json'): Promise<Blob> {
    return this.downloadArchiveFile(`/meetings/backups/${encodeURIComponent(backupId)}/${file}`);
  }
  async importBackup(database: Blob, manifest: Blob): Promise<string> {
    if (database.size > 512 * 1024 * 1024 || !database.size || manifest.size > 4096)
      throw new Error('ARCHIVE_BACKUP_SIZE_INVALID');
    const manifestHeader = JSON.stringify(JSON.parse(await manifest.text()));
    await this.initialize();
    await this.authorizeWriter();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 80_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}/meetings/backups/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/octet-stream',
          'X-Meeting-Lease': this.lease!.leaseToken,
          'X-Meeting-Backup-Manifest': manifestHeader,
          ...(this.serviceIdentity
            ? {
                'X-Meeting-Workspace': this.serviceIdentity.workspaceId,
                'X-Meeting-Build': this.serviceIdentity.buildId,
              }
            : {}),
          ...(this.archiveGeneration ? { 'X-Meeting-Generation': this.archiveGeneration } : {}),
        },
        body: database,
        signal: controller.signal,
      });
      if (!response.ok) throw new ArchiveRequestError(response.status);
      const result = (await response.json()) as { backupId?: string };
      if (!/^backup-[a-f0-9-]{36}$/.test(result.backupId ?? ''))
        throw new Error('ARCHIVE_BACKUP_ID_INVALID');
      return result.backupId!;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
  /** Caller must stop capture first. A late event keeps the old page read-only for recovery. */
  async restoreBackup(backupId: string): Promise<{ safetyBackupPath: string }> {
    if (this.restoring || this.pendingRestore) throw new Error('ARCHIVE_RESTORING');
    this.restoring = true;
    let requested = false;
    try {
      await this.correctionChain;
      this.checkpoint();
      await this.flushPending();
      for (const meeting of await this.store.listMeetings()) {
        await this.registerMeeting(meeting);
        for (const gap of await this.outbox.lossGaps(meeting.meetingId))
          this.enqueue({ kind: 'gap', gap }, meeting.meetingId);
      }
      await this.flushPending();
      if (this.outbox.hasVolatileData() || this.pendingMetadata.size || this.status.pendingCount)
        throw new Error('ARCHIVE_PENDING_DATA');
      if (this.retry) clearTimeout(this.retry);
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.retry = this.renewTimer = null;
      const intent = {
        backupId,
        generation: crypto.randomUUID(),
        previousGeneration: this.archiveGeneration,
      };
      await this.store.saveRestoreIntent(intent);
      this.pendingRestore = intent;
      this.update({ restorePending: true });
      requested = true;
      const result = await this.request<{ safetyBackupPath: string; archiveGeneration: string }>(
        '/meetings/restore',
        { backupId, generation: intent.generation },
        true,
        true,
        20_000,
      );
      await this.finishRestore(intent, result.archiveGeneration);
      return result;
    } finally {
      this.restoring = false;
      if (requested) this.fail(new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH'));
    }
  }
  private async finishRestore(
    intent: RestoreIntent,
    generation: string,
    preservePending = false,
  ): Promise<void> {
    if (generation !== intent.generation) throw new Error('ARCHIVE_GENERATION_MISMATCH');
    this.lease = null;
    this.checkpoint();
    await this.outbox.settleLosses();
    await this.outbox.flushToDisk();
    if (this.outbox.hasVolatileData() || this.pendingMetadata.size)
      throw new Error('ARCHIVE_PENDING_DATA');
    await this.store.retireForRestore(generation, preservePending);
    this.pendingRestore = null;
    this.update({ restorePending: false, ...(preservePending ? { pendingCount: 0 } : {}) });
  }
  /** Explicit retry uses the persisted identity; it cannot reapply a completed restore. */
  async reconcileRestore(preservePending = false): Promise<{ safetyBackupPath: string }> {
    if (this.restoring) throw new Error('ARCHIVE_RESTORING');
    this.restoring = true;
    try {
      await this.prepareLocal();
      const intent = this.pendingRestore;
      if (!intent) throw new Error('ARCHIVE_RESTORE_NOT_PENDING');
      const info = await this.request<{
        token: string;
        dataDirectory: string;
        archiveGeneration?: string | null;
        serviceIdentity?: unknown;
      }>('/local/bootstrap', {}, false);
      this.acceptServiceIdentity(info.serviceIdentity);
      if (info.archiveGeneration === intent.generation) {
        await this.finishRestore(intent, intent.generation, preservePending);
        return { safetyBackupPath: info.dataDirectory };
      }
      if ((info.archiveGeneration ?? null) !== intent.previousGeneration)
        throw new Error('ARCHIVE_RESTORE_SUPERSEDED');
      // Preservation is only for a restore already applied by the service.
      // An unapplied restore can be cancelled to save into the original archive.
      if (preservePending) throw new Error('ARCHIVE_RESTORE_NOT_APPLIED');
      this.token = info.token;
      this.archiveGeneration = intent.previousGeneration;
      await this.authorizeWriter(true);
      const result = await this.request<{ safetyBackupPath: string; archiveGeneration: string }>(
        '/meetings/restore',
        { backupId: intent.backupId, generation: intent.generation },
        true,
        true,
        20_000,
      );
      await this.finishRestore(intent, result.archiveGeneration);
      return result;
    } finally {
      this.restoring = false;
      this.fail(new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH'));
    }
  }
  exportRetiredRestoreData(): Promise<Blob> {
    return this.store.exportRetired();
  }
  /** User action only: the service still refuses any other live lease holder. */
  async cancelPendingRestore(): Promise<void> {
    if (this.restoring) throw new Error('ARCHIVE_RESTORING');
    this.restoring = true;
    try {
      await this.prepareLocal();
      const intent = this.pendingRestore;
      if (!intent) throw new Error('ARCHIVE_RESTORE_NOT_PENDING');
      const info = await this.request<{
        token: string;
        archiveGeneration?: string | null;
        serviceIdentity?: unknown;
      }>('/local/bootstrap', {}, false);
      this.acceptServiceIdentity(info.serviceIdentity);
      if ((info.archiveGeneration ?? null) !== intent.previousGeneration)
        throw new Error('ARCHIVE_RESTORE_ALREADY_APPLIED');
      this.token = info.token;
      this.archiveGeneration = intent.previousGeneration;
      await this.authorizeWriter(true);
      // Releasing this lease fences a delayed original restore request before
      // deleting intent. An already-running restore makes release fail safely.
      await this.release();
      await this.store.clearRestoreIntent(intent.generation);
      this.pendingRestore = null;
      this.initialized = null;
      this.update({ restorePending: false, state: 'pending', error: null, retryBlocked: false });
    } catch (error) {
      this.fail(new ArchiveRequestError(409, 'ARCHIVE_GENERATION_MISMATCH'));
      throw error;
    } finally {
      this.restoring = false;
    }
  }
  /** User action only: the service still refuses any other live lease holder. */
  retryWriterOwnership(): Promise<void> {
    if (this.ownershipRetry) return this.ownershipRetry;
    this.ownershipRetry = this.retryOwnership().finally(() => {
      this.ownershipRetry = null;
    });
    return this.ownershipRetry;
  }
  private async retryOwnership(): Promise<void> {
    if (this.disposed) throw new Error('Archive client disposed');
    if (this.retry) clearTimeout(this.retry);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.retry = null;
    this.renewTimer = null;
    let acquired = false;
    try {
      // Finish an older flush before replacing its authorization context.
      await this.flushing?.catch(() => undefined);
      this.lease = null; // invalidate any renewal already in flight
      if (this.retry) clearTimeout(this.retry);
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.retry = null;
      this.renewTimer = null;
      await this.prepareLocal();
      await this.bootstrap();
      this.initialized = Promise.resolve();
      await this.authorizeWriter(true);
      acquired = true;
      this.update({ state: 'pending', error: null });
      await this.flushPending();
    } catch (error) {
      this.fail(error);
      // Bootstrap/network failures must not unlock automatic lease attempts.
      if (!acquired && !this.disposed) this.update({ state: 'read_only' });
      throw error;
    }
  }
  async release(): Promise<void> {
    if (!this.lease) return;
    await this.request('/meetings/lease/release', {}, true, true);
    this.lease = null;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of [this.retry, this.partialTimer, this.renewTimer])
      if (timer) clearTimeout(timer);
    this.requests.forEach((controller) => controller.abort());
    this.unsubscribeOutbox?.();
    this.listeners.clear();
  }
}
