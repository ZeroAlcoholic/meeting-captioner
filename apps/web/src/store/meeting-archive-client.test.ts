import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MeetingEnvelope,
  MeetingMetadata,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { MeetingEnvelope as EnvelopeSchema } from '@meeting-audio/contracts';
import { createStoreBoundHandlers } from '../providers/coalesce-handlers.js';
import { MeetingArchiveClient } from './meeting-archive-client.js';
import { MemoryMeetingStore, draft } from './meeting-test-store.js';

const metadata: MeetingMetadata = {
  meetingId: draft().meetingId,
  title: 'test',
  createdAt: new Date().toISOString(),
  captionTask: {
    purpose: 'transcription',
    inputLanguages: ['zh-tw', 'en'],
    textPolicy: 'zh-TW-preserve-original',
  },
};
describe('preflight availability', () => {
  it.each(['same', 'workspace', 'build', 'missing'] as const)(
    'checks managed service identity after authorization expires: %s',
    async (change) => {
      const server = service();
      const store = new MemoryMeetingStore();
      const original = { workspaceId: 'workspace-a', buildId: 'build-a' };
      let restarted = false;
      let repaired = false;
      let writesAfterRestart = 0;
      const client = new MeetingArchiveClient({
        store,
        fetcher: async (url, init) => {
          const path = String(url);
          if (path.endsWith('/local/bootstrap')) {
            const response = await server.fetcher(url, init);
            const identity =
              change === 'missing' && restarted && !repaired
                ? undefined
                : {
                    workspaceId:
                      change === 'workspace' && restarted && !repaired
                        ? 'workspace-b'
                        : original.workspaceId,
                    buildId:
                      change === 'build' && restarted && !repaired ? 'build-b' : original.buildId,
                  };
            return Response.json({ ...(await response.json()), serviceIdentity: identity });
          }
          if (path.endsWith('/events') && !restarted) {
            restarted = true;
            return Response.json({ error: 'LOCAL_AUTH_REQUIRED' }, { status: 401 });
          }
          if (restarted && init?.method === 'POST') writesAfterRestart++;
          return server.fetcher(url, init);
        },
      });
      try {
        await client.startMeeting(metadata);
        client.recordTranscript(draft('retained across restart').payload as TranscriptEvent);
        await expect(client.flushPending()).rejects.toThrow('401');
        if (change === 'same') {
          await client.flushPending();
          expect(server.committed.size).toBe(1);
          expect(store.events).toHaveLength(0);
        } else {
          await expect(client.flushPending()).rejects.toThrow('SERVICE_IDENTITY_MISMATCH');
          expect(store.events).toHaveLength(1);
          expect(writesAfterRestart).toBe(0);
          expect(client.getStatus()).toMatchObject({
            error: 'service_identity_changed',
            retryBlocked: true,
          });
          repaired = true;
          await client.flushPending();
          expect(server.committed.size).toBe(1);
          expect(store.events).toHaveLength(0);
          expect(client.getStatus()).toMatchObject({ error: null, retryBlocked: false });
        }
      } finally {
        client.dispose();
      }
    },
  );
  it('binds a fresh store before saving metadata and sends the current generation with writes', async () => {
    const server = service(),
      store = new MemoryMeetingStore();
    const generation = crypto.randomUUID();
    const client = new MeetingArchiveClient({
      store,
      fetcher: async (url, init) => {
        if (String(url).endsWith('/local/bootstrap'))
          return Response.json({
            token: 'local-token',
            storageAvailable: true,
            dataDirectory: 'local-data',
            archiveGeneration: generation,
          });
        if (init?.method === 'POST')
          expect(new Headers(init.headers).get('X-Meeting-Generation')).toBe(generation);
        return server.fetcher(url, init);
      },
    });
    try {
      await client.startMeeting(metadata);
      expect(store.generation).toBe(generation);
      client.recordTranscript(draft().payload as TranscriptEvent);
      await client.flushPending();
      expect(server.committed.size).toBe(1);
    } finally {
      client.dispose();
    }
  });
  it('retains old pending data and blocks writing when bootstrap reports another generation', async () => {
    const store = new MemoryMeetingStore();
    await store.saveMeeting(metadata);
    await store.append({ ...draft(), meetingId: metadata.meetingId });
    const before = structuredClone(store.events);
    const fetcher = vi.fn(async () =>
      Response.json({
        token: 'local-token',
        storageAvailable: true,
        dataDirectory: 'local-data',
        archiveGeneration: crypto.randomUUID(),
      }),
    );
    const client = new MeetingArchiveClient({ store, fetcher });
    try {
      await expect(client.initialize()).rejects.toThrow('ARCHIVE_GENERATION_MISMATCH');
      expect(client.getStatus()).toMatchObject({
        state: 'read_only',
        retryBlocked: true,
        error: 'archive_generation_changed',
      });
      expect(store.events).toEqual(before);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });
  it('does not claim downloadable backup support from a legacy path-only server response', async () => {
    const server = service();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: async (url, init) =>
        String(url).endsWith('/meetings/backup')
          ? Response.json({ path: 'legacy.sqlite' })
          : server.fetcher(url, init),
    });
    try {
      await expect(client.backup()).rejects.toThrow('ARCHIVE_BACKUP_DOWNLOAD_UNAVAILABLE');
    } finally {
      client.dispose();
    }
  });
  it('downloads backup bytes with local authorization and surfaces download failure', async () => {
    const server = service();
    const backupId = 'backup-' + crypto.randomUUID();
    let refused = false;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/meetings/backups/')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer local-token');
        expect(String(url)).toBe(`/meetings/backups/${backupId}/meetings.sqlite`);
        return refused
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array([0, 255, 17]));
      }
      return server.fetcher(url, init);
    });
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    try {
      const file = await client.downloadBackupFile(backupId, 'meetings.sqlite');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17]));
      refused = true;
      await expect(client.downloadBackupFile(backupId, 'meetings.sqlite')).rejects.toThrow();
    } finally {
      client.dispose();
    }
  });
  it('keeps a bound interruption in its admitted meeting after a new meeting starts', async () => {
    const server = service();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    try {
      await client.startMeeting(metadata);
      const writer = client.bindCurrentMeeting();
      const next = { ...metadata, meetingId: crypto.randomUUID() };
      await client.startMeeting(next);
      const gap = {
        gapId: crypto.randomUUID(),
        meetingId: metadata.meetingId,
        trackId: 'mic',
        captureEpoch: 'unconfirmed:attempt',
        wallClock: { startAt: metadata.createdAt, endAt: metadata.createdAt },
        state: 'unrecoverable' as const,
        alignment: 'estimated' as const,
        cause: 'delivery interrupted',
      };
      writer.recordGap(gap);
      writer.recordGap({ ...gap, meetingId: next.meetingId });
      await client.flushPending();
      const events = [...server.committed.values()];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        meetingId: metadata.meetingId,
        payload: { kind: 'gap', gap },
      });
    } finally {
      client.dispose();
    }
  });
  it('does not attribute another meeting capture loss to the previous archive', async () => {
    const store = new MemoryMeetingStore();
    const server = service();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    try {
      await client.startMeeting(metadata);
      client.recordRetentionGap(
        {
          kind: 'health',
          component: 'audio',
          state: 'connected',
          timestamp: new Date().toISOString(),
          retentionGap: {
            gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
            trackId: 'mic',
            captureEpoch: 'e1',
            from: 512,
            to: 480512,
            sampleRate: 16000,
          },
        },
        crypto.randomUUID(),
      );
      await client.flushPending();
      expect([...server.committed.values()]).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });
  it('persists normalized retention loss as the exact capture range of the current meeting', async () => {
    const store = new MemoryMeetingStore();
    const server = service();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    try {
      await client.startMeeting(metadata);
      client.recordRetentionGap(
        {
          kind: 'health',
          component: 'audio',
          state: 'connected',
          timestamp: new Date().toISOString(),
          retentionGap: {
            gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
            trackId: 'mic',
            captureEpoch: 'e1',
            from: 512,
            to: 480512,
            sampleRate: 16000,
          },
        },
        metadata.meetingId,
      );
      await client.flushPending();
      const events = [...server.committed.values()];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        meetingId: metadata.meetingId,
        payload: {
          kind: 'gap',
          gap: {
            meetingId: metadata.meetingId,
            trackId: 'mic',
            captureEpoch: 'e1',
            startSample: 512,
            endSample: 480512,
            state: 'unrecoverable',
            alignment: 'exact_capture_range',
          },
        },
      });
      expect(events[0]!.payload).not.toHaveProperty('gap.storageLoss');
    } finally {
      client.dispose();
    }
  });
  it('continues its RAM-only meeting after initial metadata storage fails', async () => {
    const store = new MemoryMeetingStore();
    const save = store.saveMeeting.bind(store);
    store.saveMeeting = async () => {
      throw new Error('quota');
    };
    const server = service();
    const fetcher: typeof fetch = (url, init) => {
      if (
        String(url).includes(`/meetings/${metadata.meetingId}`) &&
        (!init?.method || init.method === 'GET') &&
        store.meetings.length === 0
      )
        return Promise.resolve(Response.json({ error: 'MEETING_NOT_FOUND' }, { status: 404 }));
      return server.fetcher(url, init);
    };
    const client = new MeetingArchiveClient({ store, fetcher });
    try {
      await client.startMeeting(metadata);
      client.recordTranscript(draft('retained during initial outage').payload as TranscriptEvent);
      expect(store.meetings).toHaveLength(0);
      store.saveMeeting = save;
      expect(await client.continueMeeting(metadata.meetingId)).toEqual(metadata);
      await client.finalize();
      expect(client.getStatus()).toMatchObject({ pendingCount: 0, manifest: { saved: true } });
      expect([...server.committed.values()].map((event) => event.payload)).toMatchObject([
        { text: 'retained during initial outage' },
      ]);
    } finally {
      client.dispose();
    }
  });
  it('warns on page exit only while drafts or permanent-loss markers are RAM-only', async () => {
    const store = new MemoryMeetingStore();
    const server = service();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    const exit = () => {
      const event = new Event('beforeunload', { cancelable: true });
      client.beforeUnload(event as BeforeUnloadEvent);
      return event.defaultPrevented;
    };
    try {
      await client.startMeeting(metadata);
      expect(exit()).toBe(false);
      store.fail = true;
      client.recordTranscript({ ...draft().payload, status: 'partial' } as TranscriptEvent);
      expect(exit()).toBe(true);
      await expect(client.outbox.flushToDisk()).rejects.toThrow('quota');
      store.fail = false;
      await client.outbox.flushToDisk();
      // IDB pending data survives reload even before a server ACK.
      expect(client.getStatus().pendingCount).toBe(1);
      expect(exit()).toBe(false);
      store.fail = true;
      client.recordTranscript(draft('x'.repeat(300_000)).payload as TranscriptEvent);
      expect(exit()).toBe(true);
      store.fail = false;
      await client.outbox.flushToDisk();
      expect(client.getStatus().lostCount).toBe(1);
      expect(exit()).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it('finalizes permanent losses for their original meeting and blocks switching until the marker is durable', async () => {
    const server = service();
    const store = new MemoryMeetingStore();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    try {
      await client.startMeeting(metadata);
      store.fail = true;
      client.recordTranscript(draft('x'.repeat(300_000)).payload as TranscriptEvent);
      const next = { ...metadata, meetingId: crypto.randomUUID() };
      await expect(client.startMeeting(next)).rejects.toThrow('quota');
      expect(client.getCurrentMeeting()?.meetingId).toBe(metadata.meetingId);
      store.fail = false;
      await client.startMeeting(next);
      await client.finalizeMeeting(metadata.meetingId);
      await client.finalizeMeeting(next.meetingId);
      const requests = server.fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith('/finalize'),
      );
      expect(JSON.parse(String(requests[0]![1]?.body))).toMatchObject({
        pendingCount: 0,
        gaps: [{ meetingId: metadata.meetingId, storageLoss: { lostCount: 1 } }],
      });
      expect(JSON.parse(String(requests[1]![1]?.body)).gaps).toEqual([]);
      expect(client.getStatus().lostCount).toBe(0);
    } finally {
      client.dispose();
    }
  });
  it('persists and sends a wall-clock-only estimated gap without fabricating sample positions', async () => {
    const server = service();
    const store = new MemoryMeetingStore();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    try {
      await client.startMeeting(metadata);
      const gap = {
        gapId: crypto.randomUUID(),
        meetingId: metadata.meetingId,
        trackId: 'mic',
        captureEpoch: 'grant-1',
        state: 'unrecoverable' as const,
        alignment: 'estimated' as const,
        cause: '疑似休眠或排程中斷',
        wallClock: { startAt: '2026-10-15T00:00:00.000Z', endAt: '2026-10-15T00:01:00.000Z' },
      };
      client.recordGap(gap);
      await client.outbox.flushToDisk();
      expect(store.events[0]?.payload).toEqual({ kind: 'gap', gap });
      await client.flushPending();
      const envelope = EnvelopeSchema.parse(
        JSON.parse(JSON.stringify([...server.committed.values()][0])),
      );
      expect(envelope.payload).toEqual({ kind: 'gap', gap });
      expect(envelope.payload).not.toHaveProperty('gap.startSample');
    } finally {
      client.dispose();
    }
  });
  it('checks fresh storage availability without creating a meeting or writer lease', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ storageAvailable: true }))
      .mockResolvedValueOnce(Response.json({ storageAvailable: false }));
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    await client.checkAvailability();
    await expect(client.checkAvailability()).rejects.toThrow('local_storage_unavailable');
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/local/bootstrap',
      '/local/bootstrap',
    ]);
    expect(client.getCurrentMeeting()).toBeNull();
    expect(client.getStatus().pendingCount).toBe(0);
    client.dispose();
  });
});
function service(options: { rejectLease?: boolean; loseAck?: boolean } = {}) {
  const committed = new Map<string, MeetingEnvelope>();
  const batches: MeetingEnvelope[][] = [];
  let token = 'local-token';
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/local/bootstrap'))
      return Response.json({ token, dataDirectory: 'local-data', storageAvailable: true });
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${token}`)
      return new Response(null, { status: 401 });
    if (path.endsWith('/meetings/lease'))
      return options.rejectLease
        ? new Response(null, { status: 409 })
        : Response.json({ leaseToken: 'lease', expiresAt: Date.now() + 60_000 });
    if (path.endsWith('/meetings/lease/renew'))
      return Response.json({ leaseToken: 'lease', expiresAt: Date.now() + 60_000 });
    if (path.endsWith('/events')) {
      const { events } = JSON.parse(String(init?.body)) as { events: MeetingEnvelope[] };
      batches.push(events);
      events.forEach((event) => committed.set(event.eventId, event));
      if (options.loseAck) {
        options.loseAck = false;
        throw new TypeError('network');
      }
      return Response.json({
        meetingId: events[0]!.meetingId,
        committedEventIds: events.map((e) => e.eventId),
        committedAt: new Date().toISOString(),
      });
    }
    if (path.endsWith('/finalize')) {
      const input = JSON.parse(String(init?.body));
      return Response.json({
        ...input,
        meetingId: metadata.meetingId,
        saved: input.pendingCount === 0,
        lastSequence: committed.size,
        lastRevision: 1,
        finalCount: committed.size,
        finalizedAt: new Date().toISOString(),
      });
    }
    if (path.includes('/revisions?')) {
      const revisions = new Map<string, { kind: string; segmentId: string; revision: number }>();
      for (const event of committed.values()) {
        const p = event.payload;
        if (p.kind !== 'transcript' && p.kind !== 'translation') continue;
        const segmentId = p.kind === 'transcript' ? p.segmentId : p.sourceSegmentId;
        const key = `${p.kind}:${segmentId}`;
        if (event.revision > (revisions.get(key)?.revision ?? 0))
          revisions.set(key, { kind: p.kind, segmentId, revision: event.revision });
      }
      const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset'));
      const all = [...revisions.values()];
      // One row per page deliberately exercises the client's pagination.
      return Response.json({
        revisions: all.slice(offset, offset + 1),
        nextOffset: offset + 1 < all.length ? offset + 1 : null,
      });
    }
    if (path.includes('?offset=')) {
      const segments = [...committed.values()]
        .filter((e) => e.payload.kind === 'transcript')
        .map((e) => ({
          ...e.payload,
          revision: e.revision,
          originalText: e.payload.kind === 'transcript' ? e.payload.text : '',
        }));
      return Response.json({
        meeting: metadata,
        segments,
        translations: Object.fromEntries(
          [...committed.values()]
            .filter(
              (event) =>
                event.payload.kind === 'translation' &&
                segments.some(
                  (segment) =>
                    segment.kind === 'transcript' &&
                    segment.segmentId === (event.payload as TranslationEvent).sourceSegmentId,
                ),
            )
            .map((event) => {
              const payload = event.payload as TranslationEvent;
              return [payload.sourceSegmentId, { ...payload, revision: event.revision }];
            }),
        ),
        totalSegments: segments.length,
        lastSequence: committed.size,
        manifest: null,
      });
    }
    return Response.json({});
  });
  return {
    fetcher,
    committed,
    batches,
    restart: () => {
      token = 'local-token-2';
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('archive client local protocol', () => {
  it.each([400, 413, 422])(
    'retains rejected events without automatic HTTP %i retries, then recovers on explicit retry',
    async (status) => {
      vi.useFakeTimers();
      const server = service();
      const store = new MemoryMeetingStore();
      let rejectEvents = true;
      let eventRequests = 0;
      const errorCode = status === 400 ? 'INVALID_MEETING_EVENTS' : 'ARCHIVE_OPERATION_FAILED';
      const fetcher: typeof fetch = (url, init) => {
        if (String(url).endsWith('/events')) {
          eventRequests += 1;
          if (rejectEvents) return Promise.resolve(Response.json({ error: errorCode }, { status }));
        }
        return server.fetcher(url, init);
      };
      const client = new MeetingArchiveClient({ store, fetcher });
      try {
        await client.startMeeting(metadata);
        client.recordTranscript(draft('retained before rejection').payload as TranscriptEvent);
        await expect(client.flushPending()).rejects.toThrow(String(status));
        client.recordTranscript({
          ...draft('captions continue').payload,
          segmentId: 'next',
        } as TranscriptEvent);
        await client.outbox.flushToDisk();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(eventRequests).toBe(1);
        expect(store.events).toHaveLength(2);
        expect(client.getStatus()).toMatchObject({
          pendingCount: 2,
          error: status === 400 ? errorCode : `local_http_${status}`,
          retryBlocked: true,
        });
        rejectEvents = false;
        await client.flushPending();
        expect(server.committed.size).toBe(2);
        expect(store.events).toHaveLength(0);
        expect(client.getStatus()).toMatchObject({
          state: 'saved',
          error: null,
          retryBlocked: false,
        });
      } finally {
        client.dispose();
      }
    },
  );
  it('exports only after a correction requested in the same turn has committed', async () => {
    const server = service();
    const fetcher: typeof fetch = (url, init) =>
      String(url).includes('/export?')
        ? Promise.resolve(
            new Response(
              [...server.committed.values()]
                .filter((e) => e.payload.kind === 'correction')
                .map((e) => (e.payload.kind === 'correction' ? e.payload.text : ''))
                .join(''),
            ),
          )
        : server.fetcher(url, init);
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    try {
      await client.startMeeting(metadata);
      client.recordTranscript(draft('original').payload as TranscriptEvent);
      await client.flushPending();
      const event = [...server.committed.values()][0]!;
      const correction = client.correctTranscript(
        metadata.meetingId,
        (event.payload as TranscriptEvent).segmentId,
        '人工確認',
        event.revision,
      );
      const exported = client.exportMeeting(metadata.meetingId, 'corrected', 'txt');
      await correction;
      expect(await (await exported).text()).toBe('人工確認');
    } finally {
      client.dispose();
    }
  });
  it('keeps active-meeting transcripts durable after lease loss and commits them only after explicit reacquisition', async () => {
    vi.useFakeTimers();
    const server = service();
    const store = new MemoryMeetingStore();
    let loseLease = false;
    const fetcher: typeof fetch = (...args) =>
      loseLease && String(args[0]).endsWith('/meetings/lease/renew')
        ? Promise.resolve(Response.json({ error: 'WRITER_LEASE_REQUIRED' }, { status: 409 }))
        : server.fetcher(...args);
    const client = new MeetingArchiveClient({ store, fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft('before').payload as TranscriptEvent);
    await client.flushPending();
    loseLease = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getStatus().state).toBe('read_only');
    client.recordTranscript({
      ...draft('during lease loss').payload,
      kind: 'transcript',
      segmentId: 'during',
    } as TranscriptEvent);
    await client.outbox.flushToDisk();
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.payload).toMatchObject({ text: 'during lease loss' });
    expect(client.getStatus()).toMatchObject({ state: 'read_only', pendingCount: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.committed.size).toBe(1);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(1);
    loseLease = false;
    await client.retryWriterOwnership();
    const manifest = await client.finalize();
    expect(manifest).toMatchObject({ saved: true, pendingCount: 0, lastSequence: 2 });
    expect(
      [...server.committed.values()].some(
        (e) => e.payload.kind === 'transcript' && e.payload.text === 'during lease loss',
      ),
    ).toBe(true);
    client.dispose();
  });
  it('does not accept provider text for an initial meeting rejected by another writer', async () => {
    const store = new MemoryMeetingStore();
    const server = service({ rejectLease: true });
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    client.recordTranscript(draft('not started').payload as TranscriptEvent);
    await client.outbox.flushToDisk();
    expect(store.events).toHaveLength(0);
    expect(client.getStatus().pendingCount).toBe(0);
    client.dispose();
  });
  it('requires an explicit ownership retry after another tab lease expires and flushes recovered pending events', async () => {
    vi.useFakeTimers();
    const options = { rejectLease: true };
    const server = service(options);
    const store = new MemoryMeetingStore();
    await store.saveMeeting(metadata);
    const pending = await store.append(draft());
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    options.rejectLease = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(1);
    expect(server.committed.size).toBe(0);
    const retry = client.retryWriterOwnership();
    expect(client.retryWriterOwnership()).toBe(retry);
    await retry;
    expect(server.committed.has(pending.eventId)).toBe(true);
    expect(client.getStatus()).toMatchObject({ state: 'saved', pendingCount: 0 });
    const leases = server.fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/meetings/lease'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(leases).toHaveLength(2);
    expect(leases[1]).toEqual(leases[0]);
    client.dispose();
  });
  it('an explicit ownership retry still refuses an active tab and never schedules takeover', async () => {
    vi.useFakeTimers();
    const server = service({ rejectLease: true });
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    await expect(client.retryWriterOwnership()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getStatus().state).toBe('read_only');
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(2);
    client.dispose();
  });
  it('exports in read-only mode without requesting ownership again', async () => {
    const server = service({ rejectLease: true });
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    const result = await client.exportMeeting(metadata.meetingId, 'original', 'txt');
    expect(result).toBeInstanceOf(Blob);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(1);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/events')),
    ).toHaveLength(0);
    client.dispose();
  });
  it('failed manual reauthorization remains read-only without an automatic takeover timer', async () => {
    vi.useFakeTimers();
    const options = { rejectLease: true };
    const server = service(options);
    let unavailable = false;
    const fetcher: typeof fetch = (...args) =>
      unavailable && String(args[0]).endsWith('/local/bootstrap')
        ? Promise.reject(new TypeError('offline'))
        : server.fetcher(...args);
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    unavailable = true;
    await expect(client.retryWriterOwnership()).rejects.toThrow('offline');
    unavailable = false;
    options.rejectLease = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getStatus().state).toBe('read_only');
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(1);
    client.dispose();
  });
  it('keeps drafts in RAM until the persistent writer identity recovers', async () => {
    const store = new MemoryMeetingStore();
    store.getWriterId = vi
      .fn()
      .mockRejectedValueOnce(new Error('IDB unavailable'))
      .mockResolvedValue('11111111-1111-4111-8111-111111111111');
    const server = service();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    expect(store.events).toHaveLength(0);
    expect(client.getStatus().pendingCount).toBe(1);
    await client.flushPending();
    expect(server.batches[0]![0]!.writerId).toBe('11111111-1111-4111-8111-111111111111');
    client.dispose();
  });
  it('shows derived export failures separately even when the SQLite manifest committed', async () => {
    const server = service();
    const fetcher: typeof fetch = async (...args) => {
      const response = await server.fetcher(...args);
      if (String(args[0]).endsWith('/finalize'))
        return Response.json({ ...(await response.json()), exportFailure: true });
      return response;
    };
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    expect((await client.finalize()).saved).toBe(true);
    expect(client.getStatus()).toMatchObject({
      state: 'error',
      error: 'derived_export_failed',
      exportFailure: true,
    });
    client.dispose();
  });
  it('does not mislabel a revision conflict as another tab holding the lease', async () => {
    const server = service();
    const fetcher: typeof fetch = (...args) =>
      String(args[0]).endsWith('/events')
        ? Promise.resolve(Response.json({ error: 'REVISION_CONFLICT' }, { status: 409 }))
        : server.fetcher(...args);
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    await expect(client.flushPending()).rejects.toThrow('REVISION_CONFLICT');
    expect(client.getStatus()).toMatchObject({
      state: 'error',
      error: 'REVISION_CONFLICT',
      pendingCount: 1,
    });
    client.dispose();
  });
  it('editing a prior meeting preserves the active capture destination and human provenance', async () => {
    const server = service();
    const original = { ...draft(), revision: 5 };
    server.committed.set(original.eventId, original);
    const current = { ...metadata, meetingId: crypto.randomUUID() };
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await client.startMeeting(current);
    await client.correctTranscript(metadata.meetingId, 'one', '校訂', 5, 'operator');
    expect(client.getCurrentMeeting()?.meetingId).toBe(current.meetingId);
    expect(server.batches[0]![0]).toMatchObject({
      meetingId: metadata.meetingId,
      revision: 6,
      payload: {
        kind: 'correction',
        baseRevision: 5,
        source: 'human',
        editor: 'operator',
        text: '校訂',
      },
    });
    expect(server.committed.get(original.eventId)?.payload).toMatchObject({ text: 'hello' });
    client.recordTranscript(draft().payload as TranscriptEvent);
    await client.flushPending();
    expect(server.batches[1]![0]!.meetingId).toBe(current.meetingId);
    client.dispose();
  });
  it('aborts a stalled HTTP commit at five seconds while retaining the durable event', async () => {
    vi.useFakeTimers();
    const server = service();
    const store = new MemoryMeetingStore();
    const fetcher: typeof fetch = (...args) => {
      if (String(args[0]).endsWith('/events'))
        return new Promise((_resolve, reject) => {
          args[1]?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      return server.fetcher(...args);
    };
    const client = new MeetingArchiveClient({ store, fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    const failure = expect(client.flushPending()).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(store.events).toHaveLength(1);
    expect(client.getStatus().state).toBe('error');
    client.dispose();
  });
  it('rebootstraps after service token rotation and reacquires only its same owner', async () => {
    const server = service();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    server.restart();
    await expect(client.flushPending()).rejects.toThrow('(401)');
    await client.flushPending();
    const leases = server.fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/meetings/lease'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(leases).toHaveLength(2);
    expect(leases[1]).toEqual(leases[0]);
    expect(client.getStatus().pendingCount).toBe(0);
    client.dispose();
  });
  it('retains Stop finalization intent after outage and retries it after the durable queue', async () => {
    vi.useFakeTimers();
    const server = service();
    let failFinalize = true;
    const fetcher: typeof fetch = (...args) => {
      if (String(args[0]).endsWith('/finalize') && failFinalize) {
        failFinalize = false;
        return Promise.reject(new TypeError('offline'));
      }
      return server.fetcher(...args);
    };
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    await expect(client.finalize()).rejects.toThrow();
    expect(client.getStatus().manifest).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus().manifest).toMatchObject({
      saved: true,
      pendingCount: 0,
      lastSequence: 1,
    });
    client.dispose();
  });
  it('seeds continued transcript revision from the archive and rejects stale edits without read-only takeover state', async () => {
    const server = service();
    const old = { ...draft(), revision: 5 };
    server.committed.set(old.eventId, old);
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await client.continueMeeting(metadata.meetingId);
    client.recordTranscript({
      ...draft().payload,
      kind: 'transcript',
      text: 'next',
    } as TranscriptEvent);
    await client.flushPending();
    expect(server.batches[0]![0]!.revision).toBe(6);
    await expect(
      client.correctTranscript(metadata.meetingId, 'one', 'edited', 1),
    ).rejects.toThrow();
    expect(client.getStatus().state).not.toBe('read_only');
    expect(client.getStatus().pendingCount).toBe(0);
    client.dispose();
  });
  it('durably keeps each meeting metadata even while the local service is down', async () => {
    const store = new MemoryMeetingStore();
    const server = service();
    let online = false;
    const fetcher: typeof fetch = (...args) =>
      online ? server.fetcher(...args) : Promise.reject(new TypeError('offline'));
    const client = new MeetingArchiveClient({ store, fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    const second = { ...metadata, meetingId: crypto.randomUUID(), title: 'second' };
    await client.startMeeting(second);
    client.recordTranscript({
      ...draft().payload,
      kind: 'transcript',
      segmentId: 'two',
    } as TranscriptEvent);
    expect(store.meetings).toHaveLength(2);
    online = true;
    await client.flushPending();
    expect(new Set([...server.committed.values()].map((e) => e.meetingId))).toEqual(
      new Set([metadata.meetingId, second.meetingId]),
    );
    client.dispose();
  });
  it('persists before sending, replays the same event after ACK loss, and keeps monotonic revision', async () => {
    const store = new MemoryMeetingStore();
    const server = service({ loseAck: true });
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await client.startMeeting(metadata);
    client.recordTranscript(draft().payload as TranscriptEvent);
    await expect(client.flushPending()).rejects.toThrow();
    expect(store.events).toHaveLength(1);
    const id = store.events[0]!.eventId;
    await client.flushPending();
    expect(server.batches[1]![0]!.eventId).toBe(id);
    expect(server.committed.size).toBe(1);
    client.recordTranscript({
      ...draft().payload,
      kind: 'transcript',
      text: 'second',
    } as TranscriptEvent);
    await client.flushPending();
    expect(server.batches[2]![0]!.revision).toBe(2);
    expect(client.getStatus().pendingCount).toBe(0);
    client.dispose();
  });
  it('checkpoints only the newest partial at 500ms and immediately enqueues final', async () => {
    vi.useFakeTimers();
    const store = new MemoryMeetingStore();
    const server = service();
    const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await client.startMeeting(metadata);
    const event = draft().payload as TranscriptEvent;
    client.recordTranscript({ ...event, status: 'partial', text: 'a' });
    client.recordTranscript({ ...event, status: 'partial', text: 'ab' });
    await vi.advanceTimersByTimeAsync(499);
    expect(store.events).toHaveLength(0);
    expect(server.committed.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      [...store.events, ...server.committed.values()].some(
        (e) => e.payload.kind === 'transcript' && e.payload.text === 'ab',
      ),
    ).toBe(true);
    client.recordTranscript({ ...event, status: 'final', text: 'abc' });
    await client.flushPending();
    expect([...server.committed.values()].slice(-1)[0]?.payload).toMatchObject({
      status: 'final',
      text: 'abc',
    });
    client.dispose();
  });
  it('refuses a second tab lease and does not retry takeover', async () => {
    vi.useFakeTimers();
    const server = service({ rejectLease: true });
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    await expect(client.startMeeting(metadata)).rejects.toThrow();
    expect(client.getStatus().state).toBe('read_only');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/meetings/lease')),
    ).toHaveLength(1);
    client.dispose();
  });
  it('assigns a fresh owner for each tab while retaining the persistent writer identity', async () => {
    const server = service();
    const store = new MemoryMeetingStore();
    const a = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    const b = new MeetingArchiveClient({ store, fetcher: server.fetcher });
    await a.startMeeting(metadata);
    await b.startMeeting(metadata);
    const requests = server.fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/meetings/lease'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[0].writerId).toBe(requests[1].writerId);
    expect(requests[0].ownerId).not.toBe(requests[1].ownerId);
    a.dispose();
    b.dispose();
  });
});

describe('translation archive before display coalescing', () => {
  it.each(['openai-realtime', 'gemini-live'] as const)(
    'retains %s source, translation revisions and partial checkpoints before display flush',
    async (provider) => {
      vi.useFakeTimers();
      const server = service();
      const store = new MemoryMeetingStore();
      const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
      const display: Array<() => void> = [];
      try {
        await client.startMeeting({
          ...metadata,
          captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
        });
        const handlers = createStoreBoundHandlers({
          archive: client,
          scheduler: (flush) => display.push(flush),
        });
        const source = { ...(draft('original').payload as TranscriptEvent), provider };
        const translation = {
          kind: 'translation' as const,
          provider,
          mode: 'online_full' as const,
          sourceSegmentId: source.segmentId,
          status: 'final' as const,
          sourceText: source.text,
          targetText: '初稿',
          sourceLanguage: 'en',
          targetLanguage: 'zh-TW',
          updatedAt: new Date().toISOString(),
        };
        handlers.onTranscript(source);
        handlers.onTranslation(translation);
        handlers.onTranslation({ ...translation, targetText: '修訂稿' });
        handlers.onTranscript({
          ...source,
          segmentId: 'next-source',
          status: 'partial',
          text: 'next',
        });
        handlers.onTranslation({
          ...translation,
          sourceSegmentId: 'next-source',
          status: 'draft',
          targetText: '下一句',
        });
        client.checkpoint();
        await client.flushPending();
        const saved = [...server.committed.values()];
        expect(saved.map((event) => event.payload)).toEqual([
          source,
          translation,
          { ...translation, targetText: '修訂稿' },
          { ...source, segmentId: 'next-source', status: 'partial', text: 'next' },
          { ...translation, sourceSegmentId: 'next-source', status: 'draft', targetText: '下一句' },
        ]);
        expect(saved.every((event) => event.meetingId === metadata.meetingId)).toBe(true);
        expect(
          saved
            .filter((event) => event.payload.kind === 'translation')
            .map((event) => event.revision),
        ).toEqual([1, 2, 1]);
        display.forEach((flush) => flush());
        await client.flushPending();
        expect(server.committed.size).toBe(5);
        expect(client.getStatus().pendingCount).toBe(0);
      } finally {
        client.dispose();
      }
    },
  );
});

describe('meeting-bound archive writers', () => {
  it('keeps late finals and colliding partial IDs in their original meeting', async () => {
    vi.useFakeTimers();
    const server = service();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    try {
      await client.startMeeting(metadata);
      const oldWriter = client.bindCurrentMeeting();
      const next = { ...metadata, meetingId: crypto.randomUUID() };
      await client.startMeeting(next);
      const newWriter = client.bindCurrentMeeting();
      const event = draft().payload as TranscriptEvent;
      oldWriter.recordTranscript({ ...event, status: 'partial', text: 'old partial' });
      newWriter.recordTranscript({ ...event, status: 'partial', text: 'new partial' });
      client.checkpoint();
      oldWriter.recordTranscript({ ...event, text: 'old final' });
      newWriter.recordTranscript({ ...event, text: 'new final' });
      await client.flushPending();
      const saved = [...server.committed.values()];
      expect(saved).toHaveLength(4);
      for (const [meetingId, prefix] of [
        [metadata.meetingId, 'old'],
        [next.meetingId, 'new'],
      ]) {
        const events = saved.filter((e) => e.meetingId === meetingId);
        expect(events.map((e) => e.payload.kind === 'transcript' && e.payload.text)).toEqual([
          `${prefix} partial`,
          `${prefix} final`,
        ]);
        expect(events.map((e) => e.revision)).toEqual([1, 2]);
      }
    } finally {
      client.dispose();
    }
  });
  it('cannot bind an unadmitted meeting after another-tab rejection', async () => {
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: service({ rejectLease: true }).fetcher,
    });
    try {
      expect(() => client.bindCurrentMeeting()).toThrow('No admitted meeting');
      await expect(client.startMeeting(metadata)).rejects.toThrow();
      expect(() => client.bindCurrentMeeting()).toThrow('No admitted meeting');
    } finally {
      client.dispose();
    }
  });
});

describe('continued translation revisions', () => {
  it.each([
    { localRevision: 0, hasSource: true },
    { localRevision: 9, hasSource: true },
    { localRevision: 0, hasSource: false },
  ])(
    'seeds translation revisions with local=$localRevision and source=$hasSource',
    async ({ localRevision, hasSource }) => {
      const server = service();
      const source = { ...draft(), revision: 8 };
      if (hasSource) server.committed.set(source.eventId, source);
      const translation: TranslationEvent = {
        kind: 'translation',
        provider: 'openai-realtime',
        mode: 'online_full',
        sourceSegmentId: 'one',
        status: 'final',
        sourceText: 'hello',
        targetText: '原譯文',
        sourceLanguage: 'en',
        targetLanguage: 'zh-TW',
        updatedAt: new Date().toISOString(),
      };
      const previous = { ...draft(), payload: translation, revision: 5 };
      server.committed.set(previous.eventId, previous);
      const store = new MemoryMeetingStore();
      if (localRevision)
        store.revisions.set(`${metadata.meetingId}:translation:one`, localRevision);
      const client = new MeetingArchiveClient({ store, fetcher: server.fetcher });
      try {
        await client.continueMeeting(metadata.meetingId);
        client.recordTranslation({ ...translation, targetText: '續接修訂' });
        client.recordTranscript({
          ...(source.payload as TranscriptEvent),
          text: 'continued source',
        });
        await client.flushPending();
        const sent = server.batches.flat();
        expect(sent.find((event) => event.payload.kind === 'translation')?.revision).toBe(
          Math.max(5, localRevision) + 1,
        );
        expect(sent.find((event) => event.payload.kind === 'transcript')?.revision).toBe(
          hasSource ? 9 : 1,
        );
        expect(client.getStatus().pendingCount).toBe(0);
      } finally {
        client.dispose();
      }
    },
  );
});

describe('translation snapshot migration', () => {
  it.each(['not-applied', 'already-applied', 'release-failed'] as const)(
    'cancels a pending restore only after generation and lease checks: %s',
    async (outcome) => {
      const server = service();
      const store = new MemoryMeetingStore();
      let checking = false;
      const client = new MeetingArchiveClient({
        store,
        fetcher: async (url, init) => {
          const path = String(url);
          if (path.endsWith('/meetings/restore'))
            return Response.json({ error: 'ARCHIVE_FAILURE' }, { status: 503 });
          if (checking && outcome === 'already-applied' && path.endsWith('/local/bootstrap'))
            return Response.json({
              token: 'local-token',
              archiveGeneration: store.restoreIntent!.generation,
            });
          if (checking && outcome === 'release-failed' && path.endsWith('/meetings/lease/release'))
            return Response.json({ error: 'ARCHIVE_FAILURE' }, { status: 503 });
          return server.fetcher(url, init);
        },
      });
      try {
        await client.startMeeting(metadata);
        await expect(client.restoreBackup('backup-' + crypto.randomUUID())).rejects.toThrow();
        client.recordTranscript(draft('retain after cancellation').payload as TranscriptEvent);
        await client.outbox.flushToDisk();
        const pending = structuredClone(store.events);
        checking = true;
        if (outcome === 'not-applied') {
          await client.cancelPendingRestore();
          expect(store.restoreIntent).toBeNull();
          expect(store.events).toEqual(pending);
          expect(client.getStatus().restorePending).toBe(false);
          await client.flushPending();
          expect(server.committed.size).toBe(1);
        } else {
          await expect(client.cancelPendingRestore()).rejects.toThrow();
          expect(store.restoreIntent).not.toBeNull();
          expect(store.events).toEqual(pending);
          expect(client.getStatus()).toMatchObject({ state: 'read_only', restorePending: true });
        }
      } finally {
        client.dispose();
      }
    },
  );
  it('keeps the restore intent but releases renewal timers after an unsuccessful reconciliation', async () => {
    vi.useFakeTimers();
    const server = service();
    const store = new MemoryMeetingStore();
    const client = new MeetingArchiveClient({
      store,
      fetcher: async (url, init) =>
        String(url).endsWith('/meetings/restore')
          ? Response.json({ error: 'ARCHIVE_FAILURE' }, { status: 503 })
          : server.fetcher(url, init),
    });
    try {
      await client.startMeeting(metadata);
      await expect(client.restoreBackup('backup-' + crypto.randomUUID())).rejects.toThrow();
      const intent = structuredClone(store.restoreIntent);
      await expect(client.reconcileRestore()).rejects.toThrow();
      expect(store.restoreIntent).toEqual(intent);
      expect(client.getStatus()).toMatchObject({ state: 'read_only', restorePending: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.dispose();
    }
  });
  it('retains late events instead of clearing the outbox after restore', async () => {
    const server = service();
    const store = new MemoryMeetingStore();
    const client = new MeetingArchiveClient({
      store,
      fetcher: async (url, init) => {
        if (String(url).endsWith('/meetings/restore')) {
          await expect(
            client.startMeeting({ ...metadata, meetingId: crypto.randomUUID() }),
          ).rejects.toThrow('ARCHIVE_RESTORING');
          client.recordTranscript(draft('late retiring words').payload as TranscriptEvent);
          return Response.json({
            archiveGeneration: JSON.parse(String(init?.body)).generation,
            safetyBackupPath: '/safe/meetings.sqlite',
          });
        }
        return server.fetcher(url, init);
      },
    });
    try {
      await client.startMeeting(metadata);
      await expect(client.restoreBackup('backup-' + crypto.randomUUID())).rejects.toThrow(
        'ARCHIVE_PENDING_DATA',
      );
      expect(store.events.map((event) => event.payload)).toContainEqual(
        expect.objectContaining({ text: 'late retiring words' }),
      );
      expect(store.generation).toBeNull();
      expect(client.getStatus()).toMatchObject({
        state: 'read_only',
        retryBlocked: true,
        pendingCount: 1,
      });
      expect(server.committed.size).toBe(0);
      store.fail = true;
      client.recordTranscript({
        ...(draft('later RAM-only words').payload as TranscriptEvent),
        segmentId: 'late-ram',
      });
      await client.flushPending().catch(() => {});
      expect(client.getStatus()).toMatchObject({
        state: 'read_only',
        retryBlocked: true,
        error: 'archive_generation_changed',
      });
    } finally {
      client.dispose();
    }
  });
  it('imports a snapshot admitted under the current restored generation', async () => {
    const server = service();
    const generation = crypto.randomUUID();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: async (url, init) =>
        String(url).endsWith('/local/bootstrap')
          ? Response.json({
              token: 'local-token',
              storageAvailable: true,
              archiveGeneration: generation,
            })
          : server.fetcher(url, init),
    });
    try {
      await client.restoreTranslationSnapshot(
        { ...metadata, captionTask: { purpose: 'translation', langPair: 'en→zh-TW' } },
        [draft('current snapshot').payload as TranscriptEvent],
        generation,
      );
      expect([...server.committed.values()][0]?.payload).toMatchObject({
        text: 'current snapshot',
      });
      expect(client.getArchiveGeneration()).toBe(generation);
    } finally {
      client.dispose();
    }
  });
  it.each([null, '11111111-1111-4111-8111-111111111111'])(
    'rejects snapshot generation %s before importing into a restored archive',
    async (snapshotGeneration) => {
      const server = service();
      const store = new MemoryMeetingStore();
      const generation = crypto.randomUUID();
      const client = new MeetingArchiveClient({
        store,
        fetcher: async (url, init) =>
          String(url).endsWith('/local/bootstrap')
            ? Response.json({
                token: 'local-token',
                storageAvailable: true,
                archiveGeneration: generation,
              })
            : server.fetcher(url, init),
      });
      const events = [draft('keep old snapshot').payload as TranscriptEvent];
      try {
        await expect(
          client.restoreTranslationSnapshot(
            { ...metadata, captionTask: { purpose: 'translation', langPair: 'en→zh-TW' } },
            events,
            snapshotGeneration,
          ),
        ).rejects.toThrow('ARCHIVE_GENERATION_MISMATCH');
        expect(store.meetings).toEqual([]);
        expect(server.committed.size).toBe(0);
        expect(events[0]?.text).toBe('keep old snapshot');
        expect(client.getStatus()).toMatchObject({
          state: 'read_only',
          error: 'archive_generation_changed',
        });
      } finally {
        client.dispose();
      }
    },
  );
  it('finalizes a drained old meeting without marking its successor finalized', async () => {
    const server = service();
    const client = new MeetingArchiveClient({
      store: new MemoryMeetingStore(),
      fetcher: server.fetcher,
    });
    try {
      await client.startMeeting(metadata);
      const writer = client.bindCurrentMeeting();
      const successor = { ...metadata, meetingId: crypto.randomUUID() };
      await client.startMeeting(successor);
      writer.recordTranscript(draft('last old words').payload as TranscriptEvent);
      const manifest = await client.finalizeMeeting(metadata.meetingId);
      expect(manifest.saved).toBe(true);
      expect([...server.committed.values()][0]?.meetingId).toBe(metadata.meetingId);
      expect(client.getStatus().meetingId).toBe(successor.meetingId);
      expect(client.getStatus().manifest).toBeNull();
      expect(
        server.fetcher.mock.calls.some(
          ([url]) => String(url) === `/meetings/${metadata.meetingId}/finalize`,
        ),
      ).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each([401, 404, 503])(
    'does not recreate a meeting on an unclassified %s response',
    async (status) => {
      const server = service();
      let creates = 0;
      const fetcher: typeof fetch = async (url, init) => {
        if (String(url).includes('?offset='))
          return Response.json({ error: 'UNAVAILABLE' }, { status });
        if (String(url).endsWith('/meetings') && init?.method === 'POST') creates++;
        return server.fetcher(url, init);
      };
      const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
      try {
        await expect(
          client.restoreTranslationSnapshot(
            {
              ...metadata,
              captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
            },
            [draft().payload as TranscriptEvent],
          ),
        ).rejects.toThrow();
        expect(creates).toBe(0);
        expect(server.batches).toHaveLength(0);
      } finally {
        client.dispose();
      }
    },
  );

  it('resumes an interrupted import without duplicating acknowledged or pending segments', async () => {
    const server = service({ loseAck: true });
    let created = false;
    const fetcher: typeof fetch = async (url, init) => {
      const path = String(url);
      if (path.includes('?offset=') && !created)
        return Response.json({ error: 'MEETING_NOT_FOUND' }, { status: 404 });
      if (path.endsWith('/meetings') && init?.method === 'POST') created = true;
      return server.fetcher(url, init);
    };
    const client = new MeetingArchiveClient({ store: new MemoryMeetingStore(), fetcher });
    const saved = {
      ...metadata,
      captionTask: { purpose: 'translation' as const, langPair: 'en→zh-TW' as const },
    };
    const first = draft('legacy one').payload as TranscriptEvent;
    const second = { ...first, segmentId: 'two', text: 'legacy two' };
    try {
      await expect(client.restoreTranslationSnapshot(saved, [first, second])).rejects.toThrow();
      expect(client.getStatus().pendingCount).toBe(2);
      await client.restoreTranslationSnapshot(saved, [first, second]);
      expect(server.committed.size).toBe(2);
      expect(client.getStatus().pendingCount).toBe(0);
      await client.restoreTranslationSnapshot(saved, [
        { ...first, text: 'stale snapshot must not overwrite' },
        second,
      ]);
      expect(server.committed.size).toBe(2);
      expect([...server.committed.values()][0]?.payload).toMatchObject({ text: 'legacy one' });
    } finally {
      client.dispose();
    }
  });
});
