import { expect, test } from '@playwright/test';

for (const purpose of ['translation', 'transcription']) {
  for (const source of ['mic', 'system']) {
    test(`local preflight measures native PCM and releases capture (${purpose}, ${source})`, async ({
      page,
      context,
      baseURL,
    }) => {
      const forbidden: string[] = [];
      const selectedProvider = source === 'mic' ? 'openai' : 'gemini';
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // Full build already polls the optional local offline service at mount.
        if (url.href === 'http://localhost:8000/healthz') return route.abort();
        // Preflight reads configured metadata, never treats it as cloud readiness.
        // The real isolated service still has no credentials or upstream sessions.
        if (url.origin === new URL(baseURL!).origin && url.pathname === '/healthz') {
          return route.fulfill({
            json: {
              service: 'online',
              version: 'local-test',
              components: {
                apiKey: selectedProvider === 'openai' ? 'configured' : 'missing',
                gemini_key: selectedProvider === 'gemini' ? 'configured' : 'missing',
              },
            },
          });
        }
        if (
          url.origin !== new URL(baseURL!).origin ||
          /\/session\/(gemini|token|transcription)$/.test(url.pathname) ||
          url.pathname === '/session' ||
          url.pathname.startsWith('/vad/') ||
          url.pathname === '/meetings/lease'
        ) {
          forbidden.push(url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      await page.addInitScript((source) => {
        localStorage.setItem(
          'meeting-audio:settings:v1',
          JSON.stringify({
            v: 1,
            audioSource: source,
            onlineProvider: source === 'mic' ? 'openai' : 'gemini',
          }),
        );
        const tracks: MediaStreamTrack[] = [];
        const kinds: string[] = [];
        Object.assign(window, { __preflightTracks: tracks, __preflightKinds: kinds });
        const capture = async (kind: string) => {
          kinds.push(kind);
          if (!navigator.userActivation.isActive) throw new Error('Capture lost user activation');
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const destination = ctx.createMediaStreamDestination();
          osc.connect(destination);
          osc.start();
          await ctx.resume();
          const track = destination.stream.getAudioTracks()[0]!;
          tracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            osc.stop();
            void ctx.close();
          };
          return destination.stream;
        };
        navigator.mediaDevices.getUserMedia = () => capture('mic');
        navigator.mediaDevices.getDisplayMedia = () => capture('system');
      }, source);
      await page.goto('/');
      if (purpose === 'transcription')
        await page.getByRole('button', { name: '純字幕（繁中＋原文）', exact: true }).click();
      await page.getByRole('button', { name: '本機試音', exact: true }).click({ timeout: 3000 });
      const panel = page.getByRole('region', { name: '開會前本機檢查' });
      await expect(panel).toContainText('PCM 持續前進');
      await expect(panel).toContainText('偵測到聲音');
      await expect(panel).toContainText('雲端辨識尚未驗證');
      await expect(panel).toContainText(`${selectedProvider} 金鑰已設定`);
      await expect(panel).toContainText('保存服務可用');
      await expect(panel).toContainText(source === 'mic' ? '麥克風：' : '瀏覽器分享音訊：');
      expect(
        await page.evaluate(
          () => (window as unknown as { __preflightKinds: string[] }).__preflightKinds,
        ),
      ).toEqual([source]);
      await expect(
        page.getByRole('button', { name: '純字幕（繁中＋原文）', exact: true }),
      ).toBeDisabled();
      if (source === 'mic') {
        await page.screenshot({
          path: test.info().outputPath('preflight-active.png'),
          fullPage: true,
        });
      }
      await page.getByRole('button', { name: '結束試音', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { __preflightTracks: MediaStreamTrack[] }
            ).__preflightTracks.every((t) => t.readyState === 'ended'),
          ),
        )
        .toBe(true);
      expect(forbidden).toEqual([]);
    });
  }
}

for (const fault of ['denied', 'no-track', 'no-pcm', 'silent', 'broker', 'pending'] as const) {
  test(`preflight handles ${fault} without cloud calls or capture leaks`, async ({
    page,
    context,
    baseURL,
  }) => {
    const forbidden: string[] = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.href === 'http://localhost:8000/healthz') return route.abort();
      if (
        url.origin !== new URL(baseURL!).origin ||
        url.pathname === '/session' ||
        /\/session\/(gemini|transcription)$/.test(url.pathname) ||
        url.pathname.startsWith('/vad/') ||
        url.pathname === '/meetings/lease'
      ) {
        forbidden.push(url.pathname);
        return route.abort();
      }
      if (fault === 'broker' && ['/healthz', '/local/bootstrap'].includes(url.pathname))
        return route.fulfill({ status: 503, json: {} });
      return route.continue();
    });
    await page.addInitScript((fault) => {
      const tracks: MediaStreamTrack[] = [];
      let resolvePermission: (() => void) | undefined;
      Object.assign(window, { __preflightTracks: tracks, __grant: () => resolvePermission?.() });
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          audioSource: fault === 'no-track' ? 'system' : 'mic',
          transcriptRetentionEnabled: true,
        }),
      );
      localStorage.setItem(
        'meeting-audio:captions:v4',
        JSON.stringify({
          v: 5,
          savedAt: new Date().toISOString(),
          captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
          sessionPhase: 'ended',
          sessionMode: 'online_full',
          segments: [
            {
              segmentId: 'preserved',
              text: '保留會前舊字幕',
              status: 'final',
              source: 'mic',
              startMs: 0,
            },
          ],
          translations: {},
        }),
      );
      if (fault === 'no-pcm') {
        const NativeWorklet = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends NativeWorklet {
          constructor(ctx, name, options) {
            super(ctx, name, options);
            Object.defineProperty(this.port, 'onmessage', { set() {}, get: () => null });
          }
        };
      }
      const capture = async () => {
        if (fault === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        if (fault === 'pending')
          await new Promise<void>((resolve) => {
            resolvePermission = resolve;
          });
        const ctx = new AudioContext();
        const destination = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = fault === 'silent' ? 0 : 0.2;
        osc.connect(gain).connect(destination);
        osc.start();
        await ctx.resume();
        const stream =
          fault === 'no-track'
            ? document.createElement('canvas').captureStream()
            : destination.stream;
        for (const track of stream.getTracks()) {
          tracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            osc.stop();
            void ctx.close();
          };
        }
        return stream;
      };
      navigator.mediaDevices.getUserMedia = capture;
      navigator.mediaDevices.getDisplayMedia = capture;
    }, fault);
    await page.goto('/');
    await expect(page.getByText('保留會前舊字幕', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '本機試音', exact: true }).click();
    const panel = page.getByRole('region', { name: '開會前本機檢查' });
    if (fault === 'denied') await expect(panel).toContainText('收音失敗');
    if (fault === 'no-track') await expect(panel).toContainText('未分享音訊');
    if (fault === 'no-pcm') await expect(panel).toContainText('PCM 未前進');
    if (fault === 'silent') {
      await expect(panel).toContainText('PCM 持續前進');
      await expect(panel).toContainText('目前靜音');
    }
    if (fault === 'broker') {
      await expect(panel).toContainText('本機服務無法連線');
      await expect(panel).toContainText('保存服務不可用');
      await expect(panel).toContainText('PCM 持續前進');
    }
    if (!['denied', 'no-track'].includes(fault))
      await page.getByRole('button', { name: '結束試音', exact: true }).click();
    if (fault === 'pending') {
      await page.evaluate(() => (window as unknown as { __grant: () => void }).__grant());
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __preflightTracks: MediaStreamTrack[] }).__preflightTracks
                .length,
          ),
        )
        .toBe(1);
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __preflightTracks: MediaStreamTrack[] }).__preflightTracks.every(
            (t) => t.readyState === 'ended',
          ),
        ),
      )
      .toBe(true);
    await expect(page.getByText('保留會前舊字幕', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '本機試音', exact: true })).toBeEnabled();
    expect(forbidden).toEqual([]);
  });
}
