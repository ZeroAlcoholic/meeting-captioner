# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

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

## Backlog (later phases)

- [ ] P5 — Research: Voxtral (Mistral) and Speaches as alternative ASR backends; evaluate streaming support, Windows compatibility, and quality vs distil-large-v3
- [ ] P5 — Summary pipeline draft / refined / stable
- [ ] P5 — Optional in-app autosave (opt-in)
- [ ] P5 — localStorage / IndexedDB settings persistence (P1-D6)
- [ ] P6 — Long-running memory test harness
- [ ] P6 — Reconnect / silence / no-audio-track real handling
- [ ] P7 — Electron packaging
- [ ] P7 — Sidecar lifecycle (Electron main spawning online + offline)
