# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

### Phase 1 closure — one external verification remains (2026-07-30)

- [x] Gemini setup waits for `setupComplete`, uses only the exact dedicated
      translate model, and has no silent native-audio fallback (`13f6311`).
- [x] Transcript retention is opt-in/default-off with race-safe IndexedDB
      deletion (`c587fc2`).
- [x] Active sessions lock mode/scenario/backend/language; Stop releases capture
      and transport before switching (`7dd2362`).
- [x] Offline MT uses a bounded ordered dispatcher and cannot cap-wait inside
      the transcript receive loop (`b67d810`).
- [x] Production offline services are loopback-only and do not use reload
      (`2adcd78`).
- [x] Full local release matrix is green; formatting and lint gates are restored
      (`171c05b`).
- [ ] With explicit credential authorization, run
      `pnpm -F @meeting-audio/online probe:upstream-contracts`, inspect the two
      redacted fixtures, rerun the matrix, and only then mark Phase 1 complete.

**Gemini latency root-cause closure (2026-07-02) complete.**

- Official-docs research settled it: the translate model has NO latency knob
  (translationConfig = targetLanguageCode + echoTargetLanguage only; no TEXT
  modality / speed / thinking / effective VAD). ~2–3 s lag is structural
  (caption text is paced by translated-audio generation; LiveLingo measured
  ~2.9 s median). Client stack already meets all official best practices.
- Shipped: pending-source live caption (big area shows arrived source text,
  dimmed + 翻譯中… tag, during the translation-lag window) + honest ~2–3 s
  labeling on the Gemini backend option + e2e getAudioTracks mock fix.
- Do NOT revisit `gemini-3.1-flash-live-preview` as a "faster" path — it was
  the original backend and was replaced because turn-based VAD waits are worse
  for continuous meeting speech. Re-evaluate only if Google ships a new
  translate model variant (watch the models page).

**Gemini per-utterance latency fix (2026-06-29) complete.**

- Reverted Gemini Live Translate from the earlier cost-saving `TEXT` modality to
  the official speed-first `AUDIO` response modality, while still using
  `outputAudioTranscription` for text captions and discarding synthesized audio.
- Kept 512-sample / 32 ms PCM chunks; current evidence points to Gemini
  translation cadence and live-render anchoring, not client audio framing.
- Added output-first live anchoring: `outputTranscription` now emits a matching
  partial transcript anchor before its draft translation, so Gemini captions can
  render immediately even if `inputTranscription` arrives later.
- Next manual check: rerun the same YouTube field test and compare Gemini
  `ttfcMs`, `durP50`, and visible stalls against the prior cadence.

**Project KEEPALIVE — 永續雙模型字幕強化 (2026-06-12) complete.**
Dual-model reliability/continuity: 多元模型 · 不會斷 · 可接續.

- **#16** Gemini wedge detection + persistent reconnect (parity with OpenAI).
- **#7** OpenAI zero-gap renewal (make-before-break, mic-stream reuse).
- **#21** Cross-model one-click failover (`FailoverBanner`, transcript preserved).
- **#3** History tail-window render cap (`tailSegments`, 400) — store keeps full.
- **#19** verified `pcm-worklet.js` ships in `package-online` zip.
- 238 web unit tests + 15 Playwright e2e (real Chromium) green; typecheck +
  online build + package-online clean. See PROJECT_STATE.md "Project KEEPALIVE".
- **Deferred — #8 Gemini meeting-mode noise suppression**: needs real
  multi-speaker meeting audio to tune (Gemini lacks OpenAI's server far_field
  NR; blindly enabling browser NS risks gating non-dominant speakers). Do NOT
  implement without an A/B on real room audio.
- **Manual-only checks** (no live keys in CI): cross-model failover happy-path
  and 30–60 min soak — procedures in `RUNBOOK.md`.

**KEEPALIVE test-engineering (T0 → T1 → T2, 2026-06-12) complete.** The
previously manual-only reliability checks are now automated:

- **T0** mock-backend fault-injection e2e — `tests/e2e/online-mock.ts` (in-browser
  mock for both providers, no key) + `online-keepalive.spec.ts` (5 tests):
  zero-gap renewal (mic reused once), repeated renewals never blank,
  OpenAI-fail → failover-to-Gemini with transcript preserved, Gemini reconnect.
- **T1** soak — `caption-store.soak.test.ts` (5 000-turn + 200-session bounds &
  reference-stability invariants).
- **T2** conformance — `provider-conformance.test.ts` (every provider event vs
  `NormalizedEvent`) + `paragraph-grouping.property.test.ts` (seeded-PRNG props).
- Lint hygiene: `eslint.config.js` ignores `release/**`, disables base `no-undef`
  for TS, AudioWorklet globals for `pcm-worklet.js`. `pnpm lint` clean.
- **251 web unit + 20 e2e green; typecheck + lint clean.**

---

**Easy-start launcher + crash-continue + IDB capacity (2026-06-11) complete.**
Single-session focus, easy to start different settings.

- **Easy-start launcher**: `SessionLauncher` empty-state grid — one-click start
  for OpenAI/Gemini/Hybrid/Offline/Demo, each selecting its config + starting
  (no Settings detour); availability-aware.
- **Crash-continue**: persisted `sessionMode`/`sessionPhase`; `ContinueBanner`
  on reload of an interrupted/paused session → ▶ 繼續 resumes the same backend,
  transcript preserved.
- **IndexedDB capacity**: IDB primary async store; `maxSegments` 3000 → 20000;
  localStorage kept as the synchronous crash net (2000-segment tail);
  load-time merge; persist v3 → v4.
- 220 web tests (+8), typecheck + build clean, full crash-continue lifecycle
  browser-verified. See `PROJECT_STATE.md` "Easy-start launcher + crash-continue
  - IndexedDB capacity".
- Follow-up: multi-session history browser (deferred per user — single-session).

**Robustness pass (2026-06-11) complete.** Following durability hardening:

- **Offline/Hybrid wall-clock timeline rebase** — fixes the documented P6
  follow-up. WHL connection-relative `startMs` (resets to 0/connection) is now
  shifted onto wall-clock per connection in `offline-stt-provider.ts`. Fixes (a)
  export/time-gutter timestamps clamping to 0:00 for offline, and (b) reconnect/
  Resume segments sorting to the front of history. Monotonic across drops.
- **Autosave no-silent-failure** — `writeSnapshot` warns once on QuotaExceeded/
  storage-unavailable instead of swallowing; in-memory unaffected.
- 212 web tests (+2), typecheck + build clean. See `PROJECT_STATE.md`
  "Robustness pass — offline timeline + autosave honesty".
- Remaining (features, not hardening): crash-**continue** (Resume survives
  reload); IndexedDB tier for multi-session history.

**Transcript durability hardening (2026-06-11) complete.** Interruption-state
safety for the transcript log (summary deferred per user). Added
`captionStore.flushNow()` — synchronous localStorage write that folds the
in-flight `livePartial`/`liveTranslation` onto disk; wired to `pagehide` /
`visibilitychange→hidden` and to graceful Stop/Pause. Closes the debounce-window

- unfinalized-utterance loss on crash / tab-close. 210 web tests, typecheck +
  build clean. See `PROJECT_STATE.md` "Transcript durability hardening".
  Follow-up candidates: IndexedDB backup for >5 MB / multi-session history;
  explicit "continue after crash" (Resume survives reload).

**Field-feedback pass (2026-06-08) complete.** Three reported issues fixed —
see `PROJECT_STATE.md` "Field-feedback pass":

- Online speaker-switch recognition → new default `'meeting'` acoustic profile
  (browser DSP off + OpenAI far_field). **Needs real-meeting verification.**
- No Pause → added Pause/Resume that preserves the transcript log (no clear).
- History not auto-scrolling → `ResizeObserver` re-pin on pane/content resize.
- 190 web / 42 online vitest, typecheck + build clean.
- Follow-up: offline/hybrid Resume timestamp ordering (WHL restarts at 0/conn).

**Robustness audit (2026-05-23) complete.** See `PROJECT_STATE.md` for full
change log. Summary: PCM ring buffer (~32× GC reduction), WASAPI drop-counter
thread-safety fix, UUID segment IDs, healthz `model_loading` state,
`OFFLINE_CORS_ORIGIN` env var. 50 Python + all TS tests green.

P3 complete. **CaptionBoard v3 (UX overhaul)** delivered out-of-band on top of P3.5:

- Split paragraph streams (ZH and EN each grouped by their own punctuation)
- Per-paragraph elapsed-time gutter (M:SS, derived from first segment's startMs)
- Live caption weight 300 → 500 (readable at 1.5–3m office distance)
- Partial freeze with `translating · …` hint (replaces old target/source desync)
- Live segment picked by max startMs (not array tail) — robust against revised events
- Auto-hidden Export/Clear; cost panel stays in header (visible while online burns money)
- Inline confirm for Clear (replaces native `confirm()`); ref-based to handle rapid double-clicks
- Scroll fix: `margin-top: auto` on first child (top of history reachable when overflowing)
- "↓ N new" pill while scroll-paused
- `prefers-reduced-motion` for cursor and translating-hint pulse
- Caption store: new `sessionStartMs` field (Date.now() at first event) for honest export header
- New helper module `caption-board/paragraph-grouping.ts` with full unit coverage (12 tests)
- 89 web vitest tests green (was 74); typecheck clean

Sandbox prototype at `docs/sandbox/caption-board-v2.html` (lab) + screenshots `v3-*.png`.

Next: P4.

---

## P0 (done)

13 tasks complete. 8 commits in git history. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P0.md`](PLAN_P0.md).

## P1 (done)

11 tasks complete. Web 46 unit + 8 Playwright e2e tests green. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P1.md`](PLAN_P1.md).

## P2 (done)

6 tasks complete. Web 57 unit + online 8 unit + 15 Playwright e2e tests green.
Real OpenAI Realtime WebRTC path wired. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P2.md`](PLAN_P2.md).

## P3 (done)

15 tasks complete (Phase A/B/C). 21 Python + 68 JS tests green.
Full offline pipeline: WHL + CTranslate2 MT + WASAPI loopback + frontend source selector.
See [`PROJECT_STATE.md`](PROJECT_STATE.md).

Commits:

- `9929d52` — fix(offline): distil-large-v3 model, min-words filter, language-aware prompt, glossary pipeline
- `779c213` — refactor(offline): WHL as independent process + structured /healthz + startup scripts
- `44cc3f6` — feat(offline): WASAPI system audio loopback — source selector + capture pipeline

## P4 (partial — 2026-05-23)

- [x] Glossary expanded: 59 → 102 terms (insurance product, regulatory, finance, tech-meeting domains)
- [x] Hybrid Privacy mode wired:
  - `ASRSession(translate_enabled=False)` — offline service does STT only
  - `POST /translate` on online service (GPT-4o-mini) — browser calls for each final segment
  - `useHybridMode` React hook — combines offline STT + online MT
  - `App.tsx` — Hybrid button enabled; shows Whisper readiness like offline button
- [x] Dual-path MT: full_offline uses local CT2; hybrid_privacy uses GPT-4o-mini via online service
- [x] Tests: 52 Python / 41 online / 174 web all green

## P4 (complete — 2026-05-24)

- [x] Glossary expanded: 59 → 102 terms (insurance product, regulatory, finance, tech-meeting domains)
- [x] Hybrid Privacy mode wired (local STT + online MT via GPT-4.1-mini)
- [x] Dual-path MT: full_offline uses local CT2; hybrid_privacy uses GPT-4.1-mini via online service
- [x] Translation confidence scoring: inherits source transcript confidence (avg_logprob → 0-1); propagated through events.py → stabilizer → asr → translation-event schema → caption-store → UI (data-conf dimming already in place)
- [x] e2e WebSocket STT contract tests: test_ws_contract.py (5 tests) + TS provider tests (2 tests)
- [x] Hybrid mode error-path tests: translateOnline returns null on 429/502/network-fail — captions unblocked
- [x] Code review pass (2026-05-24): 0 critical, 2 warnings resolved
- [x] Model upgrade: gpt-4o-mini → gpt-4.1-mini for hybrid MT
- [x] Voxtral / Speaches: deferred to P5 as research task (see backlog)
- [x] Tests: 59 Python / 41 online / 184 web all green; TypeScript clean

## P5-A (complete — 2026-05-24)

- [x] Breeze ASR 25 model mapping in `run_whl.py` (WHL_MODEL=breeze-asr-25)
- [x] `scripts/compare_models.py` — WER/RTF/VRAM comparison harness
- [x] `eval_audio/` — ground truth transcripts for 4 zh-TW/code-switch clips
- [x] B2: token expiry check before SDP exchange (skip SDP if < 60s remaining)
- [x] B4: silence_detected health event after 30s of sub-threshold audio; recovery to connected
- [x] B5: permission denied / API error surfaced to React error state via health event interception
- [x] 4 new provider tests (B2 ×2, B4 ×2); 187 web / 41 online / 59 Python all green

## Backlog (later phases)

- [ ] P5 — Research Voxtral (Mistral) and Speaches as alternative ASR backends;
      evaluate streaming support, Windows compatibility, and quality versus
      distil-large-v3.
- [ ] P5 — Summary pipeline draft / refined / stable.
- [ ] P7 — Electron packaging.
- [ ] P7 — Sidecar lifecycle (Electron main spawning online + offline).
