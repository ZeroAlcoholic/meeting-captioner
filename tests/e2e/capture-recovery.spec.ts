import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type { MeetingManifest } from '@meeting-audio/contracts';

type DeviceHarness = {
  available: string[];
  requests: MediaStreamConstraints[];
  tracks: MediaStreamTrack[];
  holdNext: boolean;
  grant: (() => void) | null;
  clockOffset: number;
};
declare global {
  interface Window {
    __deviceRecovery: DeviceHarness;
  }
}

for (const { purpose, action } of [
  { purpose: 'translation', action: 'Stop' },
  { purpose: 'translation', action: 'Pause' },
  { purpose: 'transcription', action: 'Stop' },
] as const) {
  test(`device recovery: ${purpose} original mic only and ${action} cancels late grant`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    const origin = new URL(baseURL!).origin;
    let writerHeaders: Record<string, string> | undefined;
    const errors: string[] = [];
    let setups = 0;
    let audioPackets = 0;
    const meetingTitle = `Capture recovery ${Date.now()}`;
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
        if (url.pathname === '/session/gemini' || url.pathname === '/session/gemini/transcription')
          return route.fulfill({
            json: {
              token: 'local-only',
              expiresAt: Date.now() + 120_000,
              model: url.pathname.endsWith('/transcription')
                ? 'models/gemini-3.5-transcribe-live'
                : 'models/gemini-3.5-live-translate-preview',
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
            audioPackets++;
            if (audioPackets % 10 === 0)
              socket.send(
                JSON.stringify({
                  serverContent: {
                    inputTranscription: { text: `Source ${audioPackets}.` },
                    outputTranscription: { text: `裝置恢復前後保留的字幕 ${audioPackets}。` },
                    turnComplete: true,
                  },
                }),
              );
          }
        });
      });
      await page.addInitScript((purpose) => {
        localStorage.setItem(
          'meeting-audio:settings:v1',
          JSON.stringify({
            v: 1,
            modeId: 'online_full',
            audioSource: 'mic',
            onlineProvider: 'gemini',
            micDeviceId: 'original-usb',
            captionTask:
              purpose === 'translation'
                ? { purpose, langPair: 'en→zh-TW' }
                : {
                    purpose,
                    inputLanguages: ['zh-tw', 'en'],
                    textPolicy: 'zh-TW-preserve-original',
                  },
          }),
        );
        const state: DeviceHarness = (window.__deviceRecovery = {
          available: ['original-usb'],
          requests: [],
          tracks: [],
          holdNext: false,
          grant: null,
          clockOffset: 0,
        });
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + state.clockOffset;
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = async (descriptor) => {
          if ((descriptor.name as string) !== 'microphone') return originalQuery(descriptor);
          return Object.assign(new EventTarget(), {
            state: 'granted',
            onchange: null,
          }) as PermissionStatus;
        };
        navigator.mediaDevices.enumerateDevices = async () =>
          state.available.map(
            (deviceId) =>
              ({
                deviceId,
                kind: 'audioinput',
                groupId: deviceId,
                label: deviceId,
                toJSON() {
                  return {};
                },
              }) as MediaDeviceInfo,
          );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          state.requests.push(constraints ?? {});
          if (state.holdNext) {
            state.holdNext = false;
            await new Promise<void>((resolve) => {
              state.grant = resolve;
            });
            state.grant = null;
          }
          const ctx = new AudioContext();
          const oscillator = ctx.createOscillator();
          const destination = ctx.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await ctx.resume();
          const track = destination.stream.getAudioTracks()[0];
          const getSettings = track.getSettings.bind(track);
          // Preserve real Chrome PCM, but control device identity and availability.
          track.getSettings = () => ({ ...getSettings(), deviceId: 'original-usb' });
          const stop = track.stop.bind(track);
          let stopped = false;
          track.stop = () => {
            if (stopped) return;
            stopped = true;
            stop();
            void ctx.close();
          };
          state.tracks.push(track);
          return destination.stream;
        };
      }, purpose);
      await page.goto('/');
      if (purpose === 'translation') await page.getByTestId('launch-gemini').click();
      else {
        await page.getByRole('textbox', { name: '會議名稱', exact: true }).fill(meetingTitle);
        await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
      }
      const health = page.getByTestId('mic-level-bar');
      await expect(health).toHaveAttribute('data-reason', 'capture_resumed');
      await expect.poll(() => setups).toBe(1);
      if (purpose === 'translation')
        await expect(page.locator('body')).toContainText('裝置恢復前後保留的字幕');
      // A clock jump represents uncertain elapsed time, never fabricated PCM.
      // This is controlled clock injection, not a physical sleep/wake test.
      await page.evaluate(() => {
        window.__deviceRecovery.clockOffset = 10_000;
      });
      await expect(page.getByTestId('capture-gap-notice')).toContainText('收音完整性未確認');
      await expect(health).toHaveAttribute('data-reason', 'capture_resumed');
      expect(setups).toBe(1);
      await page.screenshot({ path: info.outputPath('capture-gap-notice.png') });
      await page.evaluate(() => {
        window.__deviceRecovery.clockOffset = 0;
      });
      await page.evaluate(() => {
        const state = window.__deviceRecovery;
        state.available = ['different-built-in'];
        const track = state.tracks.at(-1)!;
        track.stop();
        // Device and track events have independently scheduled delivery.
        navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
        track.dispatchEvent(new Event('ended'));
      });
      await expect(health).toHaveAttribute('data-reason', 'track_ended');
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.__deviceRecovery.requests.length)).toBe(1);
      expect(setups).toBe(1);
      await page.evaluate(() => {
        window.__deviceRecovery.available = ['different-built-in', 'original-usb'];
        navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
        navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      });
      await expect.poll(() => page.evaluate(() => window.__deviceRecovery.requests.length)).toBe(2);
      await expect(health).toHaveAttribute('data-reason', 'capture_resumed');
      await expect.poll(() => setups).toBe(2);
      const beforeStop = await page.evaluate(() => window.__deviceRecovery.requests);
      for (const request of beforeStop)
        expect(request.audio).toMatchObject({ deviceId: { exact: 'original-usb' } });
      await page.evaluate(() => {
        const state = window.__deviceRecovery;
        state.holdNext = true;
        const track = state.tracks.at(-1)!;
        track.stop();
        track.dispatchEvent(new Event('ended'));
        navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      });
      await expect.poll(() => page.evaluate(() => window.__deviceRecovery.requests.length)).toBe(3);
      if (purpose === 'translation')
        await page.getByTestId(action === 'Pause' ? 'pause-session' : 'stop-fake-replay').click();
      else await page.getByRole('button', { name: '停止並保存', exact: true }).click();
      await page.evaluate(() => window.__deviceRecovery.grant!());
      await expect.poll(() => page.evaluate(() => window.__deviceRecovery.tracks.length)).toBe(3);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__deviceRecovery.tracks.filter((track) => track.readyState === 'live').length,
          ),
        )
        .toBe(0);
      const stoppedPackets = audioPackets;
      const stoppedSetups = setups;
      await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
      await page.waitForTimeout(2200);
      expect(await page.evaluate(() => window.__deviceRecovery.requests.length)).toBe(3);
      expect(audioPackets).toBe(stoppedPackets);
      expect(setups).toBe(stoppedSetups);
      if (purpose === 'translation')
        await expect(page.locator('body')).toContainText('裝置恢復前後保留的字幕');
      expect(errors).toEqual([]);
      await writeFile(
        info.outputPath('device-recovery.json'),
        JSON.stringify(
          {
            purpose,
            action,
            requests: await page.evaluate(() => window.__deviceRecovery.requests),
            setups,
            audioPackets,
            scope:
              'Native Chrome synthetic PCM; injected device identity/events/permission; not physical USB recovery.',
          },
          null,
          2,
        ),
      );
      if (purpose === 'transcription') {
        await expect(page.getByTestId('persistence-status')).toContainText(
          '已保存，逐字稿尚待核對',
        );
        await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
        await page.reload();
        await page.getByRole('button', { name: meetingTitle, exact: true }).click();
        const downloaded = page.waitForEvent('download');
        await page.getByRole('button', { name: '匯出完整原始紀錄 JSON', exact: true }).click();
        const download = await downloaded;
        const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
          metadata: { manifest: MeetingManifest; meeting: { title: string } };
        };
        const manifest = exported.metadata.manifest;
        expect(exported.metadata.meeting.title).toBe(meetingTitle);
        expect(manifest.saved).toBe(true);
        const gaps = manifest.gaps.filter((gap) => 'wallClock' in gap);
        expect(gaps).toHaveLength(1);
        const gap = gaps[0];
        expect(gap).toMatchObject({
          alignment: 'estimated',
          state: 'unrecoverable',
          trackId: 'mic',
        });
        expect(gap.captureEpoch).toBeTruthy();
        expect(gap).not.toHaveProperty('startSample');
        expect(gap).not.toHaveProperty('endSample');
        expect(gap).not.toHaveProperty('sampleRate');
        if ('wallClock' in gap) {
          const elapsed = Date.parse(gap.wallClock.endAt) - Date.parse(gap.wallClock.startAt);
          expect(elapsed).toBeGreaterThanOrEqual(10_000);
          expect(elapsed).toBeLessThan(12_000);
        }
        await download.saveAs(info.outputPath('capture-gap-archive.json'));
      }
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
