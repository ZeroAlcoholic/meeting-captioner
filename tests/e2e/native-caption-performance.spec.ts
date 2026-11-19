import { expect, test } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installOnlineMocks } from './online-mock.js';

interface ProbeSnapshot {
  emitted: number;
  sendMs: number[];
  rafMs: number[];
  longTasks: number[];
  startedAt: number;
  endedAt: number;
  lastSequence: number;
}
declare global {
  interface Window {
    __captionPerf: {
      seed(count: number): void;
      control(): Promise<number[]>;
      start(): void;
      stop(): void;
      snapshot(): ProbeSnapshot;
    };
  }
}

for (const { seededFinals, storageFault } of [
  { seededFinals: 20, storageFault: 'none' },
  { seededFinals: 6000, storageFault: 'none' },
  { seededFinals: 6000, storageFault: 'slow' },
  { seededFinals: 6000, storageFault: 'hang' },
]) {
  test(`production Gemini caption diagnostic: ${seededFinals} preloaded finals, storage ${storageFault}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const stages: Array<Record<string, unknown>> = [];
    const samples: Array<Record<string, unknown>> = [];
    const pageErrors: string[] = [];
    let writerHeaders: Record<string, string> | undefined;
    const faultFile = resolve('.cache/native-audio-release/storage-fault');
    const report: Record<string, unknown> = {
      seededFinals,
      storageFault,
      status: 'running',
      stages,
      samples,
      pageErrors,
      scope:
        'Production provider/store/render with mock capture and transport; no native audio or semantic quality claim',
      longTaskReferenceMs: 50,
    };
    const save = () =>
      writeFile(
        test.info().outputPath('caption-performance.json'),
        JSON.stringify(report, null, 2),
      );
    async function stage<T>(name: string, operation: () => Promise<T>, timeout = 5000): Promise<T> {
      const entry: Record<string, unknown> = {
        name,
        wallMs: Date.now(),
        startedMs: performance.now(),
      };
      stages.push(entry);
      await save();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operationStartedMs = performance.now();
      try {
        const value = await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(name + ' exceeded ' + timeout + 'ms')),
              timeout,
            );
          }),
        ]);
        entry.status = 'completed';
        return value;
      } catch (error) {
        entry.status = 'failed';
        entry.error = String(error);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        entry.durationMs = performance.now() - operationStartedMs;
        await save();
      }
    }
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
      if (pageErrors.length > 20) pageErrors.shift();
    });
    const origin = new URL(baseURL!).origin;
    page.on('request', (request) => {
      const headers = request.headers();
      if (new URL(request.url()).origin === origin && headers['x-meeting-lease']) {
        writerHeaders = {
          origin,
          authorization: headers.authorization,
          'x-meeting-lease': headers['x-meeting-lease'],
        };
      }
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const mock = await installOnlineMocks(page);
    mock.setAvailableProviders(['gemini']);
    await page.addInitScript(() => {
      let sequence = 0;
      let emitted = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let startedAt = 0;
      let endedAt = 0;
      const sendMs: number[] = [];
      const rafMs: number[] = [];
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
          if (longTasks.length > 500) longTasks.shift();
        }
      });
      function send() {
        sequence += 1;
        const before = performance.now();
        const accepted = window.__mock.gemini.send({
          serverContent: {
            inputTranscription: { text: `Audio packet ${sequence * 10}.` },
            outputTranscription: { text: `實際音訊封包 ${sequence * 10}。` },
            turnComplete: true,
          },
        });
        if (!accepted) throw new Error('No active Gemini mock socket');
        return performance.now() - before;
      }
      function stop() {
        if (timer !== undefined) clearInterval(timer);
        if (deadline !== undefined) clearTimeout(deadline);
        if (startedAt && !endedAt) endedAt = performance.now();
        observer.disconnect();
      }
      window.__captionPerf = {
        seed(count) {
          for (let i = 0; i < count; i++) send();
        },
        async control() {
          observer.observe({ entryTypes: ['longtask'] });
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              const until = performance.now() + 100;
              while (performance.now() < until) {
                /* instrumentation positive control */
              }
            }, 0);
            setTimeout(resolve, 250);
          });
          observer.disconnect();
          const seen = [...longTasks];
          longTasks.length = 0;
          return seen;
        },
        start() {
          emitted = 0;
          sendMs.length = 0;
          rafMs.length = 0;
          longTasks.length = 0;
          startedAt = performance.now();
          observer.observe({ entryTypes: ['longtask'] });
          timer = setInterval(() => {
            // Synchronous duration includes provider normalization and store
            // callbacks. React commit/layout are measured separately below.
            sendMs.push(send());
            emitted += 1;
            const at = performance.now();
            requestAnimationFrame(() => rafMs.push(performance.now() - at));
          }, 320);
          deadline = setTimeout(stop, 60_000);
        },
        stop,
        snapshot: () => ({
          emitted,
          sendMs: [...sendMs],
          rafMs: [...rafMs],
          longTasks: [...longTasks],
          startedAt,
          endedAt,
          lastSequence: sequence,
        }),
      };
    });
    let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
    try {
      await stage('navigate', () => page.goto('/'), 10_000);
      report.loadedScripts = await stage('bundle-identity', () =>
        page
          .locator('script[src]')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src)),
      );
      await stage('start-gemini', () => page.getByTestId('launch-gemini').click());
      await stage('socket-ready', () => expect.poll(() => mock.geminiOpenSockets()).toBe(1));
      for (let count = 0; count < seededFinals; count += 100) {
        await stage('seed-' + count, () =>
          page.evaluate(
            (count) => window.__captionPerf.seed(count),
            Math.min(100, seededFinals - count),
          ),
        );
        await page.waitForTimeout(0);
      }
      await stage('seed-visible', () =>
        expect(page.getByTestId('caption-target')).toContainText(String(seededFinals * 10)),
      );
      const control = await stage('longtask-positive-control', () =>
        page.evaluate(() => window.__captionPerf.control()),
      );
      report.longTaskControl = control;
      expect(control.some((duration) => duration > 50)).toBe(true);
      cdp = await stage('cdp-attach', () => context.newCDPSession(page));
      await stage('performance-enable', () => cdp!.send('Performance.enable'));
      const metricNames = new Set([
        'ScriptDuration',
        'LayoutDuration',
        'RecalcStyleDuration',
        'TaskDuration',
        'JSHeapUsedSize',
        'Nodes',
      ]);
      const metrics = async () =>
        Object.fromEntries(
          (await cdp!.send('Performance.getMetrics')).metrics
            .filter((metric: { name: string }) => metricNames.has(metric.name))
            .map((metric: { name: string; value: number }) => [metric.name, metric.value]),
        );
      report.initialMetrics = await stage('metrics-before', metrics);
      if (storageFault !== 'none') {
        await rm(faultFile + '.log', { force: true });
        await writeFile(faultFile, storageFault);
      }
      await stage('drive-start', () => page.evaluate(() => window.__captionPerf.start()));
      const driveStarted = Date.now();
      while (Date.now() - driveStarted < 60_000) {
        await page.waitForTimeout(5000);
        const sample: Record<string, unknown> = { elapsedMs: Date.now() - driveStarted };
        samples.push(sample);
        sample.probe = await stage('probe', () =>
          page.evaluate(() => window.__captionPerf.snapshot()),
        );
        sample.live = await stage('live-innerText', () =>
          page.getByTestId('caption-target').innerText({ timeout: 4000 }),
        );
        sample.liveLocatorMs = stages.at(-1)?.durationMs;
        const history = await stage('history-innerText', () =>
          page.getByTestId('caption-history').innerText({ timeout: 4000 }),
        );
        sample.historyLocatorMs = stages.at(-1)?.durationMs;
        sample.historyChars = history.length;
        sample.historyTail = history.slice(-300);
        sample.dom = await stage('dom-snapshot', () =>
          page.evaluate(() => {
            const live = document.querySelector('[data-testid="caption-target"]');
            const history = document.querySelector('[data-testid="caption-history"]');
            return {
              liveMatches: document.querySelectorAll('[data-testid="caption-target"]').length,
              historyMatches: document.querySelectorAll('[data-testid="caption-history"]').length,
              historyNodes: history?.querySelectorAll('*').length,
              totalNodes: document.querySelectorAll('*').length,
              live: live?.textContent,
              historyTail: history?.textContent?.slice(-300),
            };
          }),
        );
        sample.metrics = await stage('metrics-sample', metrics);
        await save();
      }
      const final = await stage('drive-final', () =>
        page.evaluate(() => {
          window.__captionPerf.stop();
          return window.__captionPerf.snapshot();
        }),
      );
      report.final = final;
      report.longTasksOver50ms = final.longTasks.filter((duration) => duration > 50);
      if (storageFault !== 'none') {
        await rm(faultFile, { force: true });
        const faults = (await readFile(faultFile + '.log', 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { mode: string; at: number });
        report.injectedFaults = faults;
        expect(faults.length).toBeGreaterThan(0);
        expect(faults.every((fault) => fault.mode === storageFault)).toBe(true);
        if (storageFault === 'hang') expect(faults).toHaveLength(1);
      }
      expect(final.emitted).toBeGreaterThan(0);
      expect(final.endedAt - final.startedAt).toBeGreaterThanOrEqual(60_000);
      await stage('final-visible', () =>
        expect(page.getByTestId('caption-target')).toContainText(String(final.lastSequence * 10)),
      );
      await stage('stop-gemini', () => page.getByTestId('stop-fake-replay').click());
      await stage('capture-released', () => expect.poll(() => mock.activeCaptureTracks()).toBe(0));
      await stage('export-menu', () => page.getByTestId('export-menu-toggle').click());
      const download = await stage('export-json', async () => {
        const pending = page.waitForEvent('download', { timeout: 4000 });
        await page.getByTestId('export-json').click();
        return pending;
      });
      const downloadPath = await stage('export-path', () => download.path());
      if (!downloadPath) throw new Error('Export download has no local path');
      const exported = JSON.parse(await readFile(downloadPath, 'utf8')) as {
        segments: Array<{ segmentId: string }>;
      };
      report.exportedCount = exported.segments.length;
      report.uniqueSegmentIds = new Set(exported.segments.map((segment) => segment.segmentId)).size;
      expect(exported.segments.length).toBe(seededFinals + final.emitted);
      expect(report.uniqueSegmentIds).toBe(exported.segments.length);
      // Diagnostic result, not a newly invented performance acceptance threshold.
      report.status = 'measured';
    } catch (error) {
      report.status = 'failed';
      report.error = String(error);
      throw error;
    } finally {
      await rm(faultFile, { force: true });
      await save();
      if (!page.isClosed())
        await stage('probe-cleanup', () => page.evaluate(() => window.__captionPerf?.stop())).catch(
          () => {},
        );
      if (cdp) await stage('cdp-detach', () => cdp!.detach()).catch(() => {});
      // Browser contexts are independent writers. Stop this page's renewals and
      // release its actual lease so the next case does not inherit a live owner.
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
