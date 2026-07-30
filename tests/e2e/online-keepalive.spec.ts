import { expect, test } from '@playwright/test';
import { installOnlineMocks, type OnlineMockController } from './online-mock.js';

/**
 * Project KEEPALIVE reliability paths verified in a REAL browser against the
 * in-browser mock backend (no cloud key). These are the integration behaviours
 * the unit tests can't reach: the full provider → store → caption-board →
 * failover-UI loop under injected backend faults.
 *
 *   1. OpenAI happy path           — deltas render source + target captions.
 *   2. OpenAI zero-gap renewal     — session.closed rebuilds the peer WITHOUT
 *                                    re-acquiring the mic; history survives.
 *   3. OpenAI fail → Gemini        — renewal failure surfaces the failover
 *                                    banner; one click continues on Gemini with
 *                                    the transcript preserved.
 *   4. Gemini happy + reconnect    — serverContent renders; a server-side drop
 *                                    auto-reconnects and keeps captioning.
 */

let mock: OnlineMockController;

test.beforeEach(async ({ page }) => {
  mock = await installOnlineMocks(page);
});

async function startOpenAI(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start-real').click();
  // The DataChannel is wired (onmessage attached, channel open) only after the
  // SDP exchange completes — wait for that before injecting events.
  await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
}

async function selectOnlineMeetingSystemAudio(
  page: import('@playwright/test').Page,
  provider: 'openai' | 'gemini' = 'openai',
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('scenario-online_meeting_box').check();
  await page.getByTestId(`online-provider-${provider}`).click();
  await expect(page.getByTestId('system-audio-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-panel')).toBeHidden();
}

test.describe('KEEPALIVE — online reliability (mock backend)', () => {
  test('OpenAI deltas render source + target captions and finalize', async ({ page }) => {
    await startOpenAI(page);

    await mock.oaiInput('Quarterly revenue grew strongly.');
    await mock.oaiOutput('本季營收強勁成長。');

    await expect(page.getByTestId('caption-current')).toContainText(
      'Quarterly revenue grew strongly.',
      {
        timeout: 5_000,
      },
    );
    await expect(page.getByTestId('caption-target')).toContainText('本季營收強勁成長。', {
      timeout: 5_000,
    });

    // Completion event commits the segment into history.
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('本季營收強勁成長。', { timeout: 5_000 });

    // The background latency monitor must have observed the real event pipeline
    // (the monitor is real; only the transport is mocked). Confirms it's wired
    // and recording so a real-key session leaves numbers behind.
    const summary = await page.evaluate(() =>
      (
        window as unknown as {
          __latency: {
            summary(): Array<{ provider: string; samples: number; ttfcMs: number | null }>;
          };
        }
      ).__latency.summary(),
    );
    expect(summary.length).toBeGreaterThan(0);
    expect(summary[0]!.provider).toBe('openai-realtime');
    expect(summary[0]!.samples).toBeGreaterThan(0);
    expect(typeof summary[0]!.ttfcMs).toBe('number');
  });

  test('running locks session configuration and Stop releases transport plus capture', async ({
    page,
  }) => {
    await startOpenAI(page);
    await mock.oaiInput('Configuration stays fixed while running.');
    await mock.oaiOutput('執行期間設定保持固定。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('執行期間設定保持固定。', {
      timeout: 5_000,
    });

    expect(await mock.activeCaptureTracks()).toBe(1);
    expect(await mock.oaiOpenPeers()).toBe(1);

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('mode-full_offline')).toBeDisabled();
    await expect(page.getByTestId('scenario-hybrid')).toBeDisabled();
    await expect(page.getByTestId('online-provider-gemini')).toBeDisabled();
    await expect(page.getByTestId('lang-zh-TW→en')).toBeDisabled();

    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await expect.poll(() => mock.oaiOpenPeers()).toBe(0);

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('mode-full_offline')).toBeEnabled();
    await expect(page.getByTestId('scenario-hybrid')).toBeEnabled();
    await expect(page.getByTestId('online-provider-gemini')).toBeEnabled();
    await expect(page.getByTestId('lang-zh-TW→en')).toBeEnabled();
    await page.getByTestId('online-provider-gemini').click();

    await expect(page.locator('body')).toContainText('執行期間設定保持固定。');
  });

  test('startup shows a connecting/listening cue instead of a blank board', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-real').click();

    // Before any caption arrives the board must show an explicit, staged cue —
    // never dead air. With the mock backend it settles on 'listening' (transport
    // connected, no speech yet).
    const empty = page.getByTestId('caption-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute('data-phase', 'listening', { timeout: 10_000 });
    await expect(empty).toContainText('正在聆聽');

    // The first delta replaces the cue with the live caption.
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
    await mock.oaiOutput('第一句翻譯。');
    await expect(page.getByTestId('caption-target')).toContainText('第一句翻譯。', {
      timeout: 5_000,
    });
    await expect(empty).toBeHidden();
  });

  test('Full Offline idle does not prewarm cloud provider tokens', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          scenarioId: 'physical',
          modeId: 'full_offline',
          langPair: 'en→zh-TW',
          audioSource: 'mic',
          includeSourceTranscript: true,
          micDistance: 'meeting',
          onlineProvider: 'openai',
        }),
      );
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    expect(mock.oaiSessionCalls()).toBe(0);
    expect(mock.geminiSessionCalls()).toBe(0);
  });

  test('paused online backend switch persists the resumed backend when retention is opted in', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('toggle-transcript-retention').check();
    await page.keyboard.press('Escape');
    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
    await mock.oaiOutput('暫停前。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('暫停前。', { timeout: 5_000 });

    await page.getByTestId('pause-session').click();
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('online-provider-gemini').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('resume-session').click();

    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);
    const sessionMode = await page.evaluate(
      () => JSON.parse(localStorage.getItem('meeting-audio:captions:v4') ?? '{}').sessionMode,
    );
    expect(sessionMode).toBe('gemini');
  });

  test('OpenAI online-meeting scenario uses display capture, not microphone capture', async ({
    page,
  }) => {
    await selectOnlineMeetingSystemAudio(page, 'openai');
    await expect(page.getByTestId('start-real')).toBeEnabled();

    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    expect(await mock.userMediaAcquisitions()).toBe(0);
    expect(await mock.displayMediaAcquisitions()).toBe(1);
    expect(await mock.oaiAddedTrackKinds()).toEqual(['audio']);

    await mock.oaiInput('Breaking news from London.');
    await mock.oaiOutput('來自倫敦的突發新聞。');
    await expect(page.getByTestId('caption-target')).toContainText('來自倫敦的突發新聞。', {
      timeout: 5_000,
    });
  });

  test('system-audio Online run records field-test history only after pressing Test', async ({
    page,
  }) => {
    await selectOnlineMeetingSystemAudio(page, 'openai');
    await expect(page.getByTestId('start-real')).toBeEnabled();
    await expect(page.getByTestId('field-test-toggle')).toBeEnabled();

    await page.getByTestId('field-test-toggle').click();
    await expect(page.getByTestId('field-test-toggle')).toContainText('■ Test');

    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    await mock.oaiInput('Automatic field recording is active.');
    await mock.oaiOutput('自動現場測試記錄已啟用。');
    await mock.oaiComplete();
    await expect(page.getByTestId('caption-target')).toContainText('自動現場測試記錄已啟用。', {
      timeout: 5_000,
    });

    await page.getByTestId('stop-fake-replay').click();

    const history = await page.evaluate(() =>
      (
        window as unknown as {
          __fieldTest: {
            history(): Array<{
              label: string;
              settings: { onlineProvider: string; audioSource: string };
              runSummary: Array<{ provider: string; samples: number }>;
            }>;
          };
        }
      ).__fieldTest.history(),
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.label).toContain('OpenAI manual');
    expect(history[0]!.settings.onlineProvider).toBe('openai');
    expect(history[0]!.settings.audioSource).toBe('system');
    expect(history[0]!.runSummary[0]!.provider).toBe('openai-realtime');
    expect(history[0]!.runSummary[0]!.samples).toBeGreaterThan(0);
  });

  test('Gemini online-meeting scenario uses display capture, not microphone capture', async ({
    page,
  }) => {
    await selectOnlineMeetingSystemAudio(page, 'gemini');
    await expect(page.getByTestId('start-gemini')).toBeEnabled();

    await page.getByTestId('start-gemini').click();
    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);

    expect(await mock.userMediaAcquisitions()).toBe(0);
    expect(await mock.displayMediaAcquisitions()).toBe(1);

    await mock.geminiServerContent({
      inputTranscription: { text: 'Markets opened higher today.', languageCode: 'en-US' },
      outputTranscription: { text: '市場今天開高。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('市場今天開高。', { timeout: 5_000 });
  });

  test('idle pre-mint: token fetched before Start and consumed without a second fetch', async ({
    page,
  }) => {
    await page.goto('/');
    // Once apiKeyStatus resolves to present, the hook pre-mints a token while idle.
    await expect.poll(() => mock.oaiSessionCalls(), { timeout: 10_000 }).toBeGreaterThan(0);
    const before = mock.oaiSessionCalls();

    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    // Start consumed the warm token — no additional /session fetch on the click.
    expect(mock.oaiSessionCalls()).toBe(before);

    // And captions still flow on the pre-minted session.
    await mock.oaiOutput('預鑄字幕。');
    await expect(page.getByTestId('caption-target')).toContainText('預鑄字幕。', {
      timeout: 5_000,
    });
  });

  test('session.closed triggers zero-gap renewal — mic reused, history preserved', async ({
    page,
  }) => {
    await startOpenAI(page);

    await mock.oaiInput('First utterance before renewal.');
    await mock.oaiOutput('續期前的第一句話。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('續期前的第一句話。', { timeout: 5_000 });

    expect(await mock.oaiPeerCount()).toBe(1);
    const micBefore = await mock.micAcquisitions();
    expect(micBefore).toBe(1);

    // Upstream closes the session — provider must rebuild make-before-break.
    await mock.oaiClosed();

    // A second peer is built (renewal), and the DataChannel re-wires.
    await expect.poll(() => mock.oaiPeerCount(), { timeout: 10_000 }).toBe(2);
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    // The mic stream was REUSED across the swap — no second getUserMedia.
    expect(await mock.micAcquisitions()).toBe(1);

    // Pre-renewal history is intact AND the new session still captions.
    await expect(page.locator('body')).toContainText('續期前的第一句話。');
    await mock.oaiInput('Second utterance after renewal.');
    await mock.oaiOutput('續期後的第二句話。');
    await expect(page.getByTestId('caption-target')).toContainText('續期後的第二句話。', {
      timeout: 5_000,
    });
  });

  test('repeated renewals stay zero-gap — mic acquired once, status never blanks', async ({
    page,
  }) => {
    await startOpenAI(page);
    const RENEWALS = 5;

    await mock.oaiInput('Opening remarks.');
    await mock.oaiOutput('開場致詞。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('開場致詞。', { timeout: 5_000 });

    const status = page.locator('.app-status');

    for (let i = 1; i <= RENEWALS; i++) {
      await mock.oaiClosed();
      // Each renewal builds exactly one more peer and re-wires the channel.
      await expect.poll(() => mock.oaiPeerCount(), { timeout: 10_000 }).toBe(i + 1);
      await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

      // make-before-break: the provider never leaves 'running', so the header
      // status pill must still read the live backend — never idle/paused — i.e.
      // there is no blank window for the operator.
      await expect(status).toHaveAttribute('data-status', 'running');
      await expect(status).toHaveText('openai');

      // The mic was reused on every swap — still exactly one acquisition.
      expect(await mock.micAcquisitions()).toBe(1);

      // The post-renewal session still captions.
      await mock.oaiInput(`Point number ${i}.`);
      await mock.oaiOutput(`第 ${i} 點。`);
      await expect(page.getByTestId('caption-target')).toContainText(`第 ${i} 點。`, {
        timeout: 5_000,
      });
    }

    expect(await mock.oaiPeerCount()).toBe(RENEWALS + 1);
    expect(await mock.micAcquisitions()).toBe(1);
    // The very first caption is still in the preserved history.
    await expect(page.locator('body')).toContainText('開場致詞。');
  });

  test('OpenAI failure keeps retrying without failover when Gemini is unavailable', async ({
    page,
  }) => {
    mock.setAvailableProviders(['openai']);
    await startOpenAI(page);

    await mock.oaiOutput('只有 OpenAI 可用。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('只有 OpenAI 可用。', { timeout: 5_000 });

    mock.setOaiSessionFailing(true);
    await mock.oaiClosed();

    await expect(page.getByTestId('reconnect-pill')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('failover-banner')).toBeHidden();
    await expect(page.locator('.app-status')).toHaveText('openai');
    expect(await mock.geminiOpenSockets()).toBe(0);
  });

  test('OpenAI renewal failure surfaces failover banner → switch to Gemini keeps transcript', async ({
    page,
  }) => {
    // Initial connect succeeds (incl. the idle pre-mint).
    await startOpenAI(page);

    await mock.oaiInput('Revenue is up nine percent.');
    await mock.oaiOutput('營收成長百分之九。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('營收成長百分之九。', { timeout: 5_000 });

    // Now make the token broker 500, then force a renewal — it fails and the
    // provider drops to 'failed' health (while still retrying in the background).
    mock.setOaiSessionFailing(true);
    await mock.oaiClosed();

    const banner = page.getByTestId('failover-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Gemini');

    // One click continues on the other backend.
    await page.getByTestId('failover-switch').click();

    // Gemini socket comes up.
    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);

    // CLAUDE.md: a provider switch must NOT clear the transcript.
    await expect(page.locator('body')).toContainText('營收成長百分之九。');

    // New captions now flow from Gemini and append to the same transcript.
    await mock.geminiServerContent({
      inputTranscription: { text: 'A new sentence on Gemini.', languageCode: 'en-US' },
      outputTranscription: { text: 'Gemini 上的新句子。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('Gemini 上的新句子。', { timeout: 5_000 });
    // Banner clears once the new backend is connected.
    await expect(banner).toBeHidden({ timeout: 5_000 });
  });

  test('Gemini renders captions and auto-reconnects after a server-side drop', async ({ page }) => {
    await page.goto('/');
    // Launch Gemini directly from the idle launcher (selects backend + starts).
    await page.getByTestId('launch-gemini').click();
    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);

    await mock.geminiServerContent({
      inputTranscription: { text: 'Hello team.', languageCode: 'en-US' },
      outputTranscription: { text: '大家好。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('大家好。', { timeout: 5_000 });

    // Server drops the socket — provider must re-mint + reconnect (resume).
    await mock.geminiClose();
    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Captioning continues on the resumed session; old history preserved.
    await mock.geminiServerContent({
      inputTranscription: { text: 'Still here after reconnect.', languageCode: 'en-US' },
      outputTranscription: { text: '重連後仍在運作。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('重連後仍在運作。', { timeout: 8_000 });
    await expect(page.locator('body')).toContainText('大家好。');
  });
});
