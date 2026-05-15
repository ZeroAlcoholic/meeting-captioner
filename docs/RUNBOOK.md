# RUNBOOK.md

> Day-to-day commands, troubleshooting, and operational notes.

---

## First-time setup

See [`README.md`](../README.md) Quick Start.

TL;DR:

```powershell
# Windows
.\scripts\setup.ps1
.\scripts\doctor.ps1
```

```bash
# Unix
./scripts/setup.sh
./scripts/doctor.sh
```

---

## Daily Development

```
pnpm dev                  # web + online (concurrently)
pnpm -F web dev           # web only
pnpm -F online dev        # online only
cd services/offline
uv run uvicorn app.main:app --port 8000   # offline only
```

Open http://localhost:5173.

---

## Tests

```
pnpm test                 # all Vitest unit tests
pnpm -F contracts test    # one workspace
pnpm test:e2e             # Playwright
cd services/offline && uv run pytest
```

---

## Lint / Format / Typecheck

```
pnpm lint                 # eslint + prettier --check
pnpm format               # prettier --write
pnpm typecheck            # tsc --noEmit
cd services/offline && uv run ruff check .
```

---

## Default Ports

| Service | Port | Override env var |
|---------|------|------------------|
| Web (Vite) | 5173 | (Vite default) |
| Online | 8787 | `ONLINE_PORT` |
| Offline | 8000 | `OFFLINE_PORT` |

Free a port (Windows):

```powershell
Get-NetTCPConnection -LocalPort 5173 | Select-Object OwningProcess
Stop-Process -Id <pid>
```

Free a port (Unix):

```bash
lsof -i :5173
kill <pid>
```

---

## Git Identity

If `git commit` fails with "Author identity unknown":

```
git config user.email "you@example.com"
git config user.name "Your Name"
```

(omit `--global` to keep it scoped to this repo).

---

## Reinstall From Scratch

```
# Remove deps and lockfiles
rm -rf node_modules apps/*/node_modules services/online/node_modules packages/*/node_modules
rm -rf services/offline/.venv

# Reinstall
pnpm install
cd services/offline && uv sync
```

---

## Common Issues

### `pnpm: command not found`
Run `npm install -g pnpm`, then re-open the shell.

### `uv: command not found`
Windows: `winget install --id=astral-sh.uv -e`
macOS:   `brew install uv`
Linux:   `curl -LsSf https://astral.sh/uv/install.sh | sh`

### Port already in use
See "Default Ports" above.

### CRLF warnings on Windows
Expected. Git is normalizing to LF on commit; harmless.

### Playwright browsers not installed
`pnpm exec playwright install`

---

## Closing P0 with commits

See [`PROJECT_STATE.md`](PROJECT_STATE.md) §"Closing P0 — Suggested
Commit Sequence" for a 7-commit Conventional Commits split, or use a
single commit if you prefer.

Steps:
1. Set git identity once (repo-local; CLAUDE.md forbids agents touching
   global git config):
   ```
   git config user.email "you@example.com"
   git config user.name "Your Name"
   ```
2. Run the commit sequence.
3. Verify: `git log --oneline` shows your commits.

## Online Stack Operations

### `/healthz` schema

```json
{
  "ok": true,
  "service": "online",
  "version": "0.0.0",
  "timestamp": "2026-…",
  "components": {
    "apiKey": "configured | missing",
    "openai_reachability": "unknown | ok | degraded",
    "openai_last_change_at": "ISO timestamp",
    "uptime_sec": 123
  }
}
```

`ok` is `true` only when `apiKey === 'configured'` AND
`openai_reachability !== 'degraded'`. The reachability flag is updated
opportunistically on every `/session` call — `/healthz` itself does not
ping OpenAI.

### `/session` failure modes

| Status | Meaning | Operator action |
|--------|---------|-----------------|
| 200 | Ephemeral token returned with `session_renewal_recommended_ms` | — |
| 400 | Invalid request body (unknown key or bad `langPair`) | Fix client |
| 429 | Per-IP rate limit (`SESSION_RATE_LIMIT_PER_MIN`) exceeded | Throttle client; raise env if legitimate |
| 502 | Upstream network error (DNS, connection refused) | Check egress firewall |
| 503 | `OPENAI_API_KEY` missing | Set env var, restart |
| 504 | Upstream took longer than `OPENAI_TIMEOUT_MS` | Check OpenAI status page; raise env if needed |
| Upstream 4xx/5xx | Forwarded with **sanitized** message — full body logged server-side only | `pino` log shows raw upstream body |

### Session renewal

- Client renews ~25 min in (`SESSION_RENEW_MS`) before OpenAI's hard 30-min cap.
- Renewal preserves `captionStore` — the meeting transcript is continuous.
- If renewal itself fails, provider emits `health.transport.degraded` and
  retries once after 5 min instead of dying silently.

### ICE restart policy

- 3 attempts, exponential backoff: 3 s → 6 s → 12 s.
- Restart counter resets when ICE returns to `connected` / `completed`.
- After 3 failed attempts, provider emits `health.transport.failed` and stops.

### Graceful shutdown

- `SIGINT` / `SIGTERM` triggers `app.close()` with a 5-second hard timeout.
- `start-dev.bat` Ctrl+C propagates to the online process via `concurrently`.

---

## Open Questions

- Recommended Node version manager (volta? nvm-windows?) — to be decided
  based on team preference.
