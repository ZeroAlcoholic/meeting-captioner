# ONLINE_OFFLINE_MODES.md

> Mode selection: Online Full, Hybrid Privacy, Full Offline.
> See [`CLAUDE.md`](../CLAUDE.md) §"Online and Offline Are Both First-Class".

---

## Modes

### Online Full

```
audio → OpenAI Realtime Translation → transcript + translation → UI
```

- Best quality, lowest latency
- Requires network and OpenAI API access
- API key stays in `services/online`

### Hybrid Privacy

```
audio → local STT (services/offline) → text → online translation/summary → UI
```

- Raw audio never leaves the machine
- Text-only egress
- Useful when audio is sensitive but text is not

### Full Offline

```
audio → local STT (services/offline) → local MT (Argos) → UI
```

- No network calls in the caption/translation path
- Lower translation quality than online (UI must not claim parity)
- Required for sensitive meetings

---

## Mode Switching Rules

- Switching modes **must not clear** transcript history unless the user
  explicitly clears it.
- Switching is allowed mid-meeting; in-flight segments may be marked as
  `final` in the previous mode and the new mode picks up from the next
  segment.
- If the target mode is unavailable (e.g., offline engine not running),
  the UI must show a clear error and keep the current mode active.

---

## Component Responsibilities by Mode

| Component | Online Full | Hybrid Privacy | Full Offline |
|-----------|-------------|----------------|--------------|
| Audio capture | browser/native | browser/native | browser/native |
| STT | OpenAI | local | local |
| Translation | OpenAI | online (text) | local (Argos) |
| Summary | OpenAI (later) | online (text) | local or off |

---

## Open Questions

- Default mode on first launch? Likely **Online Full** for polish, but
  show a one-time consent dialog explaining what leaves the machine.
- Should Hybrid Privacy degrade to Full Offline automatically when the
  online translation fails repeatedly?
