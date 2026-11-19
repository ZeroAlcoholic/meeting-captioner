# 混語字幕驗收基準（2026-10-08）

狀態：建立基準中；尚無真實音訊品質結果，不能宣稱辨識門檻已通過。

## 固定的品質目標

- 中文 CER ≤ 10%；英文 WER ≤ 15%；關鍵詞保留率 ≥ 95%。
- 首個可讀片段延遲 p95 ≤ 2 秒；發話結束至 final p95 ≤ 3 秒。
- 否定、數字、金額、日期、版本、責任歸屬錯誤逐例列出，不被平均值掩蓋。
- 靜音不得捏造發言；不同回合的有效重複不得因文字相同被刪除。
- 語料分 calibration 與 holdout，holdout 不用於調整 prompt。

目前 `tests/fixtures/mixed-caption/cases.json` 是 24 個待錄製情境與朗讀稿，**不是已取得的 gold recordings**。取得可用錄音後建立 manifest，記錄 audioPath、sha256、durationMs、人工校對 reference、scenario、criticalTerms 與 split。朗讀稿不能取代對實際錄音的人工校對。合成語音若使用，獨立標示 synthetic，不計入真人／多人驗收。

## 模型與協定

OpenAI 評測候選 `gpt-live-transcribe`，使用專用 transcription session；繁中＋英文提示、保留原文。實作採單一路徑 WebSocket：讓 PCM append 與 client VAD commit 在同一有序通道，避免跨 RTP／data channel 的尾段競態；這是工程選擇，尚非真帳號握手證據。官方指南要求客戶端斷句 commit，不支援 server/semantic VAD；事件以 item_id／previous_item_id 對齊。文件與 API reference 對 languages/delay 有描述不同步，必須實際確認帳號接受欄位。[官方指南](https://developers.openai.com/api/docs/guides/realtime-transcription)

依後續使用者要求也納入 Gemini `gemini-3.5-transcribe-live`：TEXT、VERBATIM、languageCodes=[] 自動混語辨識，manual VAD activityStart/End。不用 SMART，以免刪除重複、語助詞或更正原句。官方標示單 session 最長 10 分鐘，實作 8 分鐘更新；目前更新缺口如實留存，不宣稱零損失。兩家各自驗收，不能用一家成績代替另一家。[Gemini 官方指南](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)

價格查核為 US$0.017／音訊分鐘；5 分鐘約 US$0.085。試驗的音訊時間、重試與花費須逐次累積，不能只限制單次呼叫。[官方價格](https://developers.openai.com/api/docs/pricing)

Gemini 官方估算 Live Transcribe 混合輸入／輸出費用約 US$0.009／分鐘；實際按 token 計費。兩家各 5 分鐘估算合計 US$0.13，仍須連重試計入使用者批准的總額。[Gemini 官方價格](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-transcribe-live)

離線評分工具與格式見 [使用方式](mixed-caption-eval-usage.md)，8 項自我測試已通過。未提供真實語料時，不產生虛構分數。

## 本轮測試授權與證據

- 使用者於 2026-10-08 回覆「執行真實測試」，沿用已提出的累計 US$1 上限；先以本機 SAPI 合成音訊執行真雲端整合，不計入真人品質驗收。
- 已詢問真實混語錄音路徑及原文校對資料；一般 repository 檔案清單尚未找到。
- 已詢問首版錄音留存政策；未確認前不默認持久化錄音。
- 原有 web/contracts 基準：38 files／545 tests passed；僅本機邏輯回歸，不是混語辨識證據。

每次實驗需紀錄模型、session 配置、音訊雜湊、環境、原始事件（移除 token）、各項分數、關鍵錯誤、延遲、時數及估算費用。不可記錄長效憑證。
