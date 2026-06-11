# PROJECT_STATE.md

> Single source of truth for **what is built / in progress / blocked**.
> Update at the end of every meaningful task.
> Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md). Backlog: [`TODO.md`](TODO.md).

---

## Current Phase

**P3 — Offline STT + MT Pipeline** ✅ **COMPLETE** (4 commits on master)

Full offline pipeline is production-ready. WHL runs as independent process (port 9090).
FastAPI service (port 8000) proxies ASR, applies glossary-aware CTranslate2 translation,
and streams normalized events to browser. WASAPI system audio loopback implemented.

---

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| **P0** | Foundation skeleton | ✅ complete |
| **P1** | Scenario picker + Mode selector + Health row + Audio level meter | ✅ complete |
| **P2** | OpenAI Realtime mic path (WebRTC + session bridge) | ✅ complete |
| **P3** | WhisperLiveKit + CTranslate2 MT + WASAPI loopback | ✅ complete |
| **P3.5** | Audit fixes: SPM tokenizer copy, Whisper pre-cache, ApiKey tri-state | ✅ complete |
| **P3.6** | CaptionBoard v3 UX: split paragraph streams + freeze partial + auto-hide chrome | ✅ complete |
| **P3.7** | Online render-hot-path overhaul: store split (live vs final), 50ms coalesce, memo'd Live/History | ✅ complete |
| **P3.8** | Online-slim deliverable: VITE_DEPLOYMENT_MODE flag, single-port release zip (9 MB), renewal-failure recovery | ✅ complete |
| **P3.9** | Robust pass: esbuild single-file bundle (zip 9 MB → 0.78 MB), dotenv override, late-arrival translation routing, concurrent-start guards, start/stop race short-circuit, SPA-fallback asset-404 fix, launcher Node-version checks | ✅ complete |
| **P3.10** | Strict env policy: dotenv removed entirely; OPENAI_API_KEY read from system env ONLY; .env files on disk are intentionally ignored; launchers refuse to start without the env var | ✅ complete |
| **P4** | Glossary (59→102), Hybrid Privacy, dual-path MT, confidence scoring, contract tests, code review, model upgrade (gpt-4.1-mini) | ✅ complete 2026-05-24 |
| **P5-A** | Breeze ASR 25 experiment + Online mode hardening (B2/B4/B5) | ✅ complete 2026-05-24 |
| P5-B | Summary draft/refined/stable pipeline | pending |
| P6 | Reliability + long-session stability | pending |
| P7 | Electron packaging | pending |

---

## P3 Task Status

| # | Task | Status | Commit |
|---|------|--------|--------|
| A1 | distil-large-v3 model (env-configurable via WHL_MODEL) | ✅ done | 9929d52 |
| A2 | AudioLevelEvent polling in OfflineSTTProvider (AnalyserNode) | ✅ done | 9929d52 |
| A3 | Glossary pipeline: apply_source_glossary → MT → restore_placeholders | ✅ done | 9929d52 |
| A4 | MIN_WORDS_TO_TRANSLATE = 3 filter (skip fillers) | ✅ done | 9929d52 |
| A5 | Language-aware initial_prompt dict (en / zh) | ✅ done | 9929d52 |
| B1 | WHL as independent process; TCP probe loop every 5 s | ✅ done | 779c213 |
| B2 | Structured /healthz: components.{asr, translation, audio} + legacy fields | ✅ done | 779c213 |
| B3 | start.bat + start.sh — launch WHL then uvicorn | ✅ done | 779c213 |
| C1 | wasapi_loopback.py: PyAudioWPatch loopback, mono mix, linear resample | ✅ done | 44cc3f6 |
| C2 | /ws handler branches on source:'mic'\|'system' | ✅ done | 44cc3f6 |
| C3 | OfflineAudioSource in settings-store; setAudioSource action | ✅ done | 44cc3f6 |
| C4 | OfflineSTTProvider: audioSource param, skips mic when 'system' | ✅ done | 44cc3f6 |
| C5 | AudioSourceSelector in SettingsPanel (full_offline mode only) | ✅ done | 44cc3f6 |

---

## P3.5 Audit Fixes

| # | Task | Verification |
|---|------|-------------|
| 1 | `download_models.py` passes `copy_files=["source.spm","target.spm"]` to TransformersConverter | both model dirs now have source.spm + target.spm |
| 2 | `run_whl.py` pre-instantiates `WhisperModel(WHL_MODEL,…)` to warm HF cache | first browser session no longer hits 30 s WS timeout |
| 3 | `scripts/smoke_translate.py` validates both translation directions end-to-end | exits 0; en→zh-TW and zh-TW→en both produce non-empty output |
| 4 | `useOpenAIRealtime` exports tri-state `apiKeyStatus` ('checking'\|'present'\|'no-key'\|'service-down') with 3 s polling | mirror of useOfflineSTT pattern; auto-recovers when service comes up |
| 5 | `App.tsx` consumes `apiKeyStatus` for label/title/disabled/pricing-panel gate | distinguishes "no key" from "service down" honestly |

---

## Test Status (as of P3.6)

| Suite | Count | Status |
|-------|-------|--------|
| `services/offline` pytest | 21 | ✅ passed |
| `apps/web` vitest | 89 | ✅ passed (P3.6 added 12 paragraph-grouping + 3 sessionStartMs tests) |
| `services/online` vitest | 10 | ✅ passed |
| Playwright e2e | 15 | ✅ passed (last verified P2) |

---

## P3.6 — CaptionBoard v3 (UX overhaul)

| File | Change |
|------|--------|
| `apps/web/src/store/caption-store.ts` | + `sessionStartMs: number\|null` (Date.now() at first event); persisted (optional) and reset on `clear()` |
| `apps/web/src/store/caption-store.test.ts` | + 3 lifecycle tests for `sessionStartMs` |
| `apps/web/src/caption-board/paragraph-grouping.ts` | NEW — `groupParagraphsForSide({segments, translations, side, accessor})` + `formatElapsedFromStart` |
| `apps/web/src/caption-board/paragraph-grouping.test.ts` | NEW — 12 tests covering ZH/EN punctuation, divergent grouping, U+2009 thin-space, confidence dim, gap-break, format clamp |
| `apps/web/src/caption-board/CaptionBoard.tsx` | Rewrite: split streams, live id by max startMs, partial freeze + translating hint, inline confirm clear (ref-based), pause-pill, anchor-by-first-segment timestamps |
| `apps/web/src/caption-board/CaptionBoard.module.css` | Rewrite: split layout, weight 500 live caption, hover-only chrome with backdrop blur, `margin-top:auto` scroll fix, prefers-reduced-motion |
| `docs/sandbox/caption-board-v2.html` | Interactive lab — current vs proposed split-stream side-by-side comparison |
| `docs/sandbox/v3-*.png` | Visual evidence: en-zh, zh-en, partial freeze, scroll-paused, degraded chip, app-integrated |

**Why P3.6 not P4**: pure UX/correctness layer on top of existing event contracts; no provider, store
schema, or transport changes that would justify a phase bump. Done as out-of-band hardening before
P4 starts. See `docs/TODO.md` for the full bullet list.

---

## What Exists On Disk (P3 additions)

```
services/offline/
├── pyproject.toml              [pyaudiowpatch dep added]
├── start.bat                   [new] Windows launcher: WHL + uvicorn
├── start.sh                    [new] Linux/macOS launcher
├── app/
│   ├── main.py                 [modified] TCP probe loop, structured /healthz, WASAPI branch in /ws
│   ├── capture/
│   │   ├── __init__.py         [new]
│   │   └── wasapi_loopback.py  [new] PyAudioWPatch loopback capture
│   └── pipeline/
│       ├── asr.py              [modified] distil-large-v3, min-words filter, language prompts, push_event()
│       └── translation.py      [modified] glossary masking in translate()
└── tests/
    └── test_healthz.py         [modified] +3 component structure tests

apps/web/src/
├── settings/
│   └── settings-store.ts       [modified] OfflineAudioSource type + audioSource field
├── providers/
│   ├── offline-stt-provider.ts [modified] audioSource param, level polling, source in WS start msg
│   └── use-offline-stt.ts      [modified] reads audioSource, passes to provider
└── components/
    └── SettingsPanel.tsx       [modified] AudioSourceSelector (full_offline only)
```

---

## Architecture (as of P3)

```
Browser (apps/web, port 5173)
  ├── Online Full:  OpenAIRealtimeProvider → services/online (port 3001) → OpenAI Realtime API
  └── Full Offline: OfflineSTTProvider → services/offline (port 8000) /ws
        ├── source:'mic'  → browser AudioWorklet PCM → ASRSession → WHL (port 9090)
        └── source:'system' → wasapi_loopback.py → PyAudioWPatch loopback → ASRSession → WHL

services/offline (FastAPI, port 8000)
  ├── TCP probe loop → WHL port 9090 (5 s interval)
  ├── /healthz → components: {asr, translation, audio}
  └── /ws ASRSession
        ├── WHL → segments → SegmentStabilizer → TranscriptEvent
        └── final segment → glossary mask → CTranslate2 opus-mt → restore → OpenCC → TranslationEvent

services/online (Fastify, port 3001)
  └── POST /session → OpenAI ephemeral token (server-side only, key never in browser)
```

---

## How to Run (P3)

```bash
# Full Offline mode — Terminal 1: start WHL
cd services/offline
start.bat            # Windows: opens WHL in separate window, waits 3s, starts uvicorn
# or:
WHL_MODEL=distil-large-v3 python -m whisper_live.server --port 9090 --backend faster_whisper

# Terminal 2 (if not using start.bat)
uv run uvicorn app.main:app --port 8000 --reload

# Online Full mode — Terminal 3
cd services/online && npm run dev

# Web app — Terminal 4
cd apps/web && npm run dev
```

---

## How to Resume After Session/Model Switch

1. [`../CLAUDE.md`](../CLAUDE.md) — non-negotiable rules
2. Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md)
3. **This file** — done / pending
4. [`TODO.md`](TODO.md) — backlog (now points at P4)
5. [`DECISIONS.md`](DECISIONS.md) — D1–D10 + P2-D*

---

## Active Blockers

None. P3 complete.

---

## P3.7 — Online render-hot-path overhaul

Focus: stable, snappy online captioning. Offline path optimization deferred
(see `MEMORY.md` / decoupling plan). Behavioral evidence the user reported as
"偏慢，使用體感不良" was the per-character partial-delta render storm — every
OpenAI delta (~30 Hz) re-rendered the full CaptionBoard (history paragraph
grouping over up to 500 segments × 2 streams).

| File | Change |
|------|--------|
| `apps/web/src/store/caption-store.ts` | Split state: `segments` (final only) + `livePartial` + `liveTranslation` + `translations` (final only). Partials no longer churn the history ref. Persist version bumped 1→2. |
| `apps/web/src/store/caption-store.test.ts` | Rewritten for new partial/final invariants + ref-stability assertion + liveTranslation promotion flow. 16 tests. |
| `apps/web/src/providers/coalesce-handlers.ts` | NEW — store-bound handlers that coalesce partial transcripts and draft translations to one store update per 50 ms; final/revised-final events bypass the queue. |
| `apps/web/src/providers/coalesce-handlers.test.ts` | NEW — 4 tests covering coalescing, final bypass, queue draining, sync forwarding for health/audio-level. |
| `apps/web/src/providers/use-openai-realtime.ts` | Routes provider events through coalesce handlers; flushes pending on stop. |
| `apps/web/src/providers/use-offline-stt.ts` | Same wiring. |
| `apps/web/src/providers/use-fake-replay.ts` | Same wiring. |
| `apps/web/src/caption-board/CaptionBoard.tsx` | Split into shell + memo'd `HistoryStream` (subscribes to finalized segments only) + memo'd `LiveCaption` (subscribes to live partial/translation). Per-character deltas now re-render only the live area. |
| `apps/web/src/components/MicLevelBar.tsx` | NEW — extracted from App.tsx so the 10 Hz audio-level updates redraw only the header widget. |
| `apps/web/src/App.tsx` | Renders `<MicLevelBar visible={isRunning} />`; no longer subscribes to `audioLevel` at the top level. |

Verification:
- `pnpm -F web test` — 10 files, 98 tests passed
- `pnpm -F online test` — 3 files, 20 tests passed
- `pnpm -F web typecheck` — clean
- `pnpm -F web build` — clean production build

**Why a perf phase, not P4**: pure render/store layering on top of existing
event contracts. No provider, transport, or schema changes that would justify
a phase bump.

---

## P3.8 — Online-slim deliverable

Goal: ship a clean, lightweight online-only build without forking offline
code out of the repo. Build-time `VITE_DEPLOYMENT_MODE=online` swaps offline
modules for stubs via a Vite alias, so the offline path stays in the repo
for P4 work but never enters the online distribution.

| File | Change |
|------|--------|
| `apps/web/src/deployment.ts` | NEW — single source of truth for the build flag. Exposes `DEPLOYMENT_MODE` ('online' \| 'full'), `IS_ONLINE_ONLY`, `IS_FULL`. |
| `apps/web/vite.config.ts` | Reads `VITE_DEPLOYMENT_MODE`, sets `__DEPLOYMENT_MODE__` via `define`, and aliases the virtual module `@meeting-audio/offline-stt` to either `use-offline-stt.real.ts` (full) or `use-offline-stt.stub.ts` (online). |
| `apps/web/src/providers/use-offline-stt.{real,stub}.ts` | Real impl renamed; stub returns inert hook so call sites compile. Stub pulls ZERO offline-only modules — `OfflineSTTProvider`, audio-worklet path, etc. all tree-shaken. |
| `apps/web/src/providers/use-offline-stt.ts` | Barrel that re-exports through the virtual alias. |
| `apps/web/src/types/offline-stt-virtual.d.ts` | TS declaration for the virtual module. |
| `apps/web/src/settings/settings-store.ts` | `MODE_OPTIONS` and `SCENARIO_OPTIONS` filter out hybrid + full_offline when `IS_ONLINE_ONLY`. |
| `apps/web/src/components/StartRealButton.tsx` | NEW — owns the 1 Hz renewal-countdown tick locally so App.tsx no longer re-renders every second. |
| `apps/web/src/providers/use-openai-realtime.ts` | Removed `renewalEtaMs` state; exposes stable `getRenewalEtaMs()` for `StartRealButton`. |
| `apps/web/src/providers/openai-realtime-provider.ts` | Renewal-failure path no longer pretends `_status='running'`. Adds `renewalRetryTimer` cancelled by cleanup so a stale timer can't restart after the user pressed Stop. |
| `apps/web/src/store/caption-store.ts` | Translation pruning now also runs when `segments.length >= maxSegments` so stale entries don't accumulate at-cap. |
| `apps/web/src/config.ts` | In production builds, default `ONLINE_SERVICE_URL` to '' (same-origin) — slim release serves the web from the same port as the API. |
| `apps/web/src/App.tsx` | Wires `StartRealButton`, gates `audio-source-chip` + hybrid/offline buttons on `IS_ONLINE_ONLY`. |
| `services/online/src/config.ts` | `ONLINE_HOST` (default 127.0.0.1 — loopback only for the slim build) + optional `WEB_DIST_PATH`. |
| `services/online/src/server.ts` | Registers `@fastify/static` at `/` when `WEB_DIST_PATH` is set, with an SPA fallback for deep links. |
| `services/online/package.json` | + `@fastify/static`. |
| `scripts/package-online.{ps1,sh}` | NEW — builds web (online flag), builds online service, `pnpm deploy --prod` into `release/meeting-audio-online-<timestamp>/server`, copies the web build into `web/`, drops launchers + `.env.example` + `README.md`, zips. |
| `scripts/release-templates/{start.bat,start.sh,.env.example,README.md}` | NEW — what ships in the zip. |
| `scripts/check-online-bundle.sh` | NEW — slim-bundle audit; greps the built JS for forbidden symbols and asserts size budgets. |
| `apps/web/src/deployment.test.ts` | NEW — locks in default-flag semantics. |
| `.gitignore` | + `release/`. |

### Slim distribution layout (9.0 MB zip)

```
meeting-audio-online/
├── server/                 (Fastify + pnpm-deployed prod deps; ~30 MB extracted)
│   ├── dist/server.js
│   ├── package.json
│   └── node_modules/
├── web/                    (apps/web/dist; pcm-worklet.js stripped)
│   ├── index.html
│   ├── index.css
│   └── index.<hash>.js     (~1.36 MB raw / ~545 KB gzip)
├── start.bat               (Windows: writes .env if missing, then `node server/dist/server.js`)
├── start.sh                (macOS / Linux)
├── .env.example            (OPENAI_API_KEY only; everything else has safe defaults)
└── README.md               (3-step setup)
```

`services/offline/`, the Python interpreter, WhisperLiveKit, model files —
**none ship**. End-user requirements: Node 22+, an OpenAI API key, a
microphone, Chrome/Edge.

### Verification

- `pnpm -F web test` — 11 files, **101 tests passed**
- `pnpm -F online test` — 3 files, 20 tests passed
- `pnpm -F web typecheck` + `pnpm -F online typecheck` — clean
- `scripts/check-online-bundle.sh` — slim bundle 1.36 MB raw / 545 KB gzip, no forbidden symbols
- Smoke test of `release/meeting-audio-online-*/`: `/healthz` returns ok,
  `/` serves index.html, deep route `/foo/bar` falls back to SPA, server
  binds 127.0.0.1 only (loopback)

---

## P3.9 — Robust pass

End-to-end hardening pass after spotting that the 9 MB release zip was
**non-functional** when extracted on a clean machine: pnpm deploy produces
absolute-path symlinks under `node_modules/.pnpm`, and Windows zip tools
do not preserve symlinks, so `@fastify/cors` and every other dep was
"present" as an empty directory after extraction → `ERR_MODULE_NOT_FOUND`
on first launch.

| Fix | Change |
|------|--------|
| **Server bundling** | New `services/online/build-bundle.mjs` (esbuild). Produces a single 785 KB CJS file with EVERY runtime dep inlined. Release zip dropped from 9.0 MB to **0.78 MB**. No node_modules tree to ship, no symlink fragility. |
| **`process.env.LOG_FORMAT`** | New env var; release launchers set `json` so pino doesn't try to load `pino-pretty` (which fails inside a CJS bundle). Dev (`pnpm dev`) keeps pretty logs. |
| **Build-time constants** | `__APP_VERSION__` (read from `package.json` at bundle time) and `__SERVER_BUNDLED__` replace runtime `import.meta.url` lookups that break in CJS bundles. |
| **dotenv override** | `dotenv.config({ override: true })` — end users editing `.env` expect it to win over stale system env vars (e.g. an old `OPENAI_API_KEY` from a forgotten `setx`). |
| **Late-arrival translation routing** | If a translation event arrives BEFORE its transcript partial, it lands in `translations[id]`; when the partial subsequently sets `livePartial`, the prior entry is now promoted to `liveTranslation` and removed from history. Without this, the translation was stranded. |
| **Concurrent start() guards** | All three hooks (`useOpenAIRealtime`, `useOfflineSTT`, `useFakeReplay`) now stop+drain a prior provider instance before creating a new one, and bail out if `providerRef.current !== this provider` after each await. |
| **Provider start/stop race** | `OpenAIRealtimeProvider.start()` checks `this.status === 'running'` after every await (mic, /session fetch, json, createOffer, setLocalDescription, SDP fetch, sdp text, setRemoteDescription). If the user pressed Stop mid-bring-up, the rest is short-circuited cleanly — no NPE, no misleading `transport.connected` health emit after stop. |
| **SPA fallback excludes /assets/** | `services/online/src/server.ts`: a missing hashed asset must return 404, not the HTML fallback — otherwise the browser parses HTML as JS and `SyntaxError`s. |
| **Launcher Node-version check** | `start.bat` / `start.sh` verify `node` is installed and `>= 22`; print a clear remediation message otherwise. |
| **End-to-end smoke test** | New verified path: extract zip into `/tmp/<fresh>`, launch via `node server/dist/server.bundle.cjs`, hit `/healthz`, `/session/info`, `/`, `/deep/route`, `/assets/missing.js` (404), `/assets/<real>.js` (200), POST `/unknown` (404). All correct. |

New tests:
- `apps/web` — late-arrival translation routing (caption-store), stop-during-bring-up race (provider). **103 tests pass.**
- `services/online` — 6 new SPA fallback tests (index serves, deep SPA, /assets/ never falls back to HTML, /healthz not shadowed, POST /unknown 404). **26 tests pass.**

### Final slim distribution

```
meeting-audio-online/                          (zip: 0.78 MB)
├── server/dist/server.bundle.cjs              785 KB single-file CJS
├── web/                                       2.2 MB total
│   ├── index.html
│   └── assets/{index.js,index.css,fake-transcript.js}
├── start.bat
├── start.sh
├── .env.example
└── README.md
```

End-user requirements: **Node 22+**, **OpenAI API key**, microphone. That's it.

---

## P3.10 — Strict env policy

User directive: "嚴格強迫改革，我要全部都是讀取系統(使用者)環境變數的 OPENAI_API_KEY。不要寫成檔案."

Removed all `.env` support from the slim distribution. The key is read
**only** from `process.env`, which is populated exclusively by the user's
system / user environment (`setx`, shell `export`, `$env:`).

| Change | Reason |
|------|--------|
| `services/online/src/config.ts` | Deleted `dotenv.config()` and the bundle-relative fallback added in P3.9. Schema parses `process.env` directly. Startup log line: `[config] OPENAI_API_KEY: set in system env (N chars) \| MISSING — set OPENAI_API_KEY in your user/system env`. |
| `services/online/package.json` | Removed `dotenv` from dependencies. |
| `scripts/release-templates/start.{bat,sh}` | Added explicit `OPENAI_API_KEY` env-var check before launching node; prints platform-specific `setx` / `export` guidance and refuses to start if absent. No more `.env` bootstrap. |
| `scripts/release-templates/.env.example` | **Deleted.** No template, no encouragement to write secrets to disk. |
| `scripts/release-templates/README.md` | Rewrote Setup section: `setx` (Windows persistent) / `set` (session) / `export` (POSIX). Added explicit "no `.env` file" security note at the top. |
| `scripts/package-online.{ps1,sh}` | Stopped copying `.env.example` into the release tree. |
| `services/online/src/server.test.ts` | New guard test: `package.json` MUST NOT list dotenv, and `config.ts` source MUST NOT import or require it. Future regressions blocked at the test layer. |

### Verified behaviour (clean shell, fresh extraction)

| Scenario | Result |
|---|---|
| No `OPENAI_API_KEY` set | `[config] OPENAI_API_KEY: MISSING — …`; `/session/info` → `hasApiKey:false`; launcher refuses to start with platform-specific remediation guidance. |
| `OPENAI_API_KEY=sk-FROM-SHELL-…` in shell | `[config] OPENAI_API_KEY: set in system env (29 chars)`; OpenAI's upstream rejection echoes the key prefix `sk-FROM-*****************7777` — proving pass-through. |
| Adversary writes `.env` on disk | `[config] OPENAI_API_KEY: MISSING`; `.env` is strictly ignored. |

Server bundle dropped from 786 KB → 779 KB (no dotenv to inline). Zip
remains ~0.78 MB.

---

## Robustness Audit — 2026-05-23

Four targeted fixes from an architecture audit. No phase bump — all pure
correctness/efficiency improvements on top of existing contracts.

| Fix | File(s) | Detail |
|-----|---------|--------|
| **PCM ring buffer** | `apps/web/public/pcm-worklet.js` | Pre-allocated `Float32Array`; one transfer per 4096-sample chunk (~256 ms). Eliminates per-128-frame GC allocations (~32× reduction in object churn). |
| **WASAPI drop counter** | `services/offline/app/capture/wasapi_loopback.py` | `_try_enqueue` closure runs on the event-loop thread via `call_soon_threadsafe`. Old `except Exception: pass` in the pyaudio callback never fired because `QueueFull` raised on the event-loop thread, not the callback thread. Now emits `audio:degraded` health events after every 100 drops. |
| **Segment ID collision** | `services/offline/app/pipeline/asr.py`, `apps/web/src/providers/openai-realtime-provider.ts` | `crypto.randomUUID()` (browser-native) replaces `Date.now()`-based IDs. Eliminates 15 ms Windows clock-resolution collision risk on rapid Stop+Start. |
| **healthz `model_loading` state** | `services/offline/app/main.py`, `services/offline/app/pipeline/asr.py` | Added `_whl_model_ready: bool` flag (module-level). Set via `on_model_ready` callback on `ASRSession` when `SERVER_READY` arrives from WHL. `/healthz` now returns `model_loading` (not `ready`) when the WHL process is up but the model is still warming — previously TCP-probe success was conflated with model readiness. |
| **CORS env var** | `services/offline/app/main.py` | `OFFLINE_CORS_ORIGIN` env var (comma-separated); defaults to `http://localhost:5173,http://localhost:5174`. Removes hard-coded origin coupling. |
| **`model_loading` UI label** | `apps/web/src/App.tsx` | `whisperLabel()` helper maps `model_loading` → `"loading model…"` for display in the offline button text and tooltip. Prevents raw snake_case leaking into the UI. |

New tests added:

| Suite | Tests added | Detail |
|-------|------------|--------|
| `apps/web` vitest | +2 stale-detector | Fire `renewSession()` after 30 s DC silence + 100 audio-active samples; reset on each DC event |
| `apps/web` vitest | +7 caption-store | Provider switch without transcript loss (×2), translation failure isolation (×2), long-running memory stability (×2 — burst 500 → maxSegments=100, translation map prune sync) |
| `apps/web` vitest | +2 offline-stt-provider | Malformed WS message isolation; offline server unavailable → `offline_engine_unavailable` health state |
| `services/offline` pytest | +2 asr_session | `on_model_ready` callback fires exactly once on `SERVER_READY`; callback-less session works normally |
| `services/offline` pytest | −1 +2 healthz | Replaced stale `test_healthz_ok_false_when_loading` (nonexistent status); added `test_healthz_model_loading_when_process_up_but_not_ready` + second unavailable variant |

Test totals after audit: **50 Python** (was 21 before P3.5 + new tests), TypeScript clean (`tsc --noEmit` 0 errors).

---

## Recent Decisions (P3)

- **P3-D1**: WHL as independent process (TCP probe, not daemon thread) — crash isolation
- **P3-D2**: distil-large-v3 as default model (multilingual, env-overridable via WHL_MODEL)
- **P3-D3**: Linear interpolation resample (numpy-only, no scipy) — adequate STT quality, zero deps
- **P3-D4**: MIN_WORDS_TO_TRANSLATE = 3 → revised to MIN_WORDS_TO_TRANSLATE = 1 (single-word affirmations carry meaning in meetings; only true empty/whitespace is filtered)
- **P3-D5**: source:'mic'|'system' in WS start message — backend owns WASAPI, browser owns PCM
- **P3-D6**: `_whl_model_ready` flag — TCP probe ≠ model ready; `SERVER_READY` WebSocket message is the authoritative signal
- **P3-D7**: `OFFLINE_CORS_ORIGIN` env var — hard-coded dev origins removed from source
- **P3-D8**: `crypto.randomUUID()` for all segment IDs — eliminates clock-resolution collision risk

---

## P5-A — Breeze ASR 25 experiment + Online mode hardening (2026-05-24)

Two concurrent workstreams: ASR model comparison infrastructure, and a rigorous audit of the Online Realtime provider's edge-case handling.

### Part A — Breeze ASR 25 experiment

MediaTek Research Breeze ASR 25 is a Whisper-large-v2 fine-tune (2B params, Apache 2.0) optimised for Taiwanese Mandarin and Mandarin-English code-switching. Published WER results: zh-TW 7.97% (−19% vs baseline), code-switching 13.01% (−56%). CTranslate2-compatible via community conversion.

| File | Change |
|------|--------|
| `services/offline/run_whl.py` | `_REPO_MAP` extended with `"breeze-asr-25": "SoybeanMilk/faster-whisper-Breeze-ASR-25"` and `"breeze-asr-25-ct2": "phate334/Breeze-ASR-25-ct2"`. Usage: `WHL_MODEL=breeze-asr-25 start.bat` |
| `services/offline/scripts/compare_models.py` | NEW — side-by-side ASR evaluation. Reads `eval_audio/*.wav` + `transcripts.json`. Metrics: WER (jiwer), RTF, VRAM (torch.cuda). Usage: `python scripts/compare_models.py --models distil-large-v3 breeze-asr-25` |
| `services/offline/eval_audio/transcripts.json` | NEW — 4-clip ground truth: 2 pure zh-TW, 2 Mandarin-English code-switching |
| `services/offline/eval_audio/README.md` | NEW — recording guide (16 kHz mono 16-bit PCM WAV) and usage instructions |

Note: actual `.wav` test clips not committed (binary). Record with ffmpeg per README instructions. Breeze model download requires ~4 GB VRAM for evaluation.

### Part B — Online mode hardening

Systematic audit of Online Realtime provider identified 7 gaps; 5 were real bugs.

| ID | Priority | Status | Change |
|----|----------|--------|--------|
| **B1** — stale-data detector `lastDcEventAt` | High | ✅ no bug — `lastDcEventAt = Date.now()` is correctly set after SDP, not at 0 | — |
| **B2** — token expiration not checked | High | ✅ fixed | `expires_at * 1000 - Date.now() < 60_000` → emit reconnecting + go to renewSession (skip SDP) |
| **B3** — translation arrives before transcript final | Medium | ✅ no bug — partial path already handles this via livePartial promotion | — |
| **B4** — `silence_detected` not emitted | Medium | ✅ fixed | Track `lastAudioActiveAt`; after 30 s sub-threshold → emit `audio:silence_detected`; speech resume → emit `audio:connected`. Gate with `silenceEmitted` to prevent spam. |
| **B5** — permission denied not surfaced to UI | Medium | ✅ fixed | Wrap `handlers.onHealth` in `use-openai-realtime.ts`; intercept `failed`/`api_error` → set React `error` state (drives error banner + retry button) |
| **B6** — mode switch races | Medium | deferred — the hook's sequential start/stop guards (added P3.9) cover the failure case adequately |
| **B7** — rate-limiter O(n) + json timeout | Low | deferred — rate-limiter already has `RATE_STATE_MAX_KEYS = 10_000` guard; json timeout deferred |

| File | Change |
|------|--------|
| `apps/web/src/providers/openai-realtime-provider.ts` | + `expires_at?` field on `SessionResponse`; + expiry check before SDP (lines 259–267); + `silenceEmitted` field; + silence detection in `startLevelPolling()` (lines 744–764) |
| `apps/web/src/providers/use-openai-realtime.ts` | Health event interception in `start()` — `failed`/`api_error` states propagate to React `error` state |
| `apps/web/src/providers/openai-realtime-provider.test.ts` | + 4 tests: token < 60s → renewSession (not SDP); token > 60s → normal SDP; silence_detected after 30s quiet; connected recovery after silence |

### Test totals after P5-A

| Suite | Count | Status |
|-------|-------|--------|
| `apps/web` vitest | **187** | ✅ passed |
| `services/online` vitest | **41** | ✅ passed |
| `services/offline` pytest | **59** | ✅ passed |
| TypeScript (`tsc --noEmit`) | — | ✅ clean |

---

## Field-feedback pass — 2026-06-08

Three issues reported from real use. All three fixed; no phase bump (UX +
audio-config correctness on existing contracts).

### Issue 1 — Online: switching speaker (same language) almost never recognised

Root cause: the audio chain was tuned for a **single near speaker**. Default
`micDistance='close'` → browser `autoGainControl/noiseSuppression/echoCancellation`
all ON **and** OpenAI `noise_reduction=near_field`. AGC locks gain to the first
speaker and near_field gates softer / different-voiced participants as "noise",
so when the speaker changes the new voice is dropped.

Fix: new **`'meeting'` acoustic profile, now the default** — multi-speaker room
on one mic. Browser DSP all OFF (raw signal) + OpenAI `noise_reduction=far_field`
(its tuned profile for reverberant rooms with speakers at varying distances).
`close`/`far`/`off` kept as advanced options.

| File | Change |
|------|--------|
| `apps/web/src/settings/settings-store.ts` | `MicDistance` += `'meeting'`; default + reset → `'meeting'` |
| `apps/web/src/providers/microphone-audio-provider.ts` | `'meeting'` constraints (EC/NS/AGC all false); ctor default → `'meeting'` |
| `apps/web/src/providers/openai-realtime-provider.ts` | ctor type/default += `'meeting'`; `STALE_AUDIO_ACTIVE_DB_BY_MIC.meeting = -48` |
| `apps/web/src/providers/use-openai-realtime.ts` | `effectiveMicDistance` type += `'meeting'` |
| `services/online/src/routes/session.ts` | `micDistance` enum += `'meeting'`; `'meeting'\|'far'` → `far_field` |
| `apps/web/src/components/SettingsPanel.tsx` | `Meeting` option first/recommended |

> Cannot be verified in-repo (needs a live OpenAI session + multiple speakers).
> Tuning is root-cause-based; **verify in a real meeting**. Existing installs
> with `micDistance:'close'` persisted in localStorage keep close — pick
> **Meeting** in Settings (or it applies on a fresh profile).

### Issue 2 — No Pause, only Stop+Start (which lost the LOG)

Fix: **Pause / Resume**. Pause stops capture (and drains billed minutes for the
online path) but does **not** `beginSession()`/`clear()`/`endSession()` — the
transcript log stays in memory + persisted. Resume restarts the same provider
**without** clearing, so new events append to the preserved history.

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | `pausedMode` state; `startRealCore(continueSession)` (Resume skips `beginSession`); `handlePause`/`handleResume`; ⏸ Pause (running) + ▶ Resume (paused) buttons; `paused` status chip; Stop enabled while paused to finalise |

> Online resume ordering is correct (online `startMs` = wall-clock `Date.now()`).
> Caveat: offline/hybrid resume preserves the log but new segments may interleave
> by time-from-connection (WHL restarts timestamps at 0 per connection) — follow-up.

### Issue 3 — Just-spoken (now small) line didn't auto-scroll to the bottom

Root cause: history auto-pin only fired on **paragraph-array change**. The board
is `grid-template-rows: 1fr auto`; when the big live caption wraps to extra
lines the history pane (1fr) shrinks and its bottom line scrolls out of view —
a resize that fires no scroll event and no paragraph change, so nothing re-pinned.

Fix: a **`ResizeObserver`** on the history scroll container (+ its content
column) re-pins to bottom while `autoPin` is true, catching both pane-resize and
late-translation content growth.

| File | Change |
|------|--------|
| `apps/web/src/caption-board/CaptionBoard.tsx` | `autoPinRef` + `ResizeObserver` re-pin |

### Verification

| Suite | Count | Status |
|-------|-------|--------|
| `apps/web` vitest | **190** (+3) | ✅ passed |
| `services/online` vitest | **42** (+1) | ✅ passed |
| `apps/web` typecheck / build | — | ✅ clean |

(New tests: micrphone `meeting`/`close` constraints ×2, settings-store `meeting`
persist ×1, session `meeting`→`far_field` ×1. Also fixed a latent ES2023
`findLastIndex` in `openai-realtime-provider.test.ts` surfaced by the `tsc -b`
cache invalidation.)

---

## Multi-backend (P-A/P-C) — Gemini Live as 2nd online backend — 2026-06-09

Goal: a second, UI-switchable online realtime backend alongside OpenAI. Research
(see `docs/PROVIDER_BACKENDS.md`) confirmed Azure OpenAI and Google Gemini both
do realtime translation; user chose to implement **Gemini first, by API key**.

**Backend model.** `online_full` now has a provider selector
(`settings-store.onlineProvider: 'openai' | 'gemini'`, default `openai`,
persisted). The server's `/session/info` reports `availableProviders` from which
credentials exist; the UI greys out unconfigured backends.

**Gemini Live provider** (`gemini-live-provider.ts`) — WebSocket, not WebRTC:
- Browser never holds the raw key. Server route **`POST /session/gemini`**
  (`routes/gemini.ts`) mints a short-lived ephemeral token via the Gemini
  `auth_tokens` API from `GEMINI_API_KEY`; browser opens the Live WS
  (`…BidiGenerateContentConstrained?access_token=…`) directly.
- Reuses the offline **AudioWorklet PCM** path; converts Float32→PCM16→base64
  and sends `realtimeInput`. Setup enables `inputAudioTranscription` (EN source)
  + `outputAudioTranscription` (zh-TW translation) + `contextWindowCompression`
  (unlimited duration) + `sessionResumption`; reacts to `goAway`.
- Translation is **system-instruction driven** ("translate to 繁體中文，台灣用語")
  — Gemini outputs Traditional natively (the OpenAI/Azure translate models only
  emit Mandarin and lean Simplified → still need OpenCC).
- Model default `gemini-3.1-flash-live-preview` (latest), env-overridable.
- Maps onto normalized `TranscriptEvent`/`TranslationEvent` per turn; wall-clock
  `startMs` keeps ordering correct (and Pause/Resume continuity intact).

| File | Change |
|------|--------|
| `services/online/src/config.ts` | + `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`; startup log |
| `services/online/src/routes/gemini.ts` | NEW — `POST /session/gemini` ephemeral-token broker (rate-limited, error-sanitised) |
| `services/online/src/routes/session.ts` | `/session/info` += `availableProviders`, `hasGeminiKey` |
| `services/online/src/server.ts` | register Gemini route |
| `apps/web/src/providers/gemini-live-provider.ts` | NEW — WS provider + pure `floatTo16BitPCM`/`arrayBufferToBase64`/`handleServerObject` |
| `apps/web/src/providers/use-gemini-live.ts` | NEW — hook (availability poll, start/stop, error interception) |
| `apps/web/src/settings/settings-store.ts` | + `onlineProvider` (persisted) |
| `apps/web/src/components/SettingsPanel.tsx` | + "Online backend" OpenAI/Gemini selector |
| `apps/web/src/App.tsx` | wire `useGeminiLive`; provider-gated Start buttons; pause/resume/stop/exclusivity; status chip |

### Verification
| Suite | Count | Status |
|-------|-------|--------|
| `apps/web` vitest | **199** (+9) | ✅ passed |
| `services/online` vitest | **48** (+6) | ✅ passed |
| typecheck (web + online) / web build | — | ✅ clean |

New tests: Gemini provider message-mapping + PCM helpers (8), settings-store
`onlineProvider` (1), `/session/gemini` route + `availableProviders` (6).

### Live verification — 2026-06-09 (real GEMINI_API_KEY in system env)

Verified the Gemini path end-to-end against the running v1alpha API. **Found and
fixed one real bug** in the token route:

| Check | Result |
|-------|--------|
| `GEMINI_API_KEY` reachable to server process | ✅ present (len 39) |
| `gemini-3.1-flash-live-preview` is a valid Live model | ✅ (`bidiGenerateContent`) |
| Token mint body | ❌→✅ **`liveConnectConstraints` was rejected as unknown field.** Correct shape = `{uses,expireTime,newSessionExpireTime}` → `{name}`. Model-locking via `bidiGenerateContentSetup` made the Live WS close `1011` once the client also sent a setup → now mint an **unconstrained** single-use token. |
| WS setup fields (`responseModalities:['AUDIO']`, input/outputAudioTranscription, systemInstruction, contextWindowCompression.slidingWindow, sessionResumption) | ✅ all accepted → `setupComplete` |
| Audio frame `realtimeInput.audio{data,mimeType}` | ✅ accepted (note: `realtimeInput.mediaChunks` is **deprecated** → `1007`) |
| `sessionResumptionUpdate.newHandle` delivery | ✅ received |

Fix: `routes/gemini.ts` mints an unconstrained token; test updated.

### Browser end-to-end — 2026-06-09 (Playwright + Windows-TTS speech + real key)

User reported "Gemini captions never appear" (then "both modes look broken").
Drove the real app with a synthetic mic fed from a TTS-generated 16 kHz WAV.

**Found & fixed the actual defect:** `gemini-live-provider.ts` `ws.onmessage`
did `if (typeof ev.data !== 'string') return;` — but **Gemini Live delivers its
JSON server messages as BINARY frames** (ArrayBuffer). Every transcript/
translation was silently dropped → no captions. Fixed to decode ArrayBuffer/Blob
→ UTF-8 → JSON (`tryHandle`). After the fix, the caption board showed the full
translation: 「大家好,歡迎參加會議。今天我們將討論下個季度的項目預算和時間表。」

Isolation steps proving the diagnosis:
- Demo (fake replay) rendered captions → store→CaptionBoard render path OK.
- Node direct-to-Gemini with the same WAV produced correct `inputTranscription`
  (EN) + `outputTranscription` (繁中) → protocol + provider parsing OK.
- Browser WS instrumentation: audio frames were sent (sendCount 97), but server
  messages arrived as `[binary]` and were dropped → the decode bug.
- Synthetic-mic capture measured −15.7 dB through the provider path → audio
  content was real, not silence.
- Auto-VAD only flushes a turn when it sees end-of-speech (a pause); continuous
  looped audio with no clear gap never finalized. Real mics pause naturally, so
  captions appear per utterance. (3.1 input transcript is end-of-utterance, not
  word-by-word — known.)

OpenAI path also rendered captions in the same harness → not broken (the user's
Chrome had `langPair=zh-TW→en`/translation-only persisted, which explains the
English-looking caption they saw). Regression test added: "server frames are
JSON carried over BINARY". Web tests **200**. Purely additive; OpenAI / Hybrid /
Offline untouched.

### Upgrade to Gemini 3.5 Live Translate — 2026-06-10 (released 2026-06-09)

Google shipped **`gemini-3.5-live-translate-preview`** — a dedicated live
speech translation model (Gemini 3 Pro based): **continuous streaming** (not
turn-by-turn), purpose-built translation via `translationConfig`, Traditional
Chinese output. Adopted as the new default `GEMINI_LIVE_MODEL` (env-overridable).
Verified live against the real API and end-to-end in the browser.

| Item | Verified (live) |
|------|-----------------|
| Model available to key | ✅ `gemini-3.5-live-translate-preview` (bidiGenerateContent) |
| Setup (raw WS) | `generationConfig.translationConfig{targetLanguageCode,echoTargetLanguage}` + `responseModalities:['AUDIO']`; transcription / contextWindowCompression / sessionResumption are **top-level** (NOT in generationConfig — the doc's JSON is the SDK shape). No systemInstruction (unsupported). |
| Traditional Chinese | `targetLanguageCode = 'zh-Hant'` (en→zh-TW); `'en'` for zh-TW→en |
| Streaming | Continuous: `inputTranscription`/`outputTranscription` deltas every ~0.5 s, ~few s behind speaker. **No `turnComplete`** → provider self-finalizes on sentence boundaries (。！？.!?) + length cap |
| Audio | input 16 kHz PCM16 mono (`realtimeInput.audio`), output 24 kHz (ignored) |
| Browser e2e | ✅ history "0:00 大家好。 0:01 歡迎參加會議。" + live "今天我們將討論專案預算和下一季度的時間表。" |

Provider changes (`gemini-live-provider.ts`): model-aware `buildSetup`
(translate → `translationConfig`; native-audio → `systemInstruction`),
`translateTargetCode`, and `maybeFinalizeOnSentence()`/`finalizeTurn()` so the
continuous stream is chunked into sentence segments (history populates, live
line bounded). Default model in `config.ts` → 3.5. `gemini-2.5-flash-native-audio-latest`
remains a fallback via env (system-instruction path still supported).

Tests: web **201** (+ sentence-finalization), online 48, typecheck/build clean.
Note: a `gemini-3.5-flash` chat model also exists but is a separate text model —
the live translation capability is the distinct `*-live-translate-preview`.

### Review-fix pass + full verification matrix — 2026-06-11

High-effort code review (7 angles) surfaced 6 real defects; all fixed:

| Fix | Detail |
|-----|--------|
| **Orphaned final translation** | A translation finalizing before any source partial referenced a segment that never existed → invisible forever. `maybeFinalizeOnSentence` now requires BOTH source + translation text for the sentence path; `finalizeTurn` falls back to surfacing the translation as the transcript in the rare src-less edge. |
| **Echo-silent unbounded live line** | Speaker already in the target language (`echoTargetLanguage:false`) → no translation ever arrives → live source line grew forever. Now tracks `inputTranscription.languageCode`; source self-finalizes on sentence end when input lang == target. |
| **Stale-WS double reconnect** | Old socket's late `onclose` after a reconnect swap spawned a second reconnect chain. Both `onmessage`/`onclose` now guard `this.ws !== ws`. |
| **No WS backpressure guard** | Stalled-but-OPEN Gemini socket grew the send buffer unbounded over a long meeting. Added the OfflineSTTProvider guard (1 MB threshold, degraded health every 50 drops, force reconnect at 100 consecutive). |
| **Gemini ignored `audioSource:'system'`** | 🔊 chip claimed system capture while Gemini recorded the mic. `use-gemini-live` now branches to `DisplayMediaAudioProvider` (micDistance forced 'off'), mirroring the OpenAI hook; level polling now reads `mic.analyser` via the interface. |
| **Mid-session backend switch orphaned the running provider** | Switching OpenAI↔Gemini while running hid the active provider's UI while billing continued. The Settings backend picker is now disabled while any session runs ("會議進行中 — 請先 Stop 再切換後端"). |

**Browser verification matrix (real key + TTS speech, Playwright):**

| Scenario | Result |
|----------|--------|
| Gemini + mic + bilingual ON | ✅ live 繁中「接下來，我們將規劃預算。」+ EN source; history TWO columns, per-sentence rows with timestamps |
| Backend picker while running | ✅ both options disabled with explanatory tooltip |
| Gemini + **system audio** (getDisplayMedia) | ✅ captions flow through the new DisplayMedia branch |
| Bilingual OFF | ✅ source line absent, history single column, translation-only |
| OpenAI + mic + bilingual ON | ✅ live 繁中 + EN source, pricing panel visible |

Tests: web **204** (+4 finalization/orphan/echo tests), online 48, typecheck +
build clean. Remaining backlog (cleanup, not bugs): extract shared worklet-
capture base from offline/gemini providers; provider registry in App.tsx to
centralize exclusivity; drop dead native-audio fallback if 3.5 stays default.

### Mid-meeting backend failover + Meeting Playbook — 2026-06-11

Architecture deep-pass found one missing reliability path: CLAUDE.md mandates
"provider switch → do not clear transcript", but the only cross-backend switch
was Stop → Start, which calls `beginSession()` (clears). Fixed: **`handleResume`
now resumes online sessions into the CURRENTLY SELECTED backend** — the picker
unlocks while paused, so the operator flow is *Pause → switch OpenAI↔Gemini →
Resume* and the transcript continues on the other backend.

Browser-verified end-to-end: Gemini produced「0:00 各位，歡迎來到會議。0:01
我們將審查該計劃。」→ Pause → backend switched to OpenAI → Resume → status
`running` (OpenAI), history fully preserved, new captions appended at 1:18 on
the same session timeline.

Also added `docs/MEETING_PLAYBOOK.md` — operator-facing playbook (繁中):
meeting-type → settings matrix, backend selection guide, mid-meeting rescue
procedures (Pause-first principle), hotkeys, privacy tiers.

Known cost/efficiency notes (backlog): Gemini has no cost panel yet (OpenAI
does); 3.5-translate requires AUDIO responseModality whose synthesized audio we
discard — investigate whether TEXT modality is accepted to cut output-token
cost; `langCodes` recomputed per message (trivial).

### UX reflection pass + UI-expert presentation audit — 2026-06-11

Reflective UX walk + a dedicated caption-typography expert review of the board.
Fixed (all sampled live in-browser at 400 ms resolution):

| Fix | What the viewer saw before |
|-----|------|
| **Just-finished sentence vanished (M1, worst)** | History excluded the last final assuming LiveCaption showed it — but once the NEXT partial started, the previous sentence was in NEITHER area for 1–3 s (every sentence, on Gemini's continuous path). Now history includes the last final **while a partial is in flight** (`hasLive` conditional); sampled timeline shows the sentence landing in history at the exact instant the next partial starts — zero vanish window, no double-display. |
| **Bare 5rem "…" each sentence start (M2)** | Translation lags input ~1 s; the big area collapsed to a giant ellipsis and the whole board jittered (history 1fr grew/shrank). Now a small dim `翻譯中…` status label + `min-height: 2.5em` on the target area. |
| **Untranslated finals invisible (M3)** | MT failure or Gemini echo-silent finals were skipped by the target-side paragraph accessor → with source column off, the sentence appeared NOWHERE (violates "translation fails → keep source"). Accessors + LiveCaption final state now fall back to source text. |
| **CJK display typography (M4)** | line-height 1.22 / letter-spacing −0.01em are Latin display params; 5rem 繁中 lines nearly touched. zh-target scope now 1.35 / 0. |
| **Contrast (M5/P2)** | Live source #4a5870 ≈ 2.7:1 (below the 3:1 large-text floor) → #8a98ad ≈ 7:1; history secondary → #7e8da1; time gutter #2a3448 (1.6:1, ghost) → #4a5870. |
| **In-flight words lost on Pause/Stop** | Gemini provider now `finalizeTurn()`s on stop — the last utterance reaches history/Export and the stale pulsing cursor is gone (browser-verified mid-utterance pause). |
| **Demo while paused wiped the meeting log** | Demo disabled while paused, with explanatory title. |
| **Status chip said "running" for OpenAI but "gemini" for Gemini** | Now names the backend (`openai`) — matters mid-failover. |
| **Decimal split ("3." mid-number)** | ASCII period only ends a sentence when not preceded by a digit. |

Deferred (polish backlog): landing-tint continuity cue on the newest history
row; timestamp anchor vs ring-buffer pruning (blocked: offline providers use
connection-relative startMs, so `sessionStartMs` can't anchor them); Fraunces
mixed-script in zh captions; confidence-dimming as a non-opacity cue.

Tests: web **206** (+stop-finalize, +decimal-guard), online 48, typecheck +
build clean.
