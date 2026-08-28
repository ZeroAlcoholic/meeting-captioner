# DECISIONS.md

> Architectural decisions, with the _why_. Decisions are append-only;
> if a decision is reversed, add a new entry that supersedes the old one
> rather than editing history.

Format: lightweight ADR (Architecture Decision Record).

---

## D1 — Use pnpm workspaces for the JS/TS monorepo

**Date:** P0
**Status:** Accepted
**Context:** We have at least three JS packages (web, online service, shared
contracts). Need to share TS types across them without publishing to npm.
**Decision:** Use **pnpm workspaces**.
**Why:** Faster installs, strict node_modules layout (no phantom deps),
disk savings via content-addressable store. CLAUDE.md / REFERENCE.md do
not constrain workspace tool choice.
**Consequences:** Devs need `pnpm` installed (bootstrap script handles it).

---

## D2 — Styling via plain CSS / CSS Modules only

**Date:** P0
**Status:** Accepted
**Context:** Renderer must be lightweight and not depend on heavy UI
frameworks (per `CLAUDE.md` §"Preferred Stable Stack").
**Decision:** Plain CSS or CSS Modules. No Tailwind, no styled-components,
no MUI/Chakra/Mantine.
**Why:** Direct control over typography (caption board needs large,
projector-readable text), no runtime style cost.

---

## D3 — Validate event payloads with zod

**Date:** P0
**Status:** Accepted
**Context:** Provider Abstraction (CLAUDE.md) requires UI to consume
_normalized_ events. We need both compile-time TS types and runtime
validation at provider boundaries.
**Decision:** Use **zod** in `packages/contracts` to define schemas, then
infer TS types from the schemas.
**Why:** Single source of truth for shape + validation; fake replay can
also validate its own JSON input against the same schemas.

---

## D4 — Caption state in a vanilla store, not React top-level state

**Date:** P0
**Status:** Accepted
**Context:** Partial transcript deltas can fire 10+/sec. Putting them in
React top-level state would re-render the whole tree.
**Decision:** Use **Zustand vanilla store**. React subscribes to selectors;
provider modules write to the store directly.
**Why:** Decouples high-frequency writes from React render lifecycle. See
REFERENCE.md §1.2 method note.

---

## D5 — Fake transcript format

**Date:** P0
**Status:** Accepted
**Context:** Need a reproducible source of caption-path test data.
**Decision:** JSON array of `{ tMs, kind: 'transcript' | 'translation',
segmentId, status: 'partial' | 'revised' | 'final', text, ... }`.
**Why:** Hand-writable, diffable in PRs, can be regenerated from real
sessions later.

---

## D6 — Python environment via uv

**Date:** P0
**Status:** Accepted
**Context:** Offline service and future ML stack need a reproducible Python
env. CLAUDE.md / REFERENCE.md do not pin a tool.
**Decision:** Use **uv** with `pyproject.toml`. Ship `requirements.txt`
later if needed for fallback installers.
**Why:** Order-of-magnitude faster than pip, deterministic resolver,
manages Python interpreter version itself.

---

## D7 — Lint/format toolchain

**Date:** P0
**Status:** Accepted
**Decision:** TS — ESLint + Prettier. Python — Ruff (lint + format).
**Why:** Industry default; both ship pre-tuned configs.

---

## D8 — Conventional Commits for git history

**Date:** P0
**Status:** Accepted
**Decision:** Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`, `test:`).
**Why:** Easy to scan, can drive auto-changelog later, well known.

---

## D9 — No Docker for dev/runtime

**Date:** P0
**Status:** Accepted
**Context:** Considered Docker Compose for "easy install on any machine".
**Decision:** Bootstrap scripts (`scripts/setup.*`) instead. No Docker.
**Why:** WASAPI loopback (P3) is essentially impossible inside Windows
containers; Docker Desktop also adds >2 GB and slows dev iteration. The
bootstrap script gets us to "5–10 min on a fresh machine" without it.

---

## D10 — Remote git hosting deferred

**Date:** P0
**Status:** Superseded (2026-08-28) — see "Superseded" below
**Context:** User considered whether to push to GitHub for cross-machine
sync and cloud backup.
**Decision:** **Stay fully local for now.** Re-evaluate when the user
wants to share the repo or sync across machines. Options at that point:
GitHub (private), GitLab, Gitea, self-hosted, or no remote.
**Why:** P0 is a single-machine bootstrap exercise; remote hosting adds
no value yet and forces an unnecessary platform/account decision now.
**How to apply later:** when the user is ready, set up `git remote add
origin <url>` and `git push -u origin main`. No code changes required.

**Superseded (2026-08-28):** the deferral no longer describes reality. The repo
has an `origin` on GitHub (private) and phase-1 closure was merged to `main`
through PR #1, so the platform decision this entry was postponing has already
been made. Recorded here rather than deleted: the entry explains why the project
spent P0–P1 with no remote, which is context the git history alone does not
carry. Nothing here blocks CI or any other remote-side tooling.

---

## D11 — Phase 1 privacy and caption-path defaults

**Date:** 2026-07-30
**Status:** Accepted
**Context:** Session switching, transcript persistence, slow offline MT, and
wildcard service binds could preserve audio/data longer than intended or block
caption reception.
**Decision:** Transcript retention is explicit opt-in and defaults off; active
session configuration is immutable until Stop; offline MT uses one bounded FIFO
queue with drop-oldest rather than waiting in the transcript receive loop; local
production launchers bind WHL/FastAPI to `127.0.0.1` and do not use reload.
**Why:** These defaults mechanically preserve privacy, resource ownership, and
the non-blocking caption-path invariant. Any future relaxation requires an
explicit product decision plus tests; it must not appear as a silent fallback.

---

## D12 — OpenAI key preference and call-stage failover

**Date:** 2026-08-20
**Status:** Accepted
**Context:** `OPENAI_API_KEY` (corporate `sk-svcacct-`, org
`<corporate-org>`) mints ephemeral tokens successfully, serves
normal inference, and even opens a realtime session over the **WebSocket**
transport from this network — but `POST /v1/realtime/**/calls` rejects its
ephemeral tokens with `401 ip_not_authorized` (deterministic, 5/5). The same
SDP with `OPENAI_API_KEY_AUDIO` (`sk-proj-`, a **personal** org) returns 201.
Evidence says this is an upstream enforcement defect on the WebRTC calls
endpoint rather than a missing allowlist entry — see `FAILURE_MODES.md`. Either
way the server cannot observe it: from its side the mint succeeded.
**Decision:** The primary key is **always tried first**. When the browser's SDP
exchange is rejected with 401/403 it reports the minting slot back to
`POST /session` as `rejectedSlot`; the server demotes that slot for
`DEMOTION_TTL_MS` (30 min) and mints from the alternate, and the browser retries
the exchange once on the same half-built peer. Slot NAMES only ever cross the
wire — never key material.
**Why:** Preference order preserves the intended key (billing, org policy) for
every network where it works, while the time-box means a network change
recovers it without a restart or manual edit. Retrying on the existing peer
keeps the added latency to one mint + one POST (measured 2.1 s worst case) and
keeps the make-before-break renewal path gap-free.
**Alternatives rejected:** permanently sticky switching (silently strands the
laptop on the fallback key after one bad network); swapping the env vars by
hand (invisible to anyone else, and wrong on the networks where the corporate
key works); probing the call endpoint at startup (costs a session mint on every
launch and still cannot predict a mid-meeting policy change).

**Governance note (open):** the alternate key belongs to a personal OpenAI
account (org `<personal-org>`), so while the failover is active, corporate meeting
audio and transcripts are processed under a personal account — outside company
billing, retention and data-processing terms. This is acceptable as a
short-lived workaround for an upstream defect, NOT as a steady state. Closing
it means restoring the corporate key on the WebRTC path, or adding the
WebSocket transport that the corporate key is measured to accept.

---

## D13 — Two transports for the OpenAI realtime session

**Date:** 2026-08-20
**Status:** Accepted
**Context:** OpenAI serves the same realtime translation session over WebRTC
(`POST /v1/realtime/**/calls`) and WebSocket
(`wss://api.openai.com/v1/realtime/translations`). The corporate key is
currently refused on the first and accepted on the second (D12). The event
contract is IDENTICAL on both — `session.created`,
`session.input_transcript.delta`, `session.output_transcript.delta`,
`session.closed`, `error` — verified by running a full translation session over
each.
**Decision:** Keep WebRTC as the default transport and add a WebSocket
transport (`apps/web/src/providers/openai-ws-transport.ts`) that the provider
falls back to **before** it falls back to another key. The refusal is cached per
key slot for 30 minutes so repeat starts skip the doomed attempt. Audio for the
WebSocket path reuses the shared AudioWorklet already feeding Gemini and the
offline engine, resampled in the transport to the 24 kHz PCM16 mono the append
event specifies.
**Why:** WebRTC still owns jitter buffering, loss concealment and congestion
control, which a TCP WebSocket cannot match on a lossy link, so it stays first.
But when the choice is "WebSocket in the corporate org" versus "WebRTC in a
personal account", the organisation matters more than the transport: the
alternate key moves meeting audio outside company billing, retention and
data-processing terms. Transport-before-key encodes that priority.
**On the sample rate:** a 16 kHz feed was observed transcribing correctly, but
the append event is documented as 24 kHz PCM16 mono with the rate NOT
configurable (`session.audio.input.format` is rejected as an unknown parameter
on a translation session) and unsupported formats are documented to return a
validation error. Building on undocumented tolerance would also have left a
real hole: when a browser refuses an explicit rate the shared engine falls back
to the hardware default, usually 48 kHz, which a 24 kHz decoder would render as
double-speed garbage. The transport therefore converts from whatever rate the
context reports, carrying interpolation state across chunks so the 32 ms seams
do not click.
**Trade-offs accepted:** on the WebSocket path the browser paces and sends the
PCM itself, so a congested uplink shows up as head-of-line delay rather than
graceful loss concealment; the existing backpressure guard drops frames and
forces a rebuild instead of growing the send buffer without bound. OpenAI also
keeps sending spoken-translation audio deltas that we discard — no documented
way to disable them for a translation session was found (four candidate
`session.update` shapes rejected), which is the same waste the WebRTC path
already pays.
**Alternatives rejected:** a second provider class (would fork the
segmentation, health and renewal logic that both transports share); making
WebSocket the default (gives up WebRTC's media handling on every network,
including the ones where it works); waiting for the upstream fix (leaves the
product broken for an unknown period).
