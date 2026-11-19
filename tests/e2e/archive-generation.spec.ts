import { expect, test } from '@playwright/test';
import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { storageFixture } from './storage-fixture.js';

for (const purpose of ['translation', 'transcription'] as const) {
  test(`${purpose}: restore fences the old browser outbox and admits a fresh store`, async ({
    page,
    baseURL,
  }) => {
    const fixture = await storageFixture([baseURL!]);
    let holdWrites = false;
    const cors = {
      'access-control-allow-origin': baseURL!,
      'access-control-allow-headers':
        'authorization,content-type,x-meeting-lease,x-meeting-generation',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    await page.route('**/*', async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      if (target.origin === new URL(baseURL!).origin) return route.continue();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
        return route.abort();
      if (holdWrites && target.pathname.endsWith('/events'))
        return route.fulfill({ status: 503, headers: cors, body: '{}' });
      const response = await route.fetch({ url: fixture.url + target.pathname + target.search });
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    try {
      await page.goto('/');
      await page
        .getByRole('button', {
          name: purpose === 'translation' ? '即時翻譯' : '純字幕（繁中＋原文）',
          exact: true,
        })
        .click();
      const meetingId = await page.evaluate(async (purpose) => {
        const archivePath = '/src/store/meeting-archive.ts',
          storePath = '/src/store/use-caption-store.ts';
        const { meetingArchive } = await import(/* @vite-ignore */ archivePath);
        const { captionStore } = await import(/* @vite-ignore */ storePath);
        const meetingId = crypto.randomUUID();
        const captionTask =
          purpose === 'translation'
            ? { purpose, langPair: 'en→zh-TW' }
            : { purpose, inputLanguages: ['en'], textPolicy: 'zh-TW-preserve-original' };
        await meetingArchive.startMeeting({
          meetingId,
          title: '世代隔離',
          createdAt: new Date().toISOString(),
          captionTask,
        });
        captionStore.setState({
          sessionId: meetingId,
          captionTask,
          sessionMode: 'real',
          sessionPhase: 'ended',
        });
        meetingArchive.recordTranscript({
          kind: 'transcript',
          provider: 'fixture',
          mode: 'online_full',
          source: 'microphone',
          segmentId: 'saved',
          status: 'final',
          text: '備份時已有的原稿',
          startMs: 0,
        });
        await meetingArchive.flushPending();
        return meetingId;
      }, purpose);
      const original = await fixture.repository.snapshot(meetingId);
      const backup = await fixture.repository.backup();
      holdWrites = true;
      await page.evaluate(async () => {
        const path = '/src/store/meeting-archive.ts';
        const { meetingArchive } = await import(/* @vite-ignore */ path);
        meetingArchive.recordTranscript({
          kind: 'transcript',
          provider: 'fixture',
          mode: 'online_full',
          source: 'microphone',
          segmentId: 'pending-old',
          status: 'final',
          text: '舊世代未送出的原稿',
          startMs: 1,
        });
        await meetingArchive.flushPending().catch(() => {});
        await meetingArchive.release();
      });
      const bootstrap = await fetch(fixture.url + '/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const headers = {
        authorization: `Bearer ${(await bootstrap.json()).token}`,
        'content-type': 'application/json',
      };
      const restoreLease = await fetch(fixture.url + '/meetings/lease', {
        method: 'POST',
        headers,
        body: JSON.stringify({ writerId: crypto.randomUUID(), ownerId: crypto.randomUUID() }),
      });
      expect(restoreLease.ok).toBe(true);
      const leaseToken = (await restoreLease.json()).leaseToken;
      const uploadHeaders = {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-meeting-lease': leaseToken,
        'x-meeting-backup-manifest': (
          await readFile(join(dirname(backup), 'manifest.json'), 'utf8')
        ).trim(),
      };
      const rejected = await fetch(fixture.url + '/meetings/backups/import', {
        method: 'POST',
        headers: uploadHeaders,
        body: 'truncated database',
      });
      expect(rejected.status).toBe(503);
      expect((await rejected.json()).error).toBe('ARCHIVE_BACKUP_HASH_MISMATCH');
      expect(await fixture.repository.snapshot(meetingId)).toEqual(original);
      const imported = await fetch(fixture.url + '/meetings/backups/import', {
        method: 'POST',
        headers: uploadHeaders,
        body: await readFile(backup),
      });
      expect(imported.status).toBe(200);
      const importedId = (await imported.json()).backupId;
      expect(importedId).not.toBe(basename(dirname(backup)));
      const restore = await fetch(fixture.url + '/meetings/restore', {
        method: 'POST',
        headers: { ...headers, 'x-meeting-lease': leaseToken },
        body: JSON.stringify({ backupId: importedId }),
      });
      expect(restore.ok).toBe(true);
      expect(await restore.json()).toMatchObject({
        archiveGeneration: expect.any(String),
        safetyBackupPath: expect.any(String),
      });
      holdWrites = false;
      const oldState = await page.evaluate(async () => {
        const path = '/src/store/meeting-archive.ts';
        const { meetingArchive } = await import(/* @vite-ignore */ path);
        await meetingArchive.flushPending().catch(() => {});
        return meetingArchive.getStatus();
      });
      expect(oldState).toMatchObject({
        state: 'read_only',
        error: 'archive_generation_changed',
        pendingCount: 1,
      });
      await expect(page.getByText(/本機資料已還原，舊內容暫停寫入/)).toBeVisible();
      await expect(page.getByText(/舊待存內容仍保留/)).toBeVisible();
      expect(await fixture.repository.snapshot(meetingId)).toEqual(original);
      const result = await page.evaluate(async (url) => {
        const clientPath = '/src/store/meeting-archive-client.ts',
          storePath = '/src/store/meeting-outbox.ts';
        const { MeetingArchiveClient } = await import(/* @vite-ignore */ clientPath);
        const { IndexedDbMeetingStore } = await import(/* @vite-ignore */ storePath);
        const oldStore = new IndexedDbMeetingStore();
        const reloaded = new MeetingArchiveClient({ store: oldStore, baseUrl: url });
        let reloadError = '';
        try {
          await reloaded.initialize();
        } catch (error) {
          reloadError = (error as Error).message;
        }
        reloaded.dispose();
        const pending = await oldStore.readBatch();
        const snapshotClient = new MeetingArchiveClient({
          store: new IndexedDbMeetingStore('snapshot-generation-' + crypto.randomUUID()),
          baseUrl: url,
        });
        let snapshotError = '';
        const snapshotId = crypto.randomUUID();
        try {
          await snapshotClient.restoreTranslationSnapshot(
            {
              meetingId: snapshotId,
              title: '舊快照',
              createdAt: new Date().toISOString(),
              captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
            },
            [
              {
                kind: 'transcript',
                provider: 'fixture',
                mode: 'online_full',
                source: 'microphone',
                segmentId: 'stale-snapshot',
                status: 'final',
                text: '不可重新匯入的舊快照',
                startMs: 0,
              },
            ],
          );
        } catch (error) {
          snapshotError = (error as Error).message;
        } finally {
          snapshotClient.dispose();
        }
        const fresh = new MeetingArchiveClient({
          store: new IndexedDbMeetingStore('fresh-generation-' + crypto.randomUUID()),
          baseUrl: url,
        });
        const freshId = crypto.randomUUID();
        try {
          await fresh.startMeeting({
            meetingId: freshId,
            title: '新瀏覽器',
            createdAt: new Date().toISOString(),
            captionTask: {
              purpose: 'transcription',
              inputLanguages: ['en'],
              textPolicy: 'zh-TW-preserve-original',
            },
          });
          fresh.recordTranscript({
            kind: 'transcript',
            provider: 'fixture',
            mode: 'online_full',
            source: 'microphone',
            segmentId: 'fresh',
            status: 'final',
            text: '新世代原稿',
            startMs: 0,
          });
          await fresh.flushPending();
          await fresh.release();
        } finally {
          fresh.dispose();
        }
        return {
          reloadError,
          snapshotError,
          snapshotId,
          pending: pending.map((event: { payload: { text: string } }) => event.payload.text),
          freshId,
        };
      }, fixture.url);
      expect(result.reloadError).toContain('ARCHIVE_GENERATION_MISMATCH');
      expect(result.snapshotError).toContain('ARCHIVE_GENERATION_MISMATCH');
      await expect(fixture.repository.snapshot(result.snapshotId)).rejects.toThrow(
        'MEETING_NOT_FOUND',
      );
      expect(result.pending).toEqual(['舊世代未送出的原稿']);
      expect(
        (await fixture.repository.snapshot(result.freshId)).segments.map((segment) => segment.text),
      ).toEqual(['新世代原稿']);
      expect(await fixture.repository.snapshot(meetingId)).toEqual(original);
    } finally {
      try {
        await page.evaluate(async () => {
          const path = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ path);
          meetingArchive.dispose();
        });
        await page.unrouteAll({ behavior: 'wait' });
      } finally {
        await fixture.app.close();
      }
    }
  });
}
