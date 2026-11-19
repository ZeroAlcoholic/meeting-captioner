import { expect, test } from '@playwright/test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { storageFixture } from './storage-fixture.js';
import { installOnlineMocks } from './online-mock.js';

for (const purpose of ['transcription', 'translation'] as const) {
  for (const status of [
    400,
    413,
    422,
    'export',
    'quota',
    'blocked',
    'full',
    'ioerr',
    'lock',
    'worker_exit',
    'worker_hang',
    'ack_lost',
  ] as const) {
    test(`${purpose}: ${status} failure retains events and the visible retry completes SQLite and export`, async ({
      page,
      baseURL,
    }) => {
      const workerFault = status === 'worker_exit' || status === 'worker_hang';
      const { app, repository, url, root, faultFlag, faultLog } = await storageFixture(
        [baseURL!],
        status === 'full' || status === 'ioerr' || workerFault,
      );
      const originalWorker = (repository as unknown as { worker: Worker }).worker;
      let exited = false;
      let armedAt = 0;
      let exitElapsed = 0;
      let earlyCommits = 0;
      originalWorker.once('exit', () => {
        exited = true;
        exitElapsed = performance.now() - armedAt;
      });
      let databaseLock: DatabaseSync | null = null;
      if (status === 'full' || status === 'ioerr' || status === 'lock' || workerFault)
        await page.exposeFunction('armDatabaseFault', async () => {
          armedAt = performance.now();
          if (status === 'lock') {
            databaseLock = new DatabaseSync(join(root, 'meetings.sqlite'));
            databaseLock.exec('BEGIN EXCLUSIVE');
          } else await writeFile(faultFlag, status);
        });
      const cdp = status === 'quota' ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        // Chromium treats zero as unlimited when checking bucket space; use one byte.
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: baseURL!, quotaSize: 1 });
        expect(await cdp.send('Storage.getUsageAndQuota', { origin: baseURL! })).toMatchObject({
          quota: 1,
          overrideActive: true,
        });
      }
      if (status === 'export') await writeFile(join(root, 'exports'), 'directory obstruction');
      let rejecting = true;
      let rejected = 0;
      const cors = {
        'access-control-allow-origin': baseURL!,
        'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      await page.route('**/*', async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin === new URL(baseURL!).origin) return route.continue();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
          return route.fulfill({ status: 503, headers: cors, body: '{}' });
        if (typeof status === 'number' && rejecting && target.pathname.endsWith('/events')) {
          rejected++;
          return route.fulfill({
            status,
            headers: cors,
            contentType: 'application/json',
            body: JSON.stringify({
              error: status === 400 ? 'INVALID_MEETING_EVENTS' : 'ARCHIVE_OPERATION_FAILED',
            }),
          });
        }
        const response = await route.fetch({ url: url + target.pathname + target.search });
        if (status === 'ack_lost' && rejecting && target.pathname.endsWith('/events')) {
          expect(response.ok()).toBe(true);
          rejected++;
          return route.abort('connectionreset');
        }
        if (workerFault && target.pathname.endsWith('/events') && response.ok() && !exited)
          earlyCommits++;
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      });
      try {
        await page.goto('/');
        await page
          .getByRole('button', {
            name: purpose === 'transcription' ? '純字幕（繁中＋原文）' : '即時翻譯',
            exact: true,
          })
          .click();
        const { meetingId, storageError, storageProbe } = await page.evaluate(
          async ({ purpose, exportFault, idbFault, databaseFault }) => {
            const path = '/src/store/meeting-archive.ts';
            const { meetingArchive: client } = await import(/* @vite-ignore */ path);
            const meetingId = crypto.randomUUID();
            await client.startMeeting({
              meetingId,
              title: 'HTTP recovery',
              createdAt: new Date().toISOString(),
              captionTask:
                purpose === 'translation'
                  ? { purpose, langPair: 'en→zh-TW' }
                  : {
                      purpose,
                      inputLanguages: ['zh-tw', 'en'],
                      textPolicy: 'zh-TW-preserve-original',
                    },
            });
            if (purpose === 'translation') {
              const storePath = '/src/store/use-caption-store.ts';
              const { captionStore } = await import(/* @vite-ignore */ storePath);
              captionStore.setState({
                sessionId: meetingId,
                sessionPhase: 'ended',
                sessionMode: 'real',
              });
            }
            if (idbFault === 'blocked') {
              // Inject only the blocked signal; the real request later succeeds and must be closed.
              const open = IDBFactory.prototype.open;
              IDBFactory.prototype.open = function (...args) {
                const request = open.apply(this, args);
                if (args[0] === 'meeting-audio-outbox')
                  queueMicrotask(() => request.dispatchEvent(new Event('blocked')));
                return request;
              };
              (window as unknown as { restoreStorage(): void }).restoreStorage = () => {
                IDBFactory.prototype.open = open;
              };
            }
            if (databaseFault)
              await (window as unknown as { armDatabaseFault(): Promise<void> }).armDatabaseFault();
            const padding = databaseFault === 'full' ? 'x'.repeat(100_000) : '';
            const event = {
              kind: 'transcript',
              provider: 'fixture',
              mode: 'online_full',
              source: 'microphone',
              segmentId: 'one',
              status: 'final',
              text: 'repeat' + padding,
              startMs: 0,
            };
            client.recordTranscript(event);
            client.recordTranscript({ ...event, segmentId: 'two', startMs: 1 });
            client.recordTranscript({ ...event, text: 'revised' + padding });
            if (purpose === 'translation') {
              const translation = {
                kind: 'translation',
                provider: 'fixture',
                mode: 'online_full',
                sourceSegmentId: 'one',
                status: 'final',
                sourceText: 'revised',
                targetText: '初稿',
                sourceLanguage: 'en',
                targetLanguage: 'zh-TW',
                updatedAt: new Date().toISOString(),
              };
              client.recordTranslation(translation);
              client.recordTranslation({ ...translation, targetText: '修訂譯文' });
            }
            let storageError = '';
            await client.flushPending().catch((error: Error) => {
              storageError = `${error.name}:${error.message}`;
            });
            client.recordGap({
              gapId: crypto.randomUUID(),
              meetingId,
              trackId: 'mic',
              captureEpoch: 'test',
              state: 'unrecoverable',
              alignment: 'estimated',
              cause: 'capture interrupted',
              wallClock: { startAt: '2026-10-15T00:00:00.000Z', endAt: '2026-10-15T00:00:01.000Z' },
            });
            await client.outbox.flushToDisk().catch((error: Error) => {
              if (!idbFault) throw error;
              storageError = `${error.name}:${error.message}`;
            });
            if (exportFault) await client.finalize();
            return {
              meetingId,
              storageError,
              storageProbe:
                idbFault === 'quota'
                  ? {
                      origin: location.origin,
                      estimate: await navigator.storage.estimate(),
                      persisted: await navigator.storage.persisted(),
                    }
                  : null,
            };
          },
          {
            purpose,
            exportFault: status === 'export',
            idbFault: status === 'quota' || status === 'blocked' ? status : null,
            databaseFault:
              status === 'full' || status === 'ioerr' || status === 'lock' || workerFault
                ? status
                : null,
          },
        );
        if (status === 'quota' || status === 'blocked') {
          expect(
            storageError,
            JSON.stringify({
              storageProbe,
              protocol: cdp
                ? await cdp.send('Storage.getUsageAndQuota', { origin: baseURL! })
                : null,
            }),
          ).toContain(status === 'quota' ? 'QuotaExceededError' : 'IndexedDB upgrade blocked');
          await expect(
            page.getByText('尚有內容僅在記憶體中，關閉或重新整理分頁可能遺失。請先恢復本機保存。'),
          ).toBeVisible();
          if (status === 'quota') expect(await repository.listMeetings()).toHaveLength(0);
          else expect((await repository.snapshot(meetingId)).events).toHaveLength(0);
          if (cdp) await cdp.send('Storage.overrideQuotaForOrigin', { origin: baseURL! });
          else
            await page.evaluate(() =>
              (window as unknown as { restoreStorage(): void }).restoreStorage(),
            );
        } else if (workerFault) {
          await expect(page.getByText(/保存異常，資料尚未全部確認/)).toBeVisible();
          await expect(
            page.getByText('內容已暫存於此瀏覽器，尚待本機服務確認保存。'),
          ).toBeVisible();
          const inspection = new DatabaseSync(join(root, 'meetings.sqlite'), { readOnly: true });
          try {
            expect(inspection.prepare('SELECT COUNT(*) AS count FROM events').get()?.count).toBe(0);
          } finally {
            inspection.close();
          }
          expect(await readFile(faultLog, 'utf8')).toContain(status);
          await unlink(faultFlag);
        } else if (status === 'full' || status === 'ioerr' || status === 'lock') {
          await expect(page.getByText(/保存異常，資料尚未全部確認/)).toBeVisible();
          await expect(
            page.getByText('內容已暫存於此瀏覽器，尚待本機服務確認保存。'),
          ).toBeVisible();
          const inspection = databaseLock ?? new DatabaseSync(join(root, 'meetings.sqlite'));
          expect(inspection.prepare('SELECT COUNT(*) AS count FROM events').get()?.count).toBe(0);
          if (databaseLock) {
            databaseLock.exec('ROLLBACK');
            databaseLock.close();
            databaseLock = null;
          } else {
            inspection.close();
            expect(await readFile(faultLog, 'utf8')).toContain(
              status === 'full' ? 'native SQLITE_FULL' : 'injected SQLITE_IOERR at COMMIT',
            );
            await unlink(faultFlag);
          }
        } else if (status === 'ack_lost') {
          await expect(page.getByText(/保存異常，資料尚未全部確認/)).toBeVisible();
          await expect(
            page.getByText('內容已暫存於此瀏覽器，尚待本機服務確認保存。'),
          ).toBeVisible();
          expect(rejected).toBeGreaterThan(0);
          expect((await repository.snapshot(meetingId)).events.length).toBeGreaterThan(0);
        } else if (status === 'export') {
          await expect(page.getByText('匯出副本更新失敗，請重試保存後再匯出。')).toBeVisible();
          expect((await repository.snapshot(meetingId)).manifest?.saved).toBe(true);
          await unlink(join(root, 'exports'));
        } else {
          await expect(page.getByText(/已暫停自動重送；待存逐字稿仍保留/)).toBeVisible();
          expect(rejected).toBe(1);
          expect((await repository.snapshot(meetingId)).events).toHaveLength(0);
        }
        rejecting = false;
        await page.getByRole('button', { name: '重試保存／結案', exact: true }).click();
        if (workerFault) {
          await expect.poll(() => exited, { timeout: 20_000 }).toBe(true);
          expect(originalWorker.threadId).toBe(-1);
          if (status === 'worker_hang') {
            expect(exitElapsed).toBeGreaterThanOrEqual(14_500);
            expect(exitElapsed).toBeLessThan(20_000);
          }
          await test.info().attach('worker-exit-timing', {
            body: JSON.stringify({ status, exitElapsed }),
            contentType: 'application/json',
          });
        }
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              const path = '/src/store/meeting-archive.ts';
              const { meetingArchive } = await import(/* @vite-ignore */ path);
              try {
                return (await meetingArchive.loadMeeting(id)).manifest?.saved;
              } catch (error) {
                // Quota can prevent initial creation; retry must register the
                // meeting before the HTTP polling endpoint can find it.
                if (
                  error instanceof Error &&
                  'status' in error &&
                  error.status === 404 &&
                  'code' in error &&
                  error.code === 'MEETING_NOT_FOUND'
                )
                  return false;
                throw error;
              }
            }, meetingId),
          )
          .toBe(true);
        await expect(page.getByText(/已暫停自動重送；待存逐字稿仍保留/)).toHaveCount(0);
        await expect(page.getByText('匯出副本更新失敗，請重試保存後再匯出。')).toHaveCount(0);
        const exported = await page.evaluate(async (id) => {
          const path = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ path);
          return JSON.parse(
            await (await meetingArchive.exportMeeting(id, 'corrected', 'json')).text(),
          );
        }, meetingId);
        expect(earlyCommits).toBe(0);
        if (workerFault)
          console.info(
            '[storage-worker]',
            JSON.stringify({ purpose, status, exitElapsed, earlyCommits }),
          );
        const count = purpose === 'translation' ? 6 : 4;
        expect(exported.events).toHaveLength(count);
        expect(
          new Set(exported.events.map((event: { eventId: string }) => event.eventId)).size,
        ).toBe(count);
        expect(
          exported.segments.map((s: { text: string; revision: number }) => [s.text, s.revision]),
        ).toEqual([
          ['revised' + (status === 'full' ? 'x'.repeat(100_000) : ''), 2],
          ['repeat' + (status === 'full' ? 'x'.repeat(100_000) : ''), 1],
        ]);
        expect(exported.metadata.manifest.gaps).toHaveLength(1);
        if (purpose === 'translation')
          expect(exported.translations.one).toMatchObject({ targetText: '修訂譯文', revision: 2 });
        if (status === 'export')
          expect(
            JSON.parse(await readFile(join(root, 'exports', meetingId, 'corrected.json'), 'utf8')),
          ).toEqual(exported);
        if (status === 'blocked') {
          // A late successful open after the injected blocked signal must not leak a connection.
          await page.evaluate(
            () =>
              new Promise<void>((resolve, reject) => {
                const request = indexedDB.deleteDatabase('meeting-audio-outbox');
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                request.onblocked = () =>
                  reject(new Error('Blocked open leaked its late connection'));
              }),
          );
        }
      } finally {
        if (databaseLock) {
          databaseLock.exec('ROLLBACK');
          databaseLock.close();
        }
        if (cdp) {
          await cdp.send('Storage.overrideQuotaForOrigin', { origin: baseURL! });
          await cdp.detach();
        }
        await page.close();
        await app.close();
        await repository.close();
      }
    });
  }
}

for (const purpose of ['transcription', 'translation'] as const) {
  test(`${purpose}: app warns before discarding RAM-only text and permits reload after IDB recovery`, async ({
    page,
    baseURL,
  }) => {
    // This UI test must not contact the user's daily service or any cloud endpoint.
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(baseURL!).origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto('/');
    await page
      .getByRole('button', {
        name: purpose === 'transcription' ? '純字幕（繁中＋原文）' : '即時翻譯',
        exact: true,
      })
      .click();
    await page.evaluate(async (purpose) => {
      const path = '/src/store/meeting-archive.ts';
      const { meetingArchive } = await import(/* @vite-ignore */ path);
      await meetingArchive.initialize().catch(() => undefined);
      const meetingId = crypto.randomUUID();
      await meetingArchive.startMeeting({
        meetingId,
        title: 'Volatile UI test',
        createdAt: new Date().toISOString(),
        captionTask:
          purpose === 'translation'
            ? { purpose, langPair: 'en→zh-TW' }
            : {
                purpose,
                inputLanguages: ['zh-tw', 'en'],
                textPolicy: 'zh-TW-preserve-original',
              },
      });
      if (purpose === 'translation') {
        const storePath = '/src/store/use-caption-store.ts';
        const { captionStore } = await import(/* @vite-ignore */ storePath);
        captionStore.setState({ sessionId: meetingId, sessionPhase: 'ended', sessionMode: 'real' });
      }
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === 'meeting-audio-outbox' && args[1] === 'readwrite')
          queueMicrotask(() => tx.abort());
        return tx;
      };
      (window as unknown as { restoreStorage: () => void }).restoreStorage = () => {
        IDBDatabase.prototype.transaction = transaction;
      };
      meetingArchive.outbox.enqueue({
        schemaVersion: 1,
        meetingId,
        eventId: crypto.randomUUID(),
        writerId: crypto.randomUUID(),
        connectionId: null,
        observedAt: new Date().toISOString(),
        monotonicMs: performance.now(),
        payload: {
          kind: 'transcript',
          provider: 'fixture',
          mode: 'online_full',
          source: 'microphone',
          segmentId: 'volatile',
          status: 'final',
          text: 'Do not lose this text',
          startMs: 0,
        },
      });
      await meetingArchive.outbox.flushToDisk().catch(() => undefined);
    }, purpose);
    await expect(
      page.getByText('尚有內容僅在記憶體中，關閉或重新整理分頁可能遺失。請先恢復本機保存。'),
    ).toBeVisible();
    const dialogPromise = page.waitForEvent('dialog');
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 0);
    });
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await page.evaluate(async () => {
      (window as unknown as { restoreStorage: () => void }).restoreStorage();
      const path = '/src/store/meeting-archive.ts';
      const { meetingArchive } = await import(/* @vite-ignore */ path);
      await meetingArchive.outbox.flushToDisk();
    });
    await expect(page.getByText('內容已暫存於此瀏覽器，尚待本機服務確認保存。')).toBeVisible();
    await page.reload({ timeout: 10_000 });
    const pending = await page.evaluate(async () => {
      const path = '/src/store/meeting-outbox.ts';
      const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ path);
      return new IndexedDbMeetingStore().readBatch();
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].payload.text).toBe('Do not lose this text');
  });
}

test('aborted IDB writes retain loss warnings through real IDB recovery, reload and SQLite finalization', async ({
  page,
  baseURL,
}) => {
  const { app, repository, url } = await storageFixture();
  try {
    await page.goto(url);
    const saved = await page.evaluate(async (moduleOrigin) => {
      const { MeetingArchiveClient } = await import(
        /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-archive-client.ts`
      );
      const { IndexedDbMeetingStore } = await import(
        /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-outbox.ts`
      );
      const database = `loss-${crypto.randomUUID()}`;
      const store = new IndexedDbMeetingStore(database);
      const client = new MeetingArchiveClient({ store });
      const meetingId = crypto.randomUUID();
      await client.startMeeting({
        meetingId,
        title: 'Storage loss',
        createdAt: new Date().toISOString(),
        captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
      });
      const transaction = IDBDatabase.prototype.transaction;
      let aborted = 0;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === database && args[1] === 'readwrite') {
          queueMicrotask(() => {
            aborted++;
            tx.abort();
          });
        }
        return tx;
      };
      const event = {
        kind: 'transcript',
        provider: 'fixture',
        mode: 'online_full',
        source: 'microphone',
        segmentId: 'lost',
        status: 'final',
        text: 'x'.repeat(300_000),
        startMs: 0,
      };
      let failed = false;
      try {
        client.recordTranscript(event);
        await client.flushPending();
      } catch {
        failed = true;
      } finally {
        IDBDatabase.prototype.transaction = transaction;
      }
      const during = client.getStatus();
      await client.flushPending();
      const losses = await store.readLosses(meetingId);
      // A repeated real utterance is two distinct events; a revision remains one segment.
      client.recordTranscript({ ...event, segmentId: 'one', text: 'repeat' });
      client.recordTranscript({ ...event, segmentId: 'two', text: 'repeat' });
      await client.flushPending();
      client.recordTranscript({ ...event, segmentId: 'one', text: 'revised' });
      await client.flushPending();
      const manifest = await client.finalize();
      await client.release();
      client.dispose();
      return { database, meetingId, failed, aborted, during, losses, manifest };
    }, baseURL!);
    expect(saved.failed).toBe(true);
    expect(saved.aborted).toBeGreaterThan(0);
    expect(saved.during).toMatchObject({ lostCount: 1, error: 'local_storage_unavailable' });
    expect(saved.losses).toHaveLength(1);
    expect(saved.manifest).toMatchObject({ saved: false, lostCount: 1, pendingCount: 0 });

    await page.reload();
    const restored = await page.evaluate(
      async ({ moduleOrigin, saved }) => {
        const { MeetingArchiveClient } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-archive-client.ts`
        );
        const { IndexedDbMeetingStore } = await import(
          /* @vite-ignore */ `${moduleOrigin}/src/store/meeting-outbox.ts`
        );
        const client = new MeetingArchiveClient({
          store: new IndexedDbMeetingStore(saved.database),
        });
        try {
          await client.continueMeeting(saved.meetingId);
          const status = client.getStatus();
          const manifest = await client.finalize();
          const exported = JSON.parse(
            await (await client.exportMeeting(saved.meetingId, 'corrected', 'json')).text(),
          );
          return { status, manifest, exported };
        } finally {
          await client.release();
          client.dispose();
        }
      },
      { moduleOrigin: baseURL!, saved },
    );
    expect(restored.status).toMatchObject({ lostCount: 1, error: 'memory_limit' });
    expect(restored.manifest).toMatchObject({
      saved: false,
      lostCount: 1,
      unsavedSince: saved.manifest.unsavedSince,
      unsavedUntil: saved.manifest.unsavedUntil,
    });
    expect(restored.exported.metadata.finalized).toBe(false);
    expect(restored.exported.metadata.manifest.gaps).toHaveLength(1);
    expect(
      restored.exported.segments.map((s: { text: string; revision: number }) => [
        s.text,
        s.revision,
      ]),
    ).toEqual([
      ['revised', 2],
      ['repeat', 1],
    ]);
    expect(restored.exported.events).toHaveLength(3);
  } finally {
    await app.close();
    await repository.close();
  }
});

for (const provider of ['openai', 'gemini'] as const) {
  for (const ending of (provider === 'gemini'
    ? ['recover', 'stop', 'backpressure']
    : ['recover', 'stop']) as Array<'recover' | 'stop' | 'backpressure'>) {
    test(`${provider}: translation reconnect preserves an estimated delivery gap in SQLite (${ending})`, async ({
      page,
      baseURL,
    }) => {
      const fixture = await storageFixture([baseURL!]);
      const cors = {
        'access-control-allow-origin': baseURL!,
        'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      await page.route('**/*', async (route) => {
        const req = route.request(),
          target = new URL(req.url());
        if (target.origin === new URL(baseURL!).origin) return route.continue();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
          return route.abort();
        const response = await route.fetch({ url: fixture.url + target.pathname + target.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      });
      const mock = await installOnlineMocks(page);
      mock.setAvailableProviders([provider]);
      const send = async (text: string) => {
        if (provider === 'gemini')
          await mock.geminiServerContent({
            inputTranscription: { text: 'Source ' + text },
            outputTranscription: { text },
            turnComplete: true,
          });
        else {
          await mock.oaiInput('Source ' + text);
          await mock.oaiOutput(text);
          await mock.oaiComplete();
        }
        await expect(page.locator('body')).toContainText(text);
      };
      try {
        await page.goto('/');
        await page.getByTestId(provider === 'gemini' ? 'launch-gemini' : 'launch-real').click();
        const ready = () => (provider === 'gemini' ? mock.geminiOpenSockets() : mock.oaiReady());
        await expect.poll(ready).toBe(provider === 'gemini' ? 1 : true);
        await send('中斷前原文。');
        const faultAt = await page.evaluate(() => Date.now());
        if (ending === 'stop') {
          mock.setOaiSessionFailing(true);
          mock.setGeminiSessionFailing(true);
        }
        if (ending === 'backpressure')
          await page.evaluate(() => {
            (
              window.__mock.gemini as unknown as { _last(): { bufferedAmount: number } }
            )._last().bufferedAmount = 2_000_000;
          });
        else if (provider === 'gemini') await mock.geminiClose();
        else {
          await mock.oaiClosed();
          await mock.oaiCloseActivePeer();
        }
        await expect
          .poll(async () =>
            page.evaluate(async () => {
              const path = '/src/settings/use-settings-store.ts';
              const { settingsStore } = await import(/* @vite-ignore */ path);
              return settingsStore.getState().health.transport.state;
            }),
          )
          .toMatch(
            ending === 'stop'
              ? /^(reconnecting|failed)$/
              : ending === 'backpressure'
                ? /^degraded$/
                : /^reconnecting$/,
          );
        if (ending === 'backpressure') {
          await page.evaluate(() => {
            (
              window.__mock.gemini as unknown as { _last(): { bufferedAmount: number } }
            )._last().bufferedAmount = 0;
          });
          await expect
            .poll(async () =>
              page.evaluate(async () => {
                const path = '/src/settings/use-settings-store.ts';
                const { settingsStore } = await import(/* @vite-ignore */ path);
                return settingsStore.getState().health.transport.state;
              }),
            )
            .toBe('reconnecting');
        }
        if (ending !== 'stop')
          await expect.poll(ready, { timeout: 15000 }).toBe(provider === 'gemini' ? 1 : true);
        const contentAt = await page.evaluate(() => Date.now());
        if (ending !== 'stop') await send('恢復後原文。');
        await page.getByTestId('stop-fake-replay').click();
        await expect(page.getByTestId('archive-gap-notice')).toContainText('已知缺口');
        const exported = await page.evaluate(async () => {
          const path = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ path);
          const id = meetingArchive.getCurrentMeeting().meetingId;
          return JSON.parse(
            await (await meetingArchive.exportMeeting(id, 'corrected', 'json')).text(),
          );
        });
        const gaps = exported.metadata.manifest.gaps;
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatchObject({
          meetingId: exported.metadata.meeting.meetingId,
          alignment: 'estimated',
          state: 'unrecoverable',
        });
        expect(gaps[0]).not.toHaveProperty('startSample');
        expect(Date.parse(gaps[0].wallClock.startAt)).toBeGreaterThanOrEqual(faultAt);
        expect(Date.parse(gaps[0].wallClock.endAt)).toBeGreaterThanOrEqual(contentAt);
        expect(exported.segments.map((s: { text: string }) => s.text).join(' ')).toContain(
          '中斷前原文',
        );
        if (ending !== 'stop')
          expect(exported.segments.map((s: { text: string }) => s.text).join(' ')).toContain(
            '恢復後原文',
          );
        expect(await mock.activeCaptureTracks()).toBe(0);
        console.info(
          '[delivery-gap]',
          JSON.stringify({ provider, ending, gaps, faultAt, contentAt }),
        );
      } finally {
        await page.close();
        await fixture.app.close();
        await fixture.repository.close();
      }
    });
  }
}
