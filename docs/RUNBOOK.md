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

## Open Questions

- Recommended Node version manager (volta? nvm-windows?) — to be decided
  based on team preference.
