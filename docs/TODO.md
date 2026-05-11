# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

- [ ] Close P0 with commits (waits on user `git config user.email/name`).
      Suggested sequence in [`PROJECT_STATE.md`](PROJECT_STATE.md)
      §"Closing P0 — Suggested Commit Sequence".
- [ ] (Optional) Push to a remote when the user opts in (D10).

## P0 (done)

All 13 tasks complete. See [`PROJECT_STATE.md`](PROJECT_STATE.md) for
test status and on-disk inventory.

## Next phase — P1

P1 = scenario picker UI + audio level meter, on top of the P0 skeleton.

- [ ] `ScenarioPicker` component (Physical / Online Meeting Box / Hybrid /
      Advanced) — UI only in P1; real audio routing comes in P2/P3
- [ ] Wire scenario into a top-level mode store
- [ ] `useAudioLevel` hook (Web Audio API `AnalyserNode`)
- [ ] Surface `HealthEvent` states in the header (idle / connecting /
      connected / degraded / failed / ...)
- [ ] Add Vitest cases for scenario state transitions
- [ ] Extend Playwright spec: scenario switch preserves transcript history

## Backlog (later phases)

- [ ] OpenAI Realtime session endpoint (P2)
- [ ] OpenAI Realtime browser WebRTC adapter (P2)
- [ ] WhisperLiveKit spike (P3)
- [ ] OfflineSTTProvider adapter (P3)
- [ ] WASAPI loopback via PyAudioWPatch (P3, Windows-first)
- [ ] Argos Translate integration (P4)
- [ ] Traditional Chinese / Taiwan post-processing (P4)
- [ ] Glossary hook (P4)
- [ ] Summary pipeline draft / refined / stable (P5)
- [ ] Long-running memory test harness (P6)
- [ ] Reconnect / silence / no-audio-track handling (P6)
- [ ] Electron packaging (P7)
- [ ] Sidecar lifecycle (Electron main spawning online + offline) (P7)
