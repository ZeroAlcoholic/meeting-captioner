import { expect, test } from '@playwright/test';
import { storageFixture } from './storage-fixture.js';
import { installRecoveryTranscription } from './service-recovery-transcription.js';
import { installOnlineMocks } from './online-mock.js';

for (const provider of ['openai', 'gemini'] as const) {
  for (const ending of ['handoff', 'stop-candidate', 'candidate-refused'] as const) {
    test(`translation ${provider} app owns microphone and remote until Stop: ${ending}`, async ({
      page,
      baseURL,
    }) => {
      const { app, repository, url } = await storageFixture([baseURL!]);
      const cors = {
        'access-control-allow-origin': baseURL!,
        'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      await page.route('**/*', async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        if (target.origin === new URL(baseURL!).origin) return route.continue();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
          return route.abort();
        const response = await route.fetch({ url: url + target.pathname + target.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      });
      const mock = await installOnlineMocks(page);
      try {
        await page.goto('/');
        await page.evaluate(async (provider) => {
          const path = '/src/settings/use-settings-store.ts';
          const { settingsStore } = await import(/* @vite-ignore */ path);
          settingsStore.setState({
            scenarioId: 'hybrid',
            onlineProvider: provider,
            transcriptRetentionEnabled: true,
          });
        }, provider);
        await expect(page.getByRole('region', { name: '遠端翻譯狀態' })).toBeVisible();
        await page.getByTestId(provider === 'openai' ? 'start-real' : 'start-gemini').click();
        await expect.poll(() => mock.userMediaAcquisitions()).toBe(1);
        await expect.poll(() => mock.displayMediaAcquisitions()).toBe(1);
        await expect
          .poll(() => (provider === 'openai' ? mock.oaiOpenPeers() : mock.geminiOpenSockets()))
          .toBe(2);
        await page.evaluate((provider) => {
          type Channel = { readyState: string | number; onmessage(event: { data: string }): void };
          const fake = (
            window as unknown as {
              __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
            }
          ).__mock;
          const channels = (provider === 'openai' ? fake.oai.dcs : fake.gemini.sockets).filter(
            (channel) => channel.readyState === 'open' || channel.readyState === 1,
          );
          channels.forEach((channel, index) => {
            const send = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
            if (provider === 'openai') {
              send({ type: 'session.input_transcript.delta', delta: `TRACK-${index}-original` });
              send({ type: 'session.output_transcript.delta', delta: `第${index}路譯文` });
            } else
              send({
                serverContent: {
                  inputTranscription: { text: `TRACK-${index}-original` },
                  outputTranscription: { text: `第${index}路譯文` },
                },
              });
          });
          channels.forEach((channel) =>
            channel.onmessage({
              data: JSON.stringify(
                provider === 'openai'
                  ? { type: 'response.output_audio_transcript.done' }
                  : { serverContent: { turnComplete: true } },
              ),
            }),
          );
        }, provider);
        const snapshot = () =>
          page.evaluate(async () => {
            const path = '/src/store/use-caption-store.ts';
            const { captionStore } = await import(/* @vite-ignore */ path);
            const state = captionStore.getState();
            return { segments: state.segments, translations: state.translations };
          });
        await expect.poll(async () => (await snapshot()).segments.length).toBe(2);
        let visible = await snapshot();
        expect(
          new Set(visible.segments.map((segment: { segmentId: string }) => segment.segmentId)).size,
        ).toBe(2);
        expect(
          visible.segments.map((segment: { source: string }) => segment.source).sort(),
        ).toEqual(['browser_system', 'microphone']);
        for (const segment of visible.segments) {
          const region = page.getByRole('region', {
            name: segment.source === 'microphone' ? '麥克風' : '遠端',
            exact: true,
          });
          await expect(region).toContainText(segment.text);
          await expect(region).toContainText(visible.translations[segment.segmentId].targetText);
        }
        const remoteSegment = visible.segments.find(
          (segment: { source: string }) => segment.source === 'browser_system',
        );
        const remoteIndex = Number(/TRACK-(\d)-/.exec(remoteSegment.text)![1]);
        await page.evaluate(
          ({ provider, index }) => {
            type Channel = {
              readyState: number;
              onmessage(event: { data: string }): void;
              onclose(event: { code: number; reason: string; wasClean: boolean }): void;
            };
            const fake = (
              window as unknown as {
                __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
              }
            ).__mock;
            if (provider === 'openai')
              fake.oai.dcs[index]!.onmessage({
                data: JSON.stringify({
                  type: 'error',
                  error: { code: 'invalid_api_key', message: 'Remote test connection rejected' },
                }),
              });
            else {
              const socket = fake.gemini.sockets[index]!;
              socket.onmessage({
                data: JSON.stringify({
                  error: {
                    code: 403,
                    status: 'PERMISSION_DENIED',
                    message: 'Remote test connection rejected',
                  },
                }),
              });
            }
          },
          { provider, index: remoteIndex },
        );
        await expect
          .poll(() => (provider === 'openai' ? mock.geminiOpenSockets() : mock.oaiOpenPeers()), {
            timeout: 15000,
          })
          .toBe(1);
        const remoteStatus = page
          .getByRole('region', { name: '遠端翻譯狀態' })
          .locator('p[role="status"]');
        await expect(remoteStatus).toContainText(provider === 'openai' ? 'OpenAI' : 'Gemini');
        if (provider === 'openai')
          await mock.geminiServerContent({ outputTranscription: { text: ' ' } });
        else await mock.oaiOutput(' ');
        await expect(remoteStatus).toContainText(provider === 'openai' ? 'OpenAI' : 'Gemini');
        if (ending === 'handoff') {
          if (provider === 'openai')
            await mock.geminiServerContent({
              inputTranscription: { text: 'REMOTE-after-handoff' },
              outputTranscription: { text: '遠端接管譯文' },
              turnComplete: true,
            });
          else {
            await mock.oaiInput('REMOTE-after-handoff');
            await mock.oaiOutput('遠端接管譯文');
            await mock.oaiComplete();
          }
          await expect(remoteStatus).toContainText(provider === 'openai' ? 'Gemini' : 'OpenAI');
          await expect(page.getByRole('region', { name: '遠端', exact: true })).toContainText(
            '遠端接管譯文',
          );
          await expect.poll(async () => (await snapshot()).segments.length).toBe(3);
        } else if (ending === 'candidate-refused') {
          await page.evaluate((provider) => {
            type Channel = { onmessage(event: { data: string }): void };
            const fake = (
              window as unknown as {
                __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
              }
            ).__mock;
            const channels = provider === 'openai' ? fake.gemini.sockets : fake.oai.dcs;
            channels[channels.length - 1]!.onmessage({
              data: JSON.stringify(
                provider === 'openai'
                  ? {
                      error: {
                        code: 403,
                        status: 'PERMISSION_DENIED',
                        message: 'Candidate refused',
                      },
                    }
                  : {
                      type: 'error',
                      error: { code: 'invalid_api_key', message: 'Candidate refused' },
                    },
              ),
            });
          }, provider);
          await expect
            .poll(() => (provider === 'openai' ? mock.geminiOpenSockets() : mock.oaiOpenPeers()))
            .toBe(0);
          await expect(
            page.getByRole('region', { name: '遠端翻譯狀態' }).getByRole('alert'),
          ).toBeVisible();
          const calls = [mock.oaiSessionCalls(), mock.geminiSessionCalls()];
          await page.waitForTimeout(16000);
          expect([mock.oaiSessionCalls(), mock.geminiSessionCalls()]).toEqual(calls);
          // The healthy microphone must still publish after both remote providers refuse.
          await page.evaluate(
            ({ provider, index }) => {
              type Channel = { onmessage(event: { data: string }): void };
              const fake = (
                window as unknown as {
                  __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
                }
              ).__mock;
              const channel = (provider === 'openai' ? fake.oai.dcs : fake.gemini.sockets)[index]!;
              const send = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
              if (provider === 'openai') {
                send({ type: 'session.input_transcript.delta', delta: 'MIC-still-working' });
                send({ type: 'session.output_transcript.delta', delta: '麥克風持續運作' });
                send({ type: 'response.output_audio_transcript.done' });
              } else
                send({
                  serverContent: {
                    inputTranscription: { text: 'MIC-still-working' },
                    outputTranscription: { text: '麥克風持續運作' },
                    turnComplete: true,
                  },
                });
            },
            { provider, index: remoteIndex === 0 ? 1 : 0 },
          );
          await expect(page.getByRole('region', { name: '麥克風', exact: true })).toContainText(
            '麥克風持續運作',
          );
          await expect.poll(async () => (await snapshot()).segments.length).toBe(3);
          await expect(remoteStatus).toContainText(provider === 'openai' ? 'OpenAI' : 'Gemini');
        } else {
          // Retain the actual installed handler: a queued callback may outlive close().
          await page.evaluate((provider) => {
            type Channel = { onmessage(event: { data: string }): void };
            const fake = (
              window as unknown as {
                __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
              }
            ).__mock;
            const channels = provider === 'openai' ? fake.gemini.sockets : fake.oai.dcs;
            const callback = channels[channels.length - 1]!.onmessage;
            (window as unknown as { lateRemoteContent: () => void }).lateRemoteContent = () => {
              callback({
                data: JSON.stringify(
                  provider === 'openai'
                    ? {
                        serverContent: {
                          inputTranscription: { text: 'LATE-REMOTE' },
                          outputTranscription: { text: '晚到譯文' },
                          turnComplete: true,
                        },
                      }
                    : { type: 'session.input_transcript.delta', delta: 'LATE-REMOTE' },
                ),
              });
            };
          }, provider);
        }
        visible = await snapshot();
        if (ending === 'handoff') {
          const meetingId = await page.evaluate(async () => {
            const path = '/src/store/use-caption-store.ts';
            return (await import(/* @vite-ignore */ path)).captionStore.getState().sessionId;
          });
          await page.getByTestId('pause-session').click();
          await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
          await expect.poll(() => mock.oaiOpenPeers()).toBe(0);
          await expect.poll(() => mock.geminiOpenSockets()).toBe(0);
          await page.reload();
          await page.getByTestId('continue-session').click();
          await expect(
            page.getByRole('button', { name: '重新檢查寫入權限', exact: true }),
          ).toBeVisible();
          expect(await mock.oaiOpenPeers()).toBe(0);
          expect(await mock.geminiOpenSockets()).toBe(0);
          await page.waitForTimeout(16000);
          await page.getByRole('button', { name: '重新檢查寫入權限', exact: true }).click();
          await expect(
            page.getByRole('button', { name: '重新檢查寫入權限', exact: true }),
          ).toHaveCount(0);
          await page.getByRole('button', { name: '重試此會議', exact: true }).click();
          await expect
            .poll(() => (provider === 'openai' ? mock.oaiOpenPeers() : mock.geminiOpenSockets()))
            .toBe(2);
          await expect.poll(snapshot).toEqual(visible);
          expect(
            await page.evaluate(async () => {
              const path = '/src/store/use-caption-store.ts';
              const state = (await import(/* @vite-ignore */ path)).captionStore.getState();
              return { id: state.sessionId, dual: state.separateTracks };
            }),
          ).toEqual({ id: meetingId, dual: true });
          await page.evaluate((provider) => {
            type Channel = {
              readyState: string | number;
              onmessage(event: { data: string }): void;
            };
            const fake = (
              window as unknown as {
                __mock: { oai: { dcs: Channel[] }; gemini: { sockets: Channel[] } };
              }
            ).__mock;
            const channels = provider === 'openai' ? fake.oai.dcs : fake.gemini.sockets;
            channels
              .filter((c) => c.readyState === 'open' || c.readyState === 1)
              .forEach((channel, index) => {
                const send = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
                if (provider === 'openai') {
                  send({ type: 'session.input_transcript.delta', delta: `RESUMED-${index}` });
                  send({ type: 'session.output_transcript.delta', delta: `續接第${index}路` });
                  send({ type: 'response.output_audio_transcript.done' });
                } else
                  send({
                    serverContent: {
                      inputTranscription: { text: `RESUMED-${index}` },
                      outputTranscription: { text: `續接第${index}路` },
                      turnComplete: true,
                    },
                  });
              });
          }, provider);
          await expect.poll(async () => (await snapshot()).segments.length).toBe(5);
          visible = await snapshot();
          expect(
            visible.segments
              .filter((s: { text: string }) => s.text.startsWith('RESUMED-'))
              .map((s: { source: string }) => s.source)
              .sort(),
          ).toEqual(['browser_system', 'microphone']);
        }
        expect(await mock.userMediaAcquisitions()).toBe(1);
        // Reload: one rejected admission and one explicit retry each open the picker.
        expect(await mock.displayMediaAcquisitions()).toBe(ending === 'handoff' ? 2 : 1);
        expect(
          await page.evaluate(async () => {
            const path = '/src/settings/use-settings-store.ts';
            return (await import(/* @vite-ignore */ path)).settingsStore.getState().onlineProvider;
          }),
        ).toBe(provider);
        await page.getByTestId('stop-fake-replay').click();
        await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
        await expect.poll(() => mock.oaiOpenPeers()).toBe(0);
        await expect.poll(() => mock.geminiOpenSockets()).toBe(0);
        if (ending === 'stop-candidate') {
          await page.evaluate(() =>
            (window as unknown as { lateRemoteContent: () => void }).lateRemoteContent(),
          );
          // Cross the recovery scheduler's longest backoff without replacing browser timers.
          await page.waitForTimeout(16000);
          expect(await mock.oaiOpenPeers()).toBe(0);
          expect(await mock.geminiOpenSockets()).toBe(0);
          expect(await mock.activeCaptureTracks()).toBe(0);
          expect(await mock.userMediaAcquisitions()).toBe(1);
          expect(await mock.displayMediaAcquisitions()).toBe(1);
          expect(await snapshot()).toEqual(visible);
          expect(
            await page.evaluate(async () => {
              const path = '/src/store/use-caption-store.ts';
              const state = (await import(/* @vite-ignore */ path)).captionStore.getState();
              return {
                tracks: state.liveTracks,
                partial: state.livePartial,
                translation: state.liveTranslation,
              };
            }),
          ).toEqual({ tracks: {}, partial: null, translation: null });
        }
        await expect(page.getByRole('region', { name: '遠端翻譯狀態' })).toContainText(
          '遠端收音已停止',
        );
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const path = '/src/store/meeting-archive.ts';
              const { meetingArchive } = await import(/* @vite-ignore */ path);
              return meetingArchive.getStatus().manifest?.saved === true;
            }),
          )
          .toBe(true);
        const saved = await page.evaluate(async () => {
          const path = '/src/store/meeting-archive.ts';
          const { meetingArchive } = await import(/* @vite-ignore */ path);
          const id = meetingArchive.getStatus().meetingId;
          const stored = await meetingArchive.loadMeeting(id);
          const exported = JSON.parse(
            await (await meetingArchive.exportMeeting(id, 'original', 'json')).text(),
          );
          return { stored, exported };
        });
        expect(saved.exported.segments).toEqual(saved.stored.segments);
        expect(saved.exported.translations).toEqual(saved.stored.translations);
        expect(
          saved.stored.segments.map(
            (segment: { segmentId: string; text: string; source: string }) => ({
              id: segment.segmentId,
              text: segment.text,
              source: segment.source,
            }),
          ),
        ).toEqual(
          visible.segments.map((segment: { segmentId: string; text: string; source: string }) => ({
            id: segment.segmentId,
            text: segment.text,
            source: segment.source,
          })),
        );
        for (const segment of visible.segments)
          expect(saved.exported.translations[segment.segmentId].targetText).toBe(
            visible.translations[segment.segmentId].targetText,
          );
      } finally {
        await page.close();
        await app.close();
        await repository.close();
      }
    });
  }
}

for (const provider of ['openai', 'gemini'] as const) {
  test(`translation ${provider} scoped hook captures remote without overwriting microphone health`, async ({
    page,
  }) => {
    const mock = await installOnlineMocks(page);
    await page.goto('/');
    await page.evaluate(async (provider) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const [React, { default: ReactDOM }, hooks, { createCaptureLeaseOwner }, { settingsStore }] =
        await Promise.all([
          load('/node_modules/.vite/deps/react.js'),
          load('/node_modules/.vite/deps/react-dom_client.js'),
          load(
            provider === 'openai'
              ? '/src/providers/use-openai-realtime.ts'
              : '/src/providers/use-gemini-live.ts',
          ),
          load('/src/providers/capture-lease.ts'),
          load('/src/settings/use-settings-store.ts'),
        ]);
      const owner = createCaptureLeaseOwner();
      const events: unknown[] = [];
      const before = JSON.stringify(settingsStore.getState().health);
      const scope = {
        trackId: 'remote',
        createAudio: () => owner.leaseCapture({ kind: 'system', micDistance: 'off' }),
        onHealth: (event: unknown) => events.push(event),
        onAudioLevel: () => {},
      };
      const useProvider = provider === 'openai' ? hooks.useOpenAIRealtime : hooks.useGeminiLive;
      function Probe() {
        const hook = useProvider(scope);
        Object.assign(window, {
          scopedTranslation: hook,
          scopedHealth: () => ({
            count: events.length,
            unchanged: before === JSON.stringify(settingsStore.getState().health),
          }),
        });
        return null;
      }
      const host = document.createElement('div');
      document.body.append(host);
      ReactDOM.createRoot(host).render(React.default.createElement(Probe));
    }, provider);
    await expect
      .poll(() =>
        page.evaluate(
          () => !!(window as unknown as { scopedTranslation?: unknown }).scopedTranslation,
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { scopedTranslation: { start(): Promise<boolean> } }
        ).scopedTranslation.start(),
      ),
    ).toBe(true);
    expect(await mock.displayMediaAcquisitions()).toBe(1);
    expect(await mock.userMediaAcquisitions()).toBe(0);
    if (provider === 'openai') await mock.oaiInput('REMOTE-scoped-caption');
    else await mock.geminiServerContent({ inputTranscription: { text: 'REMOTE-scoped-caption' } });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = '/src/store/use-caption-store.ts';
          const { captionStore } = await import(/* @vite-ignore */ path);
          return captionStore.getState().livePartial?.source;
        }),
      )
      .toBe('browser_system');
    await page.evaluate(() =>
      (
        window as unknown as { scopedTranslation: { restoreHealth(): void } }
      ).scopedTranslation.restoreHealth(),
    );
    const health = await page.evaluate(() =>
      (
        window as unknown as { scopedHealth(): { count: number; unchanged: boolean } }
      ).scopedHealth(),
    );
    expect(health.count).toBeGreaterThan(0);
    expect(health.unchanged).toBe(true);
    await page.evaluate(() =>
      (window as unknown as { scopedTranslation: { stop(): void } }).scopedTranslation.stop(),
    );
    expect(await mock.activeCaptureTracks()).toBe(0);
  });
}

for (const provider of ['openai', 'gemini'] as const) {
  for (const picker of ['shared', 'cancelled', 'pending', 'handoff'] as const) {
    const cancelled = picker === 'cancelled',
      pending = picker === 'pending';
    test(`pure dual ${provider} session starts and stops real captures; picker=${picker}`, async ({
      page,
      baseURL,
    }) => {
      const { app, repository, url } = await storageFixture([baseURL!]);
      const cors = {
        'access-control-allow-origin': baseURL!,
        'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      await page.route('**/*', async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        if (target.origin === new URL(baseURL!).origin) return route.continue();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
          return route.abort();
        const response = await route.fetch({ url: url + target.pathname + target.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      });
      const upstream = await installRecoveryTranscription(page, provider, picker === 'handoff');
      await page.routeWebSocket(
        (target) => target.origin === baseURL!.replace(/^http/, 'ws'),
        (socket) => {
          socket.connectToServer();
        },
      );
      await page.addInitScript((picker) => {
        const streams: MediaStream[] = [];
        let releaseShare!: () => void;
        const shareGate = new Promise<void>((resolve) => {
          releaseShare = resolve;
        });
        let shareReturned = false;
        let microphone: MediaStream | undefined;
        const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await acquire(constraints);
          microphone = stream;
          streams.push(stream);
          return stream;
        };
        navigator.mediaDevices.getDisplayMedia = async () => {
          if (picker === 'cancelled') throw new DOMException('Cancelled', 'NotAllowedError');
          if (picker === 'pending') await shareGate;
          const context = new AudioContext(),
            destination = context.createMediaStreamDestination();
          const audio = await fetch('/recovery-speech.wav').then((response) =>
            response.arrayBuffer(),
          );
          const buffer = await context.decodeAudioData(audio);
          const firstSpeech =
            buffer.getChannelData(0).findIndex((sample) => Math.abs(sample) > 0.01) /
            buffer.sampleRate;
          Object.assign(window, {
            __dualRemoteSpeak: () => {
              const speech = context.createBufferSource();
              speech.buffer = buffer;
              speech.connect(destination);
              speech.start(0, Math.max(0, firstSpeech), 2);
            },
          });
          const source = context.createConstantSource();
          source.offset.value = 0;
          source.connect(destination);
          source.start();
          await context.resume();
          const stream = destination.stream;
          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              stop();
              source.stop();
              void context.close();
            };
          }
          streams.push(stream);
          shareReturned = true;
          return stream;
        };
        Object.assign(window, {
          releaseDualShare: releaseShare,
          dualShareReturned: () => shareReturned,
          endDualMic: () => {
            const track = microphone!.getAudioTracks()[0]!;
            track.stop();
            track.dispatchEvent(new Event('ended'));
          },
          dualLiveTracks: () =>
            streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
        });
      }, picker);
      try {
        await page.goto('/');
        await page.evaluate(async () => {
          const path = '/src/settings/use-settings-store.ts';
          const { settingsStore } = await import(/* @vite-ignore */ path);
          // Qualification remains disabled in the public scenario selector.
          settingsStore.setState({ scenarioId: 'hybrid' });
        });
        await upstream.start();
        const remote = page.getByRole('region', { name: '遠端收音狀態' });
        await expect(remote).toContainText(
          cancelled ? '遠端音訊未取得' : pending ? '請選擇分享來源' : '正在顯示純字幕',
        );
        await expect.poll(() => upstream.connectionCount()).toBe(cancelled || pending ? 1 : 2);
        const live = () =>
          page.evaluate(() => (window as unknown as { dualLiveTracks(): number }).dualLiveTracks());
        await expect.poll(live).toBe(cancelled || pending ? 1 : 2);
        if (cancelled) {
          await upstream.emit('LOCAL-after-remote-cancel');
        } else if (!pending) {
          await upstream.emit('LOCAL-dual-1');
          await upstream.emit('REMOTE-dual-1', 'remote');
          await expect(page.getByRole('region', { name: '麥克風', exact: true })).toContainText(
            'LOCAL-dual-1',
          );
          await expect(page.getByRole('region', { name: '遠端', exact: true })).toContainText(
            'REMOTE-dual-1',
          );
          if (picker === 'handoff') {
            upstream.refuse('remote');
            await expect.poll(() => upstream.connectionCount(), { timeout: 15000 }).toBe(3);
            await upstream.emit('REMOTE-after-handoff', 'remote');
            await expect(remote).toContainText(provider === 'openai' ? 'gemini' : 'openai');
            await upstream.emit('LOCAL-after-remote-handoff');
            await expect(page.getByTestId('pure-session-status')).toContainText(
              provider === 'openai' ? 'OpenAI' : 'Gemini',
            );
            expect(await upstream.captures()).toBe(1);
            expect(await live()).toBe(2);
            // Exercise the real capture monitors while both native streams remain alive.
            await page.evaluate(async () => {
              const original = Date.now;
              const jumped = original() + 10000;
              Date.now = () => jumped;
              try {
                await new Promise((resolve) => setTimeout(resolve, 200));
              } finally {
                Date.now = original;
              }
            });
          }
          await page.evaluate(() => (window as unknown as { endDualMic(): void }).endDualMic());
          await expect(page.getByTestId('pure-session-status')).toContainText('需要人工處理');
          await expect(remote).toContainText('正在顯示純字幕');
          await expect.poll(live).toBe(1);
        }
        await page.getByRole('button', { name: '停止並保存', exact: true }).click();
        if (pending) {
          await page.evaluate(() =>
            (window as unknown as { releaseDualShare(): void }).releaseDualShare(),
          );
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as unknown as { dualShareReturned(): boolean }).dualShareReturned(),
              ),
            )
            .toBe(true);
        }
        await expect.poll(live).toBe(0);
        await expect(page.getByTestId('pure-session-status')).toContainText('收音已停止');
        // Deliberately ending a track leaves a known gap; it must not claim a complete transcript.
        await expect(page.getByTestId('persistence-status')).toContainText(
          cancelled || pending ? '已結案' : '已保存，逐字稿尚待核對',
        );
        await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
        if (!cancelled && !pending)
          await expect(page.getByTestId('persistence-status')).toContainText(
            `已知缺口 ${picker === 'handoff' ? 4 : 1}`,
          );
        if (cancelled) {
          const exported = await page.evaluate(async () => {
            const path = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ path);
            return (
              await meetingArchive.exportMeeting(
                meetingArchive.getStatus().meetingId,
                'original',
                'txt',
              )
            ).text();
          });
          expect(exported).toContain('LOCAL-after-remote-cancel');
        }
        if (!cancelled && !pending) {
          const archived = await page.evaluate(async () => {
            const path = '/src/store/meeting-archive.ts';
            const { meetingArchive } = await import(/* @vite-ignore */ path);
            const id = meetingArchive.getStatus().meetingId;
            const page = await meetingArchive.loadMeeting(id);
            const exported = JSON.parse(
              await (await meetingArchive.exportMeeting(id, 'original', 'json')).text(),
            );
            return { segments: page.segments, exported };
          });
          expect(archived.segments).toHaveLength(picker === 'handoff' ? 4 : 2);
          if (picker === 'handoff') {
            const gaps = archived.exported.metadata.manifest.gaps.filter((gap: { cause: string }) =>
              gap.cause.includes('休眠'),
            );
            expect(gaps).toHaveLength(2);
            expect(gaps.map((gap: { trackId: string }) => gap.trackId).sort()).toEqual([
              'mic',
              'remote',
            ]);
            expect(
              new Set(gaps.map((gap: { captureEpoch: string }) => gap.captureEpoch)).size,
            ).toBe(2);
            for (const gap of gaps) {
              expect(gap.captureEpoch).not.toMatch(/^unconfirmed:/);
              expect(
                Date.parse(gap.wallClock.endAt) - Date.parse(gap.wallClock.startAt),
              ).toBeGreaterThanOrEqual(10000);
              expect(gap.alignment).toBe('estimated');
              expect(gap.meetingId).toBe(archived.exported.metadata.meeting.meetingId);
            }
            expect(archived.segments).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ source: 'browser_system', text: 'REMOTE-after-handoff' }),
                expect.objectContaining({
                  source: 'microphone',
                  text: 'LOCAL-after-remote-handoff',
                }),
              ]),
            );
          }
          expect(archived.segments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ source: 'microphone', text: 'LOCAL-dual-1' }),
              expect.objectContaining({ source: 'browser_system', text: 'REMOTE-dual-1' }),
            ]),
          );
          expect(
            new Set(archived.segments.map((segment: { segmentId: string }) => segment.segmentId))
              .size,
          ).toBe(picker === 'handoff' ? 4 : 2);
          expect(archived.exported.segments).toEqual(archived.segments);
          expect(archived.exported.metadata.meeting.separateTracks).toBe(true);
          await page.reload();
          await page.getByRole('button', { name: /繼續此會議.*雙軌/ }).click();
          await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕');
          await expect(page.getByRole('region', { name: '遠端收音狀態' })).toContainText(
            '正在顯示純字幕',
          );
          await expect.poll(live).toBe(2);
          const restored = await page.evaluate(async () => {
            const path = '/src/store/use-caption-store.ts';
            const { captionStore } = await import(/* @vite-ignore */ path);
            const state = captionStore.getState();
            return {
              id: state.sessionId,
              dual: state.separateTracks,
              ids: state.segments.map((s: { segmentId: string }) => s.segmentId),
            };
          });
          expect(restored.id).toBe(archived.exported.metadata.meeting.meetingId);
          expect(restored.dual).toBe(true);
          expect(restored.ids).toEqual(
            archived.segments.map((s: { segmentId: string }) => s.segmentId),
          );
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect.poll(live).toBe(0);
          await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
          await expect(page.getByRole('button', { name: '開始純字幕', exact: true })).toBeEnabled();
        }
        if (pending) {
          expect(upstream.connectionCount()).toBe(1);
          expect(upstream.mintCount()).toBe(1);
          await expect(page.getByRole('button', { name: '開始純字幕', exact: true })).toBeEnabled();
        }
      } finally {
        await page.close();
        await app.close();
        await repository.close();
      }
    });
  }
}

for (const purpose of ['translation', 'transcription'] as const) {
  test(`dual ${purpose} board keeps both sources visible through interleaved finals`, async ({
    page,
  }) => {
    await page.goto('/');
    await page.evaluate(async (purpose) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const [{ captionStore }, component, React, { default: ReactDOM }] = await Promise.all([
        load('/src/store/use-caption-store.ts'),
        load(
          purpose === 'translation'
            ? '/src/caption-board/CaptionBoard.tsx'
            : '/src/components/PureCaptionText.tsx',
        ),
        load('/node_modules/.vite/deps/react.js'),
        load('/node_modules/.vite/deps/react-dom_client.js'),
      ]);
      const host = document.createElement('div');
      host.id = 'dual-board-test';
      host.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:#080c15';
      document.body.append(host);
      captionStore
        .getState()
        .beginSession(
          'real',
          purpose === 'translation'
            ? { purpose, langPair: 'en→zh-TW' }
            : { purpose, inputLanguages: ['zh-tw', 'en'], textPolicy: 'zh-TW-preserve-original' },
          true,
        );
      ReactDOM.createRoot(host).render(
        React.default.createElement(
          purpose === 'translation' ? component.CaptionBoard : component.PureLiveCaptions,
        ),
      );
      Object.assign(window, {
        translateTrack: (track: string, text: string) =>
          captionStore.getState().applyTranslation({
            sourceSegmentId: track,
            provider: 'test',
            status: 'partial',
            sourceText: track === 'mic' ? 'local draft' : 'remote draft',
            targetText: text,
            sourceLanguage: 'en',
            targetLanguage: 'zh-TW',
            updatedAt: new Date().toISOString(),
          }),
        emitTrack: (track: string, status: string, text: string) =>
          captionStore.getState().applyTranscript({
            segmentId: track,
            provider: 'test',
            source: track === 'mic' ? 'microphone' : 'browser_system',
            mode: 'online',
            status,
            text,
            startMs: track === 'mic' ? 0 : 1,
          }),
      });
    }, purpose);
    const emit = (track: string, status: string, text: string) =>
      page.evaluate(
        (args) =>
          (window as unknown as { emitTrack: (...args: string[]) => void }).emitTrack(...args),
        [track, status, text],
      );
    const board = page.locator('#dual-board-test');
    const mic = board.getByRole('region', { name: '麥克風', exact: true });
    const remote = board.getByRole('region', { name: '遠端', exact: true });
    await emit('mic', 'partial', 'local draft');
    await emit('remote', 'partial', 'remote draft');
    await expect(mic).toContainText('local draft');
    await expect(remote).toContainText('remote draft');
    await page.evaluate(() => {
      const state = window as unknown as { translateTrack: (track: string, text: string) => void };
      state.translateTrack('mic', '現場原文翻譯');
      state.translateTrack('remote', '遠端原文翻譯');
    });
    if (purpose === 'translation') {
      await expect(mic.getByTestId('caption-target')).toHaveText('現場原文翻譯');
      await expect(remote.getByTestId('caption-target')).toHaveText('遠端原文翻譯');
    } else {
      await expect(board).not.toContainText('原文翻譯');
    }
    await emit('mic', 'final', 'local final');
    await expect(mic).toContainText('local final');
    await expect(remote).toContainText('remote draft');
    await emit('remote', 'final', 'remote final');
    await expect(mic).toContainText('local final');
    await expect(remote).toContainText('remote final');
    await expect(board.getByText('local final', { exact: true })).toHaveCount(1);
    await expect(board.getByText('remote final', { exact: true })).toHaveCount(1);
    if (purpose === 'translation') {
      await expect(mic.getByTestId('caption-target')).toHaveText('現場原文翻譯');
      await expect(remote.getByTestId('caption-target')).toHaveText('遠端原文翻譯');
    } else {
      await expect(board).not.toContainText('原文翻譯');
    }
    await page.screenshot({ path: `.cache/w11-dual-${purpose}-board.png` });
    await page.evaluate(async (purpose) => {
      const path = '/src/store/use-caption-store.ts';
      const { captionStore } = await import(/* @vite-ignore */ path);
      captionStore
        .getState()
        .beginSession(
          'real',
          purpose === 'translation'
            ? { purpose, langPair: 'en→zh-TW' }
            : { purpose, inputLanguages: ['zh-tw', 'en'], textPolicy: 'zh-TW-preserve-original' },
        );
    }, purpose);
    await emit('mic', 'final', 'single source');
    await expect(board).toContainText('single source');
    await expect(mic).toHaveCount(0);
    await expect(remote).toHaveCount(0);
    await expect(board).not.toContainText('remote final');
  });
}

test('independent capture owners retain native mic/remote PCM and stop separately', async ({
  page,
  context,
  baseURL,
}) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(baseURL!).origin
      ? route.continue()
      : route.abort(),
  );
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/src/providers/capture-lease.ts';
    const { createCaptureLeaseOwner } = await import(/* @vite-ignore */ path);
    const streams: MediaStream[] = [];
    const contexts: AudioContext[] = [];
    const counts = { mic: 0, remote: 0 };
    const source = async (kind: 'mic' | 'remote') => {
      counts[kind]++;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = kind === 'mic' ? 440 : 880;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      contexts.push(context);
      streams.push(destination.stream);
      return destination.stream;
    };
    navigator.mediaDevices.getUserMedia = () => source('mic');
    navigator.mediaDevices.getDisplayMedia = () => source('remote');
    const mic = createCaptureLeaseOwner(),
      remote = createCaptureLeaseOwner();
    mic.retainCaptureForRecovery(() => {});
    remote.retainCaptureForRecovery(() => {});
    const micLease = mic.leaseCapture({ kind: 'mic', micDistance: 'off' });
    let remoteLease = remote.leaseCapture({ kind: 'system', micDistance: 'off' });
    const local = await micLease.acquire(() => {});
    const shared = await remoteLease.acquire(() => {});
    Object.assign(window, {
      dualCapture: {
        stats: () => ({
          mic: mic.retainedCaptureRange(local),
          remote: remote.retainedCaptureRange(shared),
          counts,
          live: streams
            .flatMap((stream) => stream.getTracks())
            .filter((track) => track.readyState === 'live').length,
        }),
        async stopMicAndReplaceRemote() {
          mic.releaseCaptureRecovery();
          micLease.release();
          remoteLease.release();
          remoteLease = remote.leaseCapture({ kind: 'system', micDistance: 'off' });
          return (await remoteLease.acquire(() => {})) === shared;
        },
        async stop() {
          mic.releaseCaptureRecovery();
          micLease.release();
          remote.releaseCaptureRecovery();
          remoteLease.release();
          await Promise.all(contexts.map((context) => context.close()));
        },
      },
    });
  });
  try {
    await expect
      .poll(() => page.evaluate(() => window.dualCapture.stats().mic?.to ?? 0))
      .toBeGreaterThan(1600);
    await expect
      .poll(() => page.evaluate(() => window.dualCapture.stats().remote?.to ?? 0))
      .toBeGreaterThan(1600);
    const before = await page.evaluate(() => window.dualCapture.stats());
    expect(before.mic?.captureEpoch).not.toBe(before.remote?.captureEpoch);
    expect(await page.evaluate(() => window.dualCapture.stopMicAndReplaceRemote())).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.dualCapture.stats().remote?.to ?? 0))
      .toBeGreaterThan(before.remote!.to + 1600);
    const after = await page.evaluate(() => window.dualCapture.stats());
    expect(after.mic).toBeNull();
    expect(after.counts).toEqual({ mic: 1, remote: 1 });
    expect(after.live).toBe(1);
  } finally {
    await page.evaluate(() => window.dualCapture.stop());
  }
  expect((await page.evaluate(() => window.dualCapture.stats())).live).toBe(0);
});

declare global {
  interface Window {
    dualCapture: {
      stats(): {
        mic: { to: number; captureEpoch: string } | null;
        remote: { to: number; captureEpoch: string } | null;
        counts: { mic: number; remote: number };
        live: number;
      };
      stopMicAndReplaceRemote(): Promise<boolean>;
      stop(): Promise<void>;
    };
  }
}
