# AUDIO_SOURCES.md

> Audio source selection, scenario presets, and policy.
> See [`CLAUDE.md`](../CLAUDE.md) §"Audio Source Selection Is Scenario-Based".

---

## Scenarios (UI presets)

| Scenario | Sources | Policy | UI default |
|----------|---------|--------|------------|
| **Physical Meeting** | microphone | exclusive | mic only |
| **Online Meeting Caption Box** | browser tab audio / browser system audio / Windows loopback | exclusive | tab audio (web) or loopback (desktop) |
| **Hybrid Meeting** | remote meeting audio + local mic | separate_tracks | both, separate streams |
| **Advanced Manual** | user picks | exclusive / separate_tracks / mixed | (none) |

### Why scenarios

Raw multi-select with arbitrary device combinations is a foot-gun: it
encourages users to mix mic + system audio, which causes echo and
duplicated captions. Scenarios push users toward sane defaults.

---

## Source Implementations (provider names)

- `MicrophoneAudioProvider` — `getUserMedia({ audio: true })`
- `BrowserTabAudioProvider` — `getDisplayMedia({ audio: true })`
- `WindowsLoopbackAudioProvider` — Python sidecar via PyAudioWPatch
- `BackendAudioBridgeProvider` — generic WebSocket audio frame producer

---

## Policies

- **exclusive**: only one source active. Other sources are stopped on switch.
- **separate_tracks**: multiple sources active, kept as separate streams,
  transcripts merged in store by timestamp.
- **mixed**: multiple sources mixed in Web Audio. Requires explicit user
  consent and surfaces a warning about echo and timing drift.

Default for any new scenario: **exclusive**, unless the scenario definition
overrides.

---

## Failure Modes (must be visible in UI)

- permission denied
- no device found
- track ended unexpectedly
- silence > N seconds (configurable)
- displayMedia stream has no audio track
- WASAPI device removed / changed

See [`FAILURE_MODES.md`](FAILURE_MODES.md) for the full state list.

---

## Open Questions

- Should "Advanced Manual" be hidden behind a developer flag in early builds?
- What is the silence threshold default (5s? 15s?) and is it scenario-specific?
- Process-specific WASAPI capture (Win 10 2004+) vs full system loopback —
  worth the complexity?
