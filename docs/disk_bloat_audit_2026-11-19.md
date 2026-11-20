# 工作區空間診斷（2026-11-19）

> 方法依 `docs/disk_space_techniques_2026-11-19.md`。本輪只量測與判定，**沒有刪除或改動任何檔案**。
> 探針腳本與機器清單：`.tmp/disk_audit/{measure,refs_dups,classify}.py`、`classify.json`（每一項的路徑、級別、位元組、檔數、引用來源）。

## 0. 第二輪校準（前提更正：本資料夾是當機後直接複製的備份）

使用者 2026-11-19 原話：「此資料夾為專案資料夾於系統當機後直接資料夾複製的備份，故一定會有很多連結失效。」以此前提重驗，第一輪有三處判斷要改：

| 第一輪                                    | 校準後                                                                              | 探針                                                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「連結點 0」當成正常讀數                  | pnpm `node-linker=isolated` 一定要有 junction；0 代表複製時**全部掉了**             | `node_modules` 頂層只剩 5 個 scope 空目錄；`react`、`vite`、`fastify`、`typescript` 全部 `MODULE_NOT_FOUND`                                                                                                |
| `node_modules` 列為「保留／正本」         | **已壞，無法使用**，列 A 級                                                         | 同上；專案目前不能 build、不能跑測試                                                                                                                                                                       |
| pnpm 改連結「預估約 1 GB」                | **實測可行**：只用專案內 `.pnpm-store`、離線、不連外即可重建；`prune` 可減 735.8 MB | 在 `.tmp/relink-probe` 跑 `pnpm install --offline --frozen-lockfile`：成功；四個套件都解析得到；58,952 檔中 57,804 檔是硬連結；鎖檔只用到套件庫 1,042.6 MB 中的 306.8 MB。探針目錄已刪，套件庫連結數回到 0 |
| 地端 `.venv` 刪除「牽涉地端存廢，需確認」 | 刪除**不改變任何能力**：它本來就無法執行。地端存廢只決定以後要不要 `uv sync` 重建   | `pyvenv.cfg` home 不存在；執行回報 `No Python at`                                                                                                                                                          |

### 備份本身是否完整（決定「不影響專案」的基準）

| 檢查                                          | 結果                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git fsck --full`                             | 通過，只有 dangling 物件。任何清理都不得碰 `.git`。（更正 2026-11-20：原寫「沒有遠端」是錯的，實際有 `origin`；只存在本機的是 4 個未推送 commit 與未提交的改動，見 `docs/PROGRESS_2026-11-20.md` 第 3 節） |
| 專案自有檔（版控＋未追蹤、未 ignore，457 檔） | 0 份全 NUL、0 份截斷；2 份 0 位元組的 `__init__.py` 在 HEAD 也是 0 位元組；8 份不存在的就是 `git status` 的 `D`（重構時搬到 `providers/offline/`）                                                         |
| `.pnpm-store/v3`                              | 499 個套件索引列出的 16,107 個內容檔全部存在、大小正確                                                                                                                                                     |
| 會議資料                                      | 在 `%LOCALAPPDATA%\MeetingAudio`，不在本資料夾                                                                                                                                                             |
| 日常服務建置                                  | `scripts/service-build.mjs:13` 每次啟動都建新的 `builds/<instanceId>`，舊建置從不被讀取。`runtime.json` 的 pid 已不存在                                                                                    |

### 「不影響專案」的定義與驗證方式

- 專案＝457 份專案自有檔＋`.git`（HEAD、refs、`git status`）。
- 基準快照已建立：`.tmp/disk_audit/protected_before.json`（每檔 SHA256＋HEAD＋refs＋status），由 `protected_snapshot.py` 產生。
- 所有刪除候選都已用 `git check-ignore` 確認被 ignore，且版控內 0 檔。刪除後重跑快照，必須與基準**逐位元組相同**；再跑 `pnpm install --offline`、typecheck、單元測試，確認專案能用（目前因 `node_modules` 壞掉而不能用）。

### 校準後的安全刪除清單

| #   | 項目                                                                           |            大小 | 為何不影響專案                       |
| --- | ------------------------------------------------------------------------------ | --------------: | ------------------------------------ |
| 1   | `.cache` 測試暫存 629 個                                                       |      1,824.5 MB | 無引用；現行測試會再產生             |
| 2   | `.cache/native-audio-release*`                                                 |        542.8 MB | 測試只寫不讀；setup 重建             |
| 3   | 5 份沒被引用的舊服務建置                                                       |         45.1 MB | 程式不讀舊建置                       |
| 4   | `.pnpm-store/v11`、`.playwright-mcp`、空的 `.worktrees/phase-1-closure`        |         36.4 MB | 其他 pnpm 版本／工具暫存／空目錄     |
| 5   | 所有 `node_modules`（根、`apps/web`、`services/online`、`packages/contracts`） |       約 321 MB | 已壞；第 6 步離線重建                |
| 6   | 重建後 `pnpm store prune`                                                      |        735.8 MB | 已實測鎖檔所需全在保留的 306.8 MB 內 |
| 7   | `services/offline/.venv`                                                       |      1,999.1 MB | 已無法執行                           |
|     | **合計**                                                                       | **約 5,505 MB** | 剩約 1.35 GB                         |

第 5、6 步要依序做：先刪 `node_modules`，再 `pnpm install --offline --frozen-lockfile --store-dir .pnpm-store`，成功後才 `prune`。`.npmrc` 要加 `store-dir=.pnpm-store`（改版控檔，需同意），否則之後的安裝會寫到 `D:\.pnpm-store`。

不在清單內（維持第一輪判定）：被引用的證據約 541 MB、`release/` 舊打包、`services/offline/models`、無建立者的暫存、舊 log、截圖。

## 0.1 執行紀錄（2026-11-20）

使用者授權原話（2026-11-20）：「針對 1 2 5 7，以資深音訊工程師與資深AI系統工程師身份反思校驗，確保安全無誤，真實無問題後，仔細小心刪除。 另，務必避免擅自寫到專案外面。」
只執行第 1、2、5、7 步。第 3、4、6 步、重新安裝與修改 `.npmrc` 都沒有做。

### 刪除前的專業檢查

| 角度       | 檢查                                                                          | 結果                                                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 音訊       | 第 1、2 步範圍內有沒有錄音檔（wav、pcm、webm、m4a 等）                        | 0 個                                                                                                                                                                                                                                                                                                  |
| 音訊／資料 | 804 個 SQLite（唯讀、immutable 開啟）裡全部 75,142 段文字，能不能對回測試程式 | 都對得回：測試字串、合成語音腳本 `tests/fixtures/mixed-caption/cases.json`、或 `docs/WORK_REPORT_2026-10-10.md:75-82` 已記載的雲端辨識錯字。唯一找不到原文的「保存第一句。」只出現在 2 個 `pure-archive-*`，資料夾只會由 `tests/e2e/pure-captions-server.ts:44-46` 建立，兩邊同一秒建立，屬於測試資料 |
| AI 系統    | `.venv` 裡有沒有模型權重；有沒有 `uv.lock` 以外手動裝的套件                   | 權重 0 個；95 個套件全部在 `uv.lock` 裡。模型在 `services/offline/models`，未刪                                                                                                                                                                                                                       |
| AI 系統    | `node_modules` 有沒有手動改過、重裝會遺失的檔案                               | 15,660 檔中 361 檔不在套件庫：330 個 pnpm 指令捷徑、29 個 Vite 快取、2 個 pnpm 狀態檔，全是自動產生                                                                                                                                                                                                   |
| 執行環境   | 有沒有程式正在使用這些檔案                                                    | 沒有相關的 node／python／chrome 程序                                                                                                                                                                                                                                                                  |

### 執行方式

- 腳本：`.tmp/disk_audit/delete_approved.py`。先全部預檢，有任何一項不符就整批中止。
- 預檢：路徑在專案內、不是 `.git`、頂層不是連結點、被 git 忽略、裡面 0 個版控檔、檔數與位元組和診斷清單相同。反例確認：`apps/web/src` 會被擋（未忽略、93 個版控檔）。
- 乾跑結果與診斷清單完全一致後才正式刪除。刪除只用 Python，不呼叫 pnpm、uv、node。

### 前後讀數

| 項目                             |                刪除前 |                    刪除後 |
| -------------------------------- | --------------------: | ------------------------: |
| 全部                             | 6,851.6 MB／96,364 檔 | **2,167.9 MB／38,702 檔** |
| 磁碟實際佔用                     |            7,102.6 MB |                2,270.6 MB |
| 第 1 步 `.cache` 測試暫存        |    629 個，1,824.5 MB |                         0 |
| 第 2 步 `native-audio-release*`  |              542.8 MB |                         0 |
| 第 5 步 `node_modules`（4 處）   |   318.4 MB／15,660 檔 |                         0 |
| 第 7 步 `services/offline/.venv` | 1,999.1 MB／34,580 檔 |                         0 |

### 刪除後驗證

- 專案自有 457 檔的 SHA256、HEAD、refs、`git status`：與刪除前快照**完全相同**（`protected_pre_delete.json` 與 `protected_after.json`）。
- `git fsck --full` 通過。
- 保留項目（被引用證據、`meeting-service`、`pure-release`、`release/`、`services/offline/models`、`.pnpm-store/v3`）的檔數與大小沒變。
- 專案外：執行開始後 `%LOCALAPPDATA%\pnpm`、`pnpm-cache`、`pnpm-state`、`uv`、`D:\.pnpm-store`、`D:\Python` 新增檔案 0。

### 事故：第一輪曾寫到專案外面（未清理，待使用者決定）

2026-11-19 23:28，第一輪診斷執行 `pnpm --version`、`pnpm store path`。全域 pnpm 依照 `package.json` 的 `packageManager: pnpm@9.12.0`，從 npm registry 下載 pnpm 9.12.0，寫入：

- `%LOCALAPPDATA%\pnpm\.tools\pnpm\9.12.0_tmp_16728_0\`（214 檔）
- `%LOCALAPPDATA%\pnpm\store\v10\`（197 檔）
- `%LOCALAPPDATA%\pnpm-cache\metadata-v1.3\registry.npmjs.org\pnpm.json`、`%LOCALAPPDATA%\pnpm-state\pnpm-state.json`

這同時是一次未經同意的連外動作。之後的離線安裝實驗沒有再寫到專案外面。清除這些檔案也要寫到專案外面，所以沒有自行處理。

### 目前狀態與下一步

- 專案現在沒有 `node_modules`，在重新安裝前不能建置或測試。這和刪除前相同：刪除前它已經壞了。
- 要恢復：第 6 步（需同意）——`.npmrc` 加 `store-dir=.pnpm-store`，再 `pnpm install --offline --frozen-lockfile`，已實驗證實不需連外。注意 pnpm 可能再觸發上面的版本下載，執行前要先處理。
- 地端要用時才重建 `.venv`（`uv sync`，需連外）。

## 0.2 校準後第二次清理（2026-11-20）

使用者要求：「最後校準，以資深系統專家身份，提出可以怎麼刪[確保不會影響專案]的最佳化建議」。由使用者親自執行刪除指令。

### 校準時更正的誤判

- `w04-clock-range-load-20261019/`（181 MB）原本被列為「被引用證據」。實際上文件引用的是同名的 `.log`；這個目錄是被熱更新中斷的失敗那一輪（`.last-run.json` 為 `failed`，`PROJECT_STATE.md:15` 寫明不計驗收）。原因是第 2 節的引用比對只比對名稱開頭。
- 被引用的證據目錄裡，文件只引用摘要 JSON 和 log。`trace.zip` 只出現在 Playwright 自己的執行 log 中。
- `release/` 已展開的目錄和同名 zip 不是同一份內容：其中 3 個目錄裡 contracts 的 5 個檔案比 zip 新。原因是當機前這些目錄和原始碼共用同一份檔案（硬連結），原始碼後來改了，目錄也跟著變。所以 zip 才是當時打包的原貌。
- 檔案總管顯示的大小（約 2.9 GB）會把 `node_modules` 的硬連結重複計算，實際佔用是 1,459 MB。

### 刪除項目

腳本：`.tmp/disk_audit/delete_calibrated.py`。預設只乾跑，加 `--execute` 才刪除。清單寫死了每一項的檔數和位元組。預檢內容：路徑在專案內、不是 `.git`、沒有連結點、被 git 忽略、0 個版控檔、檔數與位元組相符、`release` 目錄有同名 zip、不是目前在用的服務建置、沒有使用本專案的程序在執行。反例測試：把 `apps/web/src`、目前在用的建置、`release/meeting-audio-online` 加進清單並帶 `--execute`，預檢擋下 6 個問題，三者都沒被刪。

| 批次 | 內容                                                                                                          |   檔數 |     大小 |
| ---- | ------------------------------------------------------------------------------------------------------------- | -----: | -------: |
| 1    | 失敗那一輪的 trace 目錄、12 個已展開的 `release` 目錄、4 份只有 `service.log` 提到的舊建置、`.pnpm-store/v11` | 18,507 | 370.0 MB |
| 2    | `.cache` 底下全部 55 個 `trace.zip`（截圖、`error-context.md`、log、JSON 保留）                               |     55 | 345.4 MB |

### 前後讀數與驗證

| 項目               |   刪除前 |     刪除後 |
| ------------------ | -------: | ---------: |
| 實際佔用           | 1,459 MB | **744 MB** |
| 檔案總管顯示的大小 | 2,932 MB |   2,217 MB |

- 專案自有 454 檔的 SHA256、HEAD、refs、`git status`：與刪除前快照逐位元組相同（`protected_pre_calibrated.json` 與 `protected_post_calibrated.json`）。
- `git fsck --full` 通過。
- 保留項目都在：15 個 `release` zip、`release/meeting-audio-online/`、6 份服務建置（含目前在用的 `4bec17b6`）、`.pnpm-store/v3`（`.modules.yaml` 指向它）、被引用的 log／JSON、74 張失敗截圖。`react`、`fastify` 仍能解析。
- 刪除紀錄：`.tmp/disk_audit/delete_calibrated_log.json`。

剩下的空間是：套件庫 `v3` 約 305 MB（建置要用）、地端模型 157 MB（離線模式要用）、被引用的證據與目前在用的服務建置、`release` zip、原始碼與 `.git`。

預防（2026-11-20 同日完成）：

- R6：`scripts/release-retention.mjs`，由 `package-online.ps1` 在打包成功後呼叫。只處理有標記的新打包，保留最新 3 份 zip 和目前的展開目錄。
- R7：`scripts/workspace-capacity.mjs`，`pnpm test` 最後執行。`.cache` 400 MB、`.tmp` 1 GB、`release` 200 MB，超過就失敗。
- trace：機制是 `retain-on-failure` 加上 `--output=.cache/<新名稱>`，Playwright 只清空這次指定的目錄，所以舊目錄的 trace 會一直累積。保存設定不改（失敗時的 trace 有查錯價值），累積由 R7 抓；處理方式寫在 `docs/RUNBOOK.md` 的 Workspace capacity。
- 引用比對：處理規則已寫進同一節；診斷腳本 `.tmp/disk_audit/classify.py` 本身沒有修改。

## 結論（第一輪，數字已由第 0 節取代）

- 工作區現況：**6,851.6 MB、96,364 檔**（磁碟實際佔用 7,102.6 MB；叢集 4 KB）。讀取錯誤 0、連結點 0、硬連結 0。
- 程式、文件與版控合計約 **20 MB**（`apps/web/src` 1.6 MB、`services/online` 1.8 MB、`docs` 5.9 MB、`.git` 8.2 MB 等）；另有建置輸出 `apps/web/dist*` 約 19 MB。其餘都是暫存、相依套件與測試產物。
- 只做 A 級（可重建、無引用）：**−2,449 MB、−9,458 檔**。
- 再加上地端 `.venv`（已經無法執行）：累計 **−4,448 MB、−44,038 檔**，剩約 2.4 GB。
- 再把 pnpm 改成硬連結並清掉未用的套件：預估再減約 1 GB，剩約 **1.4 GB**。
- 最大來源是 E2E 測試暫存沒清（2.37 GB），不是地端模型。地端佔 2.16 GB（venv 2.0 GB＋模型 0.16 GB），其中 venv 已經壞掉。

## 1. 量測（依技巧文件第 1 節）

| 項目                       | 結果                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 遍歷方式                   | `\\?\D:\…` 長路徑前綴、`os.stat` 取 `st_nlink`／inode，依 inode 合併                                                |
| 讀取錯誤                   | 0（16,876 個目錄全部讀到）                                                                                          |
| 硬連結（nlink>1）          | 0 份。原因見根因 R4                                                                                                 |
| 檔案分層                   | <10 KB：80,719 檔／147 MB；10 KB–1 MB：14,983 檔／858 MB；1–100 MB：657 檔／4,573 MB；≥100 MB：5 檔／1,274 MB       |
| 內容重複（≥64 KB，SHA256） | 511 組，浪費 856.9 MB。幾乎全在下表 A 級目錄與 pnpm 兩份副本之間；刪掉 A 級與重新連結 pnpm 後，不需要另做硬連結去重 |
| 原始碼快取                 | `__pycache__`／`.pytest_cache`／`.ruff_cache`（不含 venv）36 檔、0.4 MB，可忽略                                     |

### 頂層分布

| 路徑                             |       大小 |     檔數 | 性質                                                                               |
| -------------------------------- | ---------: | -------: | ---------------------------------------------------------------------------------- |
| `.cache/`                        | 3,092.4 MB |    9,731 | 測試暫存與驗收證據混放                                                             |
| `services/offline/.venv`         | 1,999.1 MB |   34,580 | 地端 Python 環境（torch 1,092 MB、openvino 213 MB、llvmlite 102 MB、scipy 90 MB…） |
| `.pnpm-store/`                   | 1,077.3 MB |   16,943 | pnpm 套件庫（v3 1,042.6 MB＋v11 34.7 MB），**目前沒有被使用**                      |
| `node_modules/`                  |   313.2 MB |   15,583 | 已安裝套件（完整副本，不是硬連結）                                                 |
| `release/`                       |   164.5 MB |   16,779 | 2026-05～10 的打包輸出                                                             |
| `services/offline/models`        |   157.4 MB |       11 | opus-mt 英中／中英 CTranslate2 模型                                                |
| 其他（apps、docs、.git、tests…） |   約 47 MB | 約 2,700 | 正本                                                                               |

## 2. 判定與分級（依技巧文件第 2、3 節）

引用檢查：在 725 份版控與未追蹤的文字檔中（排除 `.git`、`node_modules`、`.pnpm-store`、`.cache`、`release`、`.venv`），搜尋 `.cache/<名稱>`、`release/<名稱>`，正反斜線與絕對路徑都換成 `/`、不分大小寫。1,404 個候選中有 87 個被引用。

### A 級：可重建、無引用 → 可直接刪

| 項目                                                                                                                                                                             |           大小 |       檔數 | 為何安全                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.cache/` 測試暫存目錄（`storage-fault-*` 377 個，加上 `pure-archive-openai/gemini-*`、`w08-browser-*`、`origin-recovery-*`、`origin-unrelated-*`、`storage-loss-*`，共 629 個） |     1,824.5 MB |      6,728 | 名稱是 `mkdtemp` 的隨機後綴，且目前的測試程式仍會產生這些家族；沒有文件或程式引用；內容是測試自己產生的 SQLite 與打包 worker                                                                   |
| `.cache/native-audio-release`、`native-audio-release-openai`                                                                                                                     |       542.9 MB |        717 | 只被測試當成「寫入目標」引用（`tests/e2e/native-audio-server.ts:18-20` 會 `mkdir` 再複製 bundle）；內容是測試會議資料，下次測試自動重建                                                        |
| `.cache/meeting-service/builds/` 裡的 5 份舊建置                                                                                                                                 |        45.1 MB |         50 | 目前執行個體 `4bec17b6…`（`runtime.json`）保留；另 4 份的 instance id 被 `docs/DIAGNOSIS_2026-10-12.md`、`docs/evals/2026-10-08-*`、執行帳本引用，也保留；服務現在沒有執行（pid 59208 不存在） |
| `.pnpm-store/v11`                                                                                                                                                                |        34.7 MB |      1,694 | 其他 pnpm 主版本留下的；本專案鎖定 `pnpm@9.12.0`（用 v3）                                                                                                                                      |
| `.playwright-mcp/`                                                                                                                                                               |         1.7 MB |        269 | 瀏覽器工具暫存，已 gitignore                                                                                                                                                                   |
| 空目錄（含 `.worktrees/phase-1-closure`，git 未登記）                                                                                                                            |              0 | 269 個目錄 | 空的                                                                                                                                                                                           |
| **小計**                                                                                                                                                                         | **2,448.8 MB** |  **9,458** |                                                                                                                                                                                                |

真實會議資料**不在**專案內：預設寫到 `%LOCALAPPDATA%\MeetingAudio`（`services/online/src/storage/meeting-repository.ts:23-24`），清理範圍不會碰到。

### A\*：地端環境 → 建議刪，但牽涉地端存廢，需你確認

| 項目                     |       大小 |   檔數 | 證據                                                                                                                                        |
| ------------------------ | ---------: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/offline/.venv` | 1,999.1 MB | 34,580 | **已經壞掉**：`pyvenv.cfg` 的 base `C:\Programs\miniforge3\envs\deve` 不存在，執行時回報 `No Python at …`。要用地端就必須先重建，留著也沒用 |

- 地端現況：2026-10-22 校準後「不視為可用會議方案」，P3 production-ready 宣稱已撤回（`docs/PROJECT_STATE.md:11`）。
- 刪除後的行為：完整版的 Hybrid／Full Offline 會顯示服務無法使用（既有 `service-down` 狀態）；`pnpm dev:full` 的 offline 兩個子程序會失敗；`services/offline` 的 pytest 不能跑。online 主線與 online build 不受影響（`tsconfig.online.json` 把地端 alias 到 `local-mode-unavailable.ts`）。
- 重建方式：`cd services/offline && uv sync`（`uv.lock` 已鎖版，需要連外下載約 2 GB）。

### B 級：沒被引用，但可能只有這一份 → 逐項由你決定

| 項目                                                                                                                                                                                                                                       |     大小 |   檔數 | 說明                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------: | -----: | -------------------------------------------------------------------------------------------------------- |
| `release/` 舊打包（2026-05-16～06-12 共 14 份、2026-10-02 兩份；目錄＋zip 共 24 項）                                                                                                                                                       | 160.9 MB | 16,765 | 若沒有交給別人，可由 git 歷史重新打包。被引用的 `continuity-20261002-1620`、`meeting-audio-online/` 保留 |
| `services/offline/models`                                                                                                                                                                                                                  | 157.4 MB |     11 | 模型轉換產物；重建要連外下載並轉換。地端若確定暫停，可一起刪                                             |
| `.cache/` 無建立者的隨機後綴目錄（`real-cloud-data-*`、`w07-legacy-*`、`built-archive-*`、`sqlite-limit-probe-*` 等 15 項）                                                                                                                |   1.4 MB |    128 | 目前的程式與 git 歷史都找不到建立它們的程式碼，刪了就無法重建；省得少，預設保留                          |
| `.cache/` 未被引用的舊證據與 log（623 項，含 `w12-preflight-native`；最大的是 `module-boundaries-managed-20261103` 18.7 MB、`w12-fixture-*regression` 共 15.9 MB、`w04-retention-timeout-native*` 共 9.1 MB、`live-reconnect.wav` 4.4 MB） |  58.6 MB |    718 | 多數是一次性 log；省得少，預設保留                                                                       |
| 根目錄 26 張截圖（`verify-*.png`、`ui-*.png` 等，已 gitignore）                                                                                                                                                                            |   2.5 MB |     26 | 2026-05 手動驗證截圖；省得少，預設保留                                                                   |

### C 級：pnpm 改用硬連結 → 需你同意（會重跑 `pnpm install`）

`.pnpm-store/v3`（1,042.6 MB）＋`node_modules`（313.2 MB）是兩份獨立副本。建議做法：

1. `.npmrc` 加 `store-dir=.pnpm-store`，讓 pnpm 用專案內的既有套件庫。
2. 重跑 `pnpm install --offline`：套件庫已有內容，不需連外；`node_modules` 改成硬連結，額外佔用趨近 0。
3. `pnpm store prune`：刪掉套件庫裡已不再使用的舊版本。
4. 執行後實測。預估合計再省約 1 GB，數字以實測為準。

不建議直接刪 `.pnpm-store/v3`：刪了之後下次安裝要全部重新下載，而且會寫到 `D:\.pnpm-store`（磁碟根，違反寫檔邊界）。

### 保留

| 項目                                                                                                       |      大小 | 原因                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被引用的 `.cache` 證據（85 項）                                                                            | 約 541 MB | 被 `PROJECT_STATE.md`、`TODO.md`、`FAILURE_MODES.md`、`docs/evals/*` 引用。最大的是 `hardening-w03-renewal-20261015`（311.4 MB）與 `w04-clock-range-load-20261019`（181.0 MB，一個 180.9 MB 的 Playwright `trace.zip`） |
| `.cache/meeting-service/` 目前建置、4 份被引用的舊建置、`runtime.json`、`verification.json`、`service.log` |   82.0 MB | `README.md`、`docs/RUNBOOK.md`、診斷與評測文件引用；日常服務要用                                                                                                                                                        |
| `node_modules/`、原始碼、`docs/`、`.git/`                                                                  |         — | 正本                                                                                                                                                                                                                    |

## 3. 根因：為什麼會長這麼大

| #   | 根因                                                                                            | 證據                                                                                                                                                                                                                         | 造成                                                         | 對策（另開工作，本輪不改）                                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| R1  | Playwright fixture 在 `.cache/` 用 `mkdtemp` 建目錄，結束時沒有刪除                             | `tests/e2e/storage-fixture.ts:13`（7 個測試檔共 10 處呼叫）、`tests/e2e/pure-captions-server.ts:44-46`、`tests/e2e/service-recovery.spec.ts:27`、`tests/e2e/origin-recovery.spec.ts:16`。這些 teardown 都只關服務，沒有 `rm` | 629 個目錄、1.82 GB；每跑一輪約增加 20 MB × fixture 數       | teardown 成功時 `rm(root, {recursive:true, force:true})`；失敗時保留以便除錯；位置改到 `.tmp/`。附雙側測試 |
| R2  | 原生音訊測試用固定目錄，資料只增不減                                                            | `tests/e2e/native-audio-server.ts:18-20` 只 `mkdir`＋`cp`，不清 `meeting-data`                                                                                                                                               | `meetings.sqlite` 141.8 MB、exports 兩份各 36.7 MB           | 每次 setup 先清空 `meeting-data`，或改用每輪新目錄並在結束時刪除                                           |
| R3  | 日常服務每次啟動都建一份 `builds/<instanceId>`，從不清理舊的                                    | `scripts/service-build.mjs:13`                                                                                                                                                                                               | 10 份建置共 103.6 MB，其中 5 份無引用                        | 啟動成功後只保留目前與前一份                                                                               |
| R4  | 專案從 `C:\Develop\meeting_audio` 搬到 `D:\Python\meeting_audio`，硬連結在複製時變回完整副本    | `node_modules/.modules.yaml:670` 的 `storeDir` 仍是 `C:\Develop\…\.pnpm-store\v3`（該路徑已不存在）；全樹 nlink>1 為 0；`pnpm store path` 現在指向 `D:\.pnpm-store\v3`                                                       | 套件庫與 `node_modules` 兩份共 1.36 GB；下次安裝會寫到磁碟根 | 見 C 級：`.npmrc` 固定 `store-dir`，重新連結                                                               |
| R5  | 地端 venv 跟著 `whisper-live` 拉進 torch、openvino 等大型套件；base Python 刪除後 venv 就失效了 | `services/offline/pyproject.toml` 相依 `whisper-live>=0.8.0`；`pyvenv.cfg` home 不存在                                                                                                                                       | 2.0 GB 無法執行的環境                                        | 地端重新啟用時再 `uv sync`；若改用其他引擎，屆時再評估相依                                                 |
| R6  | 打包輸出只增不減                                                                                | `scripts/package-online.ps1` 每次輸出帶時間戳的目錄＋zip                                                                                                                                                                     | 16,765 檔、161 MB                                            | 只保留最近 N 份；或改成只留 zip                                                                            |
| R7  | 膨脹沒人發現                                                                                    | 沒有容量閘                                                                                                                                                                                                                   | —                                                            | 測試結束時回報 `.cache/` 大小與檔數，超過門檻就報錯（技巧文件第 6 節）                                     |

R1、R2 合計 2.37 GB，是最大的單一來源。主因是 E2E fixture 的清理缺口，不是單元測試，也不是地端。

## 4. 本案對技巧文件的補充

技巧文件以另一專案的錄音去重為主。本案另外發現三個值得補進去的檢查：

1. **venv 是否還活著**：讀 `pyvenv.cfg` 的 `home`，再實際執行 `.venv\Scripts\python.exe`。base 不存在的 venv 是無法使用的 2 GB。
2. **套件庫是否還連得上**：比對 `node_modules/.modules.yaml` 的 `storeDir` 與 `pnpm store path`。專案搬過家時，硬連結會變回副本，舊套件庫會變成孤兒。
3. **用名稱家族找暫存外洩**：把 `mkdtemp` 的 6 碼隨機後綴換成 `*` 再分組。同一家族有幾百個目錄，就是 teardown 沒清。

## 5. 建議執行順序（都需要你同意後才做）

| 步  | 內容                                                          |                減少 | 可逆性                                     |
| --- | ------------------------------------------------------------- | ------------------: | ------------------------------------------ |
| 1   | 刪 A 級（清單見 `classify.json` 中 `cat` 以 `A:` 開頭的項目） |  2,449 MB／9,458 檔 | 測試會重建，或本來就是空的／其他版本的暫存 |
| 2   | 刪地端 `.venv`（A\*）                                         | 1,999 MB／34,580 檔 | `uv sync` 重建（需連外）                   |
| 3   | pnpm 改硬連結＋prune（C 級）                                  |         預估約 1 GB | 可重跑安裝                                 |
| 4   | B 級逐項決定                                                  |         最多 381 MB | 部分不可逆                                 |
| 5   | 修 R1–R3、R6、R7（程式改動，另開工作）                        |          防止再膨脹 | —                                          |

執行時依技巧文件第 4 節：執行前逐項比對檔數與大小，不符就停；只刪清單上的路徑，不跟隨連結；執行後重算同一組讀數並寫回本報告。

## 獨立審查

一輪唯讀子代理證偽：總量、根因 R1–R5、`LOCALAPPDATA` 資料位置都確認成立。修正了三點，已由主代理親驗後改進 `classify.py` 與本報告：4 份舊建置被文件引用（改為保留）；`w12-preflight-native` 是有名稱的證據目錄，被誤判成隨機暫存（改為 B）；漏列 `origin-unrelated-*`（補進 A）；無建立者的隨機目錄改為 B。

## 重跑指令

```
python -I -X utf8 .tmp/disk_audit/measure.py D:\Python\meeting_audio .tmp/disk_audit/before.json 4096
python -I -X utf8 .tmp/disk_audit/refs_dups.py D:\Python\meeting_audio .tmp/disk_audit/refs_dups.json
python -I -X utf8 .tmp/disk_audit/classify.py D:\Python\meeting_audio
```
