import { expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const rawMinutes = process.env.NATIVE_SOAK_MINUTES ?? '0';
export const nativeSoakMinutes = Number(rawMinutes);
if (
  !/^\d+$/.test(rawMinutes) ||
  !Number.isInteger(nativeSoakMinutes) ||
  nativeSoakMinutes < 0 ||
  nativeSoakMinutes > 120
)
  throw new Error('NATIVE_SOAK_MINUTES must be 0 (disabled) or an integer from 1 to 120');

type Sample = Record<string, number | string | boolean>;
/** Real wall-clock sampling. Synthetic text tests transport/render progress only. */
export async function runNativeSoak(
  page: Page,
  info: TestInfo,
  options: {
    provider: string;
    tick(elapsedMs: number): Promise<void>;
    sample(recordRaw: (raw: unknown) => Promise<void>): Promise<Sample>;
    snapshot?(): Promise<unknown>;
    marker: string;
  },
): Promise<(stopped: Sample) => Promise<void>> {
  const startedAt = Date.now();
  const durationMs = nativeSoakMinutes * 60_000;
  const samples: Sample[] = [];
  let loadedScripts: string[] = [];
  let cdp: CDPSession | undefined;
  const stages: Array<Record<string, unknown>> = [];
  // Fixed stage names bound this aggregate independently of soak duration.
  const stageTotals: Record<string, { count: number; maxOperationMs: number }> = {};
  let lastStage: Record<string, unknown> | undefined;
  async function runStage<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const entry: Record<string, unknown> = {
      name,
      status: 'running',
      startWallMs: Date.now(),
      startMonotonicMs: performance.now(),
    };
    lastStage = entry;
    stages.push(entry);
    if (stages.length > 200) stages.shift();
    const saveStage = () =>
      writeFile(info.outputPath('native-soak-stage.json'), JSON.stringify(entry, null, 2));
    // Persist the pending operation before awaiting browser/transport work.
    await saveStage();
    const operationStartedMs = performance.now();
    entry.operationStartedMs = operationStartedMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(name + ' exceeded 10000ms local deadline')),
            10_000,
          );
        }),
      ]);
      entry.status = 'completed';
      return value;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      entry.endWallMs = Date.now();
      entry.endMonotonicMs = performance.now();
      entry.durationMs = Number(entry.endMonotonicMs) - Number(entry.startMonotonicMs);
      const operationDurationMs = Number(entry.endMonotonicMs) - operationStartedMs;
      entry.operationDurationMs = operationDurationMs;
      const aggregate = stageTotals[name] ?? { count: 0, maxOperationMs: 0 };
      aggregate.count += 1;
      aggregate.maxOperationMs = Math.max(aggregate.maxOperationMs, operationDurationMs);
      stageTotals[name] = aggregate;
      await saveStage();
    }
  }
  let previousVisible = -1;
  let previousHistory = -1;
  let previousSampleMs = 0;
  let maxSampleGapMs = 0;
  let nextSample = 15_000;
  let nextWrite = 60_000;
  let status = 'running';
  let stopEvidence: Sample | undefined;
  let rawSample: unknown;
  const recordRaw = async (raw: unknown) => {
    rawSample = raw;
    await writeFile(
      info.outputPath('native-soak-snapshot.json'),
      JSON.stringify(
        {
          stage: 'before-sample-assertions',
          wallMs: Date.now(),
          monotonicMs: performance.now(),
          elapsedMs: Date.now() - startedAt,
          rawSample,
        },
        null,
        2,
      ),
    );
  };
  const persist = () =>
    writeFile(
      info.outputPath('native-soak.json'),
      JSON.stringify(
        {
          provider: options.provider,
          requestedMinutes: nativeSoakMinutes,
          loadedScripts,
          startedAt: new Date(startedAt).toISOString(),
          observedUntil: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          status,
          manualRecoveryActions: 0,
          scope:
            'Native audio and synthetic transport/render progress; no cloud semantics or external ICE/NAT validation',
          samples,
          maxSampleGapMs,
          stopEvidence,
          lastStage,
          stages,
          stageTotals,
        },
        null,
        2,
      ),
    );
  await persist();
  try {
    loadedScripts = await runStage('bundle-identity', () =>
      page
        .locator('script[src]')
        .evaluateAll((elements) => elements.map((element) => (element as HTMLScriptElement).src)),
    );
    cdp = await runStage('cdp-attach', () => page.context().newCDPSession(page));
    await runStage('cdp-enable', () => cdp!.send('Performance.enable'));
    while (Date.now() - startedAt < durationMs) {
      await runStage('tick-wait', () =>
        page.waitForTimeout(Math.max(0, Math.min(1000, durationMs - (Date.now() - startedAt)))),
      );
      const elapsed = Date.now() - startedAt;
      await runStage('tick', () => options.tick(elapsed));
      if (elapsed >= nextSample || elapsed >= durationMs) {
        const sampleGapMs = elapsed - previousSampleMs;
        maxSampleGapMs = Math.max(maxSampleGapMs, sampleGapMs);
        expect(
          sampleGapMs,
          'continuous observation cannot include sleep or missing intervals',
        ).toBeLessThanOrEqual(30_000);
        previousSampleMs = elapsed;
        const audio = await runStage('audio-sample', () => options.sample(recordRaw));
        const visible = await runStage('live-innerText', () =>
          page.getByTestId('caption-target').innerText({ timeout: 10_000 }),
        );
        const history = await runStage('history-innerText', () =>
          page.getByTestId('caption-history').innerText({ timeout: 10_000 }),
        );
        const latest = (text: string) =>
          Math.max(
            -1,
            ...Array.from(text.matchAll(new RegExp(options.marker + '\\s+(\\d+)', 'g')), (match) =>
              Number(match[1]),
            ),
          );
        const visibleSequence = latest(visible);
        const historySequence = latest(history);
        expect(visibleSequence, 'live caption progresses during real wall time').toBeGreaterThan(
          previousVisible,
        );
        expect(
          historySequence,
          'finalized history progresses during real wall time',
        ).toBeGreaterThan(previousHistory);
        previousVisible = visibleSequence;
        previousHistory = historySequence;
        const metrics = await runStage('cdp-metrics', () => cdp!.send('Performance.getMetrics'));
        const heap = metrics.metrics.find(
          (metric: { name: string }) => metric.name === 'JSHeapUsedSize',
        )?.value;
        samples.push({
          elapsedMs: elapsed,
          ...audio,
          visibleSequence,
          historySequence,
          ...(heap === undefined ? {} : { jsHeapUsedBytes: heap }),
        });
        // Maximum 481 samples for the 120-minute opt-in upper bound.
        if (samples.length > 481) samples.shift();
        nextSample += 15_000;
      }
      if (elapsed >= nextWrite) {
        await persist();
        console.info('[native-soak]', options.provider, JSON.stringify(samples.at(-1)));
        nextWrite += 60_000;
      }
    }
    expect(samples.length, 'all 15-second observation intervals are required').toBe(
      nativeSoakMinutes * 4,
    );
    status = 'duration-observed-awaiting-stop';
    await persist();
  } catch (error) {
    status = 'failed';
    stopEvidence = { error: error instanceof Error ? error.message : String(error) };
    const failedStage = lastStage;
    await persist();
    // Capture before the caller's finally closes peers; diagnostics must not
    // replace the original assertion or wait indefinitely for a frozen browser.
    let failureSnapshot: unknown;
    if (options.snapshot) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        failureSnapshot = await Promise.race([
          options.snapshot(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Failure snapshot timed out after 2s')),
              2000,
            );
          }),
        ]);
      } catch (snapshotError) {
        failureSnapshot = {
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    await writeFile(
      info.outputPath('native-soak-failure.json'),
      JSON.stringify(
        {
          stage: 'catch-before-cleanup',
          wallMs: Date.now(),
          monotonicMs: performance.now(),
          elapsedMs: Date.now() - startedAt,
          error: stopEvidence.error,
          rawSample,
          failureSnapshot,
          failedStage,
          stages,
          stageTotals,
        },
        null,
        2,
      ),
    );
    await persist();
    throw error;
  } finally {
    if (cdp)
      await runStage('cdp-detach', () => cdp!.detach()).catch((error) => {
        if (status !== 'failed') throw error;
      });
  }
  return async (stopped) => {
    stopEvidence = stopped;
    status = 'passed';
    await persist();
  };
}
