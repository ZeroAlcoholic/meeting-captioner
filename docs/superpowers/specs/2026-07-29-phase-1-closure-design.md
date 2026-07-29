# Phase 1 Closure Design

## Purpose

Complete every item in `docs/BLUEPRINT_2026-07-29.md` phase 1 (1.1–1.6)
without weakening the stated acceptance criteria:

- Gemini uses the current dedicated translate model and a real upstream
  contract.
- Transcript persistence is explicit opt-in and disabled by default.
- Session configuration cannot be changed while capture is active.
- Offline translation backpressure never blocks the caption receive path.
- Offline services are loopback-only by default and production launchers do not
  use development reload behavior.

The caption path remains the highest-priority path. Translation, storage, model
loading, and cleanup failures must not delay or erase source captions.

## Scope and non-goals

This design implements phase 1 only. It does not implement phase 2 latency
measurement or tuning, phase 3 Gemini drain/session fencing, Electron
packaging, summary generation, or multi-track hybrid capture.

Targeted extraction is allowed where it creates an enforceable boundary for
phase 1. A general provider-registry rewrite or broad caption-store rewrite is
out of scope.

## 1. Upstream contract source of truth

Add a live-key probe that can exercise both online providers and write
redacted JSON fixtures under `tests/fixtures/upstream-contracts/`.

The probe must:

- use server-side environment keys only;
- never print or write keys, ephemeral tokens, authorization headers, raw
  URLs containing credentials, or user speech;
- send deterministic synthetic setup/session requests;
- store only protocol shapes needed by tests, with unstable values replaced by
  typed placeholders;
- validate the redacted frame before replacing a checked-in fixture;
- exit non-zero when either upstream rejects the expected contract.

Checked-in fixtures are the single contract source for provider unit tests and
browser mocks. Hand-authored copies of upstream setup/ack frames are removed.
Running the probe is a release/manual gate because CI does not hold live keys;
fixture schema and fixture consumption remain fully automated in CI.

## 2. Gemini connection and model invariants

`GeminiLiveProvider.connect()` resolves only after receiving
`setupComplete`. A raw WebSocket `open` means transport availability, not a
usable session.

Connection behavior:

1. Open WebSocket.
2. Send the setup frame.
3. Wait for `setupComplete`.
4. Resolve and only then start audio capture.
5. Reject on timeout, socket error, or socket close before setup completion.
6. Ignore late events from stale sockets.

The online service allowlist remains the server-side authority. The browser
also rejects any minted-token response whose model is not the dedicated
translate model. The native-audio fallback setup branch and prompt helpers are
deleted; there is one supported Gemini capability, not two silently different
ones.

Reconnect uses the same readiness rule. Attempt counters reset only after
`setupComplete`.

## 3. Explicit transcript retention

Transcript retention semantics:

- default: disabled;
- disabled means no transcript payload in localStorage or IndexedDB;
- settings may persist the boolean preference, because it contains no meeting
  content;
- an upgraded installation with no explicit retention preference is treated as
  disabled: legacy transcript payloads are deleted without hydration rather
  than silently preserving the old opt-out behavior;
- enabling retention during a meeting immediately persists the full current
  in-memory transcript;
- disabling retention cancels pending writes, removes all transcript records
  from localStorage and IndexedDB, and leaves current in-memory captions
  untouched;
- a write that was already queued before disable cannot recreate deleted data;
- reload/Continue is offered only when retention was enabled and a stored
  session exists.

Extract a focused persistence controller from `caption-store.ts`. It owns
hydration, debounced writes, synchronous tail flush, IndexedDB serialization,
enable/disable transitions, and deletion ordering. The caption store owns
caption state and delegates persistence lifecycle to this controller.

The Settings UI exposes a clearly worded retention toggle. It must not imply
cloud storage. Turning it off explains that the on-screen transcript remains
until Clear/reload but the disk copy is removed.

## 4. Active-session configuration lock

While any provider is running:

- Mode is disabled.
- Scenario is disabled.
- Online backend is disabled.
- Translation direction is disabled.

The existing bilingual/source visibility toggle and acoustic-profile behavior
retain their documented semantics where they already implement a safe
provider-specific restart.

`SettingsPanel` passes one `sessionActive` value to all locked controls.
Disabled controls include an operator-facing “Stop first” reason. Programmatic
failover and crash-continue continue through explicit App actions; they do not
simulate user clicks on locked controls.

Tests prove:

- every locked control is disabled during each provider type;
- controls unlock after Stop;
- clicking/dispatching change events while disabled does not change settings;
- Stop closes the active capture transport before another configuration starts;
- transcript history remains visible.

## 5. Offline translation dispatcher

Replace the set of fire-and-forget translation tasks with one bounded FIFO
queue and one dispatcher task per `ASRSession`.

Rules:

- `_recv_loop` only normalizes/emits transcript events and performs
  non-blocking translation enqueue operations;
- one dispatcher consumes the queue in order, matching the existing
  single-threaded CTranslate2 execution model;
- when full, enqueue drops the oldest untranslated segment and accepts the
  newest segment;
- every drop increments a counter and emits a translation `degraded`
  `HealthEvent` with an explicit backlog/drop message;
- Hybrid mode (`translate_enabled=False`) does not create or enqueue local MT
  work;
- close cancels the dispatcher and prevents late translation events from
  leaking after the session has ended;
- translation exceptions are logged and surfaced as degraded translation
  health without stopping transcript flow.

Queue capacity is a named constant with deterministic tests. There is no
semaphore/set hybrid and no wait-for-capacity call in `_recv_loop`.

## 6. Loopback-only offline launch

All production-style offline launch paths bind both WhisperLiveKit and FastAPI
to `127.0.0.1` by default. `start.bat` and `start.sh` do not pass `--reload`.

Development documentation may retain an explicit `uvicorn --reload` command,
but it must also bind loopback. LAN exposure is not offered implicitly. A
future authenticated LAN mode requires a separate decision.

Launcher tests/static checks assert:

- no production launcher contains `0.0.0.0`;
- no production launcher contains `--reload`;
- `run_whl.py` binds `127.0.0.1`;
- documented production commands match the real launchers.

All Python verification uses
`C:\Programs\miniforge3\envs\deve\python.exe`.

## Error and degradation behavior

- Gemini setup failure emits transport `api_error`/`failed`, releases acquired
  resources, and never begins audio streaming.
- Persistence failure warns visibly once but never blocks captions.
- Persistence disable wins over every older queued write.
- Configuration remains locked until provider Stop cleanup has run.
- MT overload preserves source captions, prefers recent untranslated segments,
  and visibly reports degradation.
- Offline bind changes fail closed to local access only.

## Verification and completion evidence

Phase 1 is complete only when all of the following are true:

1. The live probe exists, redacts safely, validates fixtures, and checked-in
   fixtures drive unit/mocked contract tests.
2. Gemini provider tests prove setup-completion readiness, pre-setup failure,
   timeout, stale socket handling, and unsupported-model rejection.
3. Retention tests prove default-off zero writes, opt-in hydration/save,
   enable-now save, disable-now delete, and queued-write race safety.
4. Component/E2E tests prove all session configuration locks and Stop cleanup.
5. Python tests prove receive-loop non-blocking behavior, ordering,
   drop-oldest, degraded health, disabled-translation behavior, and cleanup.
6. Static launcher tests prove loopback-only/no-reload behavior.
7. Full unit suites, Python tests, Playwright E2E, lint, typecheck, and builds
   pass.
8. `PROJECT_STATE.md`, `TODO.md`, `TEST_PLAN.md`, and `RUNBOOK.md` describe the
   implemented behavior and any live-key verification that remains a release
   operation rather than pretending it ran.

No item is considered complete from code inspection or compilation alone.
