# AGENTS.md

> Repo-level instructions for coding agents (Codex / Claude Code / others).
> The authoritative project constitution is [`CLAUDE.md`](CLAUDE.md). When in
> doubt, CLAUDE.md wins. This file restates only the parts that any coding
> agent — regardless of model — must know to act safely.

---

## Required Reading Order

1. [`CLAUDE.md`](CLAUDE.md) — non-negotiable rules
2. [`REFERENCE.md`](REFERENCE.md) — official docs and reference projects
3. [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — what is built / in progress / blocked
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers and contracts
5. [`docs/TODO.md`](docs/TODO.md) — current backlog
6. The doc(s) that match the layer you are touching:
   - `docs/AUDIO_SOURCES.md`
   - `docs/ONLINE_OFFLINE_MODES.md`
   - `docs/OFFLINE_STT.md`
   - `docs/OFFLINE_TRANSLATION.md`
   - `docs/FAILURE_MODES.md`
   - `docs/TEST_PLAN.md`
   - `docs/RUNBOOK.md`

---

## Setup

See [`README.md`](README.md) Quick Start. Bootstrap scripts:
- Windows: `.\scripts\setup.ps1`
- Unix:    `./scripts/setup.sh`

Always run `scripts/doctor` after setup to verify the environment.

---

## Development Commands

```
pnpm install              # install all workspace deps
pnpm dev                  # start web + online (concurrently)
pnpm -F web dev           # web only
pnpm -F online dev        # online service only
pnpm test                 # all unit tests (Vitest across packages)
pnpm test:e2e             # Playwright e2e
pnpm lint                 # eslint + prettier check
pnpm typecheck            # tsc --noEmit across workspaces

cd services/offline
uv sync                   # install Python deps
uv run uvicorn app.main:app --port 8000
uv run pytest             # Python tests
uv run ruff check .       # Python lint
```

---

## Hard Rules (do not violate)

These are abbreviations of [`CLAUDE.md`](CLAUDE.md) — read it for full context.

1. **Caption path is sacred.** Summary, translation, model loading, persistence, animation must never block caption rendering.
2. **API keys are server-side only.** No `OPENAI_API_KEY` in any browser bundle, log, or commit.
3. **No China-origin core models or cloud APIs** (Qwen, DeepSeek, GLM, FunASR, SenseVoice, Baidu, Tencent, iFlytek, Alibaba Cloud).
4. **Online and Offline are both first-class.** Do not stub one and ship the other.
5. **UI consumes normalized events only** from `packages/contracts`. Never bind UI to a provider's raw event shape.
6. **GPT-Realtime-2 is sidecar only.** Main online caption/translation path uses Realtime Translation / Whisper.
7. **No naive Whisper chunking.** Offline STT must use VAD + rolling buffer + streaming policy.
8. **Default audio policy is exclusive or separate_tracks.** Mixing is opt-in and warns the user.

---

## Workflow Expectations

For any non-trivial change:

1. **Explore** — read the relevant docs and code first.
2. **Plan** — write or update a plan; align on approach before editing.
3. **Implement** — smallest robust vertical slice.
4. **Verify** — tests, Playwright check, screenshot, or reproducible manual steps. Code compiling is *not* verification.
5. **Update docs** — `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`, `docs/TODO.md` as relevant.
6. **Report** — what changed / files / how to run / how verified / risks / next.

---

## Subagent Map (when delegating)

| Topic | Subagent intent |
|-------|-----------------|
| OpenAI Realtime, WebRTC, SDP, session tokens | realtime-webrtc-agent |
| WhisperLiveKit, faster-whisper, VAD, streaming policy | offline-stt-agent |
| Mic, browser tab/system audio, WASAPI loopback | audio-capture-agent |
| Fullscreen caption board, accessibility, typography | caption-ux-agent |
| Summary draft/refined/stable pipeline | summary-agent |
| Reconnect, silence, long-running tests, bounded memory | reliability-agent |
| API key handling, offline guarantee, retention, deps | security-review-agent |

---

## Done Definition (per [`CLAUDE.md`](CLAUDE.md))

A feature is done only when:
- it works in the app
- visible success/failure states exist
- it emits normalized events if relevant
- it does not violate Online/Offline separation
- it does not block the caption path
- it has tests or reproducible verification
- it updates the relevant docs
- it does not expose secrets
- it does not fake unsupported capability
