# 02 工程實作規格

## 1. 目標架構

```text
Desktop Shell / Local Web UI
  ↓
Audio Capture Service
  ↓
ASR Service
  ↓
Segment Stabilizer
  ↓
Translation Service
  ↓
Taiwan Chinese Postprocess
  ↓
Caption UI / Transcript Store / Metrics
```

## 2. 模組切分

```text
apps/
  desktop/
    src/
      audio/
        mic_capture.ts
        system_loopback.ts
        audio_level_meter.ts
      ui/
        CaptionBoard.tsx
        DeviceSelector.tsx
        MetricsPanel.tsx

services/
  audio-router/
    app/
      capture_mic.py
      capture_windows_wasapi.py
      frame_normalizer.py
      level_meter.py

  asr/
    app/
      adapters/
        base.py
        whisperlivekit_adapter.py
        speaches_adapter.py
        voxtral_adapter.py
      server.py
      schemas.py

  translation/
    app/
      adapters/
        base.py
        translategemma_worker.py
        ctranslate2_opus_worker.py
      postprocess/
        opencc_tw.py
        glossary.py
        placeholder.py
        repetition_guard.py
      server.py
      schemas.py

  session-api/
    app/
      caption_stream.py
      session_store.py
      transcript_export.py
      metrics.py
```

## 3. Audio Capture

### 3.1 Input modes

```yaml
input_modes:
  mic:
    use_case: 現場會議
    source: default_microphone
    sample_rate: 16000
    channels: mono

  system:
    use_case: Teams / Zoom / Google Meet / Browser / Software
    source: WASAPI loopback on Windows
    sample_rate: 16000
    channels: mono

  mixed:
    use_case: 同時收現場與電腦音訊
    source:
      - mic
      - system
    default_policy: system_only
    optional_policy: mix_with_gain_control
```

### 3.2 AudioFrame schema

```json
{
  "type": "audio.frame",
  "session_id": "session-001",
  "source": "system",
  "sample_rate": 16000,
  "channels": 1,
  "format": "pcm16",
  "duration_ms": 20,
  "timestamp_ms": 123456,
  "payload": "<binary>"
}
```

### 3.3 AudioLevelEvent

```json
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
```

UI 必須顯示 audio level。若 3 秒內沒有音訊，顯示 `no audio detected`。

## 4. ASR Service

### 4.1 ASRAdapter interface

```python
from typing import AsyncIterator, Protocol
from dataclasses import dataclass

@dataclass
class AudioFrame:
    session_id: str
    source: str
    pcm16: bytes
    sample_rate: int
    timestamp_ms: int

@dataclass
class ASREvent:
    session_id: str
    segment_id: str
    text: str
    start_ms: int
    end_ms: int
    status: str  # partial | final
    stability: float
    speaker: str | None
    engine: str
    latency_ms: dict

class ASRAdapter(Protocol):
    async def start(self, session_id: str) -> None:
        ...

    async def push_audio(self, frame: AudioFrame) -> None:
        ...

    async def events(self) -> AsyncIterator[ASREvent]:
        ...

    async def stop(self) -> None:
        ...
```

### 4.2 ASR default policy

```yaml
asr:
  default_engine: whisperlivekit
  task: transcribe
  language: en
  translate_in_asr: false

  primary_model:
    name: large-v3-turbo
    backend: faster_whisper_or_simulstreaming
    compute_type: float16

  fallback_model:
    name: distil-large-v3
    backend: faster_whisper
    compute_type: int8_float16

partial_policy:
  emit_to_ui: true
  translate: false
  persist: false

final_policy:
  emit_to_ui: true
  translate: true
  persist: true
```

## 5. Segment Stabilizer

### 5.1 規則

```text
partial:
  - 顯示英文即時字幕
  - 不送翻譯
  - 不寫入 final transcript
  - 可被覆蓋

final:
  - 去重
  - 合併過短片段
  - 切分過長片段
  - 保留 timestamp / speaker / segment_id
  - 送 Translation Service
```

### 5.2 Trigger policy

```yaml
translation_trigger:
  translate_partial: false
  final_only: true
  min_words: 3
  max_words: 28
  max_segment_duration_ms: 9000
  dedupe_key: segment_id_and_text_hash
```

## 6. Translation Service

### 6.1 TranslationAdapter interface

```python
from dataclasses import dataclass
from typing import Protocol

@dataclass
class TranslationRequest:
    session_id: str
    segment_id: str
    source_text: str
    source_lang: str
    target_lang: str
    glossary_version: str
    timeout_ms: int

@dataclass
class TranslationResult:
    session_id: str
    segment_id: str
    source_text: str
    target_text: str
    engine: str
    status: str  # fallback | final | failed
    latency_ms: int
    revision: int

class TranslationAdapter(Protocol):
    async def translate(self, request: TranslationRequest) -> TranslationResult:
        ...
```

### 6.2 Engine policy

```yaml
translation:
  source_lang: en
  target_lang: zh-Hant-TW

  quality_path:
    engine: translategemma
    model: google/translategemma-4b-it
    timeout_ms: 1200
    enabled: true

  fallback_path:
    engine: ctranslate2
    model: Helsinki-NLP/opus-mt-en-zh
    target_token: ">>cmn_Hant<<"
    timeout_ms: 250
    enabled: true

  late_replacement:
    enabled: true
    rule: fallback_first_quality_later

  cache:
    key: source_text_hash_glossary_version_target_lang
    ttl_minutes: 120
```

### 6.3 Translation flow

```text
ASR final segment
  ↓
placeholder masking
  ↓
quality path request
  ├─ if completed within timeout: emit final translation
  └─ if timeout: emit fallback translation first
        ↓
late quality result arrives
  ↓
replace fallback translation with revision +1
  ↓
OpenCC + glossary + normalization
  ↓
Caption UI
```

## 7. Taiwan Chinese Postprocess

### 7.1 Pipeline

```text
raw MT output
  ↓
OpenCC s2twp
  ↓
glossary replacement
  ↓
proper noun restore
  ↓
number/date/money normalization
  ↓
repetition guard
  ↓
final subtitle
```

### 7.2 Glossary TSV

```tsv
source	target	note	priority
policyholder	要保人	insurance	100
insured	被保險人	insurance	100
beneficiary	受益人	insurance	100
underwriting	核保	insurance	100
claim	理賠	insurance	100
premium	保費	insurance	100
rider	附約	insurance	100
waiting period	等待期	insurance	100
exclusion	除外責任	insurance	100
health declaration	健康告知	insurance	100
```

## 8. Caption event schema

```json
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
```

## 9. Health check

```json
{
  "audio": {
    "mic": "ready",
    "system_loopback": "ready",
    "last_audio_level_ms": 120
  },
  "asr": {
    "engine": "whisperlivekit",
    "model": "large-v3-turbo",
    "status": "ready",
    "cuda": true
  },
  "translation": {
    "quality_engine": "translategemma-4b-it",
    "fallback_engine": "opus-mt-en-zh-ct2",
    "status": "ready"
  }
}
```

## 10. 禁止事項

```text
- 不得在 WebSocket handler 直接載入或呼叫重模型。
- 不得讓 ASR / MT / UI 混在同一個不可測狀態中。
- 不得預設啟用雲端 API。
- 不得預設啟用中國來源模型或服務。
- 不得把 NLLB / SeamlessM4T 當正式商用預設主線。
- 不得宣稱支援但沒有 benchmark 與可重跑指令。
```
