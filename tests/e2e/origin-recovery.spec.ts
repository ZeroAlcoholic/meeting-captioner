import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { runService, requestService } from '../../scripts/managed-service.mjs';
import { registerMeetings } from '../../services/online/src/routes/meetings.js';

const require = createRequire(new URL('../../services/online/package.json', import.meta.url));
const Fastify = require('fastify');

test('original origin replays its lost ACK after another origin cannot see the pending outbox', async ({
  page,
  baseURL,
}) => {
  const root = await mkdtemp(resolve('.cache/origin-recovery-'));
  const otherRoot = await mkdtemp(resolve('.cache/origin-unrelated-'));
  const services: Array<{ stop(): Promise<void> }> = [];
  const previousDataDir = process.env.MEETING_DATA_DIR;
  let foreignConnections = 0;
  const foreign = createServer((socket) => {
    foreignConnections++;
    socket.end();
  });
  const start = async (workspace: string) => {
    process.env.MEETING_DATA_DIR = join(root, 'archive');
    const service = await runService({
      root: workspace,
      preferredPort: 0,
      prepare: async () => ({ buildId: 'origin-recovery-test' }),
      createApp: async () => {
        const app = Fastify({ logger: false });
        await registerMeetings(app);
        app.get(
          '/',
          (_request: unknown, reply: { type(value: string): { send(value: string): unknown } }) =>
            reply.type('text/html').send('<!doctype html><title>Origin recovery fixture</title>'),
        );
        return app;
      },
    });
    services.push(service);
    return { service, state: await service.ready };
  };
  try {
    const first = await start(root);
    await page.goto(first.state.url);
    const saved = await page.evaluate(async (moduleOrigin) => {
      const { MeetingArchiveClient } = await import(
        /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-archive-client.ts`
      );
      const { IndexedDbMeetingStore } = await import(
        /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-outbox.ts`
      );
      const database = `origin-outbox-${crypto.randomUUID()}`;
      const store = new IndexedDbMeetingStore(database);
      let loseAck = false;
      const client = new MeetingArchiveClient({
        store,
        fetcher: async (url: string, init: RequestInit) => {
          const response = await fetch(url, init);
          if (loseAck && String(url).endsWith('/events')) {
            loseAck = false;
            throw new TypeError('Injected lost ACK after commit');
          }
          return response;
        },
      });
      const meetingId = crypto.randomUUID();
      await client.startMeeting({
        meetingId,
        title: 'Origin recovery',
        createdAt: new Date().toISOString(),
        captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
      });
      const event = {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'acknowledged',
        status: 'final',
        text: 'Acknowledged source',
        startMs: 0,
      };
      client.recordTranscript(event);
      await client.flushPending();
      loseAck = true;
      client.recordTranscript({
        ...event,
        segmentId: 'lost-ack',
        text: 'Committed without ACK',
        startMs: 1,
      });
      let failed = false;
      try {
        await client.flushPending();
      } catch {
        failed = true;
      }
      const pending = await store.readBatch();
      client.dispose();
      return {
        meetingId,
        database,
        failed,
        pendingIds: pending.map((entry: { eventId: string }) => entry.eventId),
      };
    }, baseURL!);
    expect(saved.failed).toBe(true);
    expect(saved.pendingIds).toHaveLength(1);
    await first.service.stop();
    await new Promise<void>((resolve) =>
      foreign.listen(Number(new URL(first.state.url).port), '127.0.0.1', resolve),
    );

    const other = await start(otherRoot);
    expect(other.state.url).not.toBe(first.state.url);
    await page.goto(other.state.url);
    const invisible = await page.evaluate(
      async ({ moduleOrigin, saved }) => {
        const { IndexedDbMeetingStore } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-outbox.ts`
        );
        const { MeetingArchiveClient } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-archive-client.ts`
        );
        const store = new IndexedDbMeetingStore(saved.database);
        const client = new MeetingArchiveClient({ store });
        try {
          return {
            pending: (await store.readBatch()).length,
            page: await client.loadMeeting(saved.meetingId),
          };
        } finally {
          client.dispose();
        }
      },
      { moduleOrigin: baseURL!, saved },
    );
    expect(invisible.pending).toBe(0);
    expect(invisible.page.totalSegments).toBe(2);
    await other.service.stop();
    expect(foreignConnections).toBe(0);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));

    const restored = await start(root);
    expect(restored.state.url).toBe(first.state.url);
    const owner = await requestService(root);
    const identity = await (
      await page.request.get(`${restored.state.url}/_meeting-audio/instance`)
    ).json();
    expect(identity.workspaceId).toBe(first.state.workspaceId);
    expect(identity.instanceId).toBe(owner.instanceId);
    expect(identity.buildId).toBe(owner.buildId);
    await page.goto(restored.state.url);
    const recovered = await page.evaluate(
      async ({ moduleOrigin, saved }) => {
        const { IndexedDbMeetingStore } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-outbox.ts`
        );
        const { MeetingArchiveClient } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-archive-client.ts`
        );
        const store = new IndexedDbMeetingStore(saved.database);
        const before = await store.readBatch();
        const client = new MeetingArchiveClient({ store });
        try {
          await client.continueMeeting(saved.meetingId);
          await client.flushPending();
          const manifest = await client.finalize();
          return {
            manifest,
            beforeIds: before.map((entry: { eventId: string }) => entry.eventId),
            pending: (await store.readBatch()).length,
            page: await client.loadMeeting(saved.meetingId),
          };
        } finally {
          client.dispose();
        }
      },
      { moduleOrigin: baseURL!, saved },
    );
    expect(recovered.beforeIds).toEqual(saved.pendingIds);
    expect(recovered.pending).toBe(0);
    expect(recovered.manifest.saved).toBe(true);
    expect(recovered.manifest.pendingCount).toBe(0);
    expect(recovered.page.totalSegments).toBe(2);
    expect(recovered.page.segments.map((entry: { text: string }) => entry.text)).toEqual([
      'Acknowledged source',
      'Committed without ACK',
    ]);
  } finally {
    if (foreign.listening) await new Promise<void>((resolve) => foreign.close(() => resolve()));
    for (const service of services.reverse()) await service.stop();
    if (previousDataDir === undefined) delete process.env.MEETING_DATA_DIR;
    else process.env.MEETING_DATA_DIR = previousDataDir;
  }
});
