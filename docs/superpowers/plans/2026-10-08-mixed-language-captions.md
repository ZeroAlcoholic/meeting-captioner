# Mixed-language Pure Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本文保留原始規劃清單；使用者後續已授權開工，取代當時「僅規劃」限制。實際完成範圍、實作調整及驗證結果以 [執行紀錄](2026-10-08-execution-ledger.md) 為準；付費測試仍依明確預算執行。

**Goal:** 交付國語以台灣繁體顯示、英文與原文保留的精準純字幕，以及可恢復、可校訂、可核對的完整地端逐字稿；A＋B 均通過才算首版完成。

**Architecture:** 以獨立工作目的及專用 transcription provider 接入既有 normalized events；共享已驗證的音源及恢復機制。新的 broker 與 managed service 同程序同來源；首版接續完成既有 L1 地端保存，語者及摘要依藍圖後續交付。

**Tech Stack:** 現有 TypeScript、React、Zustand、Zod、Fastify、Vitest、Playwright/Chrome、Node managed service；不預設新增套件。

**Spec:** [診斷與完整藍圖](../specs/2026-10-08-mixed-language-captions-meeting-blueprint.md)。執行前另讀 CLAUDE.md、REFERENCE.md、PROJECT_STATE、ARCHITECTURE、TODO、相關 audio/failure/test/runbook 文件。

## Global Constraints

- 第一階段先線上垂直切片，Offline 保持真實能力與可用性標示，不假裝線上功能等於離線支援。
- 純字幕只產生 TranscriptEvent，partial 可修訂、final 可保存。
- 保存、語者及摘要失敗只顯示各自狀態，不停止字幕。
- 既有使用者遷移後保留原翻譯設定。
- 不做文字相同即去重；連續兩次「對，對」可能是有效發言。
- 所有 Python 命令明確使用 `C:\Programs\miniforge3\envs\deve\python.exe`；本計畫預期不需 Python。
- Shell 依工作區規則循序執行；保留既有未提交變更，不能整包 commit 他人工作。
- 不新增日常 HTTP 埠；`pnpm service:status` 核對現況，必要更新才 stop/start，URL 取 status。
- 使用者已允許施工時關閉本工作區 managed 服務；開始實作後可 stop、核對 instance 已退出，再建置／驗證／start。不需重問此項許可，也不可依埠號終止別人的程序。
- 真 API 測試前提出當日價格、音訊分鐘數／重試次數及金額上限，取得專案規則要求的預算核准。
- 每項程式任務以失敗測試 → 最小實作 → 對應驗證 → diff 審查完成；不以編譯通過取代行為驗證。

## 檔案與介面配置

以下 Create 是預計新增，並非已存在。執行時若現有程式已有同職責實作，先驗證並重用，避免平行副本；檔名調整需同步本計畫。

| Task  | 修改／新增檔案                                                                                                                                                       | 責任                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A0    | Create `docs/evals/mixed-caption-baseline.md`、`tests/fixtures/mixed-caption/manifest.json`                                                                          | 語料索引、帳號／API／品質與成本基準；私人音訊不進 git |
| A1    | Create `packages/contracts/src/caption-task.ts`、相鄰 `.test.ts`；Modify contracts `index.ts`、`transcript-event.ts` 及測試；web `settings/settings-store.ts` 及測試 | 目的、語言政策、向後相容 provenance                   |
| A2    | Create `services/online/src/routes/transcription.ts` 及 `.test.ts`；Modify `server.ts`、`config.ts`、`routes/session.ts` 及相關測試                                  | 受限 broker、能力資訊、認證與期限                     |
| A3    | Create web `providers/openai-transcription-provider.ts`、`transcription-turns.ts`、`transcript-normalization.ts` 及相鄰測試                                          | 專用協定、回合／時間對應、原文保留                    |
| A4    | Create web `providers/use-openai-transcription.ts` 及測試；Modify `App.tsx`、`token-prewarm.ts`、`meeting-recovery.ts` 及測試                                        | 目的感知生命週期、預熱／恢復                          |
| A5    | Modify web `components/SessionLauncher.tsx`、`caption-board/CaptionBoard.tsx`、`displayed-live.ts` 及測試                                                            | 單字幕流程、可見失敗狀態                              |
| A6    | Modify web `store/caption-store.ts`、`caption-persistence.ts`、`export/formatters.ts` 及相鄰測試                                                                     | metadata 保留、舊快照遷移、純文字與 SRT 匯出          |
| A7    | Create `tests/e2e/pure-captions.spec.ts`、`pure-captions.config.ts`；Modify 必要的現有 mock/native test harness 與 docs                                              | Chrome、原生音訊、真服務分層驗收                      |
| B1–B4 | 沿用既有 continuity plan T01–T04/T10/T11 的明確檔案；新增 web `components/TranscriptEditor.tsx` 及測試                                                               | 首版完整留存、人工校訂、結案核對；詳見本計畫 B 節     |

所有 `web` 路徑均相對 `apps/web/src/`；contracts/server 檔案修改前核對最新實作。避免為新模式全面重寫大型 App 或翻譯 provider。

## A0：先取得會影響架構的證據

**輸入：** 藍圖 §3/4/7、目前上游 adapter、可使用的代表性音訊。

**輸出：** 固定語料 manifest、選定一種已實證 transport、上游契約 fixture、固定驗收門檻。這是後續 A2/A3 的依據，不是實作後補做的文件。

- [ ] 建立至少 24 段具 reference transcript 的索引，欄位為 `id/audioPath/sha256/durationMs/scenario/reference/criticalTerms/split`；音訊存受控地端路徑，reference 含私人內容也不提交公共 repository。保留 holdout，不用全部語料調 prompt。
- [ ] 覆蓋句內切換、完整英文、術語／email／URL、日期／金額／否定、更正、多人、近講／遠場、靜音。至少包含「不是 approve，是 pending review」及原樣重複發言。
- [ ] 明確記錄會後可否使用錄音校對；如要保留音訊，另定來源、期限、容量、刪除及處理授權。未決定前不默認啟用錄音；rawText 只代表 ASR 原始輸出，不代表人聲真值。
- [ ] 讀當日官方轉寫規格，列明 session 建立、短效憑證、連線、ready、delta、completed、commit ack、錯誤／取消；不得沿用 translation endpoints。確認本機 SDK 是否支持需要欄位，必要時用窄範圍 fetch adapter，不為此全面升級依賴。
- [ ] 在付費核准前只做契約／fixture 檢查；取得核准後，以最小音訊驗證帳號、候選 `gpt-live-transcribe`、zh-tw/en、client VAD commit 與所選 transport。記錄實際支援，不把文件或有 key 當作帳號可用證據。
- [ ] 比較低延遲／品質設定在同一批音訊上的 CER、WER、關鍵詞、首字／final 延遲與成本。以藍圖目標作起點，固定場景與門檻；未達標先分析音源、斷句或模型原因，不私自降標。
- [ ] 決定只做一種 transport：優先驗證 WebRTC；若選 WS，記錄原因、browser ephemeral auth 與 24 kHz PCM 實測。若需 relay，沿現有 server 同埠實作。任何契約差異更新下列 A2/A3 後才實作。
- [ ] 審查輸出：未知帳號能力／音訊權限／預算列為具體 gate；未通過時允許繼續無相依的設定與 UI 測試設計，但不得宣稱端到端方案已可用。

## A1：工作目的與文字 provenance

**介面提案：** 在 contracts 輸出 `CaptionTask` schema/type，名稱與欄位在此凍結；不改既有 Mode 的定義。

```ts
export const CaptionTask = z.discriminatedUnion('purpose', [
  z
    .object({
      purpose: z.literal('transcription'),
      inputLanguages: z
        .array(z.enum(['zh-tw', 'en']))
        .min(1)
        .max(2),
      textPolicy: z.literal('zh-TW-preserve-original'),
    })
    .strict(),
  z
    .object({
      purpose: z.literal('translation'),
      langPair: z.enum(['en→zh-TW', 'zh-TW→en']),
    })
    .strict(),
]);
```

TranscriptEvent 加 optional `rawText: string`、`textNormalization: 'opencc-cn-tw-v1'`、`timingBasis: 'capture-estimated'`；`text` 仍是顯示字幕。無變換可不附 rawText；新 provider 標明推估時碼。不在本步預造 speaker 或 summary schema。後續 B 保存數字 revision 與會議 provenance，不能拿目前 `revisionOf` 字串冒充數字版號。

- [ ] 新增並先執行 schema 測試，驗證舊事件可解析、新 task 合法、transcription 夾帶 langPair 被拒絕：

```ts
expect(
  CaptionTask.safeParse({
    purpose: 'transcription',
    inputLanguages: ['zh-tw', 'en'],
    textPolicy: 'zh-TW-preserve-original',
  }).success,
).toBe(true);
expect(
  CaptionTask.safeParse({
    purpose: 'transcription',
    langPair: 'en→zh-TW',
    inputLanguages: ['zh-tw'],
    textPolicy: 'zh-TW-preserve-original',
  }).success,
).toBe(false);
```

- [ ] 實作 schema/export；設定以 `captionTask` 保存，新欄位缺少時由舊 langPair 生成 translation task，不變更舊使用者偏好。
- [ ] 新增 settings migration 測試：兩種舊方向、無設定、錯誤 JSON、不支援語言及會議中禁止切 purpose；無效值採既有安全預設並可見說明，不悄悄啟動其他目的。
- [ ] 執行 `pnpm --filter @meeting-audio/contracts test` 與 web settings 定向 Vitest；檢查 diff 僅含契約與設定。

## A2：專用 session broker 與能力表

**輸入：** A0 已確認的 session/token 協定、A1 的 transcription task。

**輸出：** `registerTranscription(app: FastifyInstance): Promise<void>`，註冊 `POST /session/transcription`。前端只能要求 allowlist 語言／語音環境，不接受任意模型、上游 URL 或長效 key。成功回應沿所選 transport 定義短效憑證與期限，精確欄位按 A0 fixture 固定。

`GET /session/info` 新增 `taskCapabilities`，不移除舊 availableProviders；每項含 `provider/purpose/configured/verified`，有 key 只代表 configured。模型拒絕時回傳明確 unavailable，不能假定帳號永遠有權限。

- [ ] 用 Fastify inject 寫未註冊 route、無 key、無效語言、任意 model 欄位、上游 timeout、429、401 的失敗測試；mock 上游不打真 API。
- [ ] 最小 happy-path 測試必須斷言 upstream 是 A0 確認的 transcription endpoint、session.type 是 transcription、沒有 translation config：

```ts
expect(upstreamRequest.session.type).toBe('transcription');
expect(JSON.stringify(upstreamRequest)).not.toContain('translationConfig');
expect(responseBody).not.toHaveProperty('apiKey');
```

此處 `upstreamRequest/responseBody` 是測試中攔截 fetch 及 inject 的區域變數，按現有 route 測試模式建立。

- [ ] 實作獨立 route，重用 key failover、安全 logging 與已存在期限機制；rate limit 的總額不能因多了一個 endpoint 而繞過。只有短效憑證送前端，禁止在測試 artifact/log 印 key/token。
- [ ] 註冊 server route、能力資訊；驗證沒有 key 的 unavailable、取消請求及 key-slot failover；token mint 未 ready 不標示可收字幕。
- [ ] 執行 `pnpm --filter @meeting-audio/online test`；檢查既有 `/session` 翻譯 payload 不變、managed same-origin 與 release bundle 可註冊新路由。

## A3：連續音訊、回合與專用 provider

**輸入：** 現有 `AudioSource`、`CaptionProviderHandlers`、A2 broker、A0 fixture。

**輸出：** `OpenAITranscriptionProvider implements CaptionProvider`，建構參數含 audioSource、handlers、task；沿既有依賴注入模式提供 transport seam。`normalizeTranscript(raw: string): {text: string; rawText?: string}` 放在獨立文字模組。`transcription-turns.ts` 維護 generation/itemId/commit order/audio start-end，對外由 provider 使用；不暴露上游事件給 UI。

- [ ] 先寫 normalization 測試，覆蓋繁體、簡體中文＋英文、URL、email、大小寫、版本號、重複詞；以 actual OpenCC 字形輸出訂 expected，不加入語意替換：

```ts
const raw = '不是 approve，是 pending review；API p95 300 ms。';
expect(normalizeTranscript(raw).text).toBe(raw);
```

- [ ] 實作可追溯轉字：變換時保留 rawText 與 normalization 版本；不得做 LLM 潤稿。針對專有名詞的 OpenCC 詞彙變換做回歸，必要時採較保守字形設定並記錄差異。
- [ ] 建立事件序列 fixture：兩回合 A/B，B final 先到；A partial 重複／revised；同文但不同 item；舊 generation 晚到；final 後 stop。斷言以音訊順序呈現、每個 item final 一次、兩個不同 item 不合併。
- [ ] 實作所選 transport 的 ready/append或media/commit/error/stop；client VAD 用已驗證元件；speech-end 提交及有界長發話分段保留 continuation。先證明尾音與短停頓不漏，再調延遲。
- [ ] WebSocket 路徑若被選定，復用 stateful resampler 並驗證 48k→24k、跨 frame seam、背壓與 bounded buffer；WebRTC 路徑驗證 media track 與 VAD 觀測同一音源時鐘。兩條路徑不要未經評測同時落地。
- [ ] 加入靜音不生字、連續 60 秒發話、極短發言、stop 時尾段 commit、stop deadline、取消後回呼、權限撤銷、上游 malformed events 測試。送出前或未獲結果的音訊不得標成已完成；停止後未完成內容清楚標示，不無限等待。
- [ ] 驗證 handlers.onTranslation 呼叫數為 0、無模型音訊播放、unknown confidence/speaker 未生成；啟動／停止失敗不洩漏 capture lease。
- [ ] 執行新增 provider/turns/normalization 定向測試，加跑既有 audio-engine、capture-lease、provider-conformance 測試；真音訊品質留 A7，不用 fixture 冒充。

## A4：開始、預熱、恢復與停止

**輸入：** A1 task、A2 taskCapabilities、A3 provider、現有 meeting-recovery generation。

**輸出：** `useOpenAITranscription` 與 App 既有生命周期整合；沿用既有 hook 回傳慣例，不另造第二套全域恢復 scheduler。

- [ ] 先寫測試：純字幕 purpose 不預熱 OpenAI Translation/Gemini Translation；key 含 purpose、語言、模型／影響 token 的環境設定及 key slot；translation token 不能被 transcription 消費。
- [ ] 改候選選擇為 taskCapabilities，僅允許相同 purpose；候選不可用時顯示重試／暫停，不能自動切成翻譯或未授權雲端。
- [ ] 以可控 promise 測 ready 前 Stop、retry A 尚未完成又 retry B、A token 晚到、網路離線→恢復、權限撤銷；斷言 stale generation 不改畫面、不另開擷取、不送音訊。
- [ ] 實作 token prewarm 僅在該目的可用且符合既有政策時執行；未操作不得因顯示新選項額外建立付費 session。Stop 清 timer／訂閱／audio resources；Retry 保留歷史；新會議重設 timeline。
- [ ] 跑 App/recovery/token-prewarm/online-hooks-lifecycle 定向測試；舊翻譯雙 provider 接管回歸仍需通過。

## A5：純字幕 UI 垂直切片

**輸入：** task、normalized transcript、各元件健康狀態。

**輸出：** Launcher 目的選項與 CaptionBoard 單主欄；不更動 normalized events 的責任邊界。

- [ ] 先寫渲染測試：純字幕有一份 transcript、沒有「翻譯中」或目標語言欄；partial 更新不累積重複行，final 穩定保留；翻譯模式仍雙語。
- [ ] 實作「純字幕（繁中＋原文）」選項與明確說明；會議中鎖定目的，停止後可修改；語言選项不誤導為全文強制中文。
- [ ] 加入無權限、無音訊、連線中、辨識中、重連、字幕不可用、已停止狀態。未知支援禁用並說明；不要顯示未完成的摘要空殼。
- [ ] 純字幕不累加 translation 使用量；若無模型實際用量，僅顯示連線／音訊時間及「費用未確認」，不假算價格。狀態訊息不覆蓋已取得字幕。
- [ ] Chrome 檢查 1280×720 與窄視窗、鍵盤操作、fullscreen、長英文詞、混合標點；確認字幕主區不因狀態更新跳動。測試使用 mocks 時以報告標明。

## A6：匯出與現有快照相容

**輸入：** A1 provenance、現有 CaptionState/PersistedState/SessionMetadata。

**輸出：** 新事件欄位不在 store mapping 遺失；快照保存 purpose metadata；純字幕匯出只有 transcript。完整 durable history 仍屬 B，不在此偽裝完成。

- [ ] 寫舊 v2/v3/v4 快照 migration、缺 purpose、rawText、timingBasis、translation history 保留的測試；新增格式 version 並沿用既有 ended 安全遷移語意。
- [ ] 修改 store/persistence mapping 保留新增欄位，無 purpose 的歷史按 legacy translation 處理；不清除舊字幕，不跨會議混合。
- [ ] 匯出 options 隨 purpose 決定預設；transcription 強制不拼接遺留 translation。針對英文字串、正確排序、無 endMs、重複有效發言及空會議寫測試：

```ts
expect(
  toPlainText(
    { segments: [segment], translations: {}, sessionStartMs: 0 },
    { includeSource: true, includeTranslation: false },
  ),
).toBe(segment.text);
```

`segment` 使用既有 formatter 測試 builder 建構，text 含中英混語；另以會議 purpose 整合測試證明 UI 確實傳入上述選項。

- [ ] SRT 延用可解釋的片段時間規則，匯出 UI 說明為推估時碼；原始字形與人工修訂的完整結構匯出列入 B，不硬塞進 SRT 文本。
- [ ] UI 歷史有界時顯示匯出涵蓋範圍，不能寫「整場完整保存」。執行 store/persistence/formatters 回歸，檢查純字幕沒有重複來源＋譯文。

## A7：驗收、回歸與交付

**輸入：** A0 固定的 gold corpus／門檻、A1–A6 實作、既有 managed service。

**輸出：** 分層證據報告、未通過項目與可重現步驟；只有真服務通過才標記 A 已完成。

- [ ] 受控 Chrome E2E：啟動純字幕、中英 partial→final、停止、重試、目的鎖定、匯出；攔截所有請求斷言 translation endpoints 零呼叫、無意外 8000/8787 探測。
- [ ] 以現有 native audio harness 擴充測試真實瀏覽器擷取／連續 resampling／VAD／所選 transport，包含 48kHz、靜音、尾段停止與重連；mock upstream 結果只證明本機邊界，不證明 ASR 品質。
- [ ] 執行 `pnpm --filter @meeting-audio/contracts test`、`pnpm --filter @meeting-audio/web test`、`pnpm --filter @meeting-audio/online test`、`pnpm typecheck`、`pnpm lint`、`pnpm test:service`。若舊快取掃描問題重現，記錄原錯誤並診斷，不放寬斷言或刪使用者資料以求綠燈。
- [ ] 新建 `pure-captions.config.ts` 使用已安裝 `channel: 'chrome'`，project 名稱 `chrome`；測試 server 綁 loopback port 0，將實際 URL 傳給測試，setup 持有自己建立的 server handle 並 teardown。不要複製現有 dev config 的固定 5173 或 native config 的固定 5208／任意 reuseExistingServer。執行 `pnpm exec playwright test --config tests/e2e/pure-captions.config.ts --project chrome`。
- [ ] 日常 build 驗收先 status；需要載入新 build 時僅管理本工作區實例。確認同一服務、實際 URL、重複 start 重用、占埠時 fallback、Stop 不殺外部程序。只在 runtime 變更後做需要的 lifecycle 驗證，不無目的重啟。
- [ ] 預算核准後執行 A0 語料＋holdout 真服務測試，報告分場景 CER/WER/關鍵詞／關鍵錯誤／延遲／費用／樣本數，不只平均。若權限或預算尚缺，A 狀態保持「實作完成、真實品質未驗收」。
- [ ] 60 分鐘本機原生音訊長測檢查有界記憶體、順序、停止與恢復；真雲端長測另列預算及門檻。不要沿用未完成的 R5 當作新模式已過長測。
- [ ] 檢查最終 diff、關鍵正常與失敗路徑、既有翻譯回歸；更新 PROJECT_STATE/TODO/TEST_PLAN/RUNBOOK/DECISIONS，明列已實證與未實證項目。分批 checkpoint 只收本任務檔案，不全域 `git add .`。

## B：首版必要的完整逐字稿留存

本節提升既有 L1 優先序，沿用 [continuity 執行計畫](2026-10-02-meeting-continuity.md) 的 T01–T04/T10/T11；那些章節的檔案、介面、批次大小、期限與失敗測試是本節的必要輸入，不另建第二個 archive。舊文件稱 L1「後排」是當日排程；依 10/08 最新目標，現在是首版必做。T05–T09 非全數成為先決條件，避免為保存被迫展開整套音訊補錄。

### B1：會議身分、交易寫入與持久確認

**Files/interfaces:** 使用 T01 `meeting-event.ts` 的 MeetingEnvelope、T02 `meeting-repository.ts`/`meeting-writer.worker.ts`/`routes/meetings.ts` 的 `commitEvents` 與 CommitReceipt。meeting metadata 加 A1 `CaptionTask`，segment revision 保存 rawText/text/provenance。

- [ ] 先驗 T02 SQLite runtime／worker 打包，再建立交易／revision／重送失敗測試；不選未驗證發行 runtime 的 binding。
- [ ] 執行 T01/T02，確保事件由 normalized handler 送保存，不從可能已淘汰的畫面反推全文。ACK 僅代表 transaction 成功，單 writer lease 防止多分頁搶寫。
- [ ] 注入 commit 前／後 crash、ACK 遺失與重複 eventId；逐一比對所有已 ACK 事件重啟後仍在，event payload 與投影同交易。
- [ ] 把 worker build 納入 `scripts/service-build.mjs` 及 `services/online/build-bundle.mjs` 的實際發布布局；在不同 cwd、更新 build、service restart 測資料根目錄不變、沒有新增 listener。

### B2：自動保存、恢復與結案核對

**Files/interfaces:** 使用 T03 `meeting-outbox.ts`/`meeting-archive-client.ts`/`PersistenceStatus.tsx` 的 enqueue/flushPending；沿用 IDB 暫存及本機 receipt 契約。

- [ ] 執行 T03 的 finalized 自動保存、partial checkpoint、outbox 冪等重送、quota／disk-full／服務重啟測試。檢查舊 retention disabled 初始化不會清除新 archive。
- [ ] Stop 先停止收音與 flush 最後回合，再背景 flush outbox；UI 區分「收音已停止，仍有待存內容」與「已結案保存」。超過期限顯示待處理，不把視窗關閉當保存成功。
- [ ] 結案 manifest 記錄 meetingId、最後事件序號／revision、final 段數、pending 數、已知 gaps／unfinished turns；pending=0 且投影一致才標示已保存。沒有事件不能被解讀成該段音訊必然沒有說話。
- [ ] 以跨過 20,000 段淘汰門檻的確定性事件測試 DB 全量仍在；另做 Chrome crash/reload、重開未結案會議、新會議不覆蓋、多分頁第二 writer 拒絕。

### B3：原稿、人工校訂與完整匯出

**Files/interfaces:** 使用 T04 `meeting-export.ts`；新增 `TranscriptEditor.tsx` 及測試，對單段提交帶 baseRevision 的人工修訂，保存 editor/source/time，不覆寫 raw transcript。

- [ ] 寫測試：原稿不變、修訂 revision 遞增、stale baseRevision 拒絕並提示重載、修改不同段不互相覆寫。人工校訂先只改文字，不提前實作自動語者。
- [ ] 完整匯出從 DB 的同一已提交 revision/snapshot 讀取，提供原始轉寫版與校訂版 TXT/JSON/SRT；每份 export metadata 記錄版本、涵蓋範圍、時碼精度與缺口。
- [ ] 依 T04 每 30 秒及 Stop 背景刷新衍生 TXT/JSON、原子替換；磁碟滿保留前份完整檔案，畫面顯示尚未更新。LOG 不含憑證與全文，正式逐字稿和診斷 log 分開。
- [ ] 在隔離測試程序不注入雲端 key 並禁止非 loopback 流量，驗證本機保存／校訂／匯出仍可運作；不刪除使用者憑證或修改既有設定。比對 DB、原始版、校訂版及結案 manifest。這不代表沒有 key 還能使用雲端辨識。

### B4：首版聯合驗收與備份恢復

- [ ] 執行 T10 保存矩陣及 T11 發行／migration／backup：服務更新不得覆寫會議資料；migration 前一致性備份，舊 binary 不支援新 schema 時拒寫；從備份實際還原並核對事件。
- [ ] 以 A7 真實混語音訊走「字幕 → durable ACK → Stop → service/browser restart → 開啟逐字稿 → 校訂 → 完整匯出」，逐段與人工 reference 比較；列出漏辨、錯辨與資料保存問題，不能互相抵銷。
- [ ] 聯合門檻：A 的固定辨識門檻通過、已 ACK 事件恢復率 100%、正常結案 pending=0、export/DB 一致、已知缺口／unfinished 明示、原稿可追溯。任何一項未過，首版保持未驗收。
- [ ] 恢復日常 managed service，核對 status 的 instance/build/url 及基本健康；實際啟停只在已開始施工時執行。本輪規劃不執行。

## 後續交接：首版 A＋B 之後

1. 首版：A 與上節 B 必須聯合通過；不能交付 A 後把逐字稿保存退回待辦。
2. C：先來源標示／人工語者；音訊使用政策及評測通過後才做延後自動語者。沒有姓名依據不生成姓名。
3. D：先決定本機模型或獲允許的雲端文字處理，再做帶原句引用的決議／待辦；不等待完美自動語者，但責任人未知要明示。
4. E：在 D 的可追溯項目上做議題重開、矛盾／修訂與整場結案；不能只把最後幾分鐘送模型。
5. F：另解 Offline 已知缺陷及 L2 音訊缺口，分別驗收，不以「規劃中」呈現可用功能。

## 本輪規劃自查

- [x] 混語保真、purpose 分離、協定／模型 gate 對應 A0–A3。
- [x] token／恢復與避免假備援對應 A4；最小 UI 對應 A5。
- [x] 歷史／匯出限制與舊設定相容對應 A1/A6；完整保存 B1–B4 為首版必要部分。
- [x] 語者、點列摘要、脈絡、離線與音訊缺口均列於藍圖，有相依與驗收門檻。
- [x] 不額外開服務、不進行付費測試、不改產品程式；以上 A0–A7／B1–B4 工作項目尚未執行。

本清單是實作順序，不是完成紀錄；模型及 transport 只有 A0 通過後才可成為確定選型。
