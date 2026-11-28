# 會議強固化主工作清單：兩家交互備援，Gemini 第二金鑰後排

2026-10-19 本批收束：OpenAI 純字幕 capture→VAD→成功送音→committed/completed→SQLite→重載／原始 JSON 匯出的 inputAudioRange 已接通。完整單元 1,204 項、build、scoped eslint、Chrome 兩家基線 2 案通過；上游受控，非真服務逐樣本確認。證據 `.cache/w04-input-range-native-20261019.log`；其他 adapter 對齊、補送資格及原有外部驗收仍待辦，自動補送停用，維持 18／26 LOCAL。本批不再擴增功能或啟動長測。

2026-10-19 worklet 逾時回歸已收斂：capture retention 對型別明確的首次載入逾時，在同一有效音源上追加一次有界等待；保留每次 5 秒期限、可見 degraded、Stop 取消與失敗清理，不新增 timer／manager／依賴。原生 Chrome 六案單輪通過（30.0 秒），包含 16／48 kHz 時鐘比對、載入拒絕重試、6.5 秒延遲後一次 capture／一次 setup、斷線與 Stop；前端完整 942 項、web build、scoped eslint 通過。舊延遲案的 2 次 setup 假設已按 retention 在連線前初始化的實際路徑改為 1 次；另固定預熱與故障注入時序，保留初始失敗紀錄，未放寬期限或 PCM 斷言。證據 `.cache/w04-retention-timeout-native-final-20261019.log`、`w04-retention-timeout-web-final.log`；相關紅測與中間失敗檔同前綴。W04.2 時鐘標記尚未接入保留區／provider，補送未啟用，仍 18／26 LOCAL，完整長測與真服務／場域尚未完成。

2026-10-19 正式建置效能補驗：既有 Chrome production 20／6,000 段正常保存、6,000 段慢寫入與 worker hang 四案單輪通過（4.6 分鐘），fixture 正常回收。各 60 秒原始紀錄均無 >50 ms long task；匯出 207／6,187 段，筆數與唯一 ID 一致；慢寫入注入 180 次，hang 注入 1 次。使用現有正式產物 index-CCfXzd67.js；受控擷取與上游、真瀏覽器／SQLite，不代表真服務辨識或硬體磁碟故障，也不是 event→DOM 延遲測量。本輪未修改產品或測試程式，18／26 不變，W12 長測仍未通過。證據 `.cache/w12-close-production-performance-20261019.log` 與同名輸出目錄內四份 `caption-performance.json`。

日期：2026-10-15；2026-10-16 收束校準。現況：18／26 子項完成 LOCAL 工程驗收，詳見下表與各項證據；這不是整體真服務／場域放行。剩餘 8 項包含工程缺口及外部資格驗證，不等於還要開發 8 個功能。

**Goal:** 收對音源、穩定運作、同服務恢復，並以 OpenAI／Gemini 各一把可用金鑰完成兩家交互備援；保留紀錄且清楚處理不可恢復狀況。Gemini 第二把金鑰不屬本輪前置。

**Spec:** [診斷與場域契約](../specs/2026-10-15-meeting-resilience-design.md)。本清單是施工排序與放行範圍的唯一入口；A/D/N/V 文件保留細節，但不得把 Gemini 第二金鑰帶回前段相依。

## 執行規則

2026-10-19 收尾核對：現版 W12 LOCAL 基線未通過，runner 已 exit 1，未重啟。Gemini 最後連續採樣 94 分鐘／376 筆，OpenAI 約 93.75 分鐘／375 筆；其後觀測缺口分別 38,230,824／38,241,878 ms，超過原 30,000 ms 門檻，測試及 teardown 逾時。系統事件已確認 10/16 17:51:32（台灣時間）因 Application API 進入睡眠，與約第 94 分鐘採樣中斷吻合；發起程式未識別，事件原文見同目錄 `power-events.json`。完整 120 分鐘及 Stop 回收未驗，純字幕階段未啟動。manifest 記錄防睡眠請求已釋放。證據位於 `.cache/w12-baseline-20261016-161722` 的 manifest、native.log 與兩路 native-soak.json。18／26 不變，W04.2 與真服務／場域項目仍待驗；先釐清環境中斷原因，不放寬門檻或自動重跑整輪。

2026-10-19 短程效能補驗：修正既有 responsiveness 測試 Resume 後未提供新內容卻等待健康恢復的前置死結；只增加來源文字，保留原 20 次會議、20 partial／20 final 與控制樣本覆蓋。修後 Chrome 1 案通過（19.6 秒）、scoped eslint 通過；normalized→DOM partial p95/p99 41/41.1 ms、final 1.9/2.3 ms，Start/Pause/Resume/Stop 各 20 筆亦均達 p95≤100／p99≤250 ms，pending=0。這是 dev build＋受控上游的本機呈現／操作證據，不代表雲端辨識、production 或長測通過。未改產品碼。原始分布與失敗紀錄見 `.cache/w12-close-responsiveness-fixed-20261019`、`.cache/w12-close-responsiveness-20261019.log`；18／26 不變。 同輪後續既有 caption-longtask 三案通過（5.0 分鐘）：正常保存／停用保存對照／進行中呼叫既有匯出函式，各 90 秒、2,000 段種子、零 >50 ms 長任務；末段字幕持續推進，Stop 後全量保存 ID 與顯示資料一致，進行中匯出 2,009 段。上游受控，非真辨識；未改卡頓測試或門檻。證據 `.cache/w12-close-longtask-20261019.log` 與同名輸出目錄。

### 2026-10-16 收工範圍凍結

- **只完成既有 26 項，不新增工作包。** 修碼必須對應下列未結項的具體缺陷或原驗收條件；美化、泛用框架、無關重構及推測性擴充不納入。維持既有模組邊界與單一資源 owner；可維運／可擴充不等於預先增加抽象層。
- **工程缺口：W04.2。** W09.1 已完成本機三路與接管核對，真公司網路資格保留於 W09.2。W04.2 核對送音區間與補送資格；未經真 API 驗證不開啟自動補送，保留缺口提示，資格不足仍記待驗。
- **本機整合驗收：W12.1。** 前置滿足後沿既有測試完成四路各 120 分鐘、必要故障／保存／效能與回收核對；依既有配方至少約四小時。不能以短測替代，也不重建測試平台。
- **外部條件與放行：W02.2、W09.2、W10.1、W10.2、W11.2、W12.2。** 分別需要實體裝置、公司網路、真人素材與人工稿、實際操作、真帳號雙軌／回聲，以及真服務最終驗收。條件未齊就明列待驗與限制，不為補齊數字製造替身證據或額外功能；有條件後仍須完成原驗收。
- **完成一次就結案。** 已完成項目只因本次改動影響或新缺陷證據才重開；相關驗證通過並完成一次新鮮差異審查後收工，不反覆全面掃描。維持原門檻，所有必要項目與外部放行證據齊全才宣稱整體完成。
- **固定保留／延後界線：** OpenAI↔Gemini 雙向備援、雙軌隔離、完整保存與流暢穩定仍是必要要求；Gemini 第二金鑰、額外模型／離線擴充、摘要／語者新功能不加入本輪。

- **最新明確範圍：OpenAI／Gemini 兩家交互備援是主線必做。** 部署預檢確認兩家實際可用性，不以 Gemini 第二把金鑰為條件；不假定離線模型、備用裝置或第二條網路存在。
- **同服務恢復**：原 provider／同一授權範圍的重試、連線續期、限流冷卻、來源恢復；屬於主線必要能力。
- **跨 provider 備援**：OpenAI→Gemini、Gemini→OpenAI 均須完成，見 W03/W12。**同 provider 第二金鑰備援**：Gemini 第二 key 放最後，現階段不建置／不驗收，見 B00/B02。離線引擎另依可用能力評估，不能替代兩家雲端交互備援。
- 同服務雙連線續期也不能假定帳號允許併發；先驗資格。不允許時用同服務有界重連、保留文字與明示缺口，不虛構無縫。
- **資料備份還原**仍是主線保存工作。既有翻譯跨廠恢復保留並驗證；純字幕跨廠接管需補齊，同 purpose 切換，不能切成翻譯假裝恢復純字幕。
- 每個工作包完成：重現／基線 → 最小修改 → 直接功能測試 → 相關整合／失敗路徑 → 新鮮 diff review → 文件與證據。只有測試通過不能代替功能完成。
- 先完成每個包的前置再開依賴工作；可獨立的保存工作不必等待音訊補送。未有真人／實機／網路條件，只阻擋對應放行，不阻擋本機修復。

## 流暢與穩定的共同放行條件

這些是施工目標與測量規則，尚非現有性能宣稱。W01 記基線，W02–W11 按改動量測受影響項，W12 統一驗收；不另建效能平台。

| 項目               | 驗收與量測邊界                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 字幕本機呈現延遲   | normalized event 到對應文字 DOM 更新，前景 Chrome p95≤100 ms、p99≤250 ms。partial 只量實際採用的最新 revision，final 全量核對；另記 rAF／long task，DOM 更新不冒充螢幕實際顯示時間。與雲端辨識延遲分開 |
| 畫面卡頓           | 保留既有 `caption-longtask.spec.ts` 的 90 秒、2,000 段、零 >50 ms long-task 門檻；production 再比較 20／6,000 段，20,100 段只要求全量保存及有界顯示，不把全部歷史塞進 DOM                              |
| 操作回應           | Start/Pause/Resume/Stop 的可見狀態回應：前景本機 p95≤100 ms、p99≤250 ms；操作確認不等於上游連好或結案已存。Stop 的擷取取消不等待雲端、匯出或磁碟                                                       |
| 故障恢復           | OpenAI↔Gemini 雙向接管分別驗翻譯／純字幕；沿用受控有效字幕恢復 ≤3 秒目標，真服務另報實測。沒有字幕內容進展不能只以 socket ready 宣稱已恢復                                                             |
| 保存／背景工作隔離 | 同素材開關保存、全量匯出及注入慢磁碟／worker 故障，各跑同一字幕量測；不能犧牲 final、擴大字幕 batching 或停字幕換取通過                                                                                |
| 有界資源           | 明列每軌 buffer bytes、VAD/送音/outbox queue 容量與溢出政策。2 小時測每 5 分鐘穩態樣本及 Stop 後殘留；分開記會議文字成長、固定 buffer 與應回收物件，不把預期文字成長誤判為 leak                        |
| 量測可信度         | 固定機型、Chrome/build、電源條件及輸入；保留原始分布、最大值與異常，不只平均。每幀只記低成本計數，分批輸出，禁止在音訊回呼逐幀寫 log／Playwright assertion                                             |

未通過先定位 capture／provider／store／render／storage 的實際阻塞，不先加快取、worker 或調鬆閾值。背景分頁及睡眠分開測：不沿用前景 DOM 延遲門檻，不許因此漏存 final；睡眠期間沒取得的音訊明示缺口。

## Clean code 與避免重複架構的施工界線

| 責任                   | 優先沿用                                              | 不得重複新增                                                       |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| 會議級重試／接管時機   | `meeting-recovery.ts`                                 | UI effect、provider 與新 manager 各養一套接管計時器                |
| 單次網路嘗試期限／取消 | `recovery-attempt.ts`                                 | mint/socket 各自無限重設 deadline，或再包一套通用 retry framework  |
| 音源所有權             | `capture-lease.ts`、`audio-engine.ts`                 | 每個 provider 重開麥克風、平行維護第二份 active source             |
| 高頻事件與畫面         | `coalesce-handlers.ts`、既有 caption store／selectors | 第二個事件匯流排、另一份全文 UI store，或為每次 delta 重繪整份歷史 |
| 保存與修訂             | 現有 archive/outbox/SQLite worker／contracts          | 第二個資料庫、第二個 outbox、另一套 revision／ACK 規則             |
| 健康顯示               | normalized health 與 owner 的實際進展                 | UI 複製 provider 狀態並各自推斷恢復成功                            |
| 診斷／效能             | 現有 latency monitor、原生與長任務測試                | 通用 telemetry 平台、每幀事件持久 log、額外常駐監測服務            |

- 詳細計畫的新增檔名是**候選落點，不是必建清單**。先修改最接近的現有責任模組；只有獨立生命週期或已存在至少兩個實際使用點，才抽共用單元。單一小函式不為套模式而包 class/interface。
- 協定、活動分段與上游錯誤差異留在 adapter；共用 owner／deadline／事件契約。不得為消除兩家幾行重複，建立含大量 provider 分支的「萬用 provider」。
- 不先建 plugin registry、DI container、通用 workflow/state-machine 平台或可支援任意 N 家的 routing framework；目前就是兩家、最多兩音軌。
- 同一資源只有一個 owner：capture、attempt、候選採用、退役 drain、writer lease 分別明確。區分必要不同責任，不用一個巨型 manager 統管全部。
- 正常每軌一條主線；切換才允許一個候選及有期限退役尾文，禁止無故常駐雙雲端同送。候選／退役數量與時限以測試驗證，舊回呼不能新增 owner。
- 不因「clean code」展開全專案搬檔／重新命名／框架升級。需要整理時只整理該功能涉及的邊界，先保護行為再改結構，不混入無關修復。
- 每次引入新狀態、queue、timer、worker 或 process，說明既有哪個無法承擔、容量／期限、取消及釋放點；無具體必要性就不加入。不要以固定行數／檔案數上限壓縮可讀性，也不以拆檔數量當品質。
- 新路徑接通並驗收後，刪除被取代的同責任舊路徑及失效開關；只保留有實際舊資料需要的相容讀取與回退，記明移除條件，不能永久 v1/v2 並存。
- 每個工作包只交一個可驗收行為變更；重大狀態變更拆成可審查小步，但不建立只剩 scaffolding 的完成里程碑。使用既有測試 fixture，避免複製另一套假上游。

### 每包必做的精簡審查

- [ ] 能指出此次修復的實際使用路徑、重現證據與直接結果，沒有靠「重構完成」替代功能完成。
- [ ] 新增模組／依賴／狀態／timer 各有必要性；檢查既有替代方案，沒有相同責任的平行實作。
- [ ] owner、取消、過期事件與失敗狀態清楚；無吞錯、無無界等待、無無界 queue。
- [ ] 受影響的流暢度、資料完整性及故障驗收通過；回歸保護的是行為，不是對私有方法呼叫次數的鎖死。
- [ ] 刪除本次被取代的死碼／重複路徑；diff 無無關整理，文件只更新主清單、現況與該次證據，不再增加一份平行總計畫。

## 可直接領取的任務與收工規則

以下 **26 項**是 W01–W12 的施工切片，不另建第二份待辦。初始狀態為「未開始」，目前進度以表格與執行紀錄為準，由當次執行者負責實作、驗證及回填；既有能力先驗證，符合者可不改產品碼。每次只領一項，完成或記明阻擋後才換項，不一次展開全部模組。

狀態只用：未開始／施工中／工程已驗、場域待驗／受阻／完成。「工程已驗」不是母工作包完成；母包要等所有子項與原驗收條件滿足才勾選。每項收工記錄就在本表「狀態／證據」格連結到既有測試輸出或短報告，不新增任務管理系統。

每筆證據必含：實際 commit＋dirty 檔案雜湊、build、測試案例／命令與退出碼、輸入素材與環境、預期／實際結果、未驗範圍。有 blocker 則記「缺什麼、影響哪一項、解除後跑哪個驗收」，不以時間到或完成文件打勾。不得跳過測試、使用 passWithNoTests，或把未實作案例列為通過。

表中檔名省略的共同前綴：前端為 `apps/web/src/`，後端為 `services/online/src/`；完整落點與故障案例沿用 A/D/N/V 細節計畫。驗證代碼見下一節；代碼是執行入口，必須先補入該列所需行為斷言，不能把現有綠燈直接套給新功能。

| 任務                       | 前置                              | 最小可交付行為／修改落點                                                                        | 收工必驗；驗證入口                                                                                                           | 狀態／證據                                                             |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| W01.1 能力與基線           | 無                                | 核對 deployment、settings/settings-store.ts、App.tsx 的場景路由，修正不實能力描述；記錄現行性能 | 每個可選場景對到實際音源／purpose；20／6,000 段與 long-task 基線可重現；C1、C6                                               | 完成；見執行紀錄                                                       |
| W01.2 會前試音             | W01.1                             | 現有音源設定與 AudioLevelMeter/HealthRow 接真 track、PCM、保存狀態                              | 拒絕權限、分享未帶音訊、零 PCM、儲存不可用各有正確提示；單一 provider 可開會；C1、C4＋Chrome 操作                            | 完成（LOCAL）                                                          |
| W02.1 停流與裝置狀態       | W01.2                             | providers/audio-engine.ts、capture-lease.ts 與現有 audio adapters；補無 frame 監測及狀態        | 有 frame 靜音不重連；無 frame 能報故障；mute/context/ended 分層，Stop 清掉監測；C2、C4                                       | 完成（LOCAL）                                                          |
| W02.2 裝置恢復與取消       | W02.1                             | 原 capture owner 管重新取流及裝置選擇，不加第二 owner                                           | USB/BT/HDMI、睡眠／鎖定逐項操作；拒絕不彈窗風暴、不偷換 mic；Pause/Stop race 不復活；C2、C4、H1                              | 工程已驗、H1 場域待驗；見下方證據                                      |
| W03.1 錯誤分類與期限       | W02.1                             | meeting-recovery.ts、recovery-attempt.ts、transcription-session.ts 及 mint adapters             | auth/429/Retry-After/network/unsupported 分類、總期限、取消；永久錯不無限重試；C3                                            | 完成（LOCAL）；970 unit、39 Chrome、35 native；見下方證據              |
| W03.2 同廠續期             | W03.1、W02.2                      | session owner 接候選生命週期，保留健康主線與 late final                                         | ready 前不拆健康舊線；候選失敗／舊線先恢復／Stop 競態；不允許重疊時明示缺口；C3、C4；真併發資格交 W12.2                      | 完成（LOCAL）；worker 修復及 14 種整合情境已驗，見下方證據             |
| W03.3 純字幕跨廠接管       | W03.2                             | transcription-session 與兩家 transcription adapters 共用既有 recovery 決策                      | 兩方向各驗首有效文字、meetingId/purpose、冷卻及雙端失敗；每家一 key、Gemini 第二 key 未配置；C3、C5 擴充案例                 | 完成（LOCAL）；1049 unit、12＋4 Chrome、15 翻譯回歸                    |
| W03.4 翻譯接管與停字       | W03.2                             | 現有翻譯 session/hooks 接同一恢復契約；刪被取代 timer                                           | 翻譯兩方向、有效音訊無內容、正常靜音、雙端失敗、Pause/Stop 全過；C3、C4、C7                                                  | 完成（LOCAL）；真服務／場域交 W12/H2                                   |
| W04.1 有界音訊保全         | W02.2                             | capture owner 與 transcription-audio；只建一個必要 ring                                         | 60 秒容量；3/10/30 秒停送 sample 核對；90 秒明示覆寫，Stop 清 PCM、睡眠不造樣本；C2＋擴充原生案例                            | 完成（LOCAL capture）；送音對齊與補送仍待 W04.2                        |
| W04.2 補送資格與接線       | W04.1、W03.3、W03.4               | 各 adapter 分別決定補送能力／節流／區間，live 優先                                              | 各 provider 同廠及跨廠逐一驗證；不支援則禁用且保存缺口；未有真 API 證據保持待驗，不承諾無缺口；C3、C4、C5、H2                | 施工中：OpenAI 純字幕輸入範圍已接並驗匯出；其他 adapter／補送資格待驗  |
| W05.1 翻譯寫入既有 archive | W01.1                             | App.tsx、coalesce-handlers.ts、store/meeting-archive-client.ts                                  | coalesce 前入庫；兩家 translation final/revision 不漏，重連不換 meetingId；C8＋translation-archive E2E                       | 完成（LOCAL）；C8 119、Chrome 兩案通過，見收工紀錄                     |
| W05.2 結案與全量取回       | W05.1                             | 現有 ExportMenu、archive、校訂與保存狀態                                                        | 兩 purpose×兩家，Pause/Resume/Stop/重開／校訂；20,100 段 DB/export 精確一致、正常 pending=0；C5、C8＋translation-archive E2E | 完成（LOCAL）；1079 unit、兩目的四路及 20,100 段，見收工紀錄           |
| W06.1 固定 origin 與救援   | W05.2                             | scripts/service.mjs、managed-service.mjs、outbox/client                                         | 先重現跨埠 IDB 不可見；固定 origin，外物占埠不傳資料、不殺外物；舊 origin 救援 ACK 後才結案；C9＋origin-recovery E2E         | 完成（LOCAL）；9 項服務測試、Chrome 原網址 ACK 救援，見收工紀錄        |
| W06.2 儲存失敗閉環         | W05.2                             | 現有 outbox、repository/worker、meetings route 與 UI                                            | D3 各類 fault→提示→修復→全文比對；ACK 去重、RAM 損失永久記錄、字幕不阻塞；C8、C6＋storage-faults E2E                         | 完成（LOCAL）：27 Chrome、C8 127、C6；見收工證據                       |
| W07.1 一致性備份與還原     | W06.1、W06.2                      | 現有 repository/worker/routes 與維護入口                                                        | 兩場共 20,100 段含修訂／缺口，真備份到第二目錄還原，逐事件比對；不中斷字幕；C8＋Chrome 真操作                                | 完成（LOCAL）；見 W07 收工紀錄及 `.cache/w07-backup-verification.json` |
| W07.2 壞檔與版本保護       | W07.1                             | 同一還原路徑與 schema 相容邏輯                                                                  | 截斷、壞 hash、未支援 schema、路徑穿越、寫入失敗都保住原資料；舊 outbox／舊 binary 行為可核對；C8                            | 完成（LOCAL）；見 W07 收工紀錄及 `.cache/w07-backup-verification.json` |
| W08.1 有界程序復原         | W06.1、W06.2                      | 原 managed launcher/owner，必要才抽局部 supervisor                                              | 真 child crash/hang、3 次／60 秒上限、同 build/origin、Stop 不復活、雙 start 單例、外物不被殺；C9                            | 完成（LOCAL）；見 W08 收工證據                                         |
| W08.2 舊頁與待存接續       | W08.1                             | 現有 broker readiness、archive client 與頁面狀態                                                | child 故障不拆仍活雲端線；原頁原會議待送→重啟→DB/export 精確比對；C8、C9＋Chrome 整合                                        | 完成（LOCAL）；見 W08 收工證據                                         |
| W09.1 網路路徑與代理       | W03.3、W03.4                      | 現有 server config/mint 與前端診斷，不先建 network manager                                      | 真本機 CONNECT/NO_PROXY、可信 CA、server HTTP/browser WSS/WebRTC 分測；單家被擋能接管、雙家被擋誠實提示；C10、C7             | 完成（LOCAL）；三路/接管已驗，真公司網路交 W09.2                       |
| W09.2 公司網路資格         | W09.1                             | 不預設需改碼；使用上述診斷與 RUNBOOK                                                            | 授權公司網路重做三路＋兩方向切換，留代理／憑證限制；沒有環境就待驗；H1、H2                                                   | 未開始                                                                 |
| W10.1 品質素材與有限校準   | W01.1；可提早準備                 | 沿用 caption-eval、既有 DSP/VAD 設定與 V1 品質門檻                                              | 先凍結分場景素材、人工稿、門檻及 speaker/session 留出集，再調設定；未過列缺陷，不無限換模型／調參；H2                        | 施工中：素材核對完成；真人稿/外送權限待提供                            |
| W10.2 操作流程驗收         | W01.2、W02.2、W05.2               | 現有場景／試音／開始／恢復／停止／匯出入口                                                      | 每個待放行場景 3 次獨立操作；不讀工程文件能完成，預期可自救故障人工救援 0 次；H1                                             | 未開始                                                                 |
| W11.1 真雙音軌             | W02–W06 工程驗收                  | capture lease、session owner、coalesce-handlers 與既有 store，最多兩軌                          | mic/remote 各自 source/epoch，partial 不互蓋，final 完整，單軌故障不殺另一軌，雙軌保存匯出一致；C2、C3、C8＋Chrome 雙軌案例  | 完成（LOCAL）；真帳號/硬體資格交 W11.2，S4 未放行                      |
| W11.2 雙軌場域資格         | W11.1                             | browser capture 優先；僅必要場域補 WASAPI                                                       | 回聲／輸出裝置改變、兩家各自同 key 併發及切換資格；不能借第二 Gemini key 過關；H1、H2，不通過則 S4 未放行                    | 未開始                                                                 |
| W12.1 整合與四路長測       | W01–W08、W10、W11 工程驗收；W09.1 | 擴充既有測試，不建立另一套假上游                                                                | LOCAL 四路各 120 分鐘、兩方向故障矩陣、有效內容時間、保存比對、資源回收、共同流暢門檻；C4、C5、C6、C7＋長測配方              | 現版 LOCAL 長測基線未通過；觀測中斷，純字幕未啟動；見收尾核對          |
| W12.2 真服務與最終放行     | W12.1；各場域 H 驗收              | 實際一把 OpenAI＋一把 Gemini key，彙整原表，不開新總計畫                                        | 真服務雙向／兩 purpose、聲學、裝置與所宣稱網路均有直接證據；fresh diff review＋必要回歸＋文件一致，才勾母包；H1、H2          | 未開始                                                                 |

**預設施工順序：** W01 → W02 → W03 → W05 → W06 → W04 → W07 → W08 → W09.1 → W10 → W11 → W12。W10.1 素材準備可提前；W04.2/W09.2/H 的外部條件受阻時，繼續不依賴它的工程任務，保留阻擋狀態。表內前置優先於順序；W03 母包仍須 W02 完整驗收，不因可提早編寫 W03.1 而提前勾完成。

### 可重現的驗證入口

以下從 repo root 執行，逐個命令成功才下一個；這是施工驗證配方，**本次文件修訂沒有執行產品測試**。C1–C10 為既有入口，新增案例必須被 test discovery 收到；未收錄或 skip 不算驗過。每次依變更選對應入口，W12 才做整合回歸，不要求每小改動重跑兩小時。

| 代碼 | 命令／操作                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1   | `pnpm -F web exec vitest run src/settings/settings-store.test.ts src/deployment.test.ts src/components/AudioLevelMeter.test.ts src/components/HealthRow.test.ts`                                                                                                                                             |
| C2   | `pnpm -F web exec vitest run src/providers/audio-engine.test.ts src/providers/capture-lease.test.ts src/providers/transcription-audio.test.ts src/providers/transcription-audio-adapter.test.ts src/providers/coalesce-handlers.test.ts`                                                                     |
| C3   | `pnpm -F web exec vitest run src/providers/meeting-recovery.test.ts src/providers/recovery-attempt.test.ts src/providers/transcription-session.test.ts src/providers/gemini-transcription-provider.test.ts src/providers/openai-transcription-provider.test.ts src/providers/online-hooks-lifecycle.test.ts` |
| C4   | `pnpm exec playwright test --config tests/e2e/native-audio.config.ts`                                                                                                                                                                                                                                        |
| C5   | `pnpm exec playwright test --config tests/e2e/pure-captions.config.ts`                                                                                                                                                                                                                                       |
| C6   | 分別執行 `pnpm exec playwright test --config tests/e2e/playwright.config.ts caption-longtask.spec.ts` 與 `pnpm exec playwright test --config tests/e2e/native-caption-performance.config.ts`                                                                                                                 |
| C7   | `pnpm exec playwright test --config tests/e2e/continuity.config.ts`；另以一般 config 執行 `online-failover-latency.spec.ts`                                                                                                                                                                                  |
| C8   | 分別執行 `pnpm -F web exec vitest run src/store/meeting-archive-client.test.ts src/store/meeting-outbox.test.ts src/store/caption-store.test.ts` 與 `pnpm -F @meeting-audio/online exec vitest run src/storage/meeting-repository.test.ts src/storage/meeting-export.test.ts src/routes/meetings.test.ts`    |
| C9   | `pnpm test:service`；只測隔離 owner/child，不停止使用者的會議服務                                                                                                                                                                                                                                            |
| C10  | `pnpm -F @meeting-audio/online exec vitest run src/config.test.ts src/routes/session.test.ts src/routes/transcription.test.ts src/routes/gemini.test.ts src/routes/gemini-transcription.test.ts`；另補本機 CONNECT 整合斷言                                                                                  |
| H1   | 依 A2/A5/N2/V3 場景逐項真實操作；記裝置、Chrome、網路、步驟、期望／實際、缺口及人工介入。沒有設備／公司網路不可用 mock 取代                                                                                                                                                                                  |
| H2   | 依 A3/A4/V1/V2 執行真服務資格、聲學與長測；先有有效費用上限及素材。記兩家模型／能力／目的、時長、費用與原始事件；不得記 key。LOCAL 不能代替此欄                                                                                                                                                              |

**E2E 前置：** C4/C5/production 效能使用正式產物，先 `pnpm build`，再 `pnpm -F @meeting-audio/online exec node build-bundle.mjs --managed-output ../../.cache/pure-release/server.cjs`。C5 需要 `.cache/live-caption-speech.wav` 或 `PURE_TEST_AUDIO` 指向可用素材，保存 hash；缺檔先補合法測試素材，不以靜音替代語音。LOCAL 禁用 `CAPTION_EVAL_REAL_UPSTREAM=1`，確認 setup 未繼承任何新加金鑰別名；新增第二 key 支援前也須維持無意外付費呼叫的隔離。

**新增 E2E 的接線責任：** W05/W06 執行者將 `translation-archive.spec.ts`、`origin-recovery.spec.ts`、`storage-faults.spec.ts` 接入適合的既有 LOCAL fixture/config；名稱是候選，不必為符合文件建檔。提交時回填確切 config、命令與案例數，先 `pnpm exec playwright test --config <實際設定> --list` 確認收錄，再執行。不能把一般 continuity server 當作已具備 SQLite/origin 故障 fixture。

**W12.1 長測配方：** 建置與素材前置完成後，依序執行下面兩段；各自兩家並行由既有 config 管理，shell 不平行啟動。至少約四小時牆鐘時間，機器保持清醒，缺 Stop 或中途 runner 結束都不算通過。現有 native globalTimeout 只容納一輪，不能直接改成 workers=1 卻維持原總期限。

```powershell
$previousNativeSoak = $env:NATIVE_SOAK_MINUTES
try {
  $env:NATIVE_SOAK_MINUTES = '120'
  pnpm exec playwright test --config tests/e2e/native-audio.config.ts
  if ($LASTEXITCODE -ne 0) { throw "native soak failed: $LASTEXITCODE" }
} finally { $env:NATIVE_SOAK_MINUTES = $previousNativeSoak }
```

```powershell
$previousPureSoak = $env:PURE_SOAK_MINUTES
try {
  $env:PURE_SOAK_MINUTES = '120'
  pnpm exec playwright test --config tests/e2e/pure-captions.config.ts
  if ($LASTEXITCODE -ne 0) { throw "pure soak failed: $LASTEXITCODE" }
} finally { $env:PURE_SOAK_MINUTES = $previousPureSoak }
```

原生長測兩家各用獨立正式服務與 SQLite：Gemini 5208/5209、OpenAI 5210/5211；不繞過單一寫入者保護。長測前核對 discovery 確實各兩家；既有測試尚未涵蓋的新接管／資源斷言須先補齊。結果存於既有 `.cache/native-soak-results`、`.cache/pure-soak-results`，下次覆寫前將本次證據保存至有 run ID 的子目錄。真 API 長測的時長／預算在 H2 開跑前固定；未固定或未授權則 H2 受阻，不能以兩小時 LOCAL 宣稱雲端長測完成。

**工程收工：** 該項直接行為＋失敗路徑通過、受影響的 C 檢查與 `pnpm typecheck`／`pnpm lint` 通過、fresh diff 無越界與重複架構，回填證據和現況。既有失敗須先釐清歸屬，不能順手降低門檻；本次新增失敗必修。**整體收工：** W01–W12 必要子項完成及所宣稱場域的 H 證據齊全；Gemini 第二 key、未啟動的獨立離線場域不算本輪未完工。不得以縮減雙向備援、雙軌、保存或共同流暢門檻來結案。

### 執行紀錄

- 2026-10-16 16:17：啟動現版 W12 LOCAL 長測基線，證據 `.cache/w12-baseline-20261016-161722`。先兩家翻譯各 120 分鐘，成功才接純字幕兩家各 120 分鐘；使用既有 fixture 與語音素材，保留建置／素材 hash，無真 API。僅持有測試執行緒防睡眠請求，不改電源設定。W04.2 補送資格及四種水位對齊仍未完成；此基線不得提前算 W12 收工，若後續改受測路徑，重驗受影響部分。完成數 18／26 不變。

- W12.1 前置修正，正式 120 分鐘長測未開始，18／26 LOCAL 不變。一分鐘並行預檢重現兩家共用 SQLite writer lease，Gemini 無寫入權限而未送音；沿既有 native fixture 為兩家分開服務／資料庫，未改產品單寫入者保護，修後兩家各一分鐘與 Stop 回收通過。一般回歸另暴露 Stop 取消 SDP 後測試仍回覆的競態；單純 return 會使路由清理等待不結束，改為僅對已確認 net::ERR_ABORTED 的請求結束該攔截處理。最終原生 RTP／預檢 6 案通過（36.2 秒）、相關 eslint／typecheck 與差異檢查通過。未新增產品模組、依賴或放寬斷言；短測不計入長測驗收。W04.2 仍缺擷取／提交／上游完成區間對齊及真 API 補送資格；目前不同 pipeline 各自計時，無法以保留區末端冒充送音精確水位，自動補送維持未啟用。正式長測待工程前置收束。證據 `.cache/w12-fixture-verification.json`。

- W04.2 施工中：翻譯兩家 audio／transport 中斷沿既有 coalescer 與 bound writer 保存 estimated 缺口，Stop／替換／unmount 結束該 owner，退役尾文仍保存。此次補齊兩家 WebSocket 背壓第一幀丟棄通報；重新送音後仍待有效內容才恢復健康。最終版本 web 單元 908 項、Chrome／真 SQLite 中斷與短暫背壓 5 案、正式建置雙向接管 2 案通過；typecheck、scoped eslint、build 通過（index-T4WMil6a.js）。音訊／雲端上游受控，不是實機或真服務資格驗收。未新增 manager／timer／queue／DB／依賴。captured／submitted／provider-completed 對齊及補送資格／限速／費用仍待驗，補送未啟用；12／26 LOCAL 不變。證據 `.cache/w04-delivery-verification.json`。

- W04.1 完成（LOCAL capture 範圍），12／26 LOCAL。固定 60 秒／960,000 Float32 樣本（3,840,000 bytes）沿 capture owner 保留；無 provider 消費者期間覆寫即發同一 gapId，最多每秒更新一次，reclaim／Stop 補最後範圍，沿原 archive 保存；正常淘汰不誤報，跨會議不誤寫。C2＋buffer／retention 88 項、typecheck／scoped eslint／build 通過；原生 3／10／30／90 秒容量六案沿前輪證據，新增停流兩分鐘不造樣本單元。Chrome 原生 16／48 kHz 與同時字幕／SQLite 保存各 90 秒，兩案各 2,900 段 ID 全數一致、零 >50 ms long task、31 次更新合成一筆精確缺口；分別驗 reclaim 及直接 Stop、清 PCM／新 epoch。效能證據是 oscillator 原生 capture＋受控 normalized 字幕／真 DOM／SQLite，不含真 ASR、provider 送音成本、DOM p95/p99 或實機睡眠。兩案分兩次命令：首輪純字幕未設定顯示 task 失敗，修正測試前置及加入 seed-visible 檢查後單案通過，非單輪全綠。正式 bundle index-DqpI6nqU.js 已建置，Chrome 使用 Vite。沒有新 manager、queue、timer、DB 或依賴。W04.2 仍待提交／上游完成對齊、持有 capture 時的 transport 停送缺口、各服務補送資格與接線；未啟用補送、不宣稱零漏音。證據 `.cache/w04-retention-verification.json`。
- W04 任務邊界核對：依原任務表，W04.1 驗 capture ring／容量／覆寫／Stop；submitted、provider-completed 對齊及 adapter 停送／補送屬 W04.2。前輪暫列 W04.1 的 transport 區間待辦回列 W04.2，沒有刪除要求或宣稱上游確認。W04 母包仍未完成。

- W04.1 缺口接線已驗：未有 provider 持有收音期間覆寫的 PCM，在重新取得或 Stop／釋放時送 normalized retentionGap，畫面持續提示並沿原 archive 保存 exact_capture_range；meetingId 不符拒絕寫入。跨場誤寫及 Stop 漏報均先紅後綠。最終前端 899、contracts 35、typecheck／scoped eslint／build 通過；Chrome 16／48 kHz 各 90 秒實際 worklet→共用事件橋接→畫面→SQLite 匯出兩案全過（3.1 分鐘），正控制有效且收音觀測期間零 >50 ms long task。正式 bundle index-Co6Cusew.js 已建置，但上述 Chrome 使用 Vite。未新增 manager／DB／依賴。仍未驗完整字幕負載下的新增收音成本；此版只在 reclaim／Stop 報告已知無 owner 區間，不涵蓋仍持有 capture 的 transport 停送，亦未啟用補送。11／26 LOCAL 不變，W04.1 維持施工中。證據 `.cache/w04-retention-verification.json`。

- W04.1 容量驗證：原生六案全過（3.9 分鐘），16 kHz 3／10／30／90 秒與 48 kHz 3／90 秒消費者空窗；兩個 90 秒皆保留 960,000 樣本、缺少區間 4608→484864，容量與 missing 精確一致。正控制有效、六案零 >50 ms long task、同次 acquire／epoch、Stop 清除／新 epoch 全驗。只改既有測試；這是收音保留路徑，不冒充完整字幕負載或真上游。尚須將未確認送音區間的覆寫接可見與持久 gap，不能用 owner／ready 當上游完成，11／26 不變。證據併入 `.cache/w04-retention-verification.json`。

- W04.1 capture 接線：LiveCapture 持有單一 60 秒保留區及獨立 PCM 管線，跨 provider 消費者釋放存續，取消／最後 owner／被取代皆清除。所有權紅測後相關 47、完整前端 894、typecheck／eslint／build 通過；Chrome 真 worklet 16／48 kHz 空窗約 3 秒保留 51712／51200 樣本、不重開 capture、Stop 清除及新 epoch 兩案通過。正式 index-BmapzY5T.js 的 Gemini PCM／socket 恢復回歸一案通過。覆寫未確認區間與 gap 保存、長空窗原生 sample 核對、效能尚待驗；不稱可補送，11／26 不變。證據 `.cache/w04-retention-verification.json`。

- W04.1 開工：核對現有 provider-owned PCM 管線與 capture lease 生命週期，確認重連空窗需要 capture-owned 保全。固定容量 ring 已有 9 項單元、eslint／web typecheck 通過（`.cache/w04-buffer-green.log`、`w04-buffer-typecheck.log`），預設／上限 60 秒 3.84 MB，不隨 wall clock 偽造樣本。尚未接 capture owner、gap 保存及原生音訊，不勾完成；11／26 不變。初始 red 為新檔缺失，不冒充功能紅測。

- W06.2 收工（LOCAL）：27 案故障矩陣全過（含兩目的 ACK 遺失），C8 前端 102／後端 25、typecheck／lint 通過；90 秒正常／archive 停用對照／進行中匯出均零 >50 ms long task，全文 ID 一致。主輪兩案過、匯出因測試誤點停用選單失敗，改調既有 download 函式後單案通過，保留原 UI 政策及門檻。正式版 20／6,000 正常與慢寫入／hang 四案沿用前輪。測試 fixture 僅因兩個實際使用點抽共用；產品無新增 DB／依賴／manager。11／26 LOCAL，下一項 W04.1；真服務／場域／長測仍交原 W12/H。原始紀錄、版本、SHA256 與限制見 `.cache/hardening-w06-20261015/w06-2-verification.json`。

- W06.2 最新故障回歸：25 案主輪 23 passed／2 quota failed；新 HTTP polling 在補建前收到明確 MEETING_NOT_FOUND 即拋錯，測試改只對該暫態回傳 false，保持期限及其餘錯誤，兩案重跑 2 passed。非單輪全綠。三個變更測試檔 eslint／prettier 通過；證據與最終 SHA256 併入 `storage-performance-verification.json`。C6 剩餘項未完成，維持施工中。

- W06.2 效能續作：正式 build `index-2LmsC_26.js`，20／6,000 段正常與 6,000 段慢寫入／worker hang 四案通過（4.6 分鐘）。各 60 秒均零 >50 ms long task，207／6,187 段匯出及唯一 ID 一致。慢寫入為隔離 worker 副本 202 次×200 ms 等待，hang 為一次真 worker 阻塞、沿原期限重建；不是真磁碟硬體故障。首輪測試租約清理遺漏導致兩案未開始量測，修正測試後四案通過，沒有放寬產品保護。仍待 90 秒、保存開關／進行中匯出對照及最終回歸審查，不以 rAF 代替 event→DOM 驗收。證據 `.cache/hardening-w06-20261015/storage-performance-verification.json`，10／26 不變。

- W06.2 worker 續作：純字幕／翻譯各注入 exit／hang，4 passed（47 秒）。hang 未縮短產品期限，舊 worker 於 15034.99／15037.18 ms 退出，退出前成功提交均為零；經實際 UI 重試完成全文、修訂與 gap 核對。預設重啟 worker 由當前來源重建，隔離資料目錄已釘住；既有 opening Promise 及 await close 維持單 writer，未增加產品管理器。原始證據 `.cache/hardening-w06-20261015/storage-worker-final.log`。剩餘 C6 故障效能與最終回歸審查，10／26 不變。

- W06.2 SQLite 續作：只擴充既有 storage-faults fixture；測試 bundle 用原生 max_page_count 觸發 SQLITE_FULL（errcode=13），獨立在 COMMIT 邊界注入 SQLITE_IOERR，第二條真連線持有 EXCLUSIVE lock。純字幕／翻譯六案通過，DB 失敗後零部分提交、IDB 待存保留，解除故障後 UI 重試及 JSON 修訂／譯文／重複發言／gap 一致。初始與重啟目的地均固定隔離資料目錄，最後版本另重驗 FULL＋既有 IDB 案 2 passed；共 21 案已收錄，不宣稱本輪全跑。沒有產品碼、資料庫、依賴或重啟 owner 變更。剩餘 worker exit／hang 單 writer 閉環與 C6 故障效能，10／26 不變。證據 `.cache/hardening-w06-20261015/storage-sqlite-verification.json`。

- W06.2 IDB 續作：Chrome CDP quota=1 byte 真正觸發 QuotaExceededError；quota=0 在此次 Chromium 不構成限制，未將初始探測當通過。原生 quota 重現翻譯首次 metadata 未落盤時重試失敗，continueMeeting 改沿用已驗證的 pendingMetadata；先有單元與 Chrome 紅測再修復。blocked 為原生 open request 的 blocked 事件注入，恢復後刪除測試 DB 驗遲到連線無洩漏。最新完整 storage-faults 15 passed、相關前端 102、typecheck/lint 通過，兩目的原文／譯文修訂、重複發言與 gaps 比對一致。剩餘 SQLite／worker 故障完整閉環及 C6 故障效能，仍 10／26 LOCAL。證據 `.cache/hardening-w06-20261015/storage-idb-verification.json`。

- W06.2 HTTP／匯出續作：純字幕及翻譯各注入 400／413／422，驗可見提示、停止自動重送、按既有按鈕恢復、真 SQLite／JSON 的重複發言／修訂／譯文／缺口一致。兩目的另以 exports 檔案阻擋目錄建立造成真匯出失敗；重現並修復翻譯 DB 已存時隱藏重試按鈕。主輪 10 passed／1 failed 後，修復版兩匯出案 passed；相關前端 101、typecheck/lint 通過。retryBlocked 沿用原狀態移到公開 status，不新增重送 owner。W06.2 仍施工中，其餘 D3 個別故障完整閉環及 C6 待驗，10／26 不變。證據 `.cache/hardening-w06-20261015/storage-http-export-verification.json`。

- W06.2 關頁保護／狀態提示續作：單一 App 根 beforeunload 讀取 archive 真 RAM 所有權，同步 checkpoint；純字幕及翻譯 Chrome 均驗原生確認取消、寫回 IDB 後正常重載及文字不失。RAM-only／瀏覽器暫存未 ACK／匯出副本失敗分開提示，無新增 timer 或 owner。相關前端 101、Chrome storage-faults 3、typecheck/lint 通過；完整 D3 獨立故障閉環與 C6 故障效能仍待驗，維持 10／26。證據 `.cache/hardening-w06-20261015/storage-exit-verification.json`。

- W06.2 施工中（不勾完成）：IDB identity 沿用現有 schema 保存每次 RAM 溢出摘要，SQLite gaps 保存永久遺失；manifest 的 lostCount／unsavedSince／unsavedUntil 經重送、後續修訂、worker 重啟及再次結案仍保留。舊請求不能覆蓋成完整保存；跨會議警告分開，RAM-only 遺失標記未落盤前不允許切新場。沒有新增 DB／依賴／timer／worker。前端相關 100、後端相關 25 項通過；新增 `storage-faults.spec.ts` 已接 continuity config，Chrome 注入原生 IDB transaction abort，恢復後實際 IDB→reload→SQLite→JSON 核對遺失、重複發言與 revision。typecheck/lint 通過。完整 D3 fault→UI→修復矩陣、關頁警告與 C6 故障效能尚待驗，不以此局部成功代替 W06.2 完成；10／26 LOCAL 不變。證據 `.cache/hardening-w06-20261015/storage-loss-verification.json`。

- W01.1 完成（LOCAL 能力／基線範圍）：Hybrid Meeting 在 full/online build 均明示雙軌未實作；store 拒絕不可用場景，舊 mic/system 保留來源且顯示更正。W11 仍未完成。
- 驗證：新增回歸先 5 failed，再修復；最終 C1 共 70 passed。Chrome scenario-switch＋online-keepalive＋caption-longtask 共 20 passed；後者 90 秒、2,000 段，零 >50 ms long-task。production 20/6,000 段兩例通過、各新增 187 finals，匯出 207/6,187 筆且無重複 ID，零 >50 ms long-task。
- 新增 `tests/e2e/caption-responsiveness.spec.ts`，以一般 Playwright config 執行：20 次獨立會議，actual normalized callback → DOM，partial p95/p99 50/53.4 ms、final 2.5/2.7 ms；Start 6.3/14.2、Pause 1.9/2.2、Resume 2.8/3.2、Stop 1.7/2.2 ms。60 ms 正向控制實測 69.5 ms，final 同時核對 store status/text。不是螢幕 paint／雲端或真語音測量，純字幕及各種故障壓力仍需後續驗收。
- 量測第一次因候選握手 handler 被誤認為已採用而超時；查明後改等 transport connected 才注入，沒有更動產品或放寬門檻。最終診斷 1 passed；主工作區 typecheck/lint 通過，新增量測檔另跑 eslint 通過。
- 原始分布、production 報告與 Node/Chrome/build/工作樹相關檔案 SHA256 保留於 `.cache/hardening-w01-20261015/`（本機證據，不含金鑰）。既有 bundle 的 import.meta/CJS 警告仍存在，未在此任務擴大修復。
- 審查：能力修正無阻擋問題；修復 reset 測試前置已不可用、final 只比文字可能誤判 draft 的兩項問題。
- W01.2 完成（LOCAL）：兩種 purpose 共用既有 capture lease 試音，顯示實際 track／來源與 PCM rate／DSP、音量與 PCM 進展；服務與保存檢查不呼叫雲端、不保存 PCM。明示 key configured 並非雲端就緒、保存服務可用並非完整寫入驗證，翻譯 archive 與 WASAPI 預檢仍有限制。
- 修復取消未決權限後舊 capture 晚到的所有權競態；取消立即撤銷 lease，舊結果不能取代新收音。試音鎖住開始／設定；會議進行中隱藏試音，修復面板使字幕超出視窗的版面問題。
- W01.2 驗證：capture／adapter／session／archive 9 檔 113 tests 通過；Chrome 場景／keepalive／normalized→DOM 與操作回應 20 tests 通過；production 試音 10 tests、原生 worklet／WebRTC 6 tests 通過。試音涵蓋兩 purpose × mic/system、拒絕／無 track／無 PCM／靜音／服務故障／未決取消，核對實際擷取 API 與使用者手勢、歷史保留及收音釋放。typecheck、正式 web build、最終 lint 通過。
- 試音測試使用 Chrome 原生 AudioContext／MediaStream／AudioWorklet 及合成音訊、本機真 archive；健康 metadata 的 configured 為受控注入，不表示真 key 可用。native fixture 補上正式 SQLite worker 與隔離資料目錄。實機 USB/BT/HDMI、WASAPI、真服務與真人場域仍待後續 H1/H2，W01 不替代這些驗收。
- W01.2 新鮮審查及 running/stopped 畫面檢視完成，無阻擋問題；原始量測與畫面保留於 `.cache/hardening-w01-preflight-20261015/`，正式 web bundle `index-Dm7QeGn5.js`。W01 只結束能力誠實性與本機預檢，未完成雙軌或兩家備援等後續工作。
- 工作區決策：沿用目前 `docs/goal-phase-2` 功能分支及既有未提交內容，不另從過時 HEAD 重建，不提交或覆寫先前工作。既有未提交功能是本輪實際基線。
- Gemini 第二 key、真服務授權與實機條件維持原範圍；本輪 LOCAL 驗證不呼叫付費 API。

## 第一階段：固定範圍與收音正確

### W02.1 執行證據（2026-10-15）

- 已完成 LOCAL：共用 `capture-health.ts`，由現有 consumer 擁有 timer/listeners；Gemini、OpenAI WS、純字幕 VAD 前、offline browser mic 均用實際 PCM 回呼。WebRTC 沿既有 worklet 增加 4 Hz counter-only probe，僅代表本機 capture，不代表 RTP／辨識完成。未新增 capture owner 或恢復管理器。
- normalized audio reason 分開 stalled／muted／suspended／closed／ended；主畫面顯示原因及下一步。第一個真 frame 才清除舊故障，候選線不發布健康狀態；Stop/Pause 清理監測，舊回呼不復活。停流不被既有 silence/connected 蓋掉，也不觸發 receive-wedge 雲端重連。
- 修正 Stop 後同 instance 重用已取消 pending acquisition；回歸改用兩個獨立 permission promise/stream，驗舊 grant 釋放且新 stream 不被停止。另修正新 monitor 沿用舊 fault、WebSocket closing 時錯把未送出等同未收音，均先有有效紅測再修復。
- 驗證：完整 web 47 檔 691 tests、contracts 32 tests 通過；最後 WS closing 修正另跑 WS/Realtime 138 tests 與 Chrome WS fallback/renewal 1 test 通過。正式產物 native config 22 tests 通過，包含 6 個 capture-health 故障案例、10 個預檢及 6 個原生音訊／WebRTC 回歸；補強的 WebRTC suspend/resume 2 tests、DOM 停流計時 2 tests 通過。兩家純字幕 C5 共 2 tests 通過，含真 VAD、IndexedDB/SQLite、停止、重載、校訂與匯出；上游仍為受控替身。
- Chrome 場景／keepalive／操作與字幕延遲 20 tests 通過。舊 worklet 替身原本只報 RMS、不送 frame，導致收音故障正確阻擋接管；確認失敗原因後補齊替身送幀與 disconnect 清理，沒有放寬產品或測試門檻。
- 停幀到 DOM 故障提示：翻譯 1817.4 ms、純字幕 1930.1 ms；MutationObserver 計時，另保存輪詢觀察時間，不混為實際延遲。兩例均跨過既有 30 秒上游停字期限，未另建雲端 session。這是各一次前景合成音源實測，不是背景／實機睡眠的時間保證。
- 最新 normalized→DOM partial p95/p99 36.5/41.6 ms、final 1.5/1.9 ms；Start 3.3/12.5、Pause 1.4/2.3、Resume 1.9/2、Stop 1.3/1.4 ms，20 次獨立會議。60 ms 正向控制實測 62 ms。原始樣本已保存，仍不代表螢幕 paint 或雲端辨識延遲。
- 審查修復故障說明造成的內層橫向溢出（1280 px 視窗內內容達 1505 px）；以內層 scrollWidth 回歸，兩 purpose 畫面均已檢視。最終 build/typecheck/lint 通過；build 的既有 import.meta/CJS warning 未擴大處理。最後 WS closing 兩行修正後重建 web，並以對應 unit/Chrome WS 路徑驗證；未重跑不受影響的 native 四路。
- 證據：`.cache/hardening-w02-20261015/`；Node v24.14.0、Chrome 155.0.8059.40，最後 web bundle `index-1WlQVxs4.js`。實體 USB/BT/HDMI、睡眠／鎖定、WASAPI、真服務、公司網路與長測仍未放行，下一項 W02.2。

### W02.2 執行證據（2026-10-15；工程已驗，H1 待驗）

- 新增 production Chrome 裝置選擇回歸，分別沿翻譯／純字幕入口讀取持久化 `micDeviceId`，直接檢查送給 `getUserMedia` 的 `deviceId.exact`。指定裝置不存在時，要求保留可見故障，其他裝置的 `devicechange` 不得改收預設麥克風或重複開啟收音。
- 舊正式 bundle 兩案皆有效失敗：實際 constraints 只有 DSP／channelCount，缺少指定裝置。紅測與 trace 保存於 `.cache/hardening-w02-20261015/device-red/`；修正後回歸結果見下。這是 Chrome 內受控裝置介面的證據，不是 USB／藍牙實機驗收。
- 已接兩 purpose 的共用裝置選擇器；exact ID 與 lease identity 一致。成功 acquire 時保存實際硬體 ID，`default`／`communications` 不作恢復身分；原裝置重新可用且 permission 仍 granted 才自動重取一次。沿用現有 retention，沒有第二個 owner／retry manager。
- 新增競態回歸：devicechange 先於 ended、ended 後 settings 消失、Stop 時 pending enumerate／late grant、舊 permission rejection 不影響新會議、重新拔除。Pure Stop／unmount 先撤銷恢復意圖，再等待清理；分享拒絕只提供一次明確的人工重新分享。
- offline／hybrid browser mic 接同一 lease；人工及自動恢復依原 sessionMode 路由。兩個 Chrome 操作案例驗收拒絕後人工重試仍送往受控本機 WS，沒有呼叫雲端 session，Stop 後停止送音。這只證明瀏覽器路由／音源行為，不代表離線模型或 WASAPI 已合格。
- 新增 wall-clock-only estimated gap，沒有 startSample／endSample／sampleRate；同 stream 共用 epoch，新 stream 使用新 epoch。Chrome 注入 10 秒 clock 跳變，驗提示、收音恢復且不另建上游 session；純字幕經真 IndexedDB／SQLite 保存後重載並匯出 JSON，保留完整估計區間、pending=0，仍明示逐字稿尚待核對。兩 purpose 截圖已檢視；此測試不等於實體睡眠。
- 本輪完整單元：web 49 檔 714、online 16 檔 157、contracts 6 檔 34，共 905 tests 通過。正式 build 原生 Chrome 31 tests 與既有 Chromium 回歸 20 tests 通過；包含新增 4 個拒絕／選擇、3 個裝置恢復／Stop/Pause／缺口、2 個 offline/hybrid 人工路由案例。兩家純字幕 C5 2 tests 通過（真 VAD、IDB／SQLite、重載、校訂、匯出，上游仍為替身）。build/typecheck/lint 通過。
- 最終 fresh diff review 移除 Pure Stop 在 await 後的重複 retention 取消，保留 await 前單一撤銷點；重建 web 並重驗純字幕原生裝置恢復／late grant／Stop／缺口保存案例 1 test 通過。最後 bundle 為 `index-BWJjymmR.js`；上述完整回歸是在此一行清理前執行，未冒稱重新跑過全部。
- 本輪前景 Chromium 147 的 normalized→DOM：partial p95/p99 36.4/42.5 ms、final 1.8/3.5 ms；Start 4.4/17.4、Pause 1.9/3.3、Resume 3.1/3.7、Stop 2.0/2.1 ms，各 20 次；60 ms 正向控制 64.4 ms。這是受控輸入的 DOM／操作回應，不是 paint 或雲端辨識延遲。
- 證據位於 `.cache/hardening-w02-20261015/` 的 `device-gap-green`、`w02-2-native-regression`、`w02-2-browser-regression`、`w02-2-pure-regression`、`w02-2-final-stop` 及 `w02-2-verification.json`。真實 USB/BT/HDMI、睡眠／鎖定、OS 收音指示及 WASAPI H1 仍未驗；W02 母包不勾完成。缺硬體只阻擋相應場域放行，下一項可執行 W03.1。

### W01 現況與場景能力一致（對應 A1）

- [x] 保存實際 build／工作樹涉及檔案雜湊、runtime、部署入口、啟用 purpose 與單一 provider；不記 key。
- [x] 用既有字幕效能案例記錄本機呈現、操作回應、長任務及歷史量體基線，作後續每個受影響改動的對照；不新增基線管理系統。
- [x] 分清純字幕／翻譯、實體／線上／混合、線上／離線模式，不讓同名 Hybrid 暗示不同能力。
- [x] 修復混合場景描述與單音源路由不符；真正雙軌完成前顯示限制，不能把隱藏選項當雙軌完成。
- [x] 加開會前本機試音：實際音源／裝置、audio track、音量、PCM 是否前進、保存是否可用；不以 key 存在或 socket open 顯示全部就緒。

**驗收：** 選每個可用場景可追到實際路由；取消權限、未分享音訊及服務不可用有明確下一步；單 provider／單 key 環境可完成預檢。

### W02 收音生命週期與裝置恢復（對應 A2；前置 W01）

- [x] 獨立偵測 browser PCM 停流，分辨靜音、mute、ended、context suspend，不靠新 frame 到來才發現停幀；實體睡眠／鎖定與缺口驗證仍列 W02.2/H1，未以此項替代。
- [ ] 支援選定麥克風與裝置變更；原裝置可恢復才自動重取，不能偷偷改收另一支麥克風。
- [ ] 停止分享／權限拒絕需要使用者操作時提供單一入口；不反覆開 picker。
- [ ] Stop/Pause 撤銷所有恢復意圖、停止新收音／送音；舊回呼不能復活。

**驗收：** visible suspend、frame freeze、mute/unmute、USB/BT/HDMI、sleep/lock 分別測；歷史保留、故障層正確、Stop 後資源釋放。硬體未測者保持未驗。

## 第二階段：同服務恢復與兩家交互備援

### W03 同服務恢復、續期與兩家交互接管（對應 A4；前置 W02）

**W03.1 完成（LOCAL 範圍）。** 本機錯誤分類、總期限、冷卻及取消已驗；W03 母包仍未完成，真服務與場域資格沒有因此放行。

- Broker 保留 Retry-After 秒數／HTTP-date；兩家翻譯／純字幕使用 normalized failure，auth／unsupported 停止無效自動嘗試，429 冷卻跨 session 重建及 Stop/Start 保留，人工重試不能提前；warm token 也須經同一 gate。未知狀態不當成永久拒絕。
- 沿用 RecoveryAttempt 總期限及 generation 取消，MeetingRecovery 選擇可用服務；較晚 network 不蓋掉永久拒絕或縮短冷卻，超長期限限制單次 timer 並重新核對。沒有新增恢復 manager。
- 原始 401 瀏覽器反例：6.5 秒內 OpenAI mint 7／4 次、Gemini 6／3 次（無／有備援），已修復。OpenAI auth 測試明確分開 idle 預取與人工 Start，不能把合法人工重試誤當自動風暴。warm gate、protocol status/code、409/425、timer、最終握手及本機 worklet 均保留有效紅測到綠測紀錄。
- 最終 OpenAI alternate WebSocket network 不再重拋首把 key 的 auth；本機 Gemini worklet 暫時失敗只重試原服務，不誤觸跨廠。新鮮審查包含實際未追蹤的 helper／scheduler／session 檔案，不能只依 git diff 判斷。
- 最終快照重跑 `pnpm test`：contracts 34＋web 775＋online 161＝970 passed。一般 Chrome 同輪 39 passed（3.2 分鐘）：`recovery-policy.spec.ts meeting-recovery.spec.ts online-keepalive.spec.ts online-failover-latency.spec.ts`，使用 `tests/e2e/playwright.config.ts --workers 1`。記錄 `closure-unit.log`、`final-browser-current.log`。
- 正式 bundle `index-CqIAyV9B.js` 的 native config 35 passed（前輪已完成，同產品快照），含原生收音／WebRTC／offline-hybrid 路由及兩家純字幕 401/429 四案。純字幕拒絕案例驗 Stop 釋放、已保存／待保存 0 筆及跨 Stop/Start 冷卻；該四案沒有 ASR 文字，不作全文保存／辨識品質證據。
- build／typecheck／lint 與 diff check 已通過；收工證據及來源 SHA256 見 `.cache/hardening-w03-20261015/w03-1-verification.json`。所有上游故障為受控注入；真雲端、實體 USB/BT/HDMI、睡眠／鎖定、WASAPI 與場域長測仍待驗。W03.2–W03.4 不因本項通過而完成。

**W03.4 施工紀錄：** W03.4 完成（LOCAL）：翻譯恢復須當前非空原文或譯文才恢復健康；空白／控制訊息不掩蓋停字，正常靜音不重連。反覆停字先給同廠恢復機會，第二次獨立停字後握手仍無內容則沿既有 MeetingRecovery 跨廠接管；不新增 timer、依賴或資源 owner。兩家有效紅測後，完整單元 1061（34＋860＋167）、Chrome C7 37 案、C4 原生音訊 35 案通過，build/typecheck/lint 通過；本次收工另重跑 provider/hooks 222 項通過。正式 bundle `index-CUiIC-Jd.js`；受控字幕恢復 Gemini→OpenAI 2242 ms、OpenAI→Gemini 2146 ms、OpenAI 同廠 1133 ms，三案通過。上述為本機受控上游證據，不代表真雲端延遲、百分位數、硬體或場域長測；W03 母包仍待 W12/H2。證據 `.cache/hardening-w03-4-20261015/w03-4-verification.json`。目前 7／26 LOCAL 完成，下一項 W05.1 翻譯寫入既有 archive。

**W03.3 最終驗收：** W03.3 完成（LOCAL）：純字幕 OpenAI↔Gemini 接管共用既有 recovery、capture lease 與 archive，首筆有效內容才宣告恢復；同廠／跨廠首試分別 2／1 秒，後續退避與 Retry-After 保留。修復跨廠待內容期間續期 activate 拋錯後不再重試的漏口，有有效紅測及 55 項針對性綠測。最終 1049 單元（34＋848＋167）、build/typecheck/lint 通過。Chrome 完整雙向故障矩陣 12 案於前版通過；最終 bundle `index-CtnNkZWv.js` 重驗兩方向時序與同廠續期 4 案通過，OpenAI→Gemini 2396 ms、Gemini→OpenAI 2460 ms；翻譯共用排程回歸 15 案通過。核對 meetingId、purpose、缺口保存／重載／匯出、Stop 與單次收音。唯讀審查修正後未發現此範圍其他阻擋。以上為本機 VAD／IDB／SQLite＋受控上游，非真雲端、百分位數或場域長測；真服務資格仍交 W12/H2。版本、原始時序與雜湊見 `.cache/hardening-w03-renewal-20261015/w03-3-verification.json`。

**W03.3 施工紀錄（歷史）：** W03.3 施工中：純字幕 session 已接既有 `MeetingRecovery` 目標與兩家 transcription adapter，實際 backend 與使用者偏好分開；能力資訊優先讀 transcription taskCapabilities，沿用 capture lease／archive，沒有新增恢復 timer。跨廠連線需首筆非空文字才宣告恢復，等待狀態跨同廠續期保留；備援啟動拒絕不得卡死重試。新增 13 個單元涵蓋兩方向、scope／冷卻、能力更新、Stop 晚回呼、備援拒絕及內容前續期，保留有效紅測。最後完整單元 1043（34＋842＋167）、build/typecheck/lint 通過。修正內容前續期前的正式版本：Chrome 10 案通過（2.7 分鐘），涵蓋雙向成功／目的端拒絕／雙端拒絕／接管 Stop 與同廠續期；最後修正版另重跑雙向接管與同廠續期 4 案通過（2.3 分鐘）。既有單廠 401／429 4 案於前版通過。均使用真實本機 VAD／IDB／SQLite及受控上游，驗一次收音、Stop 後無送音／重連、全文重載匯出，不是真服務驗收；不同版本證據分開。尚待首有效內容延遲、跨廠缺口／meetingId／purpose 精確核對、人工重試語意與最後收工審查，W03.3 不收工。證據 `.cache/hardening-w03-renewal-20261015/cross-provider-verification.json`。

**W03.2 可執行切分（施工前診斷）：** 原本 `armRenewal()` 先停舊線，`start()` 又同時負責握手、VAD 與送音；不可直接並行 start。沿用 `TranscriptionSession` 作唯一 owner，依序補以下行為，全部通過才收 W03.2：

1. 兩家 pure adapter 分開候選準備與啟用：protocol ready 前不可接管，候選準備不送 PCM、不發布 live；以 adapter 測試證明取消候選不釋放 active lease。
2. session 最多各持有一條 active／candidate／retiring，單一接管點先停止舊送音再啟用新送音；候選失敗保留健康主線，Stop 撤銷全部，晚到 ready 不可復活。
3. retiring 沿用既有 5 秒尾文期限，只接受其 final 到既有歷史／archive，不覆蓋新線 partial、health 或 audio level；驗相同文字不同 segment 均保留，不按文字猜測去重。
4. 併發尚未確認或不允許時，維持有界串行續期，明示停止舊送音至新送音期間的 interruption，接既有 gap 保存；不能以 capture track 存活宣稱不中斷。真服務資格交 W12.2，W04 補送未完成前不宣稱零漏音。
5. 補 session／兩家 adapter／store 的上述競態回歸，再跑 pure/native Chrome：分記 ready、接管、首有效內容與 gap，核對 meetingId／purpose、保存及 Stop 回收；不新增恢復 manager 或另一套假上游。

**W03.2 施工紀錄（未驗收）：** 兩家 pure adapter 已拆 `prepare/isPrepared/activate`，準備階段不送 PCM／字幕／音量；保留既有 start 契約與單一 capture lease owner。session 已加候選接管及 retiring final 路由，資格由服務端明確旗標隨 mint 傳到 active provider，未設定時 App 採串行續期；不再使用測試專用 constructor callback。候選本機 VAD/worklet 仍消耗 CPU，不能宣稱零成本準備。

- 新增 session 健康主線測試先重現提前 stop；審查另發現新線失敗／重連會砍掉舊線 late final，兩個內容斷言紅測後修復。舊 final 依自己的 drain owner 保留，不隨 active generation 失效。
- 目前 session 14、OpenAI 33、Gemini 34、capture lease 35，共 116 tests 通過。最終完整單元 991 通過（34 contracts＋796 web＋161 online），typecheck/lint 通過。正式 bundle `index-k2ww4NdU.js` 原生 Chrome 的 capture-health／capture-recovery／pure-recovery-policy 共 13 tests 通過（2.6 分鐘）；這是既有流程回歸，非候選接管整合驗收。證據目錄 `.cache/hardening-w03-renewal-20261015/`。
- 最新資格接線：server 嚴格 true/false、預設 false，兩家各自的旗標隨 mint 傳到 active adapter；Gemini 續期建議上限維持 8 分鐘。操作及重驗範圍見 RUNBOOK；沒有增設 UI poll／另一個管理器。同步 Stop 在 activate 的外部回呼中發生時，不可繼續發 connected、改回 running 或重掛 timer，3 個有效紅測後修復。
- 正式 bundle `index-B1p48hOW.js` 兩家 qualified renewal 各一案通過（1.2 分鐘），沿用 pure-captions fixture 真實本機 VAD／IDB／SQLite，候選 setup 延後 1.5 秒，驗舊線存活、候選 ready 前零 PCM、同一 capture acquire、候選新文字、完整保存／重載／校訂／匯出。前版 bundle 的 OpenAI 先停舊線與 Gemini 未採用續期建議已有效失敗；見 `qualification-red.log`、`qualification-green.log`。附錄的 textObserved 時間是測試觀測點，不冒充精確首字延遲。
- 同產品快照未開併發的兩家既有 pure Chrome 整合另 2 tests 通過（2.1 分鐘），包含原有保存故障、reload／export 與 OpenAI renderer crash 接續。最終 `pnpm test` 1016 passed（contracts 34＋web 815＋online 167），typecheck／lint／diff check 通過；`qualification.json` 記錄來源與 build SHA256。此輪四個瀏覽器案例分兩個命令執行，沒有把單元或受控上游稱為真服務驗收。
- W03.2 補驗：兩家候選拒絕／就緒逾時／準備期間 Stop 共 6 個原生 Chrome 案例通過（4.0 分鐘）；核對主線持續送音、候選零 PCM、Stop 後 16 秒無新連線／音訊、收音軌釋放及保存／重載／全文匯出。首次 4 案因共用 SQLite 下的同名測試紀錄而選取失敗，已以情境名稱隔離，未放寬驗收。產品與正式 bundle 雜湊仍符合 qualification.json；證據 `.cache/hardening-w03-renewal-20261015/candidate-faults.json`。退役尾文整合、精確缺口與 VAD 成本仍待驗，W03.2 不勾完成。
- W03.2 退役尾文補驗：兩家各驗正常接管及新主線故障重連後回收舊 final，共 4 案通過；舊 final 取自真實送音的 commit/activity，在既有 5 秒範圍內回覆，保存／重載／匯出逐段核對一次。完整 pure-captions 14 案通過（4.5 分鐘），產品及 bundle 雜湊符合 qualification.json。本輪修正測試觀察輪詢延遲、按服務分組避免單寫入者租約互撞，並精確選取續接會議；產品期限與寫入保護不變。證據 `.cache/hardening-w03-renewal-20261015/retiring-final.json`。W03.2 仍待退役 partial 不蓋新 live 的瀏覽器證據、精確時序／缺口核對及 VAD 成本，真併發資格交 W12.2。
- W03.2 畫面隔離補驗：新主線已收到實際音訊並顯示 partial 後，注入退役線 partial／final；兩家均保持新主線即時文字，舊 final 進歷史且全文匯出一次。連同新主線故障後的尾文回收，共 4 個 Chrome 案例通過（2.4 分鐘，含較長清理階段；原因尚未確認）。首輪因刻意保留兩條線 final 卻仍等待首筆 final 的測試前置而死結，已修正僅此情境的等待條件。產品未變更，證據 `.cache/hardening-w03-renewal-20261015/live-isolation.json`。精確時序／缺口及 VAD 成本仍待驗；前輪完整 14 案是相同產品、較早測試快照的證據。
- W03.2 時序／缺口補驗：兩家 qualified renewal 最終 2 案通過（1.1 分鐘），送出的唯一推估缺口與重載 JSON 事件及 manifest 完全一致，meetingId 正確、無未完成片段，起訖落在候選 ready 至新定稿 DOM 出現之間。DOM 首次出現由限定此情境的有界 MutationObserver 記錄，不再只用測試輪詢時刻；原始時間與缺口見 `.cache/hardening-w03-renewal-20261015/gap-accounting.json` 及其 raw 路徑。這是各一家一次受控觀測，不是百分位數、真雲端延遲或實際漏音樣本量；缺口保持 estimated／unrecoverable。產品未變更；W03.2 尚待 VAD 資源成本驗收。
- W03.2 資源量測未過：兩家 qualified renewal 各重現候選準備時 56 ms 主執行緒 long task（首輪約 59 ms），超過 50 ms 門檻；修正測試幀紀錄容量後仍各失敗，當前新增效能驗收為 2 failed。每家僅建立 2 個 PCM worklet，均處理音訊並於 Stop 前後斷開；此回收證據不抵銷卡頓缺陷。測試端獨立 observer 保存原始幀／long-task／節點生命週期，見 `.cache/hardening-w03-renewal-20261015/resource-diagnosis.json`。長任務位於候選 worklet 建立前，VAD／ONNX 初始化是待因果驗證的候選來源；下一步驗證既有 ORT proxy worker／本機資產／取消與尾文，不自建重複音訊管線、不放寬門檻。產品未修改，W03.2 不收工。
- W03.2 worker 實驗已撤回：直接啟用 ORT proxy 使兩家啟動失敗；trace 明確指出 CommonJS 打包後無法取得 worker script URL。改用同來源獨立 ESM 可完成初始化，但兩家持續推論仍失敗。原始碼確認 proxy 轉移輸入 buffer、Silero 重用 \_sr；張量失效為待直接驗證原因，尚未取得精確推論例外。已撤回全部產品實驗並重建，web `index-B1p48hOW.js` 與 server SHA256 符合 qualification.json；未留下失效功能或診斷 log。證據 `.cache/hardening-w03-renewal-20261015/proxy-investigation.json`。下一步取得精確推論證據並評估完整 Silero worker 所有權；56 ms 長任務仍未修復，W03.2 維持施工中。
- W03.2 VAD worker 修復驗證：Silero 初始化與推論改由專屬 worker 持有，沿用原有 capture／有界幀佇列；模型與 WASM 同來源，未新增依賴。ORT proxy 直接探針確認重用張量的 buffer 從 8 bytes 被轉移成 0，下一次推論出現 DataCloneError，因此沒有沿用 proxy。正式 bundle `index-BxJcSEcg.js` 兩家候選窗口均無 >50 ms long task，rAF 最大間隔分別 Gemini 13.1／OpenAI 12.8 ms；各兩個 worker 均終止、兩個 worklet 均斷開。完整單元 1029 通過；Chrome 首輪 10 passed／4 failed，修正退役測試的靜音循環與等待前置後，四個退役案例另跑全部通過（32 秒），未放寬產品 5 秒 drain。14 種情境的證據分屬兩個命令，不稱單輪全綠。詳細原始資料與失敗紀錄見 `.cache/hardening-w03-renewal-20261015/vad-worker-verification.json`；原生收音／恢復／401／429 回歸 13 案通過（2.6 分鐘），新增同服務先恢復、候選晚 ready 不可奪權的 session 回歸後 16 案通過。W03.2 本機行為與資源所有權審查已完成；最終靜態檢查與證據雜湊見同一報告。CPU／總記憶體、背景／低效能裝置、真帳號併發與 W12 長測未驗。

- [ ] 同一 provider 單 key 下，network／auth／429／unsupported 分類，Retry-After 跨 session 重建保留。
- [ ] 整體嘗試期限、退避及取消有界；永久拒絕停止對被拒服務的無效自動嘗試，另一家合格可用則接管；兩家均不可用時顯示等待／重試，不假裝已有新字幕。
- [ ] 同服務候選允許且 ready 後才切舊線，失敗不殺健康主線；帳號不允許候選併發時改走明示缺口的重連。
- [ ] 有音但長時間無有效內容需偵測；房間安靜不觸發重連風暴。
- [ ] 交互接管必測 OpenAI→Gemini 與 Gemini→OpenAI；兩家各一 key 即可，purpose、語言／來源、meetingId 保持一致，原廠恢復比候選先 ready 的競態可正確選主線。
- [ ] 候選未 ready 不為啟動備援而拆掉仍健康主線；切換失敗、兩家均失敗、provider 冷卻、Stop/Pause 與遲來回呼均有界，不來回震盪。
- [ ] 保留 meetingId、原稿及 late final 歸屬，Stop 與恢復競態有回歸測試。
- [ ] 接管沿用 `MeetingRecovery` 決定時機與 `RecoveryAttempt` 管單次期限；新舊 provider 的實際生命週期由 session owner 管理。移除本次被取代的 UI timer／重複分支，不能再加一層 recovery manager。

**驗收：** 單服務故障自救＋兩個跨廠方向，分別涵蓋翻譯／純字幕；兩家各一 key、Gemini 無第二 key 的部署須通過。分開量測故障發現、ready、首有效內容，另一家不可用時也要正確退化。基本恢復／接管不等待 W04 重播資格；不能以單廠通過就宣稱交互備援完成。

### W04 音訊保全與各服務補送資格（對應 A3、A4 補送；前置 W02，整合需 W03）

- [ ] 會議級 capture owner 不隨 provider 斷線處置；VAD 前有界 sample-clock buffer，容量與覆寫策略明確。
- [ ] 區分擷取、提交、上游完成與文字保存；沒有上游 sample ACK 不偽造精確完成水位。
- [ ] 逐一驗兩家 provider 的補送速率、活動順序、對齊及費用；未證明支援就不啟用補送。同廠續期與跨廠接管的區間對齊分開驗，不假定兩家輸出相同。
- [ ] 無法追趕時優先保持 live；即使跨廠接管成功，仍標記不可確認／未補區間。交互備援不等於補回中斷內容，不引入尚未合格離線模型填補。
- [ ] 60 秒上限、超容量、重複發言、Stop 清除 PCM、睡眠無樣本均留正確缺口紀錄。

**驗收：** 3/10/30 秒中斷逐 sample／event 核對；90 秒超容量必顯示損失。補送不支援是有效資格結論，但不能標「無缺口恢復完成」。本階段不要求本機補辨識。

## 第三階段：文字保存與取回（可與第二階段獨立推進）

### W05 全模式地端保存（LOCAL 完成；對應 D1；前置 W01）

- [x] 翻譯與純字幕都接既有 archive/outbox；事件在 UI 合併／淘汰前投遞。
- [x] 重連／Pause/Resume 保持會議身分；原稿、譯文、人工校訂與修訂版號可追溯。
- [x] Stop 區分停止收音、仍待存、已保存及待核對；全量匯出不只讀畫面尾段。

2026-10-19 校正細項勾選以符合既有總表；不是新增完成項目，仍為 18／26。證據：`.cache/hardening-w05-20261015/w05-1-verification.json`、`w05-2-verification.json` 及其原始日誌；已核對兩家翻譯結案／20,100 段匯出、純字幕重開／校訂／匯出與 Gemini 校訂補驗的通過紀錄。上游受控，本項僅 LOCAL；真服務、裝置與場域仍依 W12/H 驗收。

**驗收：** 單 provider／單 key 兩種 purpose，各走停止、重開、校訂、全量匯出與 DB 精確比對；已 ACK 100% 取回，正常結案 pending=0。

### W06 origin 與儲存故障閉環（LOCAL 完成）（對應 D2/D3；前置 W05）

- [x] 重現 port 改變導致舊 origin IDB 待送資料不可見的風險；固定後續 origin，保留首次安全選埠。
- [x] 舊 origin 無法存取時顯示待救援未知；不可向占用舊埠的外部服務投遞資料。
- [x] 分別測 IDB quota/blocked、DB lock/FULL/IOERR、worker crash/hang、ACK 遺失、永久拒絕與匯出失敗。
- [x] 修復後重送有去重，RAM 超限的損失不可被已恢復狀態蓋掉。

**驗收：** fault→可見狀態→保留→修復→全文核對形成閉環；字幕不阻塞且不假回報已存。使用隔離資料／測試卷，不填滿系統磁碟。

### W07 備份、還原與升級（LOCAL 完成）（對應 D4；前置 W05/W06）

W07.1/W07.2 完成（LOCAL），14／26 LOCAL。沿既有 IDB identity 的 retired 前綴保留晚到事件/會議資訊/缺口，明確勾選後才與世代切換同交易移存；失敗完整回滾，不自動併入新 SQLite。重開後可下載 JSONL，下載不刪除保留紀錄。最終 Chrome 15 案、前端 921 項、scoped eslint/web build 通過；涵蓋兩目的正常/回覆遺失/取消/晚到內容、真 IDB 回滾、重新開啟與檔案內容核對。後端 47 項沿用前輪且關鍵來源雜湊一致；20,100 段/譯文/修訂/缺口、壞檔/錯版本/中斷/安全副本與舊 writer 證據見報告。備份下載另 2 案已驗。未新增依賴、資料庫或管理器。真 provider 排空、實體斷電/異碟與場域長測未驗，仍屬後續放行限制；JSONL 是可讀保留紀錄，非自動匯入格式。下一項 W08 服務復原。證據 `.cache/w07-backup-verification.json`。

- [x] 使用者可匯出一致性備份，驗 hash/schema；還原前保護現有資料。
- [x] 原稿／譯文／校訂／缺口還原後逐段相同；舊 outbox 與新 schema 相容、舊 binary 不誤寫。
- [x] 同磁碟副本與使用者異碟備份明確區分；不假定已有第二顆磁碟。

**驗收：** 真還原演練與壞檔／錯版本／寫入失敗測試；資料備份不以第二辨識服務存在為前提。

## 第四階段：日常服務與網路

### W08 服務重啟與版本所有權（對應 D5；前置 W06）

W08.1/W08.2 完成（LOCAL），16／26 LOCAL。既有 owner 有界重啟同 build/origin，Stop 不復活；managed bootstrap/寫入核對工作區與 build，錯誤或缺少身分保留待存、停止自動重送，恢復原身分可明確重試。最終正式建置 Chrome 7 案單輪通過（1.1 分鐘）：兩家×翻譯/純字幕重啟續存，以及錯工作區/錯 build/缺少身分；原頁、會議、收音取得與 provider 連線/mint 不變，SQLite/匯出全文一致並結案。純字幕使用既有語音素材、原生 Chrome 音訊/VAD，雲端辨識仍受控；初輪無音訊卻注入結果的兩個測試錯誤已修正，未改產品或放寬斷言。scoped eslint 通過。前輪程序 20、前端 925、routes 13、typecheck 證據沿用，本輪未重跑。新增責任限於一個受 owner 擁有的 HTTP child 與既有 archive 身分檢查，未加資料庫/依賴/另一套恢復管理器。真雲端/實體音源/公司網路/長測仍依 W09–W12 待驗；日常服務未啟停。下一項 W09.1。證據 `.cache/w08-service-verification.json`。

- [x] workspace owner 有界監督原服務、同 build／origin 重啟，超限明確停止，不另開替代服務。
- [x] 使用者 Stop 優先，不自動復活；不殺外物、不在會中 build/update。
- [x] 舊頁同會議重接 broker/archive，尚活的雲端連線不無故拆除。

**驗收：** 真 child crash/hang、Stop race、外物占埠及單例；待存資料正常接續。

### W09 目前服務的公司網路相容性（對應 N2；前置 W01/W03）

W09.1 完成（LOCAL 工程驗收），18／26 LOCAL。已核對既有預檢不宣稱雲端就緒、OpenAI 診斷區分 WebRTC/WS 與 ICE/內容進展、Gemini setup 與有效字幕恢復分離，未新增產品模組。本輪 Node HTTPS/CONNECT/NO_PROXY/憑證與 407 四案、原生 Chrome WSS 三案、後端 C10＋錯誤分類 91 項通過；Chrome 接管/雙端失敗/Stop 四案（22.5 秒）及新建置預檢/真 loopback RTP 六案（35.7 秒）通過，build/typecheck/lint 通過。WSS 成功案僅在隔離瀏覽器對測試憑證 SPKI 例外放行，另驗預設 Chrome 拒絕該憑證、Node CA/proxy 不自動套用 Chrome、瀏覽器 proxy 407 拒絕；不代表正式 CA 信任或真 provider 資格。首輪探針因測試工具匯出名稱錯誤未啟動，修正後三案通過；最終 CONNECT 計數只計目標端點。實際公司/VPN、外部 WSS/ICE/NAT 及真 key 仍交 W09.2/H，S5 未放行。證據 `.cache/w09-network/result.json`。

W09.1 施工中：Node 24.14.0 原生 HTTPS/CONNECT、NO_PROXY、CA 拒絕與 proxy 407 本機 4 案已驗，不新增代理 wrapper/依賴。修正兩家翻譯 token 路由將原始例外/上游正文寫入日誌的缺口，只保留安全分類/狀態碼；4 個紅測後，後端 201、typecheck/scoped eslint 通過。既有 Chrome 雙向接管等待有效內容、雙端失敗保留會議及 Stop 取消重試共 4 案通過（23.1 秒），上游受控，不能代表實際防火牆/WSS/WebRTC 可達。RUNBOOK 已分列三路配置；執行期三路就緒資訊與網路細因診斷仍待核對，W09.2 公司/VPN 環境待驗。維持 16／26 LOCAL。證據 `.cache/w09-network/result.json`。 本輪預檢審查確認本機健康不冒稱雲端就緒；修正翻譯未保存的過期說明，補明公司代理不等於瀏覽器音訊可用。新建置 Chrome 預檢 4 案與真 loopback RTP 2 案通過；RTP 初輪 409 租約隔離問題已以原 15 秒租約到期條件修正，未放寬媒體斷言。外部 WSS/ICE/NAT 與公司網路仍未驗。

- [x] LOCAL 分測 server HTTP、browser WSS、WebRTC media；證據與測試憑證限制見上，真公司網路仍待 W09.2。
- [x] Node 原生 CONNECT／NO_PROXY 以實際本機流量驗證；額外測試 CA 與拒絕未信任憑證已驗，企業 CA 待 W09.2，不關 TLS 驗證。
- [ ] 分別確認兩家現有 key 的網路路徑；一家被拒／不可達時以 W03 接管驗證，兩家皆被同網路阻擋則明示限制。Gemini 第二 key 及第二條網路不作本階段前提。

**驗收：** 本機路徑與授權實際公司環境分開；無公司環境則 S5 未驗，不阻擋已驗的 S1/S2。

## 第五階段：場域操作與品質

### W10 聲學與操作預設（對應 V1；素材準備可提前）

- [ ] 真人人工稿覆蓋近遠講者、噪音、混語、插話、否定、金額與日期；不同 speaker/session 分組校準與驗證。
- [ ] 量測現行 provider 的 DSP/VAD 預設與字幕延遲；不以換模型、換服務作第一個處理手段。
- [ ] 流程簡化為選場景、試音、開始、恢復提示、停止／匯出；錯誤有唯一下一步。

**驗收：** 依既有品質門檻逐場景報告，未過明列；使用者能不讀工程文件完成整場操作。

### W11 真雙來源與特定音源資格（對應 A5；前置 W02–W06）

W11.1 完成（LOCAL 工程驗收）：雙軌各自 source/epoch/擷取與連線所有權、交錯 partial/translation、完整 final、單軌故障隔離、兩目的遠端雙向接管、Stop/取消/晚到授權與回呼、翻譯暫停重整續接、SQLite/IDB/JSON 保存一致均有直接本機證據。完整 Chrome 雙軌 19 案通過；獨立審查發現遠端休眠缺口未沿用原始區間，已修正既有 coalescer，新增紅綠單元及兩家原生 Chrome 休眠時鐘跳變/接管/保存重開 2 案通過。修正後全專案 1185 tests（contracts 36/web 938/online 211）、typecheck/lint/build 通過；最終差異審查完成。上游及翻譯收音為受控替身，純字幕/獨立擷取包含原生 PCM/VAD；不代表真辨識、實體休眠或帳號併發資格。W11 母包/S4 仍未放行，公開 hybrid 維持停用，真併發、回聲與輸出裝置交 W11.2/H。目前 17／26 完成 LOCAL；Gemini 第二金鑰維持延後。證據 `.cache/w11-capture-verification.json`。

- [x] mic＋remote 真分軌，各有來源／epoch／故障狀態，單軌故障不停止另一軌（LOCAL；真場域交 W11.2）。
- [ ] 兩軌可以使用同一 provider，但需先驗帳號併發與成本；正常雙軌及切至另一家的情況各自驗證，不依賴 Gemini 第二 key。
- [ ] 優先使用已可用的 browser capture。WASAPI 若場域確實需要，才獨立取得 N3 中的擷取資格；不以安裝離線辨識引擎作 browser 場景前置。
- [ ] 回聲重複、跨來源時序、雙軌保存／匯出及硬體輸出變更分別測；來源不是語者。
- [x] 沿用現有 coalescer，雙軌各自有界保留最新 partial／translation，final 全量保存，不新增第二份 caption store（LOCAL）。

**驗收：** 真雙軌通過才放行 S4；原服務不允許雙連線時明示不支援，單軌可獨立放行，不偷偷用備援完成測試。

### W12 雙服務整合、交互備援與正式場域放行（對應 V2/V3；依各場域前置）

- [ ] 兩家 adapters 各自通過 LOCAL 與故障自救；再於 OpenAI 一 key＋Gemini 一 key 的部署驗證雙向自動接管。Gemini 第二 key 必須未配置，不能被測試偷偷當成前置。
- [ ] 兩家×翻譯／純字幕四路各 2 小時 LOCAL 原生音訊長測；另測兩方向交互接管、原廠搶先恢復、目的端失敗、雙端失敗及 Stop/Pause，核對音訊、有效文字與保存時間序。
- [ ] 真人／實機／公司網路及授權真 API 長測分開；沒有有效預算不新增付費測試，沒有素材／設備不冒充通過。
- [ ] 場景至少 3 次獨立操作，記人工介入；同服務可恢復故障人工救援 0 次，權限／硬體／持續服務停機按例外契約處理。
- [ ] fresh review 對照 W01–W12，每個放行場景列必要工作、實證、限制與未驗項；更新 PROJECT_STATE/TODO。
- [ ] 前述流暢與穩定共同門檻、每包精簡審查全部納入放行；列出實際新增／刪除的責任與資源，不能只報單元測試數或程式碼變短。

**完成定義：** 選定場景正常運作、同廠恢復與兩家雙向交互備援均達驗收要求，且不依賴 Gemini 第二 key。一家失效可由合格另一家接管；兩家皆停機或共用網路不通時，保留舊內容、顯示狀態並允許停止／重試，不宣稱永不中斷。

## 最後階段：Gemini 第二金鑰備援（暫緩，不阻擋 W01–W12）

### B00 先確認第二把 Gemini 金鑰是否存在

- [ ] 使用者另行提供可用資源並要求啟動時，才確認 Gemini 第二 key 的權限、成本與帳號限制；不要求現在建立第二 key。
- [ ] 未提供時標 not-configured；主線兩家交互備援照常驗收，不把第二 key 缺失當 blocker。

### B02 Gemini 內部換 key（原 N1，最後處理）

- [ ] 只有 B00 成立才啟動 N1；Gemini 主 key 拒絕→第二 key→冷卻後主 key 的策略，須與既有跨廠接管避免競態。
- [ ] 單 Gemini key 的行為不退步，不以多 key 規避限流；完成前不宣稱 Gemini 具備內部第二 key 備援。

### 保留能力：離線與本機補處理（N3/N4）

有實際模型／算力且相應工作啟動後才驗資格；不當作雙雲端接管前置、不假定目前可用。S6 全離線需求保留，按獨立場域驗收，不混入線上主線完成定義。

兩家交互備援由 W03/W12 執行，不屬本節後排工作。

**W05.1 施工紀錄：** W05.1 施工中：App 已在兩家線上翻譯啟動前取得綁定 meetingId 的 archive writer，重連／接管／Pause/Resume 沿用，新增獨立保存狀態與 pagehide/Stop checkpoint。Chrome 先重現字幕已顯示但 SQLite 零會議的兩個紅測；目前正式版本兩方向均驗原文／譯文入庫、接管／暫停續接同 ID、Stop 收音回收及重載後 DB 資料一致。慢寫入權限 2.5 秒會誤開雙 provider 的兩個紅測已修復，以既有 recovery 阻擋條件等待保存啟動；舊尾文進新場畫面的單元紅測亦已修復，保存仍留原場。完整單元 1067、C7 37 案為尾文／慢保存最後修正前版本；最後版本另驗相關單元 65、Chrome SQLite 2、連續性回歸 6 案及 build/lint 通過。SQLite／IDB 為真本機，音訊與雲端上游受控，非真服務場域驗收。待補保存啟動期間 Stop／保存故障、重開續接 revision、舊快照遷移；結案／全量匯出另依 W05.2。完成數維持 7／26 LOCAL。證據 `.cache/hardening-w05-20261015/app-verification.json`。

**W05.1 續接與舊快照施工紀錄：** W05.1 續接與舊快照補強：App 已接 restoreTranslationSnapshot，先讀原會議 metadata／修訂序號，清空既有待送，再只匯入 archive 缺少的原文／譯文；已存修訂優先，舊快照保留，僅明確 MEETING_NOT_FOUND 才建立會議。未增加資料庫、queue、timer 或依賴。ACK 遺失重試不重複、未知 401/404/503 不誤建會議，client/outbox 41 項通過；正式 bundle index-nyg5R59v.js 的 Chrome 兩案通過（44.9 秒），涵蓋兩家舊快照匯入、雙向接管、Pause/Resume、進行中 reload 後同 ID 續接、既有修訂不變，以及保存啟動中 Stop 後不重啟收音。build/typecheck/lint 通過。曾有一輪案例通過後結束階段未退出，手動中止；加診斷重測及最後無診斷版本均正常退出，原因仍未確認，不宣稱已修復。保存故障的 App 重試閉環仍待補；結案／全量匯出屬 W05.2。W05.1 維持施工中、7／26 LOCAL 不變，真雲端／硬體／場域未驗。證據 `.cache/hardening-w05-20261015/migration-verification.json`。

**W05.1 故障補驗紀錄：** W05.1 保存故障補驗（仍施工中）：新增兩家 503→持續出字／待保存提示→服務恢復自動補存的 Chrome 案例；原會議不變、新會議僅使用同一 ID，故障前後原文逐段核對。兩案功能斷言各於約 45 秒通過，但全域清理再次未退出，已中止命令（退出碼 1），不能列為完整 E2E 通過；待定位測試服務清理原因。C8 本輪前端 95、後端／真 SQLite 24 項通過。這輪只補驗證，未改產品碼；既有契約是暫時儲存故障不阻塞字幕、沿原 outbox 補送，先前「503 必須阻止收音」測試前提已依實作契約修正，沒有更動正式門檻或吞掉故障。完成數維持 7／26 LOCAL；下一個明確收尾項是清理卡住原因與 W05.1 驗收審查，不展開 W05.2。證據 `.cache/hardening-w05-20261015/storage-retry-verification.json`。

**W05.1 收工紀錄：** W05.1 完成（LOCAL）：翻譯事件在畫面合併前進既有 archive/outbox；兩家切換、Pause/Resume、重開續接保留 meetingId，原文／譯文與修訂可取回。舊快照只補缺少資料，ACK 遺失重試不重複；保存啟動中 Stop 不復活收音，503 期間字幕持續、待存可見，恢復後原文補存核對通過。C8 前端 95＋後端／真 SQLite 24 項通過；移除臨時診斷後正式 Chrome 兩案 48.8 秒、退出碼 0，沿用既有 production build。新鮮審查核對 coalescer 先保存、writer 固定身分、App 取消及測試斷言，無新增平行資料架構。完成數為 8／26 LOCAL。先前測試結束偶發未退出仍未查明；兩次診斷均為零待處理請求／連線且正常關閉，不宣稱修復，列為後續程序關閉／整合長測的未解風險。此收工只對應 W05.1，W05 母包仍待 W05.2 結案／全量匯出，真雲端與場域資格未驗。本輪不展開下一項。證據 `.cache/hardening-w05-20261015/w05-1-verification.json`。

**W05.2 收工紀錄：** W05.2 完成（LOCAL，線上兩家×翻譯／純字幕）：Stop 立即停收音，Gemini 尾文完成訊號沿用既有有界 drain，不新增計時器；結案綁定停止時的 meetingId，舊場尾文不得結案新場。畫面區分未結案／已結案並提供保存重試；翻譯兩個匯出入口共用既有下載模組、讀完整 archive，失敗明示，不退回畫面尾段。原有 Markdown 格式保留，資料來自完整 JSON archive。兩家翻譯各驗 20,100 段下載、原文／譯文依片段 ID 對應、既有編輯器校訂、原稿保留及重新結案；純字幕兩家原生音訊基線含重開／校訂／匯出通過。最終產品 bundle index-CKloBGLP.js；完整單元 1079、build/typecheck/lint 通過。翻譯完整校訂證據分兩次命令：OpenAI 案通過，Gemini 案因測試誤用物件列舉順序失敗後改以 ID 精確核對，單案重跑通過（52.2 秒）；不是同一輪全綠。未加產品檔案、依賴、資料庫或管理器。完成數 9／26 LOCAL；測試服務關閉偶爾較慢原因未明，真雲端／場域／長測未驗，不能宣稱全專案完成。證據 `.cache/hardening-w05-20261015/w05-2-verification.json`。

**W06.1 收工紀錄：** W06.1 完成（LOCAL）：managed service 沿用既有 runtime.json 保存首次 originPort，重啟固定原網址；占埠時不靜默換址、不連線或終止占用者，解除占用後可恢復。舊合法網址可沿用，損壞狀態檔保留並拒絕啟動；明確不同 --port 報 migration required／待救援未知，不實際變更。Chrome 真 IndexedDB／SQLite 重現跨埠同名 outbox 不可見，恢復原網址並核對 IPC／HTTP workspace、instance、build 後，原 pending event ID 重送去重、待存歸零且結案成功。9 項 managed service 測試、Chrome 一案、lint 通過；沒有新資料庫、管理器或通用搬移協定。10／26 LOCAL 完成。未知更早網址、localhost 別名、其他 Chrome profile 不宣稱自動救援；日常服務未啟停。證據 `.cache/hardening-w06-20261015/w06-1-verification.json`。
