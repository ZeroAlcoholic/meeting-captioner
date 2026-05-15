# 05 參考資料

## ASR / Streaming STT

### WhisperLiveKit

- Repo: https://github.com/QUENTINFUXA/WHISPERLIVEKIT
- 用途：real-time / simultaneous speech-to-text，本機或 on-prem。
- 參考價值：不是單純對 audio batch 跑 Whisper，而是處理 buffering / incremental processing，避免小段音訊造成語境切斷與轉錄品質下降。

### WhisperLiveKit releases

- Releases: https://github.com/QuentinFuxa/WhisperLiveKit/releases
- 用途：追蹤 Voxtral backend、benchmark harness、SimulStreaming 等新功能。

### faster-whisper

- Repo: https://github.com/SYSTRAN/faster-whisper
- 用途：CTranslate2-based Whisper inference，支援 faster inference、quantization、batch、distil-large-v3。

### Speaches

- Repo: https://github.com/speaches-ai/speaches
- 用途：OpenAI-compatible local STT/TTS server，STT powered by faster-whisper，支援 streaming transcription。
- 適合：Architecture B 的 local service boundary。

### Voxtral

- Mistral announcement: https://mistral.ai/news/voxtral-transcribe-2
- 用途：Voxtral Realtime / speech-native ASR experimental branch。
- 注意：開 branch benchmark，不要直接取代主線。

## Audio capture

### PyAudioWPatch

- Repo: https://github.com/s0d3s/PyAudioWPatch
- PyPI: https://pypi.org/project/PyAudioWPatch/
- 用途：Windows WASAPI loopback，錄 speaker output。
- 適合：P0 Windows system audio prototype。

### PyAudioWPatch WASAPI loopback example

- Example: https://github.com/s0d3s/PyAudioWPatch/blob/master/examples/pawp_record_wasapi_loopback.py
- 用途：錄「What you hear」speaker output 的範例。

### electron-audio-loopback

- Repo: https://github.com/alectrocute/electron-audio-loopback
- 用途：Electron system audio loopback。
- 適合：桌面 App 產品化階段。

## Translation / MT

### TranslateGemma

- HF model: https://huggingface.co/google/translategemma-4b-it
- Collection: https://huggingface.co/collections/google/translategemma
- 用途：local quality translation path。
- 注意：適合 benchmark 取代 OPUS-MT 作 final quality path，但實際 latency 必須用目標筆電測。

### CTranslate2

- Repo: https://github.com/OpenNMT/CTranslate2
- 用途：高效 Transformer inference runtime，適合 OPUS-MT fallback、MarianMT、Whisper 等。

### OPUS-MT en→zh

- Model: https://huggingface.co/Helsinki-NLP/opus-mt-en-zh
- 用途：fast fallback，不建議當最終品質主線。

### OpenCC

- Repo: https://github.com/BYVoid/OpenCC
- 用途：簡繁、異體字、地區詞彙轉換；本案用 `s2twp`。
- 注意：OpenCC 不是翻譯模型，不能修正語意錯譯。

## 不建議作為正式商用主線

### NLLB

- Model: https://huggingface.co/facebook/nllb-200-distilled-600M
- 原因：常見模型授權為 CC-BY-NC，適合 benchmark / research，不適合作正式商用預設。

### SeamlessM4T

- Model: https://huggingface.co/facebook/seamless-m4t-v2-large
- 原因：技術上可研究，但商用授權與 production suitability 需謹慎，不作預設主線。
