# 雲端／地端模組與資料夾檢閱

日期：2026-11-03。目的：先隔離地端開發對已驗雲端的影響，再逐步開工地端。這次沒有啟動 Python、下載模型、呼叫付費 API 或更換辨識／翻譯引擎。

## 已證實並修補的耦合

### 1. 雲端仍載入地端實作，舊 Hybrid 會議能啟動地端

修前以真實 online Vite build 的 Rollup module graph 查到 `offline-stt-provider.ts`／`use-hybrid-mode.ts`。App 無條件 import Hybrid hook，只有 Offline STT hook 使用 build alias；Hybrid 的 deployment guard 僅停止健康輪詢，無法排除實作與 Start。舊 Hybrid 會議 Continue 未檢查部署能力，可重新取得音源並連地端 `/ws`。

已將地端 adapter／hook／專屬測試集中到 `apps/web/src/providers/offline/`，Hybrid 編排／測試集中到 `providers/hybrid/`。App 的兩個本機模式都經明確 alias，雲端版對應 unavailable capability；UI 型別獨立於實作。移除原本只轉送一層的 Offline barrel、舊 stub 及手寫 virtual declaration，避免重複介面。

舊 Offline／Hybrid running／paused 會議在雲端版保留歷史與匯出，Continue 明確停用且說明須用完整版本；handleContinue 與內部 resume 均在改寫狀態／啟動前拒絕。不把原會議靜默改送雲端。

### 2. 地端編譯錯誤會阻擋雲端啟動

修前 TypeScript program 實際包含地端 adapter、real hook、Hybrid hook 及測試；managed 與 online ZIP 仍先跑完整 `tsc -b`。Vite tree-shaking 不能隔離先行的 TypeScript 編譯。

現以 `tsconfig.online.json` 排除地端／Hybrid 實作與測試，兩條 paths 指向 unavailable capability；完整 target 保留真實實作與所有原有檢查。managed 使用 online target，Windows／Unix ZIP 使用 `build:online`。專用 `vite.online.config.ts` 選能力而不改 production 環境設定載入語意；managed 仍可使用既有 `VITE_DEPLOYMENT_MODE=online`。

Vite 雲端 build 加入實際 module load 拒絕，防止未來跨目錄直接引用繞過 alias。`tests/architecture/provider-boundaries.test.mjs` 注入地端型別／載入錯誤，驗雲端成功、full 保留型別失敗；再向入口注入一條錯誤直接引用，驗建置明確拒絕。這些檢查接進 `pnpm test`，沒有放進服務啟動。

### 3. 舊 bundle 字串檢查錯把共用音訊當地端

`check-online-bundle.sh` 原本禁止 `pcm-worklet`／`audioWorklet.addModule`，但 Gemini、OpenAI WebSocket、純字幕也使用本機音訊擷取／VAD。已改用實際模組邊界檢查，保留原始／gzip 大小門檻。沒有刪除雲端必要音訊資產。

## 保留的架構與未搬動範圍

- Node／Python 服務未見跨服務程式 import；地端 Python 沒有加入 cloud client。
- `packages/contracts` 是共用事件契約；capture lease／PCM／VAD、呈現、保存是共用平台。共用變更仍須評估兩端，不承諾所有變更零影響。
- 雲端 provider／recovery／SQLite 產品邏輯未改動。`services/online/src/storage` 是本機保存，未為目錄名稱搬成另一個服務。
- Python 現有 `capture/`／`pipeline/`、ASR、stabilizer、MT dispatcher、後處理責任可保留。模型／data 目錄本輪未搬動；不新建泛用 plugin registry 或 asset framework。
- 專屬測試跟著實作搬移；跨模式 capture routing 與 provider conformance 留在共用層。

## 地端接下來的施工順序

| 順序             | 已確認缺口                                                                                                                                       | 最小處置與範圍                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| L1 契約          | `main.py` 可選 system／STT-only，但 `pipeline/events.py` 仍固定 microphone／full_offline；前端多為型別斷言，未驗跨語言真契約                     | 由 session 明確傳 mode／source；Python 產代表事件，TS 用既有 Zod 驗證結構與來源／模式語意。限 offline adapter／事件邊界，不改雲端協定。 |
| L2 runtime／資源 | Windows launcher 的 ASR 優先 `.venv`、API 使用 deve；ASR startup 的 `snapshot_download` 未固定 revision／本地模式，MT／glossary 依原始碼相對定位 | 明確選定並揭露 runtime／裝置／模型版本；顯式準備與只讀本機執行分離，缺檔可見失敗。必要時只增加 offline 範圍的資源定位模組。             |
| L3 既有缺陷      | stabilizer 強制定稿後吞上游修訂；MT timeout 不能終止 native worker                                                                               | 沿既有 pipeline 分別重現、修復與驗收，不用搬檔代替行為修復。                                                                            |
| L4 模型          | 現有離線品質／延遲未達需求，候選尚未本機實測                                                                                                     | 先單獨比較 Riva 4B v2 MT，再評 Nemotron 0.6B ASR；通過本機品質、串流延遲與失敗隔離後才接 provider。                                     |

本輪只完成隔離整理與上述檢閱，未修 L1–L4，不變更既有 18／26 LOCAL 或地端可用性狀態。研究細節見 [NVIDIA 報告](2026-11-03-nvidia-realtime-translation.md)。

## 驗證與沿用

- 3 項架構邊界檢查先紅後綠；修前 online compiler 載入 6 個被注入失敗的地端檔案，online bundle 實際載入 Hybrid。日誌 `.cache/module-boundaries-20261103-{red,green}.log`。
- 搬移／能力介面／capture routing／provider conformance／deployment 的 38 項單元通過：`.cache/module-boundaries-20261103-unit.log`。
- 雲端 production Chrome 6 案通過（9.3 秒）：Offline／Hybrid × running／paused 四案保留原文／譯文／JSON／sessionId、零擷取／地端請求，另兩家正常雲端 Stop→SQLite／匯出兩案。`.cache/module-boundaries-20261103-chrome.log`；build 為 `index-CO0niutr.js`。雲端與音訊受控，不是新真 API 品質驗收。
- 全前端 typecheck、完整 eslint、service-build 取消回收測試通過。完整及雲端前端 build 均通過；後者在改回 production mode 的專用 config 後產生相同 `index-CO0niutr.js`，沿用上述 Chrome，不因同一產物重跑。
- managed 實際建置步驟另驗：日常入口明確設定 `VITE_DEPLOYMENT_MODE`，會讓 fallback 常數與獨立 build 不同，產生 `index-B6uZdkaq.js`。沒有把檔名不同當產品失敗或強行改成相同：直接使用這份 web／server 產物再跑上述 6 案，**6 passed（12.4 秒）**，日誌 `.cache/module-boundaries-20261103-managed-chrome.log`。初始探針誤用相對輸出路徑，以及後續要求兩種設定的 hash 必須相同，兩份失敗紀錄保留在 `module-boundaries-20261103-managed-build.log`／`module-boundaries-20261103-managed-build-final.log`，不算通過證據；沒有因此修改產品或放寬行為斷言。
- 獨立唯讀檢閱未發現新的隔離阻擋。未重新執行未變更的雲端 provider 全套、付費 API 或長測。

下次接續先讀此報告與 PROJECT_STATE；相關指紋未變更就沿用這些證據。新地端專屬修改只驗地端及 boundary；動到 contracts／capture／保存才擴大到相應共用回歸。不是每次啟動或換工作階段重驗。

## 版本指紋

### 收尾校準

收尾重新讀取原始驗證日誌並核對下列 21 個檔案，全部與已驗版本一致；沒有重跑整套測試或再改產品。完成範圍是本輪模組／建置隔離與舊會議保護，不是完整系統放行。日誌支持 38 項受影響單元、3 項架構故障注入、日常正式產物 6 項 Chrome；Chrome 的上游／擷取受控，不能替代真人辨識品質或長會議資格。Windows ZIP 僅另驗腳本語法，未實際產生／執行 ZIP；Unix 打包與 Bash bundle guard 本輪未實跑。

指紋只涵蓋列出的邊界檔案，不能單憑這 21 個值排除其他共用程式、設定、依賴、runtime 或網路變動。接續仍先判斷實際變更影響面；沒有相關變動才沿用證據，不因新工作階段或服務重開重驗。L1–L4 維持待施工，不以文件與目錄整理補勾。

雲端兩家翻譯 provider、OpenAI hook 與遠端軌的 SHA-256 均與前輪驗證一致，沿用原有邏輯驗證。以下是本輪邊界的版本指紋；有差異先看實際 diff，純格式變動不自動要求整套重驗。

```json
{
  "apps/web/src/App.tsx": "77aa2c00ead415cc30a93d9a392aa51bb71dac62096d7be4133bca1a4e80f590",
  "apps/web/src/components/SessionLauncher.tsx": "7f4762aed7e76ae700d98336ec3f713484bcb4237938330eafdcfcf641708ac6",
  "apps/web/vite.config.ts": "cce174c4d5c6ad88a8829f3b773fd75091547e768971de7b5159bb44685ede21",
  "apps/web/vite.online.config.ts": "eaacecff9aed48352e92e6061f8689c735a5e9cac173bea8cdfc417e8b24ce4f",
  "apps/web/tsconfig.app.json": "d55617524fa944228c3b5208beef9288d1fa3dc6cc63fb76000d148af4d35600",
  "apps/web/tsconfig.online.json": "1487baf6ea4923b6dec871acf6fc4815bf9d741265e9520df9a25b6759f415f7",
  "apps/web/src/providers/local-mode-controller.ts": "1be9f1511be65c836e1e1f1965507bfbd4d404711dda185af620dddabfab42e3",
  "apps/web/src/providers/local-mode-unavailable.ts": "21ebf57b127593d8a437af64ad47c4f20e462fff1b19d8d11240df747c5d871d",
  "apps/web/src/providers/offline/offline-stt-provider.ts": "fd9bae0c62d3e2a37e3f1a507ddb90b4dc57cf20bf6707deac9c95e146652821",
  "apps/web/src/providers/offline/use-offline-stt.ts": "dd2dc4cb752dc0b7514bfb870705c75e2cefd105bbe36a7fbeec74eca0b08d3a",
  "apps/web/src/providers/hybrid/use-hybrid-mode.ts": "68fb3f12621336cd8672001e972616055b8594db03c122fb6e23abb1e46540ee",
  "scripts/service-build.mjs": "39214d6e69d4a64c5bdaed19d26d4540d5b7da8e123e038b1d202078f8bbe91c",
  "scripts/package-online.ps1": "0fa094256b3411dd41c8fd57e34260d26410350612cf3c86e18dbc295c17be59",
  "scripts/package-online.sh": "7c3ba316589a184ebc93eca5e55817996262853b5e483e916d15b79cb737c25e",
  "scripts/check-online-bundle.sh": "84366ca664b87aaf26e9a7af3381b0f4c114c1c9a53b456f363f4d9537b90c76",
  "apps/web/package.json": "fbf6c45407f6ca981f7abb53dfbae045e82c3a2c3640fae974627555a2fa631e",
  "package.json": "cdff564183ef36b4a77ec1c14b4464155dee2e2edda487b6cc765f5b3698c497",
  "pnpm-lock.yaml": "eee9a8b432617a8920aa3b8b5cd29ffdb3398eb8cba2c2f87f325dad015484a6",
  "tests/architecture/provider-boundaries.test.mjs": "bf37a5cf67ff3b2ebfe760d69c3a218732cc441186a613afb4b9f38bd874b9ae",
  "tests/e2e/deployment-boundaries.spec.ts": "49d4296ec692612244f92f19037c6d3b085ee3a2a6c7673f2640a554764d3b7e",
  "tests/e2e/pure-captions-server.ts": "e7e7bc6980fdc0177a968232145d51402b2ab81dcf123de334036b9bfa818faf"
}
```
