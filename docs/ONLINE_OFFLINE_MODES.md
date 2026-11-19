# ONLINE_OFFLINE_MODES.md

> Mode selection: Online Full, Hybrid Privacy, Full Offline.
> See [`CLAUDE.md`](../CLAUDE.md) §"Online and Offline Are Both First-Class".

2026-11-03 現行邊界：雲端版本只包含雲端 adapter 與共用平台，地端／Hybrid 透過 TypeScript／Vite 能力入口隔離；完整版本才載入地端實作。舊地端會議在雲端版本保留歷史與匯出、停用續用，不會靜默切成雲端。詳見 [ARCHITECTURE](ARCHITECTURE.md#雲端地端模組邊界2026-11-03)。Full Offline 的速度／品質、模型離線準備與啟動資格仍未驗收，見 [現況診斷](evals/2026-10-22-offline-calibration.md)。

---

## Modes

### Online Full

```
audio → OpenAI / Gemini realtime adapter → transcript + translation → UI
```

- Quality and latency require real-service evaluation
- Requires network and configured provider access
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
audio → local STT (services/offline) → local MT (OPUS-MT / CTranslate2) → UI
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

| Component     | Online Full    | Hybrid Privacy | Full Offline   |
| ------------- | -------------- | -------------- | -------------- |
| Audio capture | browser/native | browser/native | browser/native |
| STT           | OpenAI / Gemini | local          | local          |
| Translation   | OpenAI / Gemini | online (text)  | local (OPUS-MT) |
| Summary       | OpenAI (later) | online (text)  | local or off   |

---

## Open Questions

- Default mode on first launch? Likely **Online Full** for polish, but
  show a one-time consent dialog explaining what leaves the machine.
- Should Hybrid Privacy degrade to Full Offline automatically when the
  online translation fails repeatedly?
