# 純字幕與完整逐字稿執行紀錄

使用者已指示開始完成 1/2/3/4；規劃文件的「本輪不實作」是前輪限制，已被最新指示取代。服務可在施工時停止。

## 基準與決策

- managed instance `f0f74d63-64d5-48ea-bfbc-920e95aeee87` 已經 service:status 確認後由 service:stop 停止。沒有依埠號殺程序。
- 分支 `docs/goal-phase-2` 已有大量未提交成果。Ruling：在既有非 main 工作分支局部修改，將 194 個相關檔案雜湊及原檔保存至 `.cache/mixed-captions-baseline-20261008`；不建立會遺漏未提交成果的 HEAD-only worktree，不 stash、不自動 commit。
- 基準 `pnpm exec vitest run --config tests/unit/web-regression.config.ts`：38 files、545 tests 全過。
- Windows shell 呼叫保持整個團隊同時最多一個；子代理使用 shell 時主代理不啟動 shell。
- Ruling：A0 帳號真測與真人語料尚缺時，可完成不依賴未知 API 行為的契約、地端保存及本機測試；候選模型仍標未實證，不把 mock 當完成。

## 狀態

- A0：24 份情境稿＋可驗證音檔雜湊的離線評分工具已建；8 項評分測試通過。真人參考語料／付費預算未回答，沒有真實品質分數。
- A1–A6：已實作並定向驗證。UI 採 PureCaptionWorkspace + TranscriptionSession，保留原 TranslationApp；復用既有 MeetingRecovery 和音源租約，不讓純字幕掛載翻譯 token 預熱。快照 v5 包含 purpose/provenance，舊格式按 legacy translation 遷移。
- A3 擴充：後續使用者明確要求 Gemini/OpenAI 皆完成；加入專用 Gemini 純轉寫 adapter，而非拿翻譯或互動模型冒充。OpenAI 保留 primary/audio 兩把 server-only key，明確 auth/IP 拒絕可 TTL demotion，opaque pre-ready 1006 只做一次備援探測；429 不觸發換 key。
- A7：兩家 Chrome 原生 AudioContext/Worklet、Silero、SQLite、重載、校訂、匯出及各 60 分鐘長測已通過；上游是受控 WS 事件。字型 CDN 連外被新增驗收抓出後移除，使用本機系統字型。真服務 gate 仍未完成。
- B1–B4：SQLite FULL 同步 worker、IDB strict outbox、receipt 冪等、writer lease、revision、人工作成修訂、原始／校訂 TXT/JSON/SRT 已實作。實際 SQLite 超過 20,000 段、ACK/crash/replay、lock、backup/restore、migration 拒寫測試通過。尚需真實混語聯合驗收。

## Fresh review 修復

- 定期續接的 Stop 原會等待新的連線完成：RED 重現後改為立即停止當前 provider。
- 音源失敗後的第二個 transport failure 原會覆蓋等待人工授權狀態：失敗即撤銷 provider generation，RED/GREEN 已驗證。
- 曾成功收音的分頁失去寫入租約時，仍保留字幕於 durable outbox，僅 HTTP 等待明確重新取權；初次被拒絕的第二分頁不開始收音。
- `manifest.saved` 表示持久交付完成，不表示沒有缺口；UI 獨立顯示 gaps/unfinished，不能因 ACK 成功隱藏不完整內容。
- 停止尾音 flush、lease renew token 保留、SRT epoch 相對時間、worker deadline/recovery、衍生匯出更新競態與診斷 log 皆有具體修復／定向測試。
- 一分鐘雙雲端受控測試揭露「保存校訂」與立即匯出競態：校訂尚在取得 lease、尚未 enqueue，匯出已先讀舊 DB。新增同一 turn 呼叫的失敗測試後，匯出等待 correctionChain；20 項 client tests 與兩家一分鐘 native 整合測試皆通過。E2E 另改為等待 editor 關閉，避免把 textarea value 誤當持久化證據。

## 2026-10-08 最終回歸進度

- `pnpm typecheck`、`pnpm lint` 通過。
- web/contracts `web-regression.config.ts`：51 files / 656 tests 通過。
- online `--dir src`：13 files / 137 tests；`--dir scripts`：2 files / 12 tests 通過；加總回歸 819 項。
- managed-service：6 tests；混語評分工具：8 tests 通過。
- 原生 Chrome 上游受控測試：兩家各一分鐘連續 PCM／VAD／SQLite／停止／重載／校訂／匯出通過。OpenAI 另有 renderer crash＋commit 後丟 HTTP receipt＋IDB replay 證据，未重複存入已提交片段。
- 預設 web Vitest 曾遇既有 `.pytest_cache` `EPERM scandir`；沒有刪快取或調整權限，採明確 source 範圍與既有 regression config 執行，測試斷言未放寬。
- 13:57–14:57 兩家各 60 分鐘、同時使用獨立 port 0 服務的原生 Chrome 長測通過；每家 240 次觀測。OpenAI 三條連線、302 段；Gemini 八條連線、301 段。JS heap 峰值分別約 51.6／66.2 MiB（非整個瀏覽器記憶體）。
- 從實際 SQLite 與衍生 JSON/TXT 逐段比對：每個原始回合恰好一次、原稿保留、人工校訂投影一致、時序一致、pending=0、未完成回合為空。續接保守標示 OpenAI 2／Gemini 7 個未補回的推估缺口，仍需人工核對，並非無漏音保證。
- 再跑一般 Chrome 流程：兩家皆通過；包含 OpenAI renderer crash／遺失 receipt、360px／1280px 無橫向溢出、鍵盤進入全螢幕。報告：[本機驗證數據](../../evals/2026-10-08-local-verification.json)。
- 一般 online build 原未產生 worker，且直接 Node ESM start 遇 contracts TS source resolution 錯誤；改為 typecheck/build 後使用既有 server.bundle.cjs，worker 隨 bundle 產出。以實際建置產物、隔離可用埠與 SQLite bootstrap 驗證成功。
- 最後部署探測抓出 HTTP 415 被錯分成 503：PowerShell 預設表單格式不能拿來判定 SQLite 故障。新增 RED/GREEN 測試，保留 415 與安全錯誤碼；正式 JSON bootstrap 成功。不將先前失敗歸因為已證實的儲存權限問題。
- 最終 managed instance `8526191a-9ce4-4b5b-b51d-7651eb69423c`，PID 39972，URL `http://127.0.0.1:43871`，build `5525eb2e07c6ed43f9e9e51aeaf6335882082372472a36ac4c8075d5fa282df3`。重複 start 確認 reused；healthz、SQLite bootstrap、415 皆實測通過；Gemini/OpenAI 及主備兩把 key 已配置，雲端 verified 仍為 false。
- 正式資料根目錄 `C:\Users\zerou\AppData\Local\MeetingAudio` 在工作區外，因此以自動審核允許的權限啟動及驗證；沙箱內不可存取該程序的 named pipe，未降低 pipe 的存取保護。一般使用者終端沿用 service:start/status/stop。
- 最後以 Chrome 開啟上述正式 instance：純字幕頁面與兩家選項正常、archive bootstrap 200、三個 VAD 模型／WASM 資產皆 200，無頁面錯誤及雲端呼叫。另僅比對布林結果確認兩把 OpenAI key 非同一值，沒有輸出憑證。

## 尚待明確決定

- 真 API 合計 US$1 已由後續「執行真實測試」授權；真人混語音檔／人工稿仍待提供，先用自行合成音訊。
- 原始錄音是否留存。目前只保存文字、修訂及已知缺口；未默認錄音。
- 「內網／外網 KEY」暫沿用既有同一官方 endpoint 的 primary/audio 配置；是否另有內網 proxy URL 尚待回答，不猜位址、不送憑證到未知主機。

付費測試、錄音留存及真實語料回答到達後，在此及 eval 報告更新；未回答不代表核准。

## 2026-10-08 真實 API 後續

- 使用者「執行真實測試」授權後，以本機 SAPI 合成混語音訊實際呼叫 OpenAI primary／audio 與 Gemini；不使用私人錄音，不 mock 雲端。
- 抓出並修正 Gemini REST 欄位、模型前綴、跨段 generation 尚未完成即送下一段造成漏句。保留兩輪漏句結果；修正後同 WAV 完整 6 段，結案／重載／TXT 通過。
- OpenAI primary 實際 5 段；audio 備用槽 6 段且完整結案。兩把 key 是強制槽位驗證，未宣稱實際內外網自動切換。
- 本輪回歸 web/contracts 659、online src 137、Gemini Chrome 端到端 1；typecheck／lint 通過。真雲端文字、重載與匯出另以斷言逐段核對。
- 詳見 [真雲端結果與限制](../../evals/2026-10-08-real-cloud.md)。真人品質、真雲端長測仍未驗收。
- 真測修正版已重新部署：instance `c81b0456-4557-4170-81b9-55164d1b17e7`，build `3d0c4f58b123c9f1053f180c734fbb50ea26f2c81e9d6ba9de92834de41ff06c`，URL `http://127.0.0.1:43871`。Chrome／SQLite bootstrap／VAD 資產通過，重複 start 同實例 reused；此為目前版本，取代上方先前部署紀錄。
