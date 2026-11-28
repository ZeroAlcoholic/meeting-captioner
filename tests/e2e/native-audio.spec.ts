import { expect, test, type WebSocketRoute } from '@playwright/test';
import assert from 'node:assert/strict';
import { nativeSoakMinutes, runNativeSoak } from './native-soak.js';

for (const rate of [16000, 48000]) {
  test(`native PCM clock aligns independently started consumers at ${rate} Hz`, async ({
    page,
    context,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.route('**/_pcm-clock-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<button>Start clock check</button>',
      }),
    );
    await page.goto('/_pcm-clock-test');
    await page.getByRole('button').click();
    const result = await page.evaluate(async (sampleRate) => {
      type Chunk = { type: 'pcm'; startFrame: number; pcm: ArrayBuffer };
      const audio = new AudioContext({ sampleRate });
      const source = audio.createOscillator();
      const nodes: AudioWorkletNode[] = [];
      const received: Chunk[][] = [[], []];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await audio.audioWorklet.addModule('/pcm-worklet.js');
        await audio.resume();
        const collect = (index: number, chunkSize: number, count: number) =>
          new Promise<void>((resolve) => {
            const node = new AudioWorkletNode(audio, 'pcm-worklet', {
              processorOptions: { chunkSize, frameMetadata: true },
            });
            nodes.push(node);
            node.port.onmessage = ({ data }: MessageEvent<Chunk>) => {
              if (data.type !== 'pcm') return;
              received[index]!.push(data);
              if (received[index]!.length >= count) resolve();
            };
            source.connect(node);
            node.connect(audio.destination);
          });
        const exercise = async () => {
          const first = collect(0, 512, 3);
          source.start();
          await first;
          // A later provider starts at a different local zero and chunk size.
          await collect(1, 1024, 6);
        };
        await Promise.race([
          exercise(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Native clock probe timed out')), 5000);
          }),
        ]);
        const samples = new Map<number, number>();
        for (const chunk of received[0]!) {
          new Float32Array(chunk.pcm).forEach((value, i) =>
            samples.set(chunk.startFrame + i, value),
          );
        }
        let compared = 0;
        let mismatches = 0;
        let nonzero = 0;
        for (const chunk of received[1]!) {
          new Float32Array(chunk.pcm).forEach((value, i) => {
            const expected = samples.get(chunk.startFrame + i);
            if (expected === undefined) return;
            compared++;
            if (value !== expected) mismatches++;
            if (value !== 0) nonzero++;
          });
        }
        return {
          sampleRate: audio.sampleRate,
          compared,
          mismatches,
          nonzero,
          first: received[0]![0]!.startFrame,
          later: received[1]![0]!.startFrame,
        };
      } finally {
        clearTimeout(timeout);
        source.disconnect();
        for (const node of nodes) {
          node.port.close();
          node.disconnect();
        }
        await audio.close();
      }
    }, rate);
    expect(result.sampleRate).toBe(rate);
    expect(result.later).toBeGreaterThan(result.first);
    expect(result.compared).toBeGreaterThanOrEqual(5120);
    expect(result.nonzero).toBeGreaterThan(5000);
    expect(result.mismatches).toBe(0);
    await test.info().attach('native-pcm-clock.json', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
  });
}

for (const { failFirstWorklet, sampleRate, delayFirstWorklet } of [
  { failFirstWorklet: false, sampleRate: 16000 },
  { failFirstWorklet: true, sampleRate: 16000 },
  { failFirstWorklet: false, sampleRate: 48000 },
  { failFirstWorklet: false, sampleRate: 16000, delayFirstWorklet: true },
]) {
  test(`release sends native worklet PCM and recovers a socket drop (worklet transient=${failFirstWorklet}, rate=${sampleRate}, delayed=${!!delayFirstWorklet})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    let writerHeaders: Record<string, string> | undefined;
    let releaseWorklet!: () => void;
    const captureStarted = new Promise<void>((resolve) => {
      releaseWorklet = resolve;
    });
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
      if (failFirstWorklet) await page.request.post('/_native-test/arm-worklet-failure');
      if (delayFirstWorklet) await page.request.post('/_native-test/arm-worklet-delay');
      let pcmFrames = 0;
      let nonzeroSamples = 0;
      let setups = 0;
      let socket: WebSocketRoute;
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        // Prewarming may otherwise consume most of the injected delay before
        // acquisition starts, so the capture wait would never actually expire.
        if (delayFirstWorklet && url.pathname === '/pcm-worklet.js') await captureStarted;
        if (url.pathname === '/session/info')
          return route.fulfill({
            json: { hasGeminiKey: true, hasApiKey: false, availableProviders: ['gemini'] },
          });
        if (url.pathname === '/session/gemini')
          return route.fulfill({
            json: { token: 'offline-test', model: 'models/gemini-3.5-live-translate-preview' },
          });
        return route.continue();
      });
      await context.routeWebSocket('**/*', (ws) => {
        if (!ws.url().startsWith('wss://generativelanguage.googleapis.com/')) {
          ws.close();
          return;
        }
        socket = ws;
        let ready = false;
        ws.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.setup) {
            setups += 1;
            setTimeout(() => {
              ready = true;
              ws.send(JSON.stringify({ setupComplete: {} }));
            }, 200);
          }
          if (message.realtimeInput?.audio) {
            assert.equal(ready, true, 'PCM frame received before setupComplete (ready=false)');
            const audio = message.realtimeInput.audio;
            assert.equal(
              audio.mimeType,
              `audio/pcm;rate=${sampleRate > 16000 ? 16000 : sampleRate}`,
              `Unexpected PCM MIME type: ${String(audio.mimeType)}`,
            );
            const pcm = Buffer.from(audio.data, 'base64');
            pcmFrames += 1;
            for (let i = 0; i + 1 < pcm.length; i += 2)
              if (pcm.readInt16LE(i) !== 0) nonzeroSamples += 1;
            if (pcmFrames % 10 === 0)
              ws.send(
                JSON.stringify({
                  serverContent: {
                    inputTranscription: { text: `Audio packet ${pcmFrames}.` },
                    outputTranscription: { text: `實際音訊封包 ${pcmFrames}。` },
                    turnComplete: true,
                  },
                }),
              );
          }
        });
      });
      await page.addInitScript(
        ({ sampleRate }) => {
          // Real Chrome AudioContext, Worklet, MediaStream and tracks; only replace
          // physical capture with a deterministic oscillator to avoid recording people.
          let captures = 0;
          const streams: MediaStream[] = [];
          const loads: string[] = [];
          Object.defineProperty(window, '__nativeCapture', {
            value: { streams, loads, count: () => captures },
          });
          const NativeContext = window.AudioContext;
          window.AudioContext = class extends NativeContext {
            constructor(options?: AudioContextOptions) {
              if (sampleRate === 48000 && options?.sampleRate === 16000)
                throw new DOMException('Test hardware requires default rate', 'NotSupportedError');
              super(sampleRate === 48000 ? { ...options, sampleRate: 48000 } : options);
              const load = this.audioWorklet.addModule.bind(this.audioWorklet);
              this.audioWorklet.addModule = (url, options) => {
                loads.push(String(url));
                return load(url, options);
              };
            }
          };
          navigator.mediaDevices.getUserMedia = async () => {
            captures += 1;
            const ctx = new NativeContext({ sampleRate });
            const oscillator = ctx.createOscillator();
            const destination = ctx.createMediaStreamDestination();
            oscillator.connect(destination);
            oscillator.start();
            await ctx.resume();
            streams.push(destination.stream);
            return destination.stream;
          };
        },
        { sampleRate },
      );
      await page.goto('/');
      await page.getByTestId('launch-gemini').click();
      if (delayFirstWorklet) {
        await page.waitForFunction(
          () =>
            (
              window as unknown as { __nativeCapture: { count(): number } }
            ).__nativeCapture.count() === 1,
        );
        releaseWorklet();
        await expect(page.getByTitle('Mic: degraded', { exact: true })).toBeVisible({
          timeout: 7000,
        });
        expect(setups).toBe(0);
        expect(
          await page.evaluate(() =>
            (window as unknown as { __nativeCapture: { count(): number } }).__nativeCapture.count(),
          ),
        ).toBe(1);
      }
      try {
        await expect.poll(() => pcmFrames, { timeout: 12_000 }).toBeGreaterThan(10);
      } finally {
        await test.info().attach('native-audio-evidence', {
          contentType: 'application/json',
          body: JSON.stringify({
            pcmFrames,
            nonzeroSamples,
            setups,
            loaderUrls: await page.evaluate(
              () =>
                (window as unknown as { __nativeCapture: { loads: string[] } }).__nativeCapture
                  .loads,
            ),
            httpWorklet: await (await page.request.get('/_native-test/worklet-count')).json(),
          }),
        });
      }
      expect(nonzeroSamples).toBeGreaterThan(100);
      await expect(page.locator('body')).toContainText('實際音訊封包');
      const initialSetups = setups;
      // Retention now initializes before the cloud session. A local module
      // timeout must recover on the acquired device, without a cloud reconnect.
      expect(initialSetups).toBe(1);
      expect(
        await page.evaluate(() =>
          (window as unknown as { __nativeCapture: { count(): number } }).__nativeCapture.count(),
        ),
      ).toBe(1);
      const before = pcmFrames;
      socket!.close({ code: 1011, reason: 'offline test disconnect' });
      await expect.poll(() => setups).toBe(initialSetups + 1);
      await expect.poll(() => pcmFrames).toBeGreaterThan(before + 10);
      const beforeRotation = pcmFrames;
      socket!.send(JSON.stringify({ goAway: { timeLeft: '2s' } }));
      await expect.poll(() => setups).toBe(initialSetups + 2);
      await expect.poll(() => pcmFrames).toBeGreaterThan(beforeRotation + 10);
      expect(
        await page.evaluate(() =>
          (window as unknown as { __nativeCapture: { count(): number } }).__nativeCapture.count(),
        ),
      ).toBe(1);
      let finishSoak: Awaited<ReturnType<typeof runNativeSoak>> | undefined;
      if (nativeSoakMinutes) {
        let nextRotation = 9 * 60_000;
        let lastFrames = pcmFrames;
        let lastNonzero = nonzeroSamples;
        const startingSetups = setups;
        let soakRotations = 0;
        finishSoak = await runNativeSoak(page, test.info(), {
          provider: 'gemini',
          marker: '實際音訊封包',
          async tick(elapsedMs) {
            if (elapsedMs >= nextRotation) {
              socket!.send(JSON.stringify({ goAway: { timeLeft: '2s' } }));
              soakRotations += 1;
              nextRotation += 9 * 60_000;
            }
          },
          async sample() {
            expect(pcmFrames).toBeGreaterThan(lastFrames);
            expect(nonzeroSamples).toBeGreaterThan(lastNonzero);
            const captures = await page.evaluate(() =>
              (
                window as unknown as { __nativeCapture: { count(): number } }
              ).__nativeCapture.count(),
            );
            expect(captures).toBe(1);
            const sample = {
              pcmFrames,
              nonzeroSamples,
              frameDelta: pcmFrames - lastFrames,
              captures,
              setups,
              renewals: setups - startingSetups,
              soakRotations,
            };
            lastFrames = pcmFrames;
            lastNonzero = nonzeroSamples;
            return sample;
          },
        });
        expect(soakRotations).toBe(Math.floor(nativeSoakMinutes / 9));
        expect(setups - startingSetups).toBe(soakRotations);
      }
      await page.getByTestId('stop-fake-replay').click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as { __nativeCapture: { streams: MediaStream[] } }
              ).__nativeCapture.streams
                .flatMap((s) => s.getTracks())
                .filter((t) => t.readyState === 'live').length,
          ),
        )
        .toBe(0);
      const afterStop = pcmFrames;
      await page.waitForTimeout(500);
      expect(pcmFrames).toBe(afterStop);
      await finishSoak?.({
        liveTracks: 0,
        pcmFramesAfterStop: pcmFrames,
        pcmFramesAtStop: afterStop,
        setups,
      });
      if (failFirstWorklet)
        expect(
          (await (await page.request.get('/_native-test/worklet-count')).json()).requests,
        ).toBeGreaterThan(1);
    } finally {
      releaseWorklet();
      // Stop retains the writer for editing. A completed test must release its
      // own lease before the next independent browser uses this fixture.
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
