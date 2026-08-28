# Gemini v1beta 轉換成本與延遲改善嚴格診斷

- 日期：2026-08-28（Asia/Taipei）
- 專案：`meeting_audio`
- 範圍：Google Gemini 線上即時翻譯路徑
- 性質：研究與 live probe 診斷；本報告不代表已完成正式架構遷移

## 1. 結論摘要

1. 專案目前使用的 `gemini-3.5-live-translate-preview`，仍是 Google 最新的專用即時語音翻譯模型。
2. 2026-08-26 的新 release 是 GA 的 `gemini-3.5-transcribe` 與
   `gemini-3.5-transcribe-live`，不是新版 Live Translate。
3. `v1alpha → v1beta` 是相容性與安全性遷移，沒有證據顯示會改善模型推論延遲。
4. 現有 Live Translate 單模型路徑仍有最快的完整 final；若優先追求第一個可見譯文，則
   `Transcribe Live → Flash-Lite 文字翻譯`具備約 30–38% 的實用改善潛力。
5. 替代管線的完整 final 在本次量測中約慢 0.53 秒，但每小時推估成本可由約
   US$2.21 降至 US$0.66–0.81。
6. 不應直接切換正式預設。應先遷移 v1beta，再以 feature flag 建立替代管線，通過真實會議音訊、
   P50/P95、翻譯品質、長時間換線及失敗路徑驗收後，才能決定是否更換主路徑。

## 2. 最新模型與版本狀態

### 2.1 即時翻譯

- 模型：`gemini-3.5-live-translate-preview`
- 發布：2026-06
- 狀態：Preview
- 功能：70+ 語言的低延遲語音對語音翻譯，並可取得輸入及輸出 transcription。
- 繁體中文 target code：`zh-Hant`
- 限制：只接受音訊輸入；不支援 system instruction、function calling、thinking、搜尋及文字輸入。

### 2.2 新發布的即時轉錄

- 模型：`gemini-3.5-transcribe-live`
- 發布：2026-08-26
- 狀態：GA
- 功能：低延遲 interim transcription、final transcription、語言偵測、custom vocabulary、
  Smart transcription、manual/hybrid VAD。
- 限制：Live session 最長 10 分鐘；不支援 live speaker diarization 及 word-level timestamps。
- 它是 STT，不直接產生翻譯。

### 2.3 API 版本

- `v1alpha`：專案建立時使用的舊實驗端點；目前 Google API 版本說明只正式列出 `v1` 與
  `v1beta`。
- `v1beta`：目前 Live API、ephemeral token、Live Translate 與 Live Transcribe 文件使用的端點。
- 模型 release stage 與 API version 是兩件事：Preview 模型可以透過 v1beta 使用；改用 v1beta
  不等同改用另一個推論模型。

## 3. 專案現況

### 3.1 模型與協定

目前設定只允許：

```text
gemini-3.5-live-translate-preview
```

相關位置：

- `services/online/src/config.ts`
- `services/online/src/routes/gemini.ts`
- `apps/web/src/providers/gemini-live-provider.ts`
- `services/online/scripts/probe-upstream-contracts.ts`
- `tests/fixtures/upstream-contracts/gemini-live-translate.json`

目前仍使用：

```text
POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens
wss://generativelanguage.googleapis.com/ws/
  google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained
```

### 3.2 已存在的延遲最佳化

- 瀏覽器預先 mint ephemeral token。
- token mint 與音訊來源取得並行。
- 16 kHz PCM16 mono。
- AudioWorklet 使用 512 samples，即 32ms 音訊封包。
- 瀏覽器直接連線 Google WebSocket，音訊不經本機 Fastify proxy。
- 已有 context window compression、session resumption、GoAway 處理、backpressure guard、
  wedge detection 與 persistent reconnect。
- `outputAudioTranscription` 直接進字幕路徑，翻譯音訊本身不播放。

### 3.3 尚存的啟動等待

目前 provider 在 token、音訊來源與 WebSocket `setupComplete` 完成後，才啟動 AudioWorklet：

```text
mint token ┐
           ├─ wait → connect WS → setupComplete → startAudioCapture
get audio ┘
```

因此冷啟動仍可能多等待一次 WebSocket setup RTT。若將 WebSocket connect 與音訊來源取得完整並行，
理論上可再減少約 0.25–0.30 秒，但必須正確處理麥克風拒絕、Stop、重啟與 orphan socket。

## 4. v1alpha 與 v1beta live probe

### 4.1 測試條件

- 使用目前環境的 `GEMINI_API_KEY`。
- 不輸出 key 或 ephemeral token。
- 不送出會議音訊。
- 每個版本執行三次 token mint＋WebSocket `setupComplete`。

### 4.2 結果

| 版本    |           三次完整啟動 | 中位數 |
| ------- | ---------------------: | -----: |
| v1alpha | 1.359s、1.627s、1.227s | 1.359s |
| v1beta  | 1.195s、1.463s、1.454s | 1.454s |

樣本數只有三次，而且兩組分布重疊。結果只能支持「v1beta 沒有可辨識的啟動速度優勢」，不能支持
v1beta 較慢。正式應用已有 token prewarm，因此上述 token mint 時間通常不在使用者按下 Start 的
關鍵路徑。

### 4.3 token constraint 實測

Google 教學頁面的 raw REST 範例使用 `liveConnectConstraints`，但在本次環境對 v1alpha 與
v1beta 均回傳 HTTP 400：

```text
Unknown name "liveConnectConstraints" at 'auth_token'
```

Google API Reference 定義的 canonical 欄位為：

```json
{
  "bidiGenerateContentSetup": {
    "model": "models/gemini-3.5-live-translate-preview"
  },
  "fieldMask": "model"
}
```

此格式已以 v1beta 實測成功 mint token，並在瀏覽器相同的 constrained WebSocket setup 收到
`setupComplete`。這使伺服器可以只鎖定模型，同時允許前端設定 `zh-Hant` 或 `en`，不必把語言
選擇耦合到 token route。

### 4.4 v1beta 遷移價值

可確認的價值：

- 跟隨現行官方端點與 schema。
- 使用 `x-goog-api-key` header，避免 server-to-Google request URL 含長期 key。
- 可用 `bidiGenerateContentSetup`＋`fieldMask` 鎖定模型，縮小 ephemeral token 被濫用的範圍。
- 可直接採用 Live Transcribe 等只在現行 v1beta 文件出現的新能力。

沒有證據支持的價值：

- 模型推論更快。
- Live Translate 第一個譯文更早。
- 32ms/100ms 音訊封包行為會因 API 版本自動改變。

## 5. 延遲量測方法

### 5.1 固定輸入

- 使用 `gemini-3.1-flash-tts-preview` 產生固定英文語音。
- 測試內容：

```text
Good morning everyone. Today we will review the project budget.
Then we will discuss the schedule for next quarter.
```

- TTS 回傳 24 kHz PCM16，測試器在記憶體轉為 16 kHz PCM16。
- 音訊長度因每次 TTS 生成略有變動，校正後主要測試約 7.56–7.68 秒。
- 音訊依真實播放速度送入 WebSocket。
- 使用絕對時鐘排程，避免大量 32ms `setTimeout` 的累積漂移。

### 5.2 樣本數與解讀限制

- Live Translate 32ms/100ms：各三次。
- Live Transcribe 32ms/100ms：各三次。
- Flash-Lite、3.6 Flash、3.7 Flash 文字翻譯：各五次。
- 測試音訊為乾淨的合成單一講者，不能推廣成嘈雜會議、多講者、口音或網路壅塞下的 P95。
- 本次結果適合做架構篩選及建立假說，不足以直接宣告 production SLA。

## 6. 音訊封包大小

### 6.1 校正後結果

| 路徑            | 指標         | 32ms 中位數 | 100ms 中位數 |           差異 |
| --------------- | ------------ | ----------: | -----------: | -------------: |
| Live Translate  | 第一原文     |      2.827s |       2.921s |   32ms 快 94ms |
| Live Translate  | 第一譯文     |      3.158s |       3.113s |  100ms 快 45ms |
| Live Transcribe | 第一 interim |      0.944s |       0.719s | 100ms 快 225ms |
| Live Transcribe | final        |      7.782s |       7.882s |  32ms 快 100ms |

Live Translate 的 45–94ms 差異小於合理的網路及推論波動，沒有足夠證據改變現有 32ms 設定。
Live Transcribe 的 interim 在三次 100ms 測試均較快，若建立新路徑，可用 100ms 作為第一個候選，
但仍需真實音訊 A/B。

### 6.2 傳輸與 CPU 成本

16 kHz PCM16 mono 原始音訊為：

```text
16,000 samples/s × 2 bytes = 32,000 bytes/s
```

Base64 後約 42,667 bytes/s，音訊 token 費用不因封包大小改變。

| 封包  | 訊息數/秒 | raw bytes/訊息 | 特性                                            |
| ----- | --------: | -------------: | ----------------------------------------------- |
| 32ms  |     31.25 |          1,024 | 較低填充等待、較高 JSON/base64/main-thread 次數 |
| 100ms |        10 |          3,200 | 訊息數減少 68%，但增加封包填充等待              |

100ms 主要價值是降低 main-thread、GC、JSON 與 WebSocket frame 數量，不是降低 audio token 成本。

## 7. 現有 Live Translate 基線

100ms 校正後三次第一譯文：

```text
3.329s、2.923s、3.113s
median = 3.113s
```

另一組三次完整事件量測：

| 指標                            |                   結果 |
| ------------------------------- | ---------------------: |
| 音訊長度                        |               約 7.60s |
| 第一譯文                        | 3.273s、3.278s、3.322s |
| 最後譯文                        | 7.988s、7.988s、8.037s |
| 最後譯文落後音訊結束            |               約 0.39s |
| 每次 output transcription event |                   6 次 |

單次輸出節奏：

|   時間 | 輸出           |
| -----: | -------------- |
| 3.222s | 大家早安。     |
| 3.916s | 今天我們將     |
| 4.922s | 審查專案預算。 |
| 5.918s | 然後           |
| 6.908s | 我們將討論     |
| 7.986s | 下一季的日程   |

現有路徑的特性是第一個有意義譯文約 3.2 秒才出現，但之後以 append-only 形式持續增加，最後譯文
在講者停止後約 0.4 秒完成。專案丟棄翻譯音訊，但仍必須等待模型的 AUDIO output transcription，
因此仍支付 output audio token 成本。

## 8. Live Transcribe 基線

100ms 封包的中位數：

| 指標                       |    中位數 |
| -------------------------- | --------: |
| 第一 interim transcription |    0.719s |
| final transcription        |    7.882s |
| final 落後實際送完音訊     | 約 0.275s |

單次 7.68 秒測試共收到 15 個 interim：

|   時間 | 累積字元數 |
| -----: | ---------: |
| 0.821s |          4 |
| 1.326s |         13 |
| 1.821s |         23 |
| 2.313s |         23 |
| 2.814s |         32 |
| 3.226s |         37 |
| 3.721s |         48 |
| 4.226s |         56 |
| 4.683s |         64 |
| 5.232s |         69 |
| 5.629s |         77 |
| 6.123s |         89 |
| 6.609s |        102 |
| 7.111s |        107 |
| 7.613s |        116 |

第一個 interim 雖然快，但只有約 4 個字元，不足以做穩定翻譯。約 1.3 秒時累積至 13 字元，才較
接近第一個可用的短片語。

## 9. 第二階段文字翻譯模型

固定短句、streamGenerateContent、五次、最低可用 thinking level：

| 模型                    | Thinking | 首 chunk 中位數 | 完整回應中位數 |
| ----------------------- | -------- | --------------: | -------------: |
| `gemini-3.5-flash-lite` | minimal  |          0.613s |         0.641s |
| `gemini-3.6-flash`      | minimal  |          1.203s |         1.230s |
| `gemini-3.7-flash`      | low      |          1.020s |         1.022s |

在此簡單翻譯工作中，Flash-Lite 明顯最快，也符合 Google 對其低延遲、高吞吐及低成本的定位。
3.6/3.7 的進階推理能力並未為短句翻譯帶來可量測的延遲優勢。

## 10. 替代管線的延遲推導

候選架構：

```text
16k PCM
  → gemini-3.5-transcribe-live
  → interim transcript
  → bounded/coalesced server request
  → gemini-3.5-flash-lite (minimal)
  → draft translation
  → final transcript
  → final translation overwrite
```

### 10.1 最早但不穩定的草稿

```text
0.719s first interim + 0.613s Flash-Lite = 1.332s
```

相對 Live Translate 3.113s，理論改善約 1.78 秒或 57%。但是此時 transcript 可能只有 4 個字元，
不可視為有意義的使用者改善。

### 10.2 第一個有意義草稿

等待至少 10–15 字元：

```text
1.326s transcript + 0.613s translation = 1.939s
```

加入 100–250ms coalescing、本機 server hop 與 UI 更新後，合理目標約 2.0–2.2 秒。相對 3.113s，
實用改善約 0.9–1.1 秒或 30–38%。

### 10.3 完整 final

```text
7.882s final transcript + 0.641s final translation = 8.523s
```

相對 Live Translate 最後譯文約 7.988s，替代管線慢約 0.535 秒或 6.7%。因此此架構是「更早顯示
草稿」，不是「更早完成 final」。

## 11. Partial translation 的成本與穩定性

若每個 interim 都送去翻譯：

- 15 requests / 7.68s ≈ 117 requests/min。
- 累積 interim 字元總和為 860，final 為 116，重複前綴約放大 7.41 倍。
- 前一個 HTTP request 可能晚於後一個返回，必須 sequence gate 或 AbortController。
- 翻譯完整 prefix 時，模型可能重寫前文；不能假設譯文是 append-only。
- UI 必須區分 speculative draft 與 authoritative final，並限制閃爍及大範圍回改。

建議第一個實驗策略：

- 第一個請求：累積至少 10–15 字元。
- 後續最多每 1 秒一次。
- 文字未增加或只有空白/標點變化時不送。
- 每個 segment 同時最多一個有效 request。
- 新 request 發出時 abort 舊 request，回應再以 segment sequence 驗證。
- final 永遠重新翻譯一次，並覆寫所有 draft。
- dispatcher 必須 bounded；壓力下丟棄舊 draft，不能阻塞 transcript/caption path。

## 12. 營運成本估算

### 12.1 官方單價

- Live Translate：合計約 US$0.0368/min。
- Transcribe Live：約 US$0.009/min。
- Gemini 3.5 Flash-Lite：US$0.30/M input tokens、US$2.50/M output tokens。

### 12.2 假設

- 依 Google Transcribe 定價估算採用約 175 text tokens/min。
- 翻譯輸入與輸出 token 數量視為同量級。
- 每次 partial request 約增加 25 個 prompt input tokens。
- 實際繁中 tokenization、領域詞與句長會改變結果，因此以下為決策級估算，不是帳單保證。

### 12.3 結果

| 方案                             |  約每分鐘 | 約每小時 | 相對節省 |
| -------------------------------- | --------: | -------: | -------: |
| 現有 Live Translate              | US$0.0368 |  US$2.21 |        — |
| Transcribe＋只翻 final           | US$0.0095 |  US$0.57 |   約 74% |
| Transcribe＋最多每秒一次 partial | US$0.0110 |  US$0.66 |   約 70% |
| Transcribe＋每個 interim 都翻    | US$0.0135 |  US$0.81 |   約 63% |

即使 naive partial translation 仍比 Live Translate 便宜，但 117 RPM、回應競態與 UI 抖動使其不具
production 可行性。費用不是主要限制，請求率與一致性才是。

換算 1,000 meeting-hours/month：

| 方案                  |            約月費 |
| --------------------- | ----------------: |
| Live Translate        |          US$2,208 |
| 每秒一次 partial 管線 |            US$660 |
| 差額                  | 約 US$1,548/month |

未計免費額度、稅、匯率、tier、重試、重複 session 或其他服務成本。

## 13. 工程轉換成本

### 13.1 v1beta 原路徑遷移

估計：0.5–1 人日。

工作內容：

- token endpoint 改為 `/v1beta/auth_tokens`。
- 改用 `x-goog-api-key` header。
- WebSocket namespace 改為 `v1beta`。
- 使用 `bidiGenerateContentSetup`＋`fieldMask:"model"` 鎖模型。
- 更新 upstream probe、fixture、unit tests、文件。
- live 驗證 setup、音訊、transcription、session resumption、GoAway 與 reconnect。

預期延遲改善：0ms；不得把版本遷移包裝成效能優化。

### 13.2 冷啟動並行化

估計：0.5–1 人日。

工作內容：

- WebSocket connect 與音訊來源取得並行。
- Stop／麥克風拒絕／token 失敗時中止另一分支。
- 防止晚到的 setup 或 mic grant 污染下一個 session。
- 補 race、teardown 與 failover tests。

理論收益：冷啟動最多約 0.25–0.30 秒；暖啟動與已建立 capture lease 時可能更小。

### 13.3 Transcribe＋Flash-Lite prototype

估計：2–3 人日。

範圍：

- 新 experimental provider。
- Transcribe interim/final normalized event mapping。
- server-side Gemini Flash-Lite translation endpoint。
- 簡單的 1 秒 coalescing、abort 與 feature flag。
- 固定音訊 benchmark。

此階段只能證明可行性，不能當 production 完成。

### 13.4 Production 化

估計：7–12 人日，包含 prototype。

主要成本：

- partial revision、sequence gate、bounded dispatcher 與 caption-path isolation。
- Transcribe 10 分鐘 session rotation；必要時使用短暫雙 session overlap 並去重。
- 429、timeout、網路中斷、wedge、重連與 fallback。
- 語言切換、`zh-Hant`／英文雙向模式及 custom vocabulary。
- 真實會議音訊 corpus、領域詞與翻譯品質回歸。
- provider conformance、unit、integration、browser E2E、60 分鐘 soak。
- 成本與延遲 telemetry 更新。

## 14. 主要風險

### 14.1 品質風險

- interim 是可改寫的假說，不是 final。
- 英中語序差異使短 prefix 特別容易被後文推翻。
- Flash-Lite 雖快，但本次沒有完成與 Live Translate 的正式翻譯品質評測。
- 不能以低 latency 取代術語準確率、漏譯率及語意完整性驗收。

### 14.2 可靠性風險

- Transcribe Live 最長 10 分鐘，長會議必須換線。
- partial request 可能超過專案 RPM；Google 實際配額依 tier 與專案狀態而異。
- abort 不保證上游停止計費，也不能取代 late-response sequence gate。
- 多一個模型與 HTTP hop，增加故障面及監控維度。

### 14.3 UX 風險

- 太早顯示 4–8 字元譯文可能比等待更令人困惑。
- 大幅回改譯文會造成閱讀位置跳動。
- 必須明確區分 draft/final，但不能增加動畫或同步工作阻塞 caption rendering。

### 14.4 安全風險

- 音訊可繼續使用 browser→Gemini ephemeral-token 直連。
- Flash-Lite 標準文字 API 不應把長期 API key 放進瀏覽器；應透過本機 online service。
- v1beta token 應至少使用 `fieldMask:"model"` 鎖定模型。

## 15. 建議執行順序

### Phase A：立即做，低風險

1. 將現有 Gemini token 與 WebSocket 遷移至 v1beta。
2. 改用 `x-goog-api-key` header。
3. 以 `bidiGenerateContentSetup`＋`fieldMask:"model"` 鎖定模型。
4. 保留現有 `gemini-3.5-live-translate-preview` 與 32ms 封包。
5. 跑真實 upstream contract probe 與既有回歸測試。

### Phase B：獨立實驗，不取代主路徑

1. 新增 `gemini_fast_caption` feature flag。
2. `gemini-3.5-transcribe-live` 使用 100ms、VERBATIM、明確語言 hint。
3. 第一個翻譯至少等待 10–15 字元，後續最多每秒一次。
4. 使用 `gemini-3.5-flash-lite`＋`minimal`。
5. final transcript 必須重新翻譯並覆寫 draft。

### Phase C：以證據決定是否切換

只有同一批真實會議音訊達到全部門檻，才能更換預設：

- 第一個有意義譯文：P50 ≤2.2s、P95 ≤3.0s。
- 說完至 final translation：P50 ≤1.0s、P95 ≤1.5s。
- 60 分鐘測試及每次 10 分鐘換線均無字幕遺失、重複或錯序。
- 領域術語、漏譯率與語意品質不得低於 Live Translate 基線。
- 平均 Gemini 成本 ≤US$0.014/min。
- partial request rate 維持在專案實際 quota 以下，並有可見降級狀態。
- caption path 在 translation timeout、429、重連與切換期間持續顯示原文。

## 16. 最終決策

- **若目標是最低風險、最早 final：**保留 Live Translate。
- **若目標是更早第一個譯文及更低成本：**實驗 Transcribe＋Flash-Lite。
- **若目標是單純因 v1beta 而提速：**不成立；v1beta 應遷移，但理由是正確性、安全性與新功能
  相容，不是推論速度。
- **目前最合理策略：**v1beta 原路徑先行，替代管線並行量測，未通過門檻前不替換正式預設。

## 17. 官方參考

- Gemini API Release Notes：<https://ai.google.dev/gemini-api/docs/changelog>
- API versions：<https://ai.google.dev/gemini-api/docs/api-versions>
- Live Translate：<https://ai.google.dev/gemini-api/docs/live-api/live-translate>
- Live Transcribe：<https://ai.google.dev/gemini-api/docs/live-api/live-transcribe>
- Ephemeral tokens：<https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens>
- WebSocket quickstart：<https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket>
- Auth token API Reference：<https://ai.google.dev/api/generate-content>
- Live API best practices：<https://ai.google.dev/gemini-api/docs/live-api/best-practices>
- Gemini models：<https://ai.google.dev/gemini-api/docs/models>
- Pricing：<https://ai.google.dev/gemini-api/docs/pricing>
- Rate limits：<https://ai.google.dev/gemini-api/docs/rate-limits>
- Gemini 3.5 Flash-Lite：<https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite>
