# PLAN_P2.md — OpenAI Realtime Mic Path

> **Mirror of the approved plan.**
>
> **Status:** ✅ Complete. Live progress: [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## 1. Context

P1 left the UI shell complete: ScenarioPicker, ModeSelector, HealthRow, AudioLevelMeter all driven by fake events. P2 wires a real mic → OpenAI Realtime path so "Start Real" produces live English captions with Traditional Chinese translation.

**CLAUDE.md non-negotiables:**
- API key stays server-side — browser receives ephemeral `client_secret` only
- Caption path is sacred — real provider failure is visible via HealthRow, fake replay remains available
- Mode switch must not clear transcript history
- No OpenAI dep in `apps/web` — only in `services/online`

**Single P2 success metric (achieved):** Click "Start Real" (when `modeId === 'online_full'`) →
HealthRow audio dot goes `requesting_permission → connecting → connected` →
English transcript appears → Traditional Chinese translation appears above → AudioLevelMeter animates from real mic.

---

## 2. Architecture

```
Browser (apps/web)
  MicrophoneAudioProvider
    getUserMedia({ audio: true }) → MediaStream + AnalyserNode
    emits: requesting_permission → connected / failed

  OpenAIRealtimeProvider
    1. POST /session (our server) → client_secret
    2. RTCPeerConnection + data channel + addTrack(mic)
    3. createOffer → POST OpenAI Realtime endpoint → setRemoteDescription
    4. Data channel events → normalized TranscriptEvent + TranslationEvent
    5. AnalyserNode loop every 100ms → AudioLevelEvent
    6. ICE disconnect → restartIce (3s) | ICE failed → emit failed + stop

Server (services/online)
  GET /session/info → { hasApiKey: boolean }  (key availability, no session created)
  POST /session     → POST OpenAI /v1/realtime/sessions → return { client_secret }
```

---

## 3. Event Mapping

| OpenAI Realtime event | Normalized event |
|---|---|
| `conversation.item.input_audio_transcription.delta` | TranscriptEvent { status:'partial' } |
| `conversation.item.input_audio_transcription.completed` | TranscriptEvent { status:'final' } |
| `input_audio_buffer.committed` | track lastInputItemId for translation correlation |
| `response.text.delta` | TranslationEvent { status:'draft', targetText:accumulated } |
| `response.text.done` | TranslationEvent { status:'final' } |
| `error` | HealthEvent { state:'api_error' } |

---

## 4. Files Created / Modified

```
services/online/
├── package.json                              [modified] added "openai": "^4.67.0"
└── src/routes/
    ├── session.ts                            [modified] real POST /session + GET /session/info
    └── session.test.ts                       [new] unit tests (vi.mock('openai'))

apps/web/src/providers/
├── microphone-audio-provider.ts             [new] getUserMedia wrapper + AnalyserNode
├── microphone-audio-provider.test.ts        [new] 3 unit tests
├── openai-realtime-provider.ts              [new] WebRTC + data channel + level polling
├── openai-realtime-provider.test.ts         [new] 8 unit tests (mocked WebRTC)
└── use-openai-realtime.ts                   [new] React hook

apps/web/src/
└── App.tsx                                  [modified] "Start Real" button + dual-provider logic

tests/e2e/
└── openai-realtime.spec.ts                  [new] 7 Playwright tests (mocked WebRTC)

docs/
├── PLAN_P2.md                               [new] this file
├── PROJECT_STATE.md                         [modified]
└── TODO.md                                  [modified]
```

---

## 5. Confirmed Decisions (P2-D)

| # | Topic | Decision |
|---|---|---|
| P2-D1 | OpenAI SDK | Use `openai` npm package in services/online only |
| P2-D2 | Translation method | Model `response.text` events (zh-TW only); Whisper for English transcript |
| P2-D3 | App integration | Two independent hooks (fake + realtime), mutually exclusive start |
| P2-D4 | Key availability check | GET /session/info on hook mount; drives button visibility |
| P2-D5 | Silence detection | 5s no speech_started → emit audio:silence_detected (non-fatal) |
| P2-D6 | ICE reconnect | disconnected → 3s → restartIce; failed → emit failed, fallback available |
| P2-D7 | Caption clear on Start Real | clear() on start (same as Start Fake) |

---

## 6. Test Status (validated)

- contracts unit tests: 19/19 (unchanged from P0)
- web unit tests: **57/57** (P0+P1 49 + P2 +8)
- online unit tests: **8/8** (P0 2 + P2 +6 → server.test 3 + session.test 5)
- **Playwright e2e: 15/15** (P0/P1 8 + P2 +7)

---

## 7. Done Definition (achieved)

- [x] `pnpm test` green across all workspaces
- [x] `pnpm test:e2e` green (15 specs)
- [x] `pnpm typecheck` green
- [x] `pnpm lint` green (0 errors, 0 warnings)
- [x] Browser manual: "Start Real" button visible when online_full + hasApiKey
- [x] Caption history preserved through provider switch
- [x] git log has 6 clean conventional commits

---

## 8. After P2

| Phase | Focus |
|---|---|
| **P3** | WhisperLiveKit spike + WASAPI loopback (PyAudioWPatch) + OfflineSTTProvider |
| P4 | Argos Translate + Traditional Chinese post-process + glossary |
| P5 | Summary draft / refined / stable pipeline |
| P6 | Reliability + long-running memory stability |
| P7 | Electron packaging |
