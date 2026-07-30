# TEST_PLAN.md

> Test categories and what counts as evidence.
> See [`CLAUDE.md`](../CLAUDE.md) §"Verification Gates" and §"Required Test Categories".

---

## Test Levels

| Level             | Tool                            | Where                            | What it covers                           |
| ----------------- | ------------------------------- | -------------------------------- | ---------------------------------------- |
| Unit              | Vitest                          | `packages/contracts`, `apps/web` | event schema, store reducers, pure logic |
| Component         | Vitest + Testing Library        | `apps/web`                       | React components in isolation            |
| Service unit      | Vitest                          | `services/online`                | route handlers, validators               |
| Service unit (Py) | pytest                          | `services/offline`               | adapters, VAD, streaming policy          |
| Integration       | scripts in `tests/integration/` | spawn services, hit endpoints    | service ↔ contract correctness           |
| E2E               | Playwright                      | `tests/e2e/`                     | full UI flows, fake replay               |
| Stability         | custom harness                  | `tests/stability/`               | long-running memory + reconnect          |

---

## Required Test Categories (from CLAUDE.md)

- [x] event schema normalization — `apps/web/src/providers/provider-conformance.test.ts` validates every event each provider emits against the shared `NormalizedEvent` zod schema; `packages/contracts` schema parse/reject tests
- [x] fake transcript replay — `tests/e2e/fake-replay.spec.ts`, `FakeReplayProvider` conformance
- [x] caption ring buffer bounds — `caption-store.test.ts` (single-burst) + `caption-store.soak.test.ts` (sustained interleaved load) + `paragraph-grouping.property.test.ts`
- [x] provider switch without transcript loss — `mode-switch.spec.ts`, `scenario-switch.spec.ts`, and the cross-model failover path in `online-keepalive.spec.ts`
- [ ] no-audio-track handling
- [ ] audio source ended handling
- [x] silence warning — `openai-realtime-provider.test.ts` (silence_detected after 30 s)
- [x] online API failure — `online-keepalive.spec.ts` (renewal /session 500 → failover banner) + provider unit tests
- [ ] offline server unavailable
- [ ] model loading failure
- [x] translation failure isolation — `caption-store.test.ts` (translation failure isolation suite)
- [ ] summary failure isolation
- [ ] API key leak check (build artifact scan)
- [x] long-running memory stability — `caption-store.soak.test.ts` (5 000-turn soak + 200-session churn, all bounds held)

---

## Acceptable Evidence (per CLAUDE.md §"Verification Gates")

A task is not complete unless it has:

- passing automated tests, or
- Playwright browser verification, or
- screenshot of UI state, or
- reproducible manual test steps documented in the PR/commit, or
- log excerpt without secrets, or
- fake event replay result, or
- offline engine health check, or
- long-running buffer test result.

"It compiles" / "it ran once" is **not** acceptable.

---

## P0 Test Inventory (target)

- `packages/contracts`: schema parse + reject tests for each event type
- `apps/web/store`: ring-buffer eviction at capacity, partial→revised→final transitions
- `tests/e2e/fake-replay.spec.ts`: open page → click Start Fake Replay → assert at least one `final` caption visible

---

## KEEPALIVE reliability verification (T0–T2)

The dual-model online reliability work (zero-gap renewal, persistent reconnect,
cross-model failover) is covered by three automated tiers so its regressions are
caught in CI, not by hand:

### T0 — mock-backend fault-injection e2e (`tests/e2e/online-keepalive.spec.ts`)

Runs the REAL provider → store → caption-board → failover-UI loop in Chromium
against an in-browser mock backend (`tests/e2e/online-mock.ts`) — no cloud key.
`installOnlineMocks(page)` replaces `RTCPeerConnection`/`RTCDataChannel`,
`WebSocket` (Gemini host only), `getUserMedia`/`getDisplayMedia`, and
`AudioContext`, and routes the `/session*` + OpenAI SDP endpoints; the returned
controller injects faults (emit deltas, `session.closed`, fail `/session` from
the Nth call, drop the Gemini socket) and reads counters (microphone vs display
capture acquisitions, peer count). Cases:

- OpenAI deltas render source + target captions and finalize.
- Online Meeting Caption Box (`audioSource: system`) starts both OpenAI and
  Gemini through `getDisplayMedia`, not `getUserMedia`, and captions still
  render through the provider → store → board path. OpenAI adds only audio
  tracks to its peer connection even though display capture includes a disabled
  video track. This proves the architecture can exercise browser/system audio
  for the YouTube/news-playback field test; it does not claim to automate
  Chrome's real screen-share picker. A dedicated e2e also verifies the explicit
  `● Test` UI control records field-test history only after the operator opts
  in, and that app Stop finishes the run.
- Full Offline idle mode does not prewarm OpenAI or Gemini cloud tokens.
- Paused OpenAI/Gemini backend switching persists the resumed backend so crash
  Continue restarts the correct provider.
- `session.closed` → zero-gap renewal: a 2nd peer is built, the mic is REUSED
  (getUserMedia stays at 1), history preserved, new session still captions.
- Repeated renewals (×5) stay zero-gap — mic acquired once, header status never
  blanks (always shows the live backend), peer count == renewals+1.
- OpenAI renewal failure → `failed` health → failover banner → one click
  continues on Gemini with the transcript preserved.
- If the target online backend is unavailable, failover stays hidden and the
  current self-retrying provider is not stopped.
- Gemini renders captions and auto-reconnects after a server-side drop.
- Gemini Live Translate setup is locked by unit test to the speed-first official
  path: `responseModalities:["AUDIO"]`, `inputAudioTranscription`,
  `outputAudioTranscription`, and `translationConfig` inside
  `generationConfig`. Another regression test covers output-first Gemini
  streaming: `outputTranscription` creates a live transcript anchor before the
  draft translation so LiveCaption does not wait for `inputTranscription`.

> The ~30 s wedge detector and the ~31 s Gemini→`failed` backoff are timing-bound
> and remain covered by the fake-timer unit tests (`*-provider.test.ts`), not e2e.

### T1 — soak + zero-gap renewal

- `apps/web/src/store/caption-store.soak.test.ts` — 5 000-turn interleaved
  partial/final + draft/final stream and 200-session begin/clear churn; asserts
  the render-path invariants hold THROUGHOUT: `segments[]` reference stable
  across partial deltas, ring buffer capped at `maxSegments`, translations never
  orphan-leak, and the render feed (`tailSegments` → `groupParagraphsForSide`)
  bounded by `HISTORY_RENDER_SEGMENTS`. (Structural bounds, not raw heap samples
  — deterministic, not GC-noisy.)
- The repeated-renewal e2e above is the zero-gap "mic acquired once across N
  renewals, no blank window" assertion.

### T2 — provider conformance matrix + property tests

- `apps/web/src/providers/provider-conformance.test.ts` — every event emitted by
  OpenAI / Gemini / offline / fake providers (happy + failure flows) is validated
  against `NormalizedEvent`. Enforces "UI consumes normalized events only".
- `apps/web/src/components/GeminiPricingPanel.test.ts` — locks the Gemini Live
  Translate cost chip to AUDIO-mode input + output audio pricing, not the old
  TEXT-output lower bound.
- `apps/web/src/caption-board/paragraph-grouping.property.test.ts` — seeded-PRNG
  property tests for `tailSegments` (length/suffix-identity/reference-stability)
  and `groupParagraphsForSide` (content preservation, ordering, confidence
  fidelity, bounded paragraph count).

Run: `pnpm -F @meeting-audio/web test` (unit incl. T1/T2) and
`pnpm test:e2e` (T0). All green as of 2026-06-12 (251 web unit, 20 e2e).

---

## Phase 1 closure verification (2026-07-30)

| Requirement                                   | Automated evidence                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Gemini exact model/setup/ack/no fallback      | `gemini-live-provider.test.ts`, online config/route tests                                            |
| Retention default-off and race-safe disable   | `caption-persistence.test.ts`, caption-store/settings tests, retention-aware E2E                     |
| Stop-before-switch and resource release       | `mode-switch.spec.ts`, `scenario-switch.spec.ts`, `online-keepalive.spec.ts` capture/peer counters   |
| MT backpressure outside caption receive loop  | `test_translation_dispatcher.py`, `test_asr_session.py`                                              |
| Loopback-only production launch               | `test_launch_policy.py`, `bash -n services/offline/start.sh`                                         |
| Normalized event boundary and bounded history | provider conformance/property/soak tests                                                             |
| Recorded upstream fixture integrity           | `probe-upstream-contracts.test.ts`, `verify:upstream-contracts` (fails closed when files are absent) |

Release matrix last run on 2026-07-30:

```text
pnpm test              # contracts 19, online 65, web 293
pnpm test:e2e          # Playwright 30
pnpm lint              # 0 errors, 0 warnings
pnpm format:check      # pass
pnpm typecheck         # pass
pnpm build             # pass
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests -q # offline 81
cd services/offline && uv run ruff check . # pass
```

The live-key operation remains separate from CI. Run
`pnpm -F @meeting-audio/online probe:upstream-contracts` only with explicit
credential authorization. Acceptance requires both redacted files under
`tests/fixtures/upstream-contracts/`, a passing
`pnpm -F @meeting-audio/online verify:upstream-contracts`, and a manual check
that no source API key, ephemeral token, session id, or unstable timestamp
remains. The verifier reads both stored artifacts and fails if either file is
missing or violates the exact model/schema contract. As of this entry, the
probe is **not run**, so Phase 1 is not yet accepted.

---

## Open Questions

- The Phase 4 real-session soak target remains 30–60 minutes plus a 1-hour
  bounded-heap run; the former 4-hour default is explicitly deferred.
