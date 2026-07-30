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

## Phase 1 operating rules

### Local-only production launch

The production-style offline launchers bind both services to loopback and do
not enable Uvicorn reload:

```powershell
.\services\offline\start.bat
```

```bash
./services/offline/start.sh
```

Expected listeners are `127.0.0.1:9090` (WhisperLiveKit) and
`127.0.0.1:8000` (FastAPI). A wildcard/LAN bind is not a supported default.

### Transcript retention

**本機保存逐字稿** is off by default. While off, captions remain in memory for
the current page only and are not restored after reload. Enabling it explicitly
persists the current snapshot. Turning it off immediately removes the app's
localStorage/legacy snapshots and serially clears IndexedDB; the captions still
visible on the current page are not erased. Use Export before reload if the
meeting must be retained as a file.

### Stop before changing session configuration

While a session is running, mode, scenario, online backend, and language pair
are locked. Press **Stop**, wait for the stopped state, then change settings and
start again. Stop releases the active microphone/display track and transport;
there is no supported in-place provider handoff.

### Offline translation pressure

Offline MT is serialized through a FIFO queue with capacity 10. If translation
falls behind, the oldest queued translation is dropped so transcript reception
continues, and the UI receives `translation:degraded`. The current caption
source text remains available; do not restart WHL merely because this health
state appears. Reduce input rate or investigate MT/model performance.

### Live upstream contract probe

This release operation uses real server-side credentials and is never implied by
unit-test success. Obtain explicit authorization before running:

```powershell
pnpm -F @meeting-audio/online probe:upstream-contracts
```

Required environment variables: `OPENAI_API_KEY` and `GEMINI_API_KEY`;
`OPENAI_API_KEY_AUDIO` is an optional OpenAI 401/403 fallback. The probe creates
an OpenAI translation client secret, creates a one-use Gemini auth token, and
opens Gemini only long enough to receive `setupComplete`. It sends no audio or
transcript content.

Success writes:

```text
tests/fixtures/upstream-contracts/openai-realtime-translate.json
tests/fixtures/upstream-contracts/gemini-live-translate.json
```

Inspect both files before commit. They must contain placeholders instead of API
keys, ephemeral credentials, ids, and unstable timestamps. A failed or
unauthorized probe is an explicit unverified release operation, not a passing
Phase 1 result.

---

## Project KEEPALIVE — manual verification (needs live keys / a real meeting)

Automated coverage (238 web unit + 15 Playwright e2e) cannot exercise a real
backend failure, so verify these by hand before relying on a long meeting:

**Cross-model failover (#21):**

1. Set `OPENAI_API_KEY` and `GEMINI_API_KEY` in the system env; start the online
   service + web app; Start OpenAI and confirm captions.
2. Force a backend failure — e.g. disconnect the network for ~40 s, or block
   `api.openai.com` — until the amber pill turns to the red **「OpenAI 連線異常」
   FailoverBanner**.
3. Click **「⇄ 切換到 Gemini 繼續」**. Expect: Gemini starts, the existing
   transcript/history is preserved (NOT cleared), new captions append.
4. Repeat the reverse (Gemini → OpenAI).

**OpenAI zero-gap renewal (#7):** run an OpenAI session for ~26 min (or set a
short `session_renewal_recommended_ms` on the broker for a quick check) and watch
the renewal: captions must keep flowing with no visible gap and the OS mic
indicator must NOT blink off/on.

**Gemini persistent reconnect (#16):** during a Gemini session, drop the network
for >30 s while speaking; expect a `degraded`/`reconnecting` pill, automatic
recovery, and — if the outage is long — the `failed` pill + failover banner while
it keeps retrying.

**Lightweight soak (#18):** run Demo (fake-replay) or a live session for 30–60
min; confirm the board stays responsive, the history scrollback is capped
(`HISTORY_RENDER_SEGMENTS = 400`, full history still exports), and memory stays
bounded (DevTools → Performance memory / heap snapshot trend flat).

---

## Daily Development

```
pnpm dev                  # web + online (concurrently)
pnpm -F web dev           # web only
pnpm -F online dev        # online only
cd services/offline
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000   # offline dev only
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
pnpm lint                 # eslint
pnpm format:check         # prettier check (cross-platform EOL aware)
pnpm format               # prettier --write
pnpm typecheck            # tsc --noEmit
cd services/offline && uv run ruff check .
```

---

## Default Ports

| Service    | Port | Override env var |
| ---------- | ---- | ---------------- |
| Web (Vite) | 5173 | (Vite default)   |
| Online     | 8787 | `ONLINE_PORT`    |
| Offline    | 8000 | `OFFLINE_PORT`   |

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
macOS: `brew install uv`
Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

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

| Status             | Meaning                                                        | Operator action                                |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------- |
| 200                | Ephemeral token returned with `session_renewal_recommended_ms` | —                                              |
| 400                | Invalid request body (unknown key or bad `langPair`)           | Fix client                                     |
| 429                | Per-IP rate limit (`SESSION_RATE_LIMIT_PER_MIN`) exceeded      | Throttle client; raise env if legitimate       |
| 502                | Upstream network error (DNS, connection refused)               | Check egress firewall                          |
| 503                | `OPENAI_API_KEY` missing                                       | Set env var, restart                           |
| 401/403 persisting | Both OpenAI keys rejected upstream                             | Check key restrictions; see key failover below |

### OpenAI key failover (`OPENAI_API_KEY_AUDIO`)

The primary `OPENAI_API_KEY` may be endpoint/domain-restricted (scoped
service-account policy). Set an alternate private key in the system env as
`OPENAI_API_KEY_AUDIO`: when an upstream call is rejected with 401/403 the
server retries once with the alternate key and sticks to whichever works
(latency-first — no repeated failing round-trips). 429/5xx/timeouts never
trigger a switch. `/healthz` reports the active slot as
`components.openai_key_slot` (`primary` | `audio`). Keys are read from the
system env only — a terminal/service started before `setx` will not see a
newly added key; restart it from a fresh shell.
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

## Reading caption-latency numbers (background monitor)

A passive monitor records caption latency for the running session (no HUD, no
perf cost). To read it during/after a REAL-key session, open DevTools console:

```js
window.__latency.summary(); // current session, per provider: ttfcMs, lagP50/P95, samples
window.__latency.export(); // raw per-segment samples (for analysis)
window.__latency.history(); // last 50 past-session summaries (persisted in localStorage)
```

Metrics are ARRIVAL-based proxies (honest caveat):

- `ttfcMs` — transport 'connecting' → first translation (bring-up felt latency)
- `lagMs` — a segment's first event → its first translation (responsiveness)
- `durMs` — a segment's first event → finalization

It also logs a one-line `[latency] …` summary to the console every ~15 s. Use it
to compare OpenAI vs Gemini on the SAME spoken input and pick the faster backend.
For true spoken-word→on-screen latency, do a clap/marker test against the real
key (the monitor numbers are the repeatable in-app proxy, not microphone-truth).

## YouTube / web-page audio realtime field test

Use this when comparing OpenAI vs Gemini with a real English news video. This is
a field test because browsers require a user gesture and a picker choice for
`getDisplayMedia`; automated e2e only proves the app routes `system` audio to
display capture.

Recording is explicit. Normal use is not recorded unless the operator presses
`● Test`.

1. Start the online service + web app with both `OPENAI_API_KEY` and
   `GEMINI_API_KEY` available to the server.
2. Open a second browser tab or window with a stable English news video. Prefer a
   known segment with continuous speech and minimal music/ads; avoid changing
   videos between providers.
3. In the app, choose Scenario → **Online Meeting Caption Box**. Confirm the 🔊
   chip and the Share system audio hint are visible.
4. Select Online backend → **OpenAI**, then press `● Test`. The button changes to
   `■ Test`, meaning a field-test run is active.
5. Click Start, then in the browser share picker choose the YouTube tab or Entire
   Screen and enable audio sharing.
6. Let the same clip run for 60-120 seconds. Press the app **Stop** button to
   stop the provider and finish the field-test run. Pressing `■ Test` also
   finishes the run without stopping the provider.
7. Rewind the YouTube video to the same timestamp. Switch Online backend →
   **Gemini**, press `● Test`, click Start, share the same YouTube tab/screen
   with audio, run for the same duration, then press **Stop**.
8. Press `⬇ Test` to download the recorded field-test JSON, or inspect it from
   DevTools console:

   ```js
   console.log(
     JSON.stringify(
       {
         fieldHistory: window.__fieldTest.history(),
         latencySummary: window.__latency.summary(),
         latencyHistory: window.__latency.history(),
       },
       null,
       2,
     ),
   );
   ```

Optional markers while a run is active:

```js
window.__fieldTest.mark('first visible caption');
window.__fieldTest.mark('noticeable stall');
```

Manual recorder control remains available for special cases, but should not be
needed for the standard YouTube comparison:

```js
window.__fieldTest.startTimed('YT OpenAI manual', 120_000, 'video title + timestamp');
window.__fieldTest.finish('manual early stop');
```

Compare each run's `runSummary` (`lagP50`, `lagP95`, `durP50`, samples),
`latencySummaryAtFinish`, and captured settings (`onlineProvider`, `audioSource`,
`langPair`). The recorder is arrival-based; for true video-audio-to-screen
latency, record the browser window and caption board together and align on a
visible spoken-word/scene marker.

Pass criteria for venue use: both providers must show non-silent audio levels,
no blank caption board after the first spoken sentence, and no repeated
multi-second stalls. As of 2026-06-29 the Gemini translate path defaults to the
official low-latency Live Translate setup (`AUDIO` response modality +
`outputAudioTranscription` text side channel). If Gemini is still materially
slower on the same clip, inspect per-utterance output-transcription cadence
before changing chunk size; the client audio chunk is already 32 ms.

## Open Questions

- Recommended Node version manager (volta? nvm-windows?) — to be decided
  based on team preference.
