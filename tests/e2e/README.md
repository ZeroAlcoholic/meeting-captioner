# tests/e2e

Playwright cross-app end-to-end tests.

## First-time setup
```
pnpm exec playwright install chromium
```

## Run
```
pnpm test:e2e
```

The config auto-spawns `pnpm -F @meeting-audio/web dev` on port 5173 if
no dev server is already running.

## What this covers in P0
- Caption board renders empty state
- Start Fake Replay produces transcript + translation final states
- Specific scripted text appears (zh-Hant target + en source)
- Stop button halts the replay

## Future
- Provider switch without transcript loss (P2/P3)
- Failure-state surfaces (no audio track, silence, online API error)
- Long-running stability (P6)
