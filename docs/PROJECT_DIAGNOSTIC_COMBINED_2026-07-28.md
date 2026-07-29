# Meeting Audio 專案完整診斷合併報告

- 報告日期：2026-07-28（Asia/Taipei）
- 診斷對象：目前未提交的工作樹；基準 HEAD `f847dcd`
- 合併範圍：前次全專案診斷、本次複核、官方最新文件查證、真實 OpenAI／Gemini 雲端探針、測試與相依套件檢查
- 報告性質：診斷與裁決；本次未修改專案程式碼
- 原始複核稿：[AUDIT_VERIFICATION_2026-07-28.md](AUDIT_VERIFICATION_2026-07-28.md)

> **總結論：目前不能宣告兩個線上模型都已可用。** OpenAI `gpt-realtime-translate` 是最新專用 Realtime 翻譯模型，採相同專用模型與端點的 upstream 直連探針可實際串流，但尚未完成瀏覽器 speech-to-paint 真實 E2E；Gemini `gemini-3.5-live-translate-preview` 也是最新專用 Live Translate 模型，但目前工作樹的 raw WebSocket setup JSON 與現行服務端 schema 不相容，實測 3/3 在 setup 階段被 1007 關閉。專案整體有廣泛單元與 mock E2E 覆蓋，但仍存在雲端實路徑、隱私、caption path、模式切換、LAN 曝露及長會議可靠性等 release blocker。

## 1. 裁決摘要

| 面向                         | OpenAI                                      | Gemini                                                 | 裁決                                                                                         |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 本任務應用模型               | `gpt-realtime-translate`                    | `gemini-3.5-live-translate-preview`                    | 兩者皆為截至本報告日最新「專用即時語音翻譯」模型                                             |
| 一般 Live／Realtime 最新模型 | `gpt-realtime-2.1`                          | `gemini-3.1-flash-live-preview`                        | 是 agent／對話模型，不應取代專用翻譯模型                                                     |
| 專案預設 model ID            | 正確                                        | 正確                                                   | Gemini 仍允許任意環境變數覆寫，未嚴格保證最新模型                                            |
| 協定／端點                   | 專用 Translation WebRTC／WebSocket 路徑正確 | 仍用 `v1alpha` constrained WS；官方現行參考是 `v1beta` | Gemini `v1alpha` 不是本次 1007 的直接根因，但不符合「務必最新」要求                          |
| 真實雲端狀態                 | upstream 直連成功；瀏覽器 E2E 未證          | 現行 app payload 失敗                                  | 目前只有 OpenAI 的上游協定路徑可視為可運作                                                   |
| 實作骨架                     | 完整度高                                    | 完整度高                                               | Gemini 有 resumption、GoAway、compression、backpressure、reconnect，但 setup P0 使其無法發揮 |
| production readiness         | 有條件可測，不可直接宣告長會議就緒          | 不可用                                                 | 兩者皆缺真實瀏覽器長會議與 p95/p99 證據                                                      |

### 1.1 最高優先問題

1. **P0 — Gemini Live Translate 現行 setup 會被服務端拒絕。**
2. **P0 — 字幕全文預設寫入 localStorage 與 IndexedDB，違反專案「預設只存記憶體」隱私規則。**
3. **P0 — 執行中切換 Online／Offline 模式只切 UI，原雲端 provider 可能繼續收音與計費。**
4. **P0 — Offline MT 飽和時在 ASR receive loop 等待，會把翻譯壓力反向傳回 sacred caption path。**
5. **P0/P1 — 內部 WhisperLive 服務綁 `0.0.0.0:9090` 且 WebSocket 無 token／origin 防護，LAN 可達。**
6. **P1 — Gemini 在 `setupComplete` 前開始送音訊，且 setup timeout 在 raw socket open 時就被清除。**
7. **P1 — 專案宣稱 Hybrid separate tracks／摘要能力，但目前沒有對等實作。**

## 2. 證據分級與限制

本報告不把不同強度的證據混為一談：

| 等級 | 證據                         | 可支持的結論                                          |
| ---- | ---------------------------- | ----------------------------------------------------- |
| A    | 官方現行 API／模型／價格文件 | 最新模型、schema、價格、session 規則                  |
| A    | 真實 upstream API 探針       | 當下帳號、區域與 payload 的實際成功／失敗及小樣本時序 |
| B    | 目前工作樹靜態追蹤           | 實際程式路徑、狀態機、錯誤處理與政策違規              |
| B    | 單元、型別、build、mock E2E  | 專案內部契約及模擬路徑沒有回歸                        |
| C    | 小樣本延遲 A/B（每條件 n=3） | 方向性比較；不能支持正式 p95、p99 或 SLA              |

限制：

- 雲端量測是 upstream 直連，不是從麥克風到瀏覽器 paint 的完整 E2E。
- 每條件只有 3 個成功樣本；沒有跨地區、跨時段、雙語向、噪音、多人、長句或重音統計。
- 沒有完成 30–60 分鐘真實硬體會議、4 小時 soak、斷網重連與長時間 RSS／heap 證據。
- E2E 多數走 mock provider；mock 通過不代表雲端 schema 仍相容。
- 診斷基準是 dirty working tree，不等同 HEAD 或可重現 release commit。

## 3. 兩個最新 Live／Realtime 模型查證

### 3.1 OpenAI

本專案的翻譯主路徑應使用 **`gpt-realtime-translate`**。官方明確區分：翻譯人類語音使用此模型；需要回答問題、工具呼叫與會話代理時才使用一般 Realtime 模型 `gpt-realtime-2.1`。

| 項目              | 官方現況                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| 模型              | `gpt-realtime-translate`                                                                   |
| 定位              | 串流 speech-to-speech 翻譯，輸入仍在進行時即輸出翻譯音訊與 transcript delta                |
| 端點              | `/v1/realtime/translations`；瀏覽器可透過 `/realtime/translations/client_secrets` + WebRTC |
| 模態              | 音訊輸入；音訊及文字輸出                                                                   |
| context／最大輸出 | 16,000／2,000 tokens                                                                       |
| 版本策略          | 目前只有 rolling alias，無日期 snapshot 可鎖                                               |
| 翻譯費用          | US$0.034／音訊分鐘                                                                         |
| 選配來源逐字稿    | `gpt-realtime-whisper`，US$0.017／分鐘                                                     |
| 專案雙語字幕推估  | US$0.051／分鐘（翻譯 + 來源逐字稿）                                                        |

專案目前正確使用 dedicated translation client secret 與 `/translations/calls`，也處理 `session.input_transcript.delta`、`session.output_transcript.delta`、`session.output_audio.delta`。這不是把一般文字模型包裝成「Realtime」。

### 3.2 Gemini

本專案的翻譯主路徑應使用 **`gemini-3.5-live-translate-preview`**。它是截至本報告日最新專用 Live Translation 模型；一般 `gemini-3.1-flash-live-preview` 是 Live agent／即時對話模型，不是同一產品契約。

| 項目       | 官方現況                                                               |
| ---------- | ---------------------------------------------------------------------- |
| 模型       | `gemini-3.5-live-translate-preview`                                    |
| 狀態       | Preview；最新更新 2026-06                                              |
| 定位       | 低延遲音訊到音訊即時翻譯                                               |
| 語言       | 70+，含 Traditional Chinese／`zh-Hant`                                 |
| 模態       | 音訊輸入；翻譯音訊與 transcript 輸出                                   |
| token 上限 | 輸入 131,072；輸出 65,536                                              |
| 費用       | 輸入約 US$0.0053／分鐘；輸出約 US$0.0315／分鐘；合計約 US$0.0368／分鐘 |
| session    | 無壓縮音訊 session 約 15 分鐘；單一連線約 10 分鐘                      |
| 長會議     | 必須使用 context window compression、session resumption 與 GoAway 處理 |

專案有實作 compression、resumption、GoAway、回壓與 reconnect，方向正確；但現行 setup payload 使連線在這些機制啟用前就失敗。應同時注意：即使 UI 丟棄 Gemini 產生的翻譯音訊，模型仍產生音訊，不能假設免除 output audio 費用。

## 4. 真實雲端測試

### 4.1 方法

- 兩邊 API key 均由系統環境提供；未輸出或寫入金鑰內容。
- 使用合成且不含敏感資訊的英文語音，長度 7.35 秒，偵測語音約 7.01 秒。
- 翻譯方向：英文 → 台灣繁體中文。
- 每個可運作條件 3 個成功樣本。
- 時間基準是探針觀察到的 speech onset 與 upstream frame，不是 DOM paint。
- 暫存音訊與探針產物已刪除，沒有修改專案程式碼。

### 4.2 延遲結果

| Provider／條件                               | Session ready 中位數 |       首個來源逐字稿 |         首個翻譯文字 |         首個翻譯音訊 |     語音結束後 drain |
| -------------------------------------------- | -------------------: | -------------------: | -------------------: | -------------------: | -------------------: |
| OpenAI WS，200 ms chunk                      |   922 ms（884–1351） |   978 ms（917–1033） |    852 ms（612–926） |    441 ms（283–446） |  1036 ms（821–1848） |
| Gemini v1beta，schema 可用，100 ms chunk     |    227 ms（162–294） | 3065 ms（2972–3186） | 3313 ms（3176–3395） | 3316 ms（3177–3396） | 1731 ms（1598–1849） |
| Gemini v1beta，schema 可用，專案 32 ms chunk |    185 ms（178–200） | 3746 ms（3681–3791） | 3927 ms（3918–4017） | 3928 ms（3919–4018） | 1743 ms（1649–1822） |

方向性觀察：

- 本次狹窄條件下，OpenAI 首個翻譯文字中位數比 Gemini 100 ms 約快 2.46 秒。
- Gemini 32 ms 比 100 ms 的首字慢約 614 ms；這推翻「chunk 越小一定越快」的假設，但 n=3 不足以直接規定 production chunk。
- Google 文件本身同時出現 20–40 ms、20–100 ms 與 Live Translate 100 ms 建議，因此正確行動是建立足量 A/B，不是憑單頁文件硬改。
- OpenAI 翻譯語意良好，但以 `zh` 測試時回傳簡體；專案靠 OpenCC `s2tw` 正規化成台灣繁體。
- Gemini 在可用 payload 下直接輸出繁體中文，語意良好。

### 4.3 Gemini 現行 app payload：3/3 失敗

目前 dedicated translate 分支把 transcription 欄位放在 `setup.generationConfig`：

```json
{
  "setup": {
    "generationConfig": {
      "inputAudioTranscription": {},
      "outputAudioTranscription": {},
      "translationConfig": { "targetLanguageCode": "zh-Hant" }
    }
  }
}
```

`v1alpha + BidiGenerateContentConstrained` 與 `v1beta + BidiGenerateContent` 均被 WebSocket 1007 關閉，核心錯誤一致：

```text
Invalid JSON payload received. Unknown name "inputAudioTranscription"
at 'setup.generation_config': Cannot find field.
```

把 `inputAudioTranscription` 與 `outputAudioTranscription` 移到 `setup` 頂層、僅保留 `translationConfig` 在 `generationConfig` 後，`v1alpha`／`v1beta`、raw key／ephemeral token 的 8 組握手矩陣全部可取得 `setupComplete`。因此：

- **唯一已證實的當前 1007 根因是 transcription 欄位位置。**
- `v1alpha` 雖然必須為「最新 API」要求遷移，但不是這次 1007 的充分原因。
- 未使用 `liveConnectConstraints` 不是這次握手失敗原因；專案註解另記載約束 token 曾觸發 1011，需先重新做相容矩陣，不能未驗證就硬鎖。
- 現行 Google raw WebSocket Live Translate 範例把兩欄放在 `generationConfig`，但 Live API schema、SDK 形狀與實際服務端使用 setup 頂層；這是已實測的官方文件／服務端矛盾。
- 壞 payload 是尚未提交工作樹回歸；HEAD 版本原本放在 setup 頂層。

## 5. 前次結論的嚴格修正

### 5.1 已推翻或降級

| 較早判斷                                                         | 最終裁決                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Gemini 失敗主因是 `v1alpha`                                      | **錯。** `v1alpha` + 正確欄位也成功；欄位位置才是本次唯一已證實根因           |
| 立即改成 `liveConnectConstraints` 即可                           | **證據不足。** 有安全收益，但必須先重測專案記錄過的 1011                      |
| Gemini chunk 必須改成 100 ms                                     | **降為待測。** n=3 指向 100 ms 較快，官方文件卻互相矛盾，需足量 A/B           |
| OpenAI client secret `expires_at=3600` 證明 session 可活 60 分鐘 | **類別錯誤。** client secret expiry 只限制建立 session；已建立 session 可繼續 |
| 因此應移除固定 25 分鐘 renewal                                   | **不可直接照做。** 不能拿 secret expiry 決定 session renewal                  |

### 5.2 OpenAI expiry 的精確裁決

官方有兩個不同欄位，不可混用：

1. translation client secret response 的頂層 `expires_at`：短效憑證失效時間，只限制建立新 session。
2. `session.created.session.expires_at`：該 translation session 的失效時間。

本輪 direct WS 看到的 session event 約為 3600 秒，可作為當次 session 的觀察值；但固定 25 分鐘 make-before-break 仍是保守而非明確錯誤。較穩健做法是：保留 renewal，優先讀 `session.created.session.expires_at`，扣除安全 margin；缺欄位時才回退到固定值，並以一小時以上真實 WebRTC 測試驗證。不可改成讀 client secret 的頂層 expiry。

## 6. 線上模型與服務詳細診斷

### P0／Release blocker

#### O-1 Gemini setup schema 回歸

- 證據：[gemini-live-provider.ts](../apps/web/src/providers/gemini-live-provider.ts) `402–426`。
- mock 測試目前反而斷言錯誤的巢狀 JSON，等於把回歸鎖成通過。
- 影響：latest Gemini model 在真實服務完全不可用，UI 宣稱的支援與實況不符。

#### O-2 模式切換不停止舊 provider

- `ModeSelector` 在 running 期間仍可直接 `setMode()`；settings store 只更新模式。
- `App` 依新模式隱藏舊 provider UI，但舊 provider 不一定 stop。
- 影響：雲端仍收音、傳送及計費，使用者卻看不到原連線狀態；同時是隱私與費用風險。

### P1／High

#### O-3 Gemini 未等 `setupComplete`

- `connect()` 在 raw `ws.onopen` 送 setup 後立即 resolve 並清除 15 秒 timeout。
- `start()` 隨即 `startAudioCapture()`；官方要求收到 `BidiGenerateContentSetupComplete` 後才送其他訊息。
- 若 socket 開啟但 setup 永遠不完成，start 可呈現 running、setup timeout 已失效、wedge detector 又尚未 armed。

#### O-4 音訊初始化失敗仍保留 running

- `AudioContext` 不可用或 `AudioWorklet` 例外時只發 degraded 後 return。
- provider 沒有轉 failed／stopped，UI 可能顯示已運作但沒有音訊上行。

#### O-5 Gemini stop 未送 `audioStreamEnd` 且未 drain

- `stop()` 直接 cleanup／close；沒有先送 `realtimeInput.audioStreamEnd`，也沒有等待 pending output。
- 影響：句尾翻譯或音訊可能遺失，並錯過官方支援的暫停／重開 stream 語意。

#### O-6 Gemini transcription 配對模型不安全

- 官方說 input／output transcription 獨立送達、沒有跨訊息順序保證。
- provider 以單一來源／目標 accumulator 與目前 utterance ID 配對，並靠標點／本地條件 finalize。
- 風險：快速語句、延遲 output 或 reconnect 邊界可能把兩句錯配；`lastInputLang` 在 finalize 後也未完整清理。

#### O-7 不嚴格保證最新 Gemini model

- `GEMINI_LIVE_MODEL` 是任意字串；註解仍推薦舊 native-audio fallback。
- provider 依 model 名稱 regex 決定 dedicated translation 或 system instruction fallback。
- 影響：部署可在無明確警告下偏離使用者要求的最新 Live Translate；fallback 不是等價能力。

#### O-8 health／release 腳本把 Gemini 當次等路徑

- `/healthz` 只看 `OPENAI_API_KEY` 與 OpenAI reachability；Gemini-only 部署會回不健康。
- `start.bat`／`start.sh` 硬性要求 OpenAI key；即使只選 Gemini 也無法啟動 release。

#### O-9 OpenAI transcript segmentation／alignment 證據不足

- Translation API 是連續 append-only delta；專案另監聽未列於正式 Translation server event 的 completion event，並以 1 秒 inactivity／12 秒最大長度自行斷句。
- event type 已包含 `elapsed_ms` 對齊 metadata，但專案未充分利用。
- 風險：來源／翻譯 arrival order 與本地 timeout 邊界可造成切句及配對偏移。

#### O-10 OpenAI renewal 策略過度硬編碼

- 固定 25 分鐘 make-before-break 是安全保守值，不能直接刪除。
- 但官方 Translation session event 已提供 `session.expires_at`；目前未根據實際 session deadline 調整。
- 正確改善：使用 session event expiry + margin，保留固定 fallback，再做長會議實測。

#### O-11 音源 metadata 失真

- OpenAI／Gemini normalized event 多處硬編 `source: 'microphone'`。
- 專案實際可用 DisplayMedia／browser tab／system audio；contracts 也支援相應 source。
- 影響：匯出、診斷、統計與 downstream 行為無法辨認真實來源。

#### O-12 執行中切 scenario 只有 OpenAI 自動重啟

- 設定狀態可直接變更 scenario／audio source。
- OpenAI 有重啟處理；Gemini、Offline、Hybrid 可能仍用舊 capture，UI 卻顯示新來源。

### P2／Medium

#### O-13 UI 延遲宣稱不可稽核

- `SettingsPanel` 顯示 Gemini「約落後 2–3 秒」。repo 沒有對應正式 latency artifact；現行 app 又在 setup 失敗。
- 本輪可用 schema 的直連結果是首字約 3.18–4.02 秒區間，仍不能直接換成 UI SLA。

#### O-14 latency monitor 不能作正式 provider benchmark

- 量的是 event arrival proxy，不是聲音 onset → DOM paint。
- `recordHealth()` 沒清空 `samples`，會跨 session 汙染。
- persistence 每 15 秒 append，同一 session 沒有 replace，單場可擠掉全部 50 筆歷史。
- output 比 input 先到時可產生 0 lag；目前沒有 repository latency artifact。

#### O-15 normalized event 只靠 TypeScript cast

- Provider raw JSON 經 `JSON.parse` 後多以型別斷言處理；contracts 沒有 runtime schema 驗證。
- conformance 測試主要驗 fixtures，無法攔截 upstream 欄位漂移；Gemini 本次就是具體反例。

#### O-16 Hybrid Online MT 不是第二個 Realtime 模型

- Hybrid 的 `gpt-4.1-mini` `/translate` 是文字 request／response 路徑，不是 speech streaming。
- 不應把它列為符合「兩邊都要 realtime/live」的模型支援；失敗目前偏靜默，晚回結果也可能寫入新 session。

## 7. 前端、音源與契約診斷

### P0／P1

#### F-1 字幕預設持久化違反隱私規則

- `use-caption-store.ts` 以無參數 `createCaptionStore()` 建立全域 store。
- 預設 `persistKey` 是 `meeting-audio:captions:v4`，會同步 localStorage tail 並非同步保存 IndexedDB 全量。
- page hide／visibility hidden／Stop／Pause 會主動 flush。
- 這是全模式預設，不只 Offline；使用者沒有明示 opt-in。
- 直接違反 `CLAUDE.md` 的「Default retention: in-memory only」及不得靜默持久化要求。

#### F-2 Hybrid Meeting 的 separate tracks 宣稱不實

- settings／文件描述 remote + mic separate tracks 已啟用。
- 實際 scenario 只選單一 audio source，coalescer 也只有單一路徑，沒有雙軌同步與來源標記。
- UI／文件不得把規劃中的能力呈現為已支援。

#### F-3 Summary 能力仍非完成狀態

- P5 summary draft／refined／stable pipeline 尚未完整交付。
- 會議模式文字若宣稱已可做 summary，與專案狀態不一致。

### P2

- caption store 有 bounded segment、live/final 分離、coalescing 等正向設計，但同步 JSON stringify／localStorage write 仍可能在長歷史下阻塞 UI；這同時強化「預設不持久化」的必要性。
- resume／continue 可能先把 store phase 設為 running，再等待 provider 成功，造成狀態與真實 capture 不一致。
- `online-slim` 仍可能經 `useHybridMode` 帶入 offline 路徑；bundle guard 與 Gemini 必須包含 `pcm-worklet.js` 的需求要一併驗證。
- DisplayMedia provider 對無音軌、ended 與清理已有防護，是正向證據。

## 8. Offline、隱私與安全診斷

### P0／P1

#### S-1 MT 飽和會阻塞字幕接收

- `services/offline/app/pipeline/asr.py` 在 pending translation 達 10 時，直接在 ASR recv loop 內 `await asyncio.wait(FIRST_COMPLETED)`。
- 可重現：送入 12 筆時，已 consume 11、pending 10、recv loop 尚未完成。
- 每筆 translation 有約 5 秒 timeout，限制了單次阻塞上界，但 executor thread 不一定因 wait timeout 真正停止。
- source caption 在未飽和前會先送出，這是正向設計；飽和時仍違反「translation 不得阻塞 caption path」。

#### S-2 Stop／disconnect 不會 drain 或 cancel pending translation

- ASR finally 送 sentinel，但沒有等待、取消或隔離晚回 MT task。
- 可出現 consumer 先收到結束，translation 在其後才完成；可能遺失尾句或形成 orphan work。

#### S-3 WhisperLive 服務對 LAN 曝露

- `services/offline/run_whl.py` 綁 `0.0.0.0:9090`；該 socket 是內部 WhisperLive，不是 FastAPI browser WS。
- FastAPI `/ws` 本身接受連線時沒有 token／origin／初始 schema 認證；HTTP CORS 不保護 WebSocket。
- release／開發指令另有把 FastAPI 綁 `0.0.0.0:8000` 的情形，必須明確區分本機與 LAN 模式。

#### S-4 Full Offline UI 只檢查 Whisper，未檢查 MT readiness

- MT 模型不存在或初始化失敗時，字幕仍可能啟動但翻譯靜默消失。
- health response 對語向與模型能力描述不完整，UI 沒有對使用者顯示清楚失敗狀態。

### P2

#### S-5 Offline model 可重現性不足

- 實際套件是 Collabora `whisper-live>=0.8.0`，不是文件反覆寫的 WhisperLiveKit。
- 程式確實採 VAD + rolling buffer／streaming policy，**沒有**違反「naive Whisper chunking」禁令。
- `snapshot_download` 依 mutable model 名稱，未鎖 revision／`local_files_only`；所謂 Full Offline 啟動仍可能查詢 Hugging Face metadata。

#### S-6 Stabilizer 與長會議記憶體風險

- stabilizer 依已輸出字元長度截掉 revision，可能丟失 ASR 修訂內容；既有測試甚至接受這種 loss。
- `_slices` 未持續 prune，長會議有成長風險；尚無 4 小時實測證據。

#### S-7 Unix／開發啟動路徑不一致

- Unix release script 使用不可執行的 `python -m whisper_live.server` 路徑；`pyaudiowpatch` 又是 Windows 專用。
- root `dev:full` 使用普通 `python`，違反本 workspace 指定 runtime，並把 FastAPI 綁到 `0.0.0.0`。
- Unix script 缺完整 process trap／清理，可能留下背景程序。

#### S-8 敏感內容可能進入 log

- 部分錯誤處理會記錄 transcript snippet、raw provider payload 或 upstream response body。
- 本輪 secret scan 未發現真實 API key 被提交或進 browser bundle；測試只有明顯 fake key。API key server-side boundary 整體正確。

## 9. 相依套件、build、格式與文件狀態

### 9.1 供應鏈

`pnpm audit --prod`：**7 high、1 moderate**。涉及：

- `form-data 4.0.5`
- `brace-expansion 5.0.6`（多筆 advisory）
- `fast-uri 3.1.2`（多筆 advisory）
- `find-my-way 9.6.0`
- `@fastify/static 9.1.3`（含授權繞過風險）

這些不是「測試有過」就可忽略；應確認 patched version、lockfile 影響與 Fastify 相容性後升級。

### 9.2 Build／lint／format

- build 通過。
- Vite 主 JS chunk 約 769.92 kB、gzip 約 580.91 kB，超過 500 kB warning；需確認 online-only bundle 是否夾帶 Offline／Hybrid 重依賴。
- lint exit 0，但有 3 個 warning。
- explicit format check 找到 91 個不符合檔案；root script 還因掃描 `apps/web/.pytest_cache` 遇到 EPERM。
- 指定 Python runtime 未安裝 `ruff`，所以不能宣稱 Python lint 已通過。

### 9.3 文件與狀態治理

- `ARCHITECTURE.md`、`ONLINE_OFFLINE_MODES.md`、`PROVIDER_BACKENDS.md`、`TODO.md`、`RUNBOOK.md` 存在舊模型、舊 retry、P2/P3 未實作與已實作狀態互相矛盾。
- P5 summary、P6 長會議可靠性、P7 Electron 仍未完成，專案不應標成整體 production-ready。
- `TEST_PLAN.md` 有未勾選或過時項目；真正仍缺的是 real cloud contract、MT saturation nonblocking、pending drain、MT unavailable UI、WS origin/LAN、opt-in retention、stabilizer/RSS soak、artifact secret CI。
- 中國來源 core model／cloud provider 掃描只命中文件禁令，未發現 Qwen、DeepSeek、GLM、FunASR、SenseVoice、百度、騰訊、科大訊飛、阿里雲實作。

## 10. 驗證矩陣

### 10.1 前次完整驗證

| 驗證            |                結果 | 解讀                                   |
| --------------- | ------------------: | -------------------------------------- |
| `pnpm test`     | 350 JS tests passed | contracts 19、web 283、online 48       |
| `pnpm test:e2e` |           29 passed | Playwright mock-backed；不等於真實雲端 |
| Offline pytest  |           64 passed | 使用指定 Miniforge runtime             |
| build           |              passed | 有大 chunk warning                     |
| lint            |              exit 0 | 3 warnings                             |
| typecheck       |              passed | 三個 JS workspace                      |

### 10.2 本次針對性重驗

| 驗證                                                                 |                     結果 |
| -------------------------------------------------------------------- | -----------------------: |
| OpenAI provider + Gemini provider + latency monitor + field recorder | 4 files／69 tests passed |
| Online service                                                       | 5 files／48 tests passed |
| `pnpm typecheck`                                                     |                 全部通過 |

Online 測試過程仍出現 `MaxListenersExceededWarning: 11 exit listeners`；測試綠燈不代表 listener lifecycle 沒問題。

### 10.3 真實 API 驗證

| 項目                                 | 結果                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| OpenAI current dedicated translation | 成功；3 個完整音訊樣本                                       |
| Gemini current app setup             | 失敗；3/3 close 1007                                         |
| Gemini corrected setup               | 成功；v1alpha／v1beta、raw／ephemeral 矩陣皆可 setupComplete |
| Gemini corrected audio translation   | 成功；100 ms 與 32 ms 各 3 個完整樣本                        |

## 11. 已證實與尚未證實

### 已證實

- 兩個應選模型都是截至 2026-07-28 最新的專用 Realtime／Live 翻譯模型。
- OpenAI 使用的模型、端點與事件架構是真 Realtime，且 upstream 直連可用；這仍不是完整瀏覽器 E2E 證明。
- Gemini 專案有真正 Live 音訊架構，但 current working tree payload 無法通過 setup。
- Gemini 的 1007 根因是 transcription 欄位位置，不是 `v1alpha` 本身。
- 預設字幕持久化、模式切換、MT 飽和阻塞與 LAN bind 都是目前程式碼中的真實問題。
- mock／unit suite 很廣，但沒攔住 Gemini upstream schema 回歸。

### 尚未證實

- 任一 provider 的真實瀏覽器 speech-to-paint p50／p95／p99。
- 30、60、120 分鐘會議中無縫 renewal／resumption 與不漏字幕。
- 雙語向、多人、噪音、快速切語、系統音源與不同瀏覽器下的相對延遲及準確率。
- OpenAI 固定 25 分鐘 renewal 是否是最佳值；只能說安全保守，應改由 session expiry 驅動並實測。
- Gemini 32 ms 或 100 ms 的 production 最佳 chunk。
- `liveConnectConstraints` 在目前 API 是否仍會重現專案記錄的 1011。
- Full Offline 在完全斷網、無 Hugging Face cache metadata 查詢時能否冷啟動。

## 12. 修復優先序

|  序 | 動作                                                                        | 驗收證據                                                                       |
| --: | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
|   1 | Gemini transcription 欄位還原到 setup 頂層；同步改 mock fixture             | raw WS／ephemeral 真實 smoke 均收到 `setupComplete` 與翻譯 delta               |
|   2 | Gemini connect 必須等 `setupComplete`；保留 setup timeout                   | 永不 setup、1007、1011、timeout 都能轉 failed，不留 running 假狀態             |
|   3 | 執行中 mode／scenario／backend 切換統一 stop 或原子 handoff                 | 舊 provider 零殘留收音、連線、計費；UI 狀態一致                                |
|   4 | 全模式字幕持久化預設關閉，改明示 opt-in                                     | 首次使用不建立 LS／IDB；opt-in、export、clear、reload 有測試                   |
|   5 | Offline MT queue 與 caption recv loop 完全解耦                              | MT 卡住 30 秒時 source caption 仍持續，bounded queue 有可見 drop/degraded 狀態 |
|   6 | pending MT 在 stop／disconnect 時有明確 drain/cancel/session fence          | 不遺失尾句、不把舊結果寫進新 session                                           |
|   7 | WhisperLive／FastAPI 預設只綁 loopback；LAN 模式加明示設定與 WS auth/origin | 從 LAN 無法連預設服務；授權及 origin 負向測試                                  |
|   8 | `/healthz` 與 release scripts 支援 OpenAI-only、Gemini-only、both           | 三種配置各自能正確啟動與回報健康                                               |
|   9 | Gemini 遷移 `v1beta` 並重測 constrained token                               | 真實 1011／1007 矩陣；安全限制不破壞 setup                                     |
|  10 | 強制 production model allowlist，只允許最新 dedicated translate             | 舊／任意 model 啟動即清楚失敗，不靜默 fallback                                 |
|  11 | OpenAI 使用 `session.created.session.expires_at` + margin renewal           | 60–120 分鐘 WebRTC 不斷字幕；client secret expiry 不被誤用                     |
|  12 | 重做可稽核 latency pipeline                                                 | speech marker → normalized event → DOM paint；原始 JSONL 與 p50/p95/p99 入檔   |
|  13 | 音源 metadata、Hybrid capability、Summary 文案與實作對齊                    | mic／tab／system／separate tracks 契約測試；未實作功能不顯示已支援             |
|  14 | 升級 production vulnerabilities，修 format／EPERM／ruff                     | audit 無 high；lint、format、ruff 可重現通過                                   |
|  15 | 長會議與故障注入                                                            | 4h soak、斷網、GoAway、token expiry、音訊裝置失效、heap/RSS bounded            |

## 13. 最終 release gate

要符合「兩邊都用最新、都是真 Realtime／Live」的要求，至少必須同時滿足：

1. OpenAI 鎖定 `gpt-realtime-translate`，Gemini 鎖定 `gemini-3.5-live-translate-preview`；禁止靜默降級到一般文字或舊 native-audio 模型。
2. 兩個 provider 都有每日或 release 前的真實 upstream contract smoke；mock 只作快速回歸。
3. 完整瀏覽器 E2E 量測 speech onset → caption paint，公開樣本數、地區、語向、音源與 p50/p95/p99。
4. 30–60 分鐘以上真實會議可無縫 renewal／resumption，且 source／translation 不錯配、不漏尾句。
5. 模式／scenario／provider 切換不殘留收音或付費連線。
6. caption path 在 MT、summary、storage、model loading、動畫、網路故障時仍不被阻塞。
7. 預設不持久化逐字稿；LAN／WebSocket 預設不暴露；API key 不進 browser／log／artifact。
8. UI 只宣稱已被真實測試支持的能力與延遲，不把 Preview、mock 或計畫項目呈現為完成。

## 14. 官方來源

### OpenAI

- [Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)
- [`gpt-realtime-translate` model](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Realtime Translation client secret](https://developers.openai.com/api/reference/resources/realtime/subresources/translations/subresources/client_secrets/methods/create)
- [Translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)
- [Audio pricing](https://developers.openai.com/api/docs/pricing#audio-tokens)

### Google Gemini

- [Live Translation guide](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
- [`gemini-3.5-live-translate-preview` model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview)
- [Live API WebSocket schema](https://ai.google.dev/api/live)
- [Live API session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## 15. 報告完整性聲明

- 本報告保留前次結果，但以本次更強的正交握手矩陣、真實音訊測試與官方現行 schema 覆蓋較早推測。
- 沒有把通過的 mock 測試當成 upstream 可用證明，也沒有把 n=3 延遲當成 SLA。
- 沒有把 `gpt-4.1-mini` 文字 MT、一般 Realtime agent 或 native-audio fallback 計入「兩個最新 Realtime／Live 翻譯模型」。
- 沒有因 dirty working tree 而把未提交回歸歸咎於 HEAD；Gemini setup 故障明確標示為目前工作樹狀態。
- 報告不含 API key、真實會議音訊或敏感逐字稿。
