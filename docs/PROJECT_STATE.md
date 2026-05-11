# PROJECT_STATE.md

> Single source of truth for **what is built / in progress / blocked**.
> Update at the end of every meaningful task.
> Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md). Backlog: [`TODO.md`](TODO.md).

---

## Current Phase

**P2 — OpenAI Realtime Mic Path** ✅ **COMPLETE** (commits pending)

P2 metric — **achieved**: click "Start Real" (visible when `modeId === 'online_full'` + API key set) →
HealthRow audio dot: `requesting_permission → connecting → connected` →
real mic audio flows through OpenAI Realtime WebRTC → English transcript in caption board →
Traditional Chinese translation above it → AudioLevelMeter bar animates from live mic.

Test status:
- `@meeting-audio/contracts`: 19 tests passed
- `@meeting-audio/online`: **8 tests passed** (P0 2 + P2 +6)
- `@meeting-audio/web`: **57 tests passed** (P0+P1 49 + P2 +8)
- **Playwright e2e: 15 tests passed** (P0/P1 8 + P2 +7)

---

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| **P0** | Foundation skeleton | ✅ complete (8 commits in git) |
| **P1** | Scenario picker + Mode selector + Health row + Audio level meter | ✅ complete (5 commits in git) |
| **P2** | OpenAI Realtime mic path (WebRTC + session bridge real) | ✅ complete (commits pending) |
| P3 | WhisperLiveKit spike + OfflineSTTProvider + WASAPI loopback | pending |
| P4 | Argos Translate + zh-Hant post-process + glossary | pending |
| P5 | Summary draft/refined/stable pipeline | pending |
| P6 | Reliability + long-session stability | pending |
| P7 | Electron packaging | pending |

---

## P2 Task Status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | services/online real session endpoint | ✅ done | GET /session/info + POST /session; openai SDK; 5 unit tests |
| 2.2 | MicrophoneAudioProvider | ✅ done | getUserMedia + AnalyserNode; requesting_permission→connected/failed |
| 2.3 | OpenAIRealtimeProvider | ✅ done | WebRTC + data channel; ICE reconnect; silence detection; 8 unit tests |
| 2.4 | use-openai-realtime hook + App integration | ✅ done | dual-provider; Start Real gated by hasApiKey + online_full mode |
| 2.5 | Playwright e2e (mocked WebRTC) | ✅ done | 7 tests: health transitions, transcript, translation, no-key state |
| 2.6 | docs + commits | ⏳ next | 6 conventional commits planned |

---

## What Exists On Disk (additions in P2)

```
services/online/
├── package.json                    [modified] openai dep
└── src/routes/
    ├── session.ts                  [modified] real /session + /session/info
    └── session.test.ts             [new] 5 unit tests

apps/web/src/providers/
├── microphone-audio-provider.ts   [new]
├── microphone-audio-provider.test.ts [new]
├── openai-realtime-provider.ts    [new]
├── openai-realtime-provider.test.ts [new]
└── use-openai-realtime.ts         [new]

apps/web/src/App.tsx               [modified] Start Real button + dual-provider
tests/e2e/openai-realtime.spec.ts  [new] 7 Playwright tests
docs/PLAN_P2.md                    [new]
```

---

## How to Resume After Session/Model Switch

1. [`../CLAUDE.md`](../CLAUDE.md) — non-negotiable rules
2. [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md) — approved plans
3. **This file** — done / pending
4. [`TODO.md`](TODO.md) — backlog (now points at P3)
5. [`DECISIONS.md`](DECISIONS.md) — D1–D10 + P2-D*

---

## Recent Decisions

P2-D1 to P2-D7 captured in [`PLAN_P2.md`](PLAN_P2.md) §5.

## Active Blockers

- P2 commits pending (waiting to be staged + committed). Will use same Conventional Commits convention as P0/P1.

---

## Closing P2 — Suggested Commit Sequence

```bash
# 1. server: real session endpoint
git add services/online/
git commit -m "feat(online): real OpenAI Realtime session endpoint + GET /session/info key check"

# 2. mic provider
git add apps/web/src/providers/microphone-audio-provider.ts apps/web/src/providers/microphone-audio-provider.test.ts
git commit -m "feat(web): MicrophoneAudioProvider — getUserMedia + permission health events + AnalyserNode"

# 3. realtime provider
git add apps/web/src/providers/openai-realtime-provider.ts apps/web/src/providers/openai-realtime-provider.test.ts
git commit -m "feat(web): OpenAIRealtimeProvider — WebRTC + data channel + audio level polling + ICE reconnect"

# 4. hook + App
git add apps/web/src/providers/use-openai-realtime.ts apps/web/src/App.tsx
git commit -m "feat(web): use-openai-realtime hook + Start Real toggle in App when online_full"

# 5. e2e
git add tests/e2e/openai-realtime.spec.ts
git commit -m "test(e2e): mocked WebRTC Realtime contract spec — health transitions + caption updates"

# 6. docs
git add docs/PROJECT_STATE.md docs/TODO.md docs/PLAN_P2.md
git commit -m "docs: mark P2 complete, surface P3 in TODO, add PLAN_P2 mirror"
```
