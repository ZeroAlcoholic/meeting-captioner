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

## KEEPALIVE reliability (`online-keepalive.spec.ts` + `online-mock.ts`)

`online-mock.ts` provides `installOnlineMocks(page)`: an in-browser mock backend
for both online providers (no cloud key needed). It replaces
`RTCPeerConnection`/`RTCDataChannel`, `WebSocket` (Gemini host ONLY — every other
URL, incl. Vite HMR, passes through to the native impl), `getUserMedia`/
`getDisplayMedia`, and `AudioContext`/`AudioWorkletNode`, and routes the
`/session`, `/session/info`, `/session/gemini` and OpenAI SDP endpoints. The
returned controller injects faults and reads counters:

- `oaiInput/oaiOutput/oaiComplete/oaiClosed` — drive the OpenAI DataChannel
- `failOaiSessionFrom(n)` — make `/session` 500 from the Nth call (renewal fail)
- `micAcquisitions()` / `userMediaAcquisitions()` / `displayMediaAcquisitions()` — source routing assertions
- `oaiPeerCount()` / `oaiReady()` — zero-gap assertions
- `geminiServerContent/geminiClose/geminiOpenSockets` — drive/inspect Gemini WS

Covered: OpenAI happy path, Online Meeting Caption Box system-audio routing
(OpenAI and Gemini both use `getDisplayMedia`), zero-gap renewal (capture reused,
history kept), repeated renewals never blank, OpenAI-fail → Gemini failover with
transcript preserved, Gemini happy path + auto-reconnect. See `docs/TEST_PLAN.md`
§"KEEPALIVE … (T0–T2)".

## Future

- Failure-state surfaces (no audio track, audio source ended)
- Offline/hybrid server-unavailable e2e
