import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { MeetingListing, MeetingPage, MeetingRevisionPage } from '@meeting-audio/contracts';
import { installOnlineMocks } from './online-mock.js';

for (const from of ['openai', 'gemini'] as const) {
  test(`${from} Stop saves the late translation tail before finalizing the meeting`, async ({
    page,
    context,
  }) => {
    const origin = process.env[`PURE_TEST_URL_${from.toUpperCase()}`]!;
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const mock = await installOnlineMocks(page);
    await page.addInitScript((provider) => {
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          onlineProvider: provider,
          transcriptRetentionEnabled: true,
          captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
        }),
      );
    }, from);
    await page.goto(origin);
    await page.getByTestId(from === 'openai' ? 'start-real' : 'start-gemini').click();
    if (from === 'openai') {
      await expect.poll(() => mock.oaiReady()).toBe(true);
      await mock.oaiInput('Do not');
      await mock.oaiOutput('不要');
      // Delay the upstream flush until after Stop, with no early closed marker.
      await page.evaluate(() => {
        const dc = (
          window.__mock.oai as unknown as {
            dcs: Array<{
              send(data: string): void;
              onmessage: ((event: { data: string }) => void) | null;
            }>;
          }
        ).dcs.at(-1)!;
        dc.send = (data) => {
          if (JSON.parse(data).type !== 'session.close') return;
          setTimeout(() => {
            for (const frame of [
              { type: 'session.input_transcript.delta', delta: ' approve.' },
              { type: 'session.output_transcript.delta', delta: '核准。' },
              { type: 'session.closed' },
            ])
              dc.onmessage?.({ data: JSON.stringify(frame) });
          }, 750);
        };
      });
    } else {
      await expect.poll(() => mock.geminiOpenSockets()).toBe(1);
      await mock.geminiServerContent({
        inputTranscription: { text: 'Do not' },
        outputTranscription: { text: '不要' },
      });
      await page.evaluate(() => {
        const ws = (
          window.__mock.gemini as unknown as {
            sockets: Array<{
              send(data: string): void;
              _emit(message: unknown): void;
            }>;
          }
        ).sockets.at(-1)!;
        ws.send = (data) => {
          if (!JSON.parse(data).realtimeInput?.audioStreamEnd) return;
          setTimeout(
            () =>
              ws._emit({
                serverContent: {
                  inputTranscription: { text: ' approve.' },
                  outputTranscription: { text: '核准。' },
                  turnComplete: true,
                },
              }),
            750,
          );
        };
      });
    }
    await expect(page.getByTestId('caption-target')).toContainText('不要');
    const bootstrap = await page.request.post(`${origin}/local/bootstrap`, { data: {} });
    expect(bootstrap.ok()).toBe(true);
    const { token } = await bootstrap.json();
    const headers = { Authorization: `Bearer ${token}` };
    const listing = await page.request.get(`${origin}/meetings`, { headers });
    const meeting = ((await listing.json()).meetings as MeetingListing[]).at(-1)!;
    const snapshot = async (): Promise<MeetingPage> => {
      const response = await page.request.get(`${origin}/meetings/${meeting.meetingId}`, {
        headers,
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await expect.poll(async () => (await snapshot()).manifest?.saved).toBe(true);
    const saved = await snapshot();
    expect(saved.segments.map((segment) => segment.text)).toEqual(['Do not approve.']);
    expect(Object.values(saved.translations).map((translation) => translation.targetText)).toEqual([
      '不要核准。',
    ]);
    await expect(page.locator('body')).toContainText('不要核准。');
    expect(await mock.oaiOpenPeers()).toBe(0);
    expect(await mock.geminiOpenSockets()).toBe(0);
    await page.getByTestId('export-menu-toggle').click();
    const downloadReady = page.waitForEvent('download');
    await page.getByTestId('export-json').click();
    const exported = JSON.parse(await readFile((await (await downloadReady).path())!, 'utf8'));
    expect(exported.segments.map((segment: { text: string }) => segment.text)).toEqual([
      'Do not approve.',
    ]);
    expect(
      Object.values(exported.translations).map(
        (translation) => (translation as { targetText: string }).targetText,
      ),
    ).toEqual(['不要核准。']);
  });

  test(`${from} translation reaches SQLite and keeps one meeting across handoff`, async ({
    page,
    context,
  }) => {
    const origin = process.env[`PURE_TEST_URL_${from.toUpperCase()}`]!;
    let leaseToken = '';
    let writerId = '';
    page.on('request', (request) => {
      if (request.url() === `${origin}/meetings/lease`) writerId = request.postDataJSON().writerId;
      leaseToken = request.headers()['x-meeting-lease'] ?? leaseToken;
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const mock = await installOnlineMocks(page);
    const legacyId = randomUUID();
    await page.addInitScript(
      ({ from, legacyId }) => {
        if (localStorage.getItem('meeting-audio:settings:v1')) return;
        const captionTask = { purpose: 'translation', langPair: 'en→zh-TW' };
        localStorage.setItem(
          'meeting-audio:settings:v1',
          JSON.stringify({
            v: 1,
            transcriptRetentionEnabled: true,
            onlineProvider: from,
            captionTask,
          }),
        );
        localStorage.setItem(
          'meeting-audio:captions:v4',
          JSON.stringify({
            v: 5,
            sessionId: legacyId,
            sessionStartMs: Date.now() - 60000,
            sessionEndedAt: null,
            sessionMode: from === 'gemini' ? 'gemini' : 'real',
            sessionPhase: 'running',
            captionTask,
            savedAt: new Date().toISOString(),
            segments: [
              {
                segmentId: 'legacy-one',
                provider: from,
                source: 'microphone',
                mode: 'online_full',
                status: 'final',
                text: 'Legacy source.',
                startMs: 0,
                endMs: 1000,
              },
            ],
            translations: {
              'legacy-one': {
                sourceSegmentId: 'legacy-one',
                provider: from,
                status: 'final',
                sourceText: 'Legacy source.',
                targetText: '舊字幕。',
                sourceLanguage: 'en',
                targetLanguage: 'zh-TW',
                updatedAt: new Date().toISOString(),
              },
            },
          }),
        );
      },
      { from, legacyId },
    );
    let releaseAdmission!: () => void;
    let admissionRequested = false;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    await page.route('**/meetings/lease', async (route) => {
      admissionRequested = true;
      await admission;
      await route.continue();
    });
    await page.goto(origin);
    await page.getByTestId('continue-session').click();
    await expect.poll(() => admissionRequested).toBe(true);
    // Exceed the recovery scheduler's first retry while local admission is pending.
    await page.waitForTimeout(2500);
    expect(await mock.activeCaptureTracks()).toBe(0);
    releaseAdmission();
    const send = async (provider: 'openai' | 'gemini', text: string) => {
      if (provider === 'gemini') {
        await expect.poll(() => mock.geminiOpenSockets()).toBeGreaterThan(0);
        await mock.geminiServerContent({
          inputTranscription: { text: `Source ${text}`, languageCode: 'en-US' },
          outputTranscription: { text },
          turnComplete: true,
        });
      } else {
        await expect.poll(() => mock.oaiReady()).toBe(true);
        await mock.oaiInput(`Source ${text}`);
        await mock.oaiOutput(text);
        await mock.oaiComplete();
      }
      await expect(page.locator('body')).toContainText(text);
    };
    await send(from, '儲存第一句。');
    expect(await mock.oaiOpenPeers()).toBe(from === 'openai' ? 1 : 0);
    expect(await mock.geminiOpenSockets()).toBe(from === 'gemini' ? 1 : 0);

    const bootstrap = await page.request.post(`${origin}/local/bootstrap`, { data: {} });
    expect(bootstrap.ok()).toBe(true);
    const { token } = await bootstrap.json();
    const headers = { Authorization: `Bearer ${token}` };
    const list = async (): Promise<MeetingListing[]> => {
      const response = await page.request.get(`${origin}/meetings`, { headers });
      expect(response.ok()).toBe(true);
      return (await response.json()).meetings;
    };
    await expect.poll(async () => (await list()).length).toBe(1);
    const meeting = (await list())[0]!;
    expect(meeting.captionTask.purpose).toBe('translation');
    expect(meeting.meetingId).toBe(legacyId);
    const snapshot = async (): Promise<MeetingPage> => {
      const response = await page.request.get(`${origin}/meetings/${meeting.meetingId}`, {
        headers,
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await expect
      .poll(async () => Object.values((await snapshot()).translations).map((t) => t.targetText))
      .toContain('儲存第一句。');
    if (from === 'gemini') {
      mock.setGeminiSessionFailing(true);
      await mock.geminiClose();
    } else {
      mock.setOaiSessionFailing(true);
      await mock.oaiClosed();
    }
    const target = from === 'gemini' ? 'openai' : 'gemini';
    await send(target, '接管第二句。');
    await expect
      .poll(async () => Object.values((await snapshot()).translations).map((t) => t.targetText))
      .toContain('接管第二句。');
    expect(await list()).toHaveLength(1);
    await page.getByTestId('pause-session').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await page.getByTestId('resume-session').click();
    await send(target, '繼續第三句。');
    await expect
      .poll(async () => Object.values((await snapshot()).translations).map((t) => t.targetText))
      .toContain('繼續第三句。');
    expect(await list()).toHaveLength(1);
    const saved = await snapshot();
    expect(saved.translations['legacy-one']?.targetText).toBe('舊字幕。');
    expect(saved.segments.map((s) => s.text)).toEqual([
      'Legacy source.',
      'Source 儲存第一句。',
      'Source 接管第二句。',
      'Source 繼續第三句。',
    ]);
    const revisions: MeetingRevisionPage['revisions'] = [];
    for (let offset = 0; ; ) {
      const response = await page.request.get(
        `${origin}/meetings/${meeting.meetingId}/revisions?offset=${offset}&limit=1`,
        { headers },
      );
      expect(response.ok()).toBe(true);
      const revisionPage: MeetingRevisionPage = await response.json();
      expect(revisionPage.revisions).toHaveLength(1);
      revisions.push(...revisionPage.revisions);
      if (revisionPage.nextOffset === null) break;
      expect(revisionPage.nextOffset).toBe(offset + 1);
      offset = revisionPage.nextOffset;
    }
    expect(revisions).toHaveLength(saved.segments.length + Object.keys(saved.translations).length);
    for (const segment of saved.segments)
      expect(revisions).toContainEqual({
        kind: 'transcript',
        segmentId: segment.segmentId,
        revision: segment.revision,
      });
    for (const translation of Object.values(saved.translations))
      expect(revisions).toContainEqual({
        kind: 'translation',
        segmentId: translation.sourceSegmentId,
        revision: translation.revision,
      });
    // Reload while running models an interrupted meeting, not an intentional Stop.
    mock.setGeminiSessionFailing(false);
    mock.setOaiSessionFailing(false);
    await page.reload();
    await expect(page.getByTestId('continue-session')).toBeVisible();
    // The old page's writer lease must expire before the new owner may write.
    await page.waitForTimeout(16000);
    await page.getByTestId('continue-session').click();
    await expect
      .poll(async () => (await mock.oaiReady()) || (await mock.geminiOpenSockets()) > 0)
      .toBe(true);
    const resumedProvider = (await mock.oaiReady()) ? 'openai' : 'gemini';
    await send(resumedProvider, '重開第四句。');
    await expect
      .poll(async () => Object.values((await snapshot()).translations).map((t) => t.targetText))
      .toContain('重開第四句。');
    expect(await list()).toHaveLength(1);
    const continued = await snapshot();
    expect(continued.meeting).toEqual(saved.meeting);
    expect(continued.segments.slice(0, saved.segments.length)).toEqual(saved.segments);
    expect(continued.segments).toHaveLength(saved.segments.length + 1);
    for (const [id, translation] of Object.entries(saved.translations))
      expect(continued.translations[id]).toEqual(translation);
    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await expect
      .poll(async () => (await snapshot()).manifest?.saved, { timeout: 10000 })
      .toBe(true);
    await expect(page.getByTestId('translation-persistence-status')).toContainText('已保存並結案');
    await page.reload();
    const reloaded = await snapshot();
    expect(reloaded.segments).toEqual(continued.segments);
    expect(reloaded.translations).toEqual(continued.translations);

    // Stop revokes a pending archive admission before either provider acquires capture.
    let releaseRegistration!: () => void;
    let registrationRequested = false;
    const registration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    await page.route('**/meetings', async (route) => {
      if (route.request().method() === 'POST') {
        registrationRequested = true;
        await registration;
      }
      await route.continue();
    });
    // Reload created a new lease owner; let the last page's lease expire.
    await page.waitForTimeout(16000);
    await page.getByTestId('start-gemini').or(page.getByTestId('start-real')).click();
    await expect.poll(() => registrationRequested).toBe(true);
    await page.getByTestId('stop-fake-replay').click();
    releaseRegistration();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await page.waitForTimeout(2500);
    expect(await mock.oaiOpenPeers()).toBe(0);
    expect(await mock.geminiOpenSockets()).toBe(0);
    expect((await snapshot()).segments).toEqual(continued.segments);

    let storageUnavailable = true;
    const attemptedIds = new Set<string>();
    await page.unroute('**/meetings');
    await page.route('**/meetings', async (route) => {
      if (route.request().method() === 'POST') {
        attemptedIds.add(route.request().postDataJSON().meetingId);
        if (storageUnavailable) {
          await route.fulfill({ status: 503, json: { error: 'ARCHIVE_UNAVAILABLE' } });
          return;
        }
      }
      await route.continue();
    });
    await page.getByTestId('start-gemini').or(page.getByTestId('start-real')).click();
    await expect
      .poll(async () => (await mock.oaiReady()) || (await mock.geminiOpenSockets()) > 0)
      .toBe(true);
    const faultProvider = (await mock.oaiReady()) ? 'openai' : 'gemini';
    await send(faultProvider, '故障期間的新句。');
    await expect(page.getByTestId('translation-persistence-status')).toContainText('保存異常');
    await expect(page.getByTestId('translation-persistence-status')).not.toContainText(
      '待保存 0 筆',
    );
    storageUnavailable = false;
    await expect(page.getByTestId('translation-persistence-status')).toContainText('待保存 0 筆', {
      timeout: 20000,
    });
    await send(faultProvider, '恢復後的新句。');
    expect(attemptedIds.size).toBe(1);
    const restoredId = [...attemptedIds][0]!;
    await expect
      .poll(async () => {
        const response = await page.request.get(`${origin}/meetings/${restoredId}`, { headers });
        expect(response.ok()).toBe(true);
        return ((await response.json()) as MeetingPage).segments.map((segment) => segment.text);
      })
      .toEqual(['Source 故障期間的新句。', 'Source 恢復後的新句。']);
    expect((await snapshot()).segments).toEqual(continued.segments);
    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${origin}/meetings/${restoredId}`, { headers });
          return ((await response.json()) as MeetingPage).manifest?.saved;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    // The display holds only the two live rows; archive export must include all 20,100.
    const expectedTexts = ['Source 故障期間的新句。', 'Source 恢復後的新句。'];
    const startedAt = Date.now();
    for (let offset = 2; offset < 20100; offset += 100) {
      const events = Array.from({ length: Math.min(100, 20100 - offset) }, (_, index) => {
        const sequence = offset + index;
        const text = `Archived source ${sequence}`;
        expectedTexts.push(text);
        return {
          schemaVersion: 1,
          meetingId: restoredId,
          eventId: randomUUID(),
          writerId,
          connectionId: null,
          observedAt: new Date().toISOString(),
          monotonicMs: sequence,
          revision: 1,
          payload: {
            kind: 'transcript',
            provider: faultProvider,
            mode: 'online_full',
            source: 'microphone',
            segmentId: `bulk-${sequence}`,
            status: 'final',
            text,
            startMs: startedAt + sequence,
            endMs: startedAt + sequence + 1,
          },
        };
      });
      const response = await page.request.post(`${origin}/meetings/${restoredId}/events`, {
        headers: { ...headers, 'X-Meeting-Lease': leaseToken },
        data: { events },
      });
      expect(response.ok()).toBe(true);
    }
    await page.getByTestId('export-menu-toggle').click();
    const downloadReady = page.waitForEvent('download');
    await page.getByTestId('export-json').click();
    const downloaded = await downloadReady;
    const exported = JSON.parse(await readFile((await downloaded.path())!, 'utf8')) as {
      segments: Array<{ text: string; segmentId: string }>;
      translations: MeetingPage['translations'];
    };
    expect(exported.segments.map((segment) => segment.text)).toEqual(expectedTexts);
    expect(Object.keys(exported.translations)).toHaveLength(2);
    for (const [index, text] of ['故障期間的新句。', '恢復後的新句。'].entries())
      expect(exported.translations[exported.segments[index]!.segmentId]?.targetText).toBe(text);
    // Reuse the existing archive editor for translation records, without a second editing UI.
    const restoredMeeting = (await list()).find((entry) => entry.meetingId === restoredId)!;
    await page.getByRole('button', { name: '純字幕（繁中＋原文）', exact: true }).click();
    await page.getByRole('button', { name: restoredMeeting.title, exact: true }).click();
    await page.getByRole('button', { name: '校訂', exact: true }).first().click();
    await page.getByRole('textbox', { name: '校訂文字' }).fill('Corrected source');
    await page.getByRole('button', { name: '保存校訂', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '校訂文字' })).toHaveCount(0);
    await page.getByRole('button', { name: '重試保存／結案', exact: true }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get(`${origin}/meetings/${restoredId}`, { headers });
        return ((await response.json()) as MeetingPage).manifest?.saved;
      })
      .toBe(true);
    const correctedReady = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出校訂版 JSON', exact: true }).click();
    const corrected = JSON.parse(
      await readFile((await (await correctedReady).path())!, 'utf8'),
    ) as {
      segments: Array<{ text: string; originalText: string }>;
      metadata: { finalized: boolean };
    };
    expect(corrected.segments[0]?.originalText).toBe(expectedTexts[0]);
    expect(corrected.segments.map((segment) => segment.text)).toEqual([
      'Corrected source',
      ...expectedTexts.slice(1),
    ]);
    expect(corrected.metadata.finalized).toBe(true);
  });
}
