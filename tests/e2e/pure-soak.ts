import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
export const pureSoakMinutes = Number(process.env.PURE_SOAK_MINUTES ?? 0);
if (!Number.isInteger(pureSoakMinutes) || pureSoakMinutes < 0 || pureSoakMinutes > 120)
  throw new Error('PURE_SOAK_MINUTES must be an integer 0..120');
export async function observePureSoak(
  page: Page,
  info: TestInfo,
  provider: string,
  counters: () => { frames: number; commits: number; connections: number },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const start = Date.now(),
    samples: Array<Record<string, number>> = [];
  const visibleSequence = async () => {
    const text = (await page.getByTestId('pure-history-line').allTextContents()).join('\n');
    return Math.max(0, ...Array.from(text.matchAll(/第(\d+)段/g), (match) => Number(match[1])));
  };
  let previous = start,
    previousFrames = counters().frames,
    previousMinuteCommits = counters().commits,
    previousVisibleSequence = await visibleSequence();
  try {
    for (let i = 0; i < pureSoakMinutes * 4; i++) {
      await page.waitForTimeout(Math.max(0, start + (i + 1) * 15000 - Date.now()));
      const now = Date.now();
      expect(now - previous, 'no missing wall-clock observation interval').toBeLessThan(30000);
      previous = now;
      const count = counters();
      expect(count.frames, 'native PCM continues').toBeGreaterThan(previousFrames);
      previousFrames = count.frames;
      await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕', {
        timeout: 20000,
      });
      const metrics = await cdp.send('Performance.getMetrics');
      const heap = metrics.metrics.find(
        (m: { name: string }) => m.name === 'JSHeapUsedSize',
      )?.value;
      expect(Number.isFinite(heap), 'heap metric must be available').toBe(true);
      expect(heap).toBeGreaterThan(0);
      const history = await page.getByTestId('pure-history-line').count();
      expect(history).toBeLessThanOrEqual(200);
      expect(heap, 'browser heap remains bounded').toBeLessThan(160 * 1024 * 1024);
      samples.push({ elapsedMs: now - start, ...count, heap, history });
      if ((i + 1) % 4 === 0) {
        expect(count.commits, 'finals continue each minute').toBeGreaterThan(previousMinuteCommits);
        previousMinuteCommits = count.commits;
        const currentVisibleSequence = await visibleSequence();
        expect(currentVisibleSequence, 'rendered finals continue each minute').toBeGreaterThan(
          previousVisibleSequence,
        );
        previousVisibleSequence = currentVisibleSequence;
        await writeFile(
          info.outputPath(`${provider}-soak.json`),
          JSON.stringify(
            {
              scope:
                'Native audio/VAD/local persistence with synthetic upstream, not cloud ASR quality',
              audioSha256: process.env.PURE_TEST_AUDIO_SHA256,
              minutes: pureSoakMinutes,
              observedMs: Date.now() - start,
              samples,
            },
            null,
            2,
          ),
        );
        console.info('[pure-soak]', provider, JSON.stringify(samples.at(-1)));
      }
    }
    expect(samples).toHaveLength(pureSoakMinutes * 4);
    if (pureSoakMinutes >= (provider === 'gemini' ? 10 : 30))
      expect(counters().connections).toBeGreaterThan(1);
  } finally {
    await cdp.detach();
  }
}
