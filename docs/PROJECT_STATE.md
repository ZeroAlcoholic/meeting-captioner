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
| P4 | Translation quality: dual-path MT, Voxtral/Speaches ASR adapters | pending |
| P5 | Summary draft/refined/stable pipeline | pending |
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

## Recent Decisions (P3)

- **P3-D1**: WHL as independent process (TCP probe, not daemon thread) — crash isolation
- **P3-D2**: distil-large-v3 as default model (multilingual, env-overridable via WHL_MODEL)
- **P3-D3**: Linear interpolation resample (numpy-only, no scipy) — adequate STT quality, zero deps
- **P3-D4**: MIN_WORDS_TO_TRANSLATE = 3 — skip filler words before MT to save CPU
- **P3-D5**: source:'mic'|'system' in WS start message — backend owns WASAPI, browser owns PCM
