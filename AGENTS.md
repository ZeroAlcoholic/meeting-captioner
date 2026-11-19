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
- Unix: `./scripts/setup.sh`

Always run `scripts/doctor` after setup to verify the environment.

---

## Development Commands

### 日常服務所有權（2026-10-06）

- Windows 日常啟動一律優先使用 `pnpm service:start`，先以
  `pnpm service:status` 查現有實例。重複 start 會重用，不再手動背景啟動 `8787`／`8000`。
- 實際網址以 status 的 `url` 為準，不能假定候選埠 `43871` 永遠可用。
- 使用 `pnpm service:stop` 停止本工作區實例。不可只依 PORT、程序名稱或 PID 檔殺程序。
- 此入口由工作區 owner 持有單一線上 HTTP 子程序；完整 Offline／Hybrid 與 HMR 開發僅在任務確實需要時另啟動。W08.1 程序復原與 W08.2 舊頁接續已完成本機驗收；真服務與場域放行仍待驗。
- `pnpm dev`／既有發行 ZIP 是獨立的舊入口，不受 managed singleton 管理；
  不可與日常服務無目的地重複啟動。更新日常版本須先 stop 再 start。

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
4. **Verify** — tests, Playwright check, screenshot, or reproducible manual steps. Code compiling is _not_ verification.
5. **Update docs** — `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`, `docs/TODO.md` as relevant.
6. **Report** — what changed / files / how to run / how verified / risks / next.

---

## Subagent Map (when delegating)

| Topic                                                  | Subagent intent       |
| ------------------------------------------------------ | --------------------- |
| OpenAI Realtime, WebRTC, SDP, session tokens           | realtime-webrtc-agent |
| WhisperLiveKit, faster-whisper, VAD, streaming policy  | offline-stt-agent     |
| Mic, browser tab/system audio, WASAPI loopback         | audio-capture-agent   |
| Fullscreen caption board, accessibility, typography    | caption-ux-agent      |
| Summary draft/refined/stable pipeline                  | summary-agent         |
| Reconnect, silence, long-running tests, bounded memory | reliability-agent     |
| API key handling, offline guarantee, retention, deps   | security-review-agent |

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
