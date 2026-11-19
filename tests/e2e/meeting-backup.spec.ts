import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storageFixture } from './storage-fixture.js';

for (const purpose of ['translation', 'transcription'] as const) {
  test(`${purpose}: backup downloads preserve the snapshot while captions continue`, async ({
    page,
    baseURL,
  }) => {
    const fixture = await storageFixture([baseURL!]);
    let downloadStarted = false;
    let rejectManifest = true;
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const cors = {
      'access-control-allow-origin': baseURL!,
      'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    await page.route('**/*', async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      if (target.origin === new URL(baseURL!).origin) return route.continue();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
        return route.abort();
      if (target.pathname.endsWith('/meetings.sqlite')) {
        downloadStarted = true;
        await downloadGate;
      }
      if (target.pathname.endsWith('/manifest.json') && rejectManifest)
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
        const archivePath = '/src/store/meeting-archive.ts';
        const storePath = '/src/store/use-caption-store.ts';
        const handlersPath = '/src/providers/coalesce-handlers.ts';
        const { meetingArchive } = await import(/* @vite-ignore */ archivePath);
        const { captionStore } = await import(/* @vite-ignore */ storePath);
        const { createStoreBoundHandlers } = await import(/* @vite-ignore */ handlersPath);
        const meetingId = crypto.randomUUID();
        const captionTask =
          purpose === 'translation'
            ? { purpose, langPair: 'en→zh-TW' }
            : { purpose, inputLanguages: ['zh-tw', 'en'], textPolicy: 'zh-TW-preserve-original' };
        await meetingArchive.startMeeting({
          meetingId,
          title: 'Backup browser',
          createdAt: new Date().toISOString(),
          captionTask,
        });
        captionStore.setState({ sessionId: meetingId, captionTask, sessionMode: 'real' });
        const handlers = createStoreBoundHandlers({ archive: meetingArchive.bindCurrentMeeting() });
        const emit = (index: number) => {
          handlers.onTranscript({
            kind: 'transcript',
            provider: 'controlled-backup',
            mode: 'online_full',
            source: 'microphone',
            segmentId: 'backup-' + index,
            status: 'final',
            text: 'Backup caption ' + index,
            startMs: index,
          });
          handlers.onTranslation({
            kind: 'translation',
            provider: 'controlled-backup',
            mode: 'online_full',
            sourceSegmentId: 'backup-' + index,
            sourceText: 'Backup caption ' + index,
            targetText: '備份字幕 ' + index,
            status: 'final',
            sourceLanguage: 'en',
            targetLanguage: 'zh-TW',
            updatedAt: new Date().toISOString(),
          });
        };
        (window as unknown as { backupCaption(index: number): void }).backupCaption = emit;
        for (let index = 0; index < 2000; index++) {
          emit(index);
          if (index % 100 === 99) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await meetingArchive.flushPending();
        return meetingId;
      }, purpose);
      await expect(page.locator('body')).toContainText(
        purpose === 'translation' ? '備份字幕 1999' : 'Backup caption 1999',
      );
      const expected = await fixture.repository.snapshot(meetingId);
      await page
        .locator('summary')
        .filter({ hasText: /^資料備份$/ })
        .click();
      await page.getByRole('button', { name: '建立完整備份', exact: true }).click();
      await expect(page.getByRole('button', { name: '下載備份資料庫', exact: true })).toBeEnabled();
      const databaseDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '下載備份資料庫', exact: true }).click();
      await expect.poll(() => downloadStarted).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { backupCaption(index: number): void }).backupCaption(2000),
      );
      await expect(page.locator('body')).toContainText(
        purpose === 'translation' ? '備份字幕 2000' : 'Backup caption 2000',
      );
      releaseDownload();
      const downloaded = await databaseDownload;
      const databasePath = join(fixture.root, 'downloaded.sqlite');
      await downloaded.saveAs(databasePath);
      await page.getByRole('button', { name: '下載驗證清單', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '備份或下載失敗' })).toBeVisible();
      rejectManifest = false;
      const manifestDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '下載驗證清單', exact: true }).click();
      const manifestPath = join(fixture.root, 'downloaded.manifest.json');
      const downloadedManifest = await manifestDownload;
      await downloadedManifest.saveAs(manifestPath);
      expect(downloadedManifest.suggestedFilename()).toBe(
        downloaded.suggestedFilename().replace('.sqlite', '.manifest.json'),
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.databaseSha256).toBe(
        createHash('sha256')
          .update(await readFile(databasePath))
          .digest('hex'),
      );
      expect(manifest.eventCount).toBe(4000);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database
            .prepare('SELECT envelope FROM events ORDER BY sequence')
            .all()
            .map((row) => JSON.parse(String(row.envelope))),
        ).toEqual(expected.events);
      } finally {
        database.close();
      }
      await expect
        .poll(async () => (await fixture.repository.snapshot(meetingId)).segments.length)
        .toBe(2001);
      await page
        .locator('.meeting-backup')
        .screenshot({ path: `.cache/w07-backup-${purpose}.png` });
    } finally {
      releaseDownload();
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
