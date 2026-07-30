# 04 Claude Code / Codex 指揮 Prompt

````text
你是資深 realtime audio / ASR / local inference / desktop app 架構師。請重構現有 offline 即時會議翻譯系統。目標是讓筆電可以在完全 offline 狀態下聽現場會議或視訊會議音訊，產生英文即時字幕與台灣繁中穩定翻譯字幕。

# 背景

目前系統大致為：

Browser AudioWorklet
  → FastAPI /ws
  → FastAPI lifespan spawn WhisperLiveKit daemon thread
  → ASRSession relay to WhisperLiveKit
  → SegmentStabilizer
  → optional Translation pipeline
  → CaptionBoard

目前問題：

1. 只能處理 browser microphone，尚未支援 system audio loopback。
2. WhisperLiveKit 被 FastAPI daemon thread 包住，服務邊界錯誤。
3. ASR 預設 small.en，不適合正式會議與商務術語。
4. Translation pipeline 目前 is_available=False，ctranslate2 與模型未就緒。
5. Postprocess 未真正生效。
6. 沒有 AudioLevelEvent。
7. 缺 benchmark 與可驗收報告。
8. partial / final 策略不足，中文可能跳動、重複或延遲不可控。

# 重構目標

建立四層架構：

Desktop / Local UI
  → Audio Capture Service
  → ASR Service
  → Translation Service
  → Caption UI / Transcript / Metrics

# 強制原則

1. 不得再由 FastAPI lifespan spawn WhisperLiveKit daemon thread。
2. WhisperLiveKit 必須改為獨立 service/process。
3. 建立 ASRAdapter interface，至少支援 WhisperLiveKitAdapter，預留 SpeachesAdapter 與 VoxtralRealtimeAdapter stub。
4. 建立 TranslationAdapter interface，至少支援：
   - CTranslate2OpusMTWorker as fast fallback
   - TranslateGemmaWorker as quality path 或可插拔 stub
5. partial ASR 只顯示英文，不送翻譯。
6. final/stable ASR segment 才送翻譯。
7. 支援 fallback first / quality late replacement。
8. 支援 OpenCC s2twp、glossary TSV、proper noun placeholder masking / restore。
9. 實作 Windows system audio loopback prototype：優先 PyAudioWPatch。
10. 實作 AudioLevelEvent，UI 必須顯示 mic/system audio 是否有聲音。
11. 所有模型與 runtime 狀態必須反映在 /healthz。
12. 不得接雲端 API；所有功能必須可 offline 執行。
13. 不得預設啟用中國來源模型或服務。
14. 不得把 NLLB / SeamlessM4T 設為正式商用預設主線；可留 benchmark-only adapter。
15. 不得宣稱支援但沒有可重跑測試指令與報告。

# 需要產出的模組

services/audio-router/
  - capture_mic.py
  - capture_windows_wasapi.py
  - frame_normalizer.py
  - level_meter.py
  - schemas.py

services/asr/
  - adapters/base.py
  - adapters/whisperlivekit_adapter.py
  - adapters/speaches_adapter.py stub
  - adapters/voxtral_adapter.py stub
  - server.py
  - schemas.py

services/translation/
  - adapters/base.py
  - adapters/ctranslate2_opus_worker.py
  - adapters/translategemma_worker.py or stub with clear health state
  - postprocess/opencc_tw.py
  - postprocess/glossary.py
  - postprocess/placeholder.py
  - postprocess/repetition_guard.py
  - server.py
  - schemas.py

services/session-api/
  - caption_stream.py
  - transcript_export.py
  - metrics.py
  - health.py

apps/web or apps/desktop/
  - DeviceSelector
  - AudioLevelMeter
  - CaptionBoard
  - MetricsPanel

# Event schema

ASR event:

{
  "type": "asr.segment",
  "session_id": "session-001",
  "segment_id": "seg-000123",
  "source": "system",
  "speaker": "speaker_1",
  "start_ms": 12400,
  "end_ms": 16800,
  "text": "The policyholder needs to complete the health declaration before underwriting.",
  "status": "final",
  "stability": 0.98,
  "engine": "whisperlivekit.large-v3-turbo",
  "latency_ms": {
    "audio_capture": 12,
    "asr": 640,
    "segment_stabilizer": 8
  }
}

Translation event:

{
  "type": "translation.segment",
  "session_id": "session-001",
  "segment_id": "seg-000123",
  "source_text": "The policyholder needs to complete the health declaration before underwriting.",
  "target_text": "要保人在核保前需要完成健康告知。",
  "source_lang": "en",
  "target_lang": "zh-Hant-TW",
  "status": "final",
  "engine": "translategemma-4b-it",
  "fallback_used": false,
  "revision": 1,
  "latency_ms": {
    "queue": 20,
    "translation": 820,
    "postprocess": 7,
    "total_after_asr": 847
  }
}

Audio level event:

{
  "type": "audio.level",
  "session_id": "session-001",
  "source": "system",
  "rms_db": -28.4,
  "peak_db": -12.2,
  "clipping": false,
  "muted": false,
  "timestamp_ms": 123456
}

# Benchmark 要求

建立可重跑 benchmark：

1. ASR benchmark：
   - WER
   - CER
   - RTF
   - first_partial_latency_p50/p95
   - final_segment_latency_p50/p95
   - segment_revision_count
   - hallucination_count
   - GPU memory
   - CPU usage

2. Translation benchmark：
   - chrF
   - optional COMET
   - human scoring scaffold
   - terminology accuracy
   - fallback latency p50/p95
   - quality latency p50/p95
   - late replacement count

3. End-to-end benchmark：
   - audio capture latency
   - ASR latency
   - MT latency
   - UI render latency
   - subtitle stability

# 測試音檔目錄

建立：

audio/
  clean_meeting_5m.wav
  noisy_meeting_5m.wav
  teams_system_audio_5m.wav
  google_meet_browser_audio_5m.wav
  insurance_terms_5m.wav
  fast_speaker_5m.wav
  overlapped_speakers_5m.wav

若音檔不存在，建立 README 說明如何放置，不要假造 benchmark 結果。

# 驗收條件

1. Windows microphone capture works。
2. Windows WASAPI loopback prototype works。
3. UI 顯示 AudioLevelEvent。
4. WhisperLiveKit 可獨立啟動並被 ASRAdapter 連線。
5. small.en 不再是正式預設。
6. large-v3-turbo / distil-large-v3 至少可設定與 benchmark。
7. partial segment 不送翻譯。
8. final segment 送 TranslationService。
9. OPUS-MT + CTranslate2 fallback 可啟用。
10. TranslateGemma quality path 可啟用或以明確 stub 顯示未安裝原因。
11. OpenCC + glossary + placeholder 會套用。
12. healthz 清楚顯示 mic/system/asr/mt/postprocess 狀態。
13. 產生 docs/BENCHMARK_RESULTS.md。
14. 產生 docs/OFFLINE_ARCHITECTURE.md。
15. 產生 docs/DECISIONS.md。
16. 所有功能可用本機指令重跑，不依賴雲端。

# 回報格式

請用以下格式回報：

## Current diagnosis
- ...

## Architecture changes
- ...

## Files changed
- ...

## Commands to run
```bash
...
````

## Benchmark status

- ASR: ...
- MT: ...
- E2E: ...

## Remaining blockers

- ...

## Evidence

- logs
- screenshots if UI changed
- generated reports

```

```
