# 01 架構決策：Offline 即時會議翻譯

## 1. 現況判斷

目前架構已完成基本 browser mic → FastAPI → WhisperLiveKit → caption store 流程，但不適合直接擴成正式 offline 即時會議翻譯產品。

主要原因：

```text
1. 只能穩定處理 browser microphone，尚未支援 system audio loopback。
2. WhisperLiveKit 被 FastAPI lifespan 啟動成 daemon thread，生命週期與錯誤隔離不清楚。
3. ASR 預設 small.en，不適合作為正式會議/商務/保險術語場景。
4. 翻譯 pipeline 目前停用，ctranslate2 與模型未就緒。
5. Postprocess 尚未真正生效。
6. 沒有 AudioLevelEvent，使用者無法判斷是否真的收到聲音。
7. 缺 benchmark gate，無法定位慢與不準的來源。
```

## 2. 核心決策

```text
採用「桌面音訊擷取 + 可替換 ASR + 可替換 MT + 穩定字幕事件流」架構。

不採用：
- Browser-only audio capture 作為最終方案。
- FastAPI 內部啟動 WhisperLiveKit daemon thread。
- 每個 partial segment 都翻譯。
- OPUS-MT 作為最終品質主線。
- NLLB / SeamlessM4T 作為正式商用預設主線。
```

## 3. 三種候選架構

### Architecture A：Pragmatic Desktop Offline v2（主推）

```text
Desktop Shell / Local Web UI
  ├─ Mic：現場會議
  └─ System Audio：Teams / Zoom / Google Meet / Browser / Software
        ↓
Audio Capture Layer
  ├─ Windows P0: PyAudioWPatch WASAPI loopback
  └─ Cross-platform P1: Electron/Tauri shell + audio loopback strategy
        ↓
ASR Service
  ├─ WhisperLiveKit independent process
  ├─ large-v3-turbo / distil-large-v3
  └─ optional diarization
        ↓
Segment Stabilizer
  ├─ partial: English UI only
  └─ final: translation trigger
        ↓
Translation Service
  ├─ Quality: TranslateGemma 4B / 12B
  └─ Fallback: OPUS-MT en→zh + CTranslate2
        ↓
TW Postprocess
  ├─ OpenCC s2twp
  ├─ glossary
  └─ placeholder restore
        ↓
Caption UI / Export / Metrics
```

適用：近期落地、Windows 筆電、公司內部 demo 到正式 PoC。

代價：需要做桌面音訊擷取、模型管理與 benchmark。

選擇條件：需要同時支援現場會議與視訊會議音訊。

---

### Architecture B：OpenAI-Compatible Local Services（維運型）

```text
Desktop App
  ↓
Local Gateway
  ├─ Session management
  ├─ Audio routing
  ├─ Health checks
  └─ Metrics
        ↓
OpenAI-Compatible STT Service
  ├─ Speaches / faster-whisper
  └─ optional WhisperLiveKit adapter
        ↓
Translation Service
  ├─ TranslateGemma local service
  └─ CTranslate2 fallback
        ↓
Caption Event Bus
        ↓
Caption UI
```

適用：長期產品化、API 邊界清楚、多模型服務化。

代價：比 Architecture A 多一層 Gateway，streaming UX 需要自己補完整。

選擇條件：希望所有模型都能被標準 API 替換，並可用 Docker Compose 或服務管理方式維運。

---

### Architecture C：Voxtral Realtime Experimental Branch（研究線）

```text
Desktop Audio Capture
  ↓
ASRAdapter interface
  ├─ WhisperLiveKitAdapter
  ├─ VoxtralRealtimeAdapter
  └─ SpeachesAdapter
        ↓
Unified ASR Event
        ↓
Segment Stabilizer
        ↓
TranslateGemma / OPUS fallback
        ↓
Caption UI
```

適用：測試下一代 speech-native / realtime ASR。

代價：新技術成熟度、文件、部署經驗都需驗證。

選擇條件：另開 branch，不阻礙主線交付。

## 4. 最終建議

```text
Primary：Architecture A
Secondary：Architecture B
Experimental：Architecture C
```

落地順序：

```text
1. 先用 Architecture A 修掉音訊來源、ASR 模型、服務邊界、翻譯策略。
2. 把 Translation Service 與 ASRAdapter 設計成可被 Architecture B 接管。
3. Voxtral branch 只做 benchmark，不影響主線。
```
