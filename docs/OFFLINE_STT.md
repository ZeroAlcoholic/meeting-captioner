# OFFLINE_STT.md

> Local Speech-to-Text strategy.
> See [`REFERENCE.md`](../REFERENCE.md) §5 for upstream links.

---

## Backend Selection

**Primary candidate:** [WhisperLiveKit](https://github.com/QUENTINFUXA/WHISPERLIVEKIT)
**Fallback:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) wrapped with our own VAD + streaming policy.
**Reference architecture:** [whisper_streaming](https://github.com/ufal/whisper_streaming) (paper: arXiv 2307.14743) — local agreement & self-adaptive latency.

Decision criteria (to be evaluated during P3 spike):

1. Does the backend already produce stable streaming `partial → revised → final`
   transitions, or do we have to build them?
2. Resource footprint on a typical meeting laptop (CPU and RAM during a
   60-minute session).
3. License compatibility with packaging (Electron + sidecar).
4. Maintainer responsiveness and release cadence.

---

## Hard Rules (from CLAUDE.md)

Forbidden pattern (do **not** implement):
```
audio chunk → transcribe independently → render
```

Required pattern:
```
audio stream → VAD → rolling buffer → streaming policy → partial / revised / final
```

---

## Provider Adapter Surface

Whatever backend ships, it must expose itself to the UI as an
`OfflineSTTProvider` emitting the normalized `TranscriptEvent` contract
(see [`ARCHITECTURE.md`](ARCHITECTURE.md) §4).

Required methods (sketch):
- `start(audioSource)`
- `stop()`
- `health(): HealthEvent`
- emits `TranscriptEvent` stream

---

## Models

- Initial benchmark target: Whisper **small** (~500 MB) for English.
- Stretch: medium / large-v3 if laptop hardware allows.
- Model files live under `models/` (gitignored). Bootstrap will *not*
  download them automatically — manual step in RUNBOOK.

---

## Open Questions

- WhisperLiveKit GPU requirement on Windows — does it gracefully fall
  back to CPU?
- Is `int8` quantization on faster-whisper enough for real-time on a
  modest CPU?
- Do we need per-language model selection at runtime, or is it fixed
  at session start?
