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
    // Held so the observer is not collected — a collected observer reports
    // nothing, which reads exactly like a transition that never happened.
    __gapProbeObserver: MutationObserver;
    __speaking: number;
  }
}

/** Text used to detect the first caption after the fault. */
const RESUMED_CAPTION = '接手後的字幕。';

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
 * Stamp the instant a piece of text reaches the screen.
 *
 * 數字① is defined as fault injection to the NEXT caption event, so the clock
 * has to stop on a caption. An earlier version stopped it when the auto-switch
 * notice appeared — that measures how fast the app admits there is a problem,
 * which runs ahead of the board actually coming back, and the budget could pass
 * while the room still stared at a frozen caption.
 *
 * The stamp is taken inside the page rather than by polling from Node.
 * Playwright backs its poll interval off (100 ms, then 250, 500, 1000…), so a
 * polled reading reports whenever the next poll happened to land — close to a
 * second of phantom latency against a 3 s budget, varying run to run, which is
 * how a yardstick decays into a flaky test that gets "fixed" by loosening it.
 */
async function armCaptionProbe(
  page: import('@playwright/test').Page,
  marker: string,
): Promise<void> {
  await page.evaluate((needle) => {
    window.__gapProbe = { mark: null };
    const probe = window.__gapProbe;
    const seen = (): boolean => document.body.textContent?.includes(needle) === true;
    if (seen()) {
      probe.mark = performance.now();
      return;
    }
    const observer = new MutationObserver(() => {
      if (probe.mark === null && seen()) {
        probe.mark = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__gapProbeObserver = observer;
  }, marker);
}

/**
 * Keep talking, the way a speaker does through an outage.
 *
 * The replacement backend cannot be handed a caption until it exists, and
 * waiting for it from Node would put poll granularity into the number. So the
 * page keeps offering one every 100 ms: the mock drops it while no channel is
 * open, and the first one that lands is genuinely "the next caption", measured
 * against a clock that never left the browser.
 */
async function keepSpeaking(
  page: import('@playwright/test').Page,
  marker: string,
): Promise<() => Promise<void>> {
  await page.evaluate((text) => {
    window.__speaking = window.setInterval(() => {
      window.__mock.oai.emit({ type: 'session.output_transcript.delta', delta: text });
    }, 100);
  }, marker);
  return async () => {
    await page.evaluate(() => {
      window.clearInterval(window.__speaking);
    });
  };
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
    // itself, and the clock stops when the ROOM sees a caption again — not when
    // the app first admits something is wrong.
    const stopSpeaking = await keepSpeaking(page, RESUMED_CAPTION);
    await armCaptionProbe(page, RESUMED_CAPTION);
    const t0 = await pageNow(page);
    await mock.geminiClose();

    await expect(page.getByTestId('caption-target')).toContainText(RESUMED_CAPTION, {
      timeout: OUTAGE_CEILING_MS,
    });
    const elapsed = (await readProbeMark(page)) - t0;
    await stopSpeaking();

    // The switch must be visible: captions silently coming from a different
    // model, at different quality and cost, is a lie of omission.
    const notice = page.getByTestId('autoswitch-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Gemini');
    await expect(notice).toContainText('OpenAI');

    // The capture was handed over, not re-opened. On a real machine a second
    // acquisition means a device open — and for system audio, a share dialog
    // in the middle of the meeting.
    expect(await mock.micAcquisitions()).toBe(capturesBefore);

    // CLAUDE.md: a provider switch must not clear the transcript.
    await expect(page.locator('body')).toContainText('交接前的句子。');

    await reportGap('Gemini 故障 → 字幕回到畫面', elapsed);
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

    // The speaker carries on talking through all of this.
    const stopSpeaking = await keepSpeaking(page, RESUMED_CAPTION);
    await armCaptionProbe(page, RESUMED_CAPTION);
    const t0 = await pageNow(page);
    await mock.oaiClosed();
    // A session that has gone away cannot still deliver captions. The mock's
    // peer survives oaiClosed(), so without this the words being spoken would
    // be accepted by the dead channel and the outage would measure as zero.
    await mock.oaiCloseActivePeer();

    // Wait for the provider to admit the renewal failed — it shows the
    // reconnect pill the moment it schedules a retry. Recovering upstream
    // before that point would race the failure and leave no gap to measure.
    await expect(page.getByTestId('reconnect-pill')).toBeVisible({ timeout: 15_000 });

    // Upstream is healthy again. From here on, the only thing standing between
    // the meeting and its captions is our own retry schedule — which is
    // exactly the interval this test measures.
    mock.setOaiSessionFailing(false);

    await expect(page.getByTestId('caption-target')).toContainText(RESUMED_CAPTION, {
      timeout: OUTAGE_CEILING_MS,
    });
    const elapsed = (await readProbeMark(page)) - t0;
    await stopSpeaking();

    // The rebuilt session is a genuinely new peer, not the old one limping on.
    expect(await mock.oaiPeerCount()).toBe(2);

    await reportGap('OpenAI 續期失敗後恢復 → 字幕回到畫面', elapsed);
    expect(elapsed).toBeLessThanOrEqual(GAP_BUDGET_MS);
  });
});
