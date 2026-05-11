# CLAUDE.md

## Project Identity

This project builds a meeting-grade live caption, translation, and semi-realtime summary system.

The system must support both:

1. Online Realtime Mode
   - OpenAI Realtime Translation / Whisper
   - browser audio via WebRTC
   - backend/native audio via WebSocket when needed

2. Offline Local Mode
   - local STT
   - local translation
   - local audio capture
   - no cloud dependency for core offline STT/MT

The product target is a stable laptop-based caption system for real meetings, not a demo chatbot.

---

## Core Product Goal

Build a system that can:

- show large, projector-readable live captions
- translate English speech into Traditional Chinese subtitles
- support physical meetings and online meetings
- switch between Online, Hybrid, and Full Offline processing
- support microphone, browser tab audio, system audio, and Windows speaker/headphone loopback
- generate semi-realtime summaries without blocking captions
- run reliably through long meetings without crashing or blanking the screen

---

## Primary Architecture Decision

Use three separated layers:

1. Interface and Routing Layer
   - meeting scenario selection
   - audio source selection
   - Online / Hybrid / Offline mode selection
   - fullscreen caption board
   - summary sidebar
   - health/error states

2. Online Realtime Layer
   - OpenAI Realtime Translation as the main online caption/translation path
   - OpenAI Realtime Whisper where source transcription is needed
   - GPT-Realtime-2 only as an optional assistant/tool sidecar

3. Offline Local Layer
   - WhisperLiveKit spike as the first offline STT backend candidate
   - faster-whisper fallback if WhisperLiveKit cannot be wrapped cleanly
   - jt-live-whisper as audio/product reference, not as the main codebase
   - Argos Translate first for offline English-to-Chinese translation
   - OPUS-MT as optional later candidate
   - NLLB only after license review

---

## Preferred Stable Stack

Use this unless there is a documented decision to change:

Desktop / Deployment:
- Electron for stable packaged desktop distribution
- Local web app is acceptable during MVP development

Renderer:
- Vite
- React
- TypeScript
- plain CSS or CSS Modules
- no large UI framework unless explicitly justified

Online service:
- Node.js 20+
- Fastify
- server-side OpenAI session endpoints
- no OpenAI API key in browser code

Offline service:
- Python 3.11+
- WhisperLiveKit first
- custom FastAPI + faster-whisper only if needed
- Windows WASAPI loopback support
- Argos Translate for offline MVP translation

Testing:
- Playwright for real browser verification
- Vitest for frontend logic
- pytest for offline engine
- fake transcript replay tests
- long-running stability tests

---

## Non-Negotiable Rules

### Caption Path Is Sacred

The live caption path is hard realtime.

Never allow these to block caption rendering:

- summary generation
- action item extraction
- translation refinement
- glossary correction
- export
- persistence
- model download
- model loading
- UI animation

If any soft-realtime component fails, captions must continue.

---

### Summary Is Soft Realtime

Summary must consume finalized transcript segments only.

Do not feed raw partial transcript deltas into the summary pipeline.

Summary states must be explicit:

- draft
- refined
- stable

Summary failure must never stop captions, translation, audio capture, or provider switching.

---

### Online and Offline Are Both First-Class

Do not implement Online as real and Offline as fake.

Do not implement Offline as a placeholder unless clearly marked as unavailable in the UI.

Required modes:

- Online Full:
  audio → OpenAI Realtime → transcript / translation

- Hybrid Privacy:
  audio → local STT → online translation / summary

- Full Offline:
  audio → local STT → local translation → local or no summary

Mode switching must preserve existing transcript history unless the user explicitly clears it.

---

### Do Not Use GPT-Realtime-2 as the Main Caption Engine

GPT-Realtime-2 may be used only as an optional sidecar for:

- meeting commands
- tool calling
- check_calendar(date, time)
- transcript Q&A
- manual summary commands

The main online caption/translation path must use Realtime Translation / Whisper patterns.

---

### Audio Source Selection Is Scenario-Based

Do not expose raw free-form multi-select as the default UX.

Use scenario presets:

1. Physical Meeting
   - microphone only
   - exclusive source policy

2. Online Meeting Caption Box
   - browser tab audio, browser system audio, or Windows loopback
   - microphone off by default
   - exclusive source policy

3. Hybrid Meeting
   - remote meeting audio plus local microphone
   - separate_tracks policy
   - do not mix by default

4. Advanced Manual
   - manual source selection
   - allow exclusive, separate_tracks, or mixed
   - mixed mode must warn about echo, duplicated captions, and timing drift

---

### Do Not Naively Chunk Whisper Audio

Offline STT must not do this:

audio chunk → transcribe independently → render

Offline STT must use:

audio stream → VAD → rolling buffer → streaming policy → partial/revised/final segment

WhisperLiveKit should be evaluated first because it already addresses streaming STT behavior. Build custom faster-whisper streaming only if required.

---

### Offline Translation Must Be Honest

Offline English-to-Chinese translation quality may be weaker than online models.

The UI and docs must not claim online-equivalent quality.

Offline translation should:

- translate finalized or semi-final segments
- avoid translating every partial delta
- support Traditional Chinese post-processing
- support glossary hooks
- fail gracefully by keeping source transcript visible

---

### No China-Origin Core Models or China Cloud APIs

Do not use these as core STT, MT, LLM, or cloud services:

- Qwen
- DeepSeek
- GLM
- FunASR
- SenseVoice
- Baidu
- Tencent
- iFlytek
- Alibaba Cloud
- China-hosted STT/MT/LLM APIs

If a reference project includes these, exclude or replace them.

---

### Security and Privacy

OpenAI API keys must remain server-side only.

Never:

- expose API keys in browser code
- print secrets in logs
- commit `.env`
- send offline-mode audio/text to any cloud service
- enable analytics or third-party trackers by default
- silently store meeting transcripts persistently

Default retention:
- in-memory only

Allowed retention:
- explicit user export
- later local-only autosave after user opt-in

---

## Provider Abstraction Requirement

The UI must consume normalized events only.

Do not bind UI directly to OpenAI, WhisperLiveKit, faster-whisper, Argos, or any specific backend event shape.

Use stable internal event contracts:

- TranscriptEvent
- TranslationEvent
- HealthEvent
- AudioLevelEvent

Every provider must adapt into these contracts.

---

## Required Transcript Event Semantics

Every transcript event must include:

- provider
- mode
- source
- segmentId
- status
- text
- startMs
- optional endMs
- optional confidence
- optional revisionOf

Allowed transcript statuses:

- partial
- revised
- final

---

## Required Translation Event Semantics

Every translation event must include:

- provider
- mode
- sourceSegmentId
- status
- sourceText
- targetText
- sourceLanguage
- targetLanguage
- updatedAt

Allowed translation statuses:

- draft
- refined
- final

---

## UI Principles

The product is a caption board, not a chat app.

The main screen must prioritize:

1. translated caption
2. source transcript
3. summary sidebar
4. recent caption history
5. health/status controls

UI rules:

- translated caption must be largest
- source transcript must be secondary
- summary sidebar must be optional/collapsible
- controls must not dominate the meeting view
- error states must be visible
- no silent failures
- no chat bubbles
- no decorative animation that can affect performance

---

## Reliability Requirements

Every feature must define failure behavior.

Required visible states:

- idle
- requesting permission
- connecting
- connected
- reconnecting
- degraded
- failed
- stopped
- no audio track
- silence detected
- model loading
- offline engine unavailable
- API error

Required degradation rules:

- translated audio fails → keep translated text
- translation fails → keep source transcript
- summary fails → keep captions
- online fails → allow offline or retry
- offline fails → allow online or retry
- audio source ends → keep transcript and show restart
- provider switch → do not clear transcript unless requested

---

## Claude Code Operating Rules

Before modifying code:

1. Read this file.
2. Read `AGENTS.md` if present.
3. Read relevant docs in `docs/`.
4. Identify which layer is affected:
   - interface/routing
   - online realtime
   - offline local
   - audio capture
   - summary
   - reliability
   - security
5. Explore first.
6. Plan before editing.
7. Implement the smallest robust vertical slice.
8. Verify with tests or reproducible manual checks.
9. Update project state docs.

---

## Use Subagents for Specialized Work

Use subagents when exploration, logs, or many files would pollute the main context.

Recommended subagent responsibilities:

- realtime-webrtc-agent:
  OpenAI Realtime, WebRTC, WebSocket, SDP/session setup

- offline-stt-agent:
  WhisperLiveKit, faster-whisper, VAD, streaming policy

- audio-capture-agent:
  microphone, browser tab audio, browser system audio, Windows WASAPI loopback

- caption-ux-agent:
  fullscreen caption board, accessibility, typography, projector readability

- summary-agent:
  draft/refined/stable summary pipeline

- reliability-agent:
  reconnect, silence detection, long-running tests, bounded memory

- security-review-agent:
  API key handling, offline guarantee, transcript retention, dependency risks

Subagents may investigate and report. Main implementation must still preserve the architecture rules in this file.

---

## Verification Gates

A task is not complete unless it has evidence.

Acceptable evidence:

- passing automated tests
- Playwright browser verification
- screenshot of UI state
- reproducible manual test steps
- log excerpt without secrets
- fake event replay result
- offline engine health check
- long-running buffer test result

Do not claim a feature works only because code was written.

---

## Required Test Categories

Maintain or add tests for:

- event schema normalization
- fake transcript replay
- caption ring buffer bounds
- provider switch without transcript loss
- no-audio-track handling
- audio source ended handling
- silence warning
- online API failure
- offline server unavailable
- model loading failure
- translation failure isolation
- summary failure isolation
- API key leak check
- long-running memory stability

---

## Documentation Discipline

Update docs when behavior or architecture changes.

Important docs:

- `docs/PROJECT_STATE.md`
- `docs/TODO.md`
- `docs/DECISIONS.md`
- `docs/ARCHITECTURE.md`
- `docs/AUDIO_SOURCES.md`
- `docs/ONLINE_OFFLINE_MODES.md`
- `docs/OFFLINE_STT.md`
- `docs/OFFLINE_TRANSLATION.md`
- `docs/FAILURE_MODES.md`
- `docs/TEST_PLAN.md`
- `docs/RUNBOOK.md`

Do not bury architectural decisions only in code comments.

---

## Recommended Implementation Order

Default order:

1. event schemas
2. caption store with bounded buffers
3. fullscreen caption board UI
4. scenario-based audio setup UI
5. Online Realtime microphone path
6. Online Realtime browser tab audio path
7. WhisperLiveKit spike
8. OfflineSTTProvider adapter
9. Windows WASAPI loopback
10. Argos offline translation
11. summary draft/refined/stable pipeline
12. reliability and long-session tests
13. Electron packaging

Do not jump to packaging before the local web MVP is stable.

---

## Reference Project Positioning

WhisperLiveKit:
- use as first offline STT backend candidate
- use as streaming STT architecture reference
- wrap behind our provider abstraction
- do not let it dictate the UI

jt-live-whisper:
- use as product/audio-source reference
- use for Windows WASAPI loopback behavior reference
- use for local-first subtitle workflow reference
- do not copy full feature surface
- exclude China-origin model options

OpenTransLive:
- use as broadcast/session/audience-view reference
- useful later for QR/mobile/multi-view event mode
- not the core caption engine
- not the MVP desktop/local architecture base

---

## Dependency Rules

Prefer small, stable dependencies.

Avoid:

- large UI component libraries
- unnecessary animation libraries
- unclear native binaries
- unpinned model downloads
- cloud translation wrappers in offline mode
- dependencies that silently call external services
- broad-permission MCP/plugin tools without clear need

Any new dependency must justify:

- why it is needed
- whether it affects offline guarantee
- whether it affects packaging
- whether it affects security
- whether there is a smaller alternative

---

## Done Definition

A feature is done only when:

- it works in the app
- it has visible success and failure states
- it emits normalized events if relevant
- it does not violate Online/Offline separation
- it does not block the caption path
- it has tests or reproducible verification
- it updates relevant docs
- it does not expose secrets
- it does not fake unsupported capability

---

## Reporting Format

After each meaningful task, report:

1. What changed
2. Files changed
3. How to run
4. How verified
5. Known limitations
6. Risks introduced
7. Next recommended task

Keep reports factual and concise.