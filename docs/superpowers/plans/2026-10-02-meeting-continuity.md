# 會議翻譯接續與 LOCAL 自動保存 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 逐項執行；需要分派時另依當時授權使用 superpowers:subagent-driven-development。以 `- [ ]` 追蹤，未驗收不得打勾。

**Goal:** 不換翻譯主體，修正重連／切換造成的中斷，讓 LOG 與會議文字自動可靠保存於本機，並明確保全／揭露音訊缺口。

**Architecture:** 沿用 provider 與 normalized events。新增小型會議恢復控制、本機 outbox＋SQLite writer、PCM 有界緩衝；字幕不等待保存或補錄。會議 ID 不跟 provider 更換。

**Tech Stack:** 現有 TypeScript／React／Zustand／Fastify／Vitest／Chrome Playwright；SQLite binding 經 T02 發行 runtime 驗證後鎖定。

**Spec:** [方案藍圖](../specs/2026-10-02-meeting-continuity-design.md)，先讀再執行。

## 已啟動任務與最新順序（2026-10-02）

### R1–R5 工程收斂複核（原生音訊驗收重新開啟）

前輪 mock 驗收未覆蓋真正 AudioContext／AudioWorklet。追加必要收工項目：

- [x] 正式 bundle＋Chrome 原生 PCM：正常送音、斷線重連後繼續送音、Stop 後零送音。
- [x] Worklet HTTP 載入失敗自動復原、拒絕快取失效、等待有界、Stop 取消且不傷其他使用者。
- [x] AudioContext resume 失敗不能假裝成功；共享／私有 context 的實際呼叫端接回取消與清理。
- [x] 非 16 kHz 音訊宣告真實採樣率，舊 worklet 回呼不能送進新連線。
- [x] Worklet 載入延遲 6.5 秒後，不按 Retry 即自動恢復，仍只擷取一次音源。
- [x] 543 單元／回歸＋26 Chrome＋6 正式建置原生音訊案例；修正版逐檔雜湊對照已測 bundle。
- [x] R2 原生 WebRTC：候選必須 DC open＋session.created 才接管；無 ACK 即關閉不能取代健康舊線；active DC 單獨關閉自動續期，原生 PCM／RTP 證據通過。
- [ ] R5 真實時間 LOCAL soak：正式 bundle／Chrome 原生音訊連續 60 分鐘，兩路使用本機 endpoint；OpenAI 跨 25／50 分鐘正常續期、Gemini 每 9 分鐘 GoAway，持久保存測量與 Stop 清理證據。不得以 2 小時 fake clock 代替。
- [ ] 核對使用者實際部署版本／啟動路徑；真實雲端驗證仍依 V1 預算規則，不混作已完成。

使用者追加 clean code／SOLID／不留下技術債要求。本輪重新讀取現態、重現並修復
deadline、ownership、取消與回呼競態缺口；以下項目已以目前工作樹重新驗證。
不擴充地端支線，也不以泛用框架或單純移動程式碼代替行為修復。

- [x] R1／R2：immutable recovery attempt 統一整次 12 秒 deadline、generation、取消；
      排除使用者權限等待，防止 Stop→Start 晚到結果使用新一代 signal。
- [x] R1：health callback 同步 Stop 後不再建立 socket／timer／capture；429 Retry-After 貫穿服務端與 client；
      close 診斷不洩漏 raw reason，預熱取消後晚到 token 不回填。
- [x] R2：WebRTC 未採用候選的 session.closed／error 不能丟失或替換健康主線。
- [x] R3：App 恢復預算、idle 重試及取消由單一可測試排程物件管理；
      到期重讀目前狀態，避免 stale timer；UI 不直接持有各種 backoff 計數器。
- [x] R4：capture lease 重複 acquire／release 冪等；健康監聽依 owner 而非 callback identity；
      pending 權限失敗通知每個 owner，初始化失敗不漏 stream，unmount 不接受晚到 health。
- [x] R4：backend availability polling 有期限／取消；provider hook 共用明確生命週期工具，
      不把雙份 catch／timer／error state 寫法變成新的維護負擔。
- [x] R5：本輪回歸、Chrome 故障矩陣、build／typecheck／lint、fresh review 與文件逐項對照；
      真服務未測仍留 V1，沒有以測試替身通過宣稱零漏訊。

使用者已要求「先完成整體修復，完善藍圖，訂成任務；地端處理列後」。
本計畫正式進入執行，以下排序取代原先先做 LOCAL 後端的順序。
地端 LOG／TEXT 自動保存需求仍保留，並非取消或改為人工匯出；此輪先完成線上恢復修復，
再做地端保存、ASR／MT 與補錄。`C:\Develop\audiomodel` 持續唯讀。

| 任務 | 範圍與完成證據                                                                                                     | 狀態                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| R1   | Gemini：setup 前禁止送音、GoAway 預準備、token／握手／關線有界、Stop 可取消、控制訊息不掩蓋停字；provider 回歸測試 | 本機驗收通過                                                                  |
| R2   | OpenAI：健康主線不被候選失敗停掉、初次等待 ready、mint／SDP 可取消與逾時、單次 ICE 故障自行恢復；provider 回歸測試 | 本機驗收通過                                                                  |
| R3   | App：給同模型恢復完整嘗試時間，再有界跨模型接管；兩端失敗自動重試、Stop 取消；Chrome 故障注入驗證                  | 本機驗收通過                                                                  |
| R4   | Retry 保留同場 ID／歷史、音源交接健康監聽、拒絕 ended track、依故障來源清除過期錯誤；單元與 Chrome 驗證            | 本機驗收通過                                                                  |
| R5   | 整合檢查、有效譯文恢復與缺口證據、免費長測、建置／型別／相關回歸、最終 diff 審查；更新所有完成與未驗證項目         | 短程本機驗收通過；真實時間 LOCAL soak 遭系統睡眠中斷，待重新驗收；V1／L2 另列 |
| L1   | T02–T04：地端 LOG／TEXT 自動分會議保存、失敗可見、重啟恢復、匯出                                                   | 後排，必要需求未完成                                                          |
| L2   | T07 會議級 PCM／缺口帳與 T09 地端補錄、ASR／MT 能力評估                                                            | 後排，不宣稱不漏訊                                                            |
| V1   | T08／T10／T11 中需真實服務的驗證與實際發行版會議觀測                                                               | 待預算核准；不啟動固定六小時付費測試                                          |

R1–R5 本機驗收證據見 [修復紀錄](../../MEETING_CONTINUITY_REPAIR_2026-10-02.md)：543 個 web／contracts、90 個 online 服務單元／回歸案例、26 個受控 Chrome 案例、6 個原生音訊案例、2 小時邏輯時間與24次換線、建置及靜態檢查。這不是 T00–T11 全部完成；真實服務、發行版、保存與缺口仍依 V1／L1／L2 追蹤。

整合審查追加必要案例：系統音源在跨模型啟動失敗後仍由「會議恢復意圖」保留，
自動重試不得再次要求使用者分享；Stop／Pause／真正音源 ended 必須釋放。
僅 provider 間 2 秒 handoff lease 不足以涵蓋兩家服務失敗的恢復等待。
以系統音源雙端故障後復原的 Chrome acquisition count、Stop active track count 驗證。
先採沿用 provider 自救＋App 接管協調的最小修復；下方 T05 新 reducer／RecoverySignal
屬原提案，只有現有介面不能正確表達角色與故障時才新增，不能為符合文件而重寫。
同理 T01 全套保存 envelope 隨 L1 交付，不阻擋先修 Retry 歷史保護。
連線 ready 僅代表傳輸恢復，首有效譯文與內容缺口必須另外驗證。
沒有真實長會議證據時，只能交付「本機受控驗證通過的修復」，不可宣稱雲端不會斷線、零漏字或已完美收工。

## Global Constraints

- 保持 `gemini-3.5-live-translate-preview`／`gpt-realtime-translate` 專用翻譯主體。
- LOG、原文、譯文預設自動本機保存；此為使用者明示要求，取代舊 opt-in 策略。
- 即時字幕不等待磁碟、補錄、匯出或摘要；失敗仍須立即可見。
- Online／Offline 隔離不變；無 KEY、外網斷線時本機保存仍可運作。
- 暫不增加摘要、互動助理、雲端備份、全程錄音、Electron 遷移。
- 不以文字相同判斷重複事件；不以 connected／字數取代內容恢復證據。
- Windows shell 依 AGENTS.md 循序執行；Python 只用 `C:\Programs\miniforge3\envs\deve\python.exe`。
- 工作區已有大量修改；T00 固定現態後，每項只變更自己的檔案，不覆寫使用者既有修改。

## 交付與依賴

以下保留完整需求分解；實際排程依上方 R1–R5 → L1／L2，付費 V1 另依核准預算。
先落地 T00 必要基準、T01 歷史保護、T05／T06 恢復及 T07 音源所有權，再整合驗收。
setup gate 修正可先消除協定違規，但未完成 T07 音訊保全前不能當成無缺口接續交付。

| ID  | 優先度／責任       | 依賴                                 | 可獨立驗收的交付                           |
| --- | ------------------ | ------------------------------------ | ------------------------------------------ |
| T00 | P0／診斷與基準     | 無                                   | 可重現版本、完整量測、乾淨 runner 退出     |
| T01 | P0／會議契約       | T00                                  | Retry／切換保留會議與事件身分              |
| T02 | P0／LOCAL 後端     | T01                                  | 分會議交易保存與提交確認                   |
| T03 | P0／LOCAL 前端     | T02                                  | 自動待寫／重送／啟動恢復及明確保存狀態     |
| T04 | P0／LOCAL 維護     | T03                                  | 自動 LOG、TXT／JSON、副本與升級遷移        |
| T05 | P0／恢復協調       | T01                                  | 主線／候選失敗分離，不再誤停主線           |
| T06 | P0／provider       | T05、T07                             | Gemini／OpenAI 有界且可取消的自救          |
| T07 | P0／收音保全       | T01                                  | 共用 PCM buffer、音源交接與缺口帳          |
| T08 | P1／換線最佳化     | T00、T06、T07                        | 經真 API 證實的 GoAway／ICE 續接策略       |
| T09 | P1／LOCAL 補錄     | T03、T07、能力實測                   | 缺口辨識與歷史合併；無可用能力則明確不通過 |
| T10 | 發行門檻／整合驗收 | T04、T06、T07、T08；完整接續另需 T09 | 長會議、斷網、崩潰、效能與語意驗收         |
| T11 | 發行門檻／交付     | T10                                  | 同一套修正在實際發行版成立、可回復         |

所有數值均以藍圖第 6 節為起始目標；不得在看到失敗後任意放寬。
需要修訂目標時，先記錄測量、產品取捨與未達成部分，不能靜默改驗收。

## 共用預定介面

下列是待新增的介面，不表示現態已有。T01 在 `packages/contracts/src/meeting-event.ts`
建立 MeetingEnvelope、CommitReceipt、GapRecord；T05 在 `recovery-event.ts` 建立
ConnectionRole 與 RecoverySignal。皆以 zod 建立 runtime schema，保留現有
TranscriptEvent／TranslationEvent 相容性。

```ts
type MeetingEnvelope<T> = {
  schemaVersion: 1;
  meetingId: string;
  eventId: string;
  writerId: string;
  connectionId: string | null;
  observedAt: string; // UTC，跨程序對照
  monotonicMs: number; // 同一 writer 的耗時
  revision: number;
  payload: T;
};
type CommitReceipt = { meetingId: string; committedEventIds: string[]; committedAt: string };
type ConnectionRole = 'active' | 'candidate' | 'retired';
type RecoverySignal = {
  meetingId: string;
  connectionId: string;
  provider: 'gemini' | 'openai';
  role: ConnectionRole;
  phase: 'preparing' | 'connecting' | 'ready' | 'captioning' | 'failed' | 'closed';
  reason:
    | 'rotation'
    | 'network'
    | 'timeout'
    | 'auth'
    | 'quota'
    | 'resume_rejected'
    | 'stalled'
    | 'user';
};
type GapRecord = {
  gapId: string;
  meetingId: string;
  trackId: string;
  captureEpoch: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  state: 'pending' | 'repairing' | 'repaired' | 'unrecoverable';
  cause: string;
  alignment: 'exact_capture_range' | 'estimated';
};
```

診斷事件使用白名單 payload，不接受任意 request／Error 物件序列化。
HealthEvent 繼續供 UI 使用，新增 RecoverySignal 供決策；不能靠 message 字串解析政策。
eventId 一旦入 outbox 即不可變；重送不產生新 ID。writerId 與連線 ID 不可互換。

## T00 — 固定基準與可信量測

**檔案**：新增 `tests/integration/meeting-continuity-runner.ts`、`tests/fixtures/meeting-continuity/manifest.json`；
修改 `tests/e2e/playwright.config.ts` 的測試 server 管理（僅必要範圍）。
參考 `.cache/reliability-2026-10-02/`，不把臨時診斷斷言直接當正式修正驗收。

- [ ] 記 git HEAD、dirty diff／必要 untracked 檔的雜湊、runtime、瀏覽器、應用 build ID、音源與模型 ID；不含 KEY。
- [ ] 將合成語料改為帶編號片段，含日期、金額、否定句與刻意重複；manifest 記片段起訖及標準原文／關鍵語意。
- [ ] 提前完成 T09 local STT／MT 的能力資格評估；記目前模型與硬體是否可用，避免將關鍵未知留到末階段。
- [ ] 量測 close() 呼叫時間／發起者、CloseEvent、mint／setup／first audio／第一個有效譯文、控制與內容訊息分開計數。
- [ ] 同時記錄 Gemini 與 OpenAI 的 normalized 輸出及測試用譯文；pageerror／provider error 實際接上收集器。
- [ ] runner 以明確 process handle 管 server；成功／失敗皆關閉本次所建資源，不能靠強制退出掩蓋卡住。
- [ ] 保存基準案例與報告，驗證輸出可回算耗時與語意結果。確定 5 次連續啟動／退出無殘留 listener 或程序。

驗收示例：注入已知 `pageerror`，輸出必有一筆；兩句字數相同但 eventId 不同，進度必增加；
停止輸出但持續控制訊息，報告不得標示仍在翻譯。保留目前單次 GoAway 作歷史證據，不重寫。

## T01 — 會議身分、事件契約與歷史保護

**檔案**：新增 `packages/contracts/src/meeting-event.ts`、`meeting-event.test.ts`；
修改 contracts `index.ts`、`apps/web/src/App.tsx`、`store/caption-store.ts`、
`providers/coalesce-handlers.ts`；測試 `caption-store.test.ts`、`tests/e2e/online-keepalive.spec.ts`。

**介面**：產生上列 MeetingEnvelope；以明確 `newMeeting()`／`continueMeeting(meetingId)` 行為
替代 `startRealCore(false)` 的隱含清除決策。不得為每次重連呼叫 beginSession。

- [ ] 加入目前會失敗的測試：兩家都失敗→Retry→新字幕，meetingId 與舊段完整保留。
- [ ] 加入新會議與繼續會議測試；輸入舊 generation 晚到字幕不能變成新會議 live。
- [ ] 實作契約與最小入口修正；Gemini／OpenAI 使用同一個「繼續此會議」入口。
- [ ] 從 normalized handler 取得保存資料，避免只掃有界 UI store，先預留 T03 的非阻塞訂閱。
- [ ] 跑測試與 Chrome 真操作；檢查 final diff，只提交此任務變更（待既有工作隔離完成）。

```ts
// E2E 的必要斷言；測試 fixture 提供 before/after 的實際 store 快照。
expect(after.sessionId).toBe(before.sessionId);
expect(after.segments.map((s) => s.segmentId)).toEqual(expect.arrayContaining(oldIds));
```

## T02 — LOCAL 交易儲存與 API

**檔案**：新增 `services/online/src/storage/meeting-repository.ts`、`meeting-writer.worker.ts`、
`meeting-repository.test.ts`、`routes/meetings.ts`、`routes/meetings.test.ts`；
修改 `server.ts`、`config.ts`、`build-bundle.mjs` 與必要 package/runtime 設定。

**介面**：`commitEvents(events: MeetingEnvelope<unknown>[]): Promise<CommitReceipt>`；
`GET /meetings`、`GET /meetings/:id`、`POST /meetings/:id/events`。
每批最多 100 事件／256 KiB；重複 eventId 必須回傳同等確認，不二次修改投影。

- [ ] 在實際 runtime 實驗 SQLite binding、worker 打包、DELETE／FULL 設定讀回；記錄 Node／SQLite 實際版本與修補狀態。
      目前本機 probe 已通過，不代表發行環境通過；初版不開 WAL，不提升整個專案 Node 下限來隱藏相容問題。
- [ ] 現有單檔 CJS bundle 不會自動帶入 worker：新增獨立 `dist/meeting-writer.worker.cjs` 建置產物，
      server bundled 路徑用 `__dirname` 定位；source-run 以對應開發入口；release manifest 必含兩個產物。
      在解壓縮後、不同 cwd 啟動測試。writer 異常退出使 pending requests 失敗且保留 outbox，
      檢查 DB 後限速重開，不同時啟動第二個 writer；corruption 進明確錯誤狀態而非清庫。
- [ ] 先寫交易測試：重送、舊 revision、部分批次失敗、db lock、磁碟滿、writer 異常退出。
- [ ] 建 `meetings`、`events`、`segment_revisions`、`gaps` 表；events 以 eventId 唯一，payload schema validated；事件與投影同一交易。
- [ ] 本機路由驗來源、授權、writer lease、UUID、body size；第二個 active writer 回 409。
      `/local/bootstrap` 僅接受 loopback 及明列可信 Origin／Host，取得本次程序的隨機本機授權；
      archive GET／POST 均驗授權，不能只有寫入受保護。dev 與 release origin 分別列白名單。
      writer lease 與事件 writerId 分離：重啟後重新取得租約，舊已提交 eventId 可冪等確認；
      無租約不得新增文字。第二分頁不得自動接管；服務重啟也需重新建立唯一 owner。
      保存路由不接受外部遠端連線，無 KEY 仍可使用，不記 request body。
- [ ] worker commit 成功才 ACK；寫入錯誤回結構化錯誤；app logger 不吞保存失敗。
- [ ] 子程序提交後被強制停止，再開 DB 比對全部 ACK eventId；提交前中止只允許該交易全有或全無。
- [ ] 本機資料目錄、schema migration／backup／rollback 測試與文件一併交付。

```ts
await repo.commitEvents([event]);
await repo.commitEvents([event]); // 同一 eventId
expect(await repo.countEvent(event.eventId)).toBe(1);
// 故障注入必須拒絕 promise；不能只 console.warn。
await expect(fullDiskRepo.commitEvents([nextEvent])).rejects.toThrow();
```

## T03 — 自動保存、outbox 與重啟恢復

**檔案**：新增 `apps/web/src/store/meeting-outbox.ts`、`meeting-outbox.test.ts`、
`meeting-archive-client.ts`、`components/PersistenceStatus.tsx`；
修改 `caption-persistence.ts`、`idb-persistence.ts`、`caption-store.ts`、`App.tsx`、
`settings/settings-store.ts`；新增 `tests/e2e/meeting-persistence.spec.ts`。

**介面**：`enqueue(envelope): void` 不等待磁碟；保存狀態由獨立訂閱回報。
`flushPending(): Promise<CommitReceipt[]>` 在非 caption hot path 使用；
只憑 receipt 清除 outbox，同一 writer 在 reload 後延用持久 ID。

- [ ] 寫失敗測試：browser crash／服務不可用／ACK 遺失重送／IDB quota／晚到舊 revision。
- [ ] finalized 事件立即背景排程、partial 每 500 ms 最新修訂 checkpoint；Stop 立即排最後狀態。
      未提交標記始終可見，不把非同步 checkpoint 當零損失保證。
- [ ] 每 250 ms 或達 100 筆送批次；5 秒請求期限；重試採 1/2/4/8/15 秒上限且可取消。
      記憶體待寫上限 16 MiB，先卸入 IDB；超界又無法保存時記明確未保存區間，不靜默丟棄。
- [ ] 預設本機自動保存；移除舊 disabled 初始化會 purge archive 的行為；legacy 匯入先提交再標記。
- [ ] 啟動列出未結束會議與繼續入口；載入完整 archive 分頁，UI 仍有界；匯出不能只讀 UI 尾段。
- [ ] UI 顯示本機已保存時間、待存／失敗與自動重試；error 清除以該次保存成功為準。
- [ ] Chrome 非優雅終止後重啟驗證已 ACK／IDB 已 commit 部分；未提交尾端量測揭露。

```ts
// 服務已 commit 但 ACK 遺失：outbox 重送後只存在一份資料。
expect(reloadedArchive.eventIds.filter((id) => id === eventId)).toHaveLength(1);
expect(status.pendingCount).toBe(0); // 必須在收到 receipt 後才成立
```

## T04 — LOG／TEXT 全自動本機維護

**檔案**：新增 `services/online/src/storage/diagnostic-log.ts`、`meeting-export.ts` 與同名 tests；
新增 `apps/web/src/providers/connection-diagnostics.ts`；修改 `server.ts` logger、
`apps/web/src/export/formatters.ts`、`scripts/release-templates/start.bat`／`start.sh`／`README.md`。

**介面**：診斷事件包含 meetingId、connectionId、role、phase、reasonCode、時間、frame 計數；
一般 process LOG 可無 meetingId。TXT／JSON 為 DB 衍生結果，不回寫變更 DB。

- [ ] 先測憑證／URL／原文不進診斷 LOG；為每一個 provider close、retry、handoff、storage failure 注入樣本。
- [ ] server 自動建立資料目錄與 process LOG；browser 診斷進 outbox，無內容敏感欄位。
- [ ] 事件轉折立即保存；frame 統計每秒聚合，不能每 32 ms 寫檔；輪替依 30 天／512 MiB 上限。
- [ ] 每 30 秒及 Stop 背景刷新 TXT／JSON；原子替換，磁碟滿保留舊完整副本；恢復後自動再產生。
- [ ] 新會議、更新 release、改 cwd 不改資料根目錄。會議內容不自動刪除；顯示容量與備份位置。
- [ ] 讀寫所有路徑都限資料根目錄，測路徑穿越與 LAN 拒絕；LOCAL 路徑整套測試攔截非 loopback 流量並要求為 0。
- [ ] 更新 `CLAUDE.md`／`docs/DECISIONS.md`，正式記錄使用者指定的新保存政策；保留舊 ADR 歷史。

驗收：移除所有雲端 KEY、阻擋外網，注入 normalized 測試文字；DB、LOG、TXT／JSON
仍自動產生且 reload 可讀。這只驗證本機保存，不聲稱無 KEY 能進行雲端翻譯。

## T05 — 恢復控制與候選所有權

**檔案**：新增 `apps/web/src/providers/recovery-controller.ts`、`recovery-controller.test.ts`、
`packages/contracts/src/recovery-event.ts`；修改 `App.tsx`、`providers/types.ts`、
`use-gemini-live.ts`、`use-openai-realtime.ts`；測試 `tests/e2e/online-keepalive.spec.ts`。

**介面**：`reduceRecovery(state, signal): { state, effects }` 使用 RecoverySignal，
effects 限 `startCandidate`／`activateCandidate`／`cancelCandidate`／`retryPrimary`／`stopAll`。
副作用有 generation guard；每個候選只有一個 owner，沒有多個 effect 各自重連。

- [ ] 寫測試：健康主線＋candidate failed → effects 不得有 stop／activate；2 秒提示不取消 handshake。
- [ ] 移除 App 以籠統 failed 自動 stop 的決策，改由 controller 依 role、原因與政策下令。
- [ ] 實作同時成功競態、原模型先恢復取消備援、候選先 ready 交接、候選失敗保持原路復原。
- [ ] 將舊 provider 自動 retry timer 納入唯一排程所有權；controller 下令一次 attempt，
      provider 管該次握手與取消，不再與 App effect 各自排第二條恢復鏈。
- [ ] 使用藍圖候選數值；錯誤連續失敗持續有界重試，不靠無 timer 的 cooldown 等 effect 重跑。
- [ ] transport ready 只宣告連線完成；有效新譯文才清該 connection 的翻譯錯誤。
      無音／目標語言無輸出不觸發盲目切換；兩家皆停仍保留 Continue 入口。
- [ ] 確認 Stop／新會議取消所有 timer、候選與晚到 callback；Chrome 測試前後 meetingId 一致。

```ts
const r = reduceRecovery(healthyPrimaryState, failedCandidateSignal);
expect(r.effects.some((e) => e.type === 'activateCandidate' || e.type === 'stopAll')).toBe(false);
expect(r.state.activeConnectionId).toBe(healthyPrimaryState.activeConnectionId);
```

## T06 — Provider 自救、期限與錯誤分類

**檔案**：修改 `gemini-live-provider.ts`、`openai-realtime-provider.ts`、`openai-ws-transport.ts`
與同名 tests，及 session／gemini 路由必要錯誤契約；沿用 T05 controller。

- [ ] 將現有診斷改為期望正確行為測試：setup 前 audio=0、候選失敗主線仍出字、Stop 中止 pending fetch。
- [ ] Gemini 每一代連線有 setupReady；OPEN 不足以送音，pending PCM 交 T07；總 12 秒預算涵蓋 mint＋WS setup。
- [ ] GoAway 不立即無準備關線；先保存 timeLeft／最新 resume 狀態，準備憑證；未驗證雙線前依 T08 實驗決定切點。
- [ ] browser mint／SDP 都接 AbortSignal；逾時、Stop、被新 generation 取代時中止；晚到結果不能採用。
- [ ] close 等待上限初始 1 秒；超時隔離舊線再重試，記 close-wait-timeout，不讓 onclose 成唯一進度來源。
- [ ] 分類 auth／quota／network／resume rejected；429 尊重 Retry-After；resume 真正拒絕才走新 session，保留缺口。
- [ ] OpenAI candidate 失敗只報 candidate 狀態；冷啟動等 media transport ready；ICE restart 需協商可行性驗證，否則走有界整線續期。
- [ ] 修改 createLocalOffer 的候選 track 掛載方式：候選預設不送真實音訊，採用時才替換 sender track；
      不停用共用原 track。以兩條 peer 的音訊統計確認非採用候選沒有偷送音，並真 API 驗握手相容性。
- [ ] watchdog 改用獨立進度，不讓控制訊息掩蓋有聲無內容；以靜音、目標語言、背景分頁案例防誤判。
- [ ] 相關 unit／App 故障矩陣通過，與 T07 合併驗 setup 等待期間音訊被保全再交付。

驗收：fake clock 60 秒未完成的 mint／SDP 必已被期限中止；一個 disconnected event
即可自行推進恢復，不需要測試手動再注入三次 statechange 來假造梯度。

## T07 — 音源交接與 PCM 保全

**檔案**：修改 `capture-lease.ts`／tests、`audio-engine.ts`、`apps/web/public/pcm-worklet.js`；
新增 `providers/meeting-audio-buffer.ts`／tests、`store/meeting-gap-store.ts`／tests。

**介面**：`appendFrame(trackId, epoch, startSample, pcm): void`；
`readRange(trackId, epoch, startSample, endSample): AudioRangeResult` 回明確缺失範圍，
不能以空陣列假裝成功。GapRecord 使用 T01 契約並交 T03 保存。

- [ ] 測兩次 acquire 後 track ended 只通知現有 owner；ended track 不得重用為 connected。
- [ ] 把 health listener 訂閱交接與 track live 驗證補齊；同音源切模型不重新叫分享對話框。
- [ ] 建獨立 PCM tap，WebRTC 繼續原生 media track；重用共享 AudioContext，拒絕重複開裝置。
- [ ] 120 秒／軌 ring，以 sample index 索引；測 wrap、雙軌、超限、capture restart epoch、Stop 釋放。
- [ ] 補錄排程先取得有界快照／pin；原始 PCM 總額 16 MiB 包含快照與傳送副本。
      測慢補錄＋ring wrap 不讀到其他時間音訊；超限產生缺口，不能增加無界 pinned queue。
- [ ] 以 640 ms 已知 frames 注入斷線；重連後驗證被送出／補錄排程／缺口列記之一，不能消失。
- [ ] 把音訊 captured、send-attempted、buffered、expired 與內容 received 分開統計；不宣稱 WebRTC send ACK。
      同一 sample 可先 buffered 再 send，不可將兩者累計值相加冒充完整度；以 sample 區間聯集核對覆蓋。
- [ ] 長於 120 秒故障明確列超限範圍；使用者停止共享是未捕獲，不誤報可補回。

```ts
expect(accountedSampleCount).toBe(capturedSampleCount);
expect(unexplainedSampleCount).toBe(0);
// 不可把這兩個斷言解讀成 ASR／翻譯正確率 100%。
```

## T08 — 真 API 單因素實驗與正常換線

**檔案**：擴充 T00 runner、`tests/integration/meeting-continuity-runner.ts`；
更新 Gemini／OpenAI provider 僅限實驗支持的換線策略。

- [ ] 固定語料、音量、網路，依序比較 baseline、僅取消 2 秒接管、僅修 setup gate、兩者皆修；保存每輪完整事件。
- [ ] 各條件先以 LOCAL transport 模擬至少 3 次受控 reconnect；付費前列出仍無法證明的單一假設。
- [ ] 新真 API 測試須先取得明確預算；在核准預算內驗自然 GoAway 的 timeLeft、handle、續接及首有效譯文，觀測不足明列限制，不自動延長。
- [ ] 小範圍驗 Gemini 同 handle 候選並存是否被支援；被拒即選「預準備＋切點＋buffer」，不繼續假定雙線。
- [ ] 驗 OpenAI 一次真 disconnected 的協商／整線恢復；候選失敗不停止原 peer。
- [ ] 把結果與所選策略、有限樣本限制寫入診斷附錄及 DECISIONS；不為追求零空窗改用互動模型。

完成條件：能用資料分離「接管政策」「setup gate」「供應商回應」影響；
若真 API 無法隔離某項原因，明列待證，不能宣稱該根因已定案。

## T09 — LOCAL 缺口補錄與歷史合併

**檔案**：新增 `apps/web/src/providers/gap-repair.ts`／tests；
修改 `services/offline/app/main.py` 僅當現有離線辨識可支援明確歷史片段 API；
新增對應 offline tests；修改 `caption-store.ts`、`export/formatters.ts` 與 gap UI。

**介面**：輸入 PCM 範圍＋GapRecord，輸出帶來源區間與 lineage 的 normalized events；
補錄不呼叫 live caption 的切換流程，不自動使用新雲端 API。

- [ ] 先在現有硬體驗證 local STT／MT 品質、冷啟動、吞吐、記憶體；不預先安裝大型模型或開發新離線架構。
- [ ] 不達品質／資源門檻時交付具體能力缺口，不把 fallback／佔位結果標為補錄完成。
- [ ] 寫 merge 測試：相同句子不同時間保留兩份；重疊補錄 revision 不重複；新 live 不被歷史補回覆蓋。
- [ ] 工作量上限為仍保留音訊範圍、並行度 1；即時任務資源受壓時暫停補錄，Stop 取消。
- [ ] 依原始時間插入歷史；未知供應商精確對齊標 estimated；保存補回來源、版本與失敗原因。
- [ ] 日期／金額／否定句標準語料逐項核對；匯出包含未補回缺口，不能用 AI 臆補。

此工作有明確能力門檻。若 local engine 不可用，T10 可以驗收「保存＋接續改善」版本，
但「完整缺口補錄」仍未完成，不得勾選 T09 或宣稱整場不漏訊。

## T10 — 結果驗收矩陣

**最高放行條件**：依藍圖第 8 節分 LOCAL 長測、小額核准真 API、實際會議觀測，
人工救援 0 次且符合各層的恢復／保存／內容門檻。撤銷固定 6 小時付費測試要求；
未有真實長會議證據時保留未驗證，不用 mock 成功取代真實可靠性結論。

**檔案**：新增 `tests/e2e/meeting-recovery.spec.ts`、`tests/integration/meeting-storage-crash.test.ts`；
擴充 `tests/e2e/caption-longtask.spec.ts`；更新 `docs/TEST_PLAN.md`。

- [ ] 故障矩陣：GoAway、1006、慢 setup、mint／SDP 掛住、429、resume 拒絕、候選失敗、兩家失敗、控制訊息存活無內容。
- [ ] 保存矩陣：斷網、local service restart、browser kill、commit 後 ACK 遺失、quota、磁碟滿、舊版遷移、多分頁。
- [ ] 正反案例：靜音、目標語言、長句未 final、重複句、系統音源 ended；不能測出快速恢復卻增加誤切。
- [ ] LOCAL soak 覆蓋長會議、麥克風與系統音訊；先用模擬 endpoint 阻止任何雲端流量。
- [ ] 真 API 只跑預算核准的必要項目；實際會議沿用原本音訊連線收集證據，不額外送第二份。
- [ ] 報故障到首有效譯文的分布、全部失敗樣本、捕獲缺口、漏句／誤譯、已提交資料復原量；P95 必附樣本數，不以三筆資料推廣。
- [ ] 對照保存／補錄開關的 2,000 段長任務與 heap；測佇列飽和，確認新增工作不堵字幕。
- [ ] 所有已 ACK eventId 在強制關閉後重啟均可找到；TXT／JSON 最終內容與 DB 相符。
- [ ] fresh review 檢查最終 diff、非預期修改、憑證輸出、offline 外網請求；缺陷修正後只重驗受影響範圍。

## T11 — 發行、回復與文件一致性

本機保存服務屬自動恢復範圍：launcher 必須監督本次啟動的服務 PID，
異常退出後限速重開（初始 1/2/4/8/15 秒封頂），已健康則不重啟；
正常 Stop／退出要停止監督，不能把使用者退出當故障重新開啟。
測 worker crash、整個 service crash、連續啟動失敗、使用者正常退出及 outbox 自動重送；
只管理自己建立的程序，不以 process name 終止其他服務，也不安裝 OS 常駐服務。

**檔案**：`scripts/release-templates/*`、`docs/RUNBOOK.md`、`docs/PROJECT_STATE.md`、
`docs/TODO.md`、`docs/DECISIONS.md`、`docs/FAILURE_MODES.md`、`docs/ARCHITECTURE.md`。

- [ ] 實際 Windows release 驗 SQLite worker、data dir、無 KEY 本機保存、更新不覆寫資料；不是只測 pnpm dev。
- [ ] 開始顯示本機保存路徑、build ID 與能力狀態，LOG 自動記錄，無需使用者手動開 DevTools。
- [ ] 先備份 DB（SQLite backup／一致性方式），再 schema migration；舊 binary 不支援新 schema 時拒寫而非覆寫。
- [ ] 回復流程保留資料，以已驗證相容版本重啟；不能回復到「關 retention 就清庫」策略。
- [ ] 移除文件過時「零空窗」「永不放棄但 App 會 stop」保證；將實測能力與未完成 T09 明列。
- [ ] 發行前核對 T10 證據與各項範圍；未達門檻保留未勾選，不以文件產出當成修復完成。

## 執行命令與提交規則

以下是實作時命令，**本次規劃未執行這些功能驗收**。測試檔建立後才使用：

```powershell
pnpm -F @meeting-audio/contracts test
pnpm -F @meeting-audio/web exec vitest run src/store/caption-store.test.ts src/providers/recovery-controller.test.ts
pnpm -F @meeting-audio/online exec vitest run src/storage/meeting-repository.test.ts src/routes/meetings.test.ts
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/meeting-persistence.spec.ts tests/e2e/meeting-recovery.spec.ts --project=chromium
pnpm typecheck
pnpm lint
pnpm test
```

已核對 Playwright 現有 project 名稱為 chromium，但目前未指定 Chrome channel；
T00 要設定 `channel: 'chrome'` 並修妥 server 收尾，再以同名 project 驗證。
Python 測試以指定 runtime 執行 `-m pytest`。
遇不可讀 cache 要收斂 test discovery，不降低斷言或跳過失敗案例。

每項修正循環：建立期望行為測試→確認現態失敗→最小實作→相關測試通過→
受影響整合驗證→檢查 diff 與文件→只對本任務檔案建立獨立變更／提交。
不使用 `git add .` 吞入既有 34 個修改，不為規劃文件自動發布或修改正在使用的 release。

## 最終收工核對（不得以某一小項成功取代）

- [ ] LOCAL 長測、小額核准真 API 與實際會議觀測分別列證據；可恢復故障人工救援 0 次；不以本機模擬冒充真實長會議。
- [ ] 付費 runner 無 opt-in／費用上限時拒絕啟動；測試結束關閉本次的連線、送音、預熱及重試；保留帳務估算與實際用量差異。
- [ ] 主線健康時候選失敗不影響會議；備援健康後不自動來回切模型；兩家失敗仍有自動重試排程。
- [ ] 本機服務異常退出後自動重啟與補存；正常退出不被監督器反覆拉起。

- [ ] T00–T11 的必要步驟全部有證據連結；未完成項保留未勾選。
- [ ] 本機保存、查詢、匯出與恢復不依賴 KEY、外網或 LLM；網路攔截證據為零外部請求。
- [ ] 真實發行版與開發版採同一可靠保存路徑；升級／rollback 不刪會議。
- [ ] 同場會議在 Retry、自然換線、跨模型切換後 ID 與已提交歷史完整保留。
- [ ] Gemini setup gate／告警、OpenAI candidate failure／ICE 進度的原缺陷測試均轉為期望行為通過。
- [ ] 兩家皆失效、停止共享、靜音與磁碟失效都有真實可見狀態，沒有假裝已恢復。
- [ ] 已提交內容在程序崩潰後全部可恢復；待存尾端及 RAM 音訊的限制明確揭露。
- [ ] 長會議與標準語料指出所有已補／未補缺口；日期、金額、否定句另行對照，不只看事件數量。
- [ ] Chrome runner 乾淨退出；沒有本次產生的背景程序、timer、音源或測試 listener 殘留。
- [ ] 最終 diff／範圍／憑證與資料位置審查完成；不改動未授權的既有工作。

本次規劃的本機 probe 已通過，結果見藍圖第 7 節；其餘核對項仍未執行，
不把「藍圖已完成」寫成「產品已完成」或「一定完美」。
