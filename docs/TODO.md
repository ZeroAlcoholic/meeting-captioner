# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

- [ ] Close P2 with commits (suggested 6-commit sequence in
      [`PROJECT_STATE.md`](PROJECT_STATE.md) §"Closing P2 — Suggested Commit Sequence")

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

## Next phase — P3: WhisperLiveKit + WASAPI Loopback

P3 wires the offline STT path. Real audio source selection for "Physical Meeting" and
"Hybrid Meeting" scenarios. No cloud dependency.

- [ ] WhisperLiveKit spike — evaluate as offline STT backend, wrap behind OfflineSTTProvider
- [ ] `services/offline` FastAPI + WhisperLiveKit integration (replace uv stub)
- [ ] `apps/web/src/providers/whisper-live-provider.ts` — implements CaptionProvider via WebSocket
- [ ] Windows WASAPI loopback via PyAudioWPatch (jt-live-whisper reference)
- [ ] WASAPI source available as "Online Meeting Caption Box" scenario
- [ ] `apps/web/src/providers/microphone-audio-provider.ts` — already exists for mic; WASAPI exposed via online service sidecar
- [ ] Surface `model_loading` / `offline_engine_unavailable` states via HealthRow
- [ ] Re-enable "Physical Meeting" scenario → real mic → WhisperLiveKit → TranscriptEvent
- [ ] e2e: mocked WebSocket STT contract test

## Backlog (later phases)

- [ ] P4 — Argos Translate integration
- [ ] P4 — Traditional Chinese / Taiwan post-processing
- [ ] P4 — Glossary hook
- [ ] P5 — Summary pipeline draft / refined / stable
- [ ] P5 — Optional in-app autosave (opt-in)
- [ ] P5 — localStorage / IndexedDB settings persistence (P1-D6)
- [ ] P6 — Long-running memory test harness
- [ ] P6 — Reconnect / silence / no-audio-track real handling
- [ ] P7 — Electron packaging
- [ ] P7 — Sidecar lifecycle (Electron main spawning online + offline)
