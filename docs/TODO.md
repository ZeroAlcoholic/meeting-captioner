# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

- [ ] Commit all P2 + P2+ changes (see `git status`; conventional commits)
- [ ] P3 — start offline STT path (see below)

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

Prerequisites ✅ already done (P2+):
- `AudioSource` interface — WASAPI loopback can be dropped in without touching providers
- `TranslationPipeline` interface — Argos MT can be plugged in as separate step
- `VITE_OFFLINE_SERVICE_URL` config — no hardcoded localhost in hooks
- `CaptionProvider.start(): Promise<void>` — correct async contract for all new providers

P3 tasks:
- [ ] `pip install whisper-live` — natively on Windows (no Docker); verify server starts on port 9090
- [ ] `services/offline` — FastAPI app, `whisper_live.server.TranscriptionServer` lifecycle, `/healthz` endpoint
- [ ] `apps/web/src/providers/offline-stt-provider.ts` — WebSocket client ws://OFFLINE_SERVICE_URL, normalize `{ segments }` → TranscriptEvent
- [ ] `apps/web/src/providers/use-offline-stt.ts` — React hook (mirrors use-openai-realtime pattern)
- [ ] Wire "Physical Meeting" scenario in App → mic AudioSource → offline-stt-provider
- [ ] Surface `model_loading` / `offline_engine_unavailable` / `silence_detected` via HealthRow
- [ ] Windows WASAPI loopback via PyAudioWPatch — inject as AudioSource for "Online Meeting Caption Box" scenario
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
