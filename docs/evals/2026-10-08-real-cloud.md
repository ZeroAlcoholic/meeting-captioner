# 真實雲端整合測試 — 2026-10-08

使用者回覆「執行真實測試」後，沿用累計 US$1 上限。使用原生 Chrome、實際 broker、正式 WebSocket、Silero VAD、PCM worklet、IndexedDB 與 SQLite；只替換麥克風來源為自行製作的 WAV，沒有 mock 雲端回應。測試服務使用 loopback port 0 與獨立 `.cache` 資料目錄。

## 結果與限制

| 路徑                | 真實結果                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI primary      | 憑證 200、實際轉寫 5 段，繁體顯示、重載與 TXT 一致。首輪測試過早重載，未取得結案完成的直接證據。                                     |
| OpenAI audio 備用槽 | 憑證 200、實際轉寫 6 段，已結案保存、pending 0、重載与 TXT 一致。                                                                    |
| Gemini 修正前       | 真實 400 暴露 REST 欄位錯誤；修正後 200 暴露模型名稱前綴不一致。握手成功後兩輪均漏掉金額／重複詞，系統標示已知缺口，未假裝完整結案。 |
| Gemini 修正後       | 憑證 200、setupComplete、實際轉寫 6 段；金額／否定／重複詞／最後一句皆保留，已結案保存、pending 0、重載與 TXT 一致。                 |

備用槽透過既有 retry 參數強制選用，沒有偽造主金鑰失敗。這證明兩把 key 在目前網路均可轉寫，**尚未證明實體內外網切換、自動 fallback 在不同網路的行為**。未提供內網 proxy，憑證只送既定官方 endpoint。

這是 23.605 秒合成混語的真雲端整合證據，不是台灣真人口音、多人重疊、噪音環境或長會議的準確率驗收；不產生真人 CER/WER 分數，也不宣稱完美逐字稿。

## 實際修復

1. Gemini AuthToken REST 改用 `bidiGenerateContentSetup`，保留固定模型、TEXT、VERBATIM、自動語言與 manual VAD 限制。[官方 wire reference](https://ai.google.dev/api/live.md) 與 Live Transcribe 指南 REST 範例有落差；以實際 400、wire reference 及修正後 200 交叉確認。
2. 前端允許同一固定模型的 bare 名稱與 `models/` resource 名稱；其他模型仍拒絕。
3. 真實事件顯示下一個 activityStart 在前一段 generationComplete 前發出時，會合併或漏掉整段。改為持續收音、有限暫存下一段，等 generationComplete 再依序送出；最多 256 個輸入訊息，滿載明確報告音訊缺口，不默默丟棄。使用同一 WAV 重測後由 4 段變為完整 6 段。這項判斷是本次重現與修正對照，不推定所有 Gemini 情境皆相同。

新增前綴契約、跨段順序與暫存上限回歸測試。Chrome 受控測試改用 broker 真實模型名稱及 generationComplete 事件，修正先前 mock 與真實契約落差。

## 音訊與成本紀錄

- 音訊：`.cache/real-cloud-synthetic.wav`，Windows SAPI Microsoft Hanhan Desktop（台灣中文）及 Zira Desktop（美式英文），本機合成，無私人會議內容。
- SHA256：`623a8d0c04f92c4d4d65eb43269c934b98464d8d20747058c88393a6550d8279`。
- 文稿：今天討論會議逐字稿。請保留英文術語。API, budget, OpenAI, Gemini. 今天不要部署。預算是三十美元，不是三百美元。確認，確認。最後一句，明天下午三點再測試。
- 有送音訊的雲端測試：OpenAI 2 輪、Gemini 3 輪，各 23.605 秒；另有未送音訊的憑證／契約失敗探測。
- 依官方每分鐘估算，合計音訊費用約 US$0.024；**不是帳單實扣金額**，未取得帳務 usage 核對。每輪預留 US$0.20，未送音訊輪次解除預留；累計有效預留 US$1.00，未再開新付費測試。
- 每輪 90 秒硬期限、至多兩次 mint，合成檔只播一次。保留所有失敗輪次，不以最後成功覆蓋失敗證據。
- 脫敏結果：[JSON](2026-10-08-real-cloud.json)。本機重現腳本 `.cache/real-cloud-test.mjs`，預算紀錄 `.cache/real-cloud-budget.json`；預算已預留完畢，直接重跑會拒絕。

尚待：授權真人混語錄音及人工逐字稿、實際網路切換、真雲端長測與多人／噪音品質評測。

## 最終回歸與日常服務

web/contracts 659 項、online src 137 項通過；Gemini 原生 Chrome 受控端到端 1 項通過，涵蓋停止、重載、校訂及匯出。typecheck、lint、變更程式格式檢查通過；已重新檢視最終 provider、broker 與斷句佇列的清理／上限。

修正版 managed service：`http://127.0.0.1:43871`，instance `c81b0456-4557-4170-81b9-55164d1b17e7`，build `3d0c4f58b123c9f1053f180c734fbb50ea26f2c81e9d6ba9de92834de41ff06c`。實際 Chrome 顯示、SQLite bootstrap 與三個 VAD 資產正常；重複 start 回報同 instance、`reused:true`。此部署檢查未再呼叫雲端，真雲端測試在同程式碼的隔離資料服務執行。
