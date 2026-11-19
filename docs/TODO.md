# TODO.md

2026-11-03 地端開工前的模組隔離已整理：雲端編譯／bundle 不載入地端／Hybrid 實作，舊地端歷史在 online 版保留但不啟動；驗證沿用與目錄責任見[架構檢閱](evals/2026-11-03-module-boundary-review.md)。後續依 L1 契約 source／mode＋跨語言驗證 → L2 runtime／模型資源 → L3 stabilizer／MT worker → L4 MT／ASR 評測逐項開工。這些仍待施工，不因模組整理補勾；共用 contracts／capture／保存變更須驗兩端，地端專屬變更不重跑整套雲端。

2026-11-03：雲端 Stop 漏尾文與同步重啟隔離已修補，直接證據與可沿用版本見[驗證紀錄](evals/2026-11-03-cloud-stop-verification.md)。重開服務／接續工作不重跑已驗且未變更的項目，只針對實質變更補驗。真 API 品質、授權素材／費用與場域長測仍待，完成數 18／26 LOCAL 不變。NVIDIA 後續先獨立評測 Riva Translate 4B v2 MT，再比較 Nemotron 0.6B ASR；[官方調研與門檻](evals/2026-11-03-nvidia-realtime-translation.md)，未列為已採用。

2026-10-22 同日新增直接證據：N3/N4／L2 待辦須包含強制定稿後吞掉上游否定修訂的缺陷（未修），並先核對 launcher 優先 `.venv` 的 CPU Torch／實際推論裝置及套件相容性。既有比較工具不是本任務的英→中品質／串流延遲／CT2 VRAM 驗收工具，不據此選型。詳見 [專業判讀與受控案例](evals/2026-10-22-offline-calibration.md#語音處理再校準新增證據優先於前輪結論)。

2026-10-22 離線／Granite 校準（N3/N4／L2，不變更線上優先排序）：source EOS 缺陷已最小修正並驗真 CT2 測例、87 項離線回歸；不代表完整離線可用。後續仍須核對實際 ASR runtime／可用音訊、分層量測慢的來源、修復 MT worker 卡住後的復原與可見失敗，以及真人英→中品質／持續輸入驗收。Granite 5.0 2B 先獨立驗品質及延遲，未通過不得接正式預設或宣稱串流翻譯。詳見 [證據與採用條件](evals/2026-10-22-offline-calibration.md)。既有完成數不變。

2026-10-19 本批已收束：OpenAI 純字幕 inputAudioRange 接通並通過完整單元 1,204 項、build、scoped eslint，以及兩家 Chrome 基線／SQLite／重載／匯出 2 案。詳見 PROJECT_STATE 同日收尾紀錄及 `.cache/w04-input-range-native-20261019.log`。W04.2 仍待其他 adapter 對齊與真 API 補送資格，自動補送停用；18／26 LOCAL 不變，不將待驗項目冒稱完成。

2026-10-19 W04.2 capture 時鐘映射已接入既有保留區與 lease owner；整數取樣率比例／連續原生時鐘／精確邊界才回傳範圍，其餘為 unknown，44.1 kHz 逐幀取整另有紅綠防誤判測試。63 項相關單元、web build／scoped eslint 通過；原生 16／48 kHz 三秒空窗兩案通過（10.3 秒），固定版本的 48 kHz 九十秒負載通過（1.7 分鐘）：960,000 樣本上限、零 >50 ms long task、2,900 段全部保存、31 次覆寫更新合併缺口、Stop 清除與新 epoch。首輪負載被本輪編輯觸發 HMR 中斷，不計驗收；失敗與固定版日誌分別保存於 `.cache/w04-clock-range-load-20261019.log`、`w04-clock-range-load-final-20261019.log`。provider 送音及上游完成尚未接線，補送未啟用，仍 18／26 LOCAL；此證據非真服務或實體裝置驗收。

2026-10-19 worklet 逾時回歸已收斂：capture retention 對型別明確的首次載入逾時，在同一有效音源上追加一次有界等待；保留每次 5 秒期限、可見 degraded、Stop 取消與失敗清理，不新增 timer／manager／依賴。原生 Chrome 六案單輪通過（30.0 秒），包含 16／48 kHz 時鐘比對、載入拒絕重試、6.5 秒延遲後一次 capture／一次 setup、斷線與 Stop；前端完整 942 項、web build、scoped eslint 通過。舊延遲案的 2 次 setup 假設已按 retention 在連線前初始化的實際路徑改為 1 次；另固定預熱與故障注入時序，保留初始失敗紀錄，未放寬期限或 PCM 斷言。證據 `.cache/w04-retention-timeout-native-final-20261019.log`、`w04-retention-timeout-web-final.log`；相關紅測與中間失敗檔同前綴。W04.2 時鐘標記尚未接入保留區／provider，補送未啟用，仍 18／26 LOCAL，完整長測與真服務／場域尚未完成。

2026-10-19 正式建置效能補驗：既有 Chrome production 20／6,000 段正常保存、6,000 段慢寫入與 worker hang 四案單輪通過（4.6 分鐘），fixture 正常回收。各 60 秒原始紀錄均無 >50 ms long task；匯出 207／6,187 段，筆數與唯一 ID 一致；慢寫入注入 180 次，hang 注入 1 次。使用現有正式產物 index-CCfXzd67.js；受控擷取與上游、真瀏覽器／SQLite，不代表真服務辨識或硬體磁碟故障，也不是 event→DOM 延遲測量。本輪未修改產品或測試程式，18／26 不變，W12 長測仍未通過。證據 `.cache/w12-close-production-performance-20261019.log` 與同名輸出目錄內四份 `caption-performance.json`。

2026-10-19 收尾核對：W12 現版 LOCAL 基線未通過，原 runner 已 exit 1，未重啟。兩路約第 94 分鐘後出現超過 10 小時的觀測缺口，超過原 30 秒門檻；測試及 teardown 逾時，完整 120 分鐘與 Stop 回收未驗，純字幕階段未啟動。系統事件已確認 10/16 17:51:32（台灣時間）因 Application API 進入睡眠，與約第 94 分鐘採樣中斷吻合；發起程式未識別，事件原文見同目錄 `power-events.json`。manifest 記錄防睡眠請求已釋放。證據 `.cache/w12-baseline-20261016-161722`；詳細數據見主清單「收尾核對」。18／26 LOCAL 不變；W04.2 送音對齊／補送資格及真服務／場域驗收仍待完成。先釐清環境中斷原因，不放寬門檻或自動重跑整輪。

2026-10-19 短程效能補驗：修正既有 responsiveness 測試 Resume 後未提供新內容卻等待健康恢復的前置死結；只增加來源文字，保留原 20 次會議、20 partial／20 final 與控制樣本覆蓋。修後 Chrome 1 案通過（19.6 秒）、scoped eslint 通過；normalized→DOM partial p95/p99 41/41.1 ms、final 1.9/2.3 ms，Start/Pause/Resume/Stop 各 20 筆亦均達 p95≤100／p99≤250 ms，pending=0。這是 dev build＋受控上游的本機呈現／操作證據，不代表雲端辨識、production 或長測通過。未改產品碼。原始分布與失敗紀錄見 `.cache/w12-close-responsiveness-fixed-20261019`、`.cache/w12-close-responsiveness-20261019.log`；18／26 不變。 同輪後續既有 caption-longtask 三案通過（5.0 分鐘）：正常保存／停用保存對照／進行中呼叫既有匯出函式，各 90 秒、2,000 段種子、零 >50 ms 長任務；末段字幕持續推進，Stop 後全量保存 ID 與顯示資料一致，進行中匯出 2,009 段。上游受控，非真辨識；未改卡頓測試或門檻。證據 `.cache/w12-close-longtask-20261019.log` 與同名輸出目錄。

W12.1 前置修正，正式 120 分鐘長測未開始，18／26 LOCAL 不變。一分鐘並行預檢重現兩家共用 SQLite writer lease，Gemini 無寫入權限而未送音；沿既有 native fixture 為兩家分開服務／資料庫，未改產品單寫入者保護，修後兩家各一分鐘與 Stop 回收通過。一般回歸另暴露 Stop 取消 SDP 後測試仍回覆的競態；單純 return 會使路由清理等待不結束，改為僅對已確認 net::ERR_ABORTED 的請求結束該攔截處理。最終原生 RTP／預檢 6 案通過（36.2 秒）、相關 eslint／typecheck 與差異檢查通過。未新增產品模組、依賴或放寬斷言；短測不計入長測驗收。W04.2 仍缺擷取／提交／上游完成區間對齊及真 API 補送資格；目前不同 pipeline 各自計時，無法以保留區末端冒充送音精確水位，自動補送維持未啟用。正式長測待工程前置收束。證據 `.cache/w12-fixture-verification.json`。

W09.1 完成（LOCAL 工程驗收），18／26 LOCAL。已核對既有預檢不宣稱雲端就緒、OpenAI 診斷區分 WebRTC/WS 與 ICE/內容進展、Gemini setup 與有效字幕恢復分離，未新增產品模組。本輪 Node HTTPS/CONNECT/NO_PROXY/憑證與 407 四案、原生 Chrome WSS 三案、後端 C10＋錯誤分類 91 項通過；Chrome 接管/雙端失敗/Stop 四案（22.5 秒）及新建置預檢/真 loopback RTP 六案（35.7 秒）通過，build/typecheck/lint 通過。WSS 成功案僅在隔離瀏覽器對測試憑證 SPKI 例外放行，另驗預設 Chrome 拒絕該憑證、Node CA/proxy 不自動套用 Chrome、瀏覽器 proxy 407 拒絕；不代表正式 CA 信任或真 provider 資格。首輪探針因測試工具匯出名稱錯誤未啟動，修正後三案通過；最終 CONNECT 計數只計目標端點。實際公司/VPN、外部 WSS/ICE/NAT 及真 key 仍交 W09.2/H，S5 未放行。證據 `.cache/w09-network/result.json`。

W11.1 完成（LOCAL 工程驗收）：雙軌各自 source/epoch/擷取與連線所有權、交錯 partial/translation、完整 final、單軌故障隔離、兩目的遠端雙向接管、Stop/取消/晚到授權與回呼、翻譯暫停重整續接、SQLite/IDB/JSON 保存一致均有直接本機證據。完整 Chrome 雙軌 19 案通過；獨立審查發現遠端休眠缺口未沿用原始區間，已修正既有 coalescer，新增紅綠單元及兩家原生 Chrome 休眠時鐘跳變/接管/保存重開 2 案通過。修正後全專案 1185 tests（contracts 36/web 938/online 211）、typecheck/lint/build 通過；最終差異審查完成。上游及翻譯收音為受控替身，純字幕/獨立擷取包含原生 PCM/VAD；不代表真辨識、實體休眠或帳號併發資格。W11 母包/S4 仍未放行，公開 hybrid 維持停用，真併發、回聲與輸出裝置交 W11.2/H。目前 17／26 完成 LOCAL；Gemini 第二金鑰維持延後。證據 `.cache/w11-capture-verification.json`。

W09.1 續作：四條 token 路由共用固定錯誤代碼表，辨識已知 DNS/TLS/連線/逾時，不記任意錯誤文字；未知原因與使用者取消分開。完整後端 211 項後，最後分類標籤修正另驗相關 88 項，typecheck/lint 通過；非真公司網路驗收。W10.1 已核對題稿、合成真雲端與受控評測輸出，真人音訊/人工稿/分組/外送權限仍待提供，未改 DSP/VAD 或呼叫付費 API。場域表見 `docs/evals/2026-10-15-venue-matrix.md`，16／26 LOCAL 不變。

W09.1 施工中：Node 24.14.0 原生 HTTPS/CONNECT、NO_PROXY、CA 拒絕與 proxy 407 本機 4 案已驗，不新增代理 wrapper/依賴。修正兩家翻譯 token 路由將原始例外/上游正文寫入日誌的缺口，只保留安全分類/狀態碼；4 個紅測後，後端 201、typecheck/scoped eslint 通過。既有 Chrome 雙向接管等待有效內容、雙端失敗保留會議及 Stop 取消重試共 4 案通過（23.1 秒），上游受控，不能代表實際防火牆/WSS/WebRTC 可達。RUNBOOK 已分列三路配置；執行期三路就緒資訊與網路細因診斷仍待核對，W09.2 公司/VPN 環境待驗。維持 16／26 LOCAL。證據 `.cache/w09-network/result.json`。 本輪預檢審查確認本機健康不冒稱雲端就緒；修正翻譯未保存的過期說明，補明公司代理不等於瀏覽器音訊可用。新建置 Chrome 預檢 4 案與真 loopback RTP 2 案通過；RTP 初輪 409 租約隔離問題已以原 15 秒租約到期條件修正，未放寬媒體斷言。外部 WSS/ICE/NAT 與公司網路仍未驗。

W08.1/W08.2 完成（LOCAL），16／26 LOCAL。既有 owner 有界重啟同 build/origin，Stop 不復活；managed bootstrap/寫入核對工作區與 build，錯誤或缺少身分保留待存、停止自動重送，恢復原身分可明確重試。最終正式建置 Chrome 7 案單輪通過（1.1 分鐘）：兩家×翻譯/純字幕重啟續存，以及錯工作區/錯 build/缺少身分；原頁、會議、收音取得與 provider 連線/mint 不變，SQLite/匯出全文一致並結案。純字幕使用既有語音素材、原生 Chrome 音訊/VAD，雲端辨識仍受控；初輪無音訊卻注入結果的兩個測試錯誤已修正，未改產品或放寬斷言。scoped eslint 通過。前輪程序 20、前端 925、routes 13、typecheck 證據沿用，本輪未重跑。新增責任限於一個受 owner 擁有的 HTTP child 與既有 archive 身分檢查，未加資料庫/依賴/另一套恢復管理器。真雲端/實體音源/公司網路/長測仍依 W09–W12 待驗；日常服務未啟停。下一項 W09.1。證據 `.cache/w08-service-verification.json`。

W07.1/W07.2 完成（LOCAL），14／26 LOCAL。沿既有 IDB identity 的 retired 前綴保留晚到事件/會議資訊/缺口，明確勾選後才與世代切換同交易移存；失敗完整回滾，不自動併入新 SQLite。重開後可下載 JSONL，下載不刪除保留紀錄。最終 Chrome 15 案、前端 921 項、scoped eslint/web build 通過；涵蓋兩目的正常/回覆遺失/取消/晚到內容、真 IDB 回滾、重新開啟與檔案內容核對。後端 47 項沿用前輪且關鍵來源雜湊一致；20,100 段/譯文/修訂/缺口、壞檔/錯版本/中斷/安全副本與舊 writer 證據見報告。備份下載另 2 案已驗。未新增依賴、資料庫或管理器。真 provider 排空、實體斷電/異碟與場域長測未驗，仍屬後續放行限制；JSONL 是可讀保留紀錄，非自動匯入格式。下一項 W08 服務復原。證據 `.cache/w07-backup-verification.json`。

W04.2 施工中：翻譯兩家 audio／transport 中斷沿既有 coalescer 與 bound writer 保存 estimated 缺口，Stop／替換／unmount 結束該 owner，退役尾文仍保存。此次補齊兩家 WebSocket 背壓第一幀丟棄通報；重新送音後仍待有效內容才恢復健康。最終版本 web 單元 908 項、Chrome／真 SQLite 中斷與短暫背壓 5 案、正式建置雙向接管 2 案通過；typecheck、scoped eslint、build 通過（index-T4WMil6a.js）。音訊／雲端上游受控，不是實機或真服務資格驗收。未新增 manager／timer／queue／DB／依賴。captured／submitted／provider-completed 對齊及補送資格／限速／費用仍待驗，補送未啟用；12／26 LOCAL 不變。證據 `.cache/w04-delivery-verification.json`。

W04.1 完成（LOCAL capture 範圍），12／26 LOCAL。固定 60 秒／960,000 Float32 樣本（3,840,000 bytes）沿 capture owner 保留；無 provider 消費者期間覆寫即發同一 gapId，最多每秒更新一次，reclaim／Stop 補最後範圍，沿原 archive 保存；正常淘汰不誤報，跨會議不誤寫。C2＋buffer／retention 88 項、typecheck／scoped eslint／build 通過；原生 3／10／30／90 秒容量六案沿前輪證據，新增停流兩分鐘不造樣本單元。Chrome 原生 16／48 kHz 與同時字幕／SQLite 保存各 90 秒，兩案各 2,900 段 ID 全數一致、零 >50 ms long task、31 次更新合成一筆精確缺口；分別驗 reclaim 及直接 Stop、清 PCM／新 epoch。效能證據是 oscillator 原生 capture＋受控 normalized 字幕／真 DOM／SQLite，不含真 ASR、provider 送音成本、DOM p95/p99 或實機睡眠。兩案分兩次命令：首輪純字幕未設定顯示 task 失敗，修正測試前置及加入 seed-visible 檢查後單案通過，非單輪全綠。正式 bundle index-DqpI6nqU.js 已建置，Chrome 使用 Vite。沒有新 manager、queue、timer、DB 或依賴。W04.2 仍待提交／上游完成對齊、持有 capture 時的 transport 停送缺口、各服務補送資格與接線；未啟用補送、不宣稱零漏音。證據 `.cache/w04-retention-verification.json`。

W06.2 已完成（LOCAL），11／26 LOCAL。27 案故障矩陣、C8 127 項、90 秒保存開關／進行中匯出對照及正式版慢寫入／worker hang 已驗；證據 `.cache/hardening-w06-20261015/w06-2-verification.json`。下一項 W04.1 有界音訊保全，沿用 capture owner，依原清單驗容量、覆寫缺口與 Stop 清除；不展開額外架構。真服務／場域與長測仍待原放行項。

W06.1 完成（LOCAL）：managed service 沿用既有 runtime.json 保存首次 originPort，重啟固定原網址；占埠時不靜默換址、不連線或終止占用者，解除占用後可恢復。舊合法網址可沿用，損壞狀態檔保留並拒絕啟動；明確不同 --port 報 migration required／待救援未知，不實際變更。Chrome 真 IndexedDB／SQLite 重現跨埠同名 outbox 不可見，恢復原網址並核對 IPC／HTTP workspace、instance、build 後，原 pending event ID 重送去重、待存歸零且結案成功。9 項 managed service 測試、Chrome 一案、lint 通過；沒有新資料庫、管理器或通用搬移協定。10／26 LOCAL 完成。未知更早網址、localhost 別名、其他 Chrome profile 不宣稱自動救援；日常服務未啟停。證據 `.cache/hardening-w06-20261015/w06-1-verification.json`。

W05.2 完成（LOCAL，線上兩家×翻譯／純字幕）：Stop 立即停收音，Gemini 尾文完成訊號沿用既有有界 drain，不新增計時器；結案綁定停止時的 meetingId，舊場尾文不得結案新場。畫面區分未結案／已結案並提供保存重試；翻譯兩個匯出入口共用既有下載模組、讀完整 archive，失敗明示，不退回畫面尾段。原有 Markdown 格式保留，資料來自完整 JSON archive。兩家翻譯各驗 20,100 段下載、原文／譯文依片段 ID 對應、既有編輯器校訂、原稿保留及重新結案；純字幕兩家原生音訊基線含重開／校訂／匯出通過。最終產品 bundle index-CKloBGLP.js；完整單元 1079、build/typecheck/lint 通過。翻譯完整校訂證據分兩次命令：OpenAI 案通過，Gemini 案因測試誤用物件列舉順序失敗後改以 ID 精確核對，單案重跑通過（52.2 秒）；不是同一輪全綠。未加產品檔案、依賴、資料庫或管理器。完成數 9／26 LOCAL；測試服務關閉偶爾較慢原因未明，真雲端／場域／長測未驗，不能宣稱全專案完成。證據 `.cache/hardening-w05-20261015/w05-2-verification.json`。

W05.1 完成（LOCAL）：翻譯事件在畫面合併前進既有 archive/outbox；兩家切換、Pause/Resume、重開續接保留 meetingId，原文／譯文與修訂可取回。舊快照只補缺少資料，ACK 遺失重試不重複；保存啟動中 Stop 不復活收音，503 期間字幕持續、待存可見，恢復後原文補存核對通過。C8 前端 95＋後端／真 SQLite 24 項通過；移除臨時診斷後正式 Chrome 兩案 48.8 秒、退出碼 0，沿用既有 production build。新鮮審查核對 coalescer 先保存、writer 固定身分、App 取消及測試斷言，無新增平行資料架構。完成數為 8／26 LOCAL。先前測試結束偶發未退出仍未查明；兩次診斷均為零待處理請求／連線且正常關閉，不宣稱修復，列為後續程序關閉／整合長測的未解風險。此收工只對應 W05.1，W05 母包仍待 W05.2 結案／全量匯出，真雲端與場域資格未驗。本輪不展開下一項。證據 `.cache/hardening-w05-20261015/w05-1-verification.json`。

W05.1 續接與舊快照補強：App 已接 restoreTranslationSnapshot，先讀原會議 metadata／修訂序號，清空既有待送，再只匯入 archive 缺少的原文／譯文；已存修訂優先，舊快照保留，僅明確 MEETING_NOT_FOUND 才建立會議。未增加資料庫、queue、timer 或依賴。ACK 遺失重試不重複、未知 401/404/503 不誤建會議，client/outbox 41 項通過；正式 bundle index-nyg5R59v.js 的 Chrome 兩案通過（44.9 秒），涵蓋兩家舊快照匯入、雙向接管、Pause/Resume、進行中 reload 後同 ID 續接、既有修訂不變，以及保存啟動中 Stop 後不重啟收音。build/typecheck/lint 通過。曾有一輪案例通過後結束階段未退出，手動中止；加診斷重測及最後無診斷版本均正常退出，原因仍未確認，不宣稱已修復。保存故障的 App 重試閉環仍待補；結案／全量匯出屬 W05.2。W05.1 維持施工中、7／26 LOCAL 不變，真雲端／硬體／場域未驗。證據 `.cache/hardening-w05-20261015/migration-verification.json`。

W05.1 施工中：App 已在兩家線上翻譯啟動前取得綁定 meetingId 的 archive writer，重連／接管／Pause/Resume 沿用，新增獨立保存狀態與 pagehide/Stop checkpoint。Chrome 先重現字幕已顯示但 SQLite 零會議的兩個紅測；目前正式版本兩方向均驗原文／譯文入庫、接管／暫停續接同 ID、Stop 收音回收及重載後 DB 資料一致。慢寫入權限 2.5 秒會誤開雙 provider 的兩個紅測已修復，以既有 recovery 阻擋條件等待保存啟動；舊尾文進新場畫面的單元紅測亦已修復，保存仍留原場。完整單元 1067、C7 37 案為尾文／慢保存最後修正前版本；最後版本另驗相關單元 65、Chrome SQLite 2、連續性回歸 6 案及 build/lint 通過。SQLite／IDB 為真本機，音訊與雲端上游受控，非真服務場域驗收。待補保存啟動期間 Stop／保存故障、重開續接 revision、舊快照遷移；結案／全量匯出另依 W05.2。完成數維持 7／26 LOCAL。證據 `.cache/hardening-w05-20261015/app-verification.json`。

W03.4 完成（LOCAL）：翻譯恢復須當前非空原文或譯文才恢復健康；空白／控制訊息不掩蓋停字，正常靜音不重連。反覆停字先給同廠恢復機會，第二次獨立停字後握手仍無內容則沿既有 MeetingRecovery 跨廠接管；不新增 timer、依賴或資源 owner。兩家有效紅測後，完整單元 1061（34＋860＋167）、Chrome C7 37 案、C4 原生音訊 35 案通過，build/typecheck/lint 通過；本次收工另重跑 provider/hooks 222 項通過。正式 bundle `index-CUiIC-Jd.js`；受控字幕恢復 Gemini→OpenAI 2242 ms、OpenAI→Gemini 2146 ms、OpenAI 同廠 1133 ms，三案通過。上述為本機受控上游證據，不代表真雲端延遲、百分位數、硬體或場域長測；W03 母包仍待 W12/H2。證據 `.cache/hardening-w03-4-20261015/w03-4-verification.json`。目前 7／26 LOCAL 完成，下一項 W05.1 翻譯寫入既有 archive。

W03.3 完成（LOCAL）：純字幕 OpenAI↔Gemini 接管共用既有 recovery、capture lease 與 archive，首筆有效內容才宣告恢復；同廠／跨廠首試分別 2／1 秒，後續退避與 Retry-After 保留。修復跨廠待內容期間續期 activate 拋錯後不再重試的漏口，有有效紅測及 55 項針對性綠測。最終 1049 單元（34＋848＋167）、build/typecheck/lint 通過。Chrome 完整雙向故障矩陣 12 案於前版通過；最終 bundle `index-CtnNkZWv.js` 重驗兩方向時序與同廠續期 4 案通過，OpenAI→Gemini 2396 ms、Gemini→OpenAI 2460 ms；翻譯共用排程回歸 15 案通過。核對 meetingId、purpose、缺口保存／重載／匯出、Stop 與單次收音。唯讀審查修正後未發現此範圍其他阻擋。以上為本機 VAD／IDB／SQLite＋受控上游，非真雲端、百分位數或場域長測；真服務資格仍交 W12/H2。版本、原始時序與雜湊見 `.cache/hardening-w03-renewal-20261015/w03-3-verification.json`。

W03.3 接管延遲修正：原線已結束後的跨廠首試沿用既有 1 秒 handoff 等待；同廠仍 2 秒、後續 4／8／15 秒與 Retry-After 不變，未新增 timer／依賴。前版受控 Chrome 為 OpenAI→Gemini 2994 ms、Gemini→OpenAI 3080 ms（後者未過）；正式 bundle `index-Dsm1xmgb.js` 重測兩方向為 2047／2141 ms，2 案通過，含 meetingId／transcription purpose／缺口保存重載匯出與 Stop 回收核對。這是各方向一次本機 VAD＋受控上游觀測，不是真雲端或百分位數。新增同廠／跨廠完整退避測試；針對性 54、完整單元 1048（34＋847＋167）通過。人工重試語意已有兩方向單元證據；完整故障矩陣與翻譯共用排程的新版本回歸、最後審查仍待完成，W03.3 不勾完成。原始證據 `.cache/hardening-w03-renewal-20261015/cross-delay-{green,unit,build,timing}.log` 與 `cross-delay-timing/`。

W03.3 施工中：純字幕 session 已接既有 `MeetingRecovery` 目標與兩家 transcription adapter，實際 backend 與使用者偏好分開；能力資訊優先讀 transcription taskCapabilities，沿用 capture lease／archive，沒有新增恢復 timer。跨廠連線需首筆非空文字才宣告恢復，等待狀態跨同廠續期保留；備援啟動拒絕不得卡死重試。新增 13 個單元涵蓋兩方向、scope／冷卻、能力更新、Stop 晚回呼、備援拒絕及內容前續期，保留有效紅測。最後完整單元 1043（34＋842＋167）、build/typecheck/lint 通過。修正內容前續期前的正式版本：Chrome 10 案通過（2.7 分鐘），涵蓋雙向成功／目的端拒絕／雙端拒絕／接管 Stop 與同廠續期；最後修正版另重跑雙向接管與同廠續期 4 案通過（2.3 分鐘）。既有單廠 401／429 4 案於前版通過。均使用真實本機 VAD／IDB／SQLite及受控上游，驗一次收音、Stop 後無送音／重連、全文重載匯出，不是真服務驗收；不同版本證據分開。尚待首有效內容延遲、跨廠缺口／meetingId／purpose 精確核對、人工重試語意與最後收工審查，W03.3 不收工。證據 `.cache/hardening-w03-renewal-20261015/cross-provider-verification.json`。

> Active work and near-term backlog. Long-term roadmap lives in
> [`PROJECT_STATE.md`](PROJECT_STATE.md).

---

## Now

### 場域強固化主軸 — 2026-10-15（W01／W02.1／W03.1 完成本機驗收，W02.2 工程已驗／場域待驗）

執行時直接領取主清單「可直接領取的任務與收工規則」中的 26 項子任務；每次一項，依表內前置施工並回填狀態／證據。以下 W01–W12 僅作母包索引，不另維護重複子待辦；工程已驗但缺真服務／場域證據時，母包不得勾完成。

W02.2 工程已驗、H1 場域待驗；W03.1 已完成 LOCAL。W03.2 VAD worker 修復驗證：Silero 初始化與推論改由專屬 worker 持有，沿用原有 capture／有界幀佇列；模型與 WASM 同來源，未新增依賴。ORT proxy 直接探針確認重用張量的 buffer 從 8 bytes 被轉移成 0，下一次推論出現 DataCloneError，因此沒有沿用 proxy。正式 bundle `index-BxJcSEcg.js` 兩家候選窗口均無 >50 ms long task，rAF 最大間隔分別 Gemini 13.1／OpenAI 12.8 ms；各兩個 worker 均終止、兩個 worklet 均斷開。完整單元 1029 通過；Chrome 首輪 10 passed／4 failed，修正退役測試的靜音循環與等待前置後，四個退役案例另跑全部通過（32 秒），未放寬產品 5 秒 drain。14 種情境的證據分屬兩個命令，不稱單輪全綠。詳細原始資料與失敗紀錄見 `.cache/hardening-w03-renewal-20261015/vad-worker-verification.json`；原生收音／恢復／401／429 回歸 13 案通過（2.6 分鐘），新增同服務先恢復、候選晚 ready 不可奪權的 session 回歸後 16 案通過。W03.2 本機行為與資源所有權審查已完成；最終靜態檢查與證據雜湊見同一報告。CPU／總記憶體、背景／低效能裝置、真帳號併發與 W12 長測未驗。

全工作包必遵守主清單的流暢度／穩定性與精簡審查條件：量測後修阻塞、沿用現有模組、每個資源單一 owner、不新增平行恢復／保存／事件架構、不做無關重構。新增檔名是候選落點而非必建清單；兩家交互備援仍必做、Gemini 第二 key 仍後排。

唯一排序入口：[主工作清單 W01–W12](superpowers/plans/2026-10-15-meeting-hardening-checklist.md)。**OpenAI／Gemini 兩家交互備援是主線；只有 Gemini 第二 key 放最後。** 診斷與細節見[總藍圖](superpowers/specs/2026-10-15-meeting-resilience-design.md)，承接 R/L/T 舊工作，不重複建立完成標記。

- [ ] W01/W02：場景真實能力、會前試音、裝置／PCM／context 生命週期與故障定位（A1/A2）。
- [ ] W03：同服務重連／續期／限流／停字，以及 OpenAI→Gemini、Gemini→OpenAI 自動接管；翻譯與純字幕分別完成，不依賴 Gemini 第二 key（A4）。
- [ ] W04：會議級 PCM 保全、各服務補送資格、同廠／跨廠區間對齊與缺口明示（A3/A4）。
- [ ] W05–W07：翻譯全量保存、origin、儲存故障閉環、備份還原與升級（D1–D4），可與恢復工程獨立推進。
- [ ] W08/W09：managed 有界復原、server／browser 網路與 Proxy 資格（D5/N2）。
- [ ] W10/W11：真人聲學品質、簡單操作預設、真正 mic＋remote 分軌與按需音源資格（V1/A5）。
- [ ] W12：兩家各一 key 的四路長測、雙向接管／雙端失敗、實機／真網路／資料核對及場域放行（V2/V3）。
- [ ] 獨立條件：N3/N4 離線與本機補處理需真模型與硬體資格，不作雙雲端主線前置；S6 需求保留。
- [ ] **最後 B00/B02（N1）：Gemini 第二 key 的存在／權限確認及同廠換 key，取得資源且另行開工後才做。** 不阻擋兩家交互備援驗收。

摘要／語者／議題藍圖保留，非本輪前置。施工仍須更新文件中的現況、預定方案與驗證證據，不能把規劃當已完工。

### 近期工作收尾 — 2026-10-12

- [x] 會議驗收校準：四路各 30 分鐘原生長測、續期與 Stop、各 151 段 SQLite／全文匯出一致；加強保存狀態、畫面進展、heap 與全量匯出判準，見 [報告](MEETING_CALIBRATION_2026-10-12.md)。純字幕續期缺口仍開放。

- [x] 恢復預設單元、格式、Chrome E2E 的正確探索／啟動配置，保留 production 純字幕專用驗收。
- [x] 翻譯交接中 Pause 取消兩家；退役或失敗備援不再留下錯誤健康狀態。Chrome 新增競態回歸先紅後綠。
- [x] HTTP 400／413／422 停止無效自動重送、保留待存逐字稿、UI 明示與人工重試；兩家原生純字幕保存整合通過。
- [ ] 真人混語、真實內外網、真雲端長會議與下列 T6–T15 仍開放；本輪未用受控測試替代這些驗收。
- 現況、測試層級與日常服務：[診斷報告](DIAGNOSIS_2026-10-12.md)。

### 純字幕優先與會議功能藍圖 — 2026-10-08（實作及驗收中）

- [x] 靜態診斷及分階段規劃；[藍圖](superpowers/specs/2026-10-08-mixed-language-captions-meeting-blueprint.md)、[A0–A7 清單](superpowers/plans/2026-10-08-mixed-language-captions.md)。
- [ ] A0：混語語料、模型／帳號／transport 契約與成本評測，固定驗收基準。
- [x] A1–A4 本機實作：純轉寫 purpose、兩家專用 broker/provider、normalized events、同目的恢復；真帳號能力仍列 A0 gate。
- [x] A5–A7 本機部分：單字幕 UI、匯出／遷移、兩家各 60 分鐘 Chrome 原生音訊、崩潰恢復與窄視窗／鍵盤全螢幕驗證。
- [x] A7 真雲端合成整合：OpenAI 主／備槽、Gemini 專用轉寫；修正 Gemini 真實協定與漏句問題，見 [報告](evals/2026-10-08-real-cloud.md)。
- [x] 真測後 Review：修正 Gemini generation／多 final／Stop 尾段及零長度時間戳；[驗證與後續優先順序](evals/2026-10-08-review-followup.md)。
- [ ] A7 真服務品質：US$1 測試已授權；仍需授權混語真人音檔／人工稿、內外網切換及長測驗收。
- [x] 第一梯 T0–T5（[診斷與任務序](evals/2026-10-09-followup-diagnosis.md)）：`pnpm -r test` 全專案可跑；
      字幕改用台灣用詞（OpenCC `twp` ＋專案術語表，與雲端提示同源）；OpenCC 移出首屏
      （主程式包 gzip 624 → 126 KB）；`predictions.json` 擷取工具；斷句三門檻可注入；
      兩家送出 `keywords`／`custom_vocabulary`。辨識品質仍未驗、門檻未選值。
- [ ] 第二梯 T6–T7：記憶體 PCM 環形緩衝、續期改 make-before-break（目前 Gemini 每 8 分鐘必然缺口）。
- [x] B 本機部分：SQLite／IDB 保存、原稿與校訂、完整匯出、已知缺口／待存狀態；60 分鐘資料與匯出逐段核對通過。
- [ ] B（首版必做）：沿用 L1 完整地端紀錄、人工校訂留痕、結案核對、重啟恢復及全量匯出；A＋B 都驗收才算首版完成。
- [ ] C：來源標示／人工語者，評測後再加入延後自動語者。
- [ ] D/E：有原句引用的點列摘要、決議／待辦／未決及議題脈絡。
- [ ] F：既有 L2 缺口補錄、Offline 缺陷與各階段長測。
- 後續開工指示已取代前輪僅規劃限制。文字外送摘要與音訊二次處理政策仍須明確決定；未啟用錄音落盤。

### 日常服務隔離 — 2026-10-06

- [x] Windows 單一 managed 入口、workspace IPC owner、重複 start 重用。
- [x] 專用候選 43871＋OS 動態 fallback、實際 URL／build／instance 身分。
- [x] Stop 身分核對、crash 後可重啟、異物埠不被搶占或終止。
- [x] 正式同來源單程序、每實例資產快照、online-only 不探測 8000。
- [x] 六個 lifecycle 測試、正式 Chrome 占埠／並行 start／Stop 驗證與舊服務清理。
- 操作見 [RUNBOOK](RUNBOOK.md#managed-windows-service-2026-10-06)；此項不關閉下方 R5／V1 或離線缺陷。

### 已啟動：線上整體修復與藍圖任務 — 2026-10-02

**重新開啟，尚未整體收工**：追加原生音訊修復已通過 543 單元／回歸、26 Chrome
整合與 6 個正式 bundle 原生音訊案例；修正版已打包並核對雜湊。
仍需確認使用者實際啟動網址／版本；真實雲端驗證依預算規則未執行。
下方原勾選為前輪交付紀錄，不能覆蓋此未完成狀態。

使用者指定先完成線上修復，地端處理後排。詳細追蹤見
[R1–R5／L1–L2／V1](superpowers/plans/2026-10-02-meeting-continuity.md)。

本輪依 clean code／SOLID 要求重新複核完成：整次 12 秒期限、取消所有權、
回呼競態及恢復排程已修正，507＋90 個單元／回歸及 26 個 Chrome 案例通過。

- [x] R1 Gemini 有界重連、GoAway 與 setup 送音門檻。
- [x] R2 OpenAI 候選隔離、有界就緒與 ICE 自動恢復。
- [x] R3 App 自動接管／重試協調，Stop 確實取消。
- [x] R4 Retry 歷史、音源所有權與過期錯誤修復。
- [x] R5 本機整合與回歸、最終審查、藍圖對照實際交付。
- [ ] 後排 L1：自動地端 LOG／TEXT 保存；L2：PCM 缺口與地端補錄。保留需求，尚未交付。
- [ ] V1：預算核准後的必要真 API 驗證及發行版實際會議觀測，不擅自跑付費長測。

### Meeting continuity findings — 2026-10-02

診斷與受控重現見 [會議接續報告](MEETING_CONTINUITY_DIAGNOSIS_2026-10-02.md)。以下為原始完整需求；R1–R5 的最新驗證狀態以上方及修復紀錄為準，未涵蓋的保存／缺口／真實服務驗收仍未完成：

範圍：診斷已轉為方案與實作規劃，維持專用即時翻譯，不切換成互動模型。
使用者明示：LOG／TEXT 能由 LOCAL 完成的保存、處理與恢復皆由本機自動完成。
見[藍圖與可行性校準](superpowers/specs/2026-10-02-meeting-continuity-design.md)與
[T00–T11 工作清單及收工條件](superpowers/plans/2026-10-02-meeting-continuity.md)。
線上 R1–R5 已完成本機受控驗收；地端保存未實作。SQLite worker 探測不等於保存功能驗收。
詳見 [修復與未完成項](MEETING_CONTINUITY_REPAIR_2026-10-02.md)。

最終放行：LOCAL 長測＋預算核准的小額真 API＋實際會議觀測，正常換線及可恢復故障
**人工救援 0 次**。撤銷固定 6 小時付費測試；未經明確預算核准不啟動新付費測試。
LOCAL 證據不能冒充真實長會議可靠性；首譯、保存與缺口分層驗收。詳見藍圖第 8 節。

- [ ] 使用者必要需求：LOG、原文與會議譯文自動持久保存；分會議、不被 Retry／新會議覆寫，儲存失敗可見且可復原。取代原有預設 opt-in 策略，尚未實作。

- [ ] 接管失敗後 Retry 保留原 meeting/sessionId 與歷史；Gemini 提供對等恢復入口。
- [ ] Gemini 重連等待 setupComplete 才送音；token/握手有界且可取消。
- [ ] 分離 2 秒失敗告警與跨模型接管；目的端失敗仍可繼續復原。
- [ ] GoAway 接續、字幕進度 watchdog、close/retry 診斷資訊。
- [ ] OpenAI 候選續期失敗不應觸發停止健康主連線；修正切換 ready／首字幕判準。
- [ ] OpenAI ICE restart 的協商與自行升級；mint／SDP 總期限及取消。
- [ ] Capture lease 交接健康監聽、拒絕 ended track；復原後清除過期錯誤狀態。
- [ ] 會議級有界音訊緩衝、缺口標示與非阻塞補錄；不把保留舊字幕宣稱為不漏音。
- [ ] 確認使用者執行版本與故障 LOG；真 API 長會議與帶編號音訊完整度驗收。

### Online-first priority — 2026-09-11

使用者最新指示：離線不是目前重點，線上字幕必須順、快，模型保持最新且品質好。
此排序優先於 `PLAN_2026-08-28.md` 的 Summary 開發順序。

- [x] Gemini token／WS／probe 遷移 v1beta，使用當前 KEY 確認 setupComplete。
- [x] OpenAI primary／audio 真實 mint、WS、SDP 握手；修正發行版單 KEY 環境啟動。
- [x] 防止 Gemini 停止／重啟後的 async 結果接管新會議與舊尾字幕混入新會議。
- [x] 同大版本更新 Fastify 5.12.3、Zustand 5.0.15、OpenCC 1.4.2。
- [x] 正式應用接真 API 送測試語音：OpenAI WebRTC／WS、Gemini、audio-only KEY、暫停恢復及互切。
- [x] 修正硬分段造成日期／否定句斷開的大字顯示；收音就緒提示改以真正連線狀態為準。
- [x] WebRTC 續期候選須真正 connected 才換線；失敗／逾時保留舊線，Stop 取消等待。
- [x] OpenAI 換線後獨立收完舊線尾譯；WebRTC／WS 真實重複語音跨續期，匯出各保留兩份日期／週五／否定句。
- [ ] React／Vite／TypeScript 等跨大版本遷移另列驗收，不宣稱所有框架均為最新。

- [x] 修正 OpenAI WS 接管順序、完整 audio setup 逾時與非認證錯誤切 key；
      新增單元／瀏覽器回歸，保護續期候選失敗時的健康舊連線。
- [x] 修正 2,000 段效能測試的歷史清空問題；Chrome 重新量得 90 秒無 >50 ms 長任務。

- [ ] 以代表性會議音訊量測兩個現行線上模型的首譯文 P50/P95、連續字幕停頓、
      續期／換線空窗及翻譯品質；不以 mock 延遲代替真實模型延遲。
      以實際收音與會議操作確認；保留誤譯、漏詞、失敗及未測場景。
- [ ] 對照 `gpt-live-transcribe`／`gemini-3.5-transcribe-live` 加串流文字翻譯；
      須同時通過速度與品質驗收才能更換正式預設。
- [ ] Gemini 32 ms／100 ms 封包以相同音訊 A/B；目前不宣稱 100 ms 必然更快。

當日官方查核及診斷見 [ONLINE_DIAGNOSIS_2026-09-11.md](ONLINE_DIAGNOSIS_2026-09-11.md)。
離線、Hybrid、摘要、Electron 暫不擴充。

### Phase 1 closure — complete (2026-07-30)

- [x] Gemini setup waits for `setupComplete`, uses only the exact dedicated
      translate model, and has no silent native-audio fallback (`13f6311`).
- [x] Transcript retention is opt-in/default-off with race-safe IndexedDB
      deletion (`c587fc2`).
- [x] Active sessions lock mode/scenario/backend/language; Stop releases capture
      and transport before switching (`7dd2362`).
- [x] Offline MT uses a bounded ordered dispatcher and cannot cap-wait inside
      the transcript receive loop (`b67d810`).
- [x] Production offline services are loopback-only and do not use reload
      (`2adcd78`).
- [x] Full local release matrix is green; formatting and lint gates are restored
      (`171c05b`).
- [x] The live probe is statically checked and generated fixtures are read back
      through a fail-closed verifier (`3089e3d`, `3e6a30d`).
- [x] With explicit credential authorization, the minimal OpenAI/Gemini live
      probe passed; two redacted fixtures were inspected and verified, the
      provider unit/E2E mock consume their golden frames, and the full release
      matrix was rerun (`b8029e6`).
- [x] External review (Codex) caught one residual defect in the new Gemini setup
      path: teardown before `setupComplete` left the handshake promise pending
      behind the stale-socket guard, so its 15 s timer emitted a phantom
      setup-timeout `api_error` (and, on the reconnect ladder, a `reconnecting`
      state) onto whatever session was running by then. Fixed with a teardown
      sentinel that settles the handshake; both regression tests were confirmed
      to fail before the fix.

**Gemini latency root-cause closure (2026-07-02) complete.**

- Official-docs research settled it: the translate model has NO latency knob
  (translationConfig = targetLanguageCode + echoTargetLanguage only; no TEXT
  modality / speed / thinking / effective VAD). ~2–3 s lag is structural
  (caption text is paced by translated-audio generation; LiveLingo measured
  ~2.9 s median). Client stack already meets all official best practices.
- Shipped: pending-source live caption (big area shows arrived source text,
  dimmed + 翻譯中… tag, during the translation-lag window) + honest ~2–3 s
  labeling on the Gemini backend option + e2e getAudioTracks mock fix.
- Do NOT revisit `gemini-3.1-flash-live-preview` as a "faster" path — it was
  the original backend and was replaced because turn-based VAD waits are worse
  for continuous meeting speech. Re-evaluate only if Google ships a new
  translate model variant (watch the models page).

**Gemini per-utterance latency fix (2026-06-29) complete.**

- Reverted Gemini Live Translate from the earlier cost-saving `TEXT` modality to
  the official speed-first `AUDIO` response modality, while still using
  `outputAudioTranscription` for text captions and discarding synthesized audio.
- Kept 512-sample / 32 ms PCM chunks; current evidence points to Gemini
  translation cadence and live-render anchoring, not client audio framing.
- Added output-first live anchoring: `outputTranscription` now emits a matching
  partial transcript anchor before its draft translation, so Gemini captions can
  render immediately even if `inputTranscription` arrives later.
- Next manual check: rerun the same YouTube field test and compare Gemini
  `ttfcMs`, `durP50`, and visible stalls against the prior cadence.

**Project KEEPALIVE — 永續雙模型字幕強化 (2026-06-12) complete.**
Dual-model reliability/continuity: 多元模型 · 不會斷 · 可接續.

- **#16** Gemini wedge detection + persistent reconnect (parity with OpenAI).
- **#7** OpenAI zero-gap renewal (make-before-break, mic-stream reuse).
- **#21** Cross-model one-click failover (`FailoverBanner`, transcript preserved).
- **#3** History tail-window render cap (`tailSegments`, 400) — store keeps full.
- **#19** verified `pcm-worklet.js` ships in `package-online` zip.
- 238 web unit tests + 15 Playwright e2e (real Chromium) green; typecheck +
  online build + package-online clean. See PROJECT_STATE.md "Project KEEPALIVE".
- **Deferred — #8 Gemini meeting-mode noise suppression**: needs real
  multi-speaker meeting audio to tune (Gemini lacks OpenAI's server far_field
  NR; blindly enabling browser NS risks gating non-dominant speakers). Do NOT
  implement without an A/B on real room audio.
- **Manual-only checks** (no live keys in CI): cross-model failover happy-path
  and 30–60 min soak — procedures in `RUNBOOK.md`.

**KEEPALIVE test-engineering (T0 → T1 → T2, 2026-06-12) complete.** The
previously manual-only reliability checks are now automated:

- **T0** mock-backend fault-injection e2e — `tests/e2e/online-mock.ts` (in-browser
  mock for both providers, no key) + `online-keepalive.spec.ts` (5 tests):
  zero-gap renewal (mic reused once), repeated renewals never blank,
  OpenAI-fail → failover-to-Gemini with transcript preserved, Gemini reconnect.
- **T1** soak — `caption-store.soak.test.ts` (5 000-turn + 200-session bounds &
  reference-stability invariants).
- **T2** conformance — `provider-conformance.test.ts` (every provider event vs
  `NormalizedEvent`) + `paragraph-grouping.property.test.ts` (seeded-PRNG props).
- Lint hygiene: `eslint.config.js` ignores `release/**`, disables base `no-undef`
  for TS, AudioWorklet globals for `pcm-worklet.js`. `pnpm lint` clean.
- **251 web unit + 20 e2e green; typecheck + lint clean.**

---

**Easy-start launcher + crash-continue + IDB capacity (2026-06-11) complete.**
Single-session focus, easy to start different settings.

- **Easy-start launcher**: `SessionLauncher` empty-state grid — one-click start
  for OpenAI/Gemini/Hybrid/Offline/Demo, each selecting its config + starting
  (no Settings detour); availability-aware.
- **Crash-continue**: persisted `sessionMode`/`sessionPhase`; `ContinueBanner`
  on reload of an interrupted/paused session → ▶ 繼續 resumes the same backend,
  transcript preserved.
- **IndexedDB capacity**: IDB primary async store; `maxSegments` 3000 → 20000;
  localStorage kept as the synchronous crash net (2000-segment tail);
  load-time merge; persist v3 → v4.
- 220 web tests (+8), typecheck + build clean, full crash-continue lifecycle
  browser-verified. See `PROJECT_STATE.md` "Easy-start launcher + crash-continue
  - IndexedDB capacity".
- Follow-up: multi-session history browser (deferred per user — single-session).

**Robustness pass (2026-06-11) complete.** Following durability hardening:

- **Offline/Hybrid wall-clock timeline rebase** — fixes the documented P6
  follow-up. WHL connection-relative `startMs` (resets to 0/connection) is now
  shifted onto wall-clock per connection in `offline-stt-provider.ts`. Fixes (a)
  export/time-gutter timestamps clamping to 0:00 for offline, and (b) reconnect/
  Resume segments sorting to the front of history. Monotonic across drops.
- **Autosave no-silent-failure** — `writeSnapshot` warns once on QuotaExceeded/
  storage-unavailable instead of swallowing; in-memory unaffected.
- 212 web tests (+2), typecheck + build clean. See `PROJECT_STATE.md`
  "Robustness pass — offline timeline + autosave honesty".
- Remaining (features, not hardening): crash-**continue** (Resume survives
  reload); IndexedDB tier for multi-session history.

**Transcript durability hardening (2026-06-11) complete.** Interruption-state
safety for the transcript log (summary deferred per user). Added
`captionStore.flushNow()` — synchronous localStorage write that folds the
in-flight `livePartial`/`liveTranslation` onto disk; wired to `pagehide` /
`visibilitychange→hidden` and to graceful Stop/Pause. Closes the debounce-window

- unfinalized-utterance loss on crash / tab-close. 210 web tests, typecheck +
  build clean. See `PROJECT_STATE.md` "Transcript durability hardening".
  Follow-up candidates: IndexedDB backup for >5 MB / multi-session history;
  explicit "continue after crash" (Resume survives reload).

**Field-feedback pass (2026-06-08) complete.** Three reported issues fixed —
see `PROJECT_STATE.md` "Field-feedback pass":

- Online speaker-switch recognition → new default `'meeting'` acoustic profile
  (browser DSP off + OpenAI far_field). **Needs real-meeting verification.**
- No Pause → added Pause/Resume that preserves the transcript log (no clear).
- History not auto-scrolling → `ResizeObserver` re-pin on pane/content resize.
- 190 web / 42 online vitest, typecheck + build clean.
- Follow-up: offline/hybrid Resume timestamp ordering (WHL restarts at 0/conn).

**Robustness audit (2026-05-23) complete.** See `PROJECT_STATE.md` for full
change log. Summary: PCM ring buffer (~32× GC reduction), WASAPI drop-counter
thread-safety fix, UUID segment IDs, healthz `model_loading` state,
`OFFLINE_CORS_ORIGIN` env var. 50 Python + all TS tests green.

P3 complete. **CaptionBoard v3 (UX overhaul)** delivered out-of-band on top of P3.5:

- Split paragraph streams (ZH and EN each grouped by their own punctuation)
- Per-paragraph elapsed-time gutter (M:SS, derived from first segment's startMs)
- Live caption weight 300 → 500 (readable at 1.5–3m office distance)
- Partial freeze with `translating · …` hint (replaces old target/source desync)
- Live segment picked by max startMs (not array tail) — robust against revised events
- Auto-hidden Export/Clear; cost panel stays in header (visible while online burns money)
- Inline confirm for Clear (replaces native `confirm()`); ref-based to handle rapid double-clicks
- Scroll fix: `margin-top: auto` on first child (top of history reachable when overflowing)
- "↓ N new" pill while scroll-paused
- `prefers-reduced-motion` for cursor and translating-hint pulse
- Caption store: new `sessionStartMs` field (Date.now() at first event) for honest export header
- New helper module `caption-board/paragraph-grouping.ts` with full unit coverage (12 tests)
- 89 web vitest tests green (was 74); typecheck clean

Sandbox prototype at `docs/sandbox/caption-board-v2.html` (lab) + screenshots `v3-*.png`.

Next: P4.

---

## P0 (done)

13 tasks complete. 8 commits in git history. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P0.md`](PLAN_P0.md).

## P1 (done)

11 tasks complete. Web 46 unit + 8 Playwright e2e tests green. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P1.md`](PLAN_P1.md).

## P2 (done)

6 tasks complete. Web 57 unit + online 8 unit + 15 Playwright e2e tests green.
Real OpenAI Realtime WebRTC path wired. See
[`PROJECT_STATE.md`](PROJECT_STATE.md) and [`PLAN_P2.md`](PLAN_P2.md).

## P3 (done)

15 tasks complete (Phase A/B/C). 21 Python + 68 JS tests green.
Full offline pipeline: WHL + CTranslate2 MT + WASAPI loopback + frontend source selector.
See [`PROJECT_STATE.md`](PROJECT_STATE.md).

Commits:

- `9929d52` — fix(offline): distil-large-v3 model, min-words filter, language-aware prompt, glossary pipeline
- `779c213` — refactor(offline): WHL as independent process + structured /healthz + startup scripts
- `44cc3f6` — feat(offline): WASAPI system audio loopback — source selector + capture pipeline

## P4 (partial — 2026-05-23)

- [x] Glossary expanded: 59 → 102 terms (insurance product, regulatory, finance, tech-meeting domains)
- [x] Hybrid Privacy mode wired:
  - `ASRSession(translate_enabled=False)` — offline service does STT only
  - `POST /translate` on online service (GPT-4o-mini) — browser calls for each final segment
  - `useHybridMode` React hook — combines offline STT + online MT
  - `App.tsx` — Hybrid button enabled; shows Whisper readiness like offline button
- [x] Dual-path MT: full_offline uses local CT2; hybrid_privacy uses GPT-4o-mini via online service
- [x] Tests: 52 Python / 41 online / 174 web all green

## P4 (complete — 2026-05-24)

- [x] Glossary expanded: 59 → 102 terms (insurance product, regulatory, finance, tech-meeting domains)
- [x] Hybrid Privacy mode wired (local STT + online MT via GPT-4.1-mini)
- [x] Dual-path MT: full_offline uses local CT2; hybrid_privacy uses GPT-4.1-mini via online service
- [x] Translation confidence scoring: inherits source transcript confidence (avg_logprob → 0-1); propagated through events.py → stabilizer → asr → translation-event schema → caption-store → UI (data-conf dimming already in place)
- [x] e2e WebSocket STT contract tests: test_ws_contract.py (5 tests) + TS provider tests (2 tests)
- [x] Hybrid mode error-path tests: translateOnline returns null on 429/502/network-fail — captions unblocked
- [x] Code review pass (2026-05-24): 0 critical, 2 warnings resolved
- [x] Model upgrade: gpt-4o-mini → gpt-4.1-mini for hybrid MT
- [x] Voxtral / Speaches: deferred to P5 as research task (see backlog)
- [x] Tests: 59 Python / 41 online / 184 web all green; TypeScript clean

## P5-A (complete — 2026-05-24)

- [x] Breeze ASR 25 model mapping in `run_whl.py` (WHL_MODEL=breeze-asr-25)
- [x] `scripts/compare_models.py` — WER/RTF/VRAM comparison harness
- [x] `eval_audio/` — ground truth transcripts for 4 zh-TW/code-switch clips
- [x] B2: token expiry check before SDP exchange (skip SDP if < 60s remaining)
- [x] B4: silence_detected health event after 30s of sub-threshold audio; recovery to connected
- [x] B5: permission denied / API error surfaced to React error state via health event interception
- [x] 4 new provider tests (B2 ×2, B4 ×2); 187 web / 41 online / 59 Python all green

## Backlog (later phases)

- [ ] P5 — Research Voxtral (Mistral) and Speaches as alternative ASR backends;
      evaluate streaming support, Windows compatibility, and quality versus
      distil-large-v3.
- [ ] P5 — Summary pipeline draft / refined / stable.
- [ ] P7 — Electron packaging.
- [ ] P7 — Sidecar lifecycle (Electron main spawning online + offline).
