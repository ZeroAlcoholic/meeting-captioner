# TEST_PLAN.md

> Test categories and what counts as evidence.
> See [`CLAUDE.md`](../CLAUDE.md) §"Verification Gates" and §"Required Test Categories".

---

## Test Levels

| Level | Tool | Where | What it covers |
|-------|------|-------|----------------|
| Unit | Vitest | `packages/contracts`, `apps/web` | event schema, store reducers, pure logic |
| Component | Vitest + Testing Library | `apps/web` | React components in isolation |
| Service unit | Vitest | `services/online` | route handlers, validators |
| Service unit (Py) | pytest | `services/offline` | adapters, VAD, streaming policy |
| Integration | scripts in `tests/integration/` | spawn services, hit endpoints | service ↔ contract correctness |
| E2E | Playwright | `tests/e2e/` | full UI flows, fake replay |
| Stability | custom harness | `tests/stability/` | long-running memory + reconnect |

---

## Required Test Categories (from CLAUDE.md)

- [ ] event schema normalization
- [ ] fake transcript replay
- [ ] caption ring buffer bounds
- [ ] provider switch without transcript loss
- [ ] no-audio-track handling
- [ ] audio source ended handling
- [ ] silence warning
- [ ] online API failure
- [ ] offline server unavailable
- [ ] model loading failure
- [ ] translation failure isolation
- [ ] summary failure isolation
- [ ] API key leak check (build artifact scan)
- [ ] long-running memory stability

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

## Open Questions

- Long-running stability test: 60 min vs 4 hr default?
- Where do we host model/API regression fixtures? (Probably
  `tests/fixtures/`, gitignored if large.)
