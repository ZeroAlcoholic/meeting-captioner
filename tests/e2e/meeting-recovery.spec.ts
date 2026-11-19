import { expect, test, type Page } from '@playwright/test';
import { installOnlineMocks, type OnlineMockController } from './online-mock.js';

test.beforeEach(async ({ context, baseURL }) => {
  const frontendOrigin = new URL(baseURL!).origin;
  // Page-level provider mocks take precedence. Anything they did not mock
  // must stay on this test's Vite origin, never reach a paid provider.
  await context.routeWebSocket(
    (url) => url.origin !== frontendOrigin.replace(/^http/, 'ws'),
    (socket) => socket.close({ code: 1008, reason: 'External WebSocket blocked in offline test' }),
  );
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === frontendOrigin ? route.continue() : route.abort('blockedbyclient');
  });
});

async function enterFailedHandoff(page: Page) {
  await expect
    .poll(
      async () =>
        ((await page.getByTestId('retry-real').isVisible()) &&
          (await page.getByTestId('start-real').count()) > 0) ||
        (await page.getByTestId('failover-switch').isVisible()),
      { timeout: 10_000 },
    )
    .toBe(true);
  // Old builds switch immediately; repaired builds leave self-recovery time
  // and permit this explicit operator action. Both lead to the same fault.
  if (await page.getByTestId('failover-switch').isVisible()) {
    await page.getByTestId('failover-switch').click();
  }
  await expect(page.getByTestId('retry-real')).toBeVisible({ timeout: 10_000 });
}

async function meetingSnapshot(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __captionStore: {
          getState(): {
            sessionId: string | null;
            segments: Array<{ segmentId: string; text: string }>;
            translations: Record<string, { targetText: string }>;
          };
        };
      }
    ).__captionStore.getState();
    return {
      sessionId: state.sessionId,
      segments: state.segments,
      translations: state.translations,
    };
  });
}

async function startGemini(page: Page, mock: OnlineMockController) {
  await page.goto('/');
  await page.getByTestId('launch-gemini').click();
  await expect.poll(() => mock.geminiOpenSockets()).toBeGreaterThan(0);
  await mock.geminiServerContent({
    inputTranscription: { text: 'Keep the original meeting.', languageCode: 'en-US' },
    outputTranscription: { text: '保留原本會議。' },
    turnComplete: true,
  });
  await expect(page.locator('body')).toContainText('保留原本會議。');
  await expect.poll(async () => (await meetingSnapshot(page)).segments.length).toBeGreaterThan(0);
}

test('local Gemini worklet setup failure retries Gemini without opening an OpenAI peer', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await page.goto('/');
  await page.evaluate(() => {
    const Original = window.AudioWorkletNode;
    const diagnostic = window as unknown as { __localWorkletAttempts: number };
    diagnostic.__localWorkletAttempts = 0;
    window.AudioWorkletNode = class extends Original {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        diagnostic.__localWorkletAttempts += 1;
        if (diagnostic.__localWorkletAttempts === 1) {
          throw new Error('Controlled local worklet initialization failure');
        }
        super(...args);
      }
    };
  });
  await page.getByTestId('launch-gemini').click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __localWorkletAttempts: number }).__localWorkletAttempts,
        ),
      { timeout: 15_000 },
    )
    .toBe(2);
  await expect
    .poll(
      async () => ({
        gemini: await mock.geminiOpenSockets(),
        openai: await mock.oaiPeerCount(),
      }),
      { timeout: 15_000 },
    )
    .toEqual({ gemini: 1, openai: 0 });
  await mock.geminiServerContent({
    outputTranscription: { text: '本機收音恢復，仍使用原服務。' },
    turnComplete: true,
  });
  await expect(page.locator('body')).toContainText('本機收音恢復，仍使用原服務。');
  expect(await mock.oaiPeerCount()).toBe(0);
  await expect(page.getByTestId('autoswitch-notice')).toBeHidden();
});

test('Gemini gets time to reconnect on its own; recovery clears its previous error', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await startGemini(page, mock);
  // The broker stays healthy: a dropped socket is exactly the outage this
  // vendor can resume by itself, and the standby must not take the meeting off
  // it for one. The handoff waits out a same-vendor head start, so a session
  // that comes back inside it keeps the meeting — no model swap, no notice,
  // and the context its own resumption carries is not thrown away.
  await mock.geminiClose();
  await expect.poll(() => mock.geminiOpenSockets(), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await mock.oaiPeerCount()).toBe(0);
  await expect(page.getByTestId('autoswitch-notice')).toBeHidden();
  await mock.geminiServerContent({
    outputTranscription: { text: '同模型已恢复。' },
    turnComplete: true,
  });
  await expect(page.locator('.app-error')).toBeHidden();
  await expect(page.locator('body')).toContainText('保留原本會議。');
});

test('Retry after a failed handoff keeps meeting ID and prior segments', async ({ page }) => {
  const mock = await installOnlineMocks(page);
  mock.setOaiSessionFailing(true);
  await startGemini(page, mock);
  const before = await meetingSnapshot(page);
  mock.setGeminiSessionFailing(true);
  await mock.geminiClose();
  await enterFailedHandoff(page);
  mock.setOaiSessionFailing(false);
  await page.getByTestId('retry-real').click();
  await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
  await mock.oaiOutput('接續成功。');
  await mock.oaiComplete();
  await expect(page.locator('body')).toContainText('接續成功。');
  const after = await meetingSnapshot(page);
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.segments.map((s) => s.segmentId)).toEqual(
    expect.arrayContaining(before.segments.map((s) => s.segmentId)),
  );
  await expect(page.locator('body')).toContainText('保留原本會議。');
});

test('both failed backends continue automatic recovery within the same meeting', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  mock.setOaiSessionFailing(true);
  await startGemini(page, mock);
  const before = await meetingSnapshot(page);
  mock.setGeminiSessionFailing(true);
  await mock.geminiClose();
  await enterFailedHandoff(page);
  const calls = mock.oaiSessionCalls() + mock.geminiSessionCalls();
  await expect
    .poll(() => mock.oaiSessionCalls() + mock.geminiSessionCalls(), { timeout: 8_000 })
    .toBeGreaterThan(calls);
  mock.setOaiSessionFailing(false);
  mock.setGeminiSessionFailing(false);
  await expect
    .poll(async () => (await mock.oaiReady()) || (await mock.geminiOpenSockets()) > 0, {
      timeout: 15_000,
    })
    .toBe(true);
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  await expect(page.getByTestId('reconnect-pill')).toBeVisible();
  await mock.oaiOutput('兩端故障後有效內容');
  await mock.geminiServerContent({ outputTranscription: { text: '兩端故障後有效內容' } });
  await expect(page.getByTestId('caption-target')).toContainText('兩端故障後有效內容');
  await expect(page.locator('.app-error')).toBeHidden();
});

test('Stop cancels automatic retry while both backends are unavailable', async ({ page }) => {
  const mock = await installOnlineMocks(page);
  mock.setOaiSessionFailing(true);
  await startGemini(page, mock);
  mock.setGeminiSessionFailing(true);
  await mock.geminiClose();
  await enterFailedHandoff(page);
  await expect(page.getByTestId('stop-fake-replay')).toBeEnabled();
  await page.getByTestId('stop-fake-replay').click();
  await page.waitForTimeout(500);
  const calls = mock.oaiSessionCalls() + mock.geminiSessionCalls();
  await page.waitForTimeout(4_000);
  expect(mock.oaiSessionCalls() + mock.geminiSessionCalls()).toBe(calls);
  expect(await mock.activeCaptureTracks()).toBe(0);
});

test('Stop ends capture and standby token refresh across subsequent refresh periods', async ({
  page,
}) => {
  await page.clock.install();
  const mock = await installOnlineMocks(page);
  await startGemini(page, mock);
  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  const calls = mock.oaiSessionCalls() + mock.geminiSessionCalls();
  await page.clock.fastForward(65_000);
  await page.waitForTimeout(200);
  expect(mock.oaiSessionCalls() + mock.geminiSessionCalls()).toBe(calls);
  expect(await mock.activeCaptureTracks()).toBe(0);
});

test('Pause during handoff stops both providers and ignores late standby readiness', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await page.goto('/');
  await page.getByTestId('start-real').click();
  await expect.poll(() => mock.oaiReady()).toBe(true);
  await mock.oaiInput('Preserve this meeting.');
  await mock.oaiComplete();
  const before = await meetingSnapshot(page);
  await page.evaluate(() => {
    (window.__mock.gemini as unknown as { autoSetup: boolean }).autoSetup = false;
  });
  mock.setOaiSessionFailing(true);
  await mock.oaiClosed();
  await expect(page.getByTestId('failover-switch')).toBeVisible();
  await page.getByTestId('failover-switch').click();
  await expect.poll(() => mock.geminiOpenSockets()).toBeGreaterThan(0);
  await page.getByTestId('pause-session').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  await mock.geminiSend({ setupComplete: {} });
  await page.waitForTimeout(500);
  expect(await mock.oaiOpenPeers()).toBe(0);
  expect(await mock.geminiOpenSockets()).toBe(0);
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  await expect(page.getByTestId('resume-session')).toBeVisible();
});

test('failed standby preserves health when the incumbent recovers during handoff', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await page.goto('/');
  await page.getByTestId('start-real').click();
  await expect.poll(() => mock.oaiReady()).toBe(true);
  const peers = await mock.oaiPeerCount();
  await page.evaluate(() => {
    (window.__mock.gemini as unknown as { autoSetup: boolean }).autoSetup = false;
  });
  mock.setOaiSessionFailing(true);
  await mock.oaiClosed();
  await expect(page.getByTestId('failover-switch')).toBeVisible();
  await page.getByTestId('failover-switch').click();
  await expect.poll(() => mock.geminiOpenSockets()).toBeGreaterThan(0);
  mock.setOaiSessionFailing(false);
  await expect.poll(() => mock.oaiPeerCount()).toBeGreaterThan(peers);
  await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'reconnecting');
  await mock.oaiOutput('原服務已恢復內容');
  await expect(page.getByTestId('caption-target')).toContainText('原服務已恢復內容');
  await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected');
  await mock.geminiClose();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
    timeout: 1000,
  });
  await expect(page.locator('.app-error')).toBeHidden();
  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
});

for (const from of ['gemini', 'openai'] as const) {
  test(`${from} repeated contentless handshakes escalate to the other provider`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.clock.install();
    const mock = await installOnlineMocks(page);
    if (from === 'gemini') await startGemini(page, mock);
    else {
      await page.goto('/');
      await page.getByTestId('start-real').click();
      await expect.poll(() => mock.oaiReady()).toBe(true);
      await mock.oaiInput('Preserve before repeated stalls.');
      await mock.oaiComplete();
    }
    const before = await meetingSnapshot(page);
    const captures = await mock.micAcquisitions();
    const sourceCalls = from === 'gemini' ? mock.geminiSessionCalls : mock.oaiSessionCalls;
    const initialCalls = sourceCalls();
    for (let i = 0; i < 8; i++) await page.clock.runFor(5000);
    await expect.poll(sourceCalls).toBeGreaterThan(initialCalls);
    expect(from === 'gemini' ? await mock.oaiOpenPeers() : await mock.geminiOpenSockets()).toBe(0);
    await expect(page.getByTestId('autoswitch-notice')).toBeHidden();
    for (let i = 0; i < 8; i++) await page.clock.runFor(5000);
    await expect(page.getByTestId('autoswitch-notice')).toBeVisible();
    await expect(page.getByTestId('reconnect-pill')).toBeVisible();
    if (from === 'gemini') await mock.oaiOutput('跨廠後終於有內容');
    else await mock.geminiServerContent({ outputTranscription: { text: '跨廠後終於有內容' } });
    await expect(page.getByTestId('caption-target')).toContainText('跨廠後終於有內容');
    await expect(page.getByTestId('reconnect-pill')).toBeHidden();
    expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
    expect(await mock.micAcquisitions()).toBe(captures);
    await page.getByTestId('stop-fake-replay').click();
    await page.clock.runFor(16000);
    expect(await mock.activeCaptureTracks()).toBe(0);
    expect(await mock.oaiOpenPeers()).toBe(0);
    expect(await mock.geminiOpenSockets()).toBe(0);
  });
  for (const activeAudio of [false, true]) {
    test(`${from} content watchdog distinguishes silence from blank captions (active=${activeAudio})`, async ({
      page,
    }) => {
      // Run every PCM tick across 35 s of observation and 16 s after Stop.
      test.setTimeout(90_000);
      await page.clock.install();
      const mock = await installOnlineMocks(page);
      mock.setAvailableProviders([from]);
      if (from === 'gemini') await startGemini(page, mock);
      else {
        await page.goto('/');
        await page.getByTestId('start-real').click();
        await expect.poll(() => mock.oaiReady()).toBe(true);
        await mock.oaiOutput('故障前有效字幕');
        await mock.oaiComplete();
      }
      const before = await meetingSnapshot(page);
      const connections = from === 'gemini' ? mock.geminiSessionCalls : mock.oaiSessionCalls;
      const initial = connections();
      const captures = await mock.micAcquisitions();
      await mock.setAudioAmplitude(activeAudio ? 0.05 : 0);
      for (let i = 0; i < 7; i++) {
        if (from === 'gemini')
          await mock.geminiServerContent({
            inputTranscription: { text: ' \n\t' },
            outputTranscription: { text: ' \n\t' },
          });
        else {
          await mock.oaiInput(' \n\t');
          await mock.oaiOutput(' \n\t');
        }
        await page.clock.runFor(5000);
      }
      if (activeAudio) {
        await expect.poll(connections).toBeGreaterThan(initial);
        await expect(page.getByTestId('reconnect-pill')).toBeVisible();
      } else {
        expect(connections()).toBe(initial);
        await expect(page.getByTestId('reconnect-pill')).toBeHidden();
      }
      if (from === 'gemini')
        await mock.geminiServerContent({ outputTranscription: { text: '繼續有效內容' } });
      else await mock.oaiOutput('繼續有效內容');
      await expect(page.getByTestId('caption-target')).toContainText('繼續有效內容');
      await expect(page.getByTestId('reconnect-pill')).toBeHidden();
      expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
      expect(await mock.micAcquisitions()).toBe(captures);
      await page.getByTestId('stop-fake-replay').click();
      await page.clock.runFor(16000);
      await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
      expect(from === 'gemini' ? await mock.oaiOpenPeers() : await mock.geminiOpenSockets()).toBe(
        0,
      );
    });
  }
  test(`${from} handoff waits for content after transport readiness`, async ({ page }) => {
    const mock = await installOnlineMocks(page);
    if (from === 'gemini') await startGemini(page, mock);
    else {
      await page.goto('/');
      await page.getByTestId('start-real').click();
      await expect.poll(() => mock.oaiReady()).toBe(true);
      await mock.oaiInput('Preserve this meeting.');
      await mock.oaiComplete();
    }
    const before = await meetingSnapshot(page);
    if (from === 'gemini') {
      mock.setGeminiSessionFailing(true);
      await mock.geminiClose();
      await expect.poll(() => mock.oaiReady()).toBe(true);
    } else {
      mock.setOaiSessionFailing(true);
      await mock.oaiClosed();
      await expect.poll(() => mock.geminiOpenSockets()).toBeGreaterThan(0);
    }
    await expect(page.getByTestId('autoswitch-notice')).toBeVisible();
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-transport')).toHaveAttribute(
      'data-state',
      'reconnecting',
    );
    if (from === 'gemini') await mock.oaiOutput('  ');
    else await mock.geminiServerContent({ outputTranscription: { text: '  ' } });
    await expect(page.getByTestId('health-transport')).toHaveAttribute(
      'data-state',
      'reconnecting',
    );
    if (from === 'gemini') await mock.oaiOutput('接管後有效字幕');
    else await mock.geminiServerContent({ outputTranscription: { text: '接管後有效字幕' } });
    await expect(page.getByTestId('caption-target')).toContainText('接管後有效字幕');
    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected');
    expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  });
}

test('a sustained Gemini outage automatically hands off after the same-vendor head start with zero operator clicks', async ({
  page,
}) => {
  test.setTimeout(45_000);
  const mock = await installOnlineMocks(page);
  await startGemini(page, mock);
  const before = await meetingSnapshot(page);
  const captures = await mock.micAcquisitions();
  mock.setGeminiSessionFailing(true);
  const outageAt = Date.now();
  await mock.geminiClose();
  // No Retry or switch click: this is the automatic policy, independently of
  // the manual handoff tests above.
  await expect.poll(() => mock.oaiReady(), { timeout: 35_000 }).toBe(true);
  // The same vendor is given a head start to resume by itself, but an outage it
  // cannot resume must not cost the room a wall-clock grace period: 數字① in
  // docs/GOAL_PHASE_2.md budgets 3 s for captions to return, and that budget is
  // measured precisely in online-failover-latency.spec.ts.
  const handoffMs = Date.now() - outageAt;
  expect(handoffMs).toBeGreaterThanOrEqual(1_000);
  expect(handoffMs).toBeLessThan(10_000);
  await mock.oaiOutput('自動接續的新字幕。');
  await mock.oaiComplete();
  await expect(page.locator('body')).toContainText('自動接續的新字幕。');
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  expect(await mock.micAcquisitions()).toBe(captures);
  await expect(page.locator('body')).toContainText('保留原本會議。');
  await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected');
});

test('an ended capture after handoff stops the transport and offers same-meeting retry without automatic permission prompts', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await startGemini(page, mock);
  const before = await meetingSnapshot(page);
  mock.setGeminiSessionFailing(true);
  await mock.geminiClose();
  await expect(page.getByTestId('failover-switch')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('failover-switch').click();
  await expect.poll(() => mock.oaiReady()).toBe(true);
  const captures = await mock.micAcquisitions();
  await page.evaluate(() => {
    const streams = (window as unknown as { __mock: { streams: MediaStream[] } }).__mock.streams;
    const stream = streams.find((s) => s.getAudioTracks().some((t) => t.readyState === 'live'))!;
    stream.getAudioTracks()[0]!.dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('.app-error')).toContainText(/disconnected|capture stopped/i);
  await expect.poll(() => mock.oaiOpenPeers()).toBe(0);
  await page.waitForTimeout(3_000);
  expect(await mock.micAcquisitions()).toBe(captures);
  await page.getByTestId('retry-real').click();
  await expect.poll(() => mock.oaiReady()).toBe(true);
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  expect(await mock.micAcquisitions()).toBe(captures + 1);
});

test('ten accelerated Gemini rotations preserve one meeting and one capture without cross-model switching', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const mock = await installOnlineMocks(page);
  await startGemini(page, mock);
  const before = await meetingSnapshot(page);
  const socketCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { __mock: { gemini: { sockets: unknown[] } } }).__mock.gemini.sockets
          .length,
    );
  for (let i = 1; i <= 10; i += 1) {
    const priorSockets = await socketCount();
    await mock.geminiSend({ goAway: { timeLeft: '0s' } });
    await expect.poll(socketCount, { timeout: 8_000 }).toBeGreaterThan(priorSockets);
    await expect.poll(() => mock.geminiOpenSockets()).toBe(1);
    await expect(page.getByTestId('reconnect-pill')).toBeVisible();
    await mock.geminiServerContent({
      inputTranscription: { text: 'Rotation number ' + i, languageCode: 'en-US' },
      outputTranscription: { text: '第' + i + '次接續成功。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('第' + i + '次接續成功。');
    await expect(page.getByTestId('reconnect-pill')).toBeHidden();
    expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
    expect(await mock.oaiPeerCount()).toBe(0);
    expect(await mock.activeCaptureTracks()).toBe(1);
  }
  const after = await meetingSnapshot(page);
  for (let i = 1; i <= 10; i += 1) {
    const segment = after.segments.find((s) => s.text === 'Rotation number ' + i);
    expect(segment).toBeDefined();
    expect(after.translations[segment!.segmentId]?.targetText).toBe('第' + i + '次接續成功。');
  }
  expect(after.segments.map((s) => s.segmentId)).toEqual(
    expect.arrayContaining(before.segments.map((s) => s.segmentId)),
  );
  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  await expect.poll(() => mock.geminiOpenSockets()).toBe(0);
});

test('system capture stays acquired while both backends fail and automatically recover', async ({
  page,
}) => {
  test.setTimeout(35_000);
  const mock = await installOnlineMocks(page);
  mock.setOaiSessionFailing(true);
  await page.goto('/');
  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('scenario-online_meeting_box').check();
  await page.getByTestId('online-provider-gemini').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('start-gemini').click();
  await expect.poll(() => mock.geminiOpenSockets()).toBe(1);
  const before = await meetingSnapshot(page);
  mock.setGeminiSessionFailing(true);
  await mock.geminiClose();
  await enterFailedHandoff(page);
  const calls = mock.oaiSessionCalls() + mock.geminiSessionCalls();
  await expect
    .poll(() => mock.oaiSessionCalls() + mock.geminiSessionCalls(), { timeout: 8_000 })
    .toBeGreaterThan(calls);
  expect(await mock.displayMediaAcquisitions()).toBe(1);
  expect(await mock.activeCaptureTracks()).toBe(2); // audio + required display video
  mock.setOaiSessionFailing(false);
  mock.setGeminiSessionFailing(false);
  await expect
    .poll(async () => (await mock.oaiReady()) || (await mock.geminiOpenSockets()) > 0, {
      timeout: 15_000,
    })
    .toBe(true);
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  expect(await mock.displayMediaAcquisitions()).toBe(1);
  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
});

test('Gemini Resume retains the newly shared system capture when startup fails and retry changes backend', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  mock.setOaiSessionFailing(true);
  await page.goto('/');
  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('scenario-online_meeting_box').check();
  await page.getByTestId('online-provider-gemini').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('start-gemini').click();
  await expect.poll(() => mock.geminiOpenSockets()).toBe(1);
  const before = await meetingSnapshot(page);
  mock.setGeminiSessionFailing(true);
  await page.getByTestId('pause-session').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  await page.getByTestId('resume-session').click();
  await expect(page.locator('.app-error')).toBeVisible();
  const calls = mock.oaiSessionCalls() + mock.geminiSessionCalls();
  await expect
    .poll(() => mock.oaiSessionCalls() + mock.geminiSessionCalls(), { timeout: 8_000 })
    .toBeGreaterThan(calls);
  // One original share plus the user-requested Resume share; recovery must
  // not prompt for a third getDisplayMedia acquisition.
  expect(await mock.displayMediaAcquisitions()).toBe(2);
  expect(await mock.activeCaptureTracks()).toBe(2);
  mock.setOaiSessionFailing(false);
  mock.setGeminiSessionFailing(false);
  await expect
    .poll(async () => (await mock.oaiReady()) || (await mock.geminiOpenSockets()) > 0, {
      timeout: 15_000,
    })
    .toBe(true);
  expect((await meetingSnapshot(page)).sessionId).toBe(before.sessionId);
  expect(await mock.displayMediaAcquisitions()).toBe(2);
  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
});
