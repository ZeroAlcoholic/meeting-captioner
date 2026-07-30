# Phase 1 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete blueprint phase 1 items 1.1–1.6 with real upstream contract evidence, explicit transcript-retention consent, non-blocking offline translation, safe session configuration, and loopback-only launch behavior.

**Architecture:** Keep provider-specific protocol logic at provider boundaries, extract transcript persistence and offline MT backpressure into focused controllers, and make UI locks explicit through one `sessionActive` input. Every behavior change starts with a failing test and ends with a focused commit before the full release-gate verification.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Playwright, Fastify, Node 22/tsx, Python 3.12, FastAPI, pytest, asyncio.

---

## File map

- Create `tests/fixtures/upstream-contracts/gemini-live-translate.json`: redacted Gemini setup/ack golden frame.
- Create `tests/fixtures/upstream-contracts/openai-realtime-translate.json`: redacted OpenAI client-secret/session golden frame.
- Create `services/online/scripts/probe-upstream-contracts.ts`: live-key dual-provider probe, redaction, schema validation, and atomic fixture writer.
- Create `services/online/scripts/probe-upstream-contracts.test.ts`: redaction and fixture-schema tests.
- Modify `apps/web/src/providers/gemini-live-provider.ts`: setup-complete readiness and strict model invariant.
- Modify `apps/web/src/providers/gemini-live-provider.test.ts`: golden-driven and readiness/failure coverage.
- Modify `tests/e2e/online-mock.ts`: consume golden Gemini ack instead of duplicating it.
- Create `apps/web/src/store/caption-persistence.ts`: dynamic opt-in persistence controller.
- Create `apps/web/src/store/caption-persistence.test.ts`: controller lifecycle and race tests.
- Modify `apps/web/src/store/caption-store.ts`: delegate persistence and expose async retention transition.
- Modify `apps/web/src/store/caption-store.test.ts`: default-off, enable, disable, hydrate, and in-memory invariants.
- Modify `apps/web/src/store/use-caption-store.ts`: bridge the persisted retention preference to the caption store.
- Modify `apps/web/src/settings/settings-store.ts`: persist `transcriptRetentionEnabled`, default false.
- Modify `apps/web/src/settings/settings-store.test.ts`: preference migration and persistence.
- Modify `apps/web/src/components/SettingsPanel.tsx`: local transcript-retention control.
- Modify `apps/web/src/components/ModeSelector.tsx`: accept and apply `sessionActive`.
- Modify `apps/web/src/components/ScenarioPicker.tsx`: accept and apply `sessionActive`.
- Modify `tests/e2e/mode-switch.spec.ts`: running lock, Stop unlock, transcript preservation.
- Modify `tests/e2e/scenario-switch.spec.ts`: running lock, Stop unlock, transcript preservation.
- Modify `tests/e2e/online-keepalive.spec.ts`: backend/direction lock and transport cleanup assertions.
- Create `services/offline/app/pipeline/translation_dispatcher.py`: bounded ordered MT queue with drop-oldest.
- Create `services/offline/tests/test_translation_dispatcher.py`: queue behavior and cleanup tests.
- Modify `services/offline/app/pipeline/asr.py`: own dispatcher lifecycle and remove cap wait from receive loop.
- Modify `services/offline/tests/test_asr_session.py`: disabled MT, degraded health, exception, and no-late-event coverage.
- Create `services/offline/tests/test_launch_policy.py`: static loopback/no-reload gate.
- Modify `services/offline/run_whl.py`, `services/offline/start.bat`, `services/offline/start.sh`: loopback-only production launch.
- Modify `package.json`: remove unsafe `python`/`0.0.0.0` full-dev command.
- Modify `docs/PROJECT_STATE.md`, `docs/TODO.md`, `docs/TEST_PLAN.md`, `docs/RUNBOOK.md`: phase status and reproducible verification.

### Task 1: Record and consume real upstream golden contracts

**Files:**

- Create: `tests/fixtures/upstream-contracts/gemini-live-translate.json`
- Create: `tests/fixtures/upstream-contracts/openai-realtime-translate.json`
- Create: `services/online/scripts/probe-upstream-contracts.ts`
- Create: `services/online/scripts/probe-upstream-contracts.test.ts`
- Modify: `services/online/package.json`
- Modify: `apps/web/src/providers/gemini-live-provider.test.ts`
- Modify: `tests/e2e/online-mock.ts`

- [x] **Step 1: Write failing golden-consumption tests**

Add a fixture import to `gemini-live-provider.test.ts` and compare the provider's
actual setup frame with `geminiGolden.clientFrame`. Change `online-mock.ts` to
acknowledge with `geminiGolden.serverFrame`. The missing generated fixture is
an intentional initial failure.

```ts
import geminiGolden from '../../../../tests/fixtures/upstream-contracts/gemini-live-translate.json';

expect(JSON.parse(setupFrame!)).toEqual(geminiGolden.clientFrame);
```

Add a probe-redaction unit exported from the script:

```ts
expect(
  redactOpenAI({
    value: 'secret',
    expires_at: 123,
    session: { type: 'realtime', model: 'gpt-realtime-translate' },
  }),
).toEqual({
  value: '<ephemeral-token>',
  expires_at: '<unix-seconds>',
  session: { type: 'realtime', model: 'gpt-realtime-translate' },
});
```

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm -F web test -- src/providers/gemini-live-provider.test.ts
pnpm -F online test -- scripts/probe-upstream-contracts.test.ts
```

Expected: FAIL because the fixtures and probe module do not exist.

- [x] **Step 3: Implement the probe and generate, rather than hand-author, fixtures**

The probe sends this Gemini client frame and records its redacted request plus
the real `setupComplete` acknowledgement:

```json
{
  "provider": "gemini",
  "model": "models/gemini-3.5-live-translate-preview",
  "clientFrame": {
    "setup": {
      "model": "models/gemini-3.5-live-translate-preview",
      "contextWindowCompression": { "slidingWindow": {} },
      "sessionResumption": {},
      "inputAudioTranscription": {},
      "outputAudioTranscription": {},
      "generationConfig": {
        "responseModalities": ["AUDIO"],
        "translationConfig": {
          "targetLanguageCode": "zh-Hant",
          "echoTargetLanguage": false
        }
      }
    }
  },
  "serverFrame": { "setupComplete": {} }
}
```

The generated OpenAI fixture stores only redacted response fields:

```json
{
  "provider": "openai",
  "model": "gpt-realtime-translate",
  "response": {
    "value": "<ephemeral-token>",
    "expires_at": "<unix-seconds>",
    "session": {
      "type": "realtime",
      "model": "gpt-realtime-translate"
    }
  }
}
```

Implement the probe with exported pure redactors, JSON shape assertions, a
temporary-file-plus-rename writer, direct OpenAI client-secret request, and a
Gemini auth-token plus WebSocket setup handshake. Reject any output containing
the source token/key strings before writing. Only a successful live response
writes or replaces either checked-in fixture; do not create fixtures from
expected values alone.

```ts
export function assertRedacted(value: unknown, forbidden: string[]): void {
  const json = JSON.stringify(value);
  for (const secret of forbidden.filter(Boolean)) {
    if (json.includes(secret)) throw new Error('redaction failure');
  }
}
```

Add:

```json
"probe:upstream-contracts": "tsx scripts/probe-upstream-contracts.ts"
```

to `services/online/package.json`.

- [x] **Step 4: Verify GREEN and run the live probe when keys are present**

Run:

```powershell
pnpm -F online test -- scripts/probe-upstream-contracts.test.ts
pnpm -F web test -- src/providers/gemini-live-provider.test.ts
pnpm -F online probe:upstream-contracts
```

Expected: redaction tests PASS. The live probe must PASS with both environment
keys and create both fixtures; the fixture-consuming provider test then PASSes.
If either key is absent or rejected, Task 1 remains incomplete and phase 1
cannot be closed.

- [x] **Step 5: Commit**

```powershell
git add tests/fixtures/upstream-contracts services/online/scripts services/online/package.json apps/web/src/providers/gemini-live-provider.test.ts tests/e2e/online-mock.ts
git commit -m "test: record upstream realtime contracts"
```

### Task 2: Make Gemini setup completion and model identity mandatory

**Files:**

- Modify: `apps/web/src/providers/gemini-live-provider.ts`
- Modify: `apps/web/src/providers/gemini-live-provider.test.ts`

- [x] **Step 1: Write failing readiness and rejection tests**

Add four focused tests:

```ts
it('does not start audio capture before setupComplete', async () => {
  wsEmitSetup = false;
  const start = provider.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeAudioWorkletNode.instances).toHaveLength(0);
  FakeWebSocket.instances.at(-1)!.emit({ setupComplete: {} });
  await start;
  expect(FakeAudioWorkletNode.instances).toHaveLength(1);
});
```

Also cover close-before-setup, setup timeout, and a token response carrying
`models/gemini-2.5-flash-native-audio-preview` producing `api_error`, zero
WebSockets, and zero audio-worklet nodes.

- [x] **Step 2: Run the provider test and verify RED**

Run:

```powershell
pnpm -F web test -- src/providers/gemini-live-provider.test.ts
```

Expected: readiness test FAIL because `connect()` resolves in `onopen`;
unsupported-model test FAIL because the fallback setup branch still exists.

- [x] **Step 3: Implement a setup-complete connection promise**

Use one settlement guard in `connect()`:

```ts
let settled = false;
const succeed = () => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  resolve();
};
const fail = (error: Error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  reject(error);
};
```

Parse each frame once. Call `handleServerObject(msg)` for normalized handling
and call `succeed()` only when `msg.setupComplete !== undefined`. Before setup,
`onclose`, `onerror`, and timeout call `fail()`. After setup, `onclose` keeps the
existing reconnect path.

Replace the fallback branch with an invariant:

```ts
const GEMINI_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

function assertTranslateModel(model: string): void {
  if (model !== GEMINI_TRANSLATE_MODEL) {
    throw new Error(`Unsupported Gemini model: ${model}`);
  }
}
```

Delete `systemInstructionFor` and the native-audio setup branch.

- [x] **Step 4: Verify GREEN and related regressions**

Run:

```powershell
pnpm -F web test -- src/providers/gemini-live-provider.test.ts src/providers/token-prewarm.test.ts
pnpm -F web typecheck
```

Expected: all selected tests PASS and typecheck is clean.

- [x] **Step 5: Commit**

```powershell
git add apps/web/src/providers/gemini-live-provider.ts apps/web/src/providers/gemini-live-provider.test.ts
git commit -m "fix(web): require Gemini setup completion"
```

### Task 3: Make transcript persistence explicit opt-in

**Files:**

- Create: `apps/web/src/store/caption-persistence.ts`
- Create: `apps/web/src/store/caption-persistence.test.ts`
- Modify: `apps/web/src/store/caption-store.ts`
- Modify: `apps/web/src/store/caption-store.test.ts`
- Modify: `apps/web/src/store/use-caption-store.ts`
- Modify: `apps/web/src/settings/settings-store.ts`
- Modify: `apps/web/src/settings/settings-store.test.ts`
- Modify: `apps/web/src/components/SettingsPanel.tsx`

- [x] **Step 1: Write failing preference and controller tests**

Add settings tests proving:

```ts
expect(createSettingsStore().getState().transcriptRetentionEnabled).toBe(false);
store.getState().setTranscriptRetentionEnabled(true);
expect(JSON.parse(localStorage.getItem('meeting-audio:settings:v1')!)).toMatchObject({
  transcriptRetentionEnabled: true,
});
```

Add controller/store tests proving:

- default construction does not call localStorage `setItem`, `idbLoad`, or
  `idbSave`;
- legacy v4 transcript data is removed and not hydrated when preference is
  absent/false;
- enabling saves the current full snapshot;
- disabling leaves store segments intact and removes both storage tiers;
- a deferred older `idbSave` cannot recreate data after disable.

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm -F web test -- src/settings/settings-store.test.ts src/store/caption-persistence.test.ts src/store/caption-store.test.ts
```

Expected: FAIL because the preference, controller, and transition API do not
exist and the current caption store persists by default.

- [x] **Step 3: Implement the focused controller**

Define:

```ts
export interface CaptionPersistenceController<T> {
  loadSync(): T | null;
  loadAsync(): Promise<T | null>;
  save(snapshot: T): void;
  flush(snapshot: T): void;
  setEnabled(enabled: boolean, snapshot: T): Promise<T | null>;
  clear(): Promise<void>;
  dispose(): void;
}
```

Use an incrementing generation. Every queued IDB save captures its generation
and rechecks it before committing. `setEnabled(false, snapshot)` increments the
generation, clears timers, removes localStorage keys, serializes `idbClear`
after earlier writes, and leaves the supplied in-memory snapshot untouched.

Move persistence-only constants, snapshot merge/tail helpers, debounce, storage
warning, and lifecycle listeners from `caption-store.ts` into the controller.
Keep caption mutation and ring-buffer logic in `caption-store.ts`.

Expose:

```ts
setTranscriptRetention: (enabled: boolean) => Promise<void>;
```

from `CaptionState`. Bridge the settings singleton in `use-caption-store.ts`:

```ts
void captionStore
  .getState()
  .setTranscriptRetention(settingsStore.getState().transcriptRetentionEnabled);
settingsStore.subscribe((state, previous) => {
  if (state.transcriptRetentionEnabled !== previous.transcriptRetentionEnabled) {
    void captionStore.getState().setTranscriptRetention(state.transcriptRetentionEnabled);
  }
});
```

Add `transcriptRetentionEnabled` and
`setTranscriptRetentionEnabled(boolean)` to persisted settings, defaulting
false. Add a Settings checkbox labeled `本機保存逐字稿` with explicit local-only
and deletion wording.

- [x] **Step 4: Verify GREEN and persistence regressions**

Run:

```powershell
pnpm -F web test -- src/settings/settings-store.test.ts src/store/caption-persistence.test.ts src/store/caption-store.test.ts
pnpm -F web typecheck
```

Expected: tests PASS, with no console warnings and clean typecheck.

- [x] **Step 5: Commit**

```powershell
git add apps/web/src/store apps/web/src/settings apps/web/src/components/SettingsPanel.tsx
git commit -m "feat(web): make transcript retention opt-in"
```

### Task 4: Lock session configuration until Stop completes

**Files:**

- Modify: `apps/web/src/components/ModeSelector.tsx`
- Modify: `apps/web/src/components/ScenarioPicker.tsx`
- Modify: `apps/web/src/components/SettingsPanel.tsx`
- Modify: `tests/e2e/mode-switch.spec.ts`
- Modify: `tests/e2e/scenario-switch.spec.ts`
- Modify: `tests/e2e/online-keepalive.spec.ts`

- [x] **Step 1: Change E2E expectations to the required lock and verify RED**

For Mode and Scenario:

```ts
await page.getByTestId('start-fake-replay').click();
await page.getByTestId('settings-toggle').click();
await expect(page.getByTestId('mode-full_offline')).toBeDisabled();
await page.getByTestId('stop-fake-replay').click();
await page.getByTestId('settings-toggle').click();
await expect(page.getByTestId('mode-full_offline')).toBeEnabled();
await page.getByTestId('mode-full_offline').check();
await expect(page.locator('body')).toContainText('歡迎參加會議。');
```

Mirror for Scenario. In the online mock test, assert backend and language
controls are disabled while the provider owns one capture stream, Stop reduces
active transports to zero, and only then can the setting change.

Run:

```powershell
pnpm test:e2e -- mode-switch.spec.ts scenario-switch.spec.ts online-keepalive.spec.ts
```

Expected: Mode and Scenario lock assertions FAIL because those controls ignore
`sessionActive`.

- [x] **Step 2: Implement one lock input**

Change selectors to:

```ts
export function ModeSelector({ sessionActive = false }: { sessionActive?: boolean }) {
  // ...
  const disabled = sessionActive || !opt.enabled;
}
```

Apply the same shape to `ScenarioPicker`. Set `disabled`, `data-disabled`, and a
`會議進行中 — 請先 Stop` title. Pass `sessionActive ?? false` from
`SettingsPanel`.

- [x] **Step 3: Verify GREEN**

Run:

```powershell
pnpm test:e2e -- mode-switch.spec.ts scenario-switch.spec.ts online-keepalive.spec.ts
pnpm -F web typecheck
```

Expected: all selected E2E tests PASS, settings unlock only after Stop, and
caption history remains visible.

- [x] **Step 4: Commit**

```powershell
git add apps/web/src/components/ModeSelector.tsx apps/web/src/components/ScenarioPicker.tsx apps/web/src/components/SettingsPanel.tsx tests/e2e/mode-switch.spec.ts tests/e2e/scenario-switch.spec.ts tests/e2e/online-keepalive.spec.ts
git commit -m "fix(web): lock session configuration while running"
```

### Task 5: Move offline MT backpressure out of the caption receive loop

**Files:**

- Create: `services/offline/app/pipeline/translation_dispatcher.py`
- Create: `services/offline/tests/test_translation_dispatcher.py`
- Modify: `services/offline/app/pipeline/asr.py`
- Modify: `services/offline/tests/test_asr_session.py`

- [x] **Step 1: Write failing dispatcher tests**

Use the required Python runtime:

```python
@pytest.mark.asyncio
async def test_full_queue_drops_oldest_and_keeps_newest():
    gate = asyncio.Event()
    seen: list[str] = []

    async def worker(seg: dict) -> None:
        await gate.wait()
        seen.append(seg["segment_id"])

    dispatcher = TranslationDispatcher(worker, capacity=2)
    assert dispatcher.enqueue({"segment_id": "a"}) == 0
    assert dispatcher.enqueue({"segment_id": "b"}) == 0
    assert dispatcher.enqueue({"segment_id": "c"}) == 1
    dispatcher.start()
    gate.set()
    await dispatcher.close(drain=True)
    assert seen == ["b", "c"]
```

Add tests for FIFO order, enqueue returning immediately while the worker is
blocked, worker exception callback, cancellation/no late emit, and
`translate_enabled=False` never starting/enqueuing the dispatcher.

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests/test_translation_dispatcher.py services/offline/tests/test_asr_session.py -q
```

Expected: FAIL because `TranslationDispatcher` does not exist and ASR still
waits on `_pending_translates`.

- [x] **Step 3: Implement the dispatcher**

Use one bounded `asyncio.Queue[dict]`:

```python
class TranslationDispatcher:
    def enqueue(self, segment: dict) -> int:
        dropped = 0
        if self._queue.full():
            self._queue.get_nowait()
            self._queue.task_done()
            dropped = 1
        self._queue.put_nowait(segment)
        return dropped
```

`start()` creates exactly one runner task. The runner awaits the worker in FIFO
order and reports exceptions through a synchronous callback. `close(drain)`
either waits for `queue.join()` or cancels, then awaits the runner so no task is
left pending.

In `ASRSession`, create/start the dispatcher only when translation is enabled.
`_recv_loop` calls `enqueue()` and emits translation `degraded` health when it
returns a drop. Delete `_pending_translates`, `_max_pending_translates`, and the
`asyncio.wait(FIRST_COMPLETED)` cap branch. Before emitting a translation result,
check `not self._closed`.

- [x] **Step 4: Verify GREEN and full offline suite**

Run:

```powershell
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests/test_translation_dispatcher.py services/offline/tests/test_asr_session.py -q
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests -q
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m ruff check services/offline
```

Expected: all offline tests PASS and Ruff reports no violations.

- [x] **Step 5: Commit**

```powershell
git add services/offline/app/pipeline/translation_dispatcher.py services/offline/app/pipeline/asr.py services/offline/tests/test_translation_dispatcher.py services/offline/tests/test_asr_session.py
git commit -m "fix(offline): isolate translation backpressure"
```

### Task 6: Enforce loopback-only production launch

**Files:**

- Create: `services/offline/tests/test_launch_policy.py`
- Modify: `services/offline/run_whl.py`
- Modify: `services/offline/start.bat`
- Modify: `services/offline/start.sh`
- Modify: `package.json`
- Modify: `services/offline/README.md`

- [x] **Step 1: Write the failing static policy test**

```python
@pytest.mark.parametrize("relative", ["start.bat", "start.sh"])
def test_production_launcher_is_loopback_only_without_reload(relative: str):
    text = (OFFLINE_ROOT / relative).read_text(encoding="utf-8")
    assert "0.0.0.0" not in text
    assert "--reload" not in text
    assert "127.0.0.1" in text

def test_whl_is_loopback_only():
    text = (OFFLINE_ROOT / "run_whl.py").read_text(encoding="utf-8")
    assert 'host="127.0.0.1"' in text
```

Add a root-package assertion that `dev:full` contains neither bare `python` nor
`0.0.0.0`.

- [x] **Step 2: Run test and verify RED**

Run:

```powershell
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests/test_launch_policy.py -q
```

Expected: FAIL on current `0.0.0.0`, `--reload`, and bare Python command.

- [x] **Step 3: Update production launch paths**

Set:

```python
host="127.0.0.1"
```

in `run_whl.py`. In both launchers run Uvicorn with:

```text
--host 127.0.0.1 --port 8000 --app-dir <offline-root>
```

and no `--reload`. Replace root `dev:full` with a cross-platform `uv run` command so no system
Python is selected:

```json
"dev:full": "concurrently --kill-others --names web,online,whl,offline -c blue,green,magenta,yellow \"pnpm -F web dev\" \"pnpm -F online dev\" \"cd services/offline && uv run python run_whl.py\" \"cd services/offline && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload\""
```

This root command is explicitly development-only, so Uvicorn reload remains
there. Production `start.bat` and `start.sh` contain no reload flag. Keep
`services/offline/README.md`'s development reload command explicitly bound to
`127.0.0.1`.

- [x] **Step 4: Verify GREEN**

Run:

```powershell
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests/test_launch_policy.py -q
pnpm format:check
```

Expected: policy test and formatting PASS.

- [x] **Step 5: Commit**

```powershell
git add services/offline/run_whl.py services/offline/start.bat services/offline/start.sh services/offline/README.md services/offline/tests/test_launch_policy.py package.json
git commit -m "fix(offline): bind production services to loopback"
```

### Task 7: Documentation, release-gate verification, and completion audit

**Files:**

- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/TODO.md`
- Modify: `docs/TEST_PLAN.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/BLUEPRINT_2026-07-29.md`

- [x] **Step 1: Update documentation from verified evidence**

Mark each 1.1–1.6 item with exact tests and commits. Document:

- how to run the upstream probe and what secret redaction guarantees;
- retention default-off and deletion semantics;
- Stop-before-switch behavior;
- translation queue capacity/drop policy and visible degraded state;
- loopback-only production launch;
- any live-key probe that could not be run as an explicit unverified release
  operation, not as completion.

- [x] **Step 2: Run the complete verification matrix**

Run:

```powershell
pnpm test
pnpm test:e2e
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests -q
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m ruff check services/offline
```

Expected: every command exits 0 with no test failure, type error, lint error, or
format drift.

- [x] **Step 3: Perform the adversarial requirement audit**

Run searches that must return no production violation:

```powershell
rg -n "Fallback: native-audio|systemInstructionFor|_pending_translates|_max_pending_translates" apps/web/src/providers/gemini-live-provider.ts services/offline/app/pipeline/asr.py
rg -n "0\.0\.0\.0|--reload" services/offline/run_whl.py services/offline/start.bat services/offline/start.sh
```

Inspect each phase 1 row against its named test evidence. A missing live probe,
fixture consumer, deletion-race test, Stop cleanup assertion, degraded health
assertion, or launcher gate means phase 1 remains incomplete.

- [x] **Step 4: Commit documentation**

```powershell
git add docs/PROJECT_STATE.md docs/TODO.md docs/TEST_PLAN.md docs/RUNBOOK.md docs/BLUEPRINT_2026-07-29.md
git commit -m "docs: close phase 1 with verification evidence"
```

- [x] **Step 5: Final clean-tree verification**

Run:

```powershell
git status --short
git log -8 --oneline
```

Expected: empty status and focused phase 1 commits visible in history.
