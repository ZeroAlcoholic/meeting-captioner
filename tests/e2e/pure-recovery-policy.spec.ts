import { expect, test } from '@playwright/test';

// Production browser + real local archive, synthetic Chrome capture, controlled HTTP.
// No upstream speech recognition or physical device qualification is claimed.
for (const provider of ['openai', 'gemini'] as const) {
  for (const status of [401, 429]) {
    test(`pure ${provider} ${status}: refusal survives session replacement and Stop saves`, async ({
      page,
      context,
      baseURL,
    }) => {
      const origin = new URL(baseURL!).origin;
      const calls: number[] = [];
      let forbidden = 0;
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          forbidden++;
          return route.abort();
        }
        if (url.pathname === '/session/info')
          return route.fulfill({
            json: {
              hasApiKey: provider === 'openai',
              hasGeminiKey: provider === 'gemini',
              availableProviders: [provider],
            },
          });
        const endpoint =
          provider === 'openai' ? '/session/transcription' : '/session/gemini/transcription';
        if (url.pathname === endpoint) {
          calls.push(Date.now());
          return route.fulfill({
            status,
            headers: status === 429 ? { 'Retry-After': '10' } : {},
            json: { error: 'Controlled refusal' },
          });
        }
        if (url.pathname.startsWith('/session/') || url.pathname === '/session') {
          forbidden++;
          return route.abort();
        }
        return route.continue();
      });
      await context.routeWebSocket('**/*', (socket) => {
        forbidden++;
        socket.close();
      });
      await page.addInitScript((provider) => {
        localStorage.setItem(
          'meeting-audio:settings:v1',
          JSON.stringify({
            v: 1,
            modeId: 'online_full',
            audioSource: 'mic',
            onlineProvider: provider,
            captionTask: {
              purpose: 'transcription',
              inputLanguages: ['zh-tw', 'en'],
              textPolicy: 'zh-TW-preserve-original',
            },
          }),
        );
        const tracks: MediaStreamTrack[] = [];
        Object.defineProperty(window, '__policyTracks', { value: tracks });
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const destination = context.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await context.resume();
          const track = destination.stream.getAudioTracks()[0]!;
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            void context.close();
          };
          tracks.push(track);
          return destination.stream;
        };
      }, provider);
      await page.goto('/');
      await page
        .getByRole('textbox', { name: '會議名稱', exact: true })
        .fill(`Recovery ${provider} ${status} ${Date.now()}`);
      await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
      await expect.poll(() => calls.length).toBe(1);
      await expect(page.getByRole('alert')).toContainText(/401|429|auth|rate-limit/);
      await page.waitForTimeout(status === 401 ? 6500 : 1500);
      expect(calls).toHaveLength(1);
      await page.getByRole('button', { name: '停止並保存', exact: true }).click();
      await expect(page.getByTestId('pure-session-status')).toContainText('收音已停止');
      await expect(page.getByTestId('persistence-status')).toContainText('已保存，逐字稿尚待核對');
      await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { __policyTracks: MediaStreamTrack[] }).__policyTracks.every(
              (t) => t.readyState === 'ended',
            ),
          ),
        )
        .toBe(true);
      if (status === 429) {
        await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
        await page.waitForTimeout(2000);
        expect(calls).toHaveLength(1);
        await expect.poll(() => calls.length, { timeout: 15000 }).toBe(2);
        expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(10000);
        await page.getByRole('button', { name: '停止並保存', exact: true }).click();
        await expect(page.getByTestId('pure-session-status')).toContainText('收音已停止');
        await expect(page.getByTestId('persistence-status')).toContainText(
          '已保存，逐字稿尚待核對',
        );
        await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
      }
      const stoppedCalls = calls.length;
      await page.waitForTimeout(2200);
      expect(calls).toHaveLength(stoppedCalls);
      expect(forbidden).toBe(0);
    });
  }
}
