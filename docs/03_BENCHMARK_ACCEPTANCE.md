# 03 Benchmark 與驗收規格

## 1. 目的

這份文件用來避免「能跑」被誤判成「可用」。

Offline 即時會議翻譯必須同時驗收：

```text
1. 是否真的收到音訊
2. ASR 是否準
3. ASR 是否夠即時
4. 翻譯是否準
5. 中文是否穩定不跳動
6. 系統音訊是否可用
7. 模型與 runtime 是否正確走 GPU / local
8. 當模型未就緒時 healthz 是否說清楚
```

## 2. 測試音檔集合

```text
audio/
  clean_meeting_5m.wav
  noisy_meeting_5m.wav
  teams_system_audio_5m.wav
  google_meet_browser_audio_5m.wav
  insurance_terms_5m.wav
  fast_speaker_5m.wav
  overlapped_speakers_5m.wav
```

每個音檔應有：

```text
- reference_transcript.en.txt
- reference_translation.zh-Hant-TW.txt
- metadata.yaml
```

metadata 範例：

```yaml
file: insurance_terms_5m.wav
duration_sec: 300
source: system_audio
speakers: 2
noise: medium
domain: insurance
notes:
  - includes policyholder / underwriting / claim / premium
```

## 3. ASR benchmark

### 3.1 ASR candidates

```yaml
asr_candidates:
  - name: whisperlivekit_large_v3_turbo
    backend: whisperlivekit
    model: large-v3-turbo

  - name: whisperlivekit_distil_large_v3
    backend: whisperlivekit
    model: distil-large-v3

  - name: speaches_large_v3_turbo
    backend: speaches
    model: large-v3-turbo

  - name: voxtral_realtime
    backend: voxtral
    model: voxtral-realtime
    status: experimental
```

### 3.2 ASR metrics

```text
WER
CER
RTF
first_partial_latency_p50_ms
first_partial_latency_p95_ms
final_segment_latency_p50_ms
final_segment_latency_p95_ms
segment_revision_count
hallucination_count
dropped_audio_count
GPU_memory_MB
CPU_usage_avg
crash_count
reconnect_success_rate
```

### 3.3 ASR result table format

```markdown
| Candidate | WER ↓ | RTF ↓ | First partial p95 ↓ | Final p95 ↓ | Revision count ↓ | GPU MB | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| whisperlivekit_large_v3_turbo |  |  |  |  |  |  |  |
| whisperlivekit_distil_large_v3 |  |  |  |  |  |  |  |
| speaches_large_v3_turbo |  |  |  |  |  |  |  |
| voxtral_realtime |  |  |  |  |  |  |  |
```

## 4. Translation benchmark

### 4.1 MT candidates

```yaml
translation_candidates:
  - name: translategemma_4b_it
    role: quality_path

  - name: translategemma_12b_it
    role: quality_path_high_resource

  - name: opus_mt_en_zh_ctranslate2
    role: fast_fallback

  - name: nllb_600m
    role: benchmark_only
    production_default: false
```

### 4.2 Translation metrics

```text
chrF
COMET_optional
human_meaning_preservation_1_to_5
human_tw_naturalness_1_to_5
human_terminology_accuracy_1_to_5
omission_count
hallucination_count
repetition_count
fallback_latency_p50_ms
fallback_latency_p95_ms
quality_latency_p50_ms
quality_latency_p95_ms
late_replacement_count
```

### 4.3 Human evaluation rubric

```text
5 = 可直接用於會議字幕，語意正確，台灣繁中自然，術語正確。
4 = 大致可用，少量語氣或術語需要修。
3 = 可理解但不夠自然或術語常錯。
2 = 多處漏譯、誤譯或語序不適合字幕。
1 = 不可用。
```

## 5. End-to-end latency benchmark

### 5.1 Latency breakdown

```json
{
  "segment_id": "seg-001",
  "latency_ms": {
    "audio_capture": 12,
    "audio_router": 5,
    "asr_first_partial": 420,
    "asr_final": 980,
    "segment_stabilizer": 8,
    "mt_queue": 20,
    "mt_fallback": 180,
    "mt_quality": 960,
    "postprocess": 7,
    "ui_render": 12,
    "total_to_english_partial": 449,
    "total_to_chinese_fallback": 1193,
    "total_to_chinese_quality": 1973
  }
}
```

### 5.2 Target thresholds

```yaml
targets:
  audio_level_visible_within_ms: 300
  no_audio_warning_within_ms: 3000
  english_first_partial_p95_ms: 1200
  english_final_p95_ms: 2500
  chinese_fallback_p95_ms_after_asr_final: 500
  chinese_quality_p95_ms_after_asr_final: 1800
  subtitle_revision_count_avg: 2
  system_audio_capture_required: true
```

## 6. 字幕穩定度驗收

### 6.1 不可接受

```text
- 中文字幕跟著 partial 一直改。
- 同一句中文重複出現 2 次以上。
- fallback 與 final 同時顯示成兩句。
- segment 順序錯亂。
- 英文 partial 被寫入 final transcript。
```

### 6.2 可接受

```text
- 英文 partial 即時跳動。
- 中文字幕稍慢，但 final 穩定。
- fallback 先顯示，quality translation 後到時覆蓋同一 segment。
- debug mode 顯示 revision + engine。
```

## 7. Acceptance criteria

```yaml
acceptance:
  audio:
    mic_capture: must_work
    windows_system_audio_loopback: must_work
    audio_level_event: required
    no_audio_detection: within_3s

  asr:
    small_en_not_default: true
    benchmark_large_v3_turbo: required
    benchmark_distil_large_v3: required
    p95_final_latency_ms_target: 2500

  translation:
    partial_translation_disabled: true
    quality_path_required: true
    fallback_path_required: true
    fallback_timeout_configurable: true
    zh_tw_postprocess_required: true

  ui:
    english_partial_visible: true
    chinese_final_stable: true
    subtitle_revision_debug_visible: true
    transcript_export_required: true

  offline:
    cloud_api_required: false
    external_network_required_after_model_download: false

  governance:
    china_models_default_enabled: false
    cloud_provider_default_enabled: false
```

## 8. Benchmark output files

```text
reports/
  asr_benchmark_results.md
  translation_benchmark_results.md
  e2e_latency_results.jsonl
  subtitle_stability_report.md
  model_health_report.json
```

## 9. 最低通過門檻

```text
P0 pass:
- Windows mic capture works.
- Windows system audio loopback works.
- AudioLevelEvent works.
- ASR large-v3-turbo or distil-large-v3 produces usable English final segments.
- Chinese translation appears only for final/stable segments.
- OPUS-MT fallback works.
- TranslateGemma quality path can be toggled.
- OpenCC + glossary applies.
- Benchmark report is generated.

P1 pass:
- Chinese subtitle stability acceptable.
- Teams/Zoom/browser system audio tested.
- p95 English final latency under target.
- p95 Chinese fallback latency under target.
- No unstable partial translation.

P2 pass:
- Desktop shell packaged.
- User can choose mic/system audio.
- Transcript export works.
- Model health UI works.
```
