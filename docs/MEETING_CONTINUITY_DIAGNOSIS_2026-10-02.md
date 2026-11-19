# 會議接續深度診斷 — 2026-10-02

## 結論與證據範圍

現有主要翻譯模型符合官方現行專用翻譯用途，但會議接續尚不可靠。
問題包含可重現的本地流程缺陷，不能全部歸因於 Gemini 服務不穩。
最嚴重的是：接管失敗後 Retry 會清歷史、2 秒告警會中止同模型自動重連、
斷線空窗音訊直接丟失。保留已顯示字幕，不等於保全整場會議資訊。

本次交付是診斷與改善建議，未修改正式應用、模型設定或既有測試。
工作區原已有 34 個 tracked 檔案修改；本次以現態閱讀，不把它們當成本次修正。
尚未確認使用者實際啟動的發行版、故障時間及收音方式，不能把現態缺陷
直接等同於最近一次會議故障的唯一原因。本次另以 Chrome、合成英文語音與真實 API
觀察自然 Gemini 換線，已重現 GoAway → 重連 → 自動跨模型切換；不是使用者會議音訊。

證據分級：

- **受控重現**：直接執行目前 provider 或 Chrome 應用，外部服務／收音以 mock 注入。
- **真 API 重現**：目前應用接 Google 實際 socket，使用合成語音；仍不等於使用者故障現場。
- **程式確證**：可沿目前程式路徑證明，但未跑該情境的真 API。
- **待查**：需要故障現場 LOG、實際發行版或官方服務回應才能判定。

## 1. 模型是否妥善運用

> 證據與優先序修訂：末節「嚴格複核」收斂了真實測試的結論。
> 字幕長度變化不是持續正常翻譯證據；尚未量得使用者實際漏句量與切換延遲。

| 路徑            | 程式現態                                                                        | 判斷                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Gemini 即時翻譯 | `gemini-3.5-live-translate-preview`，v1beta，AUDIO + input/output transcription | 官方翻譯指南及模型表仍列此專用模型；沒有依據因 3.8 數字較大就換成通用語音代理 |
| OpenAI 即時翻譯 | `gpt-realtime-translate`                                                        | 仍是官方專用翻譯路徑，選擇合理                                                |
| OpenAI 附帶原文 | `gpt-realtime-whisper`，雙語模式才開                                            | 不等於採用最新獨立轉錄路徑；需驗證翻譯 session 的可用 schema，不能直接換字串  |
| Hybrid 文字翻譯 | `gpt-4.1-mini`                                                                  | 較早模型選擇；目前主要故障不在此路徑，沒有本次品質對照證據支持立即替換        |
| 新轉錄候選      | 程式尚未採用 `gpt-live-transcribe` / `gemini-3.5-transcribe-live`               | 應做「原文先到、文字翻譯非阻塞」實音訊對照，不是已驗收方案                    |

程式位置：`services/online/src/config.ts:57`、`routes/session.ts:179,195`、
`routes/translate.ts:7`、`apps/web/src/providers/gemini-live-provider.ts:544`。

官方資料（本次實際開啟）：

- [Google Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate)：專用連續翻譯，使用 3.5 Live Translate；不同於輪次型語音代理。
- [Google 模型表](https://ai.google.dev/gemini-api/docs/models)：3.8 Live 用於語音代理，仍另列 3.5 Live Translate 與 Transcribe。
- [OpenAI Realtime Translation](https://developers.openai.com/api/docs/guides/realtime-translation)：翻譯使用 `gpt-realtime-translate`。
- [OpenAI Live Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe) 與 [轉錄指南](https://developers.openai.com/api/docs/guides/realtime-transcription)：新的低延遲串流轉錄路徑。
- [Gemini Transcribe 規格](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe)：Live 版每 session 10 分鐘；Live 不支援說話者分離／逐字時間戳，檔案版才有。不能把產品總覽功能全算到 Live。

**依使用者最新範圍：保留專用翻譯主體，先完整診斷斷線與切換，不改為互動模型。**
模型更新應以場景、帳號可用性、延遲、漏詞、繁中品質及成本決策。
現有 monitor 的數字不是發話到字幕延遲，也沒有證據可宣稱全部 client latency 已到底。

## 2. 找到哪些 LOG、能證明什麼

| 位置                                | 內容／時間                                             | 結論限制                                               |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `logs/{online,web,offline,whl}.log` | 檔案修改時間為 2026-05-15                              | 不是近期 Gemini 故障證據                               |
| `.cache/live-app.out.log`           | 2026-09-11，8 次 Gemini token POST 完成                | 全為 200，241.2–510.3 ms；只證明當時 token mint 成功   |
| `.cache/live-audio-app.out.log`     | 2026-09-11，1 次 Gemini token POST 完成                | 200，279.6 ms；不是 Live socket 連續穩定性             |
| `.playwright-mcp/console-*.log`     | 49 個歷史 console 檔；較新檔名為 8/20，修改時間到 8/21 | 關鍵字檢索未提供近期 Gemini close code / GoAway 故障鏈 |

檢索涵蓋 logs、.cache、.playwright-mcp、test-results 及 release 的 log 候選；
release 內同名 console 檔多為依賴程式碼，不能當操作 LOG。
本次輸出已遮蔽 token／key，不記錄實際會議內容。

Gemini socket 是瀏覽器直連 Google，後端 token route 看不到它的關閉事件。
`gemini-live-provider.ts:533` 的 onclose 不接收 CloseEvent，因此 code、reason、
wasClean 沒保留下來；`:842` 重試 catch 也丟掉具體錯誤。
發行版 `scripts/release-templates/start.bat` 把 LOG 印到終端，沒有自動轉存檔案。

現有 Field Test 可從介面記錄／匯出部分延遲資料，但只支援線上系統音訊的介面入口，
不是完整連線 flight recorder。尚未讀取使用者正在用的瀏覽器 localStorage，
也未確認實際執行的 release。工作區 `release/` 含多個 5 月／6 月版本；
資料夾日期本身不足以判斷目前執行的是哪一版。

**仍待定案的上游原因**：自然連線期限、網路／VPN 中斷、配額、服務錯誤、
resume 被拒，或舊版程式。沒有最近一次 close reason，不能選其中一個當已確認根因。

## 3. 已證實的故障鏈

### 真實自然換線：50 秒預告仍被放大成跨模型切換

2026-10-02 09:21（台灣時間）啟動目前 source、真 broker、Chrome headless
及合成英文 WAV；不 mock Google 連線。以下時間是同一頁面的 performance 毫秒：

| 時點                    | 實際觀測                                                     |
| ----------------------- | ------------------------------------------------------------ |
| 2,994.4                 | 初始 Gemini setupComplete；後續持續收到 298 個翻譯事件       |
| 541,525.0               | 第一條 Gemini 最後一個 output transcription                  |
| 542,944.2               | 收到 GoAway，`timeLeft: "50s"`                               |
| 542,954.2               | 約 10 ms 後舊線已 close，code 1000、空 reason、wasClean=true |
| 544,313.5               | 建立第二條 Gemini，帶 resumption 請求                        |
| 544,486.8               | 第二條送 setup；尚無 setupComplete，卻送出 14 個 PCM frames  |
| 546,438.3               | 第二條 close，code 1000；沒有收到 setupComplete 或任何字幕   |
| 570,590（取樣經過時間） | 頁面自動切換通知與錯誤列同時可見                             |

因此「自然換線時應用提前斷開、setup 前送音、同模型恢復被跨模型接管」已具有
真實網路情境證據。第二條關閉是否另有上游協定影響，不能單由 code 1000 判定；
應用 2 秒接管因果由下列受控 App 案例分離驗證。
close 事件距離 App stop 呼叫可受關閉握手延遲影響，不可把 3.48 秒 close 間距
誤算成程式的 2 秒告警設定。

這一輪只覆蓋一次自然換線；未量得故障至 OpenAI 首字幕精確耗時，也未驗證
語意完整度。測試 LOG 不含 token、resumption handle 或逐字稿文字。

### P0：接管失敗後 Retry 清掉會議歷史（Chrome 受控重現）

`App.tsx:889` Retry → `handleStartReal`（174）→ `startRealCore(false)` →
OpenAI 先前啟動失敗已 idle → `beginSession('real')`（153）→
`caption-store.ts:434` 清空歷史與 session。

重現步驟：Gemini 有字幕 → Gemini 斷線且 token 重試失敗 → 自動切 OpenAI，
OpenAI 也啟動失敗 → 保留的舊字幕仍可見 → 恢復 OpenAI mock → 按 Retry →
OpenAI ready，舊字幕從畫面消失。

原 E2E `online-keepalive.spec.ts:435` 只驗 Retry 出現及按之前歷史保留，沒有按下去。
Gemini 的錯誤列也沒有對等 Retry 按鈕；重新 Start Gemini 是新會議入口。

### P0：2 秒告警搶走 Gemini 自救（provider 與 Chrome App 受控重現）

斷線後 t=0 排重連；t=1 秒開始第一次 mint／握手；t=2 秒不論握手是否仍正常進行，
`armFailoverSignal`（780）就 emit transport failed。
App effect（550）把這個告警當自動跨模型指令。
`handleFailover`（482）先 stop Gemini，再 start OpenAI；停止時清掉 Gemini 的重試。

因此「provider 會永久重試」在應用層不成立：它可以被 2 秒自動接管直接取消。
目標 available（407）只證明 key/service flag，並未證明能完成握手或出字幕。
目標失敗後沒有 rollback，兩端皆停會使 failover banner 消失。
30 秒 cooldown 是 effect 內時間判斷，沒有到期 timer，不能解讀成每 30 秒自動再救一次。

### P0：重連 OPEN 至 setupComplete 之間會送 PCM（受控重現）

初次 start（369）等待 connect 完成才建立 worklet；重連保留既有 worklet。
新連線 connect（461）把 this.ws 換掉，worklet（882）只判斷 WebSocket.OPEN。
當新 socket 開啟、setupComplete 延遲時，frame 序列已是 `setup → realtimeInput`。

這證明 setup gate 在 reconnect 不完整；Google 是否因此關閉特定故障連線，
仍需真實關閉原因佐證。既有 fake 在同個 microtask 送 OPEN 與 setupComplete，遮住此競態。

### P0：空窗音訊丟失，session resumption 無法補回（受控重現）

worklet（882）在 socket 未 OPEN 時直接 return，沒有斷線佇列或補送。
測試於斷線送入 20 個 512-sample frames（16 kHz，共 640 ms），重連後只送新 frame，
沒有回放那 640 ms。capture lease 保留的是裝置／MediaStream，不是錄音備份。

服務端 resume 只能接續已收到的 session state，無法恢復本地沒送出的音訊。
finalizeTurn 也只能保存已收到文字，不代表服務尚未送回的句尾翻譯已完整保存。

### P1：GoAway 忽略剩餘時間、立即先斷（受控重現）

`handleServerObject`（598）收到 GoAway 就 finalize + close，忽略 timeLeft。
測試 timeLeft=60s 仍立即關閉，且尚無候選連線。
之後走一般 1 秒 backoff + mint + WS/setup，主動製造收音傳送空窗。

[官方 session 管理](https://ai.google.dev/gemini-api/docs/live-api/session-management)
說明一般 Live 連線約 10 分鐘，即使啟用 context compression 仍需換線；
GoAway 提供提前處理窗口。因此週期性換線是應支援的正常生命週期。
但「幾分鐘就斷」不能沒有 LOG 就一律算自然期限。

### P1：控制訊息可掩蓋字幕停滯（受控重現）

`:574` 任意 server message 都刷新 lastServerContentAt，包含 resumption update。
`:955` watchdog 要 >30 秒無訊息、且有足夠音量證據才啟動。
測試維持有聲音，每 5 秒只傳控制訊息，60 秒完全沒有字幕，仍不會被判為停滯。
必須把 transport 活性、音訊送出、原文進度、翻譯進度分開量測。

### P1：重試可被慢請求拖住；錯誤分類不足（程式確證）

- backoff 為 1 / 2 / 4 / 8 / 16 / 30 秒，WS setup 每次另可等 15 秒。
- browser `postGeminiToken`（190）沒有 AbortSignal／總 deadline；後端 upstream
  有 10 秒 timeout，不代表 browser 到本機服務的 fetch 也有上限。
- 失敗原因沒有帶到 retry 決策，不能區分正常 rotation、網路、429、認證及 resume rejection。
- `resumable:false` 不被記錄，舊 handle 持續保留。依
  [官方欄位語義](https://ai.google.dev/api/live#SessionResumptionUpdate)，此狀態使用舊 token
  可能遺失部分資料；不能推論收到 false 就一定該清 handle。應記錄狀態與 handle 年齡，
  依實際拒絕原因決定重新開 session，並補錄／標示缺口。

### 為何體感會慢很多

補充追查發現，問題不只在 Gemini：

- **OpenAI 候選失敗與主連線失敗混用狀態**：`openai-realtime-provider.ts:1128`
  更新重試一律送出 `transport failed`，即使原本 peer 仍健康。App 的自動切換
  會在 `App.tsx:475` 停止這條仍可翻譯的主連線，破壞 provider 內原有的先建後拆策略。
- **切換成功判準過早**：OpenAI 冷啟動在 SDP 完成後即可返回，未等待 ICE/DTLS connected，
  更未等待第一段翻譯。App 註解雖稱已確認 captioning，實際 `switched=true`
  不是首字幕證據。Gemini setupComplete 同樣不等於首字幕。
- **OpenAI ICE 梯度沒有自行推進**：`attemptIceRestart`（1203）計時到只呼叫一次
  `restartIce()`，未自行排下一階段；3/6/12 秒梯度依賴後續 statechange 再呼叫。
  provider 也未處理 negotiationneeded／重新交換 offer。
  [W3C WebRTC 規格](https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-restartice)
  的 ICE restart 需要後續 offer/answer 協商，呼叫方法本身不等於完成復原。
- **OpenAI mint 與 SDP 無應用層總期限**：`postSession`（204）與 `exchangeSdp`（658）
  沒有 AbortSignal／deadline；候選 peer 的 10 秒 readiness guard 在 SDP 之後才開始，
  不能限制前面的 fetch。瀏覽器／網路最終可能自行失敗，但應用沒有可承諾的恢復上限。
- **音源交接沒有交接健康監聽**：`capture-lease.ts` 重用 MediaStream 時，底層 source
  仍保留第一次 acquire 的 onHealth。新的 owner 只收到一次 connected；之後 track ended
  可送到已停止的舊 provider 而被忽略。claim 也未檢查 ended track，可能重用已失效串流。
- **關閉等待沒有期限**：Gemini GoAway／watchdog／背壓皆 close 後等 onclose 才重連；
  未設 CLOSING 的應用層 deadline。這不代表真實瀏覽器必然永遠不回呼，但慢 close
  會直接加在復原時間前面。
- **舊錯誤不隨復原消失**：hook 收到 failed/api_error 會保存 error，但 connected／stop
  不清除；同模型恢復或另一模型已出新字幕後，錯誤列仍可能顯示舊故障。
  必須區分「尚未恢復」與「已恢復但介面狀態過期」。

上述新增情境的受控執行結果見第 6 節。OpenAI WebRTC → WebSocket 的替代路徑
目前只針對 SDP 401/403 或已快取的 transport block，並非所有網路錯誤都會啟用。
這項限制本身不證明應擴大換 key；認證錯誤與服務／網路錯誤仍需分開處理。

硬斷線恢復字幕時間約為：

`故障偵測 + backoff + token RTT + WS/SDP/setup + 第一段模型輸出 + 顯示`

靜默停滯的偵測本身就可能超過 30 秒；控制訊息掩蓋時甚至不觸發。
只有 token 預熱，無法去掉握手、模型出字時間與前面已丟失的語音。
上述是流程時間分解，不是對使用者網路量得的 P95。

## 4. 如何確保會議真正接續

### 使用者追加必要需求：LOG 與會議翻譯嚴格自動儲存

2026-10-02 使用者明確要求自動保存。此要求優先於既有「預設不保存、opt-in」產品策略；
本次仍先診斷，尚未把設定改成啟用，也未宣稱資料已經可靠落盤。

現況並不符合此要求：

- `caption-store.ts` 預設關閉 retention。`caption-persistence.ts` 在 disabled 初始化時
  會 purge localStorage 並排程清 IDB，不能把「有 persistence 模組」當成已自動保存。
- 已啟用時，800 ms debounce／5 秒節流搭配 idle callback 保存已完成字幕；
  idle callback 無 timeout，5 秒不是保證落盤期限。partial 平時不寫，僅 flush 包含它。
- localStorage 只保留最後 2,000 段，IDB 以最短 8 秒間隔保存記憶體快照；
  IDB 是單一 `current` record，不是依會議存檔的歷史庫。新會議會覆寫目前快照。
- `flush()` 只同步寫 localStorage 尾端，不等待 IDB transaction；pagehide/hidden
  並不保證在瀏覽器崩潰／OS kill 前執行。不能宣稱「關頁保存」涵蓋硬崩潰。
- localStorage 失敗只 console.warn 一次，IDB 保存失敗被吞掉；介面沒有可靠的
  儲存失敗／最後成功儲存時間／待存筆數回報。資料仍在畫面，不代表已保存。
- Gemini close reason 未保存、後端 LOG 未自動落檔；無法把使用者的一場會議與
  完整斷線／切換事件鏈對起來。

必要驗收應包含：以穩定 meetingId 分會議保存原文、譯文、修訂、時間與缺口；
增量寫入並以成功提交作確認；重新啟動可恢復；新會議不覆寫舊會議；
斷線與切換不改 meetingId；記錄連線階段、關閉原因及復原耗時的診斷 LOG
亦自動持久保存，且與逐字稿分開，不含憑證。儲存失敗須立即可見並能重試，
不可默默降級為只在記憶體。儲存工作不得阻塞即時字幕。

瀏覽器快照可作快速恢復層，但不足以單獨宣稱「嚴格保存」；實作前須確認
可用的本機服務／發行版路徑，採用可查詢、可恢復的持久層，並量測可容忍的
未提交尾端窗口。會議譯文保存不等於錄音保存；原始音訊長期留存是另一項需求。

### 方案取捨

| 選項                                 | 好處                                                                       | 不足／代價                                               | 建議                               |
| ------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| 僅修重試及接管                       | 變更小，解除強制轉向／卡死／Retry 清歷史                                   | 仍不能救回斷線期間語音                                   | 立即做，但不得宣稱完整接續         |
| 修流程＋會議級短期音訊緩衝＋缺口補錄 | 同時改善即時恢復與資訊完整性；重用 capture lease、normalized events、store | 需時間軸、去重、補錄資源限制及 UI 狀態                   | 推薦的最小完整方向                 |
| 全程雙模型並行                       | 可縮短單供應商失效空窗                                                     | 持續雙倍類型成本／配額壓力、共同網路故障仍存在、合併困難 | 不作預設；需求與量測支持時才作選配 |

### 先維持同一場會議

重連、Retry、接管失敗都保留 meeting/sessionId、歷史、時間軸及使用者音源。
只有明確「開始新會議／清除」能清歷史。會議恢復控制不應依附於某個已死亡 provider。
候選失敗要繼續同模型／適當替代路徑，不把使用者困在兩端皆停。

告警與自動接管分開：2 秒可以提示，不應必然取消仍在握手的來源。
自動跨模型可提供「優先原模型／允許備援」偏好，預設策略應以實測恢復分布校準。
不要只是把 2 秒拉長，否則只把無字幕等待拖長；也不要取消備援卻沒有音訊保全。

### 音訊生命週期獨立於模型連線

會議運行期間由共用 capture 管線保留短期 PCM，以來源、序號、原始擷取時間索引。
例如每軌 120 秒、16 kHz mono PCM16 約 3.84 MB 原始資料；這是容量估算，
不含容器／複製成本，實際長度依復原時間與記憶體量測決定。
預設僅 RAM 有界保存；長斷線、頁面崩潰及超過容量要明確標記無法補回，
需跨崩潰錄音保存時由使用者明確選擇本機留存。

「已送出」不等於「供應商已處理」；不能只以 ws.send 成功刪除所有可補錄片段。
在協定缺乏音訊確認序號時，保留有界重疊區間與不確定性。

即時流優先恢復；歷史空窗交給獨立、限併發的補錄工作，不能把大量舊音訊
直接塞回 realtime 造成字幕永遠追不上。短緩衝重送也必須先驗證供應商速率與時序限制。
補錄結果依原始音訊時間插回歷史，標記「補回」，不搶即時大字幕。
合併以 source/time range/segment lineage 為主，不能只按相同文字去重：
會議真的可能重複說相同日期、金額或否定句。

### 正常換線與失敗復原分開

GoAway 提前準備 token／候選，候選確認可用後再轉送，舊端適量收尾。
同一 resumption handle 能否並存兩條連線、何時接管，需真 API 驗證；
不能照搬 OpenAI make-before-break 就宣稱 Gemini 零空窗。
若協定要求先斷後續，以短期音訊緩衝承接其必要空窗。
setupComplete 前不可送 audio；同時要保留該段 PCM，不能只加 gate 後繼續丟音。

### 使用者看的是會議完整度

狀態應清楚區分：收音中、重連中、首字幕等待、字幕已恢復、正在補回、未補回缺口。
例如「連線恢復，正在補回 12 秒內容」只能在實際有那段音訊時顯示。
未保留音訊則顯示「10:23:14–10:23:26 未能辨識」，不能聲稱會議完整。
缺口應隨逐字稿匯出；重試入口應標示「繼續此會議」。

既有 Pause/Resume、保留字幕、opt-in IndexedDB、匯出與 capture lease 可保留重用。
停止要取消候選與補錄、停止收音，晚到事件不得混入新會議。
摘要目前尚未完成；應先保全逐字稿，後續摘要引用確定的 segment，
明列未補回區間；補錄插入後再修訂受影響決議／待辦，不能靠模型臆補漏掉的事實。

## 5. 實作與驗收優先順序（建議，尚未實作）

1. **保護已有內容及取得診斷**：修 Retry 保留歷史；加入 bounded RAM 診斷環，
   記 session/connection generation、階段時間、close code、過濾後 reason、GoAway
   timeLeft、retry cause、handle age、captured/sent/buffered/dropped 音訊毫秒。
   不記 key/token/handle/逐字稿；避免在 32 ms 音訊 hot path 每框打 LOG。
2. **修同模型恢復**：setup gate、token／握手總 deadline、Stop abort、錯誤分類、
   有限速的立即首次重試、後續 jitter/backoff、resume rejection 的新 session 路徑。
3. **修接管協調**：告警與政策分開；候選 ready 才轉移所有權，失敗能繼續恢復；
   更新 sessionMode 不能先於真正採用。成功訊號區分 connected 與首字幕。
4. **保全未辨識音訊**：共用短期 buffer、缺口帳、非阻塞補錄、原時間插入、去重。
5. **翻譯接續驗收**：維持現用專用翻譯模型，用相同錄音、音量、網路條件與詞彙，
   比較修正前後速度與完整性；模型架構變更不在本次範圍。

驗收應直接覆蓋：

- 句中自然 GoAway、1006、setup 延遲、token 掛住、429、失效 resume、控制訊息存活但無字幕。
- 兩模型都失敗後恢復；按 Retry 後 sessionId 與所有舊字幕不變。
- 同一帶編號錄音含日期、金額、否定句、重複句；驗證空窗段可補回且沒有錯誤去重。
- 分別量測故障到首字幕、實際發話到 DOM、捕獲／送出／待補／已補／確失毫秒、
  漏句與重複率；不能只報成功段落的 P50/P95。
- 建議先以 60 分鐘真 API、跨多次自然 Gemini rotation 作基本驗收，再依實際會議長度延長；
  系統音訊與多人麥克風分開測。供應商錯誤、失敗樣本與誤譯全部保留。
- 緩衝容量內「本地捕獲覆蓋」應無未解釋遺失；辨識品質另與 ground truth 比對，
  不能把音訊送達率冒充內容正確率。

## 6. 本次執行驗證

臨時診斷檔置於 `.cache/reliability-2026-10-02/`，不是正式 regression suite。
其中斷言刻意確認目前缺陷，因此綠燈代表缺陷已重現，不是修復通過。

```powershell
pnpm exec vitest run --config .cache/reliability-2026-10-02/vitest.config.ts
pnpm exec vitest run --config .cache/reliability-2026-10-02/baseline.config.ts
pnpm exec playwright test --config .cache/reliability-2026-10-02/playwright.config.ts
```

- 診斷 **15/15**（完整命令 exit 0）：Gemini 6、OpenAI 4、capture/store 3、persistence 2。
  除前述恢復流程外，也重現單次 ICE disconnected 後 25 秒只 restartIce 一次、
  mint／SDP 掛住 60 秒無 deadline、交接監聽仍屬舊 owner、ended track 被重用、
  ongoing partial 在 routine save 60 秒後仍未保存，以及兩個儲存層同時失敗
  卻沒有將保存失敗傳回呼叫者。
  store 晚到 partial 覆蓋新 partial 的案例只證明底層缺乏防護，不宣稱目前 App
  Gemini → OpenAI 切換必然可達：App 會重複 stop Gemini，可能先終止舊線 drain。
- 原有相關測試 61/61：Gemini 43、failover 8、capture lease 10。
  一般 web test 掃描遇 `.pytest_cache` EPERM；改用臨時 config 精確納入原測試、
  排除不可讀 cache，沒有改測試內容或斷言。
- Chrome 操作案例輸出 1 case 通過（3.8 s），確證接管失敗後 Retry 使原字幕消失。
  Playwright 在 webServer 收尾未退出，等待後中斷 runner，總程序 exit 1；
  因此只宣稱該案例斷言完成，沒有宣稱整個 E2E 命令乾淨通過。

另以 `browser.config.ts` 執行 **5 個 Chrome 受控案例全部斷言通過**：慢 Gemini setup
被自動接管中止、健康 OpenAI 因候選 mint 失敗被停、跨模型已出字幕仍顯示舊錯誤、
同模型恢復仍顯示舊錯誤、接管失敗 Retry 清歷史。測試 server 的 Windows 收尾
再次未退出，完成所有案例後中斷 runner，總程序 exit 1；不把案例通過與
runner 乾淨退出混為一談。首次啟動此 config 的相對 cwd 錯誤已更正，未改任何斷言。

真 API 腳本 `live-continuity.ts` 完整命令 exit 0，09:21:35–09:33:24，
705.8 秒取樣，跨一次自然 GoAway。原始計時記錄為同目錄 `live-continuity.json`；
初始 298 個 input/output transcription、16,872 個音訊框，第二條 14 個框全在
setupComplete 之前。最後約 2.7 分鐘維持自動切換通知與舊錯誤，字幕長度有變化；
這不是句子完整度或 OpenAI 首譯延遲量測。

未驗證：使用者故障場景的唯一原因、部署版本一致性、長會議漏訊率、修正後成效、
新模型的真實繁中品質／延遲、補錄可用性。這些仍是後續驗收工作。

## 7. 嚴格複核：結論修訂與尚未閉合的因果鏈

重新檢查原始 JSON、量測腳本、provider 與診斷斷言後，結論應為：
**已確認數個應用層接續缺陷，並在一次真實自然換線看到相符現象；尚未完成
使用者現場事故定因、漏訊量測或恢復策略驗收。** 不應用「完整診斷」暗示後三者已完成。

### 必須收斂的說法

| 原表述／可能誤讀            | 複核後可成立的結論                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 切換後持續翻譯但留著舊錯誤  | 真實測試只每 15 秒記 DOM 字數與 errorVisible；無錯誤內容或 OpenAI 事件。只證明字數曾改變且錯誤列可見；「新字幕與舊 Gemini 錯誤並存」由另一個 mock App 案例證明 |
| Gemini 重連因提早送音而失敗 | 14 次 audio send 呼叫在觀測到 setupComplete 前，證明 gate 缺口；沒有上游協定拒絕證據，不知道移除自動接管後這次是否本來會成功                                   |
| close 1000 表示上游正常結束 | 只表示 close event 的 code；沒有記 close() 呼叫者，不能由 code 判定哪一方主動關閉第二條連線                                                                    |
| errors: [] 表示沒有錯誤     | 腳本初始化此陣列卻沒有寫入完整錯誤；未收 pageerror、完整 provider health、上游錯誤訊息，因此此欄沒有排除錯誤的證據價值                                         |
| 保存後可避免會議漏訊        | 保存只能保護已捕獲／已產生資料；沒捕獲的聲音、沒送出的 PCM、沒回傳的句尾譯文是不同損失，不會因保存字幕而被補回                                                 |
| 15+5 案例代表完整可靠性覆蓋 | 是缺陷見證案例，含 mock、虛擬時鐘與底層 store 情境；不代表 20 個獨立現場故障，也不是長會議完整性驗收                                                           |

真實字數在 elapsed 585,616–675,733 ms 多次維持 209。這既不能證明停止翻譯，
也不能證明仍在正常翻譯：重複語音可能得到同長文字，停滯也可能字數不變。
下一輪須記匿名事件序號、文字變更版本與來源，測試語料則保存完整結果對照標準答案。
測試使用 source、Vite、NODE_ENV=test、headless Chrome 與 fake microphone；
不能直接代表發行版、實體會議室、系統音訊、背景分頁或使用者的代理網路。

### 2 秒策略的實際時間預算

第一次 close=542,954.2；重連 open=544,486.4，前段已耗 1,532.2 ms。
依程式從 close 後排 2,000 ms 告警推算，只剩約 **467.8 ms** 讓 setup 完成，
尚未扣除其他排程差異。14 個 32 ms frames 約 448 ms，與此時間窗相符。
初次 setupSent→setupComplete 曾花 1,222.1 ms；這不是重連延遲分布，卻足以
顯示目前門檻沒有為一次實際握手保留合理餘裕。
以上為程式與計時交叉推論，不是直接量得 stop 呼叫時間。

仍缺反事實驗證：相同音訊／網路下分別只移除過早接管、只修 setup gate，
觀察是否恢復、首字幕時間及漏句量，才能分離兩個因素各自的貢獻。
不能把 2 秒改成更大數字就宣稱解決；也不能直接取消備援，使真正故障等待更久。
GoAway 的 50 秒是可利用的預告，並不單獨證明同 handle 雙連線可並存或可以零空窗。

### 根本控制問題與修復順序修訂

目前同一個 `transport failed` 同時表示「使用中連線失效」「候選更新失敗」
及「重連已超過提示門檻」，App 卻將它們統一解讀成停止來源、切換供應商。
這是兩家 provider 都出現問題的共同控制契約缺口。最小修復應先明確區分
主連線、候選、恢復進度與使用者政策，再決定是否切換；不必先全面重寫架構。

前述線性排序「先完成自動保存，再修接續，最後保全音訊」不宜作為實際排程：
會讓已知漏音持續存在。調整為兩條同級必要工作：

1. **立即保護現有資料與證據**：Retry 不清歷史；自動保存分會議原文／譯文及
   去除憑證的連線 LOG；明確回報提交成功、待存與失敗。必須測到新會議不覆寫、
   程序強制中止後可恢復、磁碟／配額失敗可見。不能只開 retention=true。
2. **同時修正造成漏訊的恢復路徑**：健康主連線不因候選失敗被停；setup gate、
   請求期限與取消；合理利用 GoAway；對必要斷線建立有界音訊緩衝與缺口紀錄。
   長缺口補錄可分階段，但未完成前必須明列資訊損失，不能宣稱會議完整接續。

自動保存須區分瀏覽器本地提交、本機服務已提交，以及斷電後的耐久性；
不能把 Promise resolved 或 OS 接受 write 當成所有層級的保存保證。
LOG 與會議內容分開保存，以同一 meetingId 關聯；有限額的 LOG 輪替不得連帶
刪除會議內容。原始音訊長期留存尚未由使用者要求，短期補錄緩衝不能冒充永久錄音。

後續驗收最重要的三個結果是：**故障到新有效譯文的時間、原始時間軸上的缺口與
漏句／否定句錯失、重新啟動後確實存在的會議內容**。連線 connected、字數、
成功測試數量都是輔助訊號，不能取代它們。此輪僅修訂診斷，未修改正式程式，
也未重新執行真 API；不以新增文件充當上述未完成驗證。
