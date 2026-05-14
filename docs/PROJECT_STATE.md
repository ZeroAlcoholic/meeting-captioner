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

## Test Status (as of P3)

| Suite | Count | Status |
|-------|-------|--------|
| `services/offline` pytest | 21 | ✅ passed |
| `apps/web` vitest | 68 | ✅ passed |
| `services/online` vitest | 10 | ✅ passed |
| Playwright e2e | 15 | ✅ passed (last verified P2) |

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

## Recent Decisions (P3)

- **P3-D1**: WHL as independent process (TCP probe, not daemon thread) — crash isolation
- **P3-D2**: distil-large-v3 as default model (multilingual, env-overridable via WHL_MODEL)
- **P3-D3**: Linear interpolation resample (numpy-only, no scipy) — adequate STT quality, zero deps
- **P3-D4**: MIN_WORDS_TO_TRANSLATE = 3 — skip filler words before MT to save CPU
- **P3-D5**: source:'mic'|'system' in WS start message — backend owns WASAPI, browser owns PCM
