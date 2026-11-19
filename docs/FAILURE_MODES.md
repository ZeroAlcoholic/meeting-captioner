# FAILURE_MODES.md

## W04.2 送音不確定區間（2026-10-16，施工中）

- 兩家翻譯 WebSocket 背壓從每次連續丟棄的第一幀即通報 transport degraded，後續沿用每 50 幀節流及既有強制重連門檻。成功重新送音僅解除本機送音停滯，readiness 仍等有效內容；短暫背壓亦保存估計缺口，不等累積 50 幀才開始記錄。
- 翻譯沿既有 coalescer／綁定 meetingId 的 archive writer 記錄 audio／transport 故障；兩者皆恢復後才結束同一筆估計缺口。transport 的 connected 仍由既有 readiness 等待有效文字，不以 socket ready 當內容恢復。
- 區間使用 wallClock／estimated，`unconfirmed:` epoch 只是 provider owner 的不確定範圍識別，不是擷取 sample epoch，不產生 startSample／endSample。未啟用補送時保持 unrecoverable，不能把後續出字或資料已存解讀成中斷內容已補回。
- Stop／替換／unmount 呼叫 handler.finish，一次結束該 owner 的缺口；重複清理不延長缺口，退役尾文仍可保存。舊 writer 的 gap 只能寫原會議，不能挪入下一場。翻譯結案畫面另外顯示已知缺口。
- W04.1 的 captured range 是精確擷取位置。OpenAI 純字幕已將已送出的連續範圍與 committed/completed item 關聯，final 的 `inputAudioRange` 經本機保存／重載／匯出驗證；這不是服務端逐樣本 ACK。其他路徑尚無已驗證的精確完成範圍。archive 的 durable ACK／revision 僅確認文字保存，不能互代。
- 目前沒有 provider 呼叫 readCapturedAudio 補送；兩家、兩目的的加速追趕／活動順序／跨廠對齊／費用仍待資格驗證。文件有協定訊號不等於帳號／模型真實行為已合格。

2026-10-19 W04.2 最小施工邊界核對：`capture-audio-retention.ts` 的 16 kHz 保留區從零計數；`transcription-audio.ts` 在 VAD 初始化後另建 worklet，以 `Date.now()` 加自己的樣本數產生時間；翻譯亦各自送音。因此不能將 `retainedCaptureRange().to` 在送出當下讀值就當成該封包的結束位置，也不能用兩個初始化時間相減來宣稱逐 sample 對齊。

2026-10-19 後續接線：retention 已啟用 worklet 原生時鐘訊息，沿既有 capture owner 提供 `captureRangeForNativeFrames(stream, context, from, to)`。同一 AudioContext、連續輸入、整數取樣率比例（已驗 16／48 kHz）且邊界精確落於已擷取樣本時才回傳範圍；不同 context／舊 stream／Stop、缺少時鐘或輸入跳號、未完成輸出幀、分數取樣相位皆回傳 null。44.1 kHz 等非整數比例的既有 resampler 會逐幀取整，仍保留 PCM，但不使用理想比例假造精確映射。沒有新增 PCM 保留區或逐幀持久紀錄；provider 尚未消費此映射，不能視為 submitted／provider-completed 已對齊。原生兩取樣率三秒案及 48 kHz 九十秒字幕／SQLite／覆寫案通過；證據見 `.cache/w04-clock-range-native-20261019.log`、`w04-clock-range-load-final-20261019.log`。

2026-10-19 接線狀態更正：上述「provider 尚未消費此映射」描述的是前一階段。現在 OpenAI 純字幕透過 lease 的映射介面，在成功送音後記錄來源範圍，只有對應 committed/completed item 的 final 才附上範圍；未知幀、不連續、跨 epoch、補零尾幀皆不猜測。完整單元 1,204 項與 Chrome 兩家基線 2 案通過，OpenAI 原生音訊經 SQLite／重載／JSON 匯出保留範圍，證據 `.cache/w04-input-range-native-20261019.log`。雲端為受控上游；未驗真服務辨識、逐樣本接收或重播資格。Gemini 及翻譯路徑仍保留 unknown／estimated，沒有新增補送呼叫，不將本次接線等同 W04.2 完成。

剩餘接線依序驗收，不新增 manager 或另一份 PCM 保留區：

1. 先讓既有擷取與送音取得同一音訊時鐘的位置，覆蓋不同啟動時間、16／48 kHz、尾幀及暫停恢復；實際接收封包須能回查同一 capture epoch 的保留樣本，不能只驗時間標籤單元測試。
2. 在各 adapter 的實際送出點建立 submitted 對應，明確排除背壓丟棄、取消與未送出的排隊資料；WebRTC 的傳輸統計不能冒充服務端逐樣本完成確認。
3. provider-completed 僅採可對應到已提交區間的協定事件；沒有這種證據的路徑保留 unknown／estimated。Gemini `resumable`／`newHandle` 是續接狀態，`turnComplete` 是模型回合完成，不能直接充作 capture sample ACK；官方亦明示在不可續接狀態使用舊 token 可能遺失資料（[Live API reference](https://ai.google.dev/api/live.md#SessionResumptionUpdate)）。
4. 上述本機對齊完成後才進行既定真服務補送資格驗證；同廠／跨廠、兩 purpose 分別判定，不因支援續接就啟用重播。費用、素材外送授權與模型實際行為未驗前維持禁用。此核對沒有完成 W04.2，也未更動產品行為。

官方協定核對：OpenAI 翻譯停送後再送的模型時間會連續計算，elapsed_ms 是對齊資訊，不能直接當本機擷取 ACK（[client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)、[server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)）。OpenAI 純字幕完成事件按 item_id 對應 committed item，跨 turn 完成順序不保證（[transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)）。Gemini 的 resume handle／turnComplete 與轉寫欄位各有不同意義；本輪未取得它們與本機 sample range 一一對齊的證據（[Live reference](https://ai.google.dev/api/live)、[Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)、[Live translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate)）。不因本輪查文件改模型或既有傳輸路徑。

W03.4（LOCAL 已驗）：恢復握手後維持 reconnecting，當前非空原文或譯文才恢復 connected；空白與控制訊息不重設停字時鐘，正常靜音不重連。持續音訊且反覆無內容時，第一次沿既有同廠恢復，第二個獨立 stalled attempt 後握手仍無內容則發布 failed，由既有 MeetingRecovery 選擇備援；有效內容清除計數，Stop／舊 owner 晚到事件不得復活健康或連線。未新增 timer／依賴。雙向停字升級、靜音、Pause/Stop 與雙端失敗的本機矩陣已驗；真服務／硬體／場域資格仍待 W12/H2。證據 `.cache/hardening-w03-4-20261015/w03-4-verification.json`。

2026-10-15 W03.3：原 provider 已結束時，既有 MeetingRecovery 若選擇另一家，首試等待 1 秒；選擇同廠仍等待 2 秒。後續重試維持 4／8／15 秒封頂，實際期限仍不得早於目標服務的 Retry-After。沿用同一 timer 與 Stop 取消機制；首筆有效文字才視為跨廠恢復。兩方向受控 Chrome 本輪為 2047／2141 ms，非真雲端保證；完整雙向矩陣 12 案已通過，最後續期例外修正另有 55 targeted 與 4 案正式 Chrome；LOCAL 收工證據見 `.cache/hardening-w03-renewal-20261015/w03-3-verification.json`。

## W03.3 純字幕跨廠接管（2026-10-15，施工中）

- `TranscriptionSession` 依既有 `MeetingRecovery` 的目標建立同 purpose adapter；實際 backend 與使用者偏好分開，恢復成功不自動切回偏好服務。不新增恢復 timer 或 capture owner。
- 自動恢復只選本機 broker 宣告可配置的 transcription 服務；configured 不代表真雲端已驗證。兩家的 auth／unsupported 與 Retry-After 各依 transcription scope 保留，translation 的拒絕不阻擋純字幕。兩家永久拒絕時停止無效重試，保留原文並允許停止／人工重試。
- 跨廠握手完成後等待首筆非空文字才宣告恢復；此等待狀態跨同廠續期保留。備援啟動拒絕或回傳非 running 時清理等待旗標，恢復決策仍可繼續；Stop 與陳舊回呼不得復活 owner。
- 能力 polling 沿用既有有界請求與取消，資訊更新不重開健康收音，Stop 後不重新開始。自動音源恢復保留目前 backend；明確人工 `start()` 以使用者偏好重試，僅清除該服務的永久拒絕，不繞過冷卻。
- 目前有受控上游兩方向的 Chrome 文字／保存及故障證據；首有效內容時序、缺口保存精確核對與真服務資格尚未完成。不得宣稱零缺口或真服務三秒內恢復。

## W03.2 候選續期邊界（2026-10-15，LOCAL 已驗）

- 純字幕 adapter 的 prepare 僅準備連線／本機音訊，不送上游 PCM 或發布 live；activate 同步重新核對 socket、track 與取消狀態。Silero 初始化與推論移至專屬 worker，候選期間最多兩個模型 owner；這仍有 CPU／記憶體成本，不是零成本準備。
- VAD worker 初始化最多 15 秒、單幀推論最多 2 秒；錯誤、逾時或取消會終止 worker 並回報既有音訊故障，不回退到主執行緒。傳送 PCM 副本，原始資料保留給字幕送音；沿用既有 64 幀有界佇列與 drain，正常釋放等處理結束，取消則立即終止。模型與 WASM 維持同來源 `/vad/`，未新增 CDN 或依賴。
- session 僅在 active provider 的 mint 明確回傳 boolean true 時準備候選；server 的兩家獨立資格旗標預設 false，操作規則見 RUNBOOK。不能因同時持有 capture lease 就推論帳號允許兩條雲端 session。候選啟用時同步 Stop 仍須維持 stopping，不得重掛續期 timer 或在取消後補發 connected。
- 候選失敗保留健康主線；接管後舊線沿既有最多 5 秒 drain，只轉送 final。新線失敗或重連不能提前取消這些 final；Stop/dispose 與 drain 結束後不接受陳舊回呼。本機單元與原生 Chrome 接管／保存已驗，真服務併發資格仍交 W12.2。

## W03.1 錯誤分類與恢復邊界（2026-10-15，LOCAL 已驗）

- 翻譯與純字幕各自保留 OpenAI／Gemini 兩個固定故障 scope。HTTP 401／403 與已知協定授權拒絕屬 auth；已知不支援的請求／模型屬 unsupported；429 屬 rate-limit；未知狀態、409／425、網路與期限失敗保持可重試，不從錯誤訊息文字猜測授權原因。UI 接收 normalized `recoveryFailure`，不讀供應商原始錯誤。
- auth／unsupported 停止對該 scope 的無效自動嘗試，另一家既有接管能力仍可使用。明確人工開始／繼續／切換只解除實際目標的永久拒絕；一般自動重建不解除。音源失效仍由音源流程處理，不能當成換雲端服務的理由。
- OpenAI 翻譯保留既有同 key WebRTC → WebSocket 與有授權拒絕證據才探測 alternate key 的順序；在可用路徑耗盡後才將最終握手拒絕寫入故障 scope。alternate WebSocket 若是網路失敗，不得重新拋出第一把 key 的 auth 錯誤來永久封鎖整個服務。SDP 的 429 保留 Retry-After；未知 WebSocket 關線不能單獨當成 auth 證據。
- Gemini 本機 worklet／音訊圖初始化的暫時失敗以 normalized `recoveryFailure.layer: audio` 表示，不寫入 cloud gate。App 僅對符合目前 provider 的本機故障設定 `sourceRetryOnly`，由既有 meeting scheduler 重試所選服務，不能自動跨廠；該服務仍須遵守自己的冷卻／永久拒絕限制。這不等於把所有 degraded 都封鎖，也不把暫時初始化失敗改成永久無法恢復。權限拒絕、來源 ended 等需人工處理的音源失敗仍沿原音源政策。
- Retry-After 秒數或 HTTP-date 在收到時轉為 monotonic deadline；缺少或無效值使用 15 秒冷卻。期限保留於同一頁面的 provider／session 重建、Stop／Start 與人工重試之間，包含預熱 token 的使用；不宣稱重新載入頁面後仍保留。較晚的 network 錯誤不能蓋掉永久拒絕或縮短既有冷卻。超長期限保留完整值，單次瀏覽器計時器上限為 2^31−1 ms，到點重新確認期限。
- 翻譯沿用每次網路嘗試 12 秒總期限。純字幕 OpenAI 沿用 30 秒總握手期限（含既有一次 alternate key 探測），Gemini mint 加 setup 共用 15 秒；使用者授權與本機音訊初始化另計。Stop／Pause 撤銷恢復意圖，過期 attempt 不得建立新連線或更新故障 scope。連線恢復並不代表期間音訊或字幕已補回。
- 本機單元已涵蓋 HTTP 分類、冷卻保留、預熱不能繞過拒絕、純字幕就緒前後協定錯誤、翻譯執行中協定拒絕、最終握手分類、同廠音訊初始化重試及期限取消。受控 App 測試另驗首次 worklet 建立失敗後仍由 Gemini 恢復，未建立 OpenAI peer。最新同輪 Chrome 39 案與 970 單元通過，正式 bundle native 35 案已驗，證據及範圍見 W03.1 主清單；本段不代表整體驗收或真實雲端／硬體驗收完成。

## 2026-10-12 交接與本機保存修復

- 翻譯跨廠交接期間可能同時存在兩家 provider；Pause／Stop 必須取消全部，保留原會議歷史。
- 停止交接落選者不發布共用 stopped health；交接結束（包含備援失敗）以保留方當前 normalized health 恢復 UI。不能把備援錯誤當成仍正常工作的原線故障。
- 本機保存收到 HTTP 400／413／422：保留 IDB outbox 與後續字幕，停止對同一資料自動重送，UI 顯示服務拒絕。修復／更新服務後，停止收音並按「重試保存／結案」。網路／暫時性錯誤維持原有有界退避；writer lease 仍須明確取權，不丟棄拒絕資料或標成已保存。
- 回歸與證據層級見 [本輪診斷](DIAGNOSIS_2026-10-12.md)。

> Required visible states and degradation rules.
> See [`CLAUDE.md`](../CLAUDE.md) §"Reliability Requirements".

---

## 接續修復行為與限制（2026-10-02）

- Worklet 失敗 promise 不再永久保留。真正失敗後最多自動重試一次，使用新的本機
  `?attempt=N` URL 避開瀏覽器 failed module cache；正常載入及 pending 原生操作仍共享。
  caller 等待最多 5 秒，AudioContext resume 最多 3 秒；Stop 取消自己的等待，
  不關閉其他 capture 使用的共享 context。錯誤必須傳至實際 caller，不能 degraded 後假裝有送音。
- Gemini PCM MIME 依實際 context.sampleRate 宣告，包括硬體預設 48 kHz；
  舊 worklet callback 不可跨 generation 送進新 socket。正式 bundle 原生 Chrome 已覆蓋此路徑。

- Gemini GoAway 先在舊連線可用期間準備憑證，再依剩餘時間切換；setupComplete 前不送 PCM。
  長 grace 預留 12 秒 setup 加 2 秒餘裕，憑證預備窗口最多 30 秒；短 grace 在憑證完成
  或剩餘時間減 1 秒的切點換線。未假定相同 resume handle 可雙線同時啟用。
- Gemini 與 OpenAI 每次網路嘗試共用不可重設的 12 秒期限，包含 mint、response body、
  offer／SDP、setup／ready 及 activation。使用者音源授權等待不計入。
  GoAway 預準備發生於健康舊線上，與切線後的 12 秒嘗試分開；期限不保證首有效譯文時間。
- Gemini 429 遵守 broker 傳回的 Retry-After（跨 origin 亦可讀）；冷卻期涵蓋預熱及新 provider。
  關線診斷僅包含數值 code，不記錄可能含敏感資料的 raw reason。
  連續兩次帶 handle 的 setup 在就緒前被關閉後，下次改建新 session，保留會議 ID／歷史，
  但模型上下文可能中斷。這是有界恢復政策，不代表已確認 handle 無效；token 失敗、單次
  1008 或 resumable:false 均不能單獨觸發此政策，成功 setup 重設計數。
- provider 在一次恢復嘗試中報 reconnecting，嘗試失敗才報 failed。App 從首次 outage
  起算 20 秒，僅在 failed 且沒有進行中的嘗試時自動跨模型；connected 重設預算。
  不再由 2 秒告警取消第一次 Gemini 握手。
- OpenAI 健康主線的候選失敗不改成主線 failed；候選啟用前的 terminal session 事件會拒絕接管。
  單次 ICE disconnected 等 3 秒自然恢復，仍未恢复則完整重新協商，沒有假裝 restartIce 已完成。
- 雙端啟動失敗保留同一會議及活音源，以 2／4／8／15 秒封頂重試。Stop／Pause 取消恢復意圖。
  使用者停止分享或裝置 ended 會停止傳輸並明確要求重新授權，程式不反覆彈分享框。
- 回復 transport 只清相同來源的連線錯誤，不能清掉音源失敗；「已連線」仍不等於內容已補回。
- 目前沒有完成會議級 PCM spool／缺口補錄或新地端持久保存。握手期間的未送音訊仍可能遺失，
  不得聲稱零缺口、零漏字或供應商永不斷線。真實服務與發行版驗證另列待驗收。

## Online caption issues reproduced with real audio (2026-09-11)

- A hard 12-second storage boundary can split a date unit or negation. Only
  hard-boundary continuations carry `continuationOf`; the live board uses at
  most one predecessor and 160 UTF-16 units of context. Stored text is unchanged.
- SDP success is earlier than media readiness. The listening cue now waits for
  peer `connected` or an actual session event; reconnecting also shows a
  connecting cue when the caption area is empty.
- During renewal, a WebRTC candidate must reach `connected` before replacing
  the old peer. Failure/closure/10-second readiness timeout retains the old
  transport; Stop cancels the candidate.
- Replacing a transport can discard translated output still buffered upstream.
  The retired transport stops sending audio, requests `session.close`, and
  accumulates only its old segment's tail. On `session.closed`, a 250 ms quiet
  grace collects late source deltas; the absolute cap is 10 seconds. Its final
  update goes to history without replacing the new live caption. At most one
  retired transport is retained. Error/cap/Stop preserve only text already
  received, so they do not guarantee a complete tail. Stop still releases
  capture and closes active/retired connections immediately.

## Required Visible States (per component)

For each component (audio, STT, translation, summary, transport), the
UI must be able to render at least these states:

- `idle`
- `requesting_permission`
- `connecting`
- `connected`
- `reconnecting`
- `degraded`
- `failed`
- `stopped`
- `no_audio_track`
- `silence_detected`
- `model_loading`
- `offline_engine_unavailable`
- `api_error`

These map to the `HealthEvent.state` enum in `packages/contracts`.

---

## Degradation Rules (must hold at all times)

| Trigger                | Required behavior                            |
| ---------------------- | -------------------------------------------- |
| Translated audio fails | Keep translated text                         |
| Translation fails      | Keep source transcript                       |
| Summary fails          | Keep captions                                |
| Online fails           | Allow offline or retry                       |
| Offline fails          | Allow online or retry                        |
| Audio source ends      | Keep transcript, show restart UI             |
| Provider switch        | Do not clear transcript unless user requests |

The caption path **never** waits on summary, model load, persistence, or
animation. See [`CLAUDE.md`](../CLAUDE.md) §"Caption Path Is Sacred".

---

## Online Self-Heal & Failover Ladder (Project KEEPALIVE, 2026-06-12)

Both online backends now follow the same three-tier "never go dark" model:

1. **Intra-model self-heal** (automatic, invisible):
   - _OpenAI:_ ICE-restart backoff → full session rebuild on ICE/connection
     `failed` or `session.closed`; a **stale-data detector** (DC silent > 30 s
     while audio is active) forces a rebuild; the scheduled 25-min renewal is
     **make-before-break** (new peer built over the same mic stream, then
     swapped) so it costs **zero caption gap** and never re-acquires the mic.
   - _Gemini:_ WS `onclose` AND a **receive-side wedge detector** (no
     serverContent > 30 s while audio active) trigger a session-resuming
     reconnect; reconnect retries **forever** with a capped backoff.
2. **Surface `failed` while still retrying** — after the fast retries are
   exhausted, transport health flips to `failed` (auto-retry continues in the
   background). This is the signal, not a dead end.
3. **Cross-model failover** (one click) — on `transport: failed` the
   `FailoverBanner` offers a switch to the OTHER backend; it preserves the
   transcript (no `beginSession`) and continues the same meeting.

Degradation guarantee: a backend failure never blanks the board — the last
captions stay visible, the system auto-retries, and the operator can hand off to
the other model without losing history.

---

## Call-stage OpenAI key rejection (`ip_not_authorized`, 2026-08-20)

### WebSocket recovery corrections (2026-09-11)

- Alternate-key retry requires a WebSocket failure classified as authentication
  rejection. Network, timeout and local audio setup failures preserve the key and
  report both SDP and WebSocket diagnostics when both transports failed.
- The 10-second WebSocket setup deadline includes audio worklet initialization.
  A late worklet completion cannot revive a closed transport.
- A replacement WebSocket buffers provider events until the owner activates it.
  Renewal finalizes the old segment before delivering replacement events.
- A replacement that closes before adoption does not tear down the healthy old
  session. The next recovery attempt can proceed with the old captions intact.

Follow-up correction: WebSocket close code 1008 alone no longer changes keys.
It must include an explicit authentication reason, such as `ip_not_authorized`.
Generic policy/payload failures and unrelated numeric request IDs do not demote
accounts.

### Original call-stage diagnosis

**Symptom:** captions never start; the board shows
`OpenAI SDP exchange failed (401)`. Everything server-side looks healthy —
`/session` returns 200, `/session/info` reports `hasApiKey: true`, and the
startup banner confirms the key is in the system env.

**Measured cause (this network, 2026-08-20):** the two configured keys are not
interchangeable at every endpoint.

The two keys are in DIFFERENT organisations (read off the `openai-organization`
response header): `OPENAI_API_KEY` → `<corporate-org>`,
`OPENAI_API_KEY_AUDIO` → `<personal-org>` (a personal account).

| Request (one office egress IP)                         | `OPENAI_API_KEY` (`sk-svcacct-`, corporate org) | `OPENAI_API_KEY_AUDIO` (`sk-proj-`, personal org) |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------- |
| `GET /v1/models`                                       | 200                                             | 200                                               |
| `POST /v1/responses` (billed inference)                | 200                                             | —                                                 |
| `POST /v1/realtime/translations/client_secrets` (mint) | 200                                             | 200                                               |
| `POST /v1/realtime/client_secrets` (generic mint)      | 200                                             | 200                                               |
| `WSS /v1/realtime/translations` (WebSocket transport)  | **`session.created`, stays open**               | —                                                 |
| `POST /v1/realtime/calls` (generic, real SDP)          | **401 `ip_not_authorized`**                     | 201                                               |
| `POST /v1/realtime/translations/calls` (real SDP)      | **401 `ip_not_authorized`** (5/5, 2 CF edges)   | **201** + full media (UDP/DTLS, RTT 201 ms)       |

**The obvious reading is refuted by that table.** OpenAI's IP allowlist
[applies to _all_ API requests](https://developers.openai.com/api/docs/guides/ip-allowlist)
and rejects with exactly this 401/`ip_not_authorized`. If this egress IP were
missing from the corporate org's allowlist, `/v1/models`, `/v1/responses`, both
mints and the WebSocket handshake would have failed too. They did not. So
either no allowlist is active on that scope, or one is active **and this IP is
already on it** — and the realtime _calls_ endpoint rejects anyway.

An independent report on the OpenAI developer forum (2026-08-19, one day before
this failure) describes the identical signature and pins it down:
[`/v1/realtime/calls` suddenly failing with 401 `ip_not_authorized` despite a
static, verified-allowlisted IP](https://community.openai.com/t/realtime-v1-realtime-calls-suddenly-failing-with-401-ip-not-authorized-despite-static-cloud-run-ip-being-allowlisted/1391236)
— "IP allowlist OFF → the same Realtime WebRTC flow works. IP allowlist ON →
the same flow fails", after two months of stable operation.

**Working conclusion: an upstream enforcement defect on the WebRTC calls
endpoint, not a local misconfiguration.** The rejection lands one hop AFTER our
server, in the browser, where the pre-existing mint-stage failover could never
see it.

Two traps worth remembering when re-diagnosing this:

- A malformed SDP (`v=0`) returns **400 `invalid_offer`** for BOTH keys — the
  parse happens before the authorization check, so a curl smoke test with a
  dummy body reports a false "auth is fine".
- Every server-side check (`/session`, `/session/info`, `/healthz`) stays green
  while captions are dead, because the mint hop is the only one the server
  makes and it succeeds.
- The 401 carries no `x-request-id` / `openai-organization` headers — but so do
  the 400 and the 201 from the same endpoint, so that is a property of the
  realtime service, NOT evidence about who rejected the request.
- The realtime **WebSocket** transport works with the same corporate key from
  the same IP, so neither the key, the org, the model entitlement, nor the
  network is broken — only the WebRTC calls endpoint.

**Handling — transport first, key second:**

1. On a 401/403 at the SDP exchange the browser reopens the SAME session over
   the **WebSocket transport with the SAME key** (`openai-ws-transport.ts`),
   pumping the mic itself as 24 kHz PCM16 instead of an RTP track.
   Measured on the failing network: bring-up 1.96 s including the refused
   WebRTC attempt, correct Traditional-Chinese captions, and the server's key
   slot still `primary` — the meeting stays in the corporate organisation.
2. The refusal is remembered **per key slot** for 30 minutes, so the next start
   skips the doomed WebRTC round trip entirely and re-probes later (measured
   first-caption 2.6 s with no `reconnecting` state at all). A mid-meeting
   re-probe is free: renewal is make-before-break, so the old session keeps
   captioning while the new transport is negotiated.
3. Only if the SAME key is refused on BOTH transports does the browser report
   the slot back to `POST /session` (`rejectedSlot`) so the server demotes it
   and mints from the alternate key — measured recovery 2.1 s.
4. The key demotion is **time-boxed** the same way (30 min,
   `DEMOTION_TTL_MS`): the primary key is always preferred, so a laptop that
   moves back inside an allowed network returns to it without a restart.
5. If only one key is configured and both transports refuse it, the browser
   surfaces the concrete error (status + OpenAI's own code + message + a
   plain-language hint) instead of retrying in a loop.

Full ladder, in the order that preserves the most:
`WebRTC + current key` → `WebSocket + current key` → `WebRTC + alternate key`
(reusing the already-built peer) → `WebSocket + alternate key`.

**Remediation, in order of evidence (all outside this repo):**

1. Ask an owner of the `<corporate-org>` org to open
   **Settings > Security > IP allowlist** and report whether one is active. If
   it is, the community report says disabling it restores `/v1/realtime/calls`
   even when the IP is correctly listed — that is the confirming experiment.
   (Adding the IP is NOT expected to help; the evidence above says it is either
   already listed or irrelevant.)
2. Open a support case with OpenAI quoting the endpoint, the org, and the fact
   that `WSS /v1/realtime/translations` succeeds from the same IP with the same
   key while `POST /v1/realtime/calls` returns `ip_not_authorized`.
3. **Already shipped:** the WebSocket transport above. The app no longer
   depends on either of the first two landing — it keeps running on the
   corporate key over WebSocket, and returns to WebRTC by itself once the
   upstream endpoint accepts that key again.

---

## Test Coverage

These failure modes must each have at least one automated or
reproducible-manual test in [`TEST_PLAN.md`](TEST_PLAN.md):

1. Microphone permission denied
2. `getDisplayMedia` returns stream with no audio track
3. Mic device removed mid-session
4. Silence > threshold
5. Online API key invalid
6. Online API returns 5xx repeatedly
7. Offline service not running
8. Offline model file missing
9. Translation provider crashes
10. Summary provider times out
11. Provider switched mid-meeting (transcript preserved)
12. Long-running session (memory bounded)

---

## Open Questions

- Default thresholds (silence seconds, reconnect attempts, backoff curve).
- Should `degraded` be one state or have sub-types (slow, partial,
  high-error-rate)?

Worklet 初始化須區分擷取保留區與連線後的送音階段。2026-10-19 修正：capture retention 在雲端連線前載入模組，第一次 5 秒等待逾時、原 track 仍有效時，發出 audio degraded，沿同一 capture owner 再等待原本共享的 native load 一次；每次仍限 5 秒，不重開裝置、不重複註冊模組、不建立雲端連線。取消、已 ended、非逾時拒絕及第二次逾時不再重試，沿既有清理路徑回報失敗。連線後的 Gemini worklet 初始化失敗仍沿既有會議恢復排程。原生 Chrome 固定於取得音源後注入 6.5 秒 HTTP 延遲，已驗一次 capture、一次 setup、自動恢復 PCM 及 Stop 回收；權限拒絕與真正 ended 音源仍須使用者處理。證據 `.cache/w04-retention-timeout-native-final-20261019.log`（6 passed），不代表真服務或實體裝置驗收。

OpenAI WebRTC 候選以 pc connected＋DC open＋session.created 作接管門檻；缺 ACK 的逾時、close/error 不停掉健康主線。主線字幕 DataChannel 單獨 close/error 立即排續期，不等待 30 秒內容 watchdog；舊連線事件以 generation 與 peer identity 排除。
