import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const FRAMES = 30_000;
const BATCH_SIZE = 1000;
const SAMPLE_RATE = 16_000;
type DiagnosticInfo = {
  _stepMap?: Map<string, unknown>;
  _steps?: unknown[];
  _parentStep?: () => { stepId?: string; category?: string } | undefined;
};

// Identical checks and inputs; only Playwright's per-frame reporting differs.
// Timer callbacks model the asynchronous delivery site of WebSocketRoute.onMessage.
// This probe does not claim to reproduce WebSocket transport itself.
for (const mode of ['per-frame-expect', 'plain-check', 'strict-node'] as const) {
  test(`asynchronous PCM check reporting: ${mode}`, async ({ browserName }, info) => {
    const diagnostic = info as unknown as DiagnosticInfo;
    const stepCount = () => diagnostic._stepMap?.size ?? null;
    const batches: Array<Record<string, unknown>> = [];
    const started = performance.now();
    let frames = 0;
    let violations = 0;
    let status = 'running';
    let failure: string | undefined;
    const save = () =>
      writeFile(
        info.outputPath('assertion-reporting.json'),
        JSON.stringify(
          {
            mode,
            browserName,
            status,
            frames,
            violations,
            requestedFrames: FRAMES,
            batchSize: BATCH_SIZE,
            elapsedMs: performance.now() - started,
            steps: stepCount(),
            diagnosticInternalsAvailable: diagnostic._stepMap instanceof Map,
            rootSteps: diagnostic._steps?.length ?? null,
            failure,
            batches,
            note: 'No browser. Internal step metadata is diagnostic only; no latency acceptance threshold.',
          },
          null,
          2,
        ),
      );
    try {
      await save();
      for (let batch = 0; frames < FRAMES; batch += 1) {
        // A timer turn avoids an explicit test.step zone. Both modes use the
        // same callback and batch boundaries, so reporting is the changed input.
        const sample = await new Promise<Record<string, unknown>>((resolve, reject) => {
          setTimeout(() => {
            const beforeSteps = stepCount();
            const parent = diagnostic._parentStep?.();
            const before = performance.now();
            try {
              for (let offset = 0; offset < BATCH_SIZE; offset += 1) {
                // Cooperatively cap a slow batch; test/global timeouts cannot
                // interrupt a synchronous JS callback until it yields.
                if (offset % 25 === 0 && performance.now() - started > 110_000)
                  throw new Error('Probe exceeded 110s cooperative execution limit');
                const ready = true;
                const mimeType = 'audio/pcm;rate=16000';
                if (mode === 'per-frame-expect') {
                  expect(ready).toBe(true);
                  expect(mimeType).toBe(`audio/pcm;rate=${SAMPLE_RATE}`);
                } else if (mode === 'strict-node') {
                  assert.equal(ready, true);
                  assert.equal(mimeType, `audio/pcm;rate=${SAMPLE_RATE}`);
                } else if (!ready || mimeType !== `audio/pcm;rate=${SAMPLE_RATE}`) {
                  violations += 1;
                  throw new Error('PCM arrived before setup or with an unexpected MIME type');
                }
                frames += 1;
              }
              resolve({
                batch,
                frameEnd: frames,
                durationMs: performance.now() - before,
                stepsBefore: beforeSteps,
                stepsAfter: stepCount(),
                parentStepId: parent?.stepId ?? null,
                parentCategory: parent?.category ?? null,
                workerHeapUsedBytes: process.memoryUsage().heapUsed,
              });
            } catch (error) {
              reject(error);
            }
          }, 0);
        });
        batches.push(sample);
        await save();
        console.info('[assertion-reporting]', mode, JSON.stringify(sample));
      }
      // The plain-check path keeps the same per-frame validation and records
      // one aggregate assertion instead of generating two steps for every frame.
      expect({ frames, violations }).toEqual({ frames: FRAMES, violations: 0 });
      status = 'measured';
    } catch (error) {
      status = 'failed';
      failure = String(error);
      throw error;
    } finally {
      await save();
    }
  });
}
