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

## Security & Privacy

- OpenAI API keys are **server-side only** — never sent to the browser.
- Offline mode does **not** call any cloud service.
- Transcripts are in-memory by default. Persistent storage requires explicit opt-in.

See [`CLAUDE.md`](CLAUDE.md) for full rules.
