import { expect, test } from '@playwright/test';
import { installOnlineMocks, type OnlineMockController } from './online-mock.js';

/**
 * 數字① — the failover caption-gap yardstick for P2-ONLINE
 * (contract: docs/PHASE_2_RUN.md, target: docs/GOAL_PHASE_2.md section A).
 *
 * The rule these tests exist to enforce: when an online backend dies
 * mid-meeting, the operator must not stare at a frozen caption board for half
 * a minute. Everything here is measured as a difference between two in-page
 * timestamps — fault injection versus the observable recovery event — because
 * "felt slow" is not a number anyone can regress against.
 *
 * The two tests measure DIFFERENT failure shapes, and both were written to fail
 * against the unfixed code so that passing them later means something.
 *
 *   A1+A2 — Gemini's outage is persistent, so the meeting has to move. Nobody
 *           clicks anything: the person running a meeting is looking at the
 *           room, not the laptop, so an affordance that waits for a click is
 *           not a recovery path. Gemini re-mints its token on every reconnect,
 *           so the broker has to stay broken for the outage to persist.
 *   A3    — OpenAI's outage is transient: upstream is healthy again a second
 *           later. Nothing external is keeping captions down at that point —
 *           only our own retry backoff is.
 *
 * A1's own guarantee — that the outage is noticed on a 2 s clock rather than at
 * the end of the backoff ladder — is pinned precisely in the provider's unit
 * test. Here it is one DOM transition away from A2's, so measuring it twice
 * would be the same number under two names.
 */

/** Stamp left inside the page by armDomProbe. */
declare global {
  interface Window {
    __gapProbe: { mark: number | null };
  }
}

/** Captions must come back within this long after the backend dies. */
const GAP_BUDGET_MS = 3_000;
/**
 * How long we let a measurement run before calling it hung. Must clear the
 * unfixed behaviour (~31 s for A1, ~30 s for A3) so the baseline run reports a
 * real number instead of a timeout, which would tell us nothing.
 */
const OUTAGE_CEILING_MS = 60_000;

let mock: OnlineMockController;

test.beforeEach(async ({ page }) => {
  mock = await installOnlineMocks(page);
});

/**
 * Read the page's own clock. Both ends of every measurement come from this one
 * clock, so no Node-to-browser skew can leak into the number.
 */
function pageNow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/**
 * Watch the DOM from inside the page and stamp the instant an element appears.
 *
 * Polling from Node cannot do this honestly. Playwright backs its poll interval
 * off (100 ms, then 250, 500, 1000…), so waiting for a banner reports whenever
 * the next poll happened to land, not when the banner showed up — worth close
 * to a second of phantom latency. Against a 3 s budget that is the difference
 * between a pass and a fail, and it would move test-to-test, which is how a
 * yardstick turns into a flaky test that gets "fixed" by loosening it.
 *
 * A MutationObserver inside the page stamps the transition itself.
 */
async function armDomProbe(
  page: import('@playwright/test').Page,
  testId: string,
  mode: 'appears' | 'vanishes',
): Promise<void> {
  await page.evaluate(
    ([id, wanted]) => {
      const selector = `[data-testid="${id}"]`;
      window.__gapProbe = { mark: null };
      const probe = window.__gapProbe;
      const satisfied = (): boolean =>
        (document.querySelector(selector) !== null) === (wanted === 'appears');
      if (satisfied()) {
        probe.mark = performance.now();
        return;
      }
      const observer = new MutationObserver(() => {
        if (probe.mark === null && satisfied()) {
          probe.mark = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    },
    [testId, mode] as const,
  );
}

/** Read the stamp left by armDomProbe. */
async function readProbeMark(page: import('@playwright/test').Page): Promise<number> {
  const mark = await page.evaluate(() => window.__gapProbe.mark);
  expect(mark, 'appearance probe never fired').not.toBeNull();
  return mark!;
}

/** Record the measurement where both the console and the HTML report show it. */
async function reportGap(label: string, elapsedMs: number): Promise<void> {
  const line = `${label}: ${Math.round(elapsedMs)} ms (預算 ${GAP_BUDGET_MS} ms)`;
  console.info(`[數字①] ${line}`);
  await test.info().attach('數字①', { body: line, contentType: 'text/plain' });
}

test.describe('數字① — failover caption gap', () => {
  // The unfixed paths take ~31 s and ~30 s, so the 30 s default would abort the
  // measurement before it produced a number.
  test.setTimeout(120_000);

  test('A1+A2 — a dead Gemini hands the meeting to OpenAI with nobody clicking', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('launch-gemini').click();
    await expect.poll(() => mock.geminiOpenSockets(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Prove captions were flowing before the fault, otherwise a measurement of
    // "captions came back" is meaningless.
    await mock.geminiServerContent({
      inputTranscription: { text: 'Before the handoff.', languageCode: 'en-US' },
      outputTranscription: { text: '交接前的句子。' },
      turnComplete: true,
    });
    await expect(page.locator('body')).toContainText('交接前的句子。', { timeout: 5_000 });
    const capturesBefore = await mock.micAcquisitions();
    expect(capturesBefore).toBe(1);

    // Break the token broker FIRST: Gemini mints a fresh token on every
    // reconnect, so leaving it healthy would let the first backoff tick heal
    // the session and there would be no outage to measure.
    mock.setGeminiSessionFailing(true);
    // No click anywhere in this test. The app is expected to move the meeting
    // itself and say so.
    await armDomProbe(page, 'autoswitch-notice', 'appears');
    const t0 = await pageNow(page);
    await mock.geminiClose();

    await expect(page.getByTestId('autoswitch-notice')).toBeVisible({ timeout: OUTAGE_CEILING_MS });
    const elapsed = (await readProbeMark(page)) - t0;

    // The switch must be visible: captions silently coming from a different
    // model, at different quality and cost, is a lie of omission.
    await expect(page.getByTestId('autoswitch-notice')).toContainText('Gemini');
    await expect(page.getByTestId('autoswitch-notice')).toContainText('OpenAI');

    // The capture was handed over, not re-opened. On a real machine a second
    // acquisition means a device open — and for system audio, a share dialog
    // in the middle of the meeting.
    expect(await mock.micAcquisitions()).toBe(capturesBefore);

    // CLAUDE.md: a provider switch must not clear the transcript.
    await expect(page.locator('body')).toContainText('交接前的句子。');

    // And the new backend really is captioning, not merely connected.
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
    await mock.oaiOutput('交接後的句子。');
    await expect(page.getByTestId('caption-target')).toContainText('交接後的句子。', {
      timeout: 5_000,
    });

    await reportGap('Gemini 故障 → 自動接手完成', elapsed);
    expect(elapsed).toBeLessThanOrEqual(GAP_BUDGET_MS);
  });

  test('A3 — a recovered OpenAI backend resumes captions within the gap budget', async ({
    page,
  }) => {
    // Gemini is deliberately unavailable. This test is about OpenAI healing
    // ITSELF, so leaving a failover target on the table would let a future
    // auto-handoff (A2) satisfy the measurement and quietly stop testing the
    // retry schedule.
    mock.setAvailableProviders(['openai']);

    await page.goto('/');
    await page.getByTestId('start-real').click();
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);

    await mock.oaiOutput('故障前的基準句。');
    await mock.oaiComplete();
    await expect(page.locator('body')).toContainText('故障前的基準句。', { timeout: 5_000 });
    expect(await mock.oaiPeerCount()).toBe(1);

    // Kill the broker, then force a renewal against it. The renewal fails and
    // the provider enters its retry backoff.
    mock.setOaiSessionFailing(true);

    const t0 = await pageNow(page);
    await mock.oaiClosed();

    // Wait for the provider to admit the renewal failed — it shows the
    // reconnect pill the moment it schedules a retry. Recovering upstream
    // before that point would race the failure and leave no gap to measure.
    await expect(page.getByTestId('reconnect-pill')).toBeVisible({ timeout: 15_000 });

    // The pill going away is the operator-visible "we are back". Arm the probe
    // before healing upstream so the stamp is the transition itself.
    await armDomProbe(page, 'reconnect-pill', 'vanishes');

    // Upstream is healthy again. From here on, the only thing standing between
    // the meeting and its captions is our own retry schedule — which is
    // exactly the interval this test measures.
    mock.setOaiSessionFailing(false);

    // A second peer means the renewal finally went through and the caption
    // path is live again.
    await expect.poll(() => mock.oaiPeerCount(), { timeout: OUTAGE_CEILING_MS }).toBe(2);
    const elapsed = (await readProbeMark(page)) - t0;

    // Captions must actually flow on the rebuilt session, not just a peer that
    // exists on paper.
    await expect.poll(() => mock.oaiReady(), { timeout: 10_000 }).toBe(true);
    await mock.oaiOutput('恢復後的句子。');
    await expect(page.getByTestId('caption-target')).toContainText('恢復後的句子。', {
      timeout: 5_000,
    });

    await reportGap('OpenAI 續期失敗後恢復 → 字幕回來', elapsed);
    expect(elapsed).toBeLessThanOrEqual(GAP_BUDGET_MS);
  });
});
