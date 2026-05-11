# REFERENCES.md
# Meeting Live Caption & Translation System
# 會議即時字幕、翻譯、摘要系統參考資料

> 目的：提供 Claude Code / Codex 快速查閱的技術參考索引。  
> 本文件只放：架構方向、官方 docs、GitHub 連結、方法資源、可借鏡重點。  
> 不放：完整規格、實作細節、安裝流程、驗收條件。  
> 詳細規格請見：
> - docs/ARCHITECTURE.md
> - docs/ONLINE_OFFLINE_MODES.md
> - docs/AUDIO_SOURCES.md
> - docs/OFFLINE_STT.md
> - docs/OFFLINE_TRANSLATION.md
> - docs/FAILURE_MODES.md

---

## 0. Project Direction

本專案目標是建立一套可在筆電穩定運作的會議即時字幕與翻譯系統。

核心方向：

1. Online Realtime
   - OpenAI Realtime Translation / Whisper
   - Browser audio via WebRTC
   - Backend/native audio via WebSocket when needed

2. Offline Local
   - Local STT
   - Local translation
   - Local audio capture
   - Windows speaker/headphone loopback
   - No cloud dependency in Full Offline mode

3. Interface / Routing
   - Desktop-first
   - Scenario-based audio source selection
   - Online / Hybrid / Offline selectable
   - Fullscreen caption board
   - Semi-realtime summary sidebar

---

# 1. Framework / App Shell References

## 1.1 Electron

URL:
https://electronjs.org/
https://electronjs.org/docs/latest
https://electronjs.org/docs/latest/tutorial/security
https://electronjs.org/docs/latest/tutorial/context-isolation
https://electronjs.org/docs/latest/tutorial/sandbox

Use for:
- Stable desktop packaging
- Fixed Chromium runtime
- Managing Node/Python sidecars
- Long-running meeting app behavior
- Windows-first enterprise laptop deployment

Method:
- Start with local web MVP if needed.
- Package stable app with Electron later.
- Main process manages local services.
- Renderer only handles UI and safe IPC.

---

## 1.2 React + Vite + TypeScript

URLs:
https://react.dev/
https://react.dev/learn/build-a-react-app-from-scratch
https://vite.dev/
https://vite.dev/guide/
https://www.typescriptlang.org/

Use for:
- Caption board UI
- Audio setup wizard
- Online/offline mode selector
- Summary sidebar
- Strong event types

Method:
- Use React for maintainability.
- Use Vite for lightweight renderer build.
- Use TypeScript for provider/event contracts.
- Avoid putting high-frequency transcript deltas directly into top-level React state.

---

## 1.3 Fastify

URLs:
https://fastify.dev/
https://fastify.dev/docs/latest/

Use for:
- Local Node service
- OpenAI session endpoints
- API key isolation
- Online Realtime setup bridge

Method:
- Keep OpenAI API key server-side.
- Expose minimal local endpoints.
- Use Fastify for lightweight Node service.

---

## 1.4 FastAPI

URLs:
https://fastapi.tiangolo.com/
https://fastapi.tiangolo.com/advanced/websockets/

Use for:
- Offline STT / MT service
- WebSocket audio and transcript stream
- Wrapping WhisperLiveKit or custom faster-whisper backend

Method:
- Keep Python ML/audio stack separate from Node.
- Emit normalized TranscriptEvent / TranslationEvent to UI.

---

## 1.5 Playwright

URLs:
https://playwright.dev/
https://playwright.dev/docs/intro
https://playwright.dev/docs/getting-started-mcp

Use for:
- Browser UI verification
- Fullscreen caption board checks
- Error-state checks
- Claude Code visual verification

Method:
- Use Playwright MCP for Claude Code UI checks.
- Add fake transcript replay for deterministic UI tests.

---

# 2. Agentic Coding / SDD References

## 2.1 Claude Code Best Practices

URLs:
https://code.claude.com/docs/en/best-practices
https://code.claude.com/docs/en/sub-agents
https://code.claude.com/docs/en/hooks-guide
https://code.claude.com/docs/en/commands
https://code.claude.com/docs/en/skills

Use for:
- Primary agentic coding workflow
- Explore → plan → implement → verify
- Subagents
- Hooks
- Repeatable commands

Method:
- Claude Code is primary.
- Use subagents for WebRTC, offline STT, audio capture, UI, reliability, security.
- Use hooks for tests, secret checks, and docs reminders.

---

## 2.2 Codex / AGENTS.md

URLs:
https://developers.openai.com/codex/guides/agents-md
https://agents.md/

Use for:
- Backup coding agent
- Repo-level agent instructions
- Setup/test/development rules

Method:
- Maintain AGENTS.md for Codex compatibility.
- Keep CLAUDE.md as project constitution.
- Keep docs/ as detailed specs.

---

# 3. Online Realtime References

## 3.1 OpenAI Realtime Translation

URLs:
https://developers.openai.com/api/docs/guides/realtime-translation
https://developers.openai.com/api/docs/models/gpt-realtime-translate
https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/

Use for:
- Main online live translation path
- Source audio → translated audio
- Source transcript + translated transcript
- Meeting caption / live interpretation use case

Method:
- Use as Online Full mode main engine.
- Do not replace with GPT-Realtime-2.
- Keep transcript/translation events normalized before UI.

---

## 3.2 OpenAI Realtime WebRTC

URLs:
https://developers.openai.com/api/docs/guides/realtime-webrtc

Use for:
- Browser microphone audio
- Browser tab audio
- Browser system audio when supported
- Low-latency browser Realtime connection

Method:
- Browser creates RTCPeerConnection.
- Browser uses short-lived client secret/session token.
- API key stays in local server.
- Data channel events feed caption store.

---

## 3.3 OpenAI Realtime WebSocket / Conversations

URLs:
https://developers.openai.com/api/docs/guides/realtime
https://developers.openai.com/api/docs/guides/realtime-conversations

Use for:
- Backend/native audio source
- Windows loopback audio → backend → OpenAI
- Lower-level realtime audio control

Method:
- Use when audio is captured outside browser.
- Backend handles audio chunks, buffering, reconnect, backpressure.
- Not first-choice path for browser microphone/tab audio.

---

## 3.4 GPT-Realtime-2

URLs:
https://developers.openai.com/api/docs/models/gpt-realtime-2

Use for:
- Optional assistant sidecar
- Tool calling
- Meeting commands
- Transcript Q&A
- Calendar check demo

Method:
- Use only as sidecar.
- Not the main caption/translation engine.

---

## 3.5 OpenAI Realtime Translation Cookbook

URL:
https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide

Use for:
- Browser tab translation pattern
- Listen-along translation reference
- WebRTC translation session example
- Multi-speaker/video-room concept reference

Method:
- Borrow setup ideas.
- Keep this project’s provider abstraction independent.

---

# 4. Browser / Audio Capture References

## 4.1 Microphone Capture

URL:
https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

Use for:
- Physical meeting microphone input

Method:
- Implement MicrophoneProvider.
- Handle permission denied / no device / track ended / silence.

---

## 4.2 Browser Tab / Screen / System Audio

URL:
https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

Use for:
- Browser meeting tab audio
- Screen/window capture audio when supported
- Online meeting caption box mode

Method:
- Implement BrowserTabAudioProvider.
- Detect whether stream has audio track.
- Show clear error if user shares without audio.

---

## 4.3 Browser Audio Support Matrix

URL:
https://caniuse.com/mdn-api_mediadevices_getdisplaymedia_audio_capture_support

Use for:
- Browser/OS support decisions
- Explaining why system audio support differs by OS/browser

Method:
- Do not assume browser system audio always works.
- Use Windows loopback as desktop meeting fallback.

---

## 4.4 Web Audio API

URLs:
https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioSourceNode

Use for:
- Audio level meter
- Silence detection
- Advanced optional mixing

Method:
- Do not mix mic + system audio by default.
- Hybrid mode should prefer separate_tracks.

---

## 4.5 Windows WASAPI Loopback

URLs:
https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/

Use for:
- Capturing speaker/headphone output
- Desktop Teams / Zoom / Meet app audio
- Caption laptop joins online meeting and captures what it hears

Method:
- Implement WindowsLoopbackProvider through native/Python sidecar.
- Warn that unrelated system sounds may be captured.
- Later consider process-specific capture.

---

## 4.6 PyAudioWPatch

URLs:
https://github.com/s0d3s/PyAudioWPatch
https://pypi.org/project/PyAudioWPatch/
https://github.com/s0d3s/PyAudioWPatch/blob/master/examples/pawp_record_wasapi_loopback.py

Use for:
- Python WASAPI loopback implementation
- Windows speaker/headphone audio capture

Method:
- Use in offline engine or audio sidecar.
- Validate device listing, silence, track continuity.

---

# 5. Offline STT References

## 5.1 WhisperLiveKit

URLs:
https://github.com/QUENTINFUXA/WHISPERLIVEKIT
https://pypi.org/project/whisperlivekit/

Use for:
- First offline STT backend candidate
- Real-time STT server
- FastAPI/WebSocket architecture
- Streaming Whisper-like behavior
- Avoiding naive chunked Whisper usage

Method:
- Spike first.
- If stable, wrap as OfflineSTTProvider.
- Keep our UI/event schema independent.
- Do not let it dictate the whole app architecture.

---

## 5.2 faster-whisper

URL:
https://github.com/SYSTRAN/faster-whisper

Use for:
- Offline Whisper inference
- Custom STT fallback
- GPU/CPU local transcription backend

Method:
- Use if WhisperLiveKit is unsuitable.
- Must still add VAD, rolling buffer, and commit policy.
- Do not transcribe tiny chunks independently.

---

## 5.3 Whisper-Streaming

URLs:
https://github.com/ufal/whisper_streaming
https://arxiv.org/abs/2307.14743

Use for:
- Streaming policy theory
- Local agreement
- Self-adaptive latency
- Long speech real-time transcription method

Method:
- Use as reference if building custom faster-whisper streaming backend.
- Important concept: streaming STT requires stabilization policy, not just chunking.

---

## 5.4 whisper.cpp

URL:
https://github.com/ggml-org/whisper.cpp

Use for:
- Lightweight offline STT candidate
- Native/C++ sidecar candidate
- CPU-oriented fallback

Method:
- Consider later for compact native build.
- Still needs streaming policy and integration work.

---

## 5.5 Vosk

URL:
https://alphacephei.com/vosk/

Use for:
- Lightweight offline STT fallback
- Low-resource mode

Method:
- Optional fallback only.
- Not primary for English meeting caption quality.

---

## 5.6 WhisperLive / Whisper Streaming Web

URLs:
https://github.com/collabora/WhisperLive
https://github.com/ScienceIO/whisper_streaming_web

Use for:
- Browser → backend STT streaming reference
- FastAPI/WebSocket audio streaming examples
- Partial/final transcript UI ideas

Method:
- Use as reference only.
- Do not adopt as main backend unless WhisperLiveKit fails.

---

# 6. Offline Translation References

## 6.1 Argos Translate

URLs:
https://github.com/argosopentech/argos-translate
https://www.argosopentech.com/
https://pypi.org/project/argostranslate/

Use for:
- First offline MT provider
- English → Chinese local translation
- Full Offline MVP

Method:
- Translate finalized or semi-final STT segments.
- Add Traditional Chinese / Taiwan wording post-processing.
- Add glossary hook.
- Do not translate every partial STT delta.

---

## 6.2 OPUS-MT

URLs:
https://github.com/Helsinki-NLP/Opus-MT
https://github.com/Helsinki-NLP/OPUS-MT-app
https://github.com/Helsinki-NLP/OPUS-MT-train
https://arxiv.org/pdf/2212.01936

Use for:
- Second offline MT candidate
- Local translation model comparison
- Potentially more license-manageable MT route

Method:
- Benchmark English → Chinese quality.
- Verify exact model license before production use.

---

## 6.3 NLLB-200

URL:
https://huggingface.co/facebook/nllb-200-distilled-600M

Use for:
- Internal PoC
- Quality comparison
- Multilingual MT candidate

Method:
- Do not make default.
- Use only after license review.
- Not assumed production-safe.

---

## 6.4 Bergamot / Local Browser Translation

URLs:
https://blog.mozilla.org/en/mozilla/local-translation-add-on-project-bergamot/
https://browser.mt/

Use for:
- Local browser translation concept
- Future offline translation UI / packaging reference

Method:
- Reference only.
- Not MVP backend.

---

# 7. Product / Architecture Reference Projects

## 7.1 jt-live-whisper

URL:
https://github.com/jasoncheng7115/jt-live-whisper

Use for:
- Local-first voice tool reference
- Windows WASAPI loopback behavior
- macOS BlackHole setup idea
- System audio + microphone scenario
- WebUI/subtitle mode reference
- Offline NLLB / Argos workflow reference

Method:
- Use as product/audio reference.
- Do not fork as main product.
- Do not copy full feature set.
- Exclude China-origin model options.

---

## 7.2 OpenTransLive

URLs:
https://github.com/g0v/OpenTransLive
https://transcribe.g0v.tw/

Use for:
- Broadcast-style event translation reference
- One-to-many audience mode
- QR/mobile/audience views
- WebSocket / Socket.IO fan-out
- Multi-language session output
- YouTube/live event subtitle ideas

Method:
- Reference for future event/broadcast mode.
- Not the core caption engine.
- Not the offline STT engine.
- Be careful with AGPL license before any code reuse.

---

## 7.3 offline-live-translation-overlay

URL:
https://github.com/WenyuGao1/offline-live-translation-overlay

Use for:
- Offline live translation overlay reference
- faster-whisper + NLLB style architecture
- Desktop overlay idea

Method:
- Reference only.
- Check dependencies and NLLB license issues.

---

## 7.4 CleverCloud real_time_translation

URL:
https://github.com/CleverCloud/real_time_translation

Use for:
- whisper.cpp + NLLB + VAD style PoC
- Low-dependency realtime translation idea

Method:
- Reference only.
- Not production base.

---

## 7.5 Khyretos voice-translator

URL:
https://github.com/Khyretos/voice-translator

Use for:
- Offline ASR + translation overlay reference
- Vosk / Argos / OBS-style display concept

Method:
- Reference only.
- Not main backend.

---

# 8. Online / Offline Mode Method Map

## 8.1 Online Full

Method:
Audio → OpenAI Realtime Translation → transcript / translation → caption UI

Reference:
- OpenAI Realtime Translation
- OpenAI Realtime WebRTC
- OpenAI Realtime Translation Cookbook

Use when:
- Network/API is allowed
- Best quality and low latency are desired
- Browser audio is available

---

## 8.2 Hybrid Privacy

Method:
Audio → Local STT → Online text translation / summary → caption UI

Reference:
- WhisperLiveKit
- faster-whisper
- OpenAI text/summary APIs if used later

Use when:
- Raw audio should stay local
- Text can be sent online
- Better translation/summary is needed than offline MT can provide

---

## 8.3 Full Offline

Method:
Audio → Local STT → Local MT → caption UI

Reference:
- WhisperLiveKit
- faster-whisper
- Argos Translate
- OPUS-MT
- Windows WASAPI loopback

Use when:
- Network unavailable
- Sensitive meeting
- Local-only guarantee is required

---

# 9. Audio Scenario Method Map

## 9.1 Physical Meeting

Method:
Microphone → Online or Offline STT/Translation

Reference:
- getUserMedia
- OpenAI WebRTC
- WhisperLiveKit

---

## 9.2 Online Meeting Caption Box

Method A:
Browser tab audio → OpenAI WebRTC

Method B:
Windows loopback → local/offline engine

Method C:
Windows loopback → backend → OpenAI WebSocket

Reference:
- getDisplayMedia
- WASAPI loopback
- PyAudioWPatch
- jt-live-whisper

---

## 9.3 Hybrid Meeting

Method:
Remote audio + local mic → separate_tracks → merge transcript by timestamp

Reference:
- Web Audio API
- OpenAI translation cookbook multi-track thinking
- jt-live-whisper dual-source behavior reference

Rule:
Do not mix by default.

---

## 9.4 Broadcast / Event Mode

Method:
One caption source → server fan-out → many audience views

Reference:
- OpenTransLive
- Socket.IO/WebSocket fan-out
- QR/mobile views
- YouTube subtitle views

Use later:
After local caption box MVP is stable.

---

# 10. Restricted / Excluded References

## Excluded as core model/service

Do not use:
- Qwen
- DeepSeek
- GLM
- FunASR
- SenseVoice
- Baidu
- Tencent
- iFlytek
- Alibaba Cloud
- China-hosted STT / MT / LLM APIs

Reason:
- Supply-chain and governance preference.
- User explicitly prefers avoiding China-origin products/services.

---

## Restricted

NLLB:
- allowed for internal PoC / benchmark
- not default
- requires license review

OpenTransLive:
- architecture reference
- AGPL license caution
- avoid direct code reuse unless license implications are accepted

Cloud wrappers:
- avoid in Full Offline mode
- especially wrappers that silently call external translation APIs

---

# 11. Recommended Reading Order for Agents

## For Architecture Review

1. CLAUDE.md
2. AGENTS.md
3. docs/ARCHITECTURE.md
4. docs/REFERENCES.md
5. docs/ONLINE_OFFLINE_MODES.md
6. docs/AUDIO_SOURCES.md

## For Online Work

1. OpenAI Realtime Translation docs
2. OpenAI Realtime WebRTC docs
3. OpenAI Realtime Conversation/WebSocket docs
4. MDN getUserMedia
5. MDN getDisplayMedia

## For Offline Work

1. WhisperLiveKit
2. faster-whisper
3. Whisper-Streaming paper/repo
4. Argos Translate
5. OPUS-MT
6. Windows WASAPI loopback docs
7. PyAudioWPatch
8. jt-live-whisper

## For Broadcast/Event Expansion

1. OpenTransLive
2. Socket.IO / WebSocket fan-out concepts
3. Redis queue / session routing patterns