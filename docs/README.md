# Offline 即時會議翻譯架構包

## 結論

本架構包將原本「Browser → FastAPI relay → WhisperLiveKit daemon thread → optional translation」收束為可重建的 offline 即時會議翻譯方案。

目標：

- 筆電本機執行，不依賴雲端 API。
- 支援現場會議麥克風音訊。
- 支援 Teams / Zoom / Google Meet / 瀏覽器 / 電腦軟體的系統音訊。
- 英文即時轉錄，中文穩定翻譯。
- ASR、MT、音訊擷取、字幕 UI 可替換與可 benchmark。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `01_ARCHITECTURE_DECISION.md` | 決策摘要：三種候選架構、主推方案、取捨。 |
| `02_IMPLEMENTATION_SPEC.md` | 工程規格：模組切分、事件格式、服務邊界、模型策略。 |
| `03_BENCHMARK_ACCEPTANCE.md` | 驗收與測試：ASR/MT/延遲/字幕穩定度指標。 |
| `04_CLAUDE_CODE_PROMPT.md` | 可直接丟給 Claude Code / Codex 的重構 prompt。 |
| `05_REFERENCES.md` | 參考資料與來源連結。 |

## 最終建議

採用：

```text
Architecture A - Pragmatic Desktop Offline v2

Desktop Shell / Local Web UI
  ↓
Audio Capture Layer
  ├─ Mic Capture：現場會議
  └─ System Audio Loopback：Teams / Zoom / Meet / 瀏覽器 / 電腦軟體
  ↓
ASR Service
  ├─ Primary: WhisperLiveKit + large-v3-turbo / distil-large-v3
  └─ Experimental: Voxtral Realtime branch
  ↓
Segment Stabilizer
  ├─ partial：只顯示英文，不翻譯
  └─ final/stable：送翻譯
  ↓
Translation Service
  ├─ Quality path: TranslateGemma 4B / 12B
  └─ Fast fallback: OPUS-MT en→zh + CTranslate2
  ↓
Taiwan Chinese Postprocess
  ├─ OpenCC s2twp
  ├─ glossary
  └─ proper noun placeholder
  ↓
Caption UI / Transcript Export / Metrics
```

## 立即執行順序

```text
P0：停止錯誤方向
- 不再把 WhisperLiveKit 放在 FastAPI lifespan daemon thread 裡。
- 不再用 small.en 當正式預設。
- 不翻譯 unstable partial segment。
- 不把 OPUS-MT 當最終品質主線。

P1：音訊與 ASR 先穩
- 實作 mic + WASAPI loopback。
- 加 AudioLevelEvent。
- WhisperLiveKit 獨立服務化。
- large-v3-turbo / distil-large-v3 benchmark。

P2：翻譯服務獨立
- TranslationAdapter。
- TranslateGemma quality path。
- OPUS-MT + CTranslate2 fallback。
- OpenCC + glossary + placeholder。

P3：產品化
- Desktop shell。
- 字幕 overlay。
- transcript export。
- metrics dashboard。
```
