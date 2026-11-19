# OFFLINE_STT.md

> Local Speech-to-Text strategy.
> See [`REFERENCE.md`](../REFERENCE.md) §5 for upstream links.

---

## Backend Selection

**Current implementation, not usability acceptance (2026-10-22):**
`run_whl.py` starts WhisperLive (`whisper_live.server`) with the
`faster_whisper` backend and default `distil-large-v3`; it is not WhisperLiveKit.
The user reports unusable speed/quality. The deve runtime lacks `whisper-live`
and `pyaudiowpatch`; the launcher can select another project environment, which
was not executed in this investigation. No current full audio-path acceptance
is established. See [diagnosis and replacement criteria](evals/2026-10-22-offline-calibration.md).

**Original architecture candidate:** [WhisperLiveKit](https://github.com/QUENTINFUXA/WHISPERLIVEKIT).
**Underlying current ASR library:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
**Reference architecture:** [whisper_streaming](https://github.com/ufal/whisper_streaming) (paper: arXiv 2307.14743) — local agreement & self-adaptive latency.

Decision criteria for any retained or replacement backend:

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

- Implemented default: `distil-large-v3`, an English ASR model; do not infer
  Chinese or code-switching support from the multilingual Whisper family name.
  See the [official model's intended use](https://huggingface.co/distil-whisper/distil-large-v3#intended-use).
- Other launcher mappings are configuration options, not accepted capabilities.
  Model changes still require real audio, hardware, quality and latency evidence.
- Model files live under `models/` (gitignored). Bootstrap will _not_
  download them automatically — manual step in RUNBOOK.

---

## Open Questions

- Actual selected runtime/model readiness and Windows device support have not
  been accepted end to end; verify the launcher's environment, not just deve.
- Is `int8` quantization on faster-whisper enough for real-time on a
  modest CPU?
- Do we need per-language model selection at runtime, or is it fixed
  at session start?
