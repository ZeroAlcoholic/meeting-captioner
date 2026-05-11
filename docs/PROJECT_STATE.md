# PROJECT_STATE.md

> Single source of truth for **what is built / in progress / blocked**.
> Update at the end of every meaningful task.
> Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md). Backlog: [`TODO.md`](TODO.md).

---

## Current Phase

**P1 — Scenario / Mode / Health UI Shell** ✅ **COMPLETE** (pending commit)

Single P1 metric — **achieved**: open `http://localhost:5173` → click ⚙ →
see ScenarioPicker (4 presets, Advanced disabled) + ModeSelector (3
modes) + HealthRow (6 components with state-driven dots) + AudioLevelMeter
(RMS bar, peak marker, dB). Click Start Fake Replay → all four UI
elements update from the same fake script. Switch scenario or mode →
caption history preserved.

Test status:
- `@meeting-audio/contracts`: 19 tests passed
- `@meeting-audio/web`: **46 tests passed** (P0 13 + P1 +33)
- **Playwright e2e: 8 tests passed** (P0 2 + P1 +6)

---

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| **P0** | Foundation skeleton | ✅ complete (8 commits in git) |
| **P1** | Scenario picker + Mode selector + Health row + Audio level meter | ✅ complete (commits pending) |
| P2 | OpenAI Realtime mic path (WebRTC + session bridge real) | ⏳ next |
| P3 | WhisperLiveKit spike + OfflineSTTProvider + WASAPI loopback | pending |
| P4 | Argos Translate + zh-Hant post-process + glossary | pending |
| P5 | Summary draft/refined/stable pipeline | pending |
| P6 | Reliability + long-running stability | pending |
| P7 | Electron packaging | pending |

---

## P1 Task Status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | settings store | ✅ done | scenarioId / modeId / health / audioLevel + reset; **14 vitest** |
| 1.2 | fake-replay-provider extended | ✅ done | 4-way discriminated union (transcript/translation/health/audio_level) |
| 1.3 | ScenarioPicker | ✅ done | 4 presets; Advanced disabled with "(P2/P3)" hint |
| 1.4 | ModeSelector | ✅ done | 3 modes; reuses ScenarioPicker.module.css |
| 1.5 | HealthRow | ✅ done | 6 components × 13-state colour buckets + tooltip; **13 vitest** |
| 1.6 | AudioLevelMeter | ✅ done | RMS bar + peak marker + dB label; **6 vitest** |
| 1.7 | SettingsPanel | ✅ done | collapsible (open=false default) |
| 1.8 | App.tsx refactor | ✅ done | ⚙ toggle in header; SettingsPanel below header |
| 1.9 | Playwright e2e | ✅ done | scenario-switch + mode-switch + 2 new fake-replay assertions |
| 1.10 | docs | ✅ done | this file + TODO.md + PLAN_P1.md mirror |
| 1.11 | commits | ⏳ next | 5-6 conventional commits planned |

---

## What Exists On Disk (additions in P1)

```
apps/web/src/
├── settings/                            [NEW dir]
│   ├── settings-store.ts
│   ├── settings-store.test.ts
│   └── use-settings-store.ts
├── components/                          [NEW dir]
│   ├── ScenarioPicker.tsx + .module.css
│   ├── ModeSelector.tsx
│   ├── HealthRow.tsx + .module.css + .test.ts
│   ├── AudioLevelMeter.tsx + .module.css + .test.ts
│   └── SettingsPanel.tsx + .module.css
├── providers/                           [modified] types/fake-replay-provider/use-fake-replay
├── dev/fake-transcript.json             [modified] +health +audio_level events (39 total)
├── App.tsx                              [modified] settings toggle + panel
└── index.css                            [modified] .settings-toggle styles

tests/e2e/
├── fake-replay.spec.ts                  [modified] +settings/health assertions
├── scenario-switch.spec.ts              [NEW]
└── mode-switch.spec.ts                  [NEW]

docs/
├── PLAN_P1.md                           [NEW]
├── PROJECT_STATE.md                     [modified] this file
└── TODO.md                              [modified] P1 done, P2 surfaced
```

---

## How to Resume After Session/Model Switch

1. [`../CLAUDE.md`](../CLAUDE.md) — non-negotiable rules
2. [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md) — approved plans
3. **This file** — done / pending
4. [`TODO.md`](TODO.md) — backlog (now points at P2)
5. [`DECISIONS.md`](DECISIONS.md) — D1–D10

---

## Recent Decisions

P1-D1 to P1-D7 captured in [`PLAN_P1.md`](PLAN_P1.md) §5. No new entry
in [`DECISIONS.md`](DECISIONS.md) — those are project-wide architecture
decisions; P1-D* are within-phase choices.

## Active Blockers

- P1 commits pending (waiting to be staged + commit). Will use the same
  Conventional Commits convention as P0.

---

## Closing P1 — Suggested Commit Sequence

```bash
# 1. settings store + extended provider
git add apps/web/src/settings/ apps/web/src/providers/ apps/web/src/dev/fake-transcript.json
git commit -m "feat(web): settings store + provider extension for health/audio_level"

# 2. UI components
git add apps/web/src/components/
git commit -m "feat(web): ScenarioPicker, ModeSelector, HealthRow, AudioLevelMeter, SettingsPanel"

# 3. App integration
git add apps/web/src/App.tsx apps/web/src/index.css
git commit -m "feat(web): integrate settings panel into App with ⚙ toggle"

# 4. e2e
git add tests/e2e/
git commit -m "test(e2e): scenario-switch + mode-switch specs; extend fake-replay assertions"

# 5. docs
git add docs/PROJECT_STATE.md docs/TODO.md docs/PLAN_P1.md
git commit -m "docs: mark P1 complete, surface P2 in TODO, mirror plan"
```
