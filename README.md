# Meeting Audio

Meeting-grade live caption, translation, and semi-realtime summary system.

Supports both:

- **Online Realtime** — OpenAI Realtime Translation / Whisper, browser audio via WebRTC, backend audio via WebSocket
- **Offline Local** — local STT (WhisperLiveKit / faster-whisper), local translation (Argos), local audio capture (incl. Windows WASAPI loopback)

> **Project status:** P0 — Foundation skeleton. See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

---

## Quick Start (Fresh Machine)

### Prerequisites

- **git**
- **Node.js 22 LTS** (https://nodejs.org/)
- **Python 3.11+** (https://www.python.org/) — `uv` can also install Python for you
- The bootstrap script will install **pnpm** and **uv** if missing.

### Windows (PowerShell)

```powershell
git clone <repo-url> meeting_audio
cd meeting_audio
.\scripts\setup.ps1            # installs pnpm/uv if missing, runs install
.\scripts\doctor.ps1           # verifies environment
pnpm dev                       # starts web + online stub
# In another terminal:
cd services\offline
uv run uvicorn app.main:app --port 8000
```

### macOS / Linux (bash)

```bash
git clone <repo-url> meeting_audio
cd meeting_audio
./scripts/setup.sh
./scripts/doctor.sh
pnpm dev
# In another terminal:
cd services/offline && uv run uvicorn app.main:app --port 8000
```

Then open http://localhost:5173 and click **Start Fake Replay** to verify the caption path.

---

## Repository Layout

```
apps/web/              # Vite + React + TS — caption board UI
services/online/       # Fastify — OpenAI session bridge
services/offline/      # FastAPI — local STT/MT
packages/contracts/    # Shared TS event schemas (TranscriptEvent, ...)
docs/                  # Architecture, decisions, runbook, test plan
scripts/               # Bootstrap and environment doctor
tests/e2e/             # Playwright cross-app tests
```

---

## Project Documents

- [`CLAUDE.md`](CLAUDE.md) — Project constitution, non-negotiable rules
- [`REFERENCE.md`](REFERENCE.md) — Technical reference index
- [`AGENTS.md`](AGENTS.md) — Coding-agent (Codex) instructions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System architecture
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — Day-to-day commands and troubleshooting
- [`docs/TODO.md`](docs/TODO.md) — Active work and backlog

---

## Environment Variables

**Strict policy: NO `.env` files.** All env vars are read from the user's system environment only. There is a guard test (`services/online/src/server.test.ts`) that fails the build if `dotenv` is re-introduced.

Set these in your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.profile`) or via Windows `setx`:

### Online service (`services/online`)

| Variable                     | Required              | Default                 | Purpose                                            |
| ---------------------------- | --------------------- | ----------------------- | -------------------------------------------------- |
| `OPENAI_API_KEY`             | yes (for Online mode) | —                       | Server-side OpenAI key. Never sent to the browser. |
| `ONLINE_PORT`                | no                    | `8787`                  | Fastify bind port.                                 |
| `ONLINE_CORS_ORIGIN`         | no                    | `http://localhost:5173` | CORS allow-list (single origin).                   |
| `OPENAI_TIMEOUT_MS`          | no                    | `10000`                 | Hard ceiling on upstream `client_secrets` call.    |
| `SESSION_RATE_LIMIT_PER_MIN` | no                    | `30`                    | Token-bucket cap on `POST /session` per remote IP. |
| `SESSION_RENEW_MS`           | no                    | `1500000`               | Browser session lifetime before renewal (25 min).  |

### Offline service (`services/offline`)

| Variable              | Required | Default                                       | Purpose                                                            |
| --------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `OFFLINE_PORT`        | no       | `8000`                                        | FastAPI bind port.                                                 |
| `OFFLINE_CORS_ORIGIN` | no       | `http://localhost:5173,http://localhost:5174` | CORS allow-list (comma-separated).                                 |
| `WHL_MODEL`           | no       | (see `run_whl.py`)                            | WhisperLiveKit model selector.                                     |
| `OMP_NUM_THREADS`     | no       | `8`                                           | Thread count for OpenMP/MKL (set before importing faster-whisper). |

### Web app (`apps/web`, build-time only — `VITE_` prefix)

| Variable                | Required | Default                 | Purpose                                                |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------ |
| `VITE_ONLINE_BASE_URL`  | no       | `http://localhost:8787` | Online service URL the browser hits.                   |
| `VITE_OFFLINE_BASE_URL` | no       | `http://localhost:8000` | Offline service URL.                                   |
| `VITE_DEPLOYMENT_MODE`  | no       | `dev`                   | `online` to tree-shake offline path out of the bundle. |

### Setting `OPENAI_API_KEY`

```bash
# Linux / macOS — persist in shell profile
echo 'export OPENAI_API_KEY="sk-proj-..."' >> ~/.bashrc   # or ~/.zshrc
```

```powershell
# Windows — persist across sessions
setx OPENAI_API_KEY "sk-proj-..."
# (open a new terminal for the change to take effect)
```

---

## Security & Privacy

- OpenAI API keys are **server-side only** — never sent to the browser.
- Offline mode does **not** call any cloud service.
- Transcripts are in-memory by default. Persistent storage requires explicit opt-in.

See [`CLAUDE.md`](CLAUDE.md) for full rules.
