import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type { MeetingEnvelope, GapRecord, MeetingManifest } from '@meeting-audio/contracts';
import { observePureSoak, pureSoakMinutes } from './pure-soak.js';
import { installRenewalResourceObserver, type RenewalResources } from './pure-renewal-observer.js';
for (const provider of ['openai', 'gemini'] as const)
  test.describe(provider, () => {
    // Each provider fixture owns one database with a single-writer lease.
    // Keep its scenarios ordered; independent provider services can run in parallel.
    test.describe.configure({ mode: 'default' });
    for (const scenario of pureSoakMinutes
      ? ['baseline']
      : [
          'baseline',
          'cross-provider',
          'cross-provider timing',
          'cross-provider refused',
          'cross-provider both refused',
          'cross-provider Stop',
          'qualified renewal',
          'candidate refused',
          'candidate timeout',
          'candidate Stop',
          'retiring final',
          'retiring final after active failure',
        ])
      test(`${provider}: ${scenario}, native Chrome audio, local VAD, IndexedDB, SQLite, reload, correction and export`, async ({
        page,
        context,
      }, info) => {
        const origin = process.env[`PURE_TEST_URL_${provider.toUpperCase()}`]!;
        const meetingName = `${provider} ${scenario} integration`;
        const crossProvider = scenario.startsWith('cross-provider');
        const timedHandoff = scenario === 'cross-provider timing';
        let faultAt: number | null = null;
        let effectiveSentAt: number | null = null;
        let handoffTiming: Record<string, number> | null = null;
        const alternate = provider === 'openai' ? 'gemini' : 'openai';
        const renewal = scenario !== 'baseline' && !crossProvider;
        const candidateFault = scenario.startsWith('candidate ');
        const retiringFinal = scenario.startsWith('retiring final');
        const liveIsolation = scenario === 'retiring final';
        let releaseReady: (() => void) | null = null;
        let releaseTail: (() => void) | null = null;
        let sendRetiredPartial: (() => void) | null = null;
        let releaseActiveFinal: (() => void) | null = null;
        let holdActiveFinal = liveIsolation;
        let activePartialSent = false;
        let closeCandidate: (() => void) | null = null;
        let closePrimary: (() => void) | null = null;
        let lastMintBackend = provider;
        const mintCalls = { openai: 0, gemini: 0 };
        let tailSequence = 0;
        let candidateClosed = false;
        let suppressFinal = false,
          dropReceipts = false,
          receiptLost = false;
        let rejectEvents = !pureSoakMinutes;
        let rejectedRequests = 0;
        let connections = 0,
          commits = 0,
          frames = 0,
          nonzero = 0;
        let primaryClosed = false;
        let candidateReady = false;
        let candidateFrames = 0;
        let candidateBeforeReady = 0;
        let primaryAliveAtCandidateReady = false;
        let candidateReadyAt: number | null = null;
        let candidateFirstPcmAt: number | null = null;
        let candidateFirstText: string | null = null;
        let candidateFirstTextSentAt: number | null = null;
        let candidateReadyWallAt: number | null = null;
        let candidateFirstPcmWallAt: number | null = null;
        let renewalTiming: Record<string, number> | null = null;
        let candidateCreatedAt: number | null = null;
        const savedGaps = new Map<string, GapRecord>();
        const errors: string[] = [],
          forbidden: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await context.route('**/*', async (route) => {
          const u = new URL(route.request().url());
          if (rejectEvents && u.pathname.endsWith('/events')) {
            rejectedRequests++;
            return route.fulfill({ status: 400, json: { error: 'INVALID_MEETING_EVENTS' } });
          }
          if (u.pathname.endsWith('/events') && route.request().method() === 'POST') {
            const body = route.request().postDataJSON() as { events: MeetingEnvelope[] };
            for (const event of body.events)
              if (event.payload.kind === 'gap')
                savedGaps.set(event.payload.gap.gapId, event.payload.gap);
          }
          if (dropReceipts && u.pathname.endsWith('/events')) {
            const result = await route.fetch();
            expect(result.ok()).toBe(true);
            receiptLost = true;
            return route.abort();
          }
          if (u.origin !== origin) {
            forbidden.push(u.origin);
            return route.abort();
          }
          if (['/session', '/session/gemini', '/translate'].includes(u.pathname)) {
            forbidden.push(u.pathname);
            return route.abort();
          }
          if (u.pathname === '/test-speech.wav')
            return route.fulfill({
              body: await readFile(process.env.PURE_TEST_AUDIO!),
              contentType: 'audio/wav',
            });
          if (crossProvider && u.pathname === '/session/info')
            return route.fulfill({
              json: {
                taskCapabilities: ['openai', 'gemini'].map((provider) => ({
                  provider,
                  purpose: 'transcription',
                  configured: true,
                  verified: false,
                })),
              },
            });
          if (
            crossProvider &&
            ['/session/transcription', '/session/gemini/transcription'].includes(u.pathname)
          ) {
            const target = u.pathname.includes('/gemini/') ? 'gemini' : 'openai';
            lastMintBackend = target;
            mintCalls[target]++;
            if (
              (scenario === 'cross-provider refused' && target === alternate) ||
              (scenario === 'cross-provider both refused' &&
                (target === alternate || mintCalls[target] > 1))
            )
              return route.fulfill({ status: 401, json: { error: 'Controlled provider refusal' } });
          }
          if (u.pathname === '/session/transcription')
            return route.fulfill({
              json: {
                client_secret: {
                  value: 'test-only',
                  expires_at: Math.floor(Date.now() / 1000) + 600,
                },
                model: 'gpt-live-transcribe',
                session_renewal_recommended_ms: renewal && connections === 0 ? 10000 : 1500000,
                concurrent_renewal_allowed: renewal,
              },
            });
          if (u.pathname === '/session/gemini/transcription')
            return route.fulfill({
              json: {
                token: 'test-only',
                expiresAt: Date.now() + 120000,
                model: 'models/gemini-3.5-transcribe-live',
                session_renewal_recommended_ms: renewal && connections === 0 ? 10000 : 480000,
                concurrent_renewal_allowed: renewal,
              },
            });
          return route.continue();
        });
        await context.routeWebSocket('**/*', (ws) => {
          connections++;
          const connection = connections;
          const socketProvider = crossProvider ? lastMintBackend : provider;
          if (connection === 1)
            closePrimary = () => ws.close({ code: 1011, reason: 'controlled primary failure' });
          if (connection === 2) candidateCreatedAt = Date.now();
          if (connection === 2)
            closeCandidate = () => ws.close({ code: 1011, reason: 'controlled active failure' });
          ws.onClose(() => {
            if (connection === 1) primaryClosed = true;
            if (connection === 2) candidateClosed = true;
          });
          const valid =
            socketProvider === 'openai'
              ? ws.url().startsWith('wss://api.openai.com/v1/realtime?intent=transcription')
              : ws.url().includes('BidiGenerateContentConstrained?access_token=');
          if (!valid) {
            forbidden.push('unexpected websocket');
            ws.close();
            return;
          }
          let previous: string | null = null;
          let liveItemId: string | null = null;
          const ready = (message: unknown) => {
            if (scenario === 'cross-provider Stop' && connection === 2) return;
            if (candidateFault && connection > 1) {
              if (scenario === 'candidate refused') {
                ws.close({ code: 1011, reason: 'controlled candidate refusal' });
                if (connection === 2) candidateClosed = true;
              }
              return;
            }
            const deliver = () => {
              if ((renewal || crossProvider) && connection === 2) {
                primaryAliveAtCandidateReady = !primaryClosed;
                candidateReady = true;
                candidateReadyAt = performance.now();
                candidateReadyWallAt = Date.now();
              }
              ws.send(JSON.stringify(message));
            };
            // Switch during real incumbent speech so stop must drain an actual turn.
            if (retiringFinal && connection === 2) releaseReady = deliver;
            else deliver();
          };
          if (socketProvider === 'openai')
            setTimeout(
              () =>
                ready({
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
              renewal && connection === 2 ? 1500 : 100,
            );
          ws.onMessage((raw) => {
            const m = JSON.parse(String(raw));
            if (m.setup) {
              expect(m.setup.model).toBe('models/gemini-3.5-transcribe-live');
              setTimeout(
                () => ready({ setupComplete: {} }),
                renewal && connection === 2 ? 1500 : 0,
              );
            }
            const audio = m.audio ?? m.realtimeInput?.audio?.data;
            if (audio) {
              if (connection === 1 && releaseReady) {
                const deliver = releaseReady;
                releaseReady = null;
                deliver();
              }
              if (connection > 1) {
                candidateFrames++;
                candidateFirstPcmAt ??= performance.now();
                candidateFirstPcmWallAt ??= Date.now();
                if (!candidateReady) candidateBeforeReady++;
              }
              if ((liveIsolation || timedHandoff) && connection === 2 && !activePartialSent) {
                activePartialSent = true;
                liveItemId = `live-${connection}`;
                effectiveSentAt = Date.now();
                ws.send(
                  JSON.stringify(
                    socketProvider === 'openai'
                      ? {
                          type: 'conversation.item.input_audio_transcription.delta',
                          item_id: liveItemId,
                          content_index: 0,
                          delta: '新主線辨識中',
                        }
                      : { serverContent: { interimInputTranscription: { text: '新主線辨識中' } } },
                  ),
                );
              }
              frames++;
              const b = Buffer.from(audio, 'base64');
              for (let i = 0; i + 1 < b.length; i += 2) if (b.readInt16LE(i) !== 0) nonzero++;
            }
            if (m.realtimeInput?.activityEnd) {
              commits++;
              const sequence = commits;
              if (retiringFinal && connection === 1 && candidateReady) {
                expect(releaseTail).toBeNull();
                tailSequence = sequence;
                sendRetiredPartial = () =>
                  ws.send(
                    JSON.stringify({
                      serverContent: {
                        interimInputTranscription: { text: '退役線未定稿不得上畫面' },
                      },
                    }),
                  );
                releaseTail = () =>
                  ws.send(
                    JSON.stringify({
                      serverContent: {
                        inputTranscription: {
                          text: `第${sequence}段 API 今天不部署，budget 是 USD 30。`,
                        },
                        generationComplete: true,
                        turnComplete: true,
                      },
                    }),
                  );
                return;
              }
              if (holdActiveFinal && connection === 2) {
                expect(releaseActiveFinal).toBeNull();
                releaseActiveFinal = () =>
                  ws.send(
                    JSON.stringify({
                      serverContent: {
                        inputTranscription: {
                          text: `第${sequence}段 API 今天不部署，budget 是 USD 30。`,
                        },
                        generationComplete: true,
                        turnComplete: true,
                      },
                    }),
                  );
                return;
              }
              if (connection === 2)
                candidateFirstText ??= `第${commits}段 API 今天不部署，budget 是 USD 30。`;
              if (connection === 2) candidateFirstTextSentAt ??= Date.now();
              const delayedTail = !pureSoakMinutes && commits === 1;
              ws.send(
                JSON.stringify({
                  serverContent: {
                    inputTranscription: {
                      text: `第${commits}段 API 今天不部署，budget 是 USD 30。`,
                    },
                    ...(!delayedTail ? { generationComplete: true } : {}),
                    turnComplete: true,
                  },
                }),
              );
              if (delayedTail)
                setTimeout(
                  () =>
                    ws.send(
                      JSON.stringify({
                        serverContent: {
                          inputTranscription: { text: '尾段驗證：金額不是三百美元。' },
                          generationComplete: true,
                        },
                      }),
                    ),
                  700,
                );
            }
            if (m.type === 'input_audio_buffer.commit') {
              const sequence = ++commits;
              const id = liveItemId ?? `turn-${sequence}`;
              liveItemId = null;
              if (connection === 2)
                candidateFirstText ??= `第${commits}段 API 今天不部署，budget 是 USD 30。`;
              if (connection === 2) candidateFirstTextSentAt ??= Date.now();
              ws.send(
                JSON.stringify({
                  type: 'input_audio_buffer.committed',
                  item_id: id,
                  previous_item_id: previous,
                }),
              );
              previous = id;
              if (suppressFinal) return;
              if (retiringFinal && connection === 1 && candidateReady) {
                expect(releaseTail).toBeNull();
                tailSequence = commits;
                const sequence = commits;
                sendRetiredPartial = () =>
                  ws.send(
                    JSON.stringify({
                      type: 'conversation.item.input_audio_transcription.delta',
                      item_id: id,
                      content_index: 0,
                      delta: '退役線未定稿不得上畫面',
                    }),
                  );
                releaseTail = () =>
                  ws.send(
                    JSON.stringify({
                      type: 'conversation.item.input_audio_transcription.completed',
                      item_id: id,
                      content_index: 0,
                      transcript: `第${sequence}段 API 今天不部署，budget 是 USD 30。`,
                    }),
                  );
                return;
              }
              if (holdActiveFinal && connection === 2) {
                expect(releaseActiveFinal).toBeNull();
                releaseActiveFinal = () =>
                  ws.send(
                    JSON.stringify({
                      type: 'conversation.item.input_audio_transcription.completed',
                      item_id: id,
                      content_index: 0,
                      transcript: `第${sequence}段 API 今天不部署，budget 是 USD 30。`,
                    }),
                  );
                return;
              }
              ws.send(
                JSON.stringify({
                  type: 'conversation.item.input_audio_transcription.completed',
                  item_id: id,
                  content_index: 0,
                  transcript: `第${commits}段 API 今天不部署，budget 是 USD 30。`,
                }),
              );
            }
          });
        });
        if (scenario === 'qualified renewal')
          await context.addInitScript(installRenewalResourceObserver);
        await context.addInitScript(
          ({ captureTimings, overlapSpeech }) => {
            const observed: Record<string, number> = {};
            Object.defineProperty(window, '__pureCaptionObserved', { value: observed });
            if (captureTimings)
              window.addEventListener('DOMContentLoaded', () => {
                new MutationObserver(() => {
                  for (const node of document.querySelectorAll(
                    '[data-testid="pure-history-line"], [data-testid="pure-live-text"], [data-testid="pure-session-status"]',
                  )) {
                    const text = node.textContent ?? '';
                    if (text && !observed[text] && Object.keys(observed).length < 128)
                      observed[text] = Date.now();
                  }
                }).observe(document.body, { childList: true, subtree: true, characterData: true });
              });
            let acquisitions = 0;
            const tracks: MediaStreamTrack[] = [];
            Object.defineProperty(window, '__pureCaptureAcquisitions', { get: () => acquisitions });
            Object.defineProperty(window, '__pureLiveTracks', {
              get: () => tracks.filter((track) => track.readyState === 'live').length,
            });
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
            navigator.mediaDevices.getUserMedia = async () => {
              acquisitions++;
              const ctx = new AudioContext({ sampleRate: 48000 }),
                dest = ctx.createMediaStreamDestination();
              const data = await fetch('/test-speech.wav').then((r) => r.arrayBuffer()),
                buffer = await ctx.decodeAudioData(data);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.loop = true;
              source.loopEnd = Math.min(12, buffer.duration);
              if (overlapSpeech) {
                // The fixture starts with eight seconds of silence. Keep real speech
                // across adoption so new PCM can overlap the five-second old tail;
                // otherwise model startup can place adoption at the silent loop boundary.
                const samples = buffer.getChannelData(0);
                const firstSpeech = samples.findIndex((sample) => Math.abs(sample) > 0.01);
                if (firstSpeech >= 0 && firstSpeech / buffer.sampleRate < source.loopEnd)
                  source.loopStart = firstSpeech / buffer.sampleRate;
              }
              source.connect(dest);
              await ctx.resume();
              source.start();
              tracks.push(...dest.stream.getTracks());
              dest.stream.getTracks().forEach((t) =>
                t.addEventListener('ended', () => {
                  source.stop();
                  void ctx.close();
                }),
              );
              return dest.stream;
            };
          },
          {
            captureTimings: scenario === 'qualified renewal' || timedHandoff,
            overlapSpeech: retiringFinal || timedHandoff,
          },
        );
        await page.goto(origin);
        await page.getByRole('textbox', { name: '會議名稱' }).fill(meetingName);
        await page.getByRole('combobox', { name: '雲端轉寫' }).selectOption(provider);
        await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
        await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕', {
          timeout: 30000,
        });
        // Retiring cases hold the old final until adoption/failure is exercised.
        // Waiting for an unrelated new final can outlive the five-second drain.
        if (!retiringFinal)
          await expect(page.getByTestId('pure-history-line').first()).toContainText('API', {
            timeout: 45000,
          });
        if (crossProvider) {
          const before = commits;
          faultAt = Date.now();
          closePrimary!();
          if (timedHandoff) {
            await expect(page.getByTestId('pure-live-text')).toHaveText('新主線辨識中', {
              timeout: 15000,
            });
            await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕');
            const observed = await page.evaluate(
              () =>
                (window as Window & { __pureCaptionObserved: Record<string, number> })
                  .__pureCaptionObserved,
            );
            const detectedAt = Object.entries(observed).find(([text]) =>
              text.startsWith('連線中斷'),
            )?.[1];
            expect(detectedAt).toBeDefined();
            handoffTiming = {
              faultAt,
              detectedAt: detectedAt!,
              readyAt: candidateReadyWallAt!,
              firstPcmAt: candidateFirstPcmWallAt!,
              effectiveSentAt: effectiveSentAt!,
              effectiveDomAt: observed['新主線辨識中']!,
            };
            await writeFile(
              info.outputPath('handoff-timing.json'),
              JSON.stringify(
                {
                  provider,
                  ...handoffTiming,
                  audioSha256: process.env.PURE_TEST_AUDIO_SHA256,
                  userAgent: await page.evaluate(() => navigator.userAgent),
                  scope:
                    'Controlled upstream partial on actual new PCM; fault injection to DOM, not real-cloud or normalized-event latency',
                },
                null,
                2,
              ),
            );
          } else if (scenario === 'cross-provider both refused') {
            await expect.poll(() => mintCalls[provider], { timeout: 15000 }).toBe(2);
            expect(mintCalls[alternate]).toBe(1);
            await expect(page.getByTestId('pure-session-status')).toContainText('需要人工處理');
            await page.waitForTimeout(6000);
            expect(mintCalls).toEqual({ [provider]: 2, [alternate]: 1 });
            expect(candidateFrames).toBe(0);
          } else if (scenario === 'cross-provider Stop') {
            await expect.poll(() => connections).toBe(2);
            expect(candidateFrames).toBe(0);
          } else {
            await expect.poll(() => candidateFirstText, { timeout: 30000 }).not.toBeNull();
            await expect(
              page.getByTestId('pure-history-line').filter({ hasText: candidateFirstText! }),
            ).toHaveCount(1);
            const active = scenario === 'cross-provider refused' ? provider : alternate;
            await expect(page.getByTestId('pure-session-status')).toContainText(
              active === 'gemini' ? 'Gemini' : 'OpenAI',
            );
            expect(commits).toBeGreaterThan(before);
            expect(connections).toBe(2);
            expect(mintCalls[alternate]).toBe(1);
          }
          expect(
            await page.evaluate(
              () =>
                (window as Window & { __pureCaptureAcquisitions: number })
                  .__pureCaptureAcquisitions,
            ),
          ).toBe(1);
          rejectEvents = false;
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
          const stoppedFrames = frames;
          const stoppedMints = { ...mintCalls };
          await page.waitForTimeout(5000);
          expect(frames).toBe(stoppedFrames);
          expect(mintCalls).toEqual(stoppedMints);
          expect(
            await page.evaluate(
              () => (window as Window & { __pureLiveTracks: number }).__pureLiveTracks,
            ),
          ).toBe(0);
          await page.reload();
          await page
            .getByRole('region', { name: '完整會議逐字稿' })
            .getByRole('button', { name: meetingName, exact: true })
            .click();
          const rawDownload = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出完整原始紀錄 JSON' }).click();
          const raw = JSON.parse(await readFile((await (await rawDownload).path())!, 'utf8')) as {
            metadata: {
              meeting: { meetingId: string; captionTask: unknown };
              manifest: MeetingManifest;
              timingPrecision: string;
            };
            events: MeetingEnvelope[];
          };
          expect(raw.metadata.meeting.captionTask).toEqual({
            purpose: 'transcription',
            inputLanguages: ['zh-tw', 'en'],
            textPolicy: 'zh-TW-preserve-original',
          });
          expect(new Set(raw.events.map((event) => event.meetingId))).toEqual(
            new Set([raw.metadata.meeting.meetingId]),
          );
          expect(raw.events.some((event) => event.payload.kind === 'translation')).toBe(false);
          expect(savedGaps.size).toBeGreaterThan(0);
          expect(raw.metadata.manifest.meetingId).toBe(raw.metadata.meeting.meetingId);
          expect(raw.metadata.manifest.gaps).toEqual([...savedGaps.values()]);
          expect(
            raw.events
              .filter((event) => event.payload.kind === 'gap')
              .map((event) => event.payload.gap),
          ).toEqual([...savedGaps.values()]);
          expect(raw.metadata.timingPrecision).toBe('estimated');
          for (const gap of raw.metadata.manifest.gaps) {
            expect(gap.meetingId).toBe(raw.metadata.meeting.meetingId);
            expect(gap.alignment).toBe('estimated');
            expect(gap.state).toBe('unrecoverable');
            if (handoffTiming && 'startSample' in gap) {
              const epoch = Date.parse(gap.captureEpoch);
              const start = epoch + gap.startSample / (gap.sampleRate / 1000);
              const end = epoch + gap.endSample / (gap.sampleRate / 1000);
              expect(start).toBeGreaterThanOrEqual(faultAt!);
              expect(end).toBeGreaterThanOrEqual(start);
              expect(end).toBeLessThanOrEqual(handoffTiming.effectiveDomAt);
            }
          }
          await writeFile(
            info.outputPath('handoff-accounting.json'),
            JSON.stringify(
              { provider, scenario, handoffTiming, metadata: raw.metadata, events: raw.events },
              null,
              2,
            ),
          );
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出校訂版 TXT' }).click();
          const exported = await readFile((await (await download).path())!, 'utf8');
          expect(
            Array.from(exported.matchAll(/第(\d+)段 API/g), (m) => Number(m[1])).sort(
              (a, b) => a - b,
            ),
          ).toEqual(Array.from({ length: commits }, (_, i) => i + 1));
          expect(errors).toEqual([]);
          expect(forbidden).toEqual([]);
          if (handoffTiming) {
            expect(handoffTiming.effectiveDomAt - handoffTiming.faultAt).toBeLessThanOrEqual(3000);
            expect(handoffTiming.readyAt).toBeGreaterThanOrEqual(handoffTiming.detectedAt);
            expect(handoffTiming.firstPcmAt).toBeGreaterThanOrEqual(handoffTiming.readyAt);
            expect(handoffTiming.effectiveDomAt).toBeGreaterThanOrEqual(
              handoffTiming.effectiveSentAt,
            );
          }
          return;
        }
        if (retiringFinal) {
          rejectEvents = false;
          await expect
            .poll(() => candidateFrames, { timeout: 30000, intervals: [50] })
            .toBeGreaterThan(0);
          await expect.poll(() => releaseTail !== null, { intervals: [50] }).toBe(true);
          expect(primaryAliveAtCandidateReady).toBe(true);
          expect(candidateBeforeReady).toBe(0);
          if (scenario === 'retiring final after active failure') {
            closeCandidate!();
            // A third connection proves the owner advanced generation after failure.
            await expect.poll(() => connections, { timeout: 4000, intervals: [50] }).toBe(3);
          }
          expect(primaryClosed).toBe(false);
          if (liveIsolation) {
            await expect(page.getByTestId('pure-live-text')).toHaveText('新主線辨識中');
            sendRetiredPartial!();
            // Allow queued websocket events and a visible frame before checking isolation.
            await page.waitForTimeout(100);
            await expect(page.getByTestId('pure-live-text')).toHaveText('新主線辨識中');
          }
          await info.attach('retiring-final-timing', {
            body: JSON.stringify({
              provider,
              scenario,
              candidateReadyAt,
              candidateFirstPcmAt,
              tailReleasedAt: performance.now(),
              connections,
            }),
            contentType: 'application/json',
          });
          expect(performance.now() - candidateReadyAt!).toBeLessThan(5000);
          releaseTail!();
          await expect(
            page.getByTestId('pure-history-line').filter({ hasText: `第${tailSequence}段 API` }),
          ).toHaveCount(1);
          if (liveIsolation) {
            await expect(page.getByTestId('pure-live-text')).toHaveText('新主線辨識中');
            holdActiveFinal = false;
            releaseActiveFinal?.();
          }
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
          await expect(page.getByTestId('persistence-status').locator('strong')).toHaveText(
            '已保存，逐字稿尚待核對',
          );
          await expect.poll(() => primaryClosed).toBe(true);
          await page.reload();
          await page
            .getByRole('region', { name: '完整會議逐字稿' })
            .getByRole('button', { name: meetingName, exact: true })
            .click();
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出校訂版 TXT' }).click();
          const exported = await readFile((await (await download).path())!, 'utf8');
          expect(
            Array.from(exported.matchAll(/第(\d+)段 API/g), (m) => Number(m[1])).sort(
              (a, b) => a - b,
            ),
          ).toEqual(Array.from({ length: commits }, (_, i) => i + 1));
          expect(errors).toEqual([]);
          expect(forbidden).toEqual([]);
          return;
        }
        if (candidateFault) {
          rejectEvents = false;
          await expect.poll(() => connections, { timeout: 20000 }).toBe(2);
          expect(primaryClosed).toBe(false);
          if (scenario !== 'candidate Stop') {
            await expect.poll(() => candidateClosed, { timeout: 20000 }).toBe(true);
            expect(primaryClosed).toBe(false);
            const before = frames;
            await expect.poll(() => frames, { timeout: 15000 }).toBeGreaterThan(before);
            await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕');
          }
          expect(candidateFrames).toBe(0);
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
          await expect(page.getByTestId('persistence-status').locator('strong')).toHaveText(
            '已結案保存',
          );
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as Window & { __pureLiveTracks: number }).__pureLiveTracks,
              ),
            )
            .toBe(0);
          const stoppedConnections = connections;
          const stoppedFrames = frames;
          await page.waitForTimeout(16000);
          expect(connections).toBe(stoppedConnections);
          expect(frames).toBe(stoppedFrames);
          expect(primaryClosed).toBe(true);
          if (scenario !== 'candidate refused') expect(candidateClosed).toBe(true);
          expect(errors).toEqual([]);
          expect(forbidden).toEqual([]);
          await page.reload();
          const archive = page.getByRole('region', { name: '完整會議逐字稿' });
          await archive.getByRole('button', { name: meetingName, exact: true }).click();
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出校訂版 TXT' }).click();
          const file = await download;
          const exported = await readFile((await file.path())!, 'utf8');
          expect(
            Array.from(exported.matchAll(/第(\d+)段 API/g), (match) => Number(match[1])),
          ).toEqual(Array.from({ length: commits }, (_, i) => i + 1));
          return;
        }
        if (!pureSoakMinutes) {
          await expect(page.getByTestId('persistence-status')).toContainText('已暫停自動重送');
          const before = frames;
          await page.waitForTimeout(1600);
          // VAD legitimately sends nothing during the fixture's silent tail. Wait
          // for the next utterance in its 12s loop, not continuous network frames.
          await expect.poll(() => frames, { timeout: 15000 }).toBeGreaterThan(before);
          expect(rejectedRequests).toBe(1);
          rejectEvents = false;
          // Stop/save below is the explicit retry; the queue must survive refusal.
        }
        // Exercise renewal of the 15s single-writer lease while native capture runs.
        if (pureSoakMinutes)
          await observePureSoak(page, info, provider, () => ({ frames, commits, connections }));
        else await page.waitForTimeout(16000);
        if (renewal) {
          await expect.poll(() => candidateFrames, { timeout: 30000 }).toBeGreaterThan(0);
          expect(connections).toBe(2);
          expect(primaryAliveAtCandidateReady).toBe(true);
          expect(candidateBeforeReady).toBe(0);
          expect(
            await page.evaluate(
              () =>
                (window as Window & { __pureCaptureAcquisitions: number })
                  .__pureCaptureAcquisitions,
            ),
          ).toBe(1);
          await expect.poll(() => candidateFirstText, { timeout: 30000 }).not.toBeNull();
          await expect(
            page.getByTestId('pure-history-line').filter({ hasText: candidateFirstText! }),
          ).toHaveCount(1);
          const domObservedAt = await page.evaluate((text) => {
            const observed = (window as Window & { __pureCaptionObserved: Record<string, number> })
              .__pureCaptionObserved;
            return Object.entries(observed).find(([value]) => value.includes(text))?.[1] ?? null;
          }, candidateFirstText!);
          expect(domObservedAt).not.toBeNull();
          expect(candidateFirstTextSentAt).not.toBeNull();
          expect(domObservedAt!).toBeGreaterThanOrEqual(candidateFirstTextSentAt!);
          renewalTiming = {
            readyAt: candidateReadyWallAt!,
            firstPcmAt: candidateFirstPcmWallAt!,
            firstTextSentAt: candidateFirstTextSentAt!,
            firstTextDomAt: domObservedAt!,
            wireFinalToDomMs: domObservedAt! - candidateFirstTextSentAt!,
          };
          await info.attach('renewal-progress', {
            body: JSON.stringify({
              provider,
              candidateReadyAt,
              candidateFirstPcmAt,
              candidateTextObservedAt: performance.now(),
              candidateFirstTextSentAt,
              candidateDomObservedAt: domObservedAt,
              candidateFrames,
              candidateBeforeReady,
              primaryAliveAtCandidateReady,
            }),
            contentType: 'application/json',
          });
        }
        await page.getByRole('button', { name: '停止並保存', exact: true }).click();
        await expect(page.getByTestId('persistence-status').locator('strong')).toHaveText(
          connections > 1 ? '已保存，逐字稿尚待核對' : '已結案保存',
          { timeout: 15000 },
        );
        await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
        await expect(page.getByTestId('persistence-status')).toContainText(
          connections > 1 ? '已知缺口' : '已結案保存',
          {
            timeout: 15000,
          },
        );
        expect(frames).toBeGreaterThan(0);
        expect(nonzero).toBeGreaterThan(0);
        expect(commits).toBeGreaterThan(0);
        expect(errors).toEqual([]);
        expect(forbidden).toEqual([]);
        if (scenario === 'qualified renewal') {
          const resources = await page.evaluate(
            () =>
              (window as Window & { __pureRenewalResources: RenewalResources })
                .__pureRenewalResources,
          );
          await writeFile(
            info.outputPath('renewal-resources.json'),
            JSON.stringify(
              {
                provider,
                candidateCreatedAt,
                ...renewalTiming,
                resources,
                userAgent: await page.evaluate(() => navigator.userAgent),
                audioSha256: process.env.PURE_TEST_AUDIO_SHA256,
                scope:
                  'Worklet lifecycle and main-thread responsiveness; not isolated VAD CPU or total process memory',
              },
              null,
              2,
            ),
          );
          expect(resources.overflow).toBe(false);
          expect(resources.worklets).toHaveLength(2);
          expect(resources.workers).toHaveLength(2);
          expect(resources.workers.every((worker) => worker.terminatedAt !== null)).toBe(true);
          for (const worklet of resources.worklets) {
            expect(worklet.frames).toBeGreaterThan(0);
            expect(worklet.disconnectedAt).not.toBeNull();
          }
          expect(
            resources.longTasks.filter(
              (task) => task.at >= candidateCreatedAt! && task.at <= renewalTiming!.firstTextDomAt,
            ),
          ).toEqual([]);
        }
        await page.reload();
        const archive = page.getByRole('region', { name: '完整會議逐字稿' });
        await archive.getByRole('button', { name: meetingName, exact: true }).click();
        if (provider === 'openai' && scenario === 'baseline' && !pureSoakMinutes) {
          const downloading = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出完整原始紀錄 JSON' }).click();
          const raw = JSON.parse(await readFile((await (await downloading).path())!, 'utf8')) as {
            events: MeetingEnvelope[];
          };
          const ranges = raw.events.flatMap(({ payload }) =>
            payload.kind === 'transcript' && payload.status === 'final' && payload.inputAudioRange
              ? [payload.inputAudioRange]
              : [],
          );
          expect(ranges.length).toBeGreaterThan(0);
          for (const range of ranges) {
            expect(range.sampleRate).toBe(16000);
            expect(range.captureEpoch).not.toBe('');
            expect(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to)).toBe(true);
            expect(range.to).toBeGreaterThan(range.from);
          }
          await writeFile(
            info.outputPath('input-audio-ranges.json'),
            JSON.stringify(ranges, null, 2),
          );
        }
        if (scenario === 'qualified renewal') {
          const downloading = page.waitForEvent('download');
          await page.getByRole('button', { name: '匯出完整原始紀錄 JSON' }).click();
          const raw = JSON.parse(await readFile((await (await downloading).path())!, 'utf8')) as {
            metadata: {
              meeting: { meetingId: string };
              manifest: MeetingManifest;
              timingPrecision: string;
            };
            events: MeetingEnvelope[];
          };
          expect(savedGaps.size).toBe(1);
          expect(raw.metadata.manifest.gaps).toEqual([...savedGaps.values()]);
          expect(
            raw.events
              .filter((event) => event.payload.kind === 'gap')
              .map((event) => event.payload.gap),
          ).toEqual([...savedGaps.values()]);
          expect(raw.metadata.timingPrecision).toBe('estimated');
          const gap = raw.metadata.manifest.gaps[0]!;
          expect(gap.meetingId).toBe(raw.metadata.meeting.meetingId);
          expect(gap.alignment).toBe('estimated');
          expect(gap.state).toBe('unrecoverable');
          expect('startSample' in gap).toBe(true);
          if ('startSample' in gap) {
            const epoch = Date.parse(gap.captureEpoch);
            const start = epoch + gap.startSample / (gap.sampleRate / 1000);
            const end = epoch + gap.endSample / (gap.sampleRate / 1000);
            expect(start).toBeGreaterThanOrEqual(renewalTiming!.readyAt);
            expect(end).toBeGreaterThanOrEqual(start);
            expect(end).toBeLessThanOrEqual(renewalTiming!.firstTextDomAt);
          }
          expect(raw.metadata.manifest.unfinishedTurns).toEqual([]);
          await info.attach('renewal-gap', {
            body: JSON.stringify(gap),
            contentType: 'application/json',
          });
          await writeFile(
            info.outputPath('renewal-accounting.json'),
            JSON.stringify(
              {
                provider,
                timing: renewalTiming,
                gap,
                scope: 'Controlled upstream; wall-clock estimated gap, not measured missing PCM',
              },
              null,
              2,
            ),
          );
        }
        await expect(archive.locator('.pure-archive-segment').first()).toContainText('USD 30');
        await archive.getByRole('button', { name: '校訂', exact: true }).first().click();
        await page
          .getByRole('textbox', { name: '校訂文字' })
          .fill('今天不部署，API budget 是 USD 30。人工確認。');
        await page.getByRole('button', { name: '保存校訂', exact: true }).click();
        await expect(page.getByRole('textbox', { name: '校訂文字' })).toHaveCount(0);
        await expect(archive.locator('.pure-archive-segment').first()).toContainText('人工確認');
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: '匯出校訂版 TXT' }).click();
        const file = await download;
        const path = await file.path();
        expect(await readFile(path!, 'utf8')).toContain('人工確認');
        const exportedSequences = Array.from(
          (await readFile(path!, 'utf8')).matchAll(/第(\d+)段 API/g),
          (match) => Number(match[1]),
        );
        // The first finalized segment was deliberately replaced by the correction.
        // Every other upstream final must survive storage, reload and export once.
        expect(exportedSequences).toEqual(Array.from({ length: commits - 1 }, (_, i) => i + 2));
        if (provider === 'gemini' && !pureSoakMinutes)
          expect(await readFile(path!, 'utf8')).toContain('尾段驗證：金額不是三百美元。');
        await page.getByRole('button', { name: '重試保存／結案' }).click();
        await expect(page.getByTestId('persistence-status').locator('strong')).toHaveText(
          connections > 1 ? '已保存，逐字稿尚待核對' : '已結案保存',
          { timeout: 15000 },
        );
        await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆');
        await expect(page.getByTestId('persistence-status')).toContainText(
          connections > 1 ? '已知缺口' : '已結案保存',
        );
        if (!pureSoakMinutes && provider === 'openai' && !renewal) {
          suppressFinal = true;
          const before = frames;
          await archive
            .locator('li')
            .filter({
              has: page.getByRole('button', { name: meetingName, exact: true }),
            })
            .getByRole('button', { name: '繼續此會議' })
            .click();
          await expect.poll(() => frames, { timeout: 30000 }).toBeGreaterThan(before + 10);
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('persistence-status')).toContainText('已知缺口', {
            timeout: 15000,
          });
          await expect(page.getByTestId('persistence-status')).not.toContainText('已結案保存');
          suppressFinal = false;
          dropReceipts = true;
          await page.getByRole('textbox', { name: '會議名稱' }).fill('openai crash recovery');
          await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
          await expect.poll(() => receiptLost, { timeout: 45000 }).toBe(true);
          const crashTurn = commits;
          const cdp = await context.newCDPSession(page),
            crashed = page.waitForEvent('crash');
          void cdp.send('Page.crash').catch(() => {});
          await crashed;
          await page.close();
          dropReceipts = false;
          page = await context.newPage();
          await page.goto(origin);
          // A crashed owner has no release request: wait for its real 15s lease to expire.
          await page.waitForTimeout(16000);
          const row = page
            .getByRole('region', { name: '完整會議逐字稿' })
            .locator('li')
            .filter({
              has: page.getByRole('button', { name: 'openai crash recovery', exact: true }),
            });
          await row.getByRole('button', { name: '繼續此會議' }).click();
          await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕', {
            timeout: 30000,
          });
          await page.getByRole('button', { name: '停止並保存', exact: true }).click();
          await expect(page.getByTestId('persistence-status')).toContainText('待保存 0 筆', {
            timeout: 15000,
          });
          await expect(page.getByTestId('persistence-status')).toContainText('已知缺口');
          await page.getByRole('button', { name: 'openai crash recovery', exact: true }).click();
          await expect(
            page.locator('.pure-archive-segment').filter({ hasText: `第${crashTurn}段 API` }),
          ).toHaveCount(1);
        }
        for (const width of [360, 1280]) {
          await page.setViewportSize({ width, height: 720 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await expect(page.getByRole('button', { name: '全螢幕', exact: true })).toBeVisible();
          await page.screenshot({ path: `.cache/pure-e2e-results/${provider}-${width}.png` });
        }
        await page.getByRole('button', { name: '全螢幕', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
          .toBe(true);
        await page.evaluate(() => document.exitFullscreen());
        await page.screenshot({
          path: `.cache/pure-e2e-results/${provider}-archive.png`,
          fullPage: true,
        });
      });
  });
