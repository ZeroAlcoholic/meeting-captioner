import { expect, test } from '@playwright/test';
import { installOnlineMocks, type OnlineMockController } from './online-mock.js';

/**
 * 數字② — no main-thread task over 50 ms while captions are streaming
 * (contract: docs/PHASE_2_RUN.md, target: docs/GOAL_PHASE_2.md section B).
 *
 * A stall on this path is not a slow frame somewhere; it is the caption board
 * freezing mid-sentence in front of a room.
 *
 * Instrument: PerformanceObserver on 'longtask', which is the browser's own
 * definition of a task that blocked the main thread past 50 ms — the same
 * measurement DevTools shows, taken by the page instead of by eye. Recorded in
 * a REAL Chromium, on the real caption pipeline: only the transport is mocked,
 * so the store, the React tree and both persistence paths all run for real.
 *
 * Honest result, recorded because it contradicts the reason this test was
 * written: at this load the storage writes B1/B2 moved off the caption path
 * produced no long task either BEFORE or after that change. The "stall" the B
 * section set out to fix was inferred from synchronous I/O sitting on the event
 * path, never measured, and it does not reproduce. See the postmortem in
 * docs/PHASE_2_RUN.md. This test stands as the guarantee going forward, not as
 * evidence that something was repaired.
 *
 * What this is NOT: ten minutes of real speech through a real backend. Real
 * audio arrives with jitter this harness does not reproduce, and real network
 * timing could land work differently.
 */

/** Long enough to cross several of the monitor's 15 s persist windows. */
const DRIVE_MS = 90_000;
/** ~10 caption deltas a second — the cadence a streaming translation arrives at. */
const DELTA_INTERVAL_MS = 100;
/** Finalize a segment every ~5 s, so history grows and the store writes. */
const DELTAS_PER_SEGMENT = 50;
/** The browser's own long-task threshold. */
const LONG_TASK_MS = 50;
/**
 * Segments already in the transcript before the run starts.
 *
 * Duration alone does not reproduce the risk. Both writes serialize the WHOLE
 * transcript, so their cost scales with how much has been said, not with how
 * long the observer has been watching — ninety seconds from an empty board is a
 * handful of segments and a trivially cheap write. A meeting two hours in is
 * where a write could block the main thread, so that is the state to measure.
 * This is the localStorage tail cap, i.e. the largest payload the app will ever
 * write, reached by any genuinely long meeting.
 */
const SEEDED_SEGMENTS = 2_000;

declare global {
  interface Window {
    __longTasks: number[];
    __longTaskObserver: PerformanceObserver;
  }
}

let mock: OnlineMockController;

test.beforeEach(async ({ page }) => {
  mock = await installOnlineMocks(page);
});

test.describe('數字② — main-thread stalls while captioning', () => {
  test.setTimeout(DRIVE_MS + 120_000);

  test('sustained captioning produces no task over 50 ms', async ({ page }) => {
    // Start the app already holding a long meeting's worth of transcript, so
    // every persistence write serializes a realistic payload rather than a
    // near-empty one.
    await page.addInitScript((count: number) => {
      // Retention has to be ON at boot, not toggled afterwards: with it off the
      // app purges stored transcripts on start, so a seed written here would be
      // deleted before the store ever loaded it — and the run would measure an
      // empty transcript while looking like it measured a full one.
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          scenarioId: 'physical',
          modeId: 'online_full',
          langPair: 'en→zh-TW',
          audioSource: 'mic',
          includeSourceTranscript: true,
          transcriptRetentionEnabled: true,
          micDistance: 'meeting',
          onlineProvider: 'openai',
        }),
      );
      const segments = Array.from({ length: count }, (_, i) => ({
        segmentId: `seed-${i}`,
        provider: 'openai-realtime',
        mode: 'online_full',
        source: 'microphone',
        status: 'final',
        text: `Seeded utterance number ${i} about quarterly revenue and headcount planning.`,
        startMs: i * 1000,
      }));
      const translations: Record<string, unknown> = {};
      for (const segment of segments) {
        translations[segment.segmentId] = {
          provider: 'openai-realtime',
          mode: 'online_full',
          sourceSegmentId: segment.segmentId,
          status: 'final',
          sourceText: segment.text,
          targetText: `第 ${segment.segmentId} 段關於本季營收與人力規劃的逐字稿內容。`,
          sourceLanguage: 'en',
          targetLanguage: 'zh-TW',
          updatedAt: new Date().toISOString(),
        };
      }
      localStorage.setItem(
        'meeting-audio:captions:v4',
        JSON.stringify({
          v: 4,
          segments,
          translations,
          sessionStartMs: Date.now() - count * 1000,
          sessionId: 'seeded-session',
          sessionEndedAt: null,
          sessionMode: 'real',
          sessionPhase: 'ended',
          savedAt: new Date().toISOString(),
        }),
      );
    }, SEEDED_SEGMENTS);

    await page.goto('/');

    // The seeded transcript really did load — otherwise every write below would
    // serialize almost nothing and the measurement would prove nothing.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                JSON.parse(localStorage.getItem('meeting-audio:captions:v4') ?? '{}') as {
                  segments?: unknown[];
                }
              ).segments?.length ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(SEEDED_SEGMENTS);

    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    // Arm AFTER startup: bring-up cost is a different question from whether a
    // running meeting stutters, and folding them together would hide both.
    await page.evaluate(() => {
      window.__longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ['longtask'] });
      // Hold the reference. An observer with no live reference can be collected,
      // and a collected observer reports nothing — which reads exactly like a
      // main thread that never stalled.
      window.__longTaskObserver = observer;
    });

    // Prove the instrument works before trusting a zero from it. A dead
    // observer and a perfectly smooth main thread produce identical output, so
    // without this the test could pass forever while measuring nothing.
    // The block must be scheduled as an ordinary page task. Code run straight
    // through the automation channel is not attributed as a long task, so
    // blocking inline here would produce a false "instrument is broken".
    const control = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          setTimeout(() => {
            const until = performance.now() + 150;
            while (performance.now() < until) {
              /* deliberately block the main thread */
            }
          }, 0);
          setTimeout(() => {
            const seen = [...window.__longTasks];
            window.__longTasks = [];
            resolve(seen);
          }, 400);
        }),
    );
    expect(control.some((duration) => duration > 50)).toBe(true);

    // Drive the whole run from inside the page. Emitting from Node would put a
    // round-trip between every delta, which both slows the cadence and adds
    // idle gaps the real thing does not have — the browser would look calmer
    // than it is.
    await page.evaluate(
      async ({ durationMs, intervalMs, perSegment }) => {
        const deadline = performance.now() + durationMs;
        let emitted = 0;
        while (performance.now() < deadline) {
          window.__mock.oai.emit({
            type: 'session.input_transcript.delta',
            delta: 'quarterly revenue ',
          });
          window.__mock.oai.emit({
            type: 'session.output_transcript.delta',
            delta: '本季營收',
          });
          emitted += 1;
          if (emitted % perSegment === 0) {
            window.__mock.oai.emit({ type: 'response.output_audio_transcript.done' });
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return emitted;
      },
      { durationMs: DRIVE_MS, intervalMs: DELTA_INTERVAL_MS, perSegment: DELTAS_PER_SEGMENT },
    );

    // Captions are still live at the end — a frozen board would produce no long
    // tasks either, and would pass a test that only counted stalls.
    await mock.oaiOutput('最後一句。');
    await expect(page.getByTestId('caption-target')).toContainText('最後一句。', {
      timeout: 5_000,
    });

    const longTasks = await page.evaluate(() =>
      window.__longTasks
        .filter((duration) => duration > 50)
        .map((duration) => Math.round(duration)),
    );

    const line =
      longTasks.length === 0
        ? `0 個 > ${LONG_TASK_MS} ms 長任務（驅動 ${DRIVE_MS / 1000} s）`
        : `${longTasks.length} 個長任務: ${longTasks.join(', ')} ms`;
    console.info(`[數字②] ${line}`);
    await test.info().attach('數字②', { body: line, contentType: 'text/plain' });

    expect(longTasks).toEqual([]);
  });
});
