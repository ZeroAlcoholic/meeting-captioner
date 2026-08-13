import { expect, test } from '@playwright/test';
import { installOnlineMocks } from './online-mock.js';

/**
 * The projector must never go white.
 *
 * React unmounts the entire tree when a render throws, so before this boundary
 * existed any rendering bug ended the meeting with a blank screen — no message,
 * no recovery, and nobody in the room able to tell whether the laptop had
 * crashed or the speaker had stopped talking. That is the worst failure this
 * product has, because it is silent, total, and arrives in front of an audience.
 *
 * Triggered here the way it would actually happen: a stored transcript that the
 * current build cannot render. Restored state comes off disk from an older
 * version, or from a write interrupted mid-flight, and it is fed straight into
 * the caption board on load — a real path with real precedent, not a synthetic
 * throw wired in for the test.
 */

/** A segment whose text is an object. React refuses to render it and throws. */
const CORRUPT_SEGMENT = {
  segmentId: 'corrupt-1',
  provider: 'openai-realtime',
  mode: 'online_full',
  source: 'microphone',
  status: 'final',
  text: { unexpected: 'shape' },
  startMs: 1_000,
};

test('a transcript the build cannot render leaves a readable screen, not a blank one', async ({
  page,
}) => {
  await installOnlineMocks(page);

  await page.addInitScript((segment) => {
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
    localStorage.setItem(
      'meeting-audio:captions:v4',
      JSON.stringify({
        v: 4,
        segments: [segment],
        translations: {},
        sessionStartMs: Date.now() - 60_000,
        sessionId: 'corrupt-session',
        sessionEndedAt: null,
        sessionMode: 'real',
        sessionPhase: 'ended',
        savedAt: new Date().toISOString(),
      }),
    );
  }, CORRUPT_SEGMENT);

  await page.goto('/');

  // Whatever happens — the board copes with the bad segment, or a boundary
  // catches the throw — the room must not be looking at nothing.
  const body = page.locator('body');
  await expect(body).not.toBeEmpty();
  const text = ((await body.textContent()) ?? '').trim();
  expect(text.length).toBeGreaterThan(0);

  // The app shell survives either way: whoever is running the meeting can still
  // reach the controls rather than being left with a dead page.
  await expect(page.getByTestId('settings-toggle')).toBeVisible();

  // If a boundary did catch it, it has to say what to do next — an error screen
  // that only prints a stack is barely better than a white one.
  // Which of the two happened is worth printing. A test that silently accepts
  // either would let the boundary rot untested the day the store starts
  // sanitising this input, and nobody would notice.
  const boundary = page.getByTestId('caption-error-boundary');
  const caught = (await boundary.count()) > 0;
  console.info(
    caught
      ? '[boundary] 渲染丟出例外，由邊界接住'
      : '[boundary] 字幕板自行消化了損毀資料，未觸發邊界',
  );

  if (caught) {
    // An error screen that only prints a stack is barely better than a white
    // one — it has to tell the operator what to do next.
    await expect(boundary).toContainText('重新載入');
    await expect(boundary).toContainText('匯出');
  }
});
