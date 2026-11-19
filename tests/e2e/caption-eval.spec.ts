import { expect, test, type BrowserContext } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPredictions } from '../../scripts/mixed-caption-predictions.mjs';

/**
 * Plays each manifest sample through the real caption pipeline in Chrome and
 * records what the board showed, so `mixed-caption-eval.mjs` can score it.
 *
 * Only `id` and `audio` are read here — reference text, provenance and the
 * speech marks belong to the scorer, and this tool must not be able to
 * influence them.
 */
interface EvalSample {
  id: string;
  audio: string;
}
const manifestPath = path.resolve(process.env.CAPTION_EVAL_MANIFEST!);
const outputPath = path.resolve(process.env.CAPTION_EVAL_OUT!);
const provider = (process.env.CAPTION_EVAL_PROVIDER ?? 'openai') as 'openai' | 'gemini';
// Without this the session talks to the real upstream, which costs money; the
// default keeps the controlled upstream used by the pipeline regressions.
const realUpstream = process.env.CAPTION_EVAL_REAL_UPSTREAM === '1';

declare global {
  interface Window {
    __captionEval: {
      audioStartMs: number | null;
      audioEndedAtMs: number | null;
      firstTextAtMs: number | null;
      finalTextAtMs: number | null;
      finals: string[];
    };
    __captionEvalReset: () => void;
  }
}

test(`capture ${provider} caption predictions`, async ({ browser }) => {
  // A full corpus run waits out the writer lease once per sample; 24 samples
  // no longer fit in the single-sample budget this started with.
  test.setTimeout(60 * 60_000);
  const origin = process.env[`PURE_TEST_URL_${provider.toUpperCase()}`]!;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { samples: EvalSample[] };
  const base = path.dirname(manifestPath);
  let audio = Buffer.alloc(0);
  let commits = 0;

  /** Audio stand-in, upstream stand-in and capture hooks for one sample. */
  const prepare = async (context: BrowserContext) => {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/eval-audio.wav')
        return route.fulfill({ body: audio, contentType: 'audio/wav' });
      if (realUpstream || url.origin !== origin) return route.continue();
      if (url.pathname === '/session/transcription')
        return route.fulfill({
          json: {
            client_secret: { value: 'test-only', expires_at: Math.floor(Date.now() / 1000) + 600 },
            model: 'gpt-live-transcribe',
            session_renewal_recommended_ms: 1_500_000,
          },
        });
      if (url.pathname === '/session/gemini/transcription')
        return route.fulfill({
          json: {
            token: 'test-only',
            expiresAt: Date.now() + 120_000,
            model: 'models/gemini-3.5-transcribe-live',
          },
        });
      return route.continue();
    });

    if (!realUpstream)
      await context.routeWebSocket('**/*', (ws) => {
        let previous: string | null = null;
        if (provider === 'openai')
          setTimeout(
            () =>
              // The provider verifies the whole handshake before it will start.
              ws.send(
                JSON.stringify({
                  type: 'session.created',
                  session: {
                    type: 'transcription',
                    audio: {
                      input: {
                        transcription: { model: 'gpt-live-transcribe' },
                        turn_detection: null,
                      },
                    },
                  },
                }),
              ),
            50,
          );
        ws.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.setup) ws.send(JSON.stringify({ setupComplete: {} }));
          const segment = () => `受控上游第 ${++commits} 段 API budget USD 30`;
          if (message.realtimeInput?.activityEnd)
            ws.send(
              JSON.stringify({
                serverContent: {
                  inputTranscription: { text: segment() },
                  generationComplete: true,
                },
              }),
            );
          if (message.type === 'input_audio_buffer.commit') {
            const text = segment();
            const id = `turn-${commits}`;
            ws.send(
              JSON.stringify({
                type: 'input_audio_buffer.committed',
                item_id: id,
                previous_item_id: previous,
              }),
            );
            previous = id;
            ws.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: id,
                transcript: text,
              }),
            );
          }
        });
      });

    await context.addInitScript(() => {
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          captionTask: {
            purpose: 'transcription',
            inputLanguages: ['zh-tw', 'en'],
            textPolicy: 'zh-TW-preserve-original',
          },
          modeId: 'online_full',
          audioSource: 'mic',
          micDistance: 'off',
        }),
      );
      const marks: Window['__captionEval'] = {
        audioStartMs: null,
        audioEndedAtMs: null,
        firstTextAtMs: null,
        finalTextAtMs: null,
        finals: [],
      };
      window.__captionEval = marks;
      // One clock for the audio and for what the board showed; wall time would
      // drift against the sample positions the scorer compares against.
      // The sample is played exactly once however often capture is acquired: a
      // second playback would restart the clock the measurements are relative to.
      let playback: Promise<MediaStream> | null = null;
      navigator.mediaDevices.getUserMedia = () =>
        (playback ??= (async () => {
          const ctx = new AudioContext({ sampleRate: 48000 });
          const destination = ctx.createMediaStreamDestination();
          const buffer = await ctx.decodeAudioData(
            await fetch('/eval-audio.wav').then((response) => response.arrayBuffer()),
          );
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(destination);
          source.onended = () => {
            marks.audioEndedAtMs = performance.now();
          };
          await ctx.resume();
          marks.audioStartMs = performance.now();
          source.start();
          return destination.stream;
        })());
      // A restored meeting already fills the history, so only lines beyond the
      // count present when the sample starts belong to this measurement.
      let baseline = 0;
      let carriedLive = '';
      const liveText = () =>
        document.querySelector('[data-testid="pure-live-text"]')?.textContent?.trim() ?? '';
      const historyLines = () =>
        [...document.querySelectorAll('[data-testid="pure-history-line"]')]
          .map((node) => node.textContent?.trim() ?? '')
          .filter(Boolean);
      window.__captionEvalReset = () => {
        baseline = historyLines().length;
        carriedLive = liveText();
        marks.firstTextAtMs = null;
        marks.finalTextAtMs = null;
        marks.finals = [];
      };
      const observe = () => {
        const live = liveText();
        if (live && live !== carriedLive && marks.firstTextAtMs === null)
          marks.firstTextAtMs = performance.now();
        const finals = historyLines().slice(baseline);
        if (finals.length > marks.finals.length) {
          marks.finals = finals;
          marks.finalTextAtMs = performance.now();
        }
      };
      // An init script runs before the document element exists, so the observer
      // waits for it rather than throwing and taking the capture hooks with it.
      document.addEventListener('DOMContentLoaded', () =>
        new MutationObserver(observe).observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
        }),
      );
    });
  };

  const observations = [];
  const unplayed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const sample of manifest.samples) {
    // One profile per sample. An event the archive refuses stays queued in the
    // profile that produced it and is retried forever, so a shared profile lets
    // one stuck event wedge persistence for every sample after it — and a
    // measurement must not depend on what the sample before it left behind.
    const context = await browser.newContext();
    try {
      audio = await readFile(path.resolve(base, sample.audio));
      await prepare(context);
      const page = await context.newPage();
      // A capture that silently records nothing is worse than one that stops,
      // and the archive's refusals are the failure this tool has actually hit.
      page.on('response', (response) => {
        if (response.status() >= 400)
          void response
            .text()
            .then((body) =>
              console.info(
                `${sample.id}: HTTP ${response.status()} ${new URL(response.url()).pathname} ${body.slice(0, 120)}`,
              ),
            )
            .catch(() => {});
      });
      await page.goto(origin);
      await page.getByRole('textbox', { name: '會議名稱' }).fill(sample.id);
      await page.getByRole('combobox', { name: '雲端轉寫' }).selectOption(provider);
      await page.evaluate(() => window.__captionEvalReset());
      // The archive never steals the writer lease from another profile: the one
      // the previous sample ran in keeps it until the lease expires, and
      // ownership comes back only on an explicit retry. A read-only tab refuses
      // to start, and that verdict arrives a moment after navigation, so no
      // pre-flight check is trustworthy — starting is the operation to retry.
      await expect(async () => {
        const retry = page.getByRole('button', { name: '重新檢查寫入權限' });
        if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {});
        // Bounded: a disabled button would otherwise block this attempt past the
        // deadline instead of letting the next one re-check write ownership.
        await page.getByRole('button', { name: '開始純字幕', exact: true }).click({
          timeout: 10_000,
        });
        await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕', {
          timeout: 20_000,
        });
      }).toPass({ timeout: 180_000, intervals: [3_000, 5_000, 5_000] });
      // Stop only once the sample has finished playing and the tail has had time
      // to come back, so a late final is measured rather than cut off.
      await page.waitForFunction(() => window.__captionEval.audioEndedAtMs !== null, undefined, {
        timeout: 120_000,
      });
      await page.waitForTimeout(5_000);
      await page
        .getByRole('button', { name: '停止並保存', exact: true })
        .click({ timeout: 10_000 });
      // The region always carries '待保存 N 筆' and a '重試保存／結案' button, so a
      // bare '保存' matches before anything has been written. A real upstream can
      // also deliver a final after the stop, which the first finalize cannot
      // commit; the workspace offers a retry for exactly that, and the capture
      // takes it rather than recording a sample whose text was never saved.
      await expect(async () => {
        const retrySave = page.getByRole('button', { name: '重試保存／結案' });
        if (await retrySave.isVisible().catch(() => false))
          await retrySave.click({ timeout: 5_000 }).catch(() => {});
        await expect(page.getByTestId('persistence-status')).toContainText(
          /已結案保存|已保存，逐字稿尚待核對/,
          { timeout: 10_000 },
        );
      }).toPass({ timeout: 120_000, intervals: [3_000, 5_000, 5_000] });
      const marks = await page.evaluate(() => window.__captionEval);
      // Raw marks belong in the run log: a prediction file alone cannot show that
      // a sample produced no caption at all.
      console.info(`${sample.id}: ${JSON.stringify(marks)}`);
      // A sample whose audio never played is reported as missing rather than
      // ending the run: later samples still get measured, and the scorer counts
      // the omission instead of scoring a guess.
      if (marks.audioStartMs === null) unplayed.push(sample.id);
      else
        observations.push({
          id: sample.id,
          text: marks.finals.join(''),
          audioStartMs: marks.audioStartMs,
          ...(marks.firstTextAtMs === null ? {} : { firstTextAtMs: marks.firstTextAtMs }),
          ...(marks.finalTextAtMs === null ? {} : { finalTextAtMs: marks.finalTextAtMs }),
        });
    } catch (error) {
      // One sample that never starts must not discard the whole run: a capture
      // against the real upstream costs money per sample, so the ones already
      // measured are written out and the scorer counts this one as missing.
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      failed.push({ id: sample.id, error: reason });
      console.info(`${sample.id}: FAILED ${reason}`);
    } finally {
      await context.close();
    }
  }

  await writeFile(outputPath, `${JSON.stringify(buildPredictions(observations), null, 2)}\n`);
  expect({ unplayed, failed }, 'every sample played and completed').toEqual({
    unplayed: [],
    failed: [],
  });
});
