import { expect, test } from '@playwright/test';

test('IndexedDB upgrade preserves legacy pending data and refuses the old schema opener', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/store/meeting-outbox.ts';
    const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ path);
    const name = 'legacy-upgrade-' + crypto.randomUUID();
    const meetingId = crypto.randomUUID(),
      writerId = crypto.randomUUID();
    const metadata = {
      meetingId,
      title: '舊待存',
      createdAt: new Date().toISOString(),
      captionTask: {
        purpose: 'transcription',
        inputLanguages: ['en'],
        textPolicy: 'zh-TW-preserve-original',
      },
    };
    const event = {
      schemaVersion: 1,
      meetingId,
      writerId,
      eventId: crypto.randomUUID(),
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: 1,
      revision: 7,
      payload: {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'one',
        status: 'final',
        text: '舊待存原稿',
        startMs: 0,
      },
    };
    const loss = {
      gapId: crypto.randomUUID(),
      meetingId,
      trackId: 'storage',
      captureEpoch: writerId,
      state: 'unrecoverable',
      alignment: 'estimated',
      cause: 'memory_limit',
      wallClock: { startAt: metadata.createdAt, endAt: metadata.createdAt },
      storageLoss: { lostCount: 1 },
    };
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('identity');
        db.createObjectStore('meetings', { keyPath: 'meetingId' });
        db.createObjectStore('revisions');
        db.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true }).createIndex(
          'eventId',
          'event.eventId',
          { unique: true },
        );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(['identity', 'meetings', 'revisions', 'events'], 'readwrite');
      tx.objectStore('identity').put(writerId, 'writerId');
      tx.objectStore('identity').put(loss, `loss:${meetingId}:${loss.gapId}`);
      tx.objectStore('meetings').put(metadata);
      tx.objectStore('revisions').put(7, `${meetingId}:transcript:one`);
      tx.objectStore('events').add({
        event,
        bytes: new TextEncoder().encode(JSON.stringify(event)).byteLength,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    let versionChanges = 0;
    legacy.onversionchange = () => {
      versionChanges++;
      legacy.close();
    };
    const upgraded = new IndexedDbMeetingStore(name);
    const pending = await upgraded.readBatch();
    const meetings = await upgraded.listMeetings();
    const losses = await upgraded.readLosses(meetingId);
    const sameWriter = (await upgraded.getWriterId()) === writerId;
    const oldOpen = await new Promise<string>((resolve) => {
      const request = indexedDB.open(name, 1);
      request.onerror = () => resolve(request.error?.name ?? 'unknown');
      request.onsuccess = () => {
        request.result.close();
        resolve('unexpected success');
      };
    });
    const next = await upgraded.append({
      ...event,
      eventId: crypto.randomUUID(),
      payload: { ...event.payload, text: '升版後修訂' },
    });
    legacy.close();
    return {
      unchanged:
        JSON.stringify(pending) === JSON.stringify([event]) &&
        JSON.stringify(meetings) === JSON.stringify([metadata]) &&
        JSON.stringify(losses) === JSON.stringify([loss]),
      sameWriter,
      versionChanges,
      oldOpen,
      nextRevision: next.revision,
      count: await upgraded.count(),
    };
  });
  expect(result).toEqual({
    unchanged: true,
    sameWriter: true,
    versionChanges: 1,
    oldOpen: 'VersionError',
    nextRevision: 8,
    count: 2,
  });
});

test('IndexedDB generation binding fences stale instances without discarding pending data', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/store/meeting-outbox.ts';
    const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ path);
    const name = 'generation-' + crypto.randomUUID();
    const stale = new IndexedDbMeetingStore(name);
    const writerId = await stale.getWriterId();
    const current = new IndexedDbMeetingStore(name);
    const generation = crypto.randomUUID();
    await current.bindArchiveGeneration(generation);
    const event = {
      schemaVersion: 1,
      meetingId: crypto.randomUUID(),
      writerId,
      eventId: crypto.randomUUID(),
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: 1,
      payload: {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'one',
        status: 'final',
        text: '目前待存',
        startMs: 0,
      },
    };
    let staleError = '',
      changeError = '';
    try {
      await stale.append(event);
    } catch (error) {
      staleError = (error as Error).message;
    }
    const appended = await current.append(event);
    const reopened = new IndexedDbMeetingStore(name);
    try {
      await reopened.bindArchiveGeneration(crypto.randomUUID());
    } catch (error) {
      changeError = (error as Error).message;
    }
    await reopened.bindArchiveGeneration(generation);
    return {
      staleError,
      changeError,
      retained: JSON.stringify(await reopened.readBatch()) === JSON.stringify([appended]),
      count: await reopened.count(),
    };
  });
  expect(result).toEqual({
    staleError: 'ARCHIVE_GENERATION_MISMATCH',
    changeError: 'ARCHIVE_GENERATION_MISMATCH',
    retained: true,
    count: 1,
  });
});

test('IndexedDB restore transition rejects pending events and preserves retired loss records', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/store/meeting-outbox.ts';
    const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ path);
    const name = 'restore-local-' + crypto.randomUUID();
    const store = new IndexedDbMeetingStore(name);
    const writerId = await store.getWriterId();
    const meetingId = crypto.randomUUID();
    const metadata = {
      meetingId,
      title: 'saved meeting',
      createdAt: new Date().toISOString(),
      captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
    };
    await store.saveMeeting(metadata);
    const loss = { meetingId, gapId: 'loss-before-restore', storageLoss: { lostCount: 2 } };
    await store.saveLoss(loss);
    const event = await store.append({
      schemaVersion: 1,
      meetingId,
      writerId,
      eventId: crypto.randomUUID(),
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: 0,
      payload: {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'same-segment',
        status: 'final',
        text: 'pending',
        startMs: 0,
      },
    });
    const generation = crypto.randomUUID();
    let pendingError = '';
    try {
      await store.retireForRestore(generation);
    } catch (error) {
      pendingError = (error as Error).message;
    }
    const retained = (await store.readBatch())[0]?.eventId;
    await store.acknowledge([event.eventId]);
    await store.retireForRestore(generation);
    let staleError = '';
    try {
      await store.saveMeeting(metadata);
    } catch (error) {
      staleError = (error as Error).message;
    }
    const fresh = new IndexedDbMeetingStore(name);
    await fresh.bindArchiveGeneration(generation);
    const archivedLoss = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('identity');
        const read = tx
          .objectStore('identity')
          .get('retired:legacy:loss:' + meetingId + ':' + loss.gapId);
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
      };
    });
    return {
      pendingError,
      retained: retained === event.eventId,
      staleError,
      meetings: await fresh.listMeetings(),
      losses: await fresh.readLosses(meetingId),
      archivedLoss,
      loss,
      writerUnchanged: (await fresh.getWriterId()) === writerId,
    };
  });
  expect(result).toMatchObject({
    pendingError: 'ARCHIVE_PENDING_DATA',
    retained: true,
    staleError: 'ARCHIVE_GENERATION_MISMATCH',
    meetings: [],
    losses: [],
    writerUnchanged: true,
  });
  expect(result.archivedLoss).toEqual(result.loss);
});

test('explicit restore retirement preserves late events and metadata for download after reload', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/store/meeting-outbox.ts';
    const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ path);
    const name = `restore-tail-${crypto.randomUUID()}`;
    const store = new IndexedDbMeetingStore(name);
    const meeting = {
      meetingId: crypto.randomUUID(),
      title: 'retiring meeting',
      createdAt: new Date().toISOString(),
      captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
    };
    await store.saveMeeting(meeting);
    const event = await store.append({
      schemaVersion: 1,
      meetingId: meeting.meetingId,
      writerId: await store.getWriterId(),
      eventId: crypto.randomUUID(),
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: 1,
      payload: {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'late',
        status: 'final',
        text: 'retained late words',
        startMs: 0,
      },
    });
    const generation = crypto.randomUUID();
    const originalPut = IDBObjectStore.prototype.put;
    let copied = 0;
    let failed = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'identity' && String(key).startsWith('retired:') && ++copied === 2)
        return this.add(value, 'writerId'); // real duplicate-key transaction abort
      return originalPut.call(this, value, key);
    };
    try {
      await store.retireForRestore(generation, true);
    } catch {
      failed = true;
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const beforeRetry = {
      failed,
      copied,
      pending: await store.readBatch(),
      meetings: await store.listMeetings(),
      retired: await (await store.exportRetired()).text(),
    };
    await store.retireForRestore(generation, true);
    const stale = await store.append({ ...event, eventId: crypto.randomUUID() }).then(
      () => '',
      (e: Error) => e.message,
    );
    const fresh = new IndexedDbMeetingStore(name);
    await fresh.bindArchiveGeneration(generation);
    const exported = (await (await fresh.exportRetired()).text())
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    return {
      stale,
      pending: await fresh.count(),
      meetings: await fresh.listMeetings(),
      exported,
      meeting,
      event,
      beforeRetry,
    };
  });
  expect(result.stale).toBe('ARCHIVE_GENERATION_MISMATCH');
  expect(result.pending).toBe(0);
  expect(result.beforeRetry).toEqual({
    failed: true,
    copied: 2,
    pending: [result.event],
    meetings: [result.meeting],
    retired: '',
  });
  expect(result.meetings).toEqual([]);
  expect(result.exported).toContainEqual({
    key: `retired:legacy:meeting:${result.meeting.meetingId}`,
    value: result.meeting,
  });
  expect(result.exported).toContainEqual({
    key: `retired:legacy:event:${result.event.eventId}`,
    value: result.event,
  });
});

test('IndexedDB keeps translation and transcript revisions independent across reopened stores', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/store/meeting-outbox.ts';
    const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ modulePath);
    const databaseName = `revision-verification-${crypto.randomUUID()}`;
    const store = new IndexedDbMeetingStore(databaseName);
    const meetingId = crypto.randomUUID();
    const writerId = await store.getWriterId();
    const translation = {
      kind: 'translation',
      provider: 'openai-realtime',
      mode: 'online_full',
      sourceSegmentId: 'same-id',
      status: 'final',
      sourceText: 'source',
      targetText: '譯文',
      sourceLanguage: 'en',
      targetLanguage: 'zh-TW',
      updatedAt: new Date().toISOString(),
    };
    const envelope = (payload: unknown) => ({
      schemaVersion: 1,
      meetingId,
      writerId,
      eventId: crypto.randomUUID(),
      connectionId: null,
      observedAt: new Date().toISOString(),
      monotonicMs: performance.now(),
      payload,
    });
    await store.seedRevisions(
      meetingId,
      [{ segmentId: 'same-id', revision: 8 }],
      [{ sourceSegmentId: 'same-id', revision: 5 }],
    );
    const first = await store.append(envelope(translation));
    const reopened = new IndexedDbMeetingStore(databaseName);
    await reopened.seedRevisions(
      meetingId,
      [{ segmentId: 'same-id', revision: 3 }],
      [{ sourceSegmentId: 'same-id', revision: 2 }],
    );
    const second = await reopened.append(envelope({ ...translation, targetText: '續接譯文' }));
    const source = await reopened.append(
      envelope({
        kind: 'transcript',
        provider: 'openai-realtime',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'same-id',
        status: 'final',
        text: 'continued source',
        startMs: 0,
      }),
    );
    const pending = await reopened.readBatch();
    const value = {
      revisions: [first.revision, second.revision, source.revision],
      pending: pending.length,
      sameWriter: (await reopened.getWriterId()) === writerId,
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Test database still open'));
    });
    return value;
  });
  expect(result).toEqual({ revisions: [6, 7, 9], pending: 3, sameWriter: true });
});
