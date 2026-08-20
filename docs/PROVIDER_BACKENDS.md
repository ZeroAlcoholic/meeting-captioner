# Online Realtime Backends (OpenAI / Azure / Gemini)

> Multi-backend design for the `online_full` realtime caption/translation path.
> Status: **OpenAI = shipped**, **Gemini (by key) = implemented 2026-06-09
> (live-verify pending creds)**, **Azure = designed, not yet built**.
> All three are Online-tier only; Hybrid and Offline paths are untouched.

---

## Goal

Let the operator pick which cloud provider brokers the realtime translation
session, behind the project's normalized event contracts
(`TranscriptEvent` / `TranslationEvent` / `HealthEvent` / `AudioLevelEvent`).
UI selector lives in Settings → "Online backend". Default: OpenAI.

---

## Provider comparison (verified June 2026)

|                    | OpenAI (shipped)                           | Azure OpenAI (designed)                     | Gemini (by key, built)                          |
| ------------------ | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| Realtime translate | `gpt-realtime-translate`                   | same model (deployment)                     | `gemini-3.1-flash-live-preview`                 |
| Protocol           | WebRTC (SDP)                               | WebRTC (SDP, same shape)                    | **WebSocket**                                   |
| Token broker       | `/v1/realtime/translations/client_secrets` | `…/openai/v1/realtime/client_secrets`       | `auth_tokens` → our `/session/gemini`           |
| Browser connect    | `…/translations/calls` (Bearer ephemeral)  | `…/openai/v1/realtime/calls`                | `…BidiGenerateContentConstrained?access_token=` |
| Model id           | model name                                 | **deployment name** (`session.model`)       | model id (`models/…`)                           |
| Translation        | dedicated translate model                  | dedicated translate model                   | **system instruction**                          |
| Source partials    | yes (whisper)                              | `.completed` only (partials unconfirmed)    | 2.5 yes / **3.1 end-of-utterance**              |
| Session cap        | long + renewal                             | ~30 min → rolling reconnect                 | 15 min → compression + resumption + GoAway      |
| Auth (server)      | `OPENAI_API_KEY`                           | api-key / Entra (`Cognitive Services User`) | `GEMINI_API_KEY`                                |

### Traditional Chinese (繁體中文) — carefully checked

- **OpenAI / Azure** `gpt-realtime-translate`: output language list exposes only
  **"Mandarin"** (no Simplified/Traditional script switch); effectively
  **Simplified** → the project converts with **OpenCC** (`to_traditional`).
- **Gemini**: full LLM → a system instruction ("輸出繁體中文，台灣用語") yields
  **Traditional natively**, and can localize Taiwan vocabulary. Most flexible.
- **Cross-provider safety net**: keep OpenCC post-processing on all backends.

### Azure region (gpt-realtime-translate / -whisper, Global Standard, 2026-06-03)

Canada Central · Central US · **East US 2** · France Central · Sweden Central ·
South India. (Earlier "only CA/FR/IN" was an outdated snapshot — East US 2 IS
supported.)

---

## Environment variables (all server-side; secrets never reach the browser)

```
MEETING_ONLINE_PROVIDER = openai | azure | gemini    # optional server hint; UI selector is source of truth
# OpenAI (existing)
OPENAI_API_KEY
# Gemini (by key) — BUILT
GEMINI_API_KEY
GEMINI_LIVE_MODEL = gemini-3.1-flash-live-preview     # latest; override if newer ships
# Azure (designed)
AZURE_OPENAI_API_KEY | (Entra)         AZURE_OPENAI_ENDPOINT=https://<res>.openai.azure.com
AZURE_OPENAI_REALTIME_TRANSLATE_DEPLOYMENT             AZURE_OPENAI_REALTIME_WHISPER_DEPLOYMENT
# Gemini Vertex (future, enterprise data residency) — needs backend WS relay
GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_APPLICATION_CREDENTIALS
```

UI availability: `/session/info` returns `availableProviders` (derived from
which keys exist); the Settings selector greys out unconfigured backends.

---

## Implemented: Gemini Live (by key)

- Server `POST /session/gemini` mints an ephemeral token (uses:1, ~30 min TTL,
  model-locked) from `GEMINI_API_KEY`; returns `{ token, model }` only.
- `GeminiLiveProvider` (WebSocket) reuses the AudioWorklet PCM capture (16 kHz)
  used by the offline path; converts Float32→PCM16→base64, sends `realtimeInput`.
- Setup: `responseModalities:["AUDIO"]` + `inputAudioTranscription` +
  `outputAudioTranscription` + `contextWindowCompression{slidingWindow}` +
  `sessionResumption`; `goAway` triggers a resuming reconnect.
- One segment per turn (wall-clock `startMs` → correct ordering + Pause/Resume).
- See `PROJECT_STATE.md` "Multi-backend (P-A/P-C)" for the file list + tests.

### Live-verify checklist — DONE 2026-06-09 (real GEMINI_API_KEY)

1. ✅ `auth_tokens`: body `{uses,expireTime,newSessionExpireTime}` → `{name}`; `?key=` auth.
   Fixed a bug — `liveConnectConstraints` rejected; model-lock via
   `bidiGenerateContentSetup` made the WS close `1011`, so mint **unconstrained**.
2. ✅ WS setup fields all accepted (`setupComplete`). Audio frame =
   `realtimeInput.audio{data,mimeType}` (`mediaChunks` deprecated → `1007`).
   `sessionResumptionUpdate.newHandle` delivered.
3. ⏳ `inputTranscription` partial cadence on 3.1 — needs real speech (in-app mic).
   Fall back to `gemini-2.5-flash-native-audio` if source captions feel laggy.
4. ⏳ Traditional-Chinese output quality — verify in-app; add OpenCC if needed.

---

## Not yet built: Azure

WebRTC family → reuse ~90% of `OpenAIRealtimeProvider` parameterized by
`{clientSecretUrl, callsUrl, model=deployment, authMode}`. Lowest-effort second
backend. Differences: URL paths (no `/translations/`), `session.model` =
deployment name, Entra/api-key for the token call, ~30-min rolling reconnect.

## OpenAI transports: WebRTC and WebSocket

The OpenAI online backend has two interchangeable transports for the same
realtime translation session. They emit the same events, so everything above
the transport (segmentation, health ladder, renewal, wedge detection, the
`TranscriptEvent` / `TranslationEvent` contracts) is shared.

|               | WebRTC (`/v1/realtime/**/calls`)               | WebSocket (`wss://…/v1/realtime/translations`)                                              |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Audio uplink  | RTP track; browser never touches samples       | shared AudioWorklet, resampled to 24 kHz PCM16 → base64 `session.input_audio_buffer.append` |
| Loss handling | jitter buffer, concealment, congestion control | TCP retransmit (head-of-line delay under loss)                                              |
| Auth          | ephemeral token in the SDP POST                | ephemeral token in the WebSocket subprotocol                                                |
| Default       | yes                                            | fallback, chosen automatically                                                              |

Selection is automatic: WebRTC first, WebSocket when WebRTC refuses the key
(see `DECISIONS.md` D13 and `FAILURE_MODES.md`). There is no user-facing
switch — the caption board shows one online OpenAI backend either way.
