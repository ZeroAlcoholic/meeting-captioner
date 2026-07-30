# FAILURE_MODES.md

> Required visible states and degradation rules.
> See [`CLAUDE.md`](../CLAUDE.md) §"Reliability Requirements".

---

## Required Visible States (per component)

For each component (audio, STT, translation, summary, transport), the
UI must be able to render at least these states:

- `idle`
- `requesting_permission`
- `connecting`
- `connected`
- `reconnecting`
- `degraded`
- `failed`
- `stopped`
- `no_audio_track`
- `silence_detected`
- `model_loading`
- `offline_engine_unavailable`
- `api_error`

These map to the `HealthEvent.state` enum in `packages/contracts`.

---

## Degradation Rules (must hold at all times)

| Trigger                | Required behavior                            |
| ---------------------- | -------------------------------------------- |
| Translated audio fails | Keep translated text                         |
| Translation fails      | Keep source transcript                       |
| Summary fails          | Keep captions                                |
| Online fails           | Allow offline or retry                       |
| Offline fails          | Allow online or retry                        |
| Audio source ends      | Keep transcript, show restart UI             |
| Provider switch        | Do not clear transcript unless user requests |

The caption path **never** waits on summary, model load, persistence, or
animation. See [`CLAUDE.md`](../CLAUDE.md) §"Caption Path Is Sacred".

---

## Online Self-Heal & Failover Ladder (Project KEEPALIVE, 2026-06-12)

Both online backends now follow the same three-tier "never go dark" model:

1. **Intra-model self-heal** (automatic, invisible):
   - _OpenAI:_ ICE-restart backoff → full session rebuild on ICE/connection
     `failed` or `session.closed`; a **stale-data detector** (DC silent > 30 s
     while audio is active) forces a rebuild; the scheduled 25-min renewal is
     **make-before-break** (new peer built over the same mic stream, then
     swapped) so it costs **zero caption gap** and never re-acquires the mic.
   - _Gemini:_ WS `onclose` AND a **receive-side wedge detector** (no
     serverContent > 30 s while audio active) trigger a session-resuming
     reconnect; reconnect retries **forever** with a capped backoff.
2. **Surface `failed` while still retrying** — after the fast retries are
   exhausted, transport health flips to `failed` (auto-retry continues in the
   background). This is the signal, not a dead end.
3. **Cross-model failover** (one click) — on `transport: failed` the
   `FailoverBanner` offers a switch to the OTHER backend; it preserves the
   transcript (no `beginSession`) and continues the same meeting.

Degradation guarantee: a backend failure never blanks the board — the last
captions stay visible, the system auto-retries, and the operator can hand off to
the other model without losing history.

---

## Test Coverage

These failure modes must each have at least one automated or
reproducible-manual test in [`TEST_PLAN.md`](TEST_PLAN.md):

1. Microphone permission denied
2. `getDisplayMedia` returns stream with no audio track
3. Mic device removed mid-session
4. Silence > threshold
5. Online API key invalid
6. Online API returns 5xx repeatedly
7. Offline service not running
8. Offline model file missing
9. Translation provider crashes
10. Summary provider times out
11. Provider switched mid-meeting (transcript preserved)
12. Long-running session (memory bounded)

---

## Open Questions

- Default thresholds (silence seconds, reconnect attempts, backoff curve).
- Should `degraded` be one state or have sub-types (slow, partial,
  high-error-rate)?
