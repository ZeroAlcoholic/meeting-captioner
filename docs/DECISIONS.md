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
**Status:** Accepted (deferred)
**Context:** User considered whether to push to GitHub for cross-machine
sync and cloud backup.
**Decision:** **Stay fully local for now.** Re-evaluate when the user
wants to share the repo or sync across machines. Options at that point:
GitHub (private), GitLab, Gitea, self-hosted, or no remote.
**Why:** P0 is a single-machine bootstrap exercise; remote hosting adds
no value yet and forces an unnecessary platform/account decision now.
**How to apply later:** when the user is ready, set up `git remote add
origin <url>` and `git push -u origin main`. No code changes required.

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
