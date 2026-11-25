# PROJECT_STATE.md

2026-11-25 手機網頁版與線上服務強化（Phase 1 + Phase 2 + Phase 3.1）：完成深度診斷與核心強化，維持既有模組邊界、不新增平行架構或大型依賴。
- **手機版核心修復**：(1) `capture-lease.ts` 新增 `retainAudio?: boolean`，手機版設為 `false` 跳過無用的第二條 Worklet 與 3.84 MB 60 秒 PCM 緩衝；(2) `audio-engine.ts` 抽出共用線性 `resamplePcm` 與 `pcmChunkSizeForRate`，`GeminiLiveProvider`（及 `OpenAIWsTransport`）在 48 kHz 回落時維持 ~32 ms 分幀並於客戶端降採樣至 16 kHz（減少 3 倍封包數與頻寬）；(3) `microphone-audio-provider.ts` 識別 iOS Safari `AudioContext.state === 'interrupted'`，回前景無法自動 resume 時改發 `degraded` 不撕毀收音軌，由手機版顯示「點此恢復收音」橫幅；(4) `MobileApp.tsx` 遇永久性拒絕（401/403/400）自動收斂停止，不再卡在「連線中斷，重試中」；停用本地 10 秒輪詢與儲存金鑰時的重複預熱；支援「優先嘗試目前設定（如公司 Wi-Fi 內先試 OpenAI）→ 失敗自動嘗試另一把已存金鑰（如 Gemini）」的單次啟動備援；新增極簡音量脈動指示、離線偵測、一鍵改用另一家按鈕、`beforeunload` 防誤關保護與 `.txt` 匯出下載。
- **線上服務安全修正**：`services/online/src/routes/gemini.ts` 改用 `x-goog-api-key` header 取代 URL `?key=`，避免代理伺服器日誌洩漏金鑰（與 `gemini-transcription.ts` 與手機版對齊）。
- **證據**：`pnpm test` 全過（contracts 37／web 983／online 211／provider-boundaries 3／e2e-helpers 7／workspace 7／check:capacity OK）、`pnpm typecheck` 通過、`pnpm lint` 零錯誤、`build:online`（`index-CQJaUcp1.js`）與 `build:mobile`（`mobile-CwyWe1rM.js`，gzip 105.12 KB）通過。**尚未驗證**：真金鑰端到端、實體 iPhone／Android（麥克風、`interrupted` 實機恢復、螢幕恆亮）、OpenAI `client_secrets` 瀏覽器 CORS 實測；`gh-pages` 尚未推播更新（由使用者執行 `git push`）。

2026-11-10 手機網頁版（雲端線上版的免伺服器分支；接手請先讀[交接文件](HANDOFF_MOBILE_2026-11-10.md)）：診斷確認線上後端只負責「用金鑰換短效連線憑證」與本機 SQLite 保存，其餘都在瀏覽器；因此新增獨立輕量頁面 `apps/web/mobile.html`（`src/mobile/`），以瀏覽器內 broker 直接向 Gemini／OpenAI 取得短效憑證，金鑰由使用者在手機上分別輸入、只存該裝置 localStorage（見 DECISIONS D21，使用者當日核准）。範圍刻意縮小：只做麥克風收音的即時翻譯字幕、深色單欄大字逐字閱讀、字幕僅留記憶體（可複製／分享全文），不含純字幕、存檔、系統音訊與跨廠自動接管。既有 provider 只改三處取憑證呼叫改走 `service-fetch` 接縫與 worklet 路徑改用建置 base，桌面行為不變。證據：全專案單元 web 976／contracts 37／online 211 與架構邊界 3 項通過（之後新增 1 項錯誤訊息測試，手機模組 15 項另跑通過）、typecheck／`pnpm lint`／`build:online`／`build:mobile` 通過（手機主程式 gzip 約 103 KB，另有開始收音時才載入的繁中字典）；正式建置以假金鑰＋替身麥克風實測：金鑰測試顯示「被拒絕」、按開始後以白話訊息停下且可重試、金鑰不出現在頁面內容；Chrome 390×844／360×640 於模擬 Pages 子路徑實測首次輸入金鑰、字幕閱讀、設定面板、無水平捲動、往上閱讀時新字幕不搶捲動；以假金鑰實測瀏覽器可直接呼叫 Google 取憑證端點（回 400、被正確顯示為金鑰被拒絕）。**尚未驗證**：真金鑰的端到端字幕、實體 iPhone／Android（麥克風、螢幕恆亮、切到背景）、OpenAI 取憑證端點的瀏覽器跨來源許可。部署：已上線 https://zeroalcoholic.github.io/meeting-captioner/ （`gh-pages` 分支 e82de7a，由使用者執行 `git push origin gh-pages`；全域設定禁止代理執行 `git push`）。線上實測：HTTPS 200、載入最終建置、首次輸入畫面與靜態資源正常、無頁面錯誤。更新方式見 RUNBOOK「手機網頁版」。

2026-11-03 模組／架構隔離整理：已證實並修補雲端 Hybrid 入口仍載入地端、舊地端會議可續用，以及 online TypeScript 編譯仍包含地端的耦合。前端分成 `providers/offline/`／`providers/hybrid/`，兩條能力 alias 與 online 編譯／建置防跨界檢查同步；managed／ZIP 對齊，保留共用 PCM／VAD。38 項受影響單元、3 項故障注入邊界、Chrome 6 案與完整／online build 等證據見[本輪檢閱](evals/2026-11-03-module-boundary-review.md)。雲端 provider 產品邏輯未改，沿用既有驗證；不因重開重測。地端 source／mode 錯標、runtime／資源與既有品質缺陷列 L1–L4 待開工，未啟動模型或變更 18／26 LOCAL。

2026-11-03 雲端收尾修復：Gemini Stop 丟棄尾文、OpenAI Stop 未排空即關線，以及 Gemini 尾文回呼同步重啟後同 frame 混入新場，均有紅測後修補。最終完整單元 1,208 項通過；Chrome 兩家尾文／SQLite／匯出 2 案與可靠性 20 案的版本範圍分列於[驗證紀錄](evals/2026-11-03-cloud-stop-verification.md)。未呼叫付費 API，真服務品質／場域長測仍待驗，18／26 LOCAL 不變。依使用者要求保留版本與證據供下次直接接續，不因重開服務／工作階段重跑整套。另完成 [NVIDIA 模型調研](evals/2026-11-03-nvidia-realtime-translation.md)：優先評測 Riva Translate 4B v2 英→繁中，再評 Nemotron 0.6B 串流 ASR；未下載或接入。

2026-10-22 語音處理再校準：受控重播確認 SegmentStabilizer 強制定稿後以舊字元數截取上游改寫，`should approve` 改成 `should not approve` 時新 final 只剩 `aim.`、舊肯定句未更正；缺陷未修，真 ASR 發生頻率未知。另查明 launcher 優先的專案 `.venv` 確有 ASR 套件，但 Torch 檔案為 2.4.1+cpu；若照此環境成功啟動，現有 WhisperLive 裝置選擇會走 CPU int8，尚未實跑確認，不能以 deve 缺套件推論所有入口失效。500 ms VAD 不等於定稿延遲；既有中文檔案評測與 PyTorch VRAM 統計也不足以選本任務的英→中方案。本輪僅唯讀診斷／受控重播與文件校準，未修產品或啟動服務。詳見 [同日報告新增判讀](evals/2026-10-22-offline-calibration.md#語音處理再校準新增證據優先於前輪結論)。

2026-10-22 離線能力校準：使用者回報慢與品質不合需求，現有離線實作不視為可用會議方案；舊 P3 production-ready 宣稱已撤回。真 CT2 推論重現漏譯／重複，查明 SentencePiece 輸入缺少 Transformers-converted Marian 必要的 source EOS；只補 `</s>`，兩方向紅綠回歸與離線完整 87 項通過，6 個英→中合成句各兩輪及一個中→英測例前後對照確認部分漏句／重複改善，但仍有品質缺陷。逾時不能終止執行中的 worker 亦再次受控重現，未修；ASR／端到端延遲／真人品質／長會議未驗。Granite 5.0 2B 官方英→中未提供本版評測成績，仍僅列候選，未下載權重或接入。Ruff 未安裝；未改線上主線或既有驗收數。詳見 [調研與直接證據](evals/2026-10-22-offline-calibration.md)，本機原始資料 `.cache/offline-calibration-20261022/`。

2026-10-19 本批收尾：OpenAI 純字幕已將 capture 範圍沿 VAD、成功送音與 committed/completed 事件帶入 `inputAudioRange`；未知、跨 epoch、不連續及補零尾幀不猜範圍。這是本機輸入關聯，不是上游逐樣本 ACK 或逐字時間。完整單元 1,204 項、build、scoped eslint 通過；Chrome 兩家純字幕基線 2 passed（1.5 分鐘），OpenAI 經 SQLite 保存、重載及原始 JSON 匯出保留範圍。證據 `.cache/w04-input-range-all-unit.log`、`w04-input-range-native-20261019.log` 及同名輸出目錄。沿用既有模組，未新增依賴或管理器；雲端受控，非真 API 驗收。W04.2 其他 adapter 對齊及補送資格仍未完成，自動補送停用，總計仍 18／26 LOCAL。本批到此收束，不展開下一功能或重跑長測。

2026-10-19 W04.2 capture 時鐘映射已接入既有保留區與 lease owner；整數取樣率比例／連續原生時鐘／精確邊界才回傳範圍，其餘為 unknown，44.1 kHz 逐幀取整另有紅綠防誤判測試。63 項相關單元、web build／scoped eslint 通過；原生 16／48 kHz 三秒空窗兩案通過（10.3 秒），固定版本的 48 kHz 九十秒負載通過（1.7 分鐘）：960,000 樣本上限、零 >50 ms long task、2,900 段全部保存、31 次覆寫更新合併缺口、Stop 清除與新 epoch。首輪負載被本輪編輯觸發 HMR 中斷，不計驗收；失敗與固定版日誌分別保存於 `.cache/w04-clock-range-load-20261019.log`、`w04-clock-range-load-final-20261019.log`。provider 送音及上游完成尚未接線，補送未啟用，仍 18／26 LOCAL；此證據非真服務或實體裝置驗收。

2026-10-19 worklet 逾時回歸已收斂：capture retention 對型別明確的首次載入逾時，在同一有效音源上追加一次有界等待；保留每次 5 秒期限、可見 degraded、Stop 取消與失敗清理，不新增 timer／manager／依賴。原生 Chrome 六案單輪通過（30.0 秒），包含 16／48 kHz 時鐘比對、載入拒絕重試、6.5 秒延遲後一次 capture／一次 setup、斷線與 Stop；前端完整 942 項、web build、scoped eslint 通過。舊延遲案的 2 次 setup 假設已按 retention 在連線前初始化的實際路徑改為 1 次；另固定預熱與故障注入時序，保留初始失敗紀錄，未放寬期限或 PCM 斷言。證據 `.cache/w04-retention-timeout-native-final-20261019.log`、`w04-retention-timeout-web-final.log`；相關紅測與中間失敗檔同前綴。W04.2 時鐘標記尚未接入保留區／provider，補送未啟用，仍 18／26 LOCAL，完整長測與真服務／場域尚未完成。

2026-10-19 W04.2 音訊時鐘前置（未完成接線）：既有 pcm-worklet 新增 opt-in `frameMetadata`，以 AudioContext 原生 `currentFrame` 標記 PCM 起點；完整幀、flush 尾幀及輸入中斷分段已先紅後綠，相關 11 項單元通過。原生 Chrome 16／48 kHz 兩案驗證不同時間啟動、512／1024 樣本封包的 worklet 可按時鐘逐樣本比對一致；web build、scoped eslint 通過。正式 provider 尚未啟用此模式，重取樣／保留區／送音／上游完成仍未對齊，不宣稱 W04.2 完成。證據 `.cache/w04-clock-red.log`、`w04-clock-green.log`、`w04-native-clock-20261019.log`。

同輪舊路徑回歸未全過：初輪 2 passed／2 failed，現場為前案 SQLite writer lease 未釋放；native-audio 測試沿既有效能案例於 finally 關頁及釋放實際租約，修後 3 passed／1 failed（`.cache/w04-clock-legacy-fixed-20261019.log`）。剩 6.5 秒 worklet 延遲案：capture lease 的 retention 初始化先觸發 5 秒 worklet 期限，Gemini 在 capture 階段回報音源失敗、零 PCM，尚未建立雲端 session；舊測試期待連線後自動重試及 2 次 setup，需核對目前擷取恢復契約再修正，不能放寬門檻或以重跑掩蓋。既有 18／26 是先前 LOCAL 完成紀錄，本輪回歸未放行；未改電源設定、未呼叫真 API、未啟用補送。

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

W06.2 完成（LOCAL），目前 11／26 LOCAL 完成。既有 archive/outbox 保存永久遺失摘要，區分 RAM-only／瀏覽器待確認／SQLite 已存／匯出失敗；兩目的均可由畫面重試恢復，關頁保護與 quota 初始 metadata 恢復已補齊。最新 Chrome 故障矩陣 27 passed，包含真提交後丟失 ACK、重送去重與全文修訂／重複發言／gap 核對；C8 前端 102、後端 25、typecheck／lint 通過。90 秒正常保存、archive 停用對照及進行中匯出均零 >50 ms long task、最終全文 ID 一致；證據分為主輪兩案通過及修正測試入口後匯出單案通過，不稱同輪三案全綠。進行中匯出呼叫既有 download 函式，頂端選單仍依原設計停用。正式 bundle index-2LmsC_26.js 的正常／慢寫入／worker hang 四案沿用前輪通過證據。沒有新增產品 DB、依賴或管理器；本輪只抽出兩處共用的測試 fixture。證據 `.cache/hardening-w06-20261015/w06-2-verification.json`。真服務、場域與長測仍待原 W12/H 驗收；RAM-only 崩潰資料不宣稱可恢復。下一項依既定順序為 W04.1。

W06.1 完成（LOCAL）：managed service 沿用既有 runtime.json 保存首次 originPort，重啟固定原網址；占埠時不靜默換址、不連線或終止占用者，解除占用後可恢復。舊合法網址可沿用，損壞狀態檔保留並拒絕啟動；明確不同 --port 報 migration required／待救援未知，不實際變更。Chrome 真 IndexedDB／SQLite 重現跨埠同名 outbox 不可見，恢復原網址並核對 IPC／HTTP workspace、instance、build 後，原 pending event ID 重送去重、待存歸零且結案成功。9 項 managed service 測試、Chrome 一案、lint 通過；沒有新資料庫、管理器或通用搬移協定。10／26 LOCAL 完成。未知更早網址、localhost 別名、其他 Chrome profile 不宣稱自動救援；日常服務未啟停。證據 `.cache/hardening-w06-20261015/w06-1-verification.json`。

W05.2 完成（LOCAL，線上兩家×翻譯／純字幕）：Stop 立即停收音，Gemini 尾文完成訊號沿用既有有界 drain，不新增計時器；結案綁定停止時的 meetingId，舊場尾文不得結案新場。畫面區分未結案／已結案並提供保存重試；翻譯兩個匯出入口共用既有下載模組、讀完整 archive，失敗明示，不退回畫面尾段。原有 Markdown 格式保留，資料來自完整 JSON archive。兩家翻譯各驗 20,100 段下載、原文／譯文依片段 ID 對應、既有編輯器校訂、原稿保留及重新結案；純字幕兩家原生音訊基線含重開／校訂／匯出通過。最終產品 bundle index-CKloBGLP.js；完整單元 1079、build/typecheck/lint 通過。翻譯完整校訂證據分兩次命令：OpenAI 案通過，Gemini 案因測試誤用物件列舉順序失敗後改以 ID 精確核對，單案重跑通過（52.2 秒）；不是同一輪全綠。未加產品檔案、依賴、資料庫或管理器。完成數 9／26 LOCAL；測試服務關閉偶爾較慢原因未明，真雲端／場域／長測未驗，不能宣稱全專案完成。證據 `.cache/hardening-w05-20261015/w05-2-verification.json`。

W05.1 完成（LOCAL）：翻譯事件在畫面合併前進既有 archive/outbox；兩家切換、Pause/Resume、重開續接保留 meetingId，原文／譯文與修訂可取回。舊快照只補缺少資料，ACK 遺失重試不重複；保存啟動中 Stop 不復活收音，503 期間字幕持續、待存可見，恢復後原文補存核對通過。C8 前端 95＋後端／真 SQLite 24 項通過；移除臨時診斷後正式 Chrome 兩案 48.8 秒、退出碼 0，沿用既有 production build。新鮮審查核對 coalescer 先保存、writer 固定身分、App 取消及測試斷言，無新增平行資料架構。完成數為 8／26 LOCAL。先前測試結束偶發未退出仍未查明；兩次診斷均為零待處理請求／連線且正常關閉，不宣稱修復，列為後續程序關閉／整合長測的未解風險。此收工只對應 W05.1，W05 母包仍待 W05.2 結案／全量匯出，真雲端與場域資格未驗。本輪不展開下一項。證據 `.cache/hardening-w05-20261015/w05-1-verification.json`。

W05.1 續接與舊快照補強：App 已接 restoreTranslationSnapshot，先讀原會議 metadata／修訂序號，清空既有待送，再只匯入 archive 缺少的原文／譯文；已存修訂優先，舊快照保留，僅明確 MEETING_NOT_FOUND 才建立會議。未增加資料庫、queue、timer 或依賴。ACK 遺失重試不重複、未知 401/404/503 不誤建會議，client/outbox 41 項通過；正式 bundle index-nyg5R59v.js 的 Chrome 兩案通過（44.9 秒），涵蓋兩家舊快照匯入、雙向接管、Pause/Resume、進行中 reload 後同 ID 續接、既有修訂不變，以及保存啟動中 Stop 後不重啟收音。build/typecheck/lint 通過。曾有一輪案例通過後結束階段未退出，手動中止；加診斷重測及最後無診斷版本均正常退出，原因仍未確認，不宣稱已修復。保存故障的 App 重試閉環仍待補；結案／全量匯出屬 W05.2。W05.1 維持施工中、7／26 LOCAL 不變，真雲端／硬體／場域未驗。證據 `.cache/hardening-w05-20261015/migration-verification.json`。

W05.1 施工中：App 已在兩家線上翻譯啟動前取得綁定 meetingId 的 archive writer，重連／接管／Pause/Resume 沿用，新增獨立保存狀態與 pagehide/Stop checkpoint。Chrome 先重現字幕已顯示但 SQLite 零會議的兩個紅測；目前正式版本兩方向均驗原文／譯文入庫、接管／暫停續接同 ID、Stop 收音回收及重載後 DB 資料一致。慢寫入權限 2.5 秒會誤開雙 provider 的兩個紅測已修復，以既有 recovery 阻擋條件等待保存啟動；舊尾文進新場畫面的單元紅測亦已修復，保存仍留原場。完整單元 1067、C7 37 案為尾文／慢保存最後修正前版本；最後版本另驗相關單元 65、Chrome SQLite 2、連續性回歸 6 案及 build/lint 通過。SQLite／IDB 為真本機，音訊與雲端上游受控，非真服務場域驗收。待補保存啟動期間 Stop／保存故障、重開續接 revision、舊快照遷移；結案／全量匯出另依 W05.2。完成數維持 7／26 LOCAL。證據 `.cache/hardening-w05-20261015/app-verification.json`。

## 強固化施工進度 — 2026-10-15

W03.4 完成（LOCAL）：翻譯恢復須當前非空原文或譯文才恢復健康；空白／控制訊息不掩蓋停字，正常靜音不重連。反覆停字先給同廠恢復機會，第二次獨立停字後握手仍無內容則沿既有 MeetingRecovery 跨廠接管；不新增 timer、依賴或資源 owner。兩家有效紅測後，完整單元 1061（34＋860＋167）、Chrome C7 37 案、C4 原生音訊 35 案通過，build/typecheck/lint 通過；本次收工另重跑 provider/hooks 222 項通過。正式 bundle `index-CUiIC-Jd.js`；受控字幕恢復 Gemini→OpenAI 2242 ms、OpenAI→Gemini 2146 ms、OpenAI 同廠 1133 ms，三案通過。上述為本機受控上游證據，不代表真雲端延遲、百分位數、硬體或場域長測；W03 母包仍待 W12/H2。證據 `.cache/hardening-w03-4-20261015/w03-4-verification.json`。目前 7／26 LOCAL 完成，下一項 W05.1 翻譯寫入既有 archive。

W03.3 完成（LOCAL）：純字幕 OpenAI↔Gemini 接管共用既有 recovery、capture lease 與 archive，首筆有效內容才宣告恢復；同廠／跨廠首試分別 2／1 秒，後續退避與 Retry-After 保留。修復跨廠待內容期間續期 activate 拋錯後不再重試的漏口，有有效紅測及 55 項針對性綠測。最終 1049 單元（34＋848＋167）、build/typecheck/lint 通過。Chrome 完整雙向故障矩陣 12 案於前版通過；最終 bundle `index-CtnNkZWv.js` 重驗兩方向時序與同廠續期 4 案通過，OpenAI→Gemini 2396 ms、Gemini→OpenAI 2460 ms；翻譯共用排程回歸 15 案通過。核對 meetingId、purpose、缺口保存／重載／匯出、Stop 與單次收音。唯讀審查修正後未發現此範圍其他阻擋。以上為本機 VAD／IDB／SQLite＋受控上游，非真雲端、百分位數或場域長測；真服務資格仍交 W12/H2。版本、原始時序與雜湊見 `.cache/hardening-w03-renewal-20261015/w03-3-verification.json`。

W03.3 接管延遲修正：原線已結束後的跨廠首試沿用既有 1 秒 handoff 等待；同廠仍 2 秒、後續 4／8／15 秒與 Retry-After 不變，未新增 timer／依賴。前版受控 Chrome 為 OpenAI→Gemini 2994 ms、Gemini→OpenAI 3080 ms（後者未過）；正式 bundle `index-Dsm1xmgb.js` 重測兩方向為 2047／2141 ms，2 案通過，含 meetingId／transcription purpose／缺口保存重載匯出與 Stop 回收核對。這是各方向一次本機 VAD＋受控上游觀測，不是真雲端或百分位數。新增同廠／跨廠完整退避測試；針對性 54、完整單元 1048（34＋847＋167）通過。人工重試語意已有兩方向單元證據；完整故障矩陣與翻譯共用排程的新版本回歸、最後審查仍待完成，W03.3 不勾完成。原始證據 `.cache/hardening-w03-renewal-20261015/cross-delay-{green,unit,build,timing}.log` 與 `cross-delay-timing/`。

W03.3 施工中：純字幕 session 已接既有 `MeetingRecovery` 目標與兩家 transcription adapter，實際 backend 與使用者偏好分開；能力資訊優先讀 transcription taskCapabilities，沿用 capture lease／archive，沒有新增恢復 timer。跨廠連線需首筆非空文字才宣告恢復，等待狀態跨同廠續期保留；備援啟動拒絕不得卡死重試。新增 13 個單元涵蓋兩方向、scope／冷卻、能力更新、Stop 晚回呼、備援拒絕及內容前續期，保留有效紅測。最後完整單元 1043（34＋842＋167）、build/typecheck/lint 通過。修正內容前續期前的正式版本：Chrome 10 案通過（2.7 分鐘），涵蓋雙向成功／目的端拒絕／雙端拒絕／接管 Stop 與同廠續期；最後修正版另重跑雙向接管與同廠續期 4 案通過（2.3 分鐘）。既有單廠 401／429 4 案於前版通過。均使用真實本機 VAD／IDB／SQLite及受控上游，驗一次收音、Stop 後無送音／重連、全文重載匯出，不是真服務驗收；不同版本證據分開。尚待首有效內容延遲、跨廠缺口／meetingId／purpose 精確核對、人工重試語意與最後收工審查，W03.3 不收工。證據 `.cache/hardening-w03-renewal-20261015/cross-provider-verification.json`。

W03.2 VAD worker 修復驗證：Silero 初始化與推論改由專屬 worker 持有，沿用原有 capture／有界幀佇列；模型與 WASM 同來源，未新增依賴。ORT proxy 直接探針確認重用張量的 buffer 從 8 bytes 被轉移成 0，下一次推論出現 DataCloneError，因此沒有沿用 proxy。正式 bundle `index-BxJcSEcg.js` 兩家候選窗口均無 >50 ms long task，rAF 最大間隔分別 Gemini 13.1／OpenAI 12.8 ms；各兩個 worker 均終止、兩個 worklet 均斷開。完整單元 1029 通過；Chrome 首輪 10 passed／4 failed，修正退役測試的靜音循環與等待前置後，四個退役案例另跑全部通過（32 秒），未放寬產品 5 秒 drain。14 種情境的證據分屬兩個命令，不稱單輪全綠。詳細原始資料與失敗紀錄見 `.cache/hardening-w03-renewal-20261015/vad-worker-verification.json`；原生收音／恢復／401／429 回歸 13 案通過（2.6 分鐘），新增同服務先恢復、候選晚 ready 不可奪權的 session 回歸後 16 案通過。W03.2 本機行為與資源所有權審查已完成；最終靜態檢查與證據雜湊見同一報告。CPU／總記憶體、背景／低效能裝置、真帳號併發與 W12 長測未驗。

W03.2 資源量測未過：兩家 qualified renewal 各重現候選準備時 56 ms 主執行緒 long task（首輪約 59 ms），超過 50 ms 門檻；修正測試幀紀錄容量後仍各失敗，當前新增效能驗收為 2 failed。每家僅建立 2 個 PCM worklet，均處理音訊並於 Stop 前後斷開；此回收證據不抵銷卡頓缺陷。測試端獨立 observer 保存原始幀／long-task／節點生命週期，見 `.cache/hardening-w03-renewal-20261015/resource-diagnosis.json`。長任務位於候選 worklet 建立前，VAD／ONNX 初始化是待因果驗證的候選來源；下一步驗證既有 ORT proxy worker／本機資產／取消與尾文，不自建重複音訊管線、不放寬門檻。產品未修改，W03.2 不收工。

W03.2 時序／缺口補驗：兩家 qualified renewal 最終 2 案通過（1.1 分鐘），送出的唯一推估缺口與重載 JSON 事件及 manifest 完全一致，meetingId 正確、無未完成片段，起訖落在候選 ready 至新定稿 DOM 出現之間。DOM 首次出現由限定此情境的有界 MutationObserver 記錄，不再只用測試輪詢時刻；原始時間與缺口見 `.cache/hardening-w03-renewal-20261015/gap-accounting.json` 及其 raw 路徑。這是各一家一次受控觀測，不是百分位數、真雲端延遲或實際漏音樣本量；缺口保持 estimated／unrecoverable。產品未變更；W03.2 尚待 VAD 資源成本驗收。

W03.2 畫面隔離補驗：新主線已收到實際音訊並顯示 partial 後，注入退役線 partial／final；兩家均保持新主線即時文字，舊 final 進歷史且全文匯出一次。連同新主線故障後的尾文回收，共 4 個 Chrome 案例通過（2.4 分鐘，含較長清理階段；原因尚未確認）。首輪因刻意保留兩條線 final 卻仍等待首筆 final 的測試前置而死結，已修正僅此情境的等待條件。產品未變更，證據 `.cache/hardening-w03-renewal-20261015/live-isolation.json`。精確時序／缺口及 VAD 成本仍待驗；前輪完整 14 案是相同產品、較早測試快照的證據。

W03.2 退役尾文補驗：兩家各驗正常接管及新主線故障重連後回收舊 final，共 4 案通過；舊 final 取自真實送音的 commit/activity，在既有 5 秒範圍內回覆，保存／重載／匯出逐段核對一次。完整 pure-captions 14 案通過（4.5 分鐘），產品及 bundle 雜湊符合 qualification.json。本輪修正測試觀察輪詢延遲、按服務分組避免單寫入者租約互撞，並精確選取續接會議；產品期限與寫入保護不變。證據 `.cache/hardening-w03-renewal-20261015/retiring-final.json`。W03.2 仍待退役 partial 不蓋新 live 的瀏覽器證據、精確時序／缺口核對及 VAD 成本，真併發資格交 W12.2。

W03.2 補驗：兩家候選拒絕／就緒逾時／準備期間 Stop 共 6 個原生 Chrome 案例通過（4.0 分鐘）；核對主線持續送音、候選零 PCM、Stop 後 16 秒無新連線／音訊、收音軌釋放及保存／重載／全文匯出。首次 4 案因共用 SQLite 下的同名測試紀錄而選取失敗，已以情境名稱隔離，未放寬驗收。產品與正式 bundle 雜湊仍符合 qualification.json；證據 `.cache/hardening-w03-renewal-20261015/candidate-faults.json`。退役尾文整合、精確缺口與 VAD 成本仍待驗，W03.2 不勾完成。

W03.2 施工中：候選準備／接管／retiring final 已接服務端明確資格，兩家預設 false；資格隨 mint 進 active provider，無新增 UI 輪詢。正式 bundle `index-B1p48hOW.js` 的兩家 qualified renewal 受控上游整合通過（2 tests，1.2 分鐘）：候選晚 1.5 秒就緒、主線存活、候選 ready 前零 PCM、僅一次 getUserMedia、候選有效文字及保存／reload／export。舊 bundle 的 OpenAI 先停主線、Gemini 未採新續期建議已各重現有效反例。同步 Stop 另 3 個紅測後修復，session／兩 adapter 100 tests、server 43 tests 通過。未開併發的兩家既有瀏覽器流程亦通過（2 tests，2.1 分鐘）；同產品快照完整單元 1016（34＋815＋167）、typecheck/lint 與 diff check 通過。證據見 `.cache/hardening-w03-renewal-20261015/qualification.json`。候選失敗／Stop／退役尾文的瀏覽器故障矩陣、VAD 成本及真資格仍未驗收，完成數未增加。

W03.1 已完成 LOCAL 驗收：兩家／兩 purpose 的錯誤分類、Retry-After、永久拒絕、總期限與取消已接入既有恢復 owner。最後修正 OpenAI 備用連線 network 被首把 key auth 覆蓋，以及 Gemini 本機 worklet 失敗誤觸跨廠。最新重跑 970 單元及同輪 Chrome 39 tests 通過；正式 bundle `index-CqIAyV9B.js` 前輪 native 35 tests 通過，同產品快照。build/typecheck/lint 與差異審查已完成。證據 `.cache/hardening-w03-20261015/w03-1-verification.json`，範圍及限制見[主清單](superpowers/plans/2026-10-15-meeting-hardening-checklist.md)。

目前 **7／26 完成（LOCAL），另 1 項工程已驗、H1 場域待驗**。W03.4 本機驗收完成，下一項 W05.1 翻譯寫入既有 archive；真服務、同廠併發資格與真實場域未放行，W03 母包保持未完成。W03.1 的 970／39／35 為該項收工版本證據；後續產品改動以最上方施工紀錄為準。

W02.2 **工程已驗、H1 場域待驗**：指定麥克風 exact ID、原裝置／既有權限下自動恢復、分享人工重試、Stop/Pause 撤銷及晚到回呼回收；offline/hybrid browser mic 恢復保留原模式。疑似休眠／排程中斷以 wall-clock-only estimated gap 顯示，純字幕接既有 archive 保存，不捏造樣本。
本輪 905 單元、原生 Chrome 31、既有 Chromium 回歸 20、兩家純字幕保存整合 2 tests 通過，build/typecheck/lint 通過；最後移除 Stop 重複取消後另驗原生純字幕恢復／缺口保存 1 test。證據見[主清單](superpowers/plans/2026-10-15-meeting-hardening-checklist.md)與 `.cache/hardening-w02-20261015/w02-2-verification.json`。當時為 **3／26 完成，另 1 項工程已驗、場域待驗**；USB/BT/HDMI、睡眠／鎖定、WASAPI、真服務與場域長測未放行。當時下一項為 W03.1；目前進度以上段為準。

W01.1／W01.2／W02.1 已完成 LOCAL 驗收。W02.1 接上實際 PCM 停流監測、分層音源故障、Stop/Pause 清理與主畫面提示，修復重啟時舊收音請求、接管後舊警示及網路關閉誤報收音故障。Hybrid Meeting 雙軌仍未實作；試音不把金鑰存在當作雲端就緒。

W02.1：web 691 tests、contracts 32 tests、native Chrome 22 tests、既有 Chrome 回歸 20 tests、兩家純字幕原生音訊／VAD／保存整合 2 tests 通過；最後 WS closing 修正另驗 138 unit 與 Chrome WS 1 test。停流 DOM 計時翻譯 1.82 秒、純字幕 1.93 秒，另驗 WebRTC suspend/resume；最終 build/typecheck/lint 通過。證據 `.cache/hardening-w02-20261015/`。這是 W02.1 當時的本機證據，W02.2 最新狀態以上段為準；真實硬體、場域、雲端與長測未放行。

W01.1：C1 70 tests、Chrome 場景／既有連線／90秒 long-task 20 tests、production 20/6,000段 2 tests、normalized→DOM／操作基線通過。W01.2：9檔 113 tests、Chrome 回歸 20 tests、production 試音 10 tests、原生音訊／WebRTC 6 tests 通過；typecheck、正式 web build、最終 lint 通過。詳見[主清單執行紀錄](superpowers/plans/2026-10-15-meeting-hardening-checklist.md)，證據分存 `.cache/hardening-w01-20261015/` 與 `.cache/hardening-w01-preflight-20261015/`。以上保留 W01 當時的本機受控驗證紀錄；目前整體進度以本節最上方 W03.1 為準。

## 場域強固化診斷與施工藍圖 — 2026-10-15（施工前規劃紀錄）

施工入口已收斂為主清單內 26 項可領取任務，逐項列前置、既有修改落點、直接收工判準、驗證命令與證據欄；區分工程已驗／場域待驗／完成。補齊正式 build、語音素材、LOCAL 隔離、四路 120 分鐘長測及新增 E2E discovery 的前置。所有任務仍未開始，本次只驗證規劃文件，不表示產品或真服務已通過。

規劃再校準：主清單加入可量測的前景字幕／操作延遲、既有 long-task 門檻、長測資源及保存隔離要求；clean code 審查要求沿用現有恢復／擷取／coalescer／archive、單一 owner、清除被取代路徑。取消必建獨立 recovery-policy、產品備份 CLI 與通用雙軌 registry 的假設；新模組只在實際責任需要時抽出。此次只修訂文件，尚無新產品效能驗收。

最新使用者校正：**兩家交互備援必須有；Gemini 第二把金鑰才是後排。** 已新增[主工作清單 W01–W12](superpowers/plans/2026-10-15-meeting-hardening-checklist.md)，同廠恢復／OpenAI↔Gemini 接管納入 W03/W12，兩家各一 key 即可驗收；N1 另待第二 Gemini key 與後續開工。未修改產品功能，前次 80 項測試為診斷時證據，這次排序修訂僅驗文件。

本輪交付為診斷／規劃，未修改產品行為。已核對收音、純字幕／翻譯恢復、保存與 managed 入口，重跑 7 檔 80 項相關測試通過；日常服務 status 為 stopped，未啟服務或呼叫付費 API。
新增確認：full build 混合場景描述與單音源路由不符、純字幕先停後續期／同廠重試、Retry-After client 缺口、翻譯尚未接新 archive；動態埠造成舊 origin 待存佇列不可見為待重現架構風險。指定 Python 仍缺 whisper_live/pyaudiowpatch。
見[診斷與場域契約](superpowers/specs/2026-10-15-meeting-resilience-design.md)及[A 收音／連續性](superpowers/plans/2026-10-15-capture-continuity.md)、[D 保存／服務](superpowers/plans/2026-10-15-durability-service.md)、[N/V 網路／場域驗收](superpowers/plans/2026-10-15-venue-release.md)。
本藍圖整合既有 R/L/T 工作，未把歷史已驗能力重列為全未做，也未將 60 秒音訊緩衝當成無漏字保證；新任務均未施工。既有 10/12 驗證範圍如下，仍不等於真人各場域放行。

## 會議可用度校準 — 2026-10-12

兩家翻譯與純字幕各 30 分鐘、四路 Chrome 原生音訊受控長測通過，跨過 Gemini 多次換線及 OpenAI 25 分鐘續期。
純字幕各 151 段，SQLite 與原稿／校訂稿 JSON、TXT 全文一致；仍有 OpenAI 1／Gemini 3 個續期缺口。
這是本機連續性與保存證據，真人品質、真實網路及無缺口續期仍未驗收。見 [會議校準報告](MEETING_CALIBRATION_2026-10-12.md)。

> Single source of truth for **what is built / in progress / blocked**.
> Update at the end of every meaningful task.
> Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md). Backlog: [`TODO.md`](TODO.md).

---

## Current Phase

### 專案診斷與近期工作收尾 — 2026-10-12

已重新核對 10/08–10 的未提交成果，修復預設測試／格式檢查被 Python cache 阻斷、
OpenAI E2E 替身過時、production 套件誤收集，以及翻譯交接途中 Pause 未停止全部收音、
退役／失敗備援覆蓋健康狀態、逐字稿永久性 HTTP 拒絕無限重送。
保存拒絕後保留 IDB 佇列與字幕，顯示暫停重送原因，服務修復後可明確重試。
857 項 JS、85 項 Python、18 項服務／評測工具回歸、50 項預設 Chrome、6 項原生音訊及兩家 production 純字幕整合通過；最後快取順序修正另重跑 12 項相關 Chrome。
完整驗證與服務身分見 [本輪診斷報告](DIAGNOSIS_2026-10-12.md)。
真人混語品質、純轉寫 PCM 重播／無缺口續期、真實網路／長會議及離線引擎仍未整體驗收。
本輪不將歷史「完成」標記擴大成整個產品完成。

### 混語純字幕與會議功能藍圖 — 2026-10-08

依後續開工指示，已實作專用純轉寫與地端逐字稿，**真實雲端品質尚未驗收**。第一步是專用純轉寫模式，
中文顯示台灣繁體並保留英文／原文，不新增同語翻譯方向。依使用者最新目標，
首版必須包含 A 純字幕＋B/L1 完整地端逐字稿、校訂留痕及重啟恢復，不能只交付畫面字幕。
後續是語者補註、可追溯點列摘要與議題脈絡；既有 R5/V1/L1/L2
及離線缺陷仍開放。模型／協定／混語品質須真實評測，不能以有 key 代表可用。
施工前已透過 managed 入口停止舊服務，完成後已恢復並驗證單一實例重用與 AppData SQLite。新增 OpenAI `gpt-live-transcribe` 與 Gemini
`gemini-3.5-transcribe-live` 純轉寫 adapter、單字幕工作區、Silero 本機 VAD、SQLite worker、
獨立 IndexedDB outbox、寫入租約、原稿／校訂稿及全量 TXT/JSON/SRT。
OpenAI 主金鑰／備援金鑰同時涵蓋 mint 授權拒絕與連線階段失敗；不把一般網路錯誤宣稱為 IP 封鎖。
已執行真實付費 API：OpenAI 主／備金鑰及 Gemini 均完成合成混語轉寫；備用 OpenAI 與修正後 Gemini 另通過結案、重載與 TXT 匯出。修正 Gemini REST 憑證欄位、模型 resource 前綴及跨段過早開始造成的漏句；詳見 [真雲端報告](evals/2026-10-08-real-cloud.md)。24 個錄製情境不等於真人 gold corpus；真人混語準確率、真實內外網切換及真雲端長測仍待直接證據。
本機驗證：819 項單元／回歸、兩家各 60 分鐘 Chrome 原生音訊長測與停止／重載／校訂／匯出通過。
OpenAI 302 段、Gemini 301 段，資料庫與匯出逐段一致；續接分別標示 2／7 個未補回的推估缺口，不能宣稱無漏音。
另通過 renderer crash＋ACK 遺失恢復、360px／1280px 排版及鍵盤全螢幕。長測使用受控上游，非真實 ASR 評分。
最新實作差異與逐項證據見 [執行紀錄](superpowers/plans/2026-10-08-execution-ledger.md)。
真雲端後續 Review 修正 Gemini 同活動多 final 歸屬、Stop 等待 generationComplete 及推估時間區間；本輪使用原始雲端事件重播與 Chrome 受控整合驗證，未新增付費雲端呼叫，見 [審查及後續工作](evals/2026-10-08-review-followup.md)。
見 [診斷與藍圖](superpowers/specs/2026-10-08-mixed-language-captions-meeting-blueprint.md)
與 [第一階段執行清單](superpowers/plans/2026-10-08-mixed-language-captions.md)。

2026-10-10 失效切換改為先通後斷、同廠優先（[工作報告](WORK_REPORT_2026-10-10.md)）。
`HANDOFF_GRACE_MS = 20_000` 讓斷字幕窗回到 20,246 ms，違反數字① 的 3 秒目標；
但直接調小會重新弄壞 2026-10-02 修好的「不打斷進行中的握手」。改法是不再二選一：
後端回報失敗後先給同廠 1,000 ms 自救，期間不碰備援；備援連上後若同廠已自行恢復則停掉備援、留住同廠；
且永不為了啟動備援而拆掉同廠（擷取租約本就支援多持有者，麥克風不重開）。
**斷字幕窗 20,246 → 2,232 ms**（預算 3,000），`meeting-recovery` 10/10、`online-failover-latency` 2/2。
代價：同廠的有界重連最長 20 秒現在只拿得到 1,000 ms（`HANDOFF_DELAYS_MS[0]`，可調）。

2026-10-09 第一梯 T0–T5 完成（[診斷、量測與任務序](evals/2026-10-09-followup-diagnosis.md)）。
查證結論：兩家上游都沒有可靠的直出繁中——OpenAI 已送 `languages: ['zh-tw']` 與繁體 prompt，真雲端輸出仍是簡體；
Gemini Live Transcribe 的華語只有 `cmn-Hans-CN`，且不支援 system instructions。用戶端轉換因此是正確選擇，
但原設定 `to:'tw'` 只換字形不換用詞，已改為 `to:'twp'` 加一份與雲端提示共用的專案術語表；
歧義詞（`質量`、`訪問`）刻意不轉，`rawText` 原文照舊保留，標記升為 `opencc-cn-twp-v2`（v1 仍可讀取舊檔）。
OpenCC 字典（gzip 497 KB）原本同步載入並佔首屏八成，已改為收音啟動時與 token／麥克風／VAD 平行動態載入，
主程式包 gzip 由 624,023 降至 125,770 B；同一份程式改回靜態匯入重建可得 581,183 B，證明省下的首屏量體來自切分本身。
載入失敗視為啟動失敗、絕不以未轉換文字上字幕。
熱路徑轉換成本實測：每個 delta 重轉整段累積文字，600 字／150 deltas 的長句整句累計 3.6 ms、每 delta 最壞 24 µs，
相對 32 ms 幀預算可忽略，因此不加快取或增量轉換。
另新增 `predictions.json` 擷取工具、斷句三門檻可注入（預設值未動，選值等真人語料）、
兩家送出 `keywords`／`custom_vocabulary`。**辨識品質未因此獲得任何新證據。**

### Managed Windows daily service — 2026-10-06

Added `pnpm service:start/status/stop` and `start-service.cmd`: a workspace-scoped
Windows named-pipe owner builds and serves the online UI/API in one Node process.
Repeated/concurrent starts reuse the owner. Preferred loopback port 43871 falls
back to an OS-assigned port on collision, without terminating its occupant.
Instance identity gates Stop; immutable build snapshots protect active assets.
Managed mode disables CORS grants because the UI/API share an origin, including
after port fallback. Development/legacy release entry points remain separate.
Six real IPC/HTTP lifecycle tests, 525 web tests, 91 online tests, typecheck and
the unmodified `pnpm lint` command passed. A production Chrome exercise occupied
43871 with a foreign service, started two CLIs concurrently, verified one fallback
instance, captions and CORS isolation, and proved Stop preserved the foreign
service. It also exposed and fixed an online-only Hybrid health probe to 8000.
The final service runs at 127.0.0.1:43871; the previous agent-owned 8787/8000
processes were identity-checked and stopped. No cloud audio was sent.
See [operating instructions](RUNBOOK.md#managed-windows-service-2026-10-06)
and [scope/acceptance plan](superpowers/plans/2026-10-06-managed-service.md).

### Local diagnosis and service startup — 2026-10-06

Historical startup below was replaced by the managed daily service above.
Its 8787/8000 processes are now stopped; the reported offline limitations remain.

Current worktree built and started at `http://127.0.0.1:8787/`; Chrome verified
the actual production page's Demo captions without page errors. 633 JS tests,
85 Python tests, 26 mock Chrome integration cases and 6 native Chrome audio
cases passed. Typecheck passed;
source lint passed only after excluding Python cache and generated `.cache`
artifacts. The default test/lint commands still encounter cache scanning errors.
Offline FastAPI is running on 8000 but ASR is unavailable: the required Python
runtime lacks whisper_live and pyaudiowpatch. Real local MT inference reproduced
zh-to-en repetition, and a controlled probe proved MT timeout does not release
an already-running worker. No product code changed or paid API ran; the native
60-minute and real-service gates remain open.
See [diagnosis and runtime identity](DIAGNOSIS_2026-10-06.md).

### Active repair task — 2026-10-02

**Reopened after the user's completion challenge.** The prior mock-only gate
missed native audio failures. Worklet rejected-module caching, unbounded/ignored
resume failures, stale PCM callbacks and wrong Gemini sample-rate declarations
are now repaired. Current evidence: 543 web/contracts tests, 26 mock Chrome
integration tests, plus 6 production-bundle/native-Chrome audio tests covering
real HTTP 503 recovery, 16/48 kHz PCM, delayed setup, reconnect, GoAway and Stop.
Native WebRTC additionally proved a missing readiness gate: candidates now require
DC open plus session.created; failed candidates preserve the primary, while active
DC close/error triggers renewal immediately. Local RTP and decoded PCM passed.
A remaining R5 gate is real wall-clock LOCAL soak. The two-hour fake-clock
run and short native tests do not establish sustained native audio operation;
the 60-minute isolated run was interrupted by Windows sleep after about 17 minutes.
OS event timestamps corroborate the interruption; Playwright timed out. It is not
a pass or proof of a product recovery defect. The R5 long-run gate remains open.
A second run was interrupted for measurement calibration: per-frame Playwright
assertion reporting accumulated 60,000+ steps and reproduced increasing callback
cost without any browser. Native frame invariants now use Node strict assertions;
all sampling operations have local deadlines and stage diagnostics. A separate
production-bundle 20/6,000-history comparison did not reproduce the slowdown.
The calibrated continuous 60-minute gate is still pending; see the repair report.
The timestamped candidate ZIP and hashes are recorded in the repair report.
The user's actual deployment/start path is still unidentified; localhost:8787
currently serves the separate audiomodel interface. Do not mark overall closure
or real-service acceptance complete. No new paid API test ran.

User authorized implementation and requested an explicit task; online recovery
repairs now take priority over local processing. Track R1–R5 in the
[execution plan](superpowers/plans/2026-10-02-meeting-continuity.md).
The prior engineering stage passed 507 web/contracts tests, 90 online-service tests,
26 Chrome mock integration cases and the production build. A two-hour fake-clock
exercise covered 24 rotations with one capture and no remaining timers after Stop.
See [evidence and remaining gaps](MEETING_CONTINUITY_REPAIR_2026-10-02.md).
The current engineering review completed a shared whole-attempt deadline,
lifecycle cancellation, callback reentrancy fixes, Retry-After/CORS handling and
a single meeting retry scheduler. Those counts describe that prior stage; the
current native-audio verification totals are above.
This is local verification, not a deployed release or real-service long-meeting
reliability claim. Automatic local LOG/TEXT storage remains required but is scheduled
after this repair stage, together with separate local-processing work.
No new paid API test is authorized. Mock results must not be reported as proof
of real long-meeting reliability or complete information recovery.

### Continuity implementation blueprint — 2026-10-02

Proposed [design](superpowers/specs/2026-10-02-meeting-continuity-design.md) and
[T00–T11 work plan](superpowers/plans/2026-10-02-meeting-continuity.md) now define
LOCAL-only automatic LOG/TEXT storage, meeting ownership, recovery, bounded audio
retention, acceptance gates and release checks. A local Node 24.14.0 / SQLite 3.51.2
worker probe retained 100 committed events after process kill, rolled back the
uncommitted event and passed integrity_check. This is feasibility evidence only.
Initial design uses a single DB connection with DELETE/FULL, not default WAL;
worker packaging, candidate audio gating and local repair capability remain
explicit implementation gates. No production feature was changed.

Cost correction: long soak/fault tests run locally against explicit mock transports;
new paid API runs require an approved budget. The earlier fixed six-hour live API
gate is withdrawn, without presenting local tests as proof of real long-meeting
reliability. Read-only [audiomodel review](AUDIOMODEL_READONLY_REVIEW_2026-10-02.md)
identifies a local ASR candidate, not an existing translation/recovery solution.

### Meeting continuity diagnosis — 2026-10-02

Current-source diagnosis includes a completed 11.8-minute real API / Chrome run:
Gemini sent a natural GoAway with 50 seconds left, the app closed immediately,
sent 14 audio frames before reconnect setup completed, then switched providers.
Fifteen controlled diagnostic assertions passed; five Chrome scenarios reproduced
handoff, stale-error and Retry-history failures. The existing 61 related unit tests
pass but do not establish lossless continuity. User additionally requires automatic
durable logs and meeting translations; current opt-in, single-snapshot storage
does not meet that requirement. Dedicated translation remains the main path.
No runtime repair was made. The user's deployed build and incident close reasons
remain unconfirmed. See [the findings, evidence limits and recommended
repair order](MEETING_CONTINUITY_DIAGNOSIS_2026-10-02.md).

Critical re-audit: real-run DOM length samples do not prove ongoing translation;
the empty diagnostic errors array was not a complete error collector. Direct
OpenAI event timing and semantic loss remain unmeasured. Report section 7 separates
observations from causal inference and makes durable saving and recovery repair
co-priorities, rather than delaying audio protection until after storage work.

### Online-first diagnostic — 2026-09-11

**Current result: real application audio exercised.** Production frontend + Chrome native
capture/media + real APIs now render captions through OpenAI WebRTC, OpenAI WS
(controlled SDP rejection), Gemini, and an audio-only-key process. Pause/resume,
both provider switches, socket reconnect and Stop resource release were exercised
with synthetic English, not user meeting audio. No claim of perfect translation:
repeated runs exposed mistranslation, omitted words and one silence hallucination.
See [the direct results](ONLINE_DIAGNOSIS_2026-09-11.md).

Repaired deadline-split caption context (date units and negation), premature
listening cues, and WebRTC renewal closing the old peer before the candidate was
connected. Continuations are bounded display context, not duplicated stored text.
Renewal candidates have a 10-second readiness bound and Stop cancellation.
Retired OpenAI sessions stop sending audio and drain pending translation separately
from the new live session. Real WebRTC and WS runs with accelerated renewal each
preserved both repeated dates, Friday deadlines and negations in the UI export.
Drain is bounded to 10 seconds; Stop remains immediate.
Final local regression: web 382, online 86, contracts 20; all 38 Chrome cases passed
after the final drain changes. Retained 2,000-caption load over 90 seconds: zero

> 50 ms tasks. Build succeeds; main JS 820.99 kB / gzip 612.95 kB retains the
> chunk-size warning.

Gemini uses v1beta. Both OpenAI key slots and Gemini work in this network; release
launchers support primary-only, audio-only and Gemini-only. Fastify 5.12.3,
Zustand 5.0.15 and OpenCC 1.4.2 are installed. Other major framework upgrades,
other networks, physical conference-room audio and full-length meetings remain
outside the evidence established here. Earlier diagnostic runs follow below.

Priority is now online caption smoothness, latency, model currency and quality,
per the user's current instruction. Offline/Hybrid/summary/packaging expansion
is deferred. See [the diagnostic](ONLINE_DIAGNOSIS_2026-09-11.md).

**Evidence correction:** the earlier long-task test seeded 2,000 segments but
then used Fresh Start, which cleared them before measurement. Its previous
zero-long-task result did not establish performance with a long meeting's
history. The corrected test uses Continue and verifies the actual active store
count and visible history before and after the measured stream.

**Locally verified repairs:** OpenAI WebSocket setup now has a full audio-setup
deadline and explicit activation at ownership transfer; non-auth failures do not
demote keys, and a closed renewal candidate leaves the healthy old session intact.
Regression: web 343, online 77, contracts 19, offline 85; Chrome 152 browser
integration 36 passed with mocked external transports/capture. Corrected history
load: 2,000 retained segments, 90 seconds, zero tasks over 50 ms. Mocked failover
to visible captions: 2,129 ms / 1,151 ms. Typecheck, cache-excluded ESLint and
production build pass. See the diagnostic for commands and environment limits.
Real-provider latency, translation quality and long-meeting soak remain unverified
in this run; the two dedicated translation model defaults are unchanged.

### OpenAI transport failover — complete (2026-08-20)

The corporate `sk-svcacct` key mints a translation client secret, then the
browser's SDP POST to `/v1/realtime/**/calls` is refused with
`401 ip_not_authorized`: the org IP allowlist covers the realtime media
endpoint, not the mint endpoint, so nothing the server observes reveals it.
`a269ac8` adds a second transport rather than a second provider.

| Item                | Current evidence                                                                                                                                 | Status              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| WebSocket transport | `apps/web/src/providers/openai-ws-transport.ts` — same session events as WebRTC, shared AudioWorklet, 24 kHz PCM16 resample with seam-safe state | ✅ locally verified |
| Fallback order      | WebRTC → WebSocket → alternate key slot; refusal cached per slot for 30 min. Rationale in `DECISIONS.md` D13                                     | ✅ locally verified |
| Key failover        | `services/online/src/openai-keys.ts` — primary preferred, 401/403 retries the alternate, demotion expires after 30 min (D12)                     | ✅ locally verified |
| Docs                | `DECISIONS.md` D12/D13, `FAILURE_MODES.md`, `RUNBOOK.md`, `PROVIDER_BACKENDS.md`                                                                 | ✅ updated          |

### P2-ONLINE — phase 2 online long-run — complete (2026-08-13)

Execution contract and per-task ledger: [`PHASE_2_RUN.md`](PHASE_2_RUN.md).
Goal definition: [`GOAL_PHASE_2.md`](GOAL_PHASE_2.md). Scope was fixed to the
two online paths only — offline, hybrid, summary and Electron were deliberately
excluded so the run could not expand mid-flight.

The three closing conditions and what backs each:

| Closing condition                             | Result                                                                                                                                                                      | Evidence                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ① failover caption gap ≤3 s                   | A1+A2 **2145 ms**, A3 **1137 ms** (measured to the caption returning to the DOM, not to the notice)                                                                         | `tests/e2e/online-failover-latency.spec.ts`; baseline 30–31 s in `FAILOVER_BASELINE_2026-08-12.md` |
| ② no >50 ms main-thread task while captioning | Original 2,000-segment claim invalidated by Fresh Start clearing history; corrected 2026-09-11 run: **0 tasks over 50 ms**, 2,000 retained segments, 90 s, positive control | `tests/e2e/caption-longtask.spec.ts`; see diagnostic above                                         |
| ③ no cross-tier UI claims                     | Removed the "2–3 s behind speech" copy that had no measurement behind it; the UI now states no latency number                                                               | commit `8-C1`                                                                                      |

Twelve S1 tasks completed (E1, E2, baseline, A1, A4, A2, A3, B1, B2, D1, C2,
C3), plus C1 and the error boundary. `D2` (Gemini 32/100 ms chunk screening)
stays **deferred** — it needs a live speaker and real quota, and is explicitly
not a closing condition.

Two things this run recorded that are easy to lose:

- **B-zone premise did not hold.** B1/B2 exist to fix "the picture stalls while
  someone is speaking". When it was finally measured, that stall was **not
  observable — 0 long tasks both before and after the fix**. Moving synchronous
  `localStorage` writes off the caption path remains correct hygiene; claiming
  it fixed a measured stall would not be. The control group that proves the
  `PerformanceObserver` is actually observing must stay: a broken instrument and
  a smooth main thread produce identical output.
- **Gate G1 was not triggered.** `MODEL_RECENCY_2026-08-12.md` found each
  provider's current pin to be its only dedicated realtime translation model,
  so no pin change was needed. Re-verified 2026-08-28, see
  [`MODEL_RECENCY_2026-08-28.md`](MODEL_RECENCY_2026-08-28.md).

An external review (Codex, 2026-08-13) raised seven defects; all seven were
confirmed real and fixed in `f4566b9`, each with a failing-before test. Two are
worth remembering: the e2e stopwatch had been stopping at the handoff _notice_
rather than at the returning caption (so the earlier 2020/1028 ms numbers had no
backing), and a Gemini drain guard had been written in `start()` where the stale
instance never passes, letting a previous meeting's tail land on a cleared board.

Automated evidence at the end of S1 (2026-08-13): contracts **19**, online
**68**, web **307**, Playwright **32**. Re-run 2026-08-28 after the transport
work: contracts **19**, online **77**, web **338**, offline **81**, Playwright
**35**; `pnpm typecheck`, `pnpm lint`, `pnpm build` clean.

### Phase 1 closure — complete (2026-07-30)

The Phase 1 correctness, privacy, lifecycle, caption-path, and loopback changes
are implemented and verified. With explicit authorization, the minimal live
probe created one OpenAI translation client secret and one one-use Gemini token,
completed the Gemini `setupComplete` handshake, and sent no audio or transcript
content. Both redacted fixtures are checked in and consumed by tests.

| Item                         | Current evidence                                                                                                                                                                         | Status              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 0.2 / 1.1 upstream contracts | `b8029e6`: live OpenAI/Gemini probe passed; two redacted fixtures pass fail-closed read-back and source-key scans; provider unit compares `clientFrame`, E2E mock consumes `serverFrame` | ✅ live verified    |
| 1.1 / 1.2 Gemini correctness | `13f6311`: exact `models/gemini-3.5-live-translate-preview`, top-level transcription fields, `setupComplete` required before connect, close/timeout fail, no native-audio fallback       | ✅ locally verified |
| 1.3 transcript privacy       | `c587fc2`: retention is explicit opt-in and defaults off; disabling it serially clears IndexedDB without a late-write race                                                               | ✅ locally verified |
| 1.4 session switching        | `7dd2362`: mode/scenario/backend/language are locked while running; Stop releases capture and transports before switching                                                                | ✅ locally verified |
| 1.5 caption-path isolation   | `b67d810`: one bounded FIFO MT dispatcher (capacity 10), drop-oldest under pressure, visible `translation:degraded`, cancellation prevents late emits                                    | ✅ locally verified |
| 1.6 local-only launch        | `2adcd78`: WHL and FastAPI production launchers bind `127.0.0.1`; production reload removed; both launchers share `run_whl.py`                                                           | ✅ locally verified |
| Release-gate hygiene         | `171c05b`: Prettier, ESLint, Ruff, duplicate-test collection, and cross-platform EOL gate repaired                                                                                       | ✅ verified         |
| Online test lifecycle        | `68125d4`: test Fastify instances no longer accumulate `pino-pretty` process listeners; production/dev logging is unchanged                                                              | ✅ verified         |

Current automated evidence: contracts **19**, online **65**, web **293**,
offline **81**, Playwright **30**; `pnpm lint`, `pnpm format:check`,
`pnpm typecheck`, `pnpm build`, Ruff, Bash syntax, fixture verification, and
build/fixture source-key scans exit 0.

**Gemini latency — root-cause closure + perceived-latency fix** ✅ **COMPLETE** (2026-07-02)

Deep-dive against the current official Live API docs (live-translate page, API
reference, best-practices, session-management, models page) settled the question:
**`gemini-3.5-live-translate-preview` has NO server-side latency knob.**
`translationConfig` carries only `targetLanguageCode` + `echoTargetLanguage`;
TEXT modality, `speechConfig` speed, `thinkingConfig`, and VAD tuning are all
unsupported/ineffective for this model, and the caption text side-channel
(`outputAudioTranscription`) is structurally paced by the model's translated-
audio generation. Independent measurement (LiveLingo, 120 utterances) puts
first-audio latency at **~2.9 s median** (drift to ~14 s under stress); Google's
own wording is "a few seconds behind the speaker". Our client stack (32 ms PCM
frames, 16 kHz, 33 ms coalesce, live/final store split, output-first anchor)
already meets every official best practice — client-side is at the floor.
Reverting to the turn-based `gemini-3.1-flash-live-preview` path was evaluated
and rejected: it was the ORIGINAL backend (2026-06-09) and was replaced by the
translate model precisely because turn-based VAD waits are worse for continuous
meeting speech.

What shipped instead (the two levers that remain honest and real):

- **Pending-source live caption** — during the ~2–3 s translation-lag window the
  big target area now shows the already-arrived source text (dimmed
  `.pendingSource`, tagged 翻譯中…) instead of a dead "翻譯中…" placeholder,
  swapping to the translation on its first draft delta. This converts every
  sentence's dead window into live captioning — the dominant "Gemini 特別慢"
  percept. (`CaptionBoard.tsx`, `CaptionBoard.module.css`; e2e
  `openai-realtime.spec.ts` "pending source" test — same LiveCaption path both
  backends share.)
- **Honest latency labeling** — the Gemini backend hint no longer claims
  低延遲; it states ~2–3 s model-inherent lag and recommends OpenAI for
  latency-sensitive meetings. (`SettingsPanel.tsx`.)
- **e2e mock drift fix** — the mocked `getUserMedia` stream now implements
  `getAudioTracks()` (the provider's audio-only SDP path), un-breaking 3
  pre-existing openai-realtime e2e tests that failed with
  `stream.getAudioTracks is not a function`.

Verification: 283 web unit tests + 29 Playwright e2e green; `tsc -b` clean.

**Gemini Live Translate latency correction** ✅ **COMPLETE** (2026-06-29)

Field tests showed the remaining Gemini complaint was per-utterance cadence, not
startup. The Gemini translate path now defaults to the official Live Translate
`AUDIO` response modality and consumes `outputAudioTranscription` as the text
caption side channel, discarding synthesized audio. This reverts the earlier
cost-saving `TEXT` modality because venue use prioritizes fastest visible
translation over output-audio token savings. The provider also now anchors
`outputTranscription` deltas to a synthetic live transcript when translation text
arrives before source transcription, so the caption board renders Gemini drafts
immediately instead of waiting for `inputTranscription`. Locked by
`gemini-live-provider.test.ts` setup-shape + output-first live-anchor coverage;
YouTube/system-audio field test should be rerun against the same clip to confirm
Gemini `ttfcMs`/`durP50` and visible stalls improve from the prior cadence.

Review follow-up (2026-06-29): failover now checks target backend
availability before rendering or executing the switch, so a self-retrying
provider is not stopped when the alternate key/service is unavailable. The
Gemini cost chip now estimates AUDIO-mode Live Translate billing (~$0.0368/min,
input + generated output audio) instead of the old TEXT-output lower bound.

**Project KEEPALIVE — 永續雙模型字幕強化** ✅ **COMPLETE** (2026-06-12)

Reliability/continuity hardening of the online realtime path so it satisfies the
three hard requirements: **多元模型 (multi-model) · 不會斷 (never goes dark) ·
可接續 (resumable)**. Delivered:

- **#16 Gemini receive-side wedge detection + persistent reconnect** — Gemini
  now matches OpenAI's self-heal: a stale-data detector (no serverContent while
  audio is active past 30 s) forces a session-resuming reconnect, and reconnect
  retries FOREVER with a capped backoff (was: gave up after 5 attempts). After
  5 quick attempts it surfaces `transport: failed` so the failover UI appears,
  while still retrying underneath. (`gemini-live-provider.ts`, +5 tests.)
- **#7 OpenAI zero-gap renewal (make-before-break)** — the 25-min session
  renewal now builds the new peer over the EXISTING mic stream and swaps
  atomically, so a scheduled renewal costs ZERO caption gap and never
  re-acquires the mic (no OS-indicator blink / re-prompt). On failure the old
  session is left alive and a persistent retry runs; status stays `running`.
  (`openai-realtime-provider.ts`: `buildPeer`/`wirePeer`/`fetchSessionToken`/
  `resetStaleBaselines`, +1 zero-gap test; existing retry/stop tests updated.)
- **#21 Cross-model one-click failover** — when the active backend hits
  `transport: failed`, a `FailoverBanner` offers a one-click switch to the other
  model, preserving the transcript (no `beginSession`). Decision logic isolated
  in `providers/failover.ts` (+7 tests). (`App.tsx`, `SessionLauncher.tsx`,
  `index.css`.)
- **#3 History tail-window rendering** — `HistoryStream` renders only the most
  recent `HISTORY_RENDER_SEGMENTS` (400) finalized segments; the store keeps the
  full history (Export reads it). Bounds DOM + paragraph-grouping cost on
  multi-hour meetings. (`paragraph-grouping.ts` `tailSegments`, +4 tests.)
- **#19 verified** — `package-online` ships `pcm-worklet.js` (Gemini needs it);
  confirmed present in the produced release zip.

Deferred (honest, not done blind): **#8 Gemini meeting-mode noise suppression** —
Gemini has no server-side far_field NR like OpenAI, so the 'meeting' profile
(all browser DSP off) hands it raw room audio. Enabling browser NS risks gating
non-dominant speakers; this is a quality tradeoff that needs real multi-speaker
meeting audio to tune without regressing. Tracked, not implemented.

Verification: **238 web unit tests + 15 Playwright e2e (real Chromium) green**,
typecheck clean, online build + `package-online` succeed.

---

**P3 — Offline STT + MT Pipeline** — historical implementation milestone (4 commits on master); current usability not accepted

The earlier production-ready claim is withdrawn: later real-model diagnostics and user feedback show unresolved offline failures. See the 2026-10-22 calibration above. The following describes implemented code, not a working deployment or quality acceptance. WHL is designed to run as an independent process (port 9090).
FastAPI service (port 8000) proxies ASR, applies glossary-aware CTranslate2 translation,
and streams normalized events to browser. WASAPI system audio loopback implemented.

---

## Phase Status

| Phase     | Scope                                                                                                                                                                                                                             | Status                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **P0**    | Foundation skeleton                                                                                                                                                                                                               | ✅ complete            |
| **P1**    | Scenario picker + Mode selector + Health row + Audio level meter                                                                                                                                                                  | ✅ complete            |
| **P2**    | OpenAI Realtime mic path (WebRTC + session bridge)                                                                                                                                                                                | ✅ complete            |
| **P3**    | WhisperLiveKit + CTranslate2 MT + WASAPI loopback                                                                                                                                                                                 | ✅ complete            |
| **P3.5**  | Audit fixes: SPM tokenizer copy, Whisper pre-cache, ApiKey tri-state                                                                                                                                                              | ✅ complete            |
| **P3.6**  | CaptionBoard v3 UX: split paragraph streams + freeze partial + auto-hide chrome                                                                                                                                                   | ✅ complete            |
| **P3.7**  | Online render-hot-path overhaul: store split (live vs final), 50ms coalesce, memo'd Live/History                                                                                                                                  | ✅ complete            |
| **P3.8**  | Online-slim deliverable: VITE_DEPLOYMENT_MODE flag, single-port release zip (9 MB), renewal-failure recovery                                                                                                                      | ✅ complete            |
| **P3.9**  | Robust pass: esbuild single-file bundle (zip 9 MB → 0.78 MB), dotenv override, late-arrival translation routing, concurrent-start guards, start/stop race short-circuit, SPA-fallback asset-404 fix, launcher Node-version checks | ✅ complete            |
| **P3.10** | Strict env policy: dotenv removed entirely; OPENAI_API_KEY read from system env ONLY; .env files on disk are intentionally ignored; launchers refuse to start without the env var                                                 | ✅ complete            |
| **P4**    | Glossary (59→102), Hybrid Privacy, dual-path MT, confidence scoring, contract tests, code review, model upgrade (gpt-4.1-mini)                                                                                                    | ✅ complete 2026-05-24 |
| **P5-A**  | Breeze ASR 25 experiment + Online mode hardening (B2/B4/B5)                                                                                                                                                                       | ✅ complete 2026-05-24 |
| P5-B      | Summary draft/refined/stable pipeline                                                                                                                                                                                             | pending                |
| P6        | Reliability + long-session stability                                                                                                                                                                                              | pending                |
| P7        | Electron packaging                                                                                                                                                                                                                | pending                |

---

## P3 Task Status

| #   | Task                                                                      | Status  | Commit  |
| --- | ------------------------------------------------------------------------- | ------- | ------- |
| A1  | distil-large-v3 model (env-configurable via WHL_MODEL)                    | ✅ done | 9929d52 |
| A2  | AudioLevelEvent polling in OfflineSTTProvider (AnalyserNode)              | ✅ done | 9929d52 |
| A3  | Glossary pipeline: apply_source_glossary → MT → restore_placeholders      | ✅ done | 9929d52 |
| A4  | MIN_WORDS_TO_TRANSLATE = 3 filter (skip fillers)                          | ✅ done | 9929d52 |
| A5  | Language-aware initial_prompt dict (en / zh)                              | ✅ done | 9929d52 |
| B1  | WHL as independent process; TCP probe loop every 5 s                      | ✅ done | 779c213 |
| B2  | Structured /healthz: components.{asr, translation, audio} + legacy fields | ✅ done | 779c213 |
| B3  | start.bat + start.sh — launch WHL then uvicorn                            | ✅ done | 779c213 |
| C1  | wasapi_loopback.py: PyAudioWPatch loopback, mono mix, linear resample     | ✅ done | 44cc3f6 |
| C2  | /ws handler branches on source:'mic'\|'system'                            | ✅ done | 44cc3f6 |
| C3  | OfflineAudioSource in settings-store; setAudioSource action               | ✅ done | 44cc3f6 |
| C4  | OfflineSTTProvider: audioSource param, skips mic when 'system'            | ✅ done | 44cc3f6 |
| C5  | AudioSourceSelector in SettingsPanel (full_offline mode only)             | ✅ done | 44cc3f6 |

---

## P3.5 Audit Fixes

| #   | Task                                                                                                                    | Verification                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `download_models.py` passes `copy_files=["source.spm","target.spm"]` to TransformersConverter                           | both model dirs now have source.spm + target.spm                     |
| 2   | `run_whl.py` pre-instantiates `WhisperModel(WHL_MODEL,…)` to warm HF cache                                              | first browser session no longer hits 30 s WS timeout                 |
| 3   | `scripts/smoke_translate.py` validates both translation directions end-to-end                                           | exits 0; en→zh-TW and zh-TW→en both produce non-empty output         |
| 4   | `useOpenAIRealtime` exports tri-state `apiKeyStatus` ('checking'\|'present'\|'no-key'\|'service-down') with 3 s polling | mirror of useOfflineSTT pattern; auto-recovers when service comes up |
| 5   | `App.tsx` consumes `apiKeyStatus` for label/title/disabled/pricing-panel gate                                           | distinguishes "no key" from "service down" honestly                  |

---

## Test Status (as of P3.6)

| Suite                     | Count | Status                                                                |
| ------------------------- | ----- | --------------------------------------------------------------------- |
| `services/offline` pytest | 21    | ✅ passed                                                             |
| `apps/web` vitest         | 89    | ✅ passed (P3.6 added 12 paragraph-grouping + 3 sessionStartMs tests) |
| `services/online` vitest  | 10    | ✅ passed                                                             |
| Playwright e2e            | 15    | ✅ passed (last verified P2)                                          |

---

## P3.6 — CaptionBoard v3 (UX overhaul)

| File                                                    | Change                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/store/caption-store.ts`                   | + `sessionStartMs: number\|null` (Date.now() at first event); persisted (optional) and reset on `clear()`                                                           |
| `apps/web/src/store/caption-store.test.ts`              | + 3 lifecycle tests for `sessionStartMs`                                                                                                                            |
| `apps/web/src/caption-board/paragraph-grouping.ts`      | NEW — `groupParagraphsForSide({segments, translations, side, accessor})` + `formatElapsedFromStart`                                                                 |
| `apps/web/src/caption-board/paragraph-grouping.test.ts` | NEW — 12 tests covering ZH/EN punctuation, divergent grouping, U+2009 thin-space, confidence dim, gap-break, format clamp                                           |
| `apps/web/src/caption-board/CaptionBoard.tsx`           | Rewrite: split streams, live id by max startMs, partial freeze + translating hint, inline confirm clear (ref-based), pause-pill, anchor-by-first-segment timestamps |
| `apps/web/src/caption-board/CaptionBoard.module.css`    | Rewrite: split layout, weight 500 live caption, hover-only chrome with backdrop blur, `margin-top:auto` scroll fix, prefers-reduced-motion                          |
| `docs/sandbox/caption-board-v2.html`                    | Interactive lab — current vs proposed split-stream side-by-side comparison                                                                                          |
| `docs/sandbox/v3-*.png`                                 | Visual evidence: en-zh, zh-en, partial freeze, scroll-paused, degraded chip, app-integrated                                                                         |

**Why P3.6 not P4**: pure UX/correctness layer on top of existing event contracts; no provider, store
schema, or transport changes that would justify a phase bump. Done as out-of-band hardening before
P4 starts. See `docs/TODO.md` for the full bullet list.

---

## What Exists On Disk (P3 additions)

```
services/offline/
├── pyproject.toml              [pyaudiowpatch dep added]
├── start.bat                   [new] Windows launcher: WHL + uvicorn
├── start.sh                    [new] Linux/macOS launcher
├── app/
│   ├── main.py                 [modified] TCP probe loop, structured /healthz, WASAPI branch in /ws
│   ├── capture/
│   │   ├── __init__.py         [new]
│   │   └── wasapi_loopback.py  [new] PyAudioWPatch loopback capture
│   └── pipeline/
│       ├── asr.py              [modified] distil-large-v3, min-words filter, language prompts, push_event()
│       └── translation.py      [modified] glossary masking in translate()
└── tests/
    └── test_healthz.py         [modified] +3 component structure tests

apps/web/src/
├── settings/
│   └── settings-store.ts       [modified] OfflineAudioSource type + audioSource field
├── providers/
│   ├── offline-stt-provider.ts [modified] audioSource param, level polling, source in WS start msg
│   └── use-offline-stt.ts      [modified] reads audioSource, passes to provider
└── components/
    └── SettingsPanel.tsx       [modified] AudioSourceSelector (full_offline only)
```

---

## Architecture (as of P3)

```
Browser (apps/web, port 5173)
  ├── Online Full:  OpenAIRealtimeProvider → services/online (port 3001) → OpenAI Realtime API
  └── Full Offline: OfflineSTTProvider → services/offline (port 8000) /ws
        ├── source:'mic'  → browser AudioWorklet PCM → ASRSession → WHL (port 9090)
        └── source:'system' → wasapi_loopback.py → PyAudioWPatch loopback → ASRSession → WHL

services/offline (FastAPI, port 8000)
  ├── TCP probe loop → WHL port 9090 (5 s interval)
  ├── /healthz → components: {asr, translation, audio}
  └── /ws ASRSession
        ├── WHL → segments → SegmentStabilizer → TranscriptEvent
        └── final segment → glossary mask → CTranslate2 opus-mt → restore → OpenCC → TranslationEvent

services/online (Fastify, port 3001)
  └── POST /session → OpenAI ephemeral token (server-side only, key never in browser)
```

---

## How to Run (P3)

```powershell
# Production-style local offline stack (WHL + FastAPI, loopback only)
.\services\offline\start.bat
```

```bash
# Unix-compatible launcher (WHL + FastAPI, loopback only)
./services/offline/start.sh
```

```text
# Development — run from separate terminals
cd services/offline && uv run python run_whl.py
cd services/offline && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
pnpm -F online dev
pnpm -F web dev
```

---

## How to Resume After Session/Model Switch

1. [`../CLAUDE.md`](../CLAUDE.md) — non-negotiable rules
2. Plans: [`PLAN_P0.md`](PLAN_P0.md), [`PLAN_P1.md`](PLAN_P1.md), [`PLAN_P2.md`](PLAN_P2.md)
3. **This file** — done / pending
4. [`TODO.md`](TODO.md) — backlog (now points at P4)
5. [`DECISIONS.md`](DECISIONS.md) — D1–D10 + P2-D\*

---

## Active Blockers

None. P3 complete.

---

## P3.7 — Online render-hot-path overhaul

Focus: stable, snappy online captioning. Offline path optimization deferred
(see `MEMORY.md` / decoupling plan). Behavioral evidence the user reported as
"偏慢，使用體感不良" was the per-character partial-delta render storm — every
OpenAI delta (~30 Hz) re-rendered the full CaptionBoard (history paragraph
grouping over up to 500 segments × 2 streams).

| File                                               | Change                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/store/caption-store.ts`              | Split state: `segments` (final only) + `livePartial` + `liveTranslation` + `translations` (final only). Partials no longer churn the history ref. Persist version bumped 1→2.                             |
| `apps/web/src/store/caption-store.test.ts`         | Rewritten for new partial/final invariants + ref-stability assertion + liveTranslation promotion flow. 16 tests.                                                                                          |
| `apps/web/src/providers/coalesce-handlers.ts`      | NEW — store-bound handlers that coalesce partial transcripts and draft translations to one store update per 50 ms; final/revised-final events bypass the queue.                                           |
| `apps/web/src/providers/coalesce-handlers.test.ts` | NEW — 4 tests covering coalescing, final bypass, queue draining, sync forwarding for health/audio-level.                                                                                                  |
| `apps/web/src/providers/use-openai-realtime.ts`    | Routes provider events through coalesce handlers; flushes pending on stop.                                                                                                                                |
| `apps/web/src/providers/use-offline-stt.ts`        | Same wiring.                                                                                                                                                                                              |
| `apps/web/src/providers/use-fake-replay.ts`        | Same wiring.                                                                                                                                                                                              |
| `apps/web/src/caption-board/CaptionBoard.tsx`      | Split into shell + memo'd `HistoryStream` (subscribes to finalized segments only) + memo'd `LiveCaption` (subscribes to live partial/translation). Per-character deltas now re-render only the live area. |
| `apps/web/src/components/MicLevelBar.tsx`          | NEW — extracted from App.tsx so the 10 Hz audio-level updates redraw only the header widget.                                                                                                              |
| `apps/web/src/App.tsx`                             | Renders `<MicLevelBar visible={isRunning} />`; no longer subscribes to `audioLevel` at the top level.                                                                                                     |

Verification:

- `pnpm -F web test` — 10 files, 98 tests passed
- `pnpm -F online test` — 3 files, 20 tests passed
- `pnpm -F web typecheck` — clean
- `pnpm -F web build` — clean production build

**Why a perf phase, not P4**: pure render/store layering on top of existing
event contracts. No provider, transport, or schema changes that would justify
a phase bump.

---

## P3.8 — Online-slim deliverable

Goal: ship a clean, lightweight online-only build without forking offline
code out of the repo. Build-time `VITE_DEPLOYMENT_MODE=online` swaps offline
modules for stubs via a Vite alias, so the offline path stays in the repo
for P4 work but never enters the online distribution.

| File                                                                    | Change                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/deployment.ts`                                            | NEW — single source of truth for the build flag. Exposes `DEPLOYMENT_MODE` ('online' \| 'full'), `IS_ONLINE_ONLY`, `IS_FULL`.                                                                                               |
| `apps/web/vite.config.ts`                                               | Reads `VITE_DEPLOYMENT_MODE`, sets `__DEPLOYMENT_MODE__` via `define`, and aliases the virtual module `@meeting-audio/offline-stt` to either `use-offline-stt.real.ts` (full) or `use-offline-stt.stub.ts` (online).        |
| `apps/web/src/providers/use-offline-stt.{real,stub}.ts`                 | Real impl renamed; stub returns inert hook so call sites compile. Stub pulls ZERO offline-only modules — `OfflineSTTProvider`, audio-worklet path, etc. all tree-shaken.                                                    |
| `apps/web/src/providers/use-offline-stt.ts`                             | Barrel that re-exports through the virtual alias.                                                                                                                                                                           |
| `apps/web/src/types/offline-stt-virtual.d.ts`                           | TS declaration for the virtual module.                                                                                                                                                                                      |
| `apps/web/src/settings/settings-store.ts`                               | `MODE_OPTIONS` and `SCENARIO_OPTIONS` filter out hybrid + full_offline when `IS_ONLINE_ONLY`.                                                                                                                               |
| `apps/web/src/components/StartRealButton.tsx`                           | NEW — owns the 1 Hz renewal-countdown tick locally so App.tsx no longer re-renders every second.                                                                                                                            |
| `apps/web/src/providers/use-openai-realtime.ts`                         | Removed `renewalEtaMs` state; exposes stable `getRenewalEtaMs()` for `StartRealButton`.                                                                                                                                     |
| `apps/web/src/providers/openai-realtime-provider.ts`                    | Renewal-failure path no longer pretends `_status='running'`. Adds `renewalRetryTimer` cancelled by cleanup so a stale timer can't restart after the user pressed Stop.                                                      |
| `apps/web/src/store/caption-store.ts`                                   | Translation pruning now also runs when `segments.length >= maxSegments` so stale entries don't accumulate at-cap.                                                                                                           |
| `apps/web/src/config.ts`                                                | In production builds, default `ONLINE_SERVICE_URL` to '' (same-origin) — slim release serves the web from the same port as the API.                                                                                         |
| `apps/web/src/App.tsx`                                                  | Wires `StartRealButton`, gates `audio-source-chip` + hybrid/offline buttons on `IS_ONLINE_ONLY`.                                                                                                                            |
| `services/online/src/config.ts`                                         | `ONLINE_HOST` (default 127.0.0.1 — loopback only for the slim build) + optional `WEB_DIST_PATH`.                                                                                                                            |
| `services/online/src/server.ts`                                         | Registers `@fastify/static` at `/` when `WEB_DIST_PATH` is set, with an SPA fallback for deep links.                                                                                                                        |
| `services/online/package.json`                                          | + `@fastify/static`.                                                                                                                                                                                                        |
| `scripts/package-online.{ps1,sh}`                                       | NEW — builds web (online flag), builds online service, `pnpm deploy --prod` into `release/meeting-audio-online-<timestamp>/server`, copies the web build into `web/`, drops launchers + `.env.example` + `README.md`, zips. |
| `scripts/release-templates/{start.bat,start.sh,.env.example,README.md}` | NEW — what ships in the zip.                                                                                                                                                                                                |
| `scripts/check-online-bundle.sh`                                        | NEW — slim-bundle audit; greps the built JS for forbidden symbols and asserts size budgets.                                                                                                                                 |
| `apps/web/src/deployment.test.ts`                                       | NEW — locks in default-flag semantics.                                                                                                                                                                                      |
| `.gitignore`                                                            | + `release/`.                                                                                                                                                                                                               |

### Slim distribution layout (9.0 MB zip)

```
meeting-audio-online/
├── server/                 (Fastify + pnpm-deployed prod deps; ~30 MB extracted)
│   ├── dist/server.js
│   ├── package.json
│   └── node_modules/
├── web/                    (apps/web/dist; pcm-worklet.js stripped)
│   ├── index.html
│   ├── index.css
│   └── index.<hash>.js     (~1.36 MB raw / ~545 KB gzip)
├── start.bat               (Windows: writes .env if missing, then `node server/dist/server.js`)
├── start.sh                (macOS / Linux)
├── .env.example            (OPENAI_API_KEY only; everything else has safe defaults)
└── README.md               (3-step setup)
```

`services/offline/`, the Python interpreter, WhisperLiveKit, model files —
**none ship**. End-user requirements: Node 22+, an OpenAI API key, a
microphone, Chrome/Edge.

### Verification

- `pnpm -F web test` — 11 files, **101 tests passed**
- `pnpm -F online test` — 3 files, 20 tests passed
- `pnpm -F web typecheck` + `pnpm -F online typecheck` — clean
- `scripts/check-online-bundle.sh` — slim bundle 1.36 MB raw / 545 KB gzip, no forbidden symbols
- Smoke test of `release/meeting-audio-online-*/`: `/healthz` returns ok,
  `/` serves index.html, deep route `/foo/bar` falls back to SPA, server
  binds 127.0.0.1 only (loopback)

---

## P3.9 — Robust pass

End-to-end hardening pass after spotting that the 9 MB release zip was
**non-functional** when extracted on a clean machine: pnpm deploy produces
absolute-path symlinks under `node_modules/.pnpm`, and Windows zip tools
do not preserve symlinks, so `@fastify/cors` and every other dep was
"present" as an empty directory after extraction → `ERR_MODULE_NOT_FOUND`
on first launch.

| Fix                                  | Change                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server bundling**                  | New `services/online/build-bundle.mjs` (esbuild). Produces a single 785 KB CJS file with EVERY runtime dep inlined. Release zip dropped from 9.0 MB to **0.78 MB**. No node_modules tree to ship, no symlink fragility.                                                                                                                          |
| **`process.env.LOG_FORMAT`**         | New env var; release launchers set `json` so pino doesn't try to load `pino-pretty` (which fails inside a CJS bundle). Dev (`pnpm dev`) keeps pretty logs.                                                                                                                                                                                       |
| **Build-time constants**             | `__APP_VERSION__` (read from `package.json` at bundle time) and `__SERVER_BUNDLED__` replace runtime `import.meta.url` lookups that break in CJS bundles.                                                                                                                                                                                        |
| **dotenv override**                  | `dotenv.config({ override: true })` — end users editing `.env` expect it to win over stale system env vars (e.g. an old `OPENAI_API_KEY` from a forgotten `setx`).                                                                                                                                                                               |
| **Late-arrival translation routing** | If a translation event arrives BEFORE its transcript partial, it lands in `translations[id]`; when the partial subsequently sets `livePartial`, the prior entry is now promoted to `liveTranslation` and removed from history. Without this, the translation was stranded.                                                                       |
| **Concurrent start() guards**        | All three hooks (`useOpenAIRealtime`, `useOfflineSTT`, `useFakeReplay`) now stop+drain a prior provider instance before creating a new one, and bail out if `providerRef.current !== this provider` after each await.                                                                                                                            |
| **Provider start/stop race**         | `OpenAIRealtimeProvider.start()` checks `this.status === 'running'` after every await (mic, /session fetch, json, createOffer, setLocalDescription, SDP fetch, sdp text, setRemoteDescription). If the user pressed Stop mid-bring-up, the rest is short-circuited cleanly — no NPE, no misleading `transport.connected` health emit after stop. |
| **SPA fallback excludes /assets/**   | `services/online/src/server.ts`: a missing hashed asset must return 404, not the HTML fallback — otherwise the browser parses HTML as JS and `SyntaxError`s.                                                                                                                                                                                     |
| **Launcher Node-version check**      | `start.bat` / `start.sh` verify `node` is installed and `>= 22`; print a clear remediation message otherwise.                                                                                                                                                                                                                                    |
| **End-to-end smoke test**            | New verified path: extract zip into `/tmp/<fresh>`, launch via `node server/dist/server.bundle.cjs`, hit `/healthz`, `/session/info`, `/`, `/deep/route`, `/assets/missing.js` (404), `/assets/<real>.js` (200), POST `/unknown` (404). All correct.                                                                                             |

New tests:

- `apps/web` — late-arrival translation routing (caption-store), stop-during-bring-up race (provider). **103 tests pass.**
- `services/online` — 6 new SPA fallback tests (index serves, deep SPA, /assets/ never falls back to HTML, /healthz not shadowed, POST /unknown 404). **26 tests pass.**

### Final slim distribution

```
meeting-audio-online/                          (zip: 0.78 MB)
├── server/dist/server.bundle.cjs              785 KB single-file CJS
├── web/                                       2.2 MB total
│   ├── index.html
│   └── assets/{index.js,index.css,fake-transcript.js}
├── start.bat
├── start.sh
├── .env.example
└── README.md
```

End-user requirements: **Node 22+**, **OpenAI API key**, microphone. That's it.

---

## P3.10 — Strict env policy

User directive: "嚴格強迫改革，我要全部都是讀取系統(使用者)環境變數的 OPENAI_API_KEY。不要寫成檔案."

Removed all `.env` support from the slim distribution. The key is read
**only** from `process.env`, which is populated exclusively by the user's
system / user environment (`setx`, shell `export`, `$env:`).

| Change                                     | Reason                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/online/src/config.ts`            | Deleted `dotenv.config()` and the bundle-relative fallback added in P3.9. Schema parses `process.env` directly. Startup log line: `[config] OPENAI_API_KEY: set in system env (N chars) \| MISSING — set OPENAI_API_KEY in your user/system env`. |
| `services/online/package.json`             | Removed `dotenv` from dependencies.                                                                                                                                                                                                               |
| `scripts/release-templates/start.{bat,sh}` | Added explicit `OPENAI_API_KEY` env-var check before launching node; prints platform-specific `setx` / `export` guidance and refuses to start if absent. No more `.env` bootstrap.                                                                |
| `scripts/release-templates/.env.example`   | **Deleted.** No template, no encouragement to write secrets to disk.                                                                                                                                                                              |
| `scripts/release-templates/README.md`      | Rewrote Setup section: `setx` (Windows persistent) / `set` (session) / `export` (POSIX). Added explicit "no `.env` file" security note at the top.                                                                                                |
| `scripts/package-online.{ps1,sh}`          | Stopped copying `.env.example` into the release tree.                                                                                                                                                                                             |
| `services/online/src/server.test.ts`       | New guard test: `package.json` MUST NOT list dotenv, and `config.ts` source MUST NOT import or require it. Future regressions blocked at the test layer.                                                                                          |

### Verified behaviour (clean shell, fresh extraction)

| Scenario                                  | Result                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `OPENAI_API_KEY` set                   | `[config] OPENAI_API_KEY: MISSING — …`; `/session/info` → `hasApiKey:false`; launcher refuses to start with platform-specific remediation guidance.                |
| `OPENAI_API_KEY=sk-FROM-SHELL-…` in shell | `[config] OPENAI_API_KEY: set in system env (29 chars)`; OpenAI's upstream rejection echoes the key prefix `sk-FROM-*****************7777` — proving pass-through. |
| Adversary writes `.env` on disk           | `[config] OPENAI_API_KEY: MISSING`; `.env` is strictly ignored.                                                                                                    |

Server bundle dropped from 786 KB → 779 KB (no dotenv to inline). Zip
remains ~0.78 MB.

---

## Robustness Audit — 2026-05-23

Four targeted fixes from an architecture audit. No phase bump — all pure
correctness/efficiency improvements on top of existing contracts.

| Fix                               | File(s)                                                                                      | Detail                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PCM ring buffer**               | `apps/web/public/pcm-worklet.js`                                                             | Pre-allocated `Float32Array`; one transfer per 4096-sample chunk (~256 ms). Eliminates per-128-frame GC allocations (~32× reduction in object churn).                                                                                                                                                                         |
| **WASAPI drop counter**           | `services/offline/app/capture/wasapi_loopback.py`                                            | `_try_enqueue` closure runs on the event-loop thread via `call_soon_threadsafe`. Old `except Exception: pass` in the pyaudio callback never fired because `QueueFull` raised on the event-loop thread, not the callback thread. Now emits `audio:degraded` health events after every 100 drops.                               |
| **Segment ID collision**          | `services/offline/app/pipeline/asr.py`, `apps/web/src/providers/openai-realtime-provider.ts` | `crypto.randomUUID()` (browser-native) replaces `Date.now()`-based IDs. Eliminates 15 ms Windows clock-resolution collision risk on rapid Stop+Start.                                                                                                                                                                         |
| **healthz `model_loading` state** | `services/offline/app/main.py`, `services/offline/app/pipeline/asr.py`                       | Added `_whl_model_ready: bool` flag (module-level). Set via `on_model_ready` callback on `ASRSession` when `SERVER_READY` arrives from WHL. `/healthz` now returns `model_loading` (not `ready`) when the WHL process is up but the model is still warming — previously TCP-probe success was conflated with model readiness. |
| **CORS env var**                  | `services/offline/app/main.py`                                                               | `OFFLINE_CORS_ORIGIN` env var (comma-separated); defaults to `http://localhost:5173,http://localhost:5174`. Removes hard-coded origin coupling.                                                                                                                                                                               |
| **`model_loading` UI label**      | `apps/web/src/App.tsx`                                                                       | `whisperLabel()` helper maps `model_loading` → `"loading model…"` for display in the offline button text and tooltip. Prevents raw snake_case leaking into the UI.                                                                                                                                                            |

New tests added:

| Suite                     | Tests added             | Detail                                                                                                                                                                         |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web` vitest         | +2 stale-detector       | Fire `renewSession()` after 30 s DC silence + 100 audio-active samples; reset on each DC event                                                                                 |
| `apps/web` vitest         | +7 caption-store        | Provider switch without transcript loss (×2), translation failure isolation (×2), long-running memory stability (×2 — burst 500 → maxSegments=100, translation map prune sync) |
| `apps/web` vitest         | +2 offline-stt-provider | Malformed WS message isolation; offline server unavailable → `offline_engine_unavailable` health state                                                                         |
| `services/offline` pytest | +2 asr_session          | `on_model_ready` callback fires exactly once on `SERVER_READY`; callback-less session works normally                                                                           |
| `services/offline` pytest | −1 +2 healthz           | Replaced stale `test_healthz_ok_false_when_loading` (nonexistent status); added `test_healthz_model_loading_when_process_up_but_not_ready` + second unavailable variant        |

Test totals after audit: **50 Python** (was 21 before P3.5 + new tests), TypeScript clean (`tsc --noEmit` 0 errors).

---

## Recent Decisions (P3)

- **P3-D1**: WHL as independent process (TCP probe, not daemon thread) — crash isolation
- **P3-D2**: distil-large-v3 as default model (multilingual, env-overridable via WHL_MODEL)
- **P3-D3**: Linear interpolation resample (numpy-only, no scipy) — adequate STT quality, zero deps
- **P3-D4**: MIN_WORDS_TO_TRANSLATE = 3 → revised to MIN_WORDS_TO_TRANSLATE = 1 (single-word affirmations carry meaning in meetings; only true empty/whitespace is filtered)
- **P3-D5**: source:'mic'|'system' in WS start message — backend owns WASAPI, browser owns PCM
- **P3-D6**: `_whl_model_ready` flag — TCP probe ≠ model ready; `SERVER_READY` WebSocket message is the authoritative signal
- **P3-D7**: `OFFLINE_CORS_ORIGIN` env var — hard-coded dev origins removed from source
- **P3-D8**: `crypto.randomUUID()` for all segment IDs — eliminates clock-resolution collision risk

---

## P5-A — Breeze ASR 25 experiment + Online mode hardening (2026-05-24)

Two concurrent workstreams: ASR model comparison infrastructure, and a rigorous audit of the Online Realtime provider's edge-case handling.

### Part A — Breeze ASR 25 experiment

MediaTek Research Breeze ASR 25 is a Whisper-large-v2 fine-tune (2B params, Apache 2.0) optimised for Taiwanese Mandarin and Mandarin-English code-switching. Published WER results: zh-TW 7.97% (−19% vs baseline), code-switching 13.01% (−56%). CTranslate2-compatible via community conversion.

| File                                           | Change                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/offline/run_whl.py`                  | `_REPO_MAP` extended with `"breeze-asr-25": "SoybeanMilk/faster-whisper-Breeze-ASR-25"` and `"breeze-asr-25-ct2": "phate334/Breeze-ASR-25-ct2"`. Usage: `WHL_MODEL=breeze-asr-25 start.bat`                      |
| `services/offline/scripts/compare_models.py`   | NEW — side-by-side ASR evaluation. Reads `eval_audio/*.wav` + `transcripts.json`. Metrics: WER (jiwer), RTF, VRAM (torch.cuda). Usage: `python scripts/compare_models.py --models distil-large-v3 breeze-asr-25` |
| `services/offline/eval_audio/transcripts.json` | NEW — 4-clip ground truth: 2 pure zh-TW, 2 Mandarin-English code-switching                                                                                                                                       |
| `services/offline/eval_audio/README.md`        | NEW — recording guide (16 kHz mono 16-bit PCM WAV) and usage instructions                                                                                                                                        |

Note: actual `.wav` test clips not committed (binary). Record with ffmpeg per README instructions. Breeze model download requires ~4 GB VRAM for evaluation.

### Part B — Online mode hardening

Systematic audit of Online Realtime provider identified 7 gaps; 5 were real bugs.

| ID                                                   | Priority | Status                                                                                            | Change                                                                                                                                                                   |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1** — stale-data detector `lastDcEventAt`         | High     | ✅ no bug — `lastDcEventAt = Date.now()` is correctly set after SDP, not at 0                     | —                                                                                                                                                                        |
| **B2** — token expiration not checked                | High     | ✅ fixed                                                                                          | `expires_at * 1000 - Date.now() < 60_000` → emit reconnecting + go to renewSession (skip SDP)                                                                            |
| **B3** — translation arrives before transcript final | Medium   | ✅ no bug — partial path already handles this via livePartial promotion                           | —                                                                                                                                                                        |
| **B4** — `silence_detected` not emitted              | Medium   | ✅ fixed                                                                                          | Track `lastAudioActiveAt`; after 30 s sub-threshold → emit `audio:silence_detected`; speech resume → emit `audio:connected`. Gate with `silenceEmitted` to prevent spam. |
| **B5** — permission denied not surfaced to UI        | Medium   | ✅ fixed                                                                                          | Wrap `handlers.onHealth` in `use-openai-realtime.ts`; intercept `failed`/`api_error` → set React `error` state (drives error banner + retry button)                      |
| **B6** — mode switch races                           | Medium   | deferred — the hook's sequential start/stop guards (added P3.9) cover the failure case adequately |
| **B7** — rate-limiter O(n) + json timeout            | Low      | deferred — rate-limiter already has `RATE_STATE_MAX_KEYS = 10_000` guard; json timeout deferred   |

| File                                                      | Change                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/providers/openai-realtime-provider.ts`      | + `expires_at?` field on `SessionResponse`; + expiry check before SDP (lines 259–267); + `silenceEmitted` field; + silence detection in `startLevelPolling()` (lines 744–764) |
| `apps/web/src/providers/use-openai-realtime.ts`           | Health event interception in `start()` — `failed`/`api_error` states propagate to React `error` state                                                                         |
| `apps/web/src/providers/openai-realtime-provider.test.ts` | + 4 tests: token < 60s → renewSession (not SDP); token > 60s → normal SDP; silence_detected after 30s quiet; connected recovery after silence                                 |

### Test totals after P5-A

| Suite                       | Count   | Status    |
| --------------------------- | ------- | --------- |
| `apps/web` vitest           | **187** | ✅ passed |
| `services/online` vitest    | **41**  | ✅ passed |
| `services/offline` pytest   | **59**  | ✅ passed |
| TypeScript (`tsc --noEmit`) | —       | ✅ clean  |

---

## Field-feedback pass — 2026-06-08

Three issues reported from real use. All three fixed; no phase bump (UX +
audio-config correctness on existing contracts).

### Issue 1 — Online: switching speaker (same language) almost never recognised

Root cause: the audio chain was tuned for a **single near speaker**. Default
`micDistance='close'` → browser `autoGainControl/noiseSuppression/echoCancellation`
all ON **and** OpenAI `noise_reduction=near_field`. AGC locks gain to the first
speaker and near_field gates softer / different-voiced participants as "noise",
so when the speaker changes the new voice is dropped.

Fix: new **`'meeting'` acoustic profile, now the default** — multi-speaker room
on one mic. Browser DSP all OFF (raw signal) + OpenAI `noise_reduction=far_field`
(its tuned profile for reverberant rooms with speakers at varying distances).
`close`/`far`/`off` kept as advanced options.

| File                                                  | Change                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/web/src/settings/settings-store.ts`             | `MicDistance` += `'meeting'`; default + reset → `'meeting'`                    |
| `apps/web/src/providers/microphone-audio-provider.ts` | `'meeting'` constraints (EC/NS/AGC all false); ctor default → `'meeting'`      |
| `apps/web/src/providers/openai-realtime-provider.ts`  | ctor type/default += `'meeting'`; `STALE_AUDIO_ACTIVE_DB_BY_MIC.meeting = -48` |
| `apps/web/src/providers/use-openai-realtime.ts`       | `effectiveMicDistance` type += `'meeting'`                                     |
| `services/online/src/routes/session.ts`               | `micDistance` enum += `'meeting'`; `'meeting'\|'far'` → `far_field`            |
| `apps/web/src/components/SettingsPanel.tsx`           | `Meeting` option first/recommended                                             |

> Cannot be verified in-repo (needs a live OpenAI session + multiple speakers).
> Tuning is root-cause-based; **verify in a real meeting**. Existing installs
> with `micDistance:'close'` persisted in localStorage keep close — pick
> **Meeting** in Settings (or it applies on a fresh profile).

### Issue 2 — No Pause, only Stop+Start (which lost the LOG)

Fix: **Pause / Resume**. Pause stops capture (and drains billed minutes for the
online path) but does **not** `beginSession()`/`clear()`/`endSession()` — the
transcript log stays in memory + persisted. Resume restarts the same provider
**without** clearing, so new events append to the preserved history.

| File                   | Change                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx` | `pausedMode` state; `startRealCore(continueSession)` (Resume skips `beginSession`); `handlePause`/`handleResume`; ⏸ Pause (running) + ▶ Resume (paused) buttons; `paused` status chip; Stop enabled while paused to finalise |

> Online resume ordering is correct (online `startMs` = wall-clock `Date.now()`).
> Caveat: offline/hybrid resume preserves the log but new segments may interleave
> by time-from-connection (WHL restarts timestamps at 0 per connection) — follow-up.

### Issue 3 — Just-spoken (now small) line didn't auto-scroll to the bottom

Root cause: history auto-pin only fired on **paragraph-array change**. The board
is `grid-template-rows: 1fr auto`; when the big live caption wraps to extra
lines the history pane (1fr) shrinks and its bottom line scrolls out of view —
a resize that fires no scroll event and no paragraph change, so nothing re-pinned.

Fix: a **`ResizeObserver`** on the history scroll container (+ its content
column) re-pins to bottom while `autoPin` is true, catching both pane-resize and
late-translation content growth.

| File                                          | Change                                 |
| --------------------------------------------- | -------------------------------------- |
| `apps/web/src/caption-board/CaptionBoard.tsx` | `autoPinRef` + `ResizeObserver` re-pin |

### Verification

| Suite                        | Count        | Status    |
| ---------------------------- | ------------ | --------- |
| `apps/web` vitest            | **190** (+3) | ✅ passed |
| `services/online` vitest     | **42** (+1)  | ✅ passed |
| `apps/web` typecheck / build | —            | ✅ clean  |

(New tests: micrphone `meeting`/`close` constraints ×2, settings-store `meeting`
persist ×1, session `meeting`→`far_field` ×1. Also fixed a latent ES2023
`findLastIndex` in `openai-realtime-provider.test.ts` surfaced by the `tsc -b`
cache invalidation.)

---

## Multi-backend (P-A/P-C) — Gemini Live as 2nd online backend — 2026-06-09

Goal: a second, UI-switchable online realtime backend alongside OpenAI. Research
(see `docs/PROVIDER_BACKENDS.md`) confirmed Azure OpenAI and Google Gemini both
do realtime translation; user chose to implement **Gemini first, by API key**.

**Backend model.** `online_full` now has a provider selector
(`settings-store.onlineProvider: 'openai' | 'gemini'`, default `openai`,
persisted). The server's `/session/info` reports `availableProviders` from which
credentials exist; the UI greys out unconfigured backends.

**Gemini Live provider** (`gemini-live-provider.ts`) — WebSocket, not WebRTC:

- Browser never holds the raw key. Server route **`POST /session/gemini`**
  (`routes/gemini.ts`) mints a short-lived ephemeral token via the Gemini
  `auth_tokens` API from `GEMINI_API_KEY`; browser opens the Live WS
  (`…BidiGenerateContentConstrained?access_token=…`) directly.
- Reuses the offline **AudioWorklet PCM** path; converts Float32→PCM16→base64
  and sends `realtimeInput`. Setup enables `inputAudioTranscription` (EN source)
  - `outputAudioTranscription` (zh-TW translation) + `contextWindowCompression`
    (unlimited duration) + `sessionResumption`; reacts to `goAway`.
- Translation is **system-instruction driven** ("translate to 繁體中文，台灣用語")
  — Gemini outputs Traditional natively (the OpenAI/Azure translate models only
  emit Mandarin and lean Simplified → still need OpenCC).
- Model default `gemini-3.1-flash-live-preview` (latest), env-overridable.
- Maps onto normalized `TranscriptEvent`/`TranslationEvent` per turn; wall-clock
  `startMs` keeps ordering correct (and Pause/Resume continuity intact).

| File                                             | Change                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `services/online/src/config.ts`                  | + `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`; startup log                                           |
| `services/online/src/routes/gemini.ts`           | NEW — `POST /session/gemini` ephemeral-token broker (rate-limited, error-sanitised)            |
| `services/online/src/routes/session.ts`          | `/session/info` += `availableProviders`, `hasGeminiKey`                                        |
| `services/online/src/server.ts`                  | register Gemini route                                                                          |
| `apps/web/src/providers/gemini-live-provider.ts` | NEW — WS provider + pure `floatTo16BitPCM`/`arrayBufferToBase64`/`handleServerObject`          |
| `apps/web/src/providers/use-gemini-live.ts`      | NEW — hook (availability poll, start/stop, error interception)                                 |
| `apps/web/src/settings/settings-store.ts`        | + `onlineProvider` (persisted)                                                                 |
| `apps/web/src/components/SettingsPanel.tsx`      | + "Online backend" OpenAI/Gemini selector                                                      |
| `apps/web/src/App.tsx`                           | wire `useGeminiLive`; provider-gated Start buttons; pause/resume/stop/exclusivity; status chip |

### Verification

| Suite                                | Count        | Status    |
| ------------------------------------ | ------------ | --------- |
| `apps/web` vitest                    | **199** (+9) | ✅ passed |
| `services/online` vitest             | **48** (+6)  | ✅ passed |
| typecheck (web + online) / web build | —            | ✅ clean  |

New tests: Gemini provider message-mapping + PCM helpers (8), settings-store
`onlineProvider` (1), `/session/gemini` route + `availableProviders` (6).

### Live verification — 2026-06-09 (real GEMINI_API_KEY in system env)

Verified the Gemini path end-to-end against the running v1alpha API. **Found and
fixed one real bug** in the token route:

| Check                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY` reachable to server process                                                                                                                   | ✅ present (len 39)                                                                                                                                                                                                                                                                                   |
| `gemini-3.1-flash-live-preview` is a valid Live model                                                                                                          | ✅ (`bidiGenerateContent`)                                                                                                                                                                                                                                                                            |
| Token mint body                                                                                                                                                | ❌→✅ **`liveConnectConstraints` was rejected as unknown field.** Correct shape = `{uses,expireTime,newSessionExpireTime}` → `{name}`. Model-locking via `bidiGenerateContentSetup` made the Live WS close `1011` once the client also sent a setup → now mint an **unconstrained** single-use token. |
| WS setup fields (`responseModalities:['AUDIO']`, input/outputAudioTranscription, systemInstruction, contextWindowCompression.slidingWindow, sessionResumption) | ✅ all accepted → `setupComplete`                                                                                                                                                                                                                                                                     |
| Audio frame `realtimeInput.audio{data,mimeType}`                                                                                                               | ✅ accepted (note: `realtimeInput.mediaChunks` is **deprecated** → `1007`)                                                                                                                                                                                                                            |
| `sessionResumptionUpdate.newHandle` delivery                                                                                                                   | ✅ received                                                                                                                                                                                                                                                                                           |

Fix: `routes/gemini.ts` mints an unconstrained token; test updated.

### Browser end-to-end — 2026-06-09 (Playwright + Windows-TTS speech + real key)

User reported "Gemini captions never appear" (then "both modes look broken").
Drove the real app with a synthetic mic fed from a TTS-generated 16 kHz WAV.

**Found & fixed the actual defect:** `gemini-live-provider.ts` `ws.onmessage`
did `if (typeof ev.data !== 'string') return;` — but **Gemini Live delivers its
JSON server messages as BINARY frames** (ArrayBuffer). Every transcript/
translation was silently dropped → no captions. Fixed to decode ArrayBuffer/Blob
→ UTF-8 → JSON (`tryHandle`). After the fix, the caption board showed the full
translation: 「大家好,歡迎參加會議。今天我們將討論下個季度的項目預算和時間表。」

Isolation steps proving the diagnosis:

- Demo (fake replay) rendered captions → store→CaptionBoard render path OK.
- Node direct-to-Gemini with the same WAV produced correct `inputTranscription`
  (EN) + `outputTranscription` (繁中) → protocol + provider parsing OK.
- Browser WS instrumentation: audio frames were sent (sendCount 97), but server
  messages arrived as `[binary]` and were dropped → the decode bug.
- Synthetic-mic capture measured −15.7 dB through the provider path → audio
  content was real, not silence.
- Auto-VAD only flushes a turn when it sees end-of-speech (a pause); continuous
  looped audio with no clear gap never finalized. Real mics pause naturally, so
  captions appear per utterance. (3.1 input transcript is end-of-utterance, not
  word-by-word — known.)

OpenAI path also rendered captions in the same harness → not broken (the user's
Chrome had `langPair=zh-TW→en`/translation-only persisted, which explains the
English-looking caption they saw). Regression test added: "server frames are
JSON carried over BINARY". Web tests **200**. Purely additive; OpenAI / Hybrid /
Offline untouched.

### Upgrade to Gemini 3.5 Live Translate — 2026-06-10 (released 2026-06-09)

Google shipped **`gemini-3.5-live-translate-preview`** — a dedicated live
speech translation model (Gemini 3 Pro based): **continuous streaming** (not
turn-by-turn), purpose-built translation via `translationConfig`, Traditional
Chinese output. Adopted as the new default `GEMINI_LIVE_MODEL` (env-overridable).
Verified live against the real API and end-to-end in the browser.

| Item                   | Verified (live)                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model available to key | ✅ `gemini-3.5-live-translate-preview` (bidiGenerateContent)                                                                                                                                                                                                                                  |
| Setup (raw WS)         | `generationConfig.translationConfig{targetLanguageCode,echoTargetLanguage}` + `responseModalities:['AUDIO']`; transcription / contextWindowCompression / sessionResumption are **top-level** (NOT in generationConfig — the doc's JSON is the SDK shape). No systemInstruction (unsupported). |
| Traditional Chinese    | `targetLanguageCode = 'zh-Hant'` (en→zh-TW); `'en'` for zh-TW→en                                                                                                                                                                                                                              |
| Streaming              | Continuous: `inputTranscription`/`outputTranscription` deltas every ~0.5 s, ~few s behind speaker. **No `turnComplete`** → provider self-finalizes on sentence boundaries (。！？.!?) + length cap                                                                                            |
| Audio                  | input 16 kHz PCM16 mono (`realtimeInput.audio`), output 24 kHz (ignored)                                                                                                                                                                                                                      |
| Browser e2e            | ✅ history "0:00 大家好。 0:01 歡迎參加會議。" + live "今天我們將討論專案預算和下一季度的時間表。"                                                                                                                                                                                            |

Provider changes (`gemini-live-provider.ts`): model-aware `buildSetup`
(translate → `translationConfig`; native-audio → `systemInstruction`),
`translateTargetCode`, and `maybeFinalizeOnSentence()`/`finalizeTurn()` so the
continuous stream is chunked into sentence segments (history populates, live
line bounded). Default model in `config.ts` → 3.5. `gemini-2.5-flash-native-audio-latest`
remains a fallback via env (system-instruction path still supported).

Tests: web **201** (+ sentence-finalization), online 48, typecheck/build clean.
Note: a `gemini-3.5-flash` chat model also exists but is a separate text model —
the live translation capability is the distinct `*-live-translate-preview`.

### Review-fix pass + full verification matrix — 2026-06-11

High-effort code review (7 angles) surfaced 6 real defects; all fixed:

| Fix                                                          | Detail                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orphaned final translation**                               | A translation finalizing before any source partial referenced a segment that never existed → invisible forever. `maybeFinalizeOnSentence` now requires BOTH source + translation text for the sentence path; `finalizeTurn` falls back to surfacing the translation as the transcript in the rare src-less edge. |
| **Echo-silent unbounded live line**                          | Speaker already in the target language (`echoTargetLanguage:false`) → no translation ever arrives → live source line grew forever. Now tracks `inputTranscription.languageCode`; source self-finalizes on sentence end when input lang == target.                                                                |
| **Stale-WS double reconnect**                                | Old socket's late `onclose` after a reconnect swap spawned a second reconnect chain. Both `onmessage`/`onclose` now guard `this.ws !== ws`.                                                                                                                                                                      |
| **No WS backpressure guard**                                 | Stalled-but-OPEN Gemini socket grew the send buffer unbounded over a long meeting. Added the OfflineSTTProvider guard (1 MB threshold, degraded health every 50 drops, force reconnect at 100 consecutive).                                                                                                      |
| **Gemini ignored `audioSource:'system'`**                    | 🔊 chip claimed system capture while Gemini recorded the mic. `use-gemini-live` now branches to `DisplayMediaAudioProvider` (micDistance forced 'off'), mirroring the OpenAI hook; level polling now reads `mic.analyser` via the interface.                                                                     |
| **Mid-session backend switch orphaned the running provider** | Switching OpenAI↔Gemini while running hid the active provider's UI while billing continued. The Settings backend picker is now disabled while any session runs ("會議進行中 — 請先 Stop 再切換後端").                                                                                                            |

**Browser verification matrix (real key + TTS speech, Playwright):**

| Scenario                                    | Result                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Gemini + mic + bilingual ON                 | ✅ live 繁中「接下來，我們將規劃預算。」+ EN source; history TWO columns, per-sentence rows with timestamps |
| Backend picker while running                | ✅ both options disabled with explanatory tooltip                                                           |
| Gemini + **system audio** (getDisplayMedia) | ✅ captions flow through the new DisplayMedia branch                                                        |
| Bilingual OFF                               | ✅ source line absent, history single column, translation-only                                              |
| OpenAI + mic + bilingual ON                 | ✅ live 繁中 + EN source, pricing panel visible                                                             |

Tests: web **204** (+4 finalization/orphan/echo tests), online 48, typecheck +
build clean. Remaining backlog (cleanup, not bugs): extract shared worklet-
capture base from offline/gemini providers; provider registry in App.tsx to
centralize exclusivity; drop dead native-audio fallback if 3.5 stays default.

### Mid-meeting backend failover + Meeting Playbook — 2026-06-11

Architecture deep-pass found one missing reliability path: CLAUDE.md mandates
"provider switch → do not clear transcript", but the only cross-backend switch
was Stop → Start, which calls `beginSession()` (clears). Fixed: **`handleResume`
now resumes online sessions into the CURRENTLY SELECTED backend** — the picker
unlocks while paused, so the operator flow is _Pause → switch OpenAI↔Gemini →
Resume_ and the transcript continues on the other backend.

Browser-verified end-to-end: Gemini produced「0:00 各位，歡迎來到會議。0:01
我們將審查該計劃。」→ Pause → backend switched to OpenAI → Resume → status
`running` (OpenAI), history fully preserved, new captions appended at 1:18 on
the same session timeline.

Also added `docs/MEETING_PLAYBOOK.md` — operator-facing playbook (繁中):
meeting-type → settings matrix, backend selection guide, mid-meeting rescue
procedures (Pause-first principle), hotkeys, privacy tiers.

Known cost/efficiency notes (backlog): Gemini has no cost panel yet (OpenAI
does); 3.5-translate requires AUDIO responseModality whose synthesized audio we
discard — investigate whether TEXT modality is accepted to cut output-token
cost; `langCodes` recomputed per message (trivial).

### UX reflection pass + UI-expert presentation audit — 2026-06-11

Reflective UX walk + a dedicated caption-typography expert review of the board.
Fixed (all sampled live in-browser at 400 ms resolution):

| Fix                                                               | What the viewer saw before                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Just-finished sentence vanished (M1, worst)**                   | History excluded the last final assuming LiveCaption showed it — but once the NEXT partial started, the previous sentence was in NEITHER area for 1–3 s (every sentence, on Gemini's continuous path). Now history includes the last final **while a partial is in flight** (`hasLive` conditional); sampled timeline shows the sentence landing in history at the exact instant the next partial starts — zero vanish window, no double-display. |
| **Bare 5rem "…" each sentence start (M2)**                        | Translation lags input ~1 s; the big area collapsed to a giant ellipsis and the whole board jittered (history 1fr grew/shrank). Now a small dim `翻譯中…` status label + `min-height: 2.5em` on the target area.                                                                                                                                                                                                                                  |
| **Untranslated finals invisible (M3)**                            | MT failure or Gemini echo-silent finals were skipped by the target-side paragraph accessor → with source column off, the sentence appeared NOWHERE (violates "translation fails → keep source"). Accessors + LiveCaption final state now fall back to source text.                                                                                                                                                                                |
| **CJK display typography (M4)**                                   | line-height 1.22 / letter-spacing −0.01em are Latin display params; 5rem 繁中 lines nearly touched. zh-target scope now 1.35 / 0.                                                                                                                                                                                                                                                                                                                 |
| **Contrast (M5/P2)**                                              | Live source #4a5870 ≈ 2.7:1 (below the 3:1 large-text floor) → #8a98ad ≈ 7:1; history secondary → #7e8da1; time gutter #2a3448 (1.6:1, ghost) → #4a5870.                                                                                                                                                                                                                                                                                          |
| **In-flight words lost on Pause/Stop**                            | Gemini provider now `finalizeTurn()`s on stop — the last utterance reaches history/Export and the stale pulsing cursor is gone (browser-verified mid-utterance pause).                                                                                                                                                                                                                                                                            |
| **Demo while paused wiped the meeting log**                       | Demo disabled while paused, with explanatory title.                                                                                                                                                                                                                                                                                                                                                                                               |
| **Status chip said "running" for OpenAI but "gemini" for Gemini** | Now names the backend (`openai`) — matters mid-failover.                                                                                                                                                                                                                                                                                                                                                                                          |
| **Decimal split ("3." mid-number)**                               | ASCII period only ends a sentence when not preceded by a digit.                                                                                                                                                                                                                                                                                                                                                                                   |

### Transcript durability hardening (interruption safety) — 2026-06-11

User directive: 摘要稍晚，先嚴格確保轉錄資料能保全並輸出，包含中斷狀態。

Audit of the persistence path found the normal flow solid (finalized
`segments`+`translations` autosave to localStorage, reload rehydrates, graceful
Stop finalizes the in-flight utterance via each provider's `flushSegment`/
`finalizeTurn`, 4 export formats). Three interruption-state gaps remained, all
rooted in **no synchronous flush before the page goes away**:

| Gap                                                                               | Risk before fix                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Debounced-only writes (800 ms, 5 s hard cap)                                      | a hard crash / OS kill / tab-close inside the window dropped the most recent finalized segments |
| `livePartial`/`liveTranslation` never persisted (by design, to avoid 20 Hz churn) | an utterance still being spoken at crash time was lost entirely                                 |
| Same window right after Stop                                                      | last finalized line could be lost if the tab closed before the debounce fired                   |

Fix — `captionStore.flushNow()` (`apps/web/src/store/caption-store.ts`):

- Synchronous `localStorage.setItem`, bypassing the debounce.
- **Folds the in-flight `livePartial` + `liveTranslation` into the snapshot** as
  a provisional segment (deduped by id) — the only writer that persists live
  state, so a mid-sentence interruption survives reload.
- Wired to `pagehide` + `visibilitychange→hidden` (the reliable unload signals;
  guarded for the node test env where the APIs are absent).
- `App.tsx` `handleStop` / `handlePause` call it explicitly so the last line is
  durable the instant capture ends, not 800 ms later.
- Recovery path already complete: reload rehydrates (now incl. the folded
  in-flight line); `RestoredSessionChip` + header `ExportMenu` make it
  exportable before any new Start.

Refactor: `buildPersistPayload(state, includeLive)` + `writeSnapshot(key,payload)`
shared by the debounced saver (`includeLive:false`) and `flushNow`
(`includeLive:true`).

Tests: web **210** (+4 — flushNow fold/dedupe/no-op, pagehide/visibilitychange
emergency-flush wiring), typecheck + build clean. online/offline untouched.

### Robustness pass — offline timeline + autosave honesty — 2026-06-11

User directive: 摘要延後，完成各項穩健性強化. Follows the transcript-durability
hardening above; closes the highest-value reliability gaps in the
transcript/session lifecycle.

**1. Offline/Hybrid wall-clock timeline rebase (correctness, was the documented
P6 follow-up).** WHL emits `startMs` relative to audio position and **resets it
to 0 on every WS connection**; `sessionStartMs` is `Date.now()`. Two real bugs
followed:

- Export `.srt`/`.md` and the history time-gutter computed
  `elapsed = max(0, startMs − sessionStartMs)` → with a tiny relative `startMs`
  and a `Date.now()` anchor this **clamped to 0:00 for every offline segment**.
- After an auto-reconnect or Pause→Resume, the new connection's `startMs≈0`
  sorted to the **front** of history (`upsertSorted` orders by `startMs`),
  scrambling the log just hardened in the durability pass.

Fix (`offline-stt-provider.ts`): a per-connection `connectionAnchorMs =
Date.now()` stamped in `ws.onopen`; `rebaseTranscript()` shifts every transcript
`startMs`/`endMs` onto wall-clock before forwarding. Re-stamped on each
reconnect → monotonic across drops/resumes. Unifies offline timestamps with the
online providers (already `Date.now()`-based). Translations key by
`sourceSegmentId` (no time) → untouched. Covers Hybrid too (same provider).

**2. Autosave no-silent-failure (`caption-store.ts`).** `writeSnapshot` swallowed
QuotaExceeded/unavailable-storage errors silently — a failing autosave would
lose the meeting on reload with zero warning. Now warns once (rate-limited)
pointing the user to Export. In-memory captions never blocked either way.

| Suite             | Count                                                     | Status   |
| ----------------- | --------------------------------------------------------- | -------- |
| `apps/web` vitest | **212** (+2 rebase: absolute-shift + reconnect-monotonic) | ✅       |
| typecheck / build | —                                                         | ✅ clean |

Already-covered robustness (verified, no change needed): mic/display track-`ended`
→ `failed` health; offline WS reconnect backoff + WS backpressure force-reconnect;
OpenAI renewal backoff; Gemini stale-WS guard + backpressure; bounded ring buffer
(`maxSegments`) + synced translation pruning.

Remaining robustness backlog (features, not hardening): crash-**continue**
(persist `pausedMode`/session so Resume survives a reload — today reload can
export the restored log but must start a new session); IndexedDB tier for
multi-session / >5 MB history.

### Easy-start launcher + crash-continue + IndexedDB capacity — 2026-06-11

User directive: 「1 2 並且優化啟動點，確保使用者啟動容易」→ clarified: single-session
focus, easy to start different settings. Three interlocking pieces, all
single-session.

**1. Easy-start launcher (item 3).** New `SessionLauncher` (empty-state grid) +
`ContinueBanner` (`components/SessionLauncher.tsx`). On a fresh idle screen the
caption board's empty state is replaced by a one-click grid — OpenAI / Gemini /
Hybrid / 全離線 / Demo — each of which SELECTS its mode+backend AND starts in a
single click (no need to open Settings to switch configuration). Availability-
aware: greys out OpenAI/Gemini without a key, Hybrid/Offline while WhisperLive
is loading, with the reason inline. Header buttons unchanged (e2e + during-/
post-session controls).

**2. Crash-continue (item 1).** Session lifecycle is now persisted:
`sessionMode` ('real'|'gemini'|'offline'|'hybrid'|'fake') + `sessionPhase`
('running'|'paused'|'ended') in the caption-store snapshot. `beginSession(mode)`
stamps mode+running; Pause → `setSessionPhase('paused')`; Resume →
`'running'`; Stop/endSession → `'ended'`. On reload, if a restored session's
phase is running/paused, `ContinueBanner` offers **▶ 繼續上次會議** — resumes the
SAME backend WITHOUT `beginSession()`, preserving the transcript. Online modes
continue into the currently-selected backend (the existing failover path),
shared via `resumeProviderForMode()`.

**3. IndexedDB single-session capacity (item 2).** New `store/idb-persistence.ts`
(tiny dependency-free promise wrapper). IndexedDB is now the PRIMARY durable
store (async debounced write of the full history); `DEFAULT_MAX_SEGMENTS` raised
3000 → **20000** (~11 h). localStorage is retained as the **synchronous** crash
net — IDB cannot be written on `pagehide` — holding a bounded `LS_TAIL_SEGMENTS`
(2000) tail + the in-flight line. On load: instant sync hydrate from
localStorage, then async IDB merge (`mergeSnapshots` — newer `savedAt` wins,
union missing-by-id so the sync tail's post-debounce final/in-flight line is
preserved, cap to maxSegments). A `sessionTouched` guard stops a late async
hydrate from clobbering a freshly-started session. Persist bumped v3 → **v4**
(v2/v3 still read; key `meeting-audio:captions:v4`). `clear()` now also
`idbClear()`s.

| Suite                                      | Count                                                                        | Status       |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------ |
| `apps/web` vitest                          | **220** (+8: lifecycle ×4, tail-bound ×1, mergeSnapshots ×2, tailPayload ×1) | ✅           |
| typecheck / build                          | —                                                                            | ✅ clean     |
| Live browser (Playwright, real dev server) | —                                                                            | ✅ see below |

**Browser-verified end-to-end (real dev server + HMR):**

- Fresh idle → launcher grid (OpenAI/Gemini available, Hybrid/Offline greyed
  "WhisperLive: unavailable", Demo) — `data-testid=session-launcher`.
- Start Demo → persisted `phase=running, mode=fake, segments=4` in the v4 key.
- Reload mid-session (crash) → `ContinueBanner` "上次會議未正常結束 · 4 段字幕已保留
  · Demo 試播 · ▶ 繼續上次會議" + restored transcript visible.
- ▶ 繼續 → status `fake` (running), banner gone, 4 segments preserved (no clear).
- Stop → persisted `phase=ended` → reload would show only the 📂 restored chip.
- Navigation triggered the pagehide emergency-flush, which correctly re-persisted
  in-memory state (durability pass working). Only benign console errors (offline
  :8000 down, favicon 404).

Note: `e2e/fake-replay.spec.ts` pre-start assertion updated `caption-empty` →
`session-launcher` (the empty state is now the launcher; header Demo button
unchanged). e2e not run here (needs full stack).

### Code-review fix pass (persistence races) — 2026-06-11

High-effort review (7 finder angles) of the launcher/crash-continue/IDB diff
surfaced 8 real issues, concentrated in the new IndexedDB layer; all fixed:

| #   | Fix                                                                                                                                                                                                                                                                                                                                        | File                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 1   | **flushNow no longer writes IDB** — it fired on every `visibilitychange→hidden` (tab switch) and, during the pre-hydration window, would overwrite the full IDB history with the localStorage-tail-only state (data loss). Now LS-tail-sync only; the periodic debounced saver owns IDB; the LS tail is merged back over IDB on next load. | `caption-store.ts`   |
| 2   | **Late async hydrate clobbering Continue/Resume** — that path never set `sessionTouched`, so a slow IDB read could revert phase/mode and resurrect the restored chip after resume. `setSessionPhase` (Pause/Resume/Continue) and the first `applyTranscript` now set `sessionTouched`.                                                     | `caption-store.ts`   |
| 3   | **clear() vs in-flight idbSave race** — `clear()`’s delete could lose to a still-committing save from a just-prior flushNow, resurrecting a cleared meeting. All IDB writes now run through one serialized promise chain (`idbChain`); clear routes through it.                                                                            | `caption-store.ts`   |
| 4   | **IDB write cost** — full-history structured clone on every debounce + every tab switch. Now gated (`idbHydrated`/`sessionTouched`) and throttled to ≥8 s (`IDB_SAVE_MIN_INTERVAL_MS`); LS tail is the sync net between IDB writes.                                                                                                        | `caption-store.ts`   |
| 5   | **Page-exit listener leak** — pagehide/visibilitychange were registered per `createCaptionStore()`. Now deduped per key via module-level `lifecycleBoundKeys` (no stacking under HMR / repeated test construction).                                                                                                                        | `caption-store.ts`   |
| 6   | **Continue used the selected backend, not the recorded one** — a Gemini meeting could continue on OpenAI if the picker was changed. `handleContinue` now branches on the persisted `sessionMode` and syncs the picker.                                                                                                                     | `App.tsx`            |
| 7   | **Dead ternary** `sessionEndedAt != null ? 'ended' : 'ended'` → `?? 'ended'` (+ regression test that legacy phase-less data hydrates as `ended`, never resumable).                                                                                                                                                                         | `caption-store.ts`   |
| 8   | **IDB `onblocked` hang** — a future `DB_VERSION` bump with another open tab would leave open requests pending forever. `openDb` now rejects on `onblocked` → callers fall back cleanly.                                                                                                                                                    | `idb-persistence.ts` |

(#9 first-segment 0:00 from the finders was REFUTED — the leading segment
correctly displays 0:00.)

Re-verified live in-browser after the fixes: fresh → Demo → reload (crash) →
ContinueBanner shows the merged **4 segments** (IDB held a throttled early write;
the LS tail reconstructed via `mergeSnapshots`) → Continue → running, banner +
restored chip gone (no resurrection), history grew **4→6** (preserved + appended).
Tests: web **221** (+1 legacy-phase regression), typecheck + build clean.

### Deferred / polish backlog

Deferred (polish backlog): landing-tint continuity cue on the newest history
row; timestamp anchor vs ring-buffer pruning (blocked: offline providers use
connection-relative startMs, so `sessionStartMs` can't anchor them); Fraunces
mixed-script in zh captions; confidence-dimming as a non-opacity cue.

Tests: web **206** (+stop-finalize, +decimal-guard), online 48, typecheck +
build clean.

---

## KEEPALIVE test-engineering (T0 → T1 → T2) — 2026-06-12

Automated verification so the reliability work above can't silently regress —
the failure-injection coverage that previously only existed as manual procedures
in `RUNBOOK.md`.

- **T0 — mock-backend fault-injection e2e.** `tests/e2e/online-mock.ts` provides
  `installOnlineMocks(page)`: an in-browser mock for BOTH online providers (no
  cloud key) — replaces `RTCPeerConnection`/`RTCDataChannel`, `WebSocket`
  (Gemini host only; all other sockets incl. Vite HMR delegate to native),
  `getUserMedia`/`getDisplayMedia`, `AudioContext`/`AudioWorkletNode`, and routes
  `/session*` + the OpenAI SDP call. Its controller injects faults (deltas,
  `session.closed`, `/session` 500 from the Nth call, Gemini socket drop) and
  reads counters (mic acquisitions, peer count). `tests/e2e/online-keepalive.spec.ts`
  (5 tests) drives the REAL provider→store→board→failover loop: OpenAI happy
  path; zero-gap renewal (2nd peer built, **mic reused — getUserMedia stays at
  1**, history kept); repeated renewals (×5) never blank; OpenAI-fail → failover
  banner → one-click switch to Gemini with transcript preserved; Gemini happy +
  auto-reconnect.
- **T1 — soak + zero-gap.** `apps/web/src/store/caption-store.soak.test.ts` —
  5 000-turn interleaved stream + 200-session churn asserting render-path
  invariants THROUGHOUT: `segments[]` reference stable across partials, ring
  buffer capped, no translation orphan-leak, render feed bounded by
  `HISTORY_RENDER_SEGMENTS`. The repeated-renewal e2e is the "mic acquired once,
  no blank window" zero-gap proof.
- **T2 — conformance + property tests.**
  `apps/web/src/providers/provider-conformance.test.ts` validates every event
  each provider (OpenAI/Gemini/offline/fake) emits against the shared
  `NormalizedEvent` schema (enforces "UI consumes normalized events only").
  `apps/web/src/caption-board/paragraph-grouping.property.test.ts` — seeded-PRNG
  properties for `tailSegments` + `groupParagraphsForSide`.
- **Lint hygiene.** `eslint.config.js`: ignore the `release/**` build artifact
  (matching `dist`/`build`), disable base `no-undef` for TS (tsc covers it; it
  false-positived on type-only refs like `RequestInit`), and an AudioWorklet
  globals override for `pcm-worklet.js`. `pnpm lint` now passes (0 errors).

Tests: web **251** unit (20 files; +10: soak ×2, conformance ×4, property ×4),
**20** Playwright e2e (+5 KEEPALIVE), typecheck + lint clean. See
`docs/TEST_PLAN.md` §"KEEPALIVE reliability verification (T0–T2)".

---

## Startup-latency / "啟動好幾秒消失" pass — 2026-06-12

Operator feedback: cold start showed a dead-looking blank board for several
seconds. Two root causes + fixes:

- **No visible startup state (perception).** On Start the launcher vanished and
  the board showed a bare "Waiting for captions…", while `ReconnectingIndicator`
  deliberately ignores `connecting`. Fix: `LiveCaption`'s empty state is now
  health-aware (`startupCue()` in `CaptionBoard.tsx`) — a staged cue with spinner
  `請允許麥克風… → 連線中… → 已連線·正在聆聽…` (`data-phase` on `caption-empty`,
  styled in `CaptionBoard.module.css`). Dead air → explicit "system is working".
- **Sequential mic→token (real ~0.3-0.6 s).** `start()` awaited mic acquisition
  THEN fetched the ephemeral token, though they're independent. Both providers
  now fire the token fetch CONCURRENTLY with `mic.acquire()` (settle-wrapped so a
  mic denial can't orphan the in-flight fetch); on a cold start the token is
  ready by the time the user clicks Allow. Error attribution preserved (mic =
  audio failure, token = transport failure). `openai-realtime-provider.ts`,
  `gemini-live-provider.ts`.

Inherent latency NOT removed (documented, honest): WebRTC ICE/DTLS handshake and
the model needing ~1-2 s of speech before the first translation delta — these are
now MASKED by the listening cue, not hidden.

Follow-up (proposed, not yet done): OpenAI output-delta `s2tw()` re-converts the
whole accumulated string per delta (O(n²)/utterance) — convert incrementally on
the live path, full-convert on finalize.

Verified in real Chromium: `online-keepalive.spec.ts` "startup shows a
connecting/listening cue instead of a blank board". Tests: web **251** unit, **21**
e2e, typecheck + lint clean.

### Pre-warm architecture (P0 + P2) — 2026-06-12

Operator note: "麥克風授權那個在啟動時就應該先做完". Correct — the root inefficiency
was that the WHOLE capture pipeline was rebuilt per Start (and torn down per
Stop). Introduced a shared, long-lived audio engine + online preconnect:

- **`providers/audio-engine.ts` (new)** — one shared `AudioContext` (16 kHz) +
  compiled AudioWorklet module, reused across every session (the worklet is
  registered PER context, so pre-warming it requires a persistent shared
  context). `getCaptureContext()`, `ensureCaptureWorklet()` (loads once),
  `resumeCaptureContext()`, `preconnectRealtimeBackends()` (online-only TLS
  preconnect to OpenAI + Gemini hosts), `prewarmCapture({online})`, and a
  `__resetAudioEngineForTests()` hook. **Never acquires the mic** (zero privacy
  cost — context stays suspended until a session resumes it).
- **Providers route through the engine** — `MicrophoneAudioProvider`,
  `GeminiLiveProvider`, `OfflineSTTProvider` use `getCaptureContext()` +
  `ensureCaptureWorklet()` instead of `new AudioContext()` + `addModule()` per
  start; release/cleanup detaches nodes but **no longer closes** the shared
  context (closing forced a cold rebuild + worklet recompile next Start).
- **`App.tsx`** calls `prewarmCapture()` on mount / mode change; preconnect is
  gated to online mode so offline mode contacts no cloud host.
- Test isolation: `src/test-setup.ts` (wired via `vite.config.ts` →
  `test.setupFiles`) resets the engine before every test so the shared context
  cache can't leak across tests.

Removes the per-start AudioContext build + worklet compile (~70-280 ms) from the
hot path and the TLS handshake (~100-300 ms, online) via preconnect.

### P4 + P1 (re-examined, then completed) — 2026-06-13

On reflection both were worth completing, but the framing changed:

- **P4 — parallel local offer + ICE gather (not "pre-create the offer").**
  `buildPeer` was split into `createLocalOffer(stream)` (mic-only: pc + dc +
  createOffer + setLocalDescription — starts ICE gathering, NO token) and
  `exchangeSdp(pc, offerSdp, secret)` (token: POST SDP + apply answer). `start()`
  runs `createLocalOffer` the instant the mic is ready — IN PARALLEL with the
  in-flight token mint — so STUN candidates accrue during the token RTT and we
  POST the candidate-enriched `localDescription.sdp` at zero added latency
  (previously a candidate-less offer was sent immediately). The renewal path's
  `buildPeer` now composes the two sequentially (behaviour unchanged — the old
  peer keeps captioning, so it gains nothing from parallelism). The real win
  (faster ICE/DTLS connect on NAT/corporate networks) is confirmable only on a
  real endpoint; the mock verifies correctness (still connects + captions).
- **P1 — ephemeral-token pre-mint, safe-by-construction.** New
  `providers/token-prewarm.ts` `WarmTokenCache`: pre-mints a token while idle and
  hands it out single-use ONLY when key-matched + fresh (<45 s) + not within
  120 s of expiry; any doubt → null → caller fetches fresh (worst case == today).
  `openai-realtime-provider.ts` / `gemini-live-provider.ts` expose
  `prewarmOpenAISession()` / `prewarmGeminiSession()` (+ a shared
  `sessionRequestBody()` so the pre-mint key matches the real Start request);
  `fetchSessionToken` / `mintToken` consume the warm token first. The hooks
  pre-mint while idle (gated on `apiKeyStatus`/`geminiStatus` → online-only, no
  cloud contact offline). This hides the ~150-250 ms token RTT that became the
  long pole on a WARM start (after P0/P2 made everything else hot). Process-wide
  caches are reset per test (`test-setup.ts`).

Why P1 is still worth it after Fix B/P0: Fix B overlaps the token with mic
acquisition and P0 preconnect removed its TLS handshake, but P2 made warm-starts
so fast that the token became the remaining front-matter cost — pre-mint hides it.

Verified in real Chromium: `online-keepalive.spec.ts` "idle pre-mint: token
fetched before Start and consumed without a second fetch" + the failover test
rewritten to a deterministic `setOaiSessionFailing()` flag (timing-independent of
the idle pre-mint). Tests: `token-prewarm.test.ts` (9) + `audio-engine.test.ts`
(6); web **265** unit, **22** e2e, typecheck + lint clean.
