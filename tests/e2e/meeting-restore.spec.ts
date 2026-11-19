import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { storageFixture } from './storage-fixture.js';

for (const purpose of ['translation', 'transcription'] as const) {
  for (const delivery of [
    'normal',
    'lost-before',
    'lost-after',
    'cancel-delayed',
    'late-after',
  ] as const) {
    test(`${purpose} ${delivery}: file import and confirmed restore preserve safety data and allow a fresh meeting after reload`, async ({
      page,
      baseURL,
    }) => {
      const fixture = await storageFixture([baseURL!]);
      let safetyPath = '';
      let restoreRequests = 0;
      let leaseExpiresAt = 0;
      let leaseConflicts = 0;
      let delayedRestore: { headers: Record<string, string>; body: string } | null = null;
      let lateEvent: unknown;
      const cors = {
        'access-control-allow-origin': baseURL!,
        'access-control-allow-headers':
          'authorization,content-type,x-meeting-lease,x-meeting-generation,x-meeting-backup-manifest',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      await page.route('**/*', async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        if (target.origin === new URL(baseURL!).origin) return route.continue();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
          return route.abort();
        if (target.pathname === '/meetings/restore') {
          restoreRequests++;
          if (delivery === 'cancel-delayed') {
            delayedRestore = { headers: request.headers(), body: request.postData()! };
            return route.fulfill({
              status: 503,
              headers: cors,
              contentType: 'application/json',
              body: '{}',
            });
          }
          if (delivery === 'lost-before' && restoreRequests === 1)
            return route.abort('connectionreset');
        }
        const response = await route.fetch({ url: fixture.url + target.pathname + target.search });
        if (target.pathname === '/meetings/lease') {
          const lease = await response.json();
          if (response.ok()) leaseExpiresAt = lease.expiresAt;
          else if (lease.error === 'ANOTHER_TAB_IS_WRITING') leaseConflicts++;
        }
        if (target.pathname === '/meetings/restore' && response.ok())
          safetyPath = (await response.json()).safetyBackupPath;
        if (target.pathname === '/meetings/restore' && response.ok() && delivery === 'late-after') {
          lateEvent = await page.evaluate(async () => {
            const path = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ path);
            meetingArchive.recordTranscript({
              kind: 'transcript',
              provider: 'fixture',
              mode: 'online_full',
              source: 'microphone',
              segmentId: 'late-after-restore',
              status: 'final',
              text: 'late content preserved separately',
              startMs: 2,
            });
            await meetingArchive.outbox.flushToDisk();
            return (await meetingArchive.outbox.store.readBatch())[0];
          });
        }
        if (
          target.pathname === '/meetings/restore' &&
          delivery === 'lost-after' &&
          restoreRequests === 1
        )
          return route.abort('connectionreset');
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
          const a = '/src/store/meeting-archive.ts',
            c = '/src/store/use-caption-store.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ a);
          const { captionStore } = await import(/* @vite-ignore */ c);
          const meetingId = crypto.randomUUID();
          const captionTask =
            purpose === 'translation'
              ? { purpose, langPair: 'en→zh-TW' }
              : { purpose, inputLanguages: ['en'], textPolicy: 'zh-TW-preserve-original' };
          await meetingArchive.startMeeting({
            meetingId,
            title: 'restore UI',
            createdAt: new Date().toISOString(),
            captionTask,
          });
          meetingArchive.recordTranscript({
            kind: 'transcript',
            provider: 'fixture',
            mode: 'online_full',
            source: 'microphone',
            segmentId: 'original',
            status: 'final',
            text: 'backup content',
            startMs: 0,
          });
          await meetingArchive.flushPending();
          captionStore.setState({
            sessionId: meetingId,
            captionTask,
            sessionMode: 'real',
            sessionPhase: 'running',
          });
          return meetingId;
        }, purpose);
        const original = await fixture.repository.snapshot(meetingId);
        const backup = await fixture.repository.backup();
        await page.locator('.meeting-backup summary').click();
        await expect(page.getByLabel('備份資料庫', { exact: true })).toBeDisabled();
        await page.evaluate(async () => {
          const a = '/src/store/meeting-archive.ts',
            c = '/src/store/use-caption-store.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ a);
          const { captionStore } = await import(/* @vite-ignore */ c);
          meetingArchive.recordTranscript({
            kind: 'transcript',
            provider: 'fixture',
            mode: 'online_full',
            source: 'microphone',
            segmentId: 'later',
            status: 'final',
            text: 'save this before restore',
            startMs: 1,
          });
          captionStore.getState().endSession();
        });
        await page.getByLabel('備份資料庫', { exact: true }).setInputFiles({
          name: 'corrupt.sqlite',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('corrupt'),
        });
        await page
          .getByLabel('驗證清單', { exact: true })
          .setInputFiles(join(dirname(backup), 'manifest.json'));
        await page.getByRole('button', { name: '匯入並驗證備份', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: '操作未完成' })).toBeVisible();
        await expect(page.getByRole('button', { name: '確認還原備份', exact: true })).toHaveCount(
          0,
        );
        expect((await fixture.repository.snapshot(meetingId)).segments[0]?.text).toBe(
          'backup content',
        );
        await page.getByLabel('備份資料庫', { exact: true }).setInputFiles(backup);
        await page.getByRole('button', { name: '匯入並驗證備份', exact: true }).click();
        await expect(page.getByText('備份驗證通過，尚未還原。請確認後執行還原。')).toBeVisible();
        await expect(
          page.getByRole('button', { name: '確認還原備份', exact: true }),
        ).toBeDisabled();
        await page.getByRole('checkbox', { name: /我確認以此備份/ }).check();
        // Import is harmless, but replacing the archive must wait for the
        // stopped meeting to finish draining and finalize.
        await expect(
          page.getByRole('button', { name: '確認還原備份', exact: true }),
        ).toBeDisabled();
        await page.evaluate(async () => {
          const a = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ a);
          await meetingArchive.finalize();
        });
        await page.getByRole('button', { name: '確認還原備份', exact: true }).click();
        if (delivery === 'cancel-delayed') {
          await expect(
            page.getByRole('alert').filter({ hasText: '還原未完成或結果待核對' }),
          ).toBeVisible();
          const beforeCancel = await fixture.repository.snapshot(meetingId);
          await page.evaluate(async () => {
            const a = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ a);
            meetingArchive.recordTranscript({
              kind: 'transcript',
              provider: 'fixture',
              mode: 'online_full',
              source: 'microphone',
              segmentId: 'cancel-tail',
              status: 'final',
              text: 'tail retained through cancellation',
              startMs: 2,
            });
            await meetingArchive.outbox.flushToDisk();
          });
          await page.getByRole('button', { name: '取消待核對的還原', exact: true }).click();
          await expect(page.getByText('已取消本次還原；目前資料與待存內容保留。')).toBeVisible();
          expect(await fixture.repository.snapshot(meetingId)).toEqual(beforeCancel);
          expect(delayedRestore).not.toBeNull();
          const delayed = delayedRestore as unknown as {
            headers: Record<string, string>;
            body: string;
          };
          const replay = await fetch(fixture.url + '/meetings/restore', {
            method: 'POST',
            headers: {
              authorization: delayed.headers.authorization!,
              'content-type': 'application/json',
              'x-meeting-lease': delayed.headers['x-meeting-lease']!,
            },
            body: delayed.body,
          });
          expect(replay.status).toBe(409);
          expect((await replay.json()).error).toBe('WRITER_LEASE_REQUIRED');
          expect(await fixture.repository.snapshot(meetingId)).toEqual(beforeCancel);
          await page.evaluate(async () => {
            const a = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ a);
            await meetingArchive.flushPending();
          });
          expect(
            (await fixture.repository.snapshot(meetingId)).segments.map((segment) => segment.text),
          ).toEqual([
            'backup content',
            'save this before restore',
            'tail retained through cancellation',
          ]);
          return;
        }
        if (delivery === 'late-after') {
          await expect(
            page.getByRole('alert').filter({ hasText: '還原未完成或結果待核對' }),
          ).toBeVisible();
          expect(lateEvent).toBeDefined();
          await page.reload();
          await page.locator('.meeting-backup summary').click();
          await page.getByRole('checkbox', { name: /若還原已套用/ }).check();
          await page.getByRole('button', { name: '核對並完成上次還原', exact: true }).click();
        } else if (delivery !== 'normal') {
          await expect(
            page.getByRole('alert').filter({ hasText: '還原未完成或結果待核對' }),
          ).toBeVisible();
          if (delivery === 'lost-after') {
            await page.getByRole('button', { name: '取消待核對的還原', exact: true }).click();
            await expect(page.getByRole('alert').filter({ hasText: '無法取消' })).toBeVisible();
          }
          await page.reload();
          await page.locator('.meeting-backup summary').click();
          await page.getByRole('button', { name: '核對並完成上次還原', exact: true }).click();
          if (delivery === 'lost-before') {
            await expect(
              page.getByRole('alert').filter({ hasText: '還原結果尚未能確認' }),
            ).toBeVisible();
            expect(leaseConflicts).toBeGreaterThan(0);
            expect(restoreRequests).toBe(1);
            await expect
              .poll(() => Date.now(), { timeout: 20_000 })
              .toBeGreaterThan(leaseExpiresAt);
            await page.getByRole('button', { name: '核對並完成上次還原', exact: true }).click();
          }
        }
        await expect(page.getByText(/^還原完成。原資料安全副本/)).toBeVisible();
        expect(restoreRequests).toBe(delivery === 'lost-before' ? 2 : 1);
        expect(await fixture.repository.snapshot(meetingId)).toEqual(original);
        const safety = new DatabaseSync(safetyPath, { readOnly: true });
        try {
          const events = safety
            .prepare('SELECT envelope FROM events ORDER BY sequence')
            .all()
            .map((row) => JSON.parse(String(row.envelope)));
          expect(events.map((event) => event.payload.text)).toEqual([
            'backup content',
            'save this before restore',
          ]);
        } finally {
          safety.close();
        }
        await page.screenshot({
          path: `.cache/w07-restore-${purpose}-${delivery}.png`,
          fullPage: true,
        });
        await page.getByRole('button', { name: '重新載入還原後資料', exact: true }).click();
        await page.waitForLoadState('domcontentloaded');
        if (delivery === 'late-after') {
          await page.locator('.meeting-backup summary').click();
          const ready = page.waitForEvent('download');
          await page.getByRole('button', { name: '下載舊世代保留紀錄', exact: true }).click();
          const downloaded = await ready;
          const path = join(fixture.root, 'retired-records.jsonl');
          await downloaded.saveAs(path);
          const records = (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(
            records
              .filter((record) => record.key.includes(':event:'))
              .map((record) => record.value),
          ).toEqual([lateEvent]);
          expect(
            records.find((record) => record.key === `retired:legacy:meeting:${meetingId}`)?.value,
          ).toEqual(original.meeting);
        }
        if (delivery === 'normal') {
          // Both purposes are available in the existing complete-record viewer.
          // Open through the UI, then inspect the downloaded artifact on disk.
          await page.getByRole('button', { name: '純字幕（繁中＋原文）', exact: true }).click();
          const records = page.getByRole('region', { name: '完整會議逐字稿', exact: true });
          await records.getByRole('button', { name: '重新整理紀錄', exact: true }).click();
          await records.getByRole('button', { name: 'restore UI', exact: true }).click();
          await expect(records.locator('.pure-archive-segment > p')).toHaveText(['backup content']);
          await expect(records).not.toContainText('save this before restore');
          const downloadReady = page.waitForEvent('download');
          await records.getByRole('button', { name: '匯出完整原始紀錄 JSON', exact: true }).click();
          const download = await downloadReady;
          expect(download.suggestedFilename()).toBe(`${meetingId}-original.json`);
          const restoredExport = join(fixture.root, 'restored-original.json');
          await download.saveAs(restoredExport);
          const exported = JSON.parse(await readFile(restoredExport, 'utf8'));
          expect(exported.metadata.meeting).toEqual(original.meeting);
          expect(exported.events).toEqual(original.events);
          expect(exported.segments).toEqual(original.segments);
          expect(exported.translations).toEqual(original.translations ?? {});
        }
        const freshId = await page.evaluate(async () => {
          const a = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ a);
          const meetingId = crypto.randomUUID();
          await meetingArchive.startMeeting({
            meetingId,
            title: 'after restore',
            createdAt: new Date().toISOString(),
            captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
          });
          meetingArchive.recordTranscript({
            kind: 'transcript',
            provider: 'fixture',
            mode: 'online_full',
            source: 'microphone',
            segmentId: 'fresh',
            status: 'final',
            text: 'fresh after restore',
            startMs: 0,
          });
          await meetingArchive.flushPending();
          return meetingId;
        });
        expect(
          (await fixture.repository.snapshot(freshId)).segments.map((segment) => segment.text),
        ).toEqual(['fresh after restore']);
        expect(await fixture.repository.snapshot(meetingId)).toEqual(original);
      } finally {
        await page
          .evaluate(async () => {
            const a = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ a);
            meetingArchive.dispose();
          })
          .catch(() => {});
        await page.unrouteAll({ behavior: 'wait' });
        await fixture.app.close();
      }
    });
  }
}
