import { expect, test } from '@playwright/test';

// Exercise production settings → provider → browser capture request. Device identity and
// availability are controlled; this is not evidence of physical USB recovery.
for (const purpose of ['translation', 'transcription'] as const) {
  for (const source of ['mic', 'system'] as const) {
    test(`capture selection: ${purpose} ${source} requires explicit retry after refusal`, async ({
      page,
      context,
      baseURL,
    }) => {
      const origin = new URL(baseURL!).origin;
      let writerHeaders: Record<string, string> | undefined;
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
          if (
            url.pathname === '/session/gemini' ||
            url.pathname === '/session/gemini/transcription'
          )
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
          socket.onMessage((raw) => {
            if (JSON.parse(String(raw)).setup) socket.send(JSON.stringify({ setupComplete: {} }));
          });
        });
        await page.addInitScript(
          ({ purpose, source }) => {
            localStorage.setItem(
              'meeting-audio:settings:v1',
              JSON.stringify({
                v: 1,
                modeId: 'online_full',
                audioSource: source,
                onlineProvider: 'gemini',
                micDeviceId: 'selected-usb-microphone',
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
            const calls: MediaStreamConstraints[] = [];
            Object.defineProperty(window, '__deviceRequests', { value: calls });
            navigator.mediaDevices.enumerateDevices = async () =>
              [
                {
                  deviceId: 'different-built-in-microphone',
                  kind: 'audioinput',
                  label: 'Other microphone',
                  groupId: 'other',
                  toJSON() {
                    return {};
                  },
                },
              ] as MediaDeviceInfo[];
            navigator.mediaDevices.getUserMedia = async (constraints) => {
              calls.push(constraints ?? {});
              throw new DOMException('Selected microphone unavailable', 'NotFoundError');
            };
            navigator.mediaDevices.getDisplayMedia = async () => {
              calls.push({ audio: true, video: true });
              throw new DOMException('Share permission denied', 'NotAllowedError');
            };
          },
          { purpose, source },
        );
        await page.goto('/');
        if (purpose === 'translation') await page.getByTestId('launch-gemini').click();
        else await page.getByRole('button', { name: '開始純字幕', exact: true }).click();

        const requests = () =>
          page.evaluate(
            () =>
              (window as unknown as { __deviceRequests: MediaStreamConstraints[] })
                .__deviceRequests,
          );
        await expect.poll(async () => (await requests()).length).toBe(1);
        if (source === 'mic')
          expect((await requests())[0].audio).toMatchObject({
            deviceId: { exact: 'selected-usb-microphone' },
          });
        if (purpose === 'translation')
          await page.getByRole('button', { name: 'Open settings' }).click();
        await expect(
          page.getByTestId(purpose === 'translation' ? 'health-audio' : 'mic-level-bar'),
        ).toHaveAttribute('data-state', 'failed');
        // An unrelated devicechange must not restart capture or select the built-in mic.
        await page.evaluate(() => {
          navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
          navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
        });
        await page.waitForTimeout(2200);
        expect(await requests()).toHaveLength(1);
        if (source === 'system') {
          await page.keyboard.press('Escape');
          const retry =
            purpose === 'translation'
              ? page.getByTestId('retry-real')
              : page.getByRole('button', { name: '重新分享音訊', exact: true });
          await expect(retry).toHaveCount(1);
          await retry.click();
          await expect.poll(async () => (await requests()).length).toBe(2);
          await page.waitForTimeout(2200);
          expect(await requests()).toHaveLength(2);
        }
        if (purpose === 'transcription') {
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('pure-session-status')).toContainText('收音已停止');
          await expect(
            page.getByRole('button', { name: '停止並保存', exact: true }),
          ).toBeDisabled();
        }
        expect(errors).toEqual([]);
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
}
