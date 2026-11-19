# 網路、離線與場域驗收 Implementation Plan

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐項執行；未取得外部條件的真場域 gate 保持未驗，不以模擬補勾。

**Goal:** 讓支援場域有可重現的能力資格、簡單操作與可信放行證據。

**最新排序：** [主工作清單：兩家交互備援，Gemini 第二金鑰後排](2026-10-15-meeting-hardening-checklist.md)。N2、V1–V3 的主線驗收包含 A4 雙向交互接管；N1 第二 Gemini key 最後處理。N3/N4 按實際本機能力獨立驗，不阻擋雙雲端主線；WASAPI 僅在需要的場域取得擷取資格。

**Architecture:** 既有 providers 與 managed 入口保持主體；憑證、server HTTP、browser transport、離線推論各有獨立能力檢查。驗收從本機故障矩陣逐步擴展到硬體、真人與授權真服務。

**Tech Stack:** Node 24.14.0 已觀察 runtime、Fastify、Chrome Playwright、指定 Python、現有離線 engine／eval 工具。

**Spec:** [診斷與場域契約](../specs/2026-10-15-meeting-resilience-design.md)；依賴 [A 計畫](2026-10-15-capture-continuity.md)、[D 計畫](2026-10-15-durability-service.md)。

**精簡與效能約束：** 遵守[主清單](2026-10-15-meeting-hardening-checklist.md)的「流暢與穩定」「Clean code」條件。下列新增檔名為候選落點；優先沿用既有模組／測試，沒有實際責任或生命週期邊界就不建檔，不預建通用框架。

## Global Constraints

- 禁止把憑證、原始 upstream error body、全文逐字稿寫進一般診斷 log；secret 僅 server。
- 不關 TLS 驗證；公司 CA／Proxy 依授權環境配置，不繞過網路政策。
- Python 一律 `C:\Programs\miniforge3\envs\deve\python.exe`；Windows shell sequential。
- Full Offline 不外送 audio/text，不靜默切雲端；未安裝／未實測模型只能標 unavailable/unverified。
- 本機確定性輸出、真人 ASR、翻譯品質是三種證據；不得互相替代。真 API 執行前核對有效預算及素材外送範圍。

## N2 — 網路路徑資格與 Proxy（F12）

**Files:** `services/online/src/config.ts`、broker fetch 呼叫點、`scripts/service.mjs`／runtime 檢查；先在現有設定／broker 邊界與 tests 增加網路結果；只有共用邏輯確有需要才抽 `services/online/src/network-profile.ts`；A1 預檢顯示結果。需要 Node proxy wrapper 時才建立 `upstream-fetch.ts`，避免不必要依賴。

**Interfaces（新增）:**

```ts
interface NetworkReadiness {
  brokerHttp: 'ready' | 'blocked' | 'unverified';
  browserWss: 'ready' | 'blocked' | 'unverified';
  browserWebRtc: 'ready' | 'blocked' | 'unverified';
  checkedAt: string;
  evidence: 'local-probe' | 'real-endpoint';
}
```

ready 只適用實際測試路徑。token mint 通過不能升級 browser transport 狀態。

- [ ] 先用實際 Node runtime、本機 CONNECT proxy 與受控 HTTPS endpoint 驗 `NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY/NO_PROXY`；代理接收 CONNECT 的計數與直連命中計數都必須保存。不只看 fetch 200。
- [ ] 若 runtime 原生 proxy 滿足路由要求就沿用；不滿足才採官方支援的 dispatcher，說明 runtime floor、fetch／其他 HTTP 差異，不能從舊 Node 22 假設直接加套件。
- [ ] NO_PROXY 包含 loopback；代理憑證不記 log；不信任任意 client 提供 upstream URL；企業 CA 配置正規信任庫，禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- [ ] 在公司 profile 各測 broker HTTP、browser WSS、WebRTC media；若 UDP 不通但既有 WS 可用，驗實際 fallback。若 browser WSS 也被阻擋，UI 明示受限，不能說 server proxy 已解決；只有證據支持才另提同來源 relay 的最小設計。
- [ ] DNS fail、TLS fail、proxy auth、無網路、VPN 換線、401/403/429 分別定位；瀏覽器無法辨別細因時報「連線失敗」與安全診斷代碼，不猜測。
- [ ] 既有 config／broker tests＋本機真 CONNECT 整合（若抽出 network-profile，再跑其 tests）；V2 主線驗兩家各一 key 的可達性與拒絕提示，並驗雙向跨廠接管。Gemini 自動換至第二 key 的驗收移到 B02/N1，第二 key 不存在時不執行。

## V1 — 真人語料、聲學與品質資格（F15）

**Files:** 沿用 `scripts/mixed-caption-eval.mjs`、`scripts/mixed-caption-predictions.mjs`、`tests/fixtures/mixed-caption/`；新增 `docs/evals/2026-10-15-venue-matrix.md`（施工時建立，不放假結果）。

**輸入契約:** 可使用／外送範圍、speaker/session 分組、人工原稿、語言、聲學場景、數字／否定等關鍵標註；synthetic-tts-not-gold 不可取得真人品質分數。

- [ ] 主線啟用場景素材登錄（S6 離線後排另驗，不阻擋線上場景）：近講、遠講、低音量、空調、多人交替、重疊、回聲、混語、金額／日期／否定／自我更正；每組有原音與獨立人工核對，不用模型自評作 ground truth。
- [ ] calibration/holdout 依 speaker/session 分開，禁止同音檔切片跨集合。固定語料比較現行 DSP／候選預設與 VAD 閾值，最後只在 calibration 選值。
- [ ] holdout 報每場景 CER/WER/critical recall、首字/final p50/p95、遠講漏句、靜音幻覺、echo 重複，並列所有關鍵錯誤。純字幕門檻依 spec 第 6 節，未達則場景不放行。
- [ ] 翻譯以人工對照事實、數字、否定與責任歸屬；保留原文缺失和翻譯錯誤區分，不把「流暢」當正確。
- [ ] 每份模型／DSP／閾值選擇附相同素材 A/B、機型、成本、效能；不因單一乾淨樣本好就換正式預設。

## V2 — 故障矩陣、長測與備份演練

**Files:** 擴充 `tests/e2e/native-audio.spec.ts`、`native-webrtc.spec.ts`、`pure-captions.spec.ts`、`meeting-recovery.spec.ts`、新增 A/D 指定 spec；沿用 `native-soak.ts`、`pure-soak.ts`，補各故障測試 assertions，不能只採樣有字。

| 注入／操作                                                               | 必驗結果                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 3/10/30 秒網路中斷，90 秒超容量                                          | 同場恢復；sample／event／持久保存帳一致，超容量區間明示；不假裝已補回   |
| 401/403/429、HTTP body 卡住、WS 半開、只控制訊息無文字、candidate fail   | 分類與冷卻正確；不誤殺健康主線、不重試風暴；記首有效字而非僅 ready      |
| mute、PCM freeze、context suspend、USB 拔插、BT 重連、HDMI output change | 故障層級正確、原來源辨識、單一下一步、不靜默換麥克風                    |
| display picker cancel/no audio/Stop sharing                              | 不重開 picker 風暴；不清歷史；新一輪授權來自使用者手勢                  |
| 真 sleep/wake 與 lock/unlock 分別測                                      | 睡眠不是可保全音訊；gap 有估計範圍、醒後同場接續、Stop 不復活           |
| renderer crash、worker hang、host crash、port collision                  | 對應 A/D 恢復；已 ACK 不丟、IDB 已提交能重送；origin 未恢復時不顯示全存 |
| IDB quota／DB FULL／export fail                                          | 字幕繼續、未存狀態與缺失永久留痕、故障解除後全文核對                    |
| mic＋remote，任一路故障、兩路同時講話                                    | 獨立 track、單軌降級、雙來源不誤標為語者，回聲另評                      |

- [ ] 四條線上路徑（兩家×翻譯／純字幕）各跑 2 小時 LOCAL 原生音訊，跨多輪續期；雙軌另跑。另測兩家雙向接管、兩端皆失敗及搶先恢復；Gemini 第二 key 保持未配置。固定故障時間表與連續編號素材，記音訊 sample range、submitted、provider content、archive receipts。
- [ ] 沿用 `caption-longtask.spec.ts`、`native-caption-performance.spec.ts` 與 latency monitor，補主清單的 normalized event→DOM、操作回應及保存／匯出故障隔離量測；不另建效能工具平台。
- [ ] performance 採樣使用低負載監測，避免把 per-frame Playwright assertion 累積當產品漏記憶體。輸出 raw samples、最長 frame gap、heap/CPU 趨勢與 Stop 後資源清理。
- [ ] 新 build 通過後才進授權真服務至少 60 分鐘／選定 provider 場域；先計費估算及硬上限，達預算就結束並標未完，不默認四路全付費跑滿。
- [ ] 真內外網／VPN 切換用可存取的授權環境，測 broker 和 browser 路徑；缺環境不能以本機 proxy substitute 標通過。
- [ ] 以真人長稿走原稿／校訂／譯文／SRT/JSON 核對與 D4 真備份還原；SRT 重疊時碼與 capture-estimated 標示有明確播放器驗證，不偷偷改成精確詞級時間。
- [ ] 保存結果於日期＋build ID 的獨立 evidence 目錄，含測試命令、runtime、雜湊、模式、音源、語料身分、耗時／費用、失敗及未驗；不得覆蓋歷史證據。

## V3 — 場域易用性與放行

**Files:** `docs/RUNBOOK.md`、`PROJECT_STATE.md`、`TODO.md`、`TEST_PLAN.md`、必要場景 UI；可另建立 `docs/evals/<date>-release-acceptance.md` 保存實際結果。

- [ ] 每場景至少 3 次獨立操作，不用工程文件完成開會前檢查、開始、Pause/Resume、故障下一步、結案匯出；記實際步驟、耗時、人工介入、理解錯誤。
- [ ] 原生選音授權步驟不偽裝全自動；已分類可自救的故障人工救援 0 次，硬體／權限例外按清楚契約驗收。
- [ ] 服務／UI 顯示實際 build、origin、模式、目前及可接管 provider；對方不可用時如實顯示。主線 W01–W12 包含兩家交互備援，後排 B00/B02 不作放行條件。會議中不擅自升級。
- [ ] 完整回歸：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、受影響 Chrome configs、managed lifecycle；Python 僅有改離線時跑指定 runtime 測試。失敗先診斷，不刪 skip 或改門檻求綠。
- [ ] fresh review 同時執行主清單的精簡審查：單一 owner、無重複恢復／保存／事件路徑、新增資源有界、被取代路徑已清除，且直接流暢度結果未退步。
- [ ] fresh review 對照全部 F01–F15、S1–S7 與任務覆蓋；保留待驗場景、無法恢復的資料範圍及使用者下一步。只有已驗場景可交付「可穩定使用」結論。

## 外部條件不足時的交付

可交付本機工程修復與本機驗證，明確標示尚未取得真人／硬體／網路／費用條件的場域；不把完整產品放行標完成。不要以等待外部條件為由停止主線中不依賴它們的工作；Gemini 第二 key 維持暫緩，不因資源偶然存在就自動開工；兩家交互接管依主線完成。

## 條件式保留細節：第二金鑰最後、本機能力獨立驗

N1 依 B00 第二 Gemini key 確認及後續開工指示執行；N3/N4 依本機能力與場域需求，不是 A4 兩家交互接管的前置。

## N3 — 離線資格（資源條件獨立工作）與按需 WASAPI 擷取（F13/F14）

離線辨識／MT 安裝、修復與接管待本機資源確認及相應開工；W11 若需要 WASAPI，僅抽取 endpoint/callback/task supervision/重取樣的收音工作獨立執行，不能因此要求離線模型。

**Files:** `services/offline/app/main.py`、`pipeline/asr.py`、`pipeline/translation.py`、`pipeline/translation_dispatcher.py`、`capture/wasapi_loopback.py`、`services/offline/run_whl.py`、`pyproject.toml`；更新 `docs/OFFLINE_STT.md`、`OFFLINE_TRANSLATION.md`、`ONLINE_OFFLINE_MODES.md`。擴充 `services/offline/tests/` 對應 tests。

**Interfaces:** health 能力區分 installed/model-present/loading/inference-ready/failed，回報實際 engine 與模型版本，不以 port alive 充當辨識就緒；WASAPI 產 normalized audio health 與 A3 sample-range gap。

- [ ] 先重現目前指定 runtime 依賴缺失、真 STT 錄音推論、zh→en 重複及 MT timeout 是否占住 worker。依本輪輸出決定修復，不能照抄歷史缺陷當已重現。
- [ ] 固定實際 Whisper bridge／模型／CT2／裝置依賴與安裝流程，排除禁止模型；模型 download/load 不在字幕 hot path，預檢只在就緒後提供離線選項。
- [ ] 對不可取消的 MT native inference 使用可終止的 worker process，固定一個 active job、有界 queue，timeout 後實際回收／重建，確認下一個正常請求成功；不能只對 future 加 timeout。
- [ ] WASAPI 修正 health 與實作矛盾；capture task exception 立即 forward health，監測 callback 停止／endpoint 消失，選定 endpoint 與預設輸出變更政策可見。
- [ ] callback 記 source sample clock、drop/status；queue 以音訊秒數限制，不用相同 200 blocks 假設不同 sampleRate 都等時長。重取樣量測 44.1/48→16 kHz 的長時間樣本數、連續性、CPU與 aliasing；現有線性插值若未過，再採成熟 stateful resampler，不能先宣稱必然錯字。
- [ ] 本機 inference 與故障恢復通過後，才把離線列為可選備援；切換維持 meetingId／來源且明示品質／延遲差異。Full Offline 的外送清單為空。
- [ ] 執行指定 runtime：`& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests`；另執行真模型錄音、WASAPI 裝置拔插／輸出改變。攔截非 loopback 流量，完整離線字幕／保存／匯出期間為 0；測試必須先備妥所有本機資產。

## N4 — 會議中本機缺口補處理（資源條件獨立工作／L2）

**Depends:** A3 的 sample-range 保全、D1/D3 保存與 N3 真推論資格；未具備時只能明示缺口，不能啟用假備援。

**Files:** 新增 `apps/web/src/providers/gap-repair.ts`／tests；擴充 `services/offline/app/pipeline/asr.py`、normalized contracts、`meeting-archive-client.ts` 與 `storage/meeting-writer.worker.ts` 的修訂來源；新增 `tests/e2e/gap-repair.spec.ts`。

**Interfaces（新增）:** `RepairJob = { jobId, meetingId, range: SampleRange, purpose, status }`，status 為 queued/running/repaired/needs-review/unrecoverable；輸出攜 jobId、來源模型、音訊區間與修訂依據。PCM 僅從 A3 尚存在的 ring 讀取，不新增錄音檔。

沿用 GapRecord 狀態：queued/needs-review→pending、running→repairing、repaired→repaired、unrecoverable→unrecoverable；needs-review 原因獨立保留。現有 TranscriptCorrection.source 只允許 human，不能偽裝成人工校訂；新增 `kind:'repair'` 的 normalized payload，帶 `jobId/segmentId/baseRevision/text/provider/range`，經契約與資料庫相容遷移後保存為獨立機器補處理 revision。

- [ ] 紅測：相同文字的兩次真發言、補處理晚於新 live、重送 job、Stop during repair、buffer 已覆寫、沒有合格本機 MT、原稿已人工校訂；不能覆寫當前 live 或抹掉校訂。
- [ ] 補處理走既有合格本機 VAD＋rolling buffer／streaming policy，單一 active job、有界 PCM 複本與 deadline，不使用獨立 naive Whisper chunking。優先 live 收音，量測雙工作對 CPU/GPU／延遲的影響；超載時停補處理並明示。
- [ ] 翻譯 purpose 需合格本機 STT＋MT；只有 STT 時可補原文、譯文仍缺，不當完整 repaired。Full Offline 不可調雲端補譯。
- [ ] 結果以歷史 revision 合併，保持 raw 與人工校訂來源；只有確認匹配區間與保存 ACK 後標 repaired。無精確對齊保留 needs-review，禁止以文字相等刪除原稿。
- [ ] Stop/Pause 取消工作、清 PCM 複本與 ring，未完成範圍標 unrecoverable。若日後要停止後繼續補處理或保留錄音，須另定保留範圍與政策，不隱含在本工作內。
- [ ] `pnpm -F web exec vitest run src/providers/gap-repair.test.ts`、指定 Python pipeline tests，再 Chrome 實際缺口→本機推論→archive→export；攔截外送為 0，真 ASR 錯誤與資料合併錯誤分開報。

## N1 — Gemini 金鑰備援（後排 B02，須先確認備用 key 存在）

單 key 的失敗分類與 Retry-After 由 W03/A4 先完成，不依賴本項。

**Files:** `services/online/src/config.ts`、新增 `gemini-keys.ts`／tests、`routes/gemini.ts`、`routes/gemini-transcription.ts`、兩家 Gemini providers；沿用 OpenAI key-slot 設計但先讀其測試與語意。

**Interfaces（新增）:** server `GeminiKeySlot = 'primary' | 'backup'`，config `GEMINI_API_KEY_BACKUP`；broker 回傳所選 slot 及可用 alternate（無原始 key）。A4 `RecoveryFailure` 維持 auth/network/rate-limit 分類。

- [ ] 紅測：primary mint 401/403、兩槽全拒、primary 429、網路 timeout、單 key、舊 slot 遲來回報、call-stage opaque close；非明確 auth 不長期 demote。
- [ ] 只有已配置／允許的 alternate 可使用；auth demotion TTL 預定 5 分鐘且可注入測試，之後再試 primary。429 遵守 Retry-After，不能把換 key 當逃避 quota 的方法。
- [ ] browser 回報 slot 與短期 session 對應需 server 驗證，不能讓任意網頁提交 failedSlot 汙染全域 key 狀態。未知 close 只可分類 unknown-network，不造出 IP 封鎖結論。
- [ ] translation 與 transcription brokers 都測；slot 恢復、單 key 部署與 Stop 取消保持原行為。狀態不印 key／URL query。
- [ ] `pnpm -F online exec vitest run src/gemini-keys.test.ts src/routes/gemini.test.ts src/routes/gemini-transcription.test.ts`，再跑相關 web providers；Chrome 注入拒絕，驗證實際選槽與第一個有效字幕。真公司網路回 V2。
