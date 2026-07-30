# MEMORY.md

> Project-level memory hints for AI coding agents working in this repo.
> This file is **tracked in git** and shared across machines/users.
> Personal/per-user agent memory belongs in the agent's own user directory.

---

## What this file is for

Stable facts about the project that help an agent get oriented faster than
re-reading every doc on every session. Keep entries short and link to the
authoritative source.

If a fact lives somewhere authoritative (CLAUDE.md, docs/), do not duplicate
the content here — link to it.

---

## Authoritative References

- Constitution: [`CLAUDE.md`](CLAUDE.md)
- Tech index: [`REFERENCE.md`](REFERENCE.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- State: [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)

---

## Project Snapshot

- **Phase:** P0 — Foundation skeleton (see `docs/PROJECT_STATE.md` for current state)
- **Stack:** pnpm workspaces + Vite/React/TS (web), Fastify (online), FastAPI/uv (offline)
- **OS targets:** Windows 11 (primary), macOS, Linux
- **Caption path engines:** Online — OpenAI Realtime Translation; Offline — WhisperLiveKit (first try) / faster-whisper (fallback)
- **Translation:** Online — OpenAI; Offline — Argos Translate (English → Traditional Chinese)
- **Excluded by policy:** China-origin models / cloud APIs (see `CLAUDE.md` §"No China-Origin Core Models")

---

## Operational Reminders for Agents

- Always run `scripts/doctor` after setup changes; it will report mismatched versions or stale lockfiles.
- Default ports: web `5173`, online `8787`, offline `8000`. Override via system env vars (e.g., `ONLINE_PORT`).
- Strict policy: NO `.env` files. All env vars (incl. `OPENAI_API_KEY`) come from the user's system environment. Guard test in `services/online/src/server.test.ts` blocks dotenv regression. See README "Environment Variables".
- The fake transcript replay path (`apps/web/src/dev/fake-transcript.json` + `FakeReplayProvider`) is the canonical regression harness for the caption path. Keep it working.
