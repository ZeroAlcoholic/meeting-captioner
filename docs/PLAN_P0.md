# PLAN_P0.md — P0 Foundation Skeleton

> **Mirror of the approved plan.** Original was authored at
> `~/.claude/plans/linear-sniffing-hanrahan.md` (per-user) and is mirrored
> here so it survives session/model switches and is visible to anyone who
> clones the repo. **If the plan changes, update both files.**
>
> **Status:** Approved by user. Executing.
> **Live progress:** see [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## 1. Context

`C:\Develop\meeting_audio` started with only `CLAUDE.md` (constitution)
and `REFERENCE.md` (tech index) — no source, no deps, no docs skeleton,
no git repo.

CLAUDE.md pins architecture, implementation order, non-negotiables, and
"done" definition, but does not say what the repo should look like
**before** the first OpenAI / Whisper line is written. P0 fills that gap.

P0 = a minimum running skeleton where every later vertical slice (Online
mic / Offline STT / Caption Board / Summary) can be plugged in without
restructuring.

**Single P0 success metric:** open the browser, see a fullscreen caption
board fed by local fake-transcript replay, with `partial → revised → final`
state transitions visible — **no OpenAI, no Whisper required**. This fake
path is a permanent regression harness for "caption path is sacred".

---

## 2. Repo Layout (target)

```
meeting_audio/
├── CLAUDE.md                       # constitution
├── REFERENCE.md                    # tech index
├── AGENTS.md                       # Codex compat
├── README.md                       # dev entry
├── MEMORY.md                       # AI agent project memory
├── .gitignore  .env.example  .editorconfig
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
│
├── apps/web/                       # Vite + React + TS — caption board
│   └── src/{caption-board, store, providers, dev/fake-transcript.json}
│
├── services/
│   ├── online/                     # Fastify — OpenAI session bridge (stub in P0)
│   └── offline/                    # FastAPI — local STT/MT (stub in P0)
│
├── packages/contracts/             # Shared TS event schemas (zod)
│
├── docs/                           # 11 spec docs (this file is one of them)
│
├── scripts/                        # setup.ps1/.sh, doctor.ps1/.sh
│
└── tests/e2e/                      # Playwright fake-replay spec
```

**Why monorepo:** `packages/contracts` is shared between `apps/web` and
`services/online`. CLAUDE.md's Provider Abstraction rule requires the UI
to consume normalized events only — that is enforceable only if the
schema lives in a shared package.

**Why Python sidecar instead of npm workspace:** ML stack and Node
lifecycle don't mix. Future Electron will spawn Python the same way.

---

## 3. Task Breakdown (P0)

| # | Task | Output | Verification |
|---|------|--------|--------------|
| 0.1 | git init + root files (.gitignore, .env.example, README, AGENTS, MEMORY) | First commit | `git log` shows 1 commit |
| 0.2 | 11 docs/*.md skeletons (purpose / scope / open questions sections) | 11 md files | each has 3 named sections |
| 0.3 | pnpm monorepo + tsconfig.base + eslint + prettier | root configs | `pnpm install` clean |
| 0.4 | packages/contracts: TS types + zod schemas + Vitest | published-shape package | `pnpm -F contracts test` green |
| 0.5 | apps/web Vite + React + TS skeleton | runs | `pnpm -F web dev` shows title |
| 0.6 | caption store (bounded ring buffer, default 500) + Vitest | store module | covers partial/revised/final + eviction |
| 0.7 | FakeReplayProvider + fake-transcript.json | provider module | events visible in console |
| 0.8 | CaptionBoard component (large bilingual, last-5 history) | React component | live captions via fake replay |
| 0.9 | services/online Fastify stub: POST /session, GET /healthz | Node server | curl returns 200 |
| 0.10 | services/offline FastAPI stub: GET /healthz | Python server | curl returns 200 |
| 0.11 | Playwright e2e: open page, click Start Fake Replay, assert ≥1 final caption | spec file | `pnpm test:e2e` green |
| 0.12 | RUNBOOK + PROJECT_STATE update | docs | new dev sees board in 5 min |
| 0.13 | bootstrap scripts (setup + doctor for Win/Unix) | 4 scripts | clean machine → setup → dev works |

---

## 4. Confirmed Decisions

| # | Topic | Choice |
|---|-------|--------|
| D1 | Workspace tool | **pnpm workspaces** |
| D2 | Styling | **plain CSS / CSS Modules** (CLAUDE.md L77) |
| D3 | Schema validation | **zod** (TS types inferred from schemas) |
| D4 | Caption state | **Zustand vanilla** (decoupled from React render) |
| D5 | Fake transcript | JSON `{ tMs, kind, segmentId, status, text }` |
| D6 | Python env | **uv** + `pyproject.toml` |
| D7 | Lint/format | ESLint + Prettier (TS), Ruff (Py) |
| D8 | Commit style | Conventional Commits |
| D9 | No Docker for dev/runtime | bootstrap scripts instead |

Pre-flight (user environment):
- `npm install -g pnpm`
- `winget install --id=astral-sh.uv -e` (or `pip install uv`)

---

## 5. Out of Scope for P0 (explicit)

Not in P0 — each has its own future phase:
- OpenAI Realtime (P2)
- WhisperLiveKit spike (P3)
- WASAPI loopback (P3)
- Argos translation (P4)
- Summary pipeline (P5)
- Reliability long-running tests (P6)
- Electron packaging (P7)
- Real scenario picker logic (P1; P0 only places stubs)

---

## 6. Done Definition (P0)

- [ ] `pnpm install` clean on a fresh machine
- [ ] `pnpm -F web dev` → caption board renders
- [ ] `pnpm -F online dev` → `/healthz` returns 200
- [ ] `cd services/offline && uv run uvicorn app.main:app` → `/healthz` returns 200
- [ ] Click **Start Fake Replay** → ≥3 captions, with status transitions
- [ ] `pnpm test` green (contracts + store)
- [ ] `pnpm test:e2e` green (fake-replay spec)
- [ ] `docs/PROJECT_STATE.md` marks P0 complete
- [ ] git log has clean commit series
- [ ] **Cross-machine:** another clean machine → `setup` → `doctor` → `dev` → caption board within 10 minutes

---

## 7. Cross-Machine Bootstrap

### Install matrix by phase

| Phase | Required | Approx size | Network |
|-------|----------|-------------|---------|
| **P0** | git, Node 22 LTS, pnpm, Python 3.11+, uv | ~600 MB | one-time `pnpm install` + `uv sync` |
| P2 | + OpenAI API key | same | runtime to OpenAI |
| P3 | + ffmpeg + Whisper model (small ~500MB / medium ~1.5GB) | +2 GB | first model download |
| P3 (Win) | + PyAudioWPatch | +20 MB | — |
| P7 | + Electron Builder | +200 MB | at packaging time |

P0 has light install footprint (no ML models, no native extensions).

### Bootstrap script responsibilities

`scripts/setup.ps1` (Win) / `scripts/setup.sh` (Unix):

1. Detect missing tools; offer install via winget / brew / curl (only after consent)
   - Node 22+, pnpm, Python 3.11+, uv (git only checked, never auto-installed)
2. Copy `.env.example` → `.env` if missing
3. Run `pnpm install` and `cd services/offline && uv sync`
4. Run `doctor` to verify
5. Print next-step commands

Principles:
- Print "please run X manually" rather than fail silently
- No project-specific environment magic (no PATH edits, no registry writes, no service installs)
- Idempotent

### `scripts/doctor` responsibilities

- Print versions of node/pnpm/python/uv/git
- Verify `.env` exists (don't read values)
- Check pnpm lockfile is up to date
- Check Python venv is in sync
- Check ports 5173 / 8787 / 8000
- Print ✅/⚠️/❌ summary

### Standard "fresh machine" boot sequence

```powershell
# Windows
git clone <repo-url> meeting_audio
cd meeting_audio
.\scripts\setup.ps1
.\scripts\doctor.ps1
pnpm dev
# In another terminal:
cd services\offline; uv run uvicorn app.main:app --port 8000
# Browse to http://localhost:5173, click Start Fake Replay
```

```bash
# macOS / Linux
git clone <repo-url> meeting_audio
cd meeting_audio
./scripts/setup.sh
./scripts/doctor.sh
pnpm dev
# In another terminal:
cd services/offline && uv run uvicorn app.main:app --port 8000
```

### Why not Docker

Considered Docker Compose for "easy install everywhere" but rejected:
- Docker Desktop adds >2 GB
- WASAPI loopback (P3) is essentially impossible inside Windows containers
- Slows dev iteration

Bootstrap scripts get the same effect at lower cost.

---

## 8. Self-Review

### Aligned with CLAUDE.md
- Caption path is sacred → fake-replay path stands up first; failures elsewhere can't take it down
- Online and Offline both first-class → both services have stubs from day one
- Provider Abstraction → contracts package exists before any UI consumer
- API key server-side only → web has zero OpenAI code; key goes in `services/online` only at P2
- No premature Electron → Electron deferred to P7

### Risks acknowledged but accepted
- Monorepo overhead for one developer — paid back fast by shared contracts
- 11 doc skeletons — required by CLAUDE.md anyway
- zod runtime cost — negligible vs the bug-prevention value at provider boundaries
- FastAPI stub before real STT — only `/healthz`, ~10 lines

### What P0 buys you
1. **Spine of the caption path:** contracts + store + fake replay
2. **First visible product shape:** CaptionBoard fullscreen UI
3. **In-repo constitution:** 11 doc skeletons future agents can fill in

---

## 9. Phases After P0 (preview)

| Phase | Focus |
|-------|-------|
| P1 | Scenario picker UI + audio level meter |
| P2 | OpenAI Realtime mic path (WebRTC + session bridge) |
| P3 | WhisperLiveKit spike + OfflineSTTProvider + WASAPI loopback |
| P4 | Argos Translate (English → zh-Hant) + glossary |
| P5 | Summary draft / refined / stable pipeline |
| P6 | Reliability + long-running stability tests |
| P7 | Electron packaging |
