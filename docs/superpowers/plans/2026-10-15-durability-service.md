# 保存與日常服務 Implementation Plan

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐項施工；每項完成直接驗證後才打勾。

**Goal:** 翻譯與純字幕均能可靠保存、故障後接續、還原備份，且服務重啟不讓待存文字失聯。

**Architecture:** 沿用 SQLite worker、IDB outbox、commit receipts 與 writer lease。補齊翻譯接線、origin 所有權、故障狀態、使用者還原與小型 managed supervisor。

**Tech Stack:** 現有 TypeScript／Fastify／SQLite worker／IndexedDB／Node managed scripts／Vitest／Chrome。

**Spec:** [診斷與場域契約](../specs/2026-10-15-meeting-resilience-design.md)。排序對應[主清單 W05–W08](2026-10-15-meeting-hardening-checklist.md)；資料備份還原不是 Gemini 第二金鑰備援，仍屬主線。

**精簡與效能約束：** 遵守[主清單](2026-10-15-meeting-hardening-checklist.md)的「流暢與穩定」「Clean code」條件。下列新增檔名為候選落點；優先沿用既有模組／測試，沒有實際責任或生命週期邊界就不建檔，不預建通用框架。

## Global Constraints

- ACK 只在 DB transaction 完成後發出；未 ACK 事件不可刪除。保存不阻塞字幕。
- 不改資料根目錄、不清使用者資料、不殺陌生程序、不把同磁碟副本宣稱災難復原。
- 每項先重現／紅測、最小修復、直接故障恢復、diff review。既有 worker recovery、atomicity 與全量 export tests 保留。
- 真實磁碟满只使用隔離可限額測試卷／故障注入，禁止填滿使用者系統磁碟。

## D1 — 翻譯與純字幕共用完整會議保存（F07）

**Files:** 修改 `apps/web/src/App.tsx`、`providers/coalesce-handlers.ts`、`store/meeting-archive-client.ts`、`store/meeting-archive.ts`、`components/ExportMenu.tsx`、`settings/settings-store.ts`；沿用 `services/online/src/routes/meetings.ts`／storage；新增 `tests/e2e/translation-archive.spec.ts`。

**Interfaces:** 沿用 `startMeeting/recordTranscript/recordTranslation/finalize/exportMeeting`。前端 normalized event 在 UI 合併／淘汰前投遞；同 meetingId 跨 provider，purpose 切換先結束原 purpose 或以明確會議契約處理，不能偷偷清歷史。

- [ ] 紅測：翻譯兩家各自 final／revision 寫入 archive、partial checkpoint、Retry/接管/Pause/Resume 不新建會議、20,100 段 UI 淘汰後仍全量匯出。
- [ ] 沿用 outbox 投遞，避免在 React rerender 重複註冊或再次保存；所有 revision/eventId 由同一 owner 管理；晚到退役尾文歸原場會議。
- [ ] 翻譯畫面顯示與純字幕一致的保存／待存／缺口狀態，匯出走 durable snapshot，不能只匯 UI tail。
- [ ] 依使用者既有完整地端保存要求執行可見遷移：舊 retention 關閉不 purge 新 archive；既存瀏覽器快照先入庫成功再標已匯入；原有資料保留可核對。
- [ ] Chrome：翻譯→故障接管→Pause/Resume→Stop→renderer 重開→校訂／匯出；對 DB、原稿、譯文、manifest 精確比對 ID/文字/revision。跑 web archive/outbox tests、online meetings/repository tests 與新增 E2E；不重開雲端付費測試。

## D2 — 固定 origin 與既有 outbox 救援（F08）

**Files:** 修改 `scripts/managed-service.mjs`、`scripts/service.mjs`、`scripts/managed-service.test.mjs`、`apps/web/src/store/meeting-outbox.ts`、`meeting-archive-client.ts`；新增 `tests/e2e/origin-recovery.spec.ts`；更新 `docs/RUNBOOK.md`。

**Interfaces（新增 manifest 欄位）:**

```ts
interface OriginBinding {
  version: 1;
  workspaceId: string;
  canonicalOrigin: string; // 固定 127.0.0.1，不與 localhost 混用
  knownPreviousOrigins: string[];
}
type OriginRecoveryState = 'current' | 'old-origin-unreachable' | 'migration-required';
```

knownPreviousOrigins 只列來源，不寫 key／逐字稿。瀏覽器 profile 無法由 server 任意枚舉，不能自動保證跨 profile 救援。

- [ ] **先重現推論**：在隔離 Chrome profile 舊 origin 累積 IDB 已 commit 未 ACK 事件，停止測試服務，占舊埠，再從新埠開；確認 DB 仍有已 ACK、舊 IDB 卻不可見。保存證據後再修。
- [ ] 首次安全分配 port 後保存 canonicalOrigin；後續啟動固定使用。同 port 被外物占用時明確失敗並保留 manifest，不殺外物、不靜默新 origin；更新 existing collision test 區分首次與既有 workspace。
- [ ] 明確變更埠要建立 migration-required 狀態。舊 origin 可回復時，以同 Chrome profile 開舊 origin 的本機救援頁，正常 outbox commit ACK 後才確認搬移；若被占且無法回復，提示待救援未知而非 pending=0。
- [ ] 開啟／送資料至救援 endpoint 前驗證 workspace／instance 身分，舊埠若被外部程式占用不得投遞逐字稿或 outbox。不能僅因 URL 在 knownPreviousOrigins 就信任目前佔用者。
- [ ] 優先以固定 origin＋恢復舊 origin 正常 ACK 重送完成救援；只有實際重現此路徑不足且仍可讀舊頁，才增加受限 outbox 匯出／匯入（schema、checksum、原事件 ID 與去重）。不先建通用資料遷移工具；無法存取舊 origin 就不能宣稱可救。
- [ ] tests：首次 port collision、重啟原埠、localhost alias、舊 manifest 升級、舊 origin 不可用、新／舊事件同 ID、不同 Chrome profile 明示界線。
- [ ] `node --test scripts/managed-service.test.mjs`，再跑新增 origin E2E；核對外物服務仍活、已 ACK／待送全文不跨會議。更新操作文件與相容遷移決策。

## D3 — 儲存故障與可見恢復閉環（F09）

**Files:** 修改 `meeting-outbox.ts`、`meeting-archive-client.ts`、`PureCaptionWorkspace.tsx`／翻譯保存區、`services/online/src/routes/meetings.ts`、`storage/meeting-repository.ts`／worker／export；擴充現有 tests，新增 `tests/e2e/storage-faults.spec.ts`。

**Interfaces:** 保留 `OutboxStatus`，增加可區分層級的狀態：RAM pending、IDB committed、SQLite committed、derived-export stale；`lostCount/unsavedSince/Until` 必須進入結案 manifest，不僅短暫 UI 提示。

- [ ] 枚舉並單獨注入：IDB open blocked／quota、SQLite FULL/IOERR/lock、worker exit/hang、ACK 遺失、HTTP400/413/422、derived export fail；禁止以同一 mock error 覆蓋所有情境。
- [ ] 測 worker 現有 terminate/recreate 不會雙 writer；15 秒 timeout 後由真子程序 exit 再重建。保留既有 cooldown，不額外加第二個並行重啟器。
- [ ] 故障期間字幕維持、未 ACK 保留；原有 16 MiB RAM／240 KiB batch 限制超過時記缺失範圍，恢復後不清除不可恢復標記。
- [ ] 修復後同一會議自動或明確重試可結案；永久拒絕有明確人工重試入口。因 IDB 失效只在 RAM 的內容，關頁前提示未持久保存，crash 後不能宣稱全部恢復。
- [ ] 對每類記錄 fault→UI→queue→repair→DB→export 全文閉環；固定測試輸入至少包含 revisions、重複真發言及 gaps。
- [ ] 跑 `pnpm -F web exec vitest run src/store/meeting-outbox.test.ts src/store/meeting-archive-client.test.ts`、`pnpm -F online exec vitest run src/storage/meeting-repository.test.ts src/routes/meetings.test.ts` 及 storage Chrome 案例；記哪些為真故障、哪些為注入，不擴大結論。

## D4 — 備份、還原與版本遷移（F10）

**LOCAL 收工（2026-10-16）：** W07.1/W07.2 完成（LOCAL），14／26 LOCAL。沿既有 IDB identity 的 retired 前綴保留晚到事件/會議資訊/缺口，明確勾選後才與世代切換同交易移存；失敗完整回滾，不自動併入新 SQLite。重開後可下載 JSONL，下載不刪除保留紀錄。最終 Chrome 15 案、前端 921 項、scoped eslint/web build 通過；涵蓋兩目的正常/回覆遺失/取消/晚到內容、真 IDB 回滾、重新開啟與檔案內容核對。後端 47 項沿用前輪且關鍵來源雜湊一致；20,100 段/譯文/修訂/缺口、壞檔/錯版本/中斷/安全副本與舊 writer 證據見報告。備份下載另 2 案已驗。未新增依賴、資料庫或管理器。真 provider 排空、實體斷電/異碟與場域長測未驗，仍屬後續放行限制；JSONL 是可讀保留紀錄，非自動匯入格式。下一項 W08 服務復原。證據 `.cache/w07-backup-verification.json`。

**Files:** 擴充 `storage/meeting-writer.worker.ts`、`meeting-repository.ts`、`routes/meetings.ts`；UI 接既有本機 API 增加資料維護入口，擴充 storage／routes tests；不另外建立一套產品備份 CLI；更新 RUNBOOK／retention 說明。

**2026-10-16 世代隔離實作決策：** 還原核心只在即將切換的私有副本新增 `archive_state(id=1,generation=UUID)` 並升為 SQLite schema 2；schema 1 正常會議不強制升版，v1 event envelope 不變。每次成功還原換世代，回復安全副本保留原世代。bootstrap 提供世代，寫入比對 `x-meeting-generation`；續期核對既有 lease，避免 worker hang 阻塞續期。上一版實際 writer 已驗拒寫 schema 2。還原 HTTP 已接線：既有本機授權與 lease 保護，handler 執行期間持有寫入計數與還原旗標，避免世代檢查與實際操作之間的競態；finally 釋放操作管制，成功撤銷舊 lease。還原先等待既有衍生匯出完成，完成後重建 dirty 清單。

**瀏覽器接線（部分已驗）：** 既有 IndexedDB v2 保留舊 outbox/metadata/revisions/loss；舊 v1 opener 拒絕開啟，identity 世代在每筆交易中檢查。僅空儲存區能自動綁定新世代，舊待存內容不清除、不改綁，兩種會議目的均顯示唯讀原因並停止重試。912 項前端與兩輪共 13 項 Chrome 回歸通過。舊 caption snapshot 隔離已補：快照保存 archiveGeneration，跨世代不合併，匯入前檢查；無標記歷史快照只接受 schema 1，原快照保留，同世代恢復不受阻。916 項前端與兩個真 Chrome/SQLite 拒寫情境通過。還原 UI 已限定停止會議後操作；client 先保存 metadata/事件/loss，再送還原。成功後 IDB 單一交易檢查 pending=0，清除可重建 metadata/revision 索引，loss 以 retired:舊世代鍵保留，原 store 不改綁，舊 callbacks 繼續被拒絕；新頁重新開 store 才能寫新世代。晚到資料保留且阻止切換。兩種目的均已用真檔案選取、HTTP、SQLite、IDB 操作驗證。結果不明已接明確核對：既有 identity store 的 restoreIntent 保存 backupId/新世代/原世代，不含 token。SQLite 切換使用該新世代；回覆遺失時 bootstrap 核對同世代才完成本機轉換，未套用可沿用原 ID 重試，不搶尚未到期的舊 lease。兩目的各正常/送達前斷線/成功後丟回覆共 6 個 Chrome 案例通過。失敗取消已驗：僅原世代可取消，釋放 lease 後清除 intent；延遲舊還原請求遭拒，待存文字保留並可補存。已套用則拒絕取消，仍可核對。兩目的共 4 個 Chrome 案例、前端 921 項及靜態檢查/build 通過。本輪兩目的從既有會議清單開啟還原紀錄、下載 JSON 與備份逐項一致，2 個 Chrome 案例通過；完整備份下載另 2 案通過。兩檔存到測試磁碟路徑並核對 hash/SQLite；Chrome 使用者下載設定及實體外接磁碟不屬自動驗收。已套用後晚到資料救援仍待補齊。

本輪補還原入口的結案防護：本次會議尚未完整保存/結案時可匯入驗證，但不能取代資料庫；按鈕及點擊時皆核對現有 manifest/finalizing，無新增狀態管理器。Chrome 有效紅測後，兩目的正常/送達前斷線/成功後回覆遺失/取消延遲請求共 8 案通過（45.7 秒），scoped eslint 與 web build 通過。這是 UI 結案條件驗證，尚非真 provider 排空時序驗收；已套用後晚到資料救援仍未完成。

**外部備份匯入已接線：** 使用既有 repository/worker；HTTP octet-stream 與小型 manifest header 分離，串流寫私有暫存，不把 DB 放入 JSON 或整檔 RAM。單次 512 MiB、60 秒、同時一筆；hash/schema/integrity/count 檢查沿用還原核心，通過才發布新 backup ID，匯入不改 live DB。中斷/錯誤清除本次暫存；還原仍需另行授權操作。匯入與還原 UI 已接既有資料備份面板；驗證與還原分開，明確確認後才取代 DB。

**Interfaces（新增 artifact manifest）:**

```ts
interface BackupManifest {
  formatVersion: 1;
  schemaVersion: number;
  createdAt: string;
  databaseSha256: string;
  meetingCount: number;
  eventCount: number;
}
```

- [ ] 使用現有 SQLite consistent backup 原語，寫到暫存後 integrity_check／hash 成功才發布；來源繼續被使用也不能複製出半個 DB。
- [ ] 提供「匯出備份」到使用者指定位置，顯示最近成功與失敗；同目錄 pre-upgrade backup 與使用者異碟備份清楚區分。不自動刪會議；容量／保留預設明示。
- [ ] 還原需停止 active writer／服務寫入、先備份現有 DB、驗證 hash/schema、還原到新暫存目錄、逐項核對後原子切換；失敗保留舊資料。拒絕路徑穿越與不支援 schema。
- [ ] 升級需處理舊 outbox envelope，相容 reader／migration 先驗；舊 binary 拒寫新 schema，不假定可降版覆寫。
- [ ] 隔離目錄建 20,100 段與兩場會議，含譯文、校訂及 gaps；備份→新增修訂→還原至第二目錄→比對 backup snapshot 的全部事件與 manifest。壞 hash、截斷、schema 太新、磁碟失敗均不能換掉舊 DB。
- [ ] 跑 `pnpm -F online exec vitest run src/storage/meeting-repository.test.ts src/routes/meetings.test.ts` 與必要 export regression；Chrome 實際操作備份及開啟還原會議。完整真人長稿再由 V2 核對，不能以小樣本測試當完整交付。

## D5 — managed 服務有界自動恢復（F11）

W08.1/W08.2 完成（LOCAL），16／26 LOCAL。既有 owner 有界重啟同 build/origin，Stop 不復活；managed bootstrap/寫入核對工作區與 build，錯誤或缺少身分保留待存、停止自動重送，恢復原身分可明確重試。最終正式建置 Chrome 7 案單輪通過（1.1 分鐘）：兩家×翻譯/純字幕重啟續存，以及錯工作區/錯 build/缺少身分；原頁、會議、收音取得與 provider 連線/mint 不變，SQLite/匯出全文一致並結案。純字幕使用既有語音素材、原生 Chrome 音訊/VAD，雲端辨識仍受控；初輪無音訊卻注入結果的兩個測試錯誤已修正，未改產品或放寬斷言。scoped eslint 通過。前輪程序 20、前端 925、routes 13、typecheck 證據沿用，本輪未重跑。新增責任限於一個受 owner 擁有的 HTTP child 與既有 archive 身分檢查，未加資料庫/依賴/另一套恢復管理器。真雲端/實體音源/公司網路/長測仍依 W09–W12 待驗；日常服務未啟停。下一項 W09.1。證據 `.cache/w08-service-verification.json`。

**Depends:** D2；D3 保存恢復可先獨立交付。

**Files:** 修改 `scripts/service.mjs`、`managed-service.mjs`、`service-build.mjs`；優先延用現有 launcher/owner，必要時才抽一個局部 `scripts/service-supervisor.mjs`／test；不建通用程序管理服務；前端服務狀態需核對 build/origin；更新 `AGENTS.md`、RUNBOOK、ARCHITECTURE 的服務所有權說明。

**最小結構：** 程序無法監督自身死亡，因此 host 自動復原需要外部 owner；保留既有 CLI/IPC/manifest，常駐 owner 只負責此工作區的一個 child。不新增 HTTP 管理埠、Windows 系統服務、plugin 系統或同時管理多種 sidecar。

**Interfaces（新增 owner 狀態）:** `restartIntent:boolean`、`restartCount`、`lastExit`、`childInstanceId`、`buildId`、`canonicalOrigin`。named pipe 由 supervisor 持有，child 仍是單 UI/API HTTP 服務；不能兩者同時搶 workspace owner。

- [ ] 紅測：child crash、crash during startup、連續 crash、Stop 與 restart timer 競態、外物占 origin、第二 start 同時到、舊 supervisor manifest。
- [ ] 最多 3 次／60 秒、自動重用同 build snapshot／origin；超限顯示 failed 與一次明確重試。不要在會議中重新 build 或升級。
- [ ] Stop 先撤銷 intent、取消計時、再關 child；依實際 ownership 檢查，不用 PID/port 名稱推斷。機器重開／使用者登出不承諾自動開會或重新授權收音。
- [ ] 前端保持原頁／會議，broker 死亡時已存在的雲端連線可繼續則不強制停；archive outbox 保留。重啟後讀 readiness／identity 再重送，不把程序活著當成功。
- [ ] 使用真子程序 kill/hang＋真 HTTP/IPC 測單例、Stop 不復活、外物不被停、pending 資料重送與 DB 全文核對；`node --test scripts/managed-service.test.mjs`；若確實抽出 supervisor，再加對應單元測試，不能只為符合檔名而新增 wrapper。
- [ ] 更新日常部署程序；不啟用 Windows 登入自啟或更改系統服務設定，這些不是本任務必需。

## 收工條件

- [ ] 純字幕及翻譯均完成 D1/D3 直接資料核對；D2 跨埠風險有重現與修復證據。
- [ ] D4 真還原、D5 真 child crash 操作通過，前端能看懂待存／恢復／阻擋原因。
- [ ] 檢視最終 diff 與資料根目錄，沒有誤清既有會議／工作樹；更新 PROJECT_STATE、TODO、DECISIONS 的現況與放行限制。
