import { expect, test } from '@playwright/test';
import { installOnlineMocks } from './online-mock.js';

// Real browser routing/scheduler integration with controlled capture and upstream.
// This suite does not qualify physical audio or live cloud behavior.
test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort('blockedbyclient'),
  );
  await context.routeWebSocket(
    (url) => url.origin !== origin.replace(/^http/, 'ws'),
    (socket) => socket.close(),
  );
});

for (const provider of ['openai', 'gemini'] as const) {
  test(`${provider} Stop revokes a pending credential response`, async ({ page }) => {
    const mock = await installOnlineMocks(page);
    mock.setAvailableProviders([provider]);
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(provider === 'openai' ? /\/session$/ : /\/session\/gemini$/, async (route) => {
      requests += 1;
      await held;
      await route.fallback();
    });
    await page.goto('/');
    try {
      await page.getByTestId(provider === 'openai' ? 'start-real' : 'launch-gemini').click();
      await expect.poll(() => requests).toBeGreaterThan(0);
      await expect(page.getByTestId('stop-fake-replay')).toBeEnabled();
      await page.getByTestId('stop-fake-replay').click();
      release();
      await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
      const stoppedRequests = requests;
      await page.waitForTimeout(4500);
      expect(requests).toBe(stoppedRequests);
      expect(await mock.oaiOpenPeers()).toBe(0);
      expect(await mock.geminiOpenSockets()).toBe(0);
      await expect(page.getByTestId('stop-fake-replay')).toBeDisabled();
    } finally {
      release();
    }
  });

  test(`${provider} manual retry preserves rate-limit deadline and eventually recovers`, async ({
    page,
  }) => {
    const mock = await installOnlineMocks(page);
    mock.setAvailableProviders([provider]);
    const calls: number[] = [];
    await page.route(provider === 'openai' ? /\/session$/ : /\/session\/gemini$/, (route) => {
      calls.push(Date.now());
      if (calls.length === 1)
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '10' },
          json: { error: 'Rate limited' },
        });
      return route.fallback();
    });
    await page.goto('/');
    await page.getByTestId(provider === 'openai' ? 'start-real' : 'launch-gemini').click();
    await expect.poll(() => calls.length).toBe(1);
    await expect(page.getByTestId('retry-real')).toBeVisible();
    await page.getByTestId('retry-real').click();
    await page.waitForTimeout(4000);
    expect(calls).toHaveLength(1);
    await expect
      .poll(
        async () =>
          provider === 'openai' ? await mock.oaiReady() : (await mock.geminiOpenSockets()) > 0,
        { timeout: 15000 },
      )
      .toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(10000);
    await page.getByTestId('stop-fake-replay').click();
    await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    await page.waitForTimeout(2200);
    expect(calls).toHaveLength(2);
  });

  for (const alternateAvailable of [false, true]) {
    test(`${provider} auth refusal stops automatic mint; alternate=${alternateAvailable}`, async ({
      page,
    }) => {
      const mock = await installOnlineMocks(page);
      mock.setAvailableProviders(alternateAvailable ? ['openai', 'gemini'] : [provider]);
      let rejectedCalls = 0;
      await page.route(provider === 'openai' ? /\/session$/ : /\/session\/gemini$/, (route) => {
        rejectedCalls += 1;
        return route.fulfill({ status: 401, json: { error: 'Credentials rejected' } });
      });
      await page.goto('/');
      // OpenAI is the initial selection and pre-mints while idle. Await that
      // refusal before the explicit Start, which legitimately clears auth once.
      if (provider === 'openai') {
        await expect.poll(() => rejectedCalls).toBe(1);
        await page.waitForTimeout(1000);
        expect(rejectedCalls).toBe(1);
      }
      const idleCalls = rejectedCalls;
      await page.getByTestId(provider === 'openai' ? 'start-real' : 'launch-gemini').click();
      await expect.poll(() => rejectedCalls).toBe(idleCalls + 1);
      if (alternateAvailable) {
        await expect
          .poll(async () =>
            provider === 'openai' ? (await mock.geminiOpenSockets()) > 0 : await mock.oaiReady(),
          )
          .toBe(true);
        if (provider === 'openai') {
          await mock.geminiServerContent({
            outputTranscription: { text: '備援服務繼續字幕。' },
            turnComplete: true,
          });
        } else await mock.oaiOutput('備援服務繼續字幕。');
        await expect(page.getByTestId('caption-target')).toContainText('備援服務繼續字幕。');
      } else await expect(page.locator('.app-error')).toBeVisible();
      // Covers both the 1 s adapter and 2/4 s session retry schedules.
      await page.waitForTimeout(6500);
      expect(rejectedCalls).toBe(idleCalls + 1);
      await expect(page.getByTestId('stop-fake-replay')).toBeEnabled();
      await page.getByTestId('stop-fake-replay').click();
      await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
    });
  }
}
