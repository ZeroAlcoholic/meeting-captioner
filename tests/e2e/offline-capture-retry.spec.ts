import { expect, test } from '@playwright/test';

for (const mode of ['full_offline', 'hybrid_privacy'] as const) {
  test(`${mode}: manual microphone retry preserves the meeting mode`, async ({
    page,
    context,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    let cloudSessions = 0;
    let starts = 0;
    let packets = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.port === '8000' && url.pathname === '/healthz')
        return route.fulfill({ json: { ok: true, whisper_status: 'ready' } });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/session/info')
        return route.fulfill({
          json: { hasGeminiKey: true, hasApiKey: true, availableProviders: ['gemini', 'openai'] },
        });
      if (url.pathname.startsWith('/session/')) {
        cloudSessions++;
        return route.fulfill({ status: 503, json: { error: 'Unexpected cloud session' } });
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => {
      if (new URL(socket.url()).port !== '8000') {
        socket.close();
        return;
      }
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') {
          packets++;
          return;
        }
        const message = JSON.parse(raw);
        if (message.type === 'start') {
          starts++;
          expect(message).toMatchObject({ source: 'mic', translate: mode === 'full_offline' });
        }
      });
    });
    await page.addInitScript((mode) => {
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          modeId: mode,
          audioSource: 'mic',
          micDeviceId: 'test-mic',
          captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
        }),
      );
      let calls = 0;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (++calls === 1) throw new DOMException('Mic temporarily unavailable', 'NotFoundError');
        if (
          typeof constraints?.audio !== 'object' ||
          (constraints.audio.deviceId as ConstrainDOMStringParameters)?.exact !== 'test-mic'
        )
          throw new Error('Selected microphone identity was lost');
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const destination = ctx.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await ctx.resume();
        const track = destination.stream.getAudioTracks()[0];
        track.getSettings = () => ({ deviceId: 'test-mic' });
        Object.defineProperty(window, '__offlineRetryTrack', { value: track });
        return destination.stream;
      };
    }, mode);
    await page.goto('/');
    await page.getByTestId(mode === 'full_offline' ? 'launch-offline' : 'launch-hybrid').click();
    await expect(page.getByTestId('retry-real')).toBeVisible();
    expect(starts).toBe(0);
    await page.getByTestId('retry-real').click();
    await expect.poll(() => starts).toBe(1);
    await expect.poll(() => packets).toBeGreaterThan(10);
    await expect(page.locator('.app-status')).toHaveText(
      mode === 'full_offline' ? 'offline' : 'hybrid',
    );
    expect(cloudSessions).toBe(0);
    await page.getByTestId('stop-fake-replay').click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __offlineRetryTrack: MediaStreamTrack }).__offlineRetryTrack
              .readyState,
        ),
      )
      .toBe('ended');
    const stoppedPackets = packets;
    await page.waitForTimeout(500);
    expect(packets).toBe(stoppedPackets);
    expect(errors).toEqual([]);
  });
}
