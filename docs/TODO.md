# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

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

## Next — P4: Translation Quality + ASR Adapters

Goal: production-grade translation output and pluggable ASR backends.

- [ ] Dual-path MT: keep opus-mt as fast path; add higher-quality fallback (evaluate options)
- [ ] Evaluate Voxtral / Speaches as alternative ASR backends behind provider abstraction
- [ ] zh-TW post-processing: expand glossary TSV (current: 16 terms → target: 60+)
- [ ] Translation confidence scoring — surface low-confidence segments in UI
- [ ] Hybrid Privacy mode: local STT → online translation (wire the mode that's currently unimplemented)
- [ ] e2e: mocked WebSocket STT contract test for offline provider

## Backlog (later phases)

- [ ] P5 — Summary pipeline draft / refined / stable
- [ ] P5 — Optional in-app autosave (opt-in)
- [ ] P5 — localStorage / IndexedDB settings persistence (P1-D6)
- [ ] P6 — Long-running memory test harness
- [ ] P6 — Reconnect / silence / no-audio-track real handling
- [ ] P7 — Electron packaging
- [ ] P7 — Sidecar lifecycle (Electron main spawning online + offline)
