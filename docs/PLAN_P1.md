# PLAN_P1.md — Scenario / Mode / Health UI Shell

> **Mirror of the approved plan.** Original at
> `~/.claude/plans/linear-sniffing-hanrahan.md` (per-user). Mirrored
> here so it survives session/model switches.
>
> **Status:** ✅ Complete. Live progress: [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## 1. Context

P0 left `apps/web` at "click Start Fake Replay → see captions". Missing:
- No scenario picker (CLAUDE.md L181-199 mandates scenario-based)
- No mode selector (CLAUDE.md L146-156: Online Full / Hybrid Privacy / Full Offline)
- `HealthEvent` schema existed but nothing surfaced it
- `AudioLevelEvent` schema existed but no meter

P1 builds the UI shell so P2 (OpenAI Realtime) and P3 (WhisperLiveKit + WASAPI loopback) only need to plug into the provider layer — UI doesn't change again.

**Single P1 success metric (achieved):** open browser → see ScenarioPicker (4 presets) + ModeSelector (3 modes) + HealthRow (6 components) + AudioLevelMeter (animated bar); Start Fake Replay drives all of them; switching scenario / mode preserves caption history.

---

## 2. Scope

| In | Out |
|----|-----|
| settings store (scenario / mode / health / audioLevel) | localStorage persistence (P5/P6) |
| ScenarioPicker (4 presets, Advanced disabled) | Real audio source switching (P2/P3) |
| ModeSelector (3 modes) | Real provider switching (P2/P3) |
| HealthRow (6 components, 13-state color map) | Real health source (P2/P3) |
| AudioLevelMeter (RMS bar + peak marker + dB) | Real microphone / Web Audio capture (P2) |
| FakeReplayProvider extended for health + audio_level | Any real OpenAI / Whisper / Argos |
| App.tsx refactor: collapsible SettingsPanel + CaptionBoard | Glossary, retention, language settings |
| Vitest for store transitions | Long-running stability tests (P6) |
| Playwright: scenario switch, mode switch, health surface | |

---

## 3. UI Layout (achieved)

```
┌──────────────────────────────────────────────────────────┐
│ Meeting Audio              status [Start] [Stop] [⚙]      │
├──────────────────────────────────────────────────────────┤
│ ▼ Settings (collapsed by default; click ⚙ to open)        │
│   ┌Scenario┐ ┌Mode┐ ┌Health┐                               │
│   ...                                                     │
│   Audio level ▓▓▓▓▓░░░░  -22 dB                            │
├──────────────────────────────────────────────────────────┤
│             歡迎參加會議。                                  │
│             Welcome to the meeting.                        │
│             history (last 5) ↑                             │
└──────────────────────────────────────────────────────────┘
```

---

## 4. Files Created / Modified

```
apps/web/src/
├── App.tsx                                    [modified] add SettingsPanel + ⚙ toggle
├── index.css                                  [modified] .settings-toggle styles
├── settings/                                  [NEW]
│   ├── settings-store.ts                      Zustand vanilla, scenario/mode/health/audioLevel
│   ├── settings-store.test.ts                 14 vitest cases
│   └── use-settings-store.ts                  React hook
├── components/                                [NEW]
│   ├── ScenarioPicker.tsx + .module.css       4 radios; Advanced disabled
│   ├── ModeSelector.tsx                       3 radios; reuses ScenarioPicker.module.css
│   ├── HealthRow.tsx + .module.css            6 dots × 13-state buckets; tooltip
│   ├── HealthRow.test.ts                      13 cases (every state mapped)
│   ├── AudioLevelMeter.tsx + .module.css      RMS bar + peak marker + dB
│   ├── AudioLevelMeter.test.ts                6 cases (rmsToWidthPercent)
│   ├── SettingsPanel.tsx + .module.css        collapsible container
├── providers/
│   ├── types.ts                               [modified] CaptionProviderHandlers + onHealth/onAudioLevel
│   ├── fake-replay-provider.ts                [modified] 4-way discriminated union
│   ├── fake-replay-provider.test.ts           [modified] multi-event dispatch
│   └── use-fake-replay.ts                     [modified] wires health/level → settingsStore
└── dev/
    └── fake-transcript.json                   [modified] +health +audio_level (39 events total)

tests/e2e/
├── fake-replay.spec.ts                        [modified] +settings panel + health row assertions
├── scenario-switch.spec.ts                    [NEW] preserves history; Advanced disabled
└── mode-switch.spec.ts                        [NEW] preserves history; all 3 modes selectable
```

---

## 5. Confirmed Decisions (P1-D)

| # | Topic | Decision |
|---|-------|----------|
| P1-D1 | settings vs caption store | Separate stores |
| P1-D2 | Caption preserved on mode/scenario switch | Yes (CLAUDE.md hard rule) |
| P1-D3 | Advanced scenario in P1 | Disabled with "(Available in P2/P3)" hint |
| P1-D4 | AudioLevelMeter source | Fake events only (no mic permission yet) |
| P1-D5 | Settings panel default | Collapsed |
| P1-D6 | localStorage persistence | Not in P1 |
| P1-D7 | Health dot click | `title` tooltip (state + message) |

---

## 6. Test Status (validated)

- Web unit tests: **46/46** (caption-store 8, settings-store 14, AudioLevelMeter 6, HealthRow 13, fake-replay-provider 5)
- Contracts unit tests: 19/19 (unchanged from P0)
- **Playwright e2e: 8/8** (4 fake-replay + 2 scenario-switch + 2 mode-switch)

---

## 7. Done Definition (achieved)

- [x] `pnpm test` green across all workspaces
- [x] `pnpm test:e2e` green (8 specs)
- [x] Browser manual: ScenarioPicker / ModeSelector / HealthRow / AudioLevelMeter all visible after ⚙; switching scenario/mode keeps caption history
- [x] CaptionBoard never blanks during settings interactions
- [x] `docs/PROJECT_STATE.md` marks P1 complete
- [x] git log has clean commit series

---

## 8. After P1

| Phase | Focus |
|-------|-------|
| **P2** | OpenAI Realtime mic path: real `/session` (issues client_secret), browser WebRTC, MicrophoneAudioProvider, real Health/Level from provider |
| P3 | WhisperLiveKit spike + WASAPI loopback (PyAudioWPatch) + OfflineSTTProvider |
| P4 | Argos Translate + Traditional Chinese post-process + glossary |
| P5 | Summary draft / refined / stable pipeline |
| P6 | Reliability + long-running memory stability |
| P7 | Electron packaging |
