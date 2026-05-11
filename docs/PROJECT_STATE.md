# PROJECT_STATE.md

> Single source of truth for **what is built / in progress / blocked**.
> Update at the end of every meaningful task.
> Plan: [`PLAN_P0.md`](PLAN_P0.md). Backlog: [`TODO.md`](TODO.md).

---

## Current Phase

**P0 — Foundation skeleton** ✅ **COMPLETE** (pending commit only)

Single P0 metric — **achieved**: `pnpm -F @meeting-audio/web dev` →
http://localhost:5173 → click **Start Fake Replay** → see partial →
revised → final captions render with bilingual translation, completely
without OpenAI or Whisper. Validated by user on 2026-05-11.

Test status (validated by user):
- `@meeting-audio/contracts`: 19 tests passed
- `@meeting-audio/web`: 13 tests passed
- Browser run: 4 sentences (English source + Traditional Chinese
  translation) rendered with status transitions and history fall-back

---

## P0 Task Status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0.1 | git init + root files | 🟡 6/7 | files done, git init done, **commit pending user `git config user.email/name`** |
| 0.2 | 11 docs/*.md skeletons | ✅ done | + `PLAN_P0.md` mirror |
| 0.3 | pnpm monorepo setup | ✅ done | package.json, workspace, tsconfig.base, eslint flat, prettier, .npmrc |
| 0.4 | packages/contracts | ✅ done | 5 zod schemas + NormalizedEvent union; **19 vitest cases green** |
| 0.5 | apps/web Vite skeleton | ✅ done | React 18 + Vite 5; project tsconfig refs |
| 0.6 | caption store + Vitest | ✅ done | Zustand vanilla + bounded ring buffer (default 500); **8 vitest cases** |
| 0.7 | FakeReplayProvider | ✅ done | zod-validated script; 14 events / 4 sentences; **5 vitest cases** |
| 0.8 | CaptionBoard component | ✅ done | bilingual large/small + 5-line history + cursor blink for non-final |
| 0.9 | services/online Fastify stub | ✅ done | `/healthz` + `/session` stub (refuses to leak API key); 2 vitest cases |
| 0.10 | services/offline FastAPI stub | ✅ done | `/healthz`; uv-managed; 1 pytest case |
| 0.11 | Playwright e2e fake-replay | ✅ done | 2 specs: full caption flow + Stop button |
| 0.12 | RUNBOOK + PROJECT_STATE update | ✅ done | this file + TODO.md updated; RUNBOOK skeleton sufficient for P0 |
| 0.13 | bootstrap scripts | ✅ done | `setup.ps1`, `doctor.ps1`, `setup.sh`, `doctor.sh` |

Legend: ✅ done · 🟡 partial · ⏳ pending · ⛔ blocked

---

## What Exists On Disk

```
meeting_audio/
├── .git/                              ✅ initialized (no commits yet)
├── CLAUDE.md  REFERENCE.md            ✅ pre-existing
├── README.md  AGENTS.md  MEMORY.md    ✅
├── .gitignore  .env.example  .editorconfig  .npmrc
├── .prettierrc.json  .prettierignore  eslint.config.js
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
│
├── apps/web/
│   ├── package.json  vite.config.ts
│   ├── tsconfig.json  tsconfig.app.json  tsconfig.node.json
│   ├── index.html
│   └── src/
│       ├── main.tsx  App.tsx  index.css  vite-env.d.ts
│       ├── caption-board/   CaptionBoard.tsx + .module.css
│       ├── store/           caption-store.ts (+ test) + use-caption-store.ts
│       ├── providers/       types.ts, fake-replay-provider.ts (+ test), use-fake-replay.ts
│       └── dev/             fake-transcript.json
│
├── services/
│   ├── online/   package.json + tsconfig + src/{server,config,routes/*}.ts (+ test) + README
│   └── offline/  pyproject.toml + app/{__init__,main}.py + tests/test_healthz.py + README
│
├── packages/contracts/
│   ├── package.json + tsconfig.json
│   └── src/   common, transcript-event, translation-event, health-event,
│              audio-level-event, index  (+ 4 *.test.ts)
│
├── docs/                              ✅ 12 files
│   ├── PLAN_P0.md  PROJECT_STATE.md  TODO.md  DECISIONS.md
│   ├── ARCHITECTURE.md  AUDIO_SOURCES.md  ONLINE_OFFLINE_MODES.md
│   ├── OFFLINE_STT.md  OFFLINE_TRANSLATION.md  FAILURE_MODES.md
│   ├── TEST_PLAN.md  RUNBOOK.md
│
├── scripts/                           ✅ setup + doctor (Win + Unix)
│
└── tests/e2e/                         ✅ playwright.config.ts + fake-replay.spec.ts + README
```

---

## How to Resume After Session/Model Switch

A new Claude session can pick up by reading, in order:

1. [`../CLAUDE.md`](../CLAUDE.md) — non-negotiable rules
2. [`PLAN_P0.md`](PLAN_P0.md) — the approved plan
3. **This file** — what's done vs pending
4. [`TODO.md`](TODO.md) — short backlog (now points at P1)
5. [`DECISIONS.md`](DECISIONS.md) — D1–D10

P0 is structurally complete. Next concrete action is **either**
finishing the P0 commit (waiting on `git config`) or starting P1 work
(scenario picker UI + audio level meter).

---

## Phase Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| **P0** | Foundation skeleton | ✅ complete (commit pending) |
| P1 | Scenario picker UI + audio level meter | ⏳ next |
| P2 | OpenAI Realtime mic path (WebRTC + session bridge) | pending |
| P3 | WhisperLiveKit spike + OfflineSTTProvider + WASAPI loopback | pending |
| P4 | Argos Translate (English → zh-Hant) | pending |
| P5 | Summary draft/refined/stable pipeline | pending |
| P6 | Reliability + long-running stability | pending |
| P7 | Electron packaging | pending |

---

## Recent Decisions

See [`DECISIONS.md`](DECISIONS.md). D1–D10 accepted at start of P0:
workspace tool (pnpm), styling (CSS Modules), schema (zod), state
(Zustand vanilla), fake transcript shape, Python env (uv), lint/format,
commit style (Conventional Commits), no Docker, remote git deferred.

## Active Blockers

- `git commit` waits on user setting `git config user.email` and
  `git config user.name`. See RUNBOOK §"Git Identity" or §"Closing P0
  with commits" below.

---

## Closing P0 — Suggested Commit Sequence

After setting `git config user.email/name` (repo-local OK), run from
the repo root. Conventional Commits per [`DECISIONS.md`](DECISIONS.md) D8.

```bash
# 1. root + docs
git add .gitignore .env.example .editorconfig README.md AGENTS.md MEMORY.md
git add docs/
git commit -m "chore: bootstrap repo with docs and root files"

# 2. monorepo + tooling
git add package.json pnpm-workspace.yaml .npmrc tsconfig.base.json \
        .prettierrc.json .prettierignore eslint.config.js
git commit -m "chore: configure pnpm workspaces, tsconfig base, eslint, prettier"

# 3. shared contracts
git add packages/
git commit -m "feat(contracts): add normalized event schemas (transcript/translation/health/audio-level)"

# 4. web app skeleton + caption path
git add apps/
git commit -m "feat(web): caption board with fake-replay provider and bounded ring-buffer store"

# 5. services
git add services/
git commit -m "feat(services): add online (Fastify) and offline (FastAPI) P0 stubs"

# 6. e2e + scripts
git add tests/ scripts/
git commit -m "test(e2e): add Playwright fake-replay spec; scripts: bootstrap + doctor"

# 7. (optional) lockfile
git add pnpm-lock.yaml
git commit -m "chore: add pnpm-lock.yaml"
```

After all commits: `git log --oneline` should show ~7 lines.

If you prefer a single commit:
```bash
git add -A
git commit -m "feat: P0 foundation skeleton"
```
