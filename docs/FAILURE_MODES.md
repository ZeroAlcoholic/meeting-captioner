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

## Call-stage OpenAI key rejection (`ip_not_authorized`, 2026-08-20)

**Symptom:** captions never start; the board shows
`OpenAI SDP exchange failed (401)`. Everything server-side looks healthy —
`/session` returns 200, `/session/info` reports `hasApiKey: true`, and the
startup banner confirms the key is in the system env.

**Measured cause (this network, 2026-08-20):** the two configured keys are not
interchangeable at every endpoint.

The two keys are in DIFFERENT organisations (read off the `openai-organization`
response header): `OPENAI_API_KEY` → `<corporate-org>`,
`OPENAI_API_KEY_AUDIO` → `<personal-org>` (a personal account).

| Request (one office egress IP)                         | `OPENAI_API_KEY` (`sk-svcacct-`, corporate org) | `OPENAI_API_KEY_AUDIO` (`sk-proj-`, personal org) |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------- |
| `GET /v1/models`                                       | 200                                             | 200                                               |
| `POST /v1/responses` (billed inference)                | 200                                             | —                                                 |
| `POST /v1/realtime/translations/client_secrets` (mint) | 200                                             | 200                                               |
| `POST /v1/realtime/client_secrets` (generic mint)      | 200                                             | 200                                               |
| `WSS /v1/realtime/translations` (WebSocket transport)  | **`session.created`, stays open**               | —                                                 |
| `POST /v1/realtime/calls` (generic, real SDP)          | **401 `ip_not_authorized`**                     | 201                                               |
| `POST /v1/realtime/translations/calls` (real SDP)      | **401 `ip_not_authorized`** (5/5, 2 CF edges)   | **201** + full media (UDP/DTLS, RTT 201 ms)       |

**The obvious reading is refuted by that table.** OpenAI's IP allowlist
[applies to _all_ API requests](https://developers.openai.com/api/docs/guides/ip-allowlist)
and rejects with exactly this 401/`ip_not_authorized`. If this egress IP were
missing from the corporate org's allowlist, `/v1/models`, `/v1/responses`, both
mints and the WebSocket handshake would have failed too. They did not. So
either no allowlist is active on that scope, or one is active **and this IP is
already on it** — and the realtime _calls_ endpoint rejects anyway.

An independent report on the OpenAI developer forum (2026-08-19, one day before
this failure) describes the identical signature and pins it down:
[`/v1/realtime/calls` suddenly failing with 401 `ip_not_authorized` despite a
static, verified-allowlisted IP](https://community.openai.com/t/realtime-v1-realtime-calls-suddenly-failing-with-401-ip-not-authorized-despite-static-cloud-run-ip-being-allowlisted/1391236)
— "IP allowlist OFF → the same Realtime WebRTC flow works. IP allowlist ON →
the same flow fails", after two months of stable operation.

**Working conclusion: an upstream enforcement defect on the WebRTC calls
endpoint, not a local misconfiguration.** The rejection lands one hop AFTER our
server, in the browser, where the pre-existing mint-stage failover could never
see it.

Two traps worth remembering when re-diagnosing this:

- A malformed SDP (`v=0`) returns **400 `invalid_offer`** for BOTH keys — the
  parse happens before the authorization check, so a curl smoke test with a
  dummy body reports a false "auth is fine".
- Every server-side check (`/session`, `/session/info`, `/healthz`) stays green
  while captions are dead, because the mint hop is the only one the server
  makes and it succeeds.
- The 401 carries no `x-request-id` / `openai-organization` headers — but so do
  the 400 and the 201 from the same endpoint, so that is a property of the
  realtime service, NOT evidence about who rejected the request.
- The realtime **WebSocket** transport works with the same corporate key from
  the same IP, so neither the key, the org, the model entitlement, nor the
  network is broken — only the WebRTC calls endpoint.

**Handling — transport first, key second:**

1. On a 401/403 at the SDP exchange the browser reopens the SAME session over
   the **WebSocket transport with the SAME key** (`openai-ws-transport.ts`),
   pumping the mic itself as 24 kHz PCM16 instead of an RTP track.
   Measured on the failing network: bring-up 1.96 s including the refused
   WebRTC attempt, correct Traditional-Chinese captions, and the server's key
   slot still `primary` — the meeting stays in the corporate organisation.
2. The refusal is remembered **per key slot** for 30 minutes, so the next start
   skips the doomed WebRTC round trip entirely and re-probes later (measured
   first-caption 2.6 s with no `reconnecting` state at all). A mid-meeting
   re-probe is free: renewal is make-before-break, so the old session keeps
   captioning while the new transport is negotiated.
3. Only if the SAME key is refused on BOTH transports does the browser report
   the slot back to `POST /session` (`rejectedSlot`) so the server demotes it
   and mints from the alternate key — measured recovery 2.1 s.
4. The key demotion is **time-boxed** the same way (30 min,
   `DEMOTION_TTL_MS`): the primary key is always preferred, so a laptop that
   moves back inside an allowed network returns to it without a restart.
5. If only one key is configured and both transports refuse it, the browser
   surfaces the concrete error (status + OpenAI's own code + message + a
   plain-language hint) instead of retrying in a loop.

Full ladder, in the order that preserves the most:
`WebRTC + current key` → `WebSocket + current key` → `WebRTC + alternate key`
(reusing the already-built peer) → `WebSocket + alternate key`.

**Remediation, in order of evidence (all outside this repo):**

1. Ask an owner of the `<corporate-org>` org to open
   **Settings > Security > IP allowlist** and report whether one is active. If
   it is, the community report says disabling it restores `/v1/realtime/calls`
   even when the IP is correctly listed — that is the confirming experiment.
   (Adding the IP is NOT expected to help; the evidence above says it is either
   already listed or irrelevant.)
2. Open a support case with OpenAI quoting the endpoint, the org, and the fact
   that `WSS /v1/realtime/translations` succeeds from the same IP with the same
   key while `POST /v1/realtime/calls` returns `ip_not_authorized`.
3. **Already shipped:** the WebSocket transport above. The app no longer
   depends on either of the first two landing — it keeps running on the
   corporate key over WebSocket, and returns to WebRTC by itself once the
   upstream endpoint accepts that key again.

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
