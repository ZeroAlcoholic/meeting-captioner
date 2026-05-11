# TODO.md

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

- [ ] Close P1 with commits (suggested 5-commit sequence in
      [`PROJECT_STATE.md`](PROJECT_STATE.md) §"Closing P1 — Suggested Commit Sequence")

## P0 (done)

13 tasks complete. 8 commits in git history. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P0.md`](PLAN_P0.md).

## P1 (done)

11 tasks complete. Web 46 unit + 8 Playwright e2e tests green. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P1.md`](PLAN_P1.md).

## Next phase — P2: OpenAI Realtime mic path

P2 is where real OpenAI usage begins. Per CLAUDE.md, the API key stays
server-side (`services/online`); the browser receives a short-lived
client_secret and connects directly to OpenAI Realtime over WebRTC.

- [ ] `services/online` `POST /session` — replace stub with real OpenAI
      session creation (returns `client_secret` for Realtime Translation)
- [ ] Add OpenAI dependency only to `services/online` (NEVER to web)
- [ ] `apps/web/src/providers/openai-realtime-provider.ts` — implements
      `CaptionProvider` over WebRTC + data channel
- [ ] `apps/web/src/providers/microphone-audio-provider.ts` — wraps
      `getUserMedia({ audio: true })`; handles permission states
- [ ] Surface `requesting_permission` / `connecting` / `connected` /
      `failed` / `api_error` / `silence_detected` via existing HealthRow
- [ ] Audio level meter wired to real `AnalyserNode` from MediaStream
- [ ] App-level mode switch: when `modeId === 'online_full'`, show
      a "Use real OpenAI" toggle (gated by `OPENAI_API_KEY` server check)
- [ ] e2e: skipped if no `OPENAI_API_KEY`; replaced by mocked WebRTC
      contract test
- [ ] Reliability: reconnect on transient failure, fall back to fake on
      hard failure, never blank captions

## Backlog (later phases)

- [ ] P3 — WhisperLiveKit spike + OfflineSTTProvider adapter
- [ ] P3 — WASAPI loopback via PyAudioWPatch (Windows-first)
- [ ] P3 — Re-enable Advanced Manual scenario (real source picker)
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
