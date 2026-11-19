import { expect, test } from '@playwright/test';
import { storageFixture } from './storage-fixture.js';

let archive: Awaited<ReturnType<typeof storageFixture>> | undefined;
test.afterEach(async ({ page }) => {
  await page.close();
  await archive?.app.close();
  await archive?.repository.close();
  archive = undefined;
});

for (const { rate, seconds } of [
  { rate: 16000, seconds: 3 },
  { rate: 48000, seconds: 3 },
  { rate: 16000, seconds: 10 },
  { rate: 16000, seconds: 30 },
  { rate: 16000, seconds: 90 },
  { rate: 48000, seconds: 90 },
]) {
  test(`native capture retains PCM through a consumer gap and clears on Stop (${rate}Hz, ${seconds}s)`, async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout((seconds + 20) * 1000);
    const origin = new URL(baseURL!).origin;
    if (seconds === 90) archive = await storageFixture([origin]);
    await context.route('**/*', async (route) => {
      const target = new URL(route.request().url());
      if (target.origin === origin) return route.continue();
      if (
        !archive ||
        (!target.pathname.startsWith('/meetings') && target.pathname !== '/local/bootstrap')
      )
        return route.abort();
      const headers = {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization,content-type,x-meeting-lease',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const response = await route.fetch({ url: archive.url + target.pathname + target.search });
      return route.fulfill({ response, headers: { ...response.headers(), ...headers } });
    });
    if (seconds !== 90)
      await page.route(origin + '/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<button>Start local capture test</button>',
        }),
      );
    if (rate === 48000)
      await page.addInitScript(() => {
        const NativeContext = window.AudioContext;
        window.AudioContext = class extends NativeContext {
          constructor(options?: AudioContextOptions) {
            if (options?.sampleRate === 16000)
              throw new DOMException('Default rate required', 'NotSupportedError');
            super({ ...options, sampleRate: 48000 });
          }
        };
      });
    await page.goto('/');
    if (seconds === 90)
      await page
        .getByRole('button', {
          name: rate === 16000 ? '純字幕（繁中＋原文）' : '即時翻譯',
          exact: true,
        })
        .click();
    else await page.getByRole('button').click();
    const result = await page.evaluate(
      async ({ rate, seconds }) => {
        const path = '/src/providers/capture-lease.ts';
        const {
          leaseCapture,
          retainCaptureForRecovery,
          releaseCaptureRecovery,
          retainedCaptureRange,
          readCapturedAudio,
          captureRangeForNativeFrames,
          __resetCaptureLeaseForTests,
        } = await import(/* @vite-ignore */ path);
        const NativeContext = window.AudioContext;
        const NativeWorklet = window.AudioWorkletNode;
        let nativeOrigin: number | null = null;
        let captureClock: AudioContext | null = null;
        window.AudioWorkletNode = class extends NativeWorklet {
          constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(context, name, options);
            if (options?.processorOptions?.frameMetadata) {
              this.port.addEventListener('message', ({ data }: MessageEvent) => {
                if (
                  data?.type === 'pcm' &&
                  nativeOrigin === null &&
                  context instanceof NativeContext
                ) {
                  nativeOrigin = data.startFrame;
                  captureClock = context;
                }
              });
            }
          }
        };
        const contexts: AudioContext[] = [];
        const streams: MediaStream[] = [];
        let acquisitions = 0;
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        if (rate === 48000)
          window.AudioContext = class extends NativeContext {
            constructor(options?: AudioContextOptions) {
              if (options?.sampleRate === 16000)
                throw new DOMException('Default rate required', 'NotSupportedError');
              super({ ...options, sampleRate: 48000 });
            }
          };
        navigator.mediaDevices.getUserMedia = async () => {
          acquisitions++;
          const source = new NativeContext({ sampleRate: rate });
          contexts.push(source);
          const oscillator = source.createOscillator();
          const destination = source.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await source.resume();
          streams.push(destination.stream);
          return destination.stream;
        };
        const spec = { kind: 'mic', micDistance: 'meeting' };
        const enginePath = '/src/providers/audio-engine.ts';
        const { getCaptureContext } = await import(/* @vite-ignore */ enginePath);
        let meetingArchive:
          | import('../../apps/web/src/store/meeting-archive-client.js').MeetingArchiveClient
          | undefined;
        let onHealth = (_event: unknown) => {};
        let drive: ReturnType<typeof setInterval> | undefined;
        let emittedCaptions = 0;
        let emitCaption = () => {};
        let savedCaptionIds: string[] = [];
        let overflowUpdates = 0;
        let lossBeforeReclaim: { from: number; to: number } | null = null;
        if (seconds === 90) {
          const archivePath = '/src/store/meeting-archive.ts';
          const handlersPath = '/src/providers/coalesce-handlers.ts';
          ({ meetingArchive } = await import(/* @vite-ignore */ archivePath));
          const { applyCaptureHealth, createStoreBoundHandlers } = await import(
            /* @vite-ignore */ handlersPath
          );
          const storePath = '/src/store/use-caption-store.ts';
          const { captionStore } = await import(/* @vite-ignore */ storePath);
          const meetingId = crypto.randomUUID();
          captionStore.setState({ sessionId: meetingId });
          await meetingArchive.startMeeting({
            meetingId,
            title: 'Native retention loss',
            createdAt: new Date().toISOString(),
            captionTask:
              rate === 16000
                ? {
                    purpose: 'transcription',
                    inputLanguages: ['zh-tw', 'en'],
                    textPolicy: 'zh-TW-preserve-original',
                  }
                : { purpose: 'translation', langPair: 'en→zh-TW' },
          });
          captionStore.setState({ captionTask: meetingArchive.getCurrentMeeting().captionTask });
          const handlers = createStoreBoundHandlers({
            archive: meetingArchive.bindCurrentMeeting(),
          });
          emitCaption = () => {
            const sequence = emittedCaptions++;
            const segmentId = `retention-load-${sequence}`;
            handlers.onTranscript({
              kind: 'transcript',
              provider: 'controlled-load',
              mode: 'online_full',
              source: 'microphone',
              segmentId,
              status: 'final',
              text: `Native caption ${sequence}`,
              startMs: sequence * 100,
            });
            handlers.onTranslation({
              kind: 'translation',
              provider: 'controlled-load',
              mode: 'online_full',
              sourceSegmentId: segmentId,
              status: 'final',
              sourceText: `Native caption ${sequence}`,
              targetText: `收音負載字幕 ${sequence}`,
              sourceLanguage: 'en',
              targetLanguage: 'zh-TW',
              updatedAt: new Date().toISOString(),
            });
          };
          for (let i = 0; i < 2000; i++) {
            emitCaption();
            if (i % 100 === 99) await new Promise((resolve) => setTimeout(resolve, 0));
          }
          await meetingArchive.flushPending();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const seedText = rate === 16000 ? 'Native caption 1999' : '收音負載字幕 1999';
          if (!document.body.textContent?.includes(seedText))
            throw new Error('Seed captions did not render');
          onHealth = (event) => {
            const health =
              event as import('../../packages/contracts/src/health-event.js').HealthEvent;
            if (health.retentionGap) {
              overflowUpdates++;
              lossBeforeReclaim = health.retentionGap;
            }
            applyCaptureHealth(health, meetingArchive);
          };
        }
        try {
          retainCaptureForRecovery(onHealth);
          const first = leaseCapture(spec);
          const stream = await first.acquire(() => {});
          const deadline = performance.now() + 5000;
          while (!retainedCaptureRange(stream)) {
            if (performance.now() > deadline) throw new Error('No retained native PCM');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          observer.observe({ entryTypes: ['longtask'] });
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              const end = performance.now() + 100;
              while (performance.now() < end) {
                /* positive control */
              }
            }, 0);
            setTimeout(resolve, 250);
          });
          const positiveControl = longTasks.some((ms) => ms > 50);
          longTasks.length = 0;
          const before = retainedCaptureRange(stream);
          const started = performance.now();
          if (seconds === 90) drive = setInterval(emitCaption, 100);
          first.release();
          while (retainedCaptureRange(stream).to - before.to < seconds * 16000) {
            if (performance.now() - started > (seconds + 5) * 1000)
              throw new Error('Captured sample clock failed to advance during consumer gap');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          clearInterval(drive);
          const after = retainedCaptureRange(stream);
          const elapsedMs = performance.now() - started;
          observer.disconnect();
          const data = readCapturedAudio(stream, { ...after, from: before.to });
          if (nativeOrigin === null || !captureClock)
            throw new Error('Native source clock missing');
          const nativeFrom = nativeOrigin + (before.to * rate) / 16000;
          const nativeTo = nativeOrigin + (after.to * rate) / 16000;
          const mappedGap = captureRangeForNativeFrames(stream, captureClock, nativeFrom, nativeTo);
          const reportedWhileParked = lossBeforeReclaim;
          const noticeWhileParked = document.querySelector(
            '[data-testid="retention-gap-notice"]',
          )?.textContent;
          const stopWithoutReclaim = seconds === 90 && rate === 48000;
          const next = leaseCapture(spec);
          let same: boolean | null = null;
          if (stopWithoutReclaim) releaseCaptureRecovery();
          else same = (await next.acquire(() => {})) === stream;
          const capturesDuringHandoff = acquisitions;
          let savedGaps: unknown[] = [];
          if (meetingArchive) {
            await meetingArchive.finalize();
            const json = JSON.parse(
              await (
                await meetingArchive.exportMeeting(
                  meetingArchive.getCurrentMeeting().meetingId,
                  'corrected',
                  'json',
                )
              ).text(),
            );
            savedGaps = json.metadata.manifest.gaps;
            savedCaptionIds = json.segments.map((s: { segmentId: string }) => s.segmentId);
          }
          releaseCaptureRecovery();
          next.release();
          const cleared = retainedCaptureRange(stream) === null;
          const clearedMapping = captureRangeForNativeFrames(
            stream,
            captureClock,
            nativeFrom,
            nativeTo,
          );
          const ended = stream.getAudioTracks().every((t) => t.readyState === 'ended');
          const restart = leaseCapture(spec);
          const fresh = await restart.acquire(() => {});
          await new Promise((resolve) => setTimeout(resolve, 200));
          const freshRange = retainedCaptureRange(fresh);
          restart.release();
          const savedIds = new Set(savedCaptionIds);
          return {
            before,
            after,
            mappedGap,
            clearedMapping,
            reportedWhileParked,
            noticeWhileParked,
            overflowUpdates,
            emittedCaptions,
            savedCaptionCount: savedCaptionIds.length,
            savedAllCaptions:
              savedCaptionIds.length === emittedCaptions &&
              Array.from({ length: emittedCaptions }, (_, i) => `retention-load-${i}`).every((id) =>
                savedIds.has(id),
              ),
            stopWithoutReclaim,
            captureSampleRate: getCaptureContext().sampleRate,
            seconds,
            elapsedMs,
            positiveControl,
            longTasks,
            same,
            capturesDuringHandoff,
            cleared,
            ended,
            retainedSamples: data.frames.reduce(
              (n: number, f: { pcm: Float32Array }) => n + f.pcm.length,
              0,
            ),
            nonzero: data.frames.some((f: { pcm: Float32Array }) =>
              f.pcm.some((v) => Math.abs(v) > 0.001),
            ),
            missing: data.missing,
            savedGaps,
            newEpoch: freshRange?.captureEpoch !== before.captureEpoch,
          };
        } finally {
          clearInterval(drive);
          observer.disconnect();
          __resetCaptureLeaseForTests();
          streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
          await Promise.all(contexts.map((c) => c.close()));
          window.AudioContext = NativeContext;
          window.AudioWorkletNode = NativeWorklet;
        }
      },
      { rate, seconds },
    );
    expect(result.same).toBe(result.stopWithoutReclaim ? null : true);
    expect(result.captureSampleRate).toBe(rate);
    expect(result.capturesDuringHandoff).toBe(1);
    expect(result.after.captureEpoch).toBe(result.before.captureEpoch);
    expect(result.mappedGap).toEqual({ ...result.after, from: result.before.to });
    expect(result.clearedMapping).toBeNull();
    expect(result.after.to - result.before.to).toBeGreaterThanOrEqual(seconds * 16000);
    expect(result.retainedSamples).toBe(Math.min(result.after.to - result.before.to, 60 * 16000));
    expect(result.positiveControl).toBe(true);
    expect(result.longTasks.filter((ms) => ms > 50)).toEqual([]);
    expect(result.nonzero).toBe(true);
    expect(result.missing).toEqual(
      seconds > 60
        ? [
            {
              trackId: result.before.trackId,
              captureEpoch: result.before.captureEpoch,
              from: result.before.to,
              to: result.after.from,
            },
          ]
        : [],
    );
    expect(result.cleared && result.ended && result.newEpoch).toBe(true);
    if (seconds === 90) {
      expect(result.emittedCaptions).toBeGreaterThan(2800);
      expect(result.savedCaptionCount).toBe(result.emittedCaptions);
      expect(result.savedAllCaptions).toBe(true);
      await expect(page.locator('body')).toContainText(
        rate === 16000
          ? `Native caption ${result.emittedCaptions - 1}`
          : `收音負載字幕 ${result.emittedCaptions - 1}`,
      );
      expect(result.reportedWhileParked).toMatchObject({ from: result.before.to });
      expect(result.noticeWhileParked).toContain('暫存音訊已覆寫');
      expect(result.overflowUpdates).toBeGreaterThan(1);
      expect(result.overflowUpdates).toBeLessThanOrEqual(32);
      await expect(page.getByTestId('retention-gap-notice')).toContainText('暫存音訊已覆寫');
      expect(result.savedGaps).toEqual([
        expect.objectContaining({
          trackId: result.before.trackId,
          captureEpoch: result.before.captureEpoch,
          startSample: result.before.to,
          endSample: result.after.from,
          sampleRate: 16000,
          state: 'unrecoverable',
          alignment: 'exact_capture_range',
        }),
      ]);
    }
    console.info('[native-retention]', JSON.stringify(result));
  });
}
