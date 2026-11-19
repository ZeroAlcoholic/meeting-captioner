import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { installOnlineMocks } from './online-mock.js';

for (const mode of ['offline', 'hybrid'] as const) {
  for (const phase of ['running', 'paused'] as const) {
    test(`online distribution preserves ${mode}/${phase} history without starting local processing`, async ({
      page,
      context,
    }) => {
      const origin = process.env.PURE_TEST_URL_OPENAI!;
      const localRequests: string[] = [];
      page.on('request', (request) => {
        if (['8000', '9090'].includes(new URL(request.url()).port))
          localRequests.push(request.url());
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const mock = await installOnlineMocks(page);
      const sessionId = randomUUID();
      await page.addInitScript(
        ({ mode, phase, sessionId }) => {
          const captionTask = { purpose: 'translation', langPair: 'en→zh-TW' };
          localStorage.setItem(
            'meeting-audio:settings:v1',
            JSON.stringify({
              v: 1,
              captionTask,
              transcriptRetentionEnabled: true,
              modeId: mode === 'hybrid' ? 'hybrid_privacy' : 'full_offline',
            }),
          );
          localStorage.setItem(
            'meeting-audio:captions:v4',
            JSON.stringify({
              v: 5,
              sessionId,
              sessionStartMs: Date.now() - 2000,
              sessionEndedAt: null,
              sessionMode: mode,
              sessionPhase: phase,
              captionTask,
              savedAt: new Date().toISOString(),
              segments: [
                {
                  segmentId: 'local-history',
                  provider: 'offline-stt',
                  source: 'microphone',
                  mode: mode === 'hybrid' ? 'hybrid_privacy' : 'full_offline',
                  status: 'final',
                  text: 'Use original local context.',
                  startMs: 1000,
                  endMs: 2000,
                },
              ],
              translations: {
                'local-history': {
                  sourceSegmentId: 'local-history',
                  provider: 'offline-stt',
                  status: 'final',
                  sourceText: 'Use original local context.',
                  targetText: '保留地端字幕。',
                  sourceLanguage: 'en',
                  targetLanguage: 'zh-TW',
                  updatedAt: new Date().toISOString(),
                },
              },
            }),
          );
        },
        { mode, phase, sessionId },
      );
      await page.goto(origin);
      await expect(page.getByTestId('continue-banner')).toContainText('此版本未包含地端處理');
      await expect(page.getByTestId('continue-session')).toBeDisabled();
      await expect(page.locator('body')).toContainText('保留地端字幕。');
      await page.getByTestId('export-menu-toggle').click();
      const downloading = page.waitForEvent('download');
      await page.getByTestId('export-json').click();
      const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
      expect(exported.segments.map((segment: { text: string }) => segment.text)).toEqual([
        'Use original local context.',
      ]);
      expect(exported.translations['local-history'].targetText).toBe('保留地端字幕。');
      expect(await mock.micAcquisitions()).toBe(0);
      expect(await mock.oaiOpenPeers()).toBe(0);
      expect(await mock.geminiOpenSockets()).toBe(0);
      expect(localRequests).toEqual([]);
      const saved = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('meeting-audio:captions:v4')!),
      );
      expect(saved.sessionMode).toBe(mode);
      expect(saved.sessionId).toBe(sessionId);
    });
  }
}
