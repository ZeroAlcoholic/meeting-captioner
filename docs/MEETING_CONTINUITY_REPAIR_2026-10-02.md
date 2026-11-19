# 會議接續修復：本機驗收紀錄

日期：2026-10-02。範圍：R1–R5 線上恢復修復；地端保存／補錄與真實服務驗收分開追蹤。
原始診斷保留於 [診斷報告](MEETING_CONTINUITY_DIAGNOSIS_2026-10-02.md)，
正式工作清單見 [執行計畫](superpowers/plans/2026-10-02-meeting-continuity.md)。

**任務重新開啟，未宣稱整體完工**：前輪 507／90／26 通過漏掉原生音訊路徑。
追加修復與打包驗證已通過；使用者實際啟動版本及真實雲端驗證仍未完成。

## 量測工具校準與效能對照（2026-10-05）

第二場 LOCAL 長測在約 34 分鐘由工程端中止；原始資料保留於 `.cache/native-soak-interrupted-20261005-reporting/`，完整 console 為 `.cache/native-soak-20261005.log`。OpenAI 已跨過 25 分鐘續期，Gemini 已做三次 GoAway，但 Gemini 採樣逐漸落後；這場不是 60 分鐘通過，也不能直接歸因產品 UI 卡頓。

已完成兩項獨立因果對照：

- 正式 bundle 的 Gemini provider／store／render，在 20 與 6,000 段歷史下，每 320ms 輸入完整一段，連續 60 秒。兩案各收到 187 段、匯出分別 207／6,187 段，ID 不重複。較大歷史量的同步處理最長 4.8ms、rAF 等待最長 25.5ms、字幕 locator 最長 5.51ms，觀察期間無 >50ms longtask；observer 另以 100ms 正控制確認有效。命令 exit 0、2 案通過。資料：`.cache/native-caption-performance-results/`。這項結果不支持以歷史存量解釋數十秒的量測延遲，也不代表所有會議情境的效能都已驗收。
- 無瀏覽器、相同輸入的 async callback 對照：30,000 frames × 2 個 Playwright expect，保留 60,032 個 step，耗時 93.6 秒；每批 1,000 frames 從 524.7ms 增至 7,305.5ms，確認 parent step 為 null。相同逐框檢查改用 Node 標準嚴格斷言後，step 不隨 frames 增長，30,000 frames 案例約 339ms；第一／最後批約 0.574／0.155ms。前者 2 案對照與後者 1 案皆 exit 0。資料：`.cache/assertion-reporting-baseline-20261005/`、`.cache/assertion-reporting-results/`。

修正只在測試工具：PCM 的 ready／MIME 仍每框嚴格驗證、遇錯立即失敗，使用 `node:assert/strict` 避免每框生成 Playwright 報告步驟。各量測 await 加 10 秒局部期限，保存 wall／monotonic 時間、當前 stage、最近 200 筆 stage 與全程每階段最大純操作耗時；操作時間排除前置診斷寫檔。沒有據此改寫產品的字幕 store 或降低驗收門檻。

短回歸另發現測試收尾競態：候選自動重試的 SDP route callback 尚未完成，harness 就關閉 peer 並結束測試。5 案通過、1 案失敗的證據保留於 `.cache/native-short-failure-20261005-route/`。修正為先以 page route 阻擋新請求，等待既有 context route callback 完成，再清理 native peers；不用 ignoreErrors。原失敗案例重複 3 次均通過，exit 0。專用診斷／native suites 使用各自 config，不繼承一般 dev-server suite 的 30 秒期限與錯誤 server 環境；未刪除案例。

校準後仍須重新完成連續 60 分鐘原生長測；先前中止結果保留，不能累加短測或相加兩場未完成長測取代門檻。

## 長測中斷校準（2026-10-05）

60 分鐘 LOCAL 長測未通過。有效採樣約 17 分鐘；OpenAI 在 08:51:08 UTC 採樣時找不到 open DataChannel，Gemini 最後記錄約 08:50:49 UTC。Windows Kernel-Power 42 記錄睡眠原因為 Application API；Power-Troubleshooter 記錄 SleepTime `2026-10-02T08:51:03.7254822Z`、WakeTime `2026-10-05T01:10:01.6467556Z`。這次持續運作條件已被睡眠破壞，不足以歸因產品自動恢復失效；測試採樣失敗即清理，也沒有保留醒來後的恢復觀察窗口。

Playwright 最終狀態為 timedout、2 did not run。PowerShell 的 finally 清理遮蔽原生命令退出碼，外層 exit 0 不代表通過。後續命令必須立即捕捉 `$LASTEXITCODE` 並明確傳回，同時核對 `.last-run.json` 與兩路 `native-soak.json` 的 passed／Stop 證據。

原始測試資料與 Windows 事件已保全於 `.cache/native-soak-interrupted-20261002/`；追蹤檔狀態改為 interrupted-system-sleep，沒有修改原始失敗採樣。R5 的 60 分鐘門檻仍未完成，不降低門檻、不改變 Windows 電源設定、不新增付費 API 測試。

## 原生 WebRTC 追加複查（2026-10-02）

原生 Chrome loopback 重現：候選 pc 已 connected、DataChannel 尚未可用，程式就接入音軌並退休健康主線；候選隨即關閉 DataChannel，舊線仍已 closed。只補 DC open 門檻的中間修正通過單元測試，但同一原生案例仍失敗，未當作完成。

根因修復：候選必須同時 pc connected、DC open、收到 session.created；共用原先的有界等待與取消。候選通道關閉／錯誤則保留主線；主線 DC 單獨關閉／錯誤直接進入自動續期，不等 30 秒停字偵測。官方 SDK 將 session.created 定義為翻譯連線建立後的第一個 server event：[事件契約](https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts)。fixture 補上該事件，沒有改以首譯文作為候選門檻（無音訊候選不能靠譯文解除等待）。

新增 6 個單元回歸覆蓋 DC 就緒、關閉、session ACK／逾時與 active DC 關閉自救。原生 RTP 測試使用實際解碼 PCM RMS 與封包增量；Chrome totalAudioEnergy 在此 loopback 路徑為 0，已保留原始值，不把單一統計欄位當成真實音訊。此測試不使用雲端、不驗證企業 NAT 或模型語意。

修復前 JSON：`.cache/reliability-2026-10-02/native-webrtc-before-ack-gate.json`。最終整合：543 web/contracts、26 Chrome 接續案例、6 原生音訊／WebRTC 案例通過；新增 OpenAI provider 全 103 案通過。候選關閉時 primary 持續 connected，210 個 RTP 封包、decoded RMS 0.705；失敗 candidate 0 封包且已關閉。完整通過的原生 JSON 已隨最新 ZIP 附 evidence/。

## 使用者要求徹查後的追加修復

| 實際缺陷                          | 根因修復與直接證據                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worklet 一次載入失敗後永久零 PCM  | 清除失敗 promise；失敗後以新的本機 query URL 載入，避開 Chrome 的失敗 module cache。真正 HTTP 503 注入先失敗，再通過原生 Chrome；只重試同 URL 的中間修正仍失敗，未冒充完成                                            |
| 初始化卡住／resume 失敗仍看似正常 | Worklet caller 等待 5 秒、resume 3 秒；錯誤傳回實際 caller，失敗釋放音源／連線；Stop 取消自己的等待。原生操作無 abort API，仍共享未結束操作，不關閉其他使用者的 context                                               |
| 慢速載入被誤判成必須人工救援      | 初始化逾時／拒絕標記 degraded，由既有會議排程自動重試；真正權限／音源 ended 仍失敗。實際 HTTP 延遲 6.5 秒先重現零 PCM，修正後不按 Retry 即恢復，且只擷取一次音源                                                      |
| 48 kHz 音訊誤標 16 kHz            | Gemini MIME 使用實際 context.sampleRate；原生 Chrome 強制走預設 48 kHz fallback，驗證真正 PCM 與正確 rate。官方允許其他採樣率並自動轉換：[Live 音訊規格](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |
| 舊 worklet 回呼跨代送音           | 每次 capture 獨立 signal／generation；Stop 後晚到 worklet／resume 不重建 graph，也不影響其他共享 caller                                                                                                               |

本輪命令與結果：

- web／contracts 全回歸 **37 檔、543 案通過**（含 audio-engine 17、Gemini 76、mic 10、display 11、offline 16、OpenAI WS 32）。
- `pnpm exec playwright test --config tests/e2e/continuity.config.ts`：**26 案通過，2.5 分鐘，exit 0**。
- `pnpm exec playwright test --config tests/e2e/native-audio.config.ts`：**6 案通過，42.4 秒，exit 0**。
  使用 online production build＋打包 server、Chrome 原生 AudioContext／AudioWorklet／MediaStream，
  實體麥克風改為真實 oscillator 音軌，雲端 WebSocket 回應由測試攔截。涵蓋正常 16 kHz、真 HTTP 503、48 kHz fallback、6.5 秒延遲載入；
  其中 4 個 Gemini 案例驗非零 PCM、斷線後送音、GoAway 後送音、延遲 setup 門檻、單次 capture 與 Stop 後停止送音。
  這不是模型翻譯品質或付費真 API 驗證。
- workspace typecheck、online production build、受影響檔 ESLint／格式檢查通過。沒有新增付費 API 呼叫。
- 打包時另重現 Windows／Bash launcher 忽略 ONLINE_PORT、仍印出 8787 的缺陷，
  已修正顯示實際設定。`pnpm -F @meeting-audio/online test` **90／90 通過**，含 8 個 launcher 案例。
  ZIP 附 `VERIFIED_BUILD.md`，說明與既有 audiomodel 並存時如何另設連接埠。
- 修正版：[meeting-audio-continuity-20261002-1620.zip](../release/meeting-audio-continuity-20261002-1620.zip)。
  `VERIFICATION.json` 記錄雜湊；打包檔與原生測試使用的前端／server 逐檔 SHA-256 比對一致。沒有替換既有 latest link 或執行中的服務。

部署核對：工作區 `logs/online.log`／`web.log` 修改時間為 5 月，不能證明當次會議故障。
本機 8787 回傳「即時語音質檢」與 `/static/session-contract.js`，與唯讀 audiomodel 參考相符；
不能把它當作 Meeting Audio 修正版，也不停止或修改該系統。已向使用者詢問實際啟動網址／路徑，尚待回覆。

以下保留前輪工程與驗收紀錄；不能以其完成用語取代上述未完成項。

## 已修正

| 問題                       | 本次行為                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Gemini 告警 2 秒即中斷握手 | 握手期間維持 reconnecting；失敗後才可接管。App 從 outage 起算 20 秒，等待當次有界嘗試結束 |
| GoAway 立即關線            | 舊線繼續處理，預先取 token；依 timeLeft 有界切換，不依賴 close 回呼才能推進               |
| setup 前送音               | setupComplete 前禁止 PCM；晚到 setup、停止後結果不能重新啟用舊線                          |
| OpenAI 候選失敗停掉主線    | 健康主線保留；候選啟用前的 closed／error 拒絕接管                                         |
| 等待沒有期限               | 每次網路嘗試共用 12 秒 deadline；含 mint、body、SDP、ready、activation，排除權限等待      |
| ICE 需要多次事件才推進     | 一次 disconnected 經 3 秒 grace 後完整續期；自然恢復不重啟                                |
| 控制事件掩蓋字幕停止       | watchdog 以來源／翻譯文字 delta 判斷內容進度；相同文字的新 delta 仍計入                   |
| 兩端啟動失敗需人工重試     | 同場以 2／4／8／15 秒封頂重試；有可用後端時自動接續                                       |
| 重試丟失歷史／錯誤未消除   | 保留會議 ID 及既有段落；依故障來源清除已恢復錯誤                                          |
| 系統分享因切換失敗而失去   | 會議恢復意圖持有音源，避免每次重試重新分享；Stop／Pause／ended 釋放                       |
| 停止後權限結果殺掉新音源   | 使用 capture lease 釋放自己的 claim，避免直接停止其他 provider 的共用 track               |
| Stop／重啟回呼破壞新連線   | 先清理舊資源，再通知 terminal／final；generation guard 阻擋舊 timer 與跨代字幕            |
| 429 或續接握手反覆失敗     | Retry-After 貫穿 broker／CORS／預熱；兩次帶 handle 的 setup 前關線後嘗試新 session        |

工程責任分開：`recovery-attempt.ts` 管整次期限與取消，`meeting-recovery.ts` 管會議接管／
重試排程，provider 管協定，App 管會議與音源持有；`session-info-polling.ts` 共用有界查詢。
Warm token 取消後不接受晚到回填，capture 以 lease owner 管理，重複 acquire／release 冪等。
新 session 可能失去模型上下文；此政策不是對 close code 的官方語意推斷，也不補回音訊缺口。

主體維持專用翻譯模型；沒有引入互動模型、付費新測試或 audiomodel 修改。

## 本機證據

- `pnpm exec vitest run --config tests/unit/web-regression.config.ts --silent`：
  **37 檔、507 案全過，exit 0**。含 Gemini 70、OpenAI provider 97、WS 31、capture lease 22、
  recovery scheduler 12、attempt 3、hooks 8、availability polling 2。
- `pnpm -F @meeting-audio/online test`：**9 檔、90 案全過，exit 0**，含 Retry-After／CORS。
- 其中 Gemini 使用 fake clock 推進 **2 小時會議時間＋24 次 GoAway**：
  只建立一套 capture、同時一條活 socket、模擬文字全數 final，Stop 後 timer／socket 歸零。
  本輪實際執行約 2.2 秒；這是邏輯時間測試，不是兩小時牆鐘 soak，也不量測真實模型語意損失。
- `pnpm exec playwright test --config tests/e2e/continuity.config.ts`：
  **26 案全過，2.3 分鐘，exit 0**。Chrome、10 個恢復案例及 16 個既有 keepalive 案例。
- 新案例直接覆蓋無點擊接管、雙端失敗自動恢復、十次加速 Gemini 換線、同場歷史、
  系統分享不重開、Pause／Resume 復原、真正音源 ended 與 Stop 取消；額外快轉 65 秒驗證
  停止後不再啟動 standby token refresh。Runner 結束後成功重新 bind 5207，證明服務已釋放。
- 新恢復案例封鎖未 mock 的外部 HTTP／WebSocket。所有服務為測試替身，未啟動真實翻譯計費連線。
- workspace typecheck、production build、修改範圍 ESLint、diff 空白檢查通過。
  建置仍有超過 500 kB chunk 的警告；未為消除警告增加無關拆包修改。
- 首輪 Chrome 7 過／1 失敗時發生 App HMR；凍結產品後完整重跑 25 案全過。
  Vite 改由測試 runner 同程序管理，成功與失敗命令均正常退出；沒有用強制退出冒充成功。

先建立缺陷測試觀察失敗，再修復。追加交叉審查修掉握手／關線同 tick、候選 terminal
事件與延遲音源授權等競態。測試語意變更有具體原因：
原 2 秒 failed／未建立 socket 的 GoAway reconnection／手動四次 ICE 事件的斷言
會固化已診斷缺陷，改為完整嘗試及單事件恢復；原自動接管 10 秒期待改為容納明確 20 秒預算。
沒有跳過失敗案例或以重跑掩蓋缺陷。

## R1–R5 完成對照

| 任務              | 本輪直接證據                                                                                                      | 判定範圍                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| R1 Gemini 恢復    | 70 個 provider 案例；含 setup gate、GoAway、整次期限、resume fallback、Stop 重入；broker／CORS 與 warm cache 回歸 | 本機協定與生命週期修復完成 |
| R2 OpenAI 恢復    | 97 個 provider＋31 個 WS 案例；含健康主線／失敗候選、ICE、期限、舊 generation 與 terminal callback                | 本機協定與生命週期修復完成 |
| R3 會議恢復協調   | 排程器 12 案、Chrome 雙向無點擊接管及雙端失敗後復原；Stop 跨 65 秒沒有 token 請求                                 | App 整合完成               |
| R4 歷史與音源     | capture 22 案、hooks 8 案；Chrome 比對同場 ID、既有字幕、capture acquisition 次數與停止後活音軌                   | 本機歷史／音源接續完成     |
| R5 整合與工程收斂 | 507＋90 單元／回歸、26 Chrome、typecheck、build、ESLint 無警告、Prettier、diff check、目前程式 fresh review       | 本輪本機驗收完成；V1 另列  |

最終審查已核對責任邊界與變更範圍：沒有新增平行的 provider 協定實作、無關依賴或
保存／補錄 stub；測試 server 使用 web workspace 自己的 Vite 公開介面，不依賴 node_modules
內部路徑。既有工作樹其他修改保留；本輪未修改 audiomodel 或地端 ASR／MT。

## 尚未完成，不能混作本次成果

1. **L1 地端 LOG／TEXT 自動持久保存**：仍需分會議、提交確認、失敗提示、重啟恢復；現有快照不等於已達成。
2. **L2 PCM 缺口保全／補录**：尚未完成。setup 等待及切換間未送音訊仍可能遺失；沒有零漏訊保證。
3. **V1 真 API／發行版長會議**：未執行新的付費驗證。靜音 WebRTC 候選的真服務相容性、
   真實首有效譯文時間、音訊接管重疊、語意完整度與長時間可靠性仍待核准預算／實際會議證據。
4. 關線只保留安全 code；沒有可靠的官方 resume 拒絕分類證據，因此採有界新 session 政策，
   不記 raw reason 或以單一 1008／resumable:false 斷定 handle 無效。會議級保存契約仍屬 L1。
5. 已封裝並驗證候選發行檔，但尚未核對或替換使用者正在執行的版本，不能把候選檔測試當成使用者部署已修好。

因此此次交付是「線上恢復缺陷修正與本機受控驗收」，不是 T00–T11 全部收工，
亦不宣稱真實會議一定不中斷、無人工介入或完整不漏訊。
