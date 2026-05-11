# ARCHITECTURE.md

> System architecture. Read together with [`CLAUDE.md`](../CLAUDE.md) and
> [`REFERENCE.md`](../REFERENCE.md).

---

## 1. Layered Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Interface / Routing  (apps/web — Vite + React + TS)         │
│  - scenario picker     - mode selector  - caption board       │
│  - summary sidebar     - health surface                       │
└──────────────▲──────────────────────────────▲────────────────┘
               │ normalized events             │ normalized events
               │ (TranscriptEvent, ...)        │
┌──────────────┴───────────────┐  ┌────────────┴───────────────┐
│  Online Realtime Layer        │  │  Offline Local Layer        │
│  (services/online — Fastify)  │  │  (services/offline — Python)│
│  - OpenAI session endpoint    │  │  - WhisperLiveKit / fw STT  │
│  - SDP/token broker           │  │  - VAD + streaming policy   │
│  - WebSocket bridge for       │  │  - Argos translation        │
│    backend audio              │  │  - WASAPI loopback (Win)    │
└───────────────────────────────┘  └────────────────────────────┘
```

The renderer talks to **either** layer, never to both for the same
caption stream. Mode selection (Online Full / Hybrid Privacy / Full
Offline) decides routing.

---

## 2. Packages and Services

| Path | Role | Stack |
|------|------|-------|
| `apps/web/` | Renderer UI: caption board, mode/scenario controls | Vite + React + TS |
| `services/online/` | OpenAI session bridge, key isolation | Node 22 + Fastify |
| `services/offline/` | Local STT/MT bridge, audio capture | Python 3.11 + FastAPI + uv |
| `packages/contracts/` | Normalized event schemas (TS + zod) | TS |
| `tests/e2e/` | Cross-app Playwright tests | Playwright |
| `scripts/` | Bootstrap and doctor | PowerShell + bash |

---

## 3. Data Flow (P0 — fake replay path)

```
fake-transcript.json
        │
        ▼
FakeReplayProvider ──► caption store (bounded ring buffer)
                              │
                              ▼
                        CaptionBoard (React)
```

This is the **canonical regression harness** for the caption path.

## 3a. Data Flow (P2+ — Online Realtime path, not yet built)

```
mic / tab audio (browser)
        │
        ▼
WebRTC ◄─── short-lived token from services/online (which holds API key)
        │
        ▼
OpenAI Realtime Translation ──► provider adapter ──► normalized events
                                                            │
                                                            ▼
                                                       caption store
                                                            │
                                                            ▼
                                                       CaptionBoard
```

## 3b. Data Flow (P3+ — Full Offline path, not yet built)

```
audio source (mic / WASAPI loopback)
        │
        ▼
services/offline (Python) — WhisperLiveKit
        │ partial / revised / final segments
        ▼
WebSocket ──► provider adapter ──► normalized events
                                          │
                                          ▼
                                Argos Translate (English → zh-Hant)
                                          │
                                          ▼
                                    caption store ──► CaptionBoard
```

---

## 4. Event Contracts

All defined in `packages/contracts`. UI imports types from there only.

- `TranscriptEvent` — { provider, mode, source, segmentId, status, text, startMs, endMs?, confidence?, revisionOf? }
- `TranslationEvent` — { provider, mode, sourceSegmentId, status, sourceText, targetText, sourceLanguage, targetLanguage, updatedAt }
- `HealthEvent` — { component, state, message?, timestamp }
- `AudioLevelEvent` — { source, rmsDb, peakDb, timestamp }

Statuses:
- Transcript: `partial | revised | final`
- Translation: `draft | refined | final`
- Health: `idle | requesting_permission | connecting | connected | reconnecting | degraded | failed | stopped | no_audio_track | silence | model_loading | offline_unavailable | api_error`

See [`CLAUDE.md`](../CLAUDE.md) §"Required Transcript/Translation Event Semantics" and §"Reliability Requirements".

---

## 5. Provider Abstraction

Every audio/STT/MT integration implements an interface that emits the
contracts above. The UI never imports OpenAI / WhisperLiveKit / Argos
SDKs directly.

P0 ships only `FakeReplayProvider`. Future providers:

- `OpenAIRealtimeProvider` (P2)
- `OfflineSTTProvider` wrapping WhisperLiveKit (P3)
- `OfflineMTProvider` wrapping Argos (P4)
- `MicrophoneAudioProvider` / `BrowserTabAudioProvider` / `WindowsLoopbackAudioProvider`

---

## 6. Process / Port Map

| Process | Port (default) | How to start |
|---------|---------------|--------------|
| Web (Vite dev) | 5173 | `pnpm -F web dev` |
| Online (Fastify) | 8787 | `pnpm -F online dev` |
| Offline (FastAPI) | 8000 | `cd services/offline && uv run uvicorn app.main:app --port 8000` |

All ports are overridable via `.env`.

---

## 7. Future Topology (post-MVP)

When packaged with Electron (P7):
- Main process spawns `services/online` and `services/offline` as sidecars
- Renderer keeps the same web URL contract — IPC only for OS-only features
  (window controls, file dialogs, native audio enumeration)
- No code under `apps/web` should branch on Electron vs browser; that
  branching lives in a thin adapter layer
