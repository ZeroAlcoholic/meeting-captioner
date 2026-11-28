import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type CaptureHarness = {
  freeze: boolean;
  delivered: number;
  tracks: MediaStreamTrack[];
  contexts: AudioContext[];
  gain: GainNode | null;
  faultAt?: number;
};
declare global {
  interface Window {
    __captureHealth: CaptureHarness;
  }
}

const cases = [
  ...(['silence', 'freeze', 'suspend', 'mute', 'ended'] as const).map((fault) => ({
    fault,
    purpose: 'translation' as const,
  })),
  { fault: 'freeze' as const, purpose: 'transcription' as const },
];
for (const { fault, purpose } of cases) {
  test(`capture health: ${purpose} native PCM ${fault} and Stop cancellation`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    if (fault === 'freeze') test.setTimeout(55_000);
    const origin = new URL(baseURL!).origin;
    let writerHeaders: Record<string, string> | undefined;
    let setups = 0;
    let packets = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) return;
      if (url.pathname === '/meetings/lease/release') {
        writerHeaders = undefined;
        return;
      }
      const headers = request.headers();
      if (headers['x-meeting-lease']) {
        writerHeaders = {
          origin,
          authorization: headers.authorization,
          'x-meeting-lease': headers['x-meeting-lease'],
          ...(headers['x-meeting-generation']
            ? { 'x-meeting-generation': headers['x-meeting-generation'] }
            : {}),
        };
      }
    });
    try {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/session/info')
          return route.fulfill({
            json: { hasGeminiKey: true, hasApiKey: false, availableProviders: ['gemini'] },
          });
        if (url.pathname === '/session/gemini')
          return route.fulfill({
            json: { token: 'local-only', model: 'models/gemini-3.5-live-translate-preview' },
          });
        if (url.pathname === '/session/gemini/transcription')
          return route.fulfill({
            json: {
              token: 'local-only',
              expiresAt: Date.now() + 120000,
              model: 'models/gemini-3.5-transcribe-live',
            },
          });
        return route.continue();
      });
      await context.routeWebSocket('**/*', (socket) => {
        if (!socket.url().startsWith('wss://generativelanguage.googleapis.com/')) {
          socket.close();
          return;
        }
        socket.onMessage((raw) => {
          const event = JSON.parse(String(raw));
          if (event.setup) {
            setups++;
            socket.send(JSON.stringify({ setupComplete: {} }));
          }
          if (event.realtimeInput?.audio) {
            packets++;
            if (packets % 10 === 0)
              socket.send(
                JSON.stringify({
                  serverContent: {
                    inputTranscription: { text: `Packet ${packets}.` },
                    outputTranscription: { text: `保留的字幕 ${packets}。` },
                    turnComplete: true,
                  },
                }),
              );
          }
          if (event.realtimeInput?.activityEnd)
            socket.send(
              JSON.stringify({
                serverContent: {
                  inputTranscription: { text: '受控純字幕尾段。' },
                  generationComplete: true,
                  turnComplete: true,
                },
              }),
            );
        });
      });
      await page.addInitScript((purpose) => {
        if (purpose === 'transcription')
          localStorage.setItem(
            'meeting-audio:settings:v1',
            JSON.stringify({
              v: 1,
              modeId: 'online_full',
              audioSource: 'mic',
              onlineProvider: 'gemini',
              captionTask: {
                purpose,
                inputLanguages: ['zh-tw', 'en'],
                textPolicy: 'zh-TW-preserve-original',
              },
            }),
          );
        const state: CaptureHarness = (window.__captureHealth = {
          freeze: false,
          delivered: 0,
          tracks: [],
          contexts: [],
          gain: null,
        });
        const NativeContext = window.AudioContext;
        const NativeWorklet = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends NativeWorklet {
          constructor(ctx: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(ctx, name, options);
            state.contexts.push(ctx as AudioContext);
            const port = this.port;
            const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!;
            Object.defineProperty(port, 'onmessage', {
              configurable: true,
              get: () => descriptor.get!.call(port),
              set: (handler: ((event: MessageEvent) => void) | null) => {
                descriptor.set!.call(
                  port,
                  handler
                    ? (event: MessageEvent) => {
                        // Freeze the real PCM delivery boundary. An independent counter
                        // probe still advances and must not hide this consumer failure.
                        if (event.data instanceof ArrayBuffer) {
                          if (state.freeze) return;
                          state.delivered++;
                        }
                        handler.call(port, event);
                      }
                    : null,
                );
              },
            });
          }
        };
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new NativeContext();
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          const destination = ctx.createMediaStreamDestination();
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await ctx.resume();
          state.gain = gain;
          state.tracks.push(...destination.stream.getTracks());
          return destination.stream;
        };
      }, purpose);
      await page.goto('/');
      if (purpose === 'translation') {
        await page.getByTestId('launch-gemini').click();
        await expect.poll(() => packets).toBeGreaterThan(10);
        await expect(page.locator('body')).toContainText('保留的字幕');
        await page.getByRole('button', { name: 'Open settings' }).click();
        await expect(page.getByTestId('health-audio')).toBeVisible();
      } else {
        await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
        await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕');
        await expect
          .poll(() => page.evaluate(() => window.__captureHealth.delivered))
          .toBeGreaterThan(10);
      }
      const initialSetups = setups;
      const injectedAt = await page.evaluate(async (fault) => {
        const state = window.__captureHealth;
        if (fault !== 'silence') {
          const element =
            document.querySelector('[data-testid="health-audio"]') ??
            document.querySelector('[data-testid="mic-level-bar"]')!;
          const observer = new MutationObserver(() => {
            const reason = element.getAttribute('data-reason');
            if (reason && reason !== 'capture_resumed') {
              state.faultAt = performance.now();
              observer.disconnect();
            }
          });
          observer.observe(element, { attributes: true, attributeFilter: ['data-reason'] });
        }
        const at = performance.now();
        if (fault === 'freeze') state.freeze = true;
        if (fault === 'silence') state.gain!.gain.value = 0;
        if (fault === 'suspend')
          await Promise.all([...new Set(state.contexts)].map((ctx) => ctx.suspend()));
        if (fault === 'mute') {
          Object.defineProperty(state.tracks[0], 'muted', { configurable: true, value: true });
          state.tracks[0].dispatchEvent(new Event('mute'));
        }
        if (fault === 'ended') {
          state.tracks[0].stop();
          state.tracks[0].dispatchEvent(new Event('ended'));
        }
        return at;
      }, fault);
      const health = page.getByTestId(purpose === 'translation' ? 'health-audio' : 'mic-level-bar');
      if (fault === 'silence') {
        const before = packets;
        await expect.poll(() => packets).toBeGreaterThan(before + 70);
        await expect(health).not.toHaveAttribute('data-state', /failed|degraded/);
      } else {
        await expect(health).toHaveAttribute('data-state', /failed|degraded/, { timeout: 3000 });
        const reason = {
          freeze: 'capture_stalled',
          suspend: 'context_suspended',
          mute: 'track_muted',
          ended: 'track_ended',
        }[fault];
        await expect(health).toHaveAttribute('data-reason', reason);
      }
      expect(setups).toBe(initialSetups);
      const evidence = await health.getAttribute('title');
      const observedAt = await page.evaluate(() => performance.now());
      const faultAt = await page.evaluate(() => window.__captureHealth.faultAt);
      if (fault !== 'silence') expect(faultAt).toBeDefined();
      if (fault === 'freeze') expect(faultAt! - injectedAt).toBeLessThanOrEqual(2000);
      if (fault === 'freeze') {
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('mic-level-bar')).toContainText('收音資料已停止前進');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          page.viewportSize()!.width,
        );
        const workspace = await page.locator('.meeting-workspace').evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
        }));
        expect(workspace.content).toBeLessThanOrEqual(workspace.width);
        await page.screenshot({ path: info.outputPath('capture-stalled.png') });
      }
      if (fault === 'freeze') {
        // Cross the existing 30s upstream wedge deadline: live source energy
        // cannot turn a stalled local PCM consumer into a cloud reconnect.
        await page.waitForTimeout(31_000);
        expect(setups).toBe(initialSetups);
        await expect(page.getByTestId('mic-level-bar')).toHaveAttribute(
          'data-reason',
          'capture_stalled',
        );
      }
      if (fault === 'mute') {
        await page.evaluate(() => {
          const track = window.__captureHealth.tracks[0];
          Object.defineProperty(track, 'muted', { configurable: true, value: false });
          track.dispatchEvent(new Event('unmute'));
        });
        await expect(health).toHaveAttribute('data-state', 'connected');
        expect(setups).toBe(initialSetups);
      }
      await page.keyboard.press('Escape');
      if (purpose === 'translation') await page.getByTestId('stop-fake-replay').click();
      else await page.getByRole('button', { name: '停止並保存', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__captureHealth.tracks.filter((track) => track.readyState === 'live').length,
          ),
        )
        .toBe(0);
      if (purpose === 'transcription')
        await expect(page.getByTestId('pure-session-status')).toContainText('收音已停止');
      await page.evaluate(async () => {
        const state = window.__captureHealth;
        state.freeze = false;
        Object.defineProperty(state.tracks[0], 'muted', { configurable: true, value: false });
        state.tracks[0].dispatchEvent(new Event('unmute'));
        await Promise.all([...new Set(state.contexts)].map((ctx) => ctx.resume()));
      });
      const stoppedPackets = packets;
      await page.waitForTimeout(2200); // Let the former watchdog deadline expire after Stop.
      expect(packets).toBe(stoppedPackets);
      expect(setups).toBe(initialSetups);
      if (purpose === 'translation') await expect(page.locator('body')).toContainText('保留的字幕');
      expect(errors).toEqual([]);
      await writeFile(
        info.outputPath('capture-health.json'),
        JSON.stringify(
          {
            fault,
            purpose,
            injectedAt,
            observedAt,
            faultAt,
            evidence,
            setups,
            packets,
            scope:
              'Native Chrome synthetic capture; controlled upstream; mute/ended are injected events.',
          },
          null,
          2,
        ),
      );
    } finally {
      await page.close();
      if (writerHeaders) {
        const released = await context.request.post(origin + '/meetings/lease/release', {
          headers: writerHeaders,
        });
        expect(released.ok()).toBe(true);
      }
    }
  });
}
