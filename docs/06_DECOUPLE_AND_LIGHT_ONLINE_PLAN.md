# 06 解耦與輕量 Online 系統規劃

> 規劃對象：將 `meeting_audio` 的 Online 與 Offline 兩條線**交付解耦**，
> 讓 Online 產品可獨立構建、安裝、試跑、移植，而 Offline 的 P4+ 工作
> （TranslateGemma、Voxtral、Speaches、glossary 擴張）可繼續推進。
>
> 配套閱讀：
> - [`../CLAUDE.md`](../CLAUDE.md)
> - [`PROJECT_STATE.md`](PROJECT_STATE.md)
> - [`ARCHITECTURE.md`](ARCHITECTURE.md)
> - [`ONLINE_OFFLINE_MODES.md`](ONLINE_OFFLINE_MODES.md)
> - [`01_ARCHITECTURE_DECISION.md`](01_ARCHITECTURE_DECISION.md) ~ [`05_REFERENCES.md`](05_REFERENCES.md)
>
> **本檔僅為規劃，無實作。任何 code 變更須等 Phase 0 通過。**

---

## 1. 問題陳述

當前 monorepo 把 Online 與 Offline 強綁在一起出貨。具體耦合點如下，全部以
真實檔案路徑為準：

### 1.1 工作區層級綁定

`pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "services/online"
```

`services/offline` 雖然不是 pnpm workspace 成員（它是 Python + uv 專案），
但根 `package.json:14-15` 的 npm scripts 把它寫進預設啟動流程：

```json
"dev": "concurrently -n web,online -c blue,green \"pnpm -F web dev\" \"pnpm -F online dev\"",
"dev:full": "concurrently --kill-others --names web,online,whl,offline ... \"python services/offline/run_whl.py\" \"python -m uvicorn app.main:app ...\""
```

意味著任何想跑 dev / e2e 的開發者，預設都會被引導去佈署 Python + WHL +
CTranslate2 環境。

### 1.2 啟動腳本綁定

`start-dev.bat`（已 single-window 化）寫死兩種 Python interpreter
（`PYTHON_VENV` for WHL、`PYTHON_CONDA` for FastAPI）和兩個服務的啟動 spec，
並硬性檢查路徑不能含空白。對純 Online 安裝者而言這些檢查與相依毫無意義，
但 launcher 沒有 online-only 分支。

### 1.3 `apps/web` 同時靜態 import 兩家 provider

`apps/web/src/App.tsx:6-8`：

```ts
import { useOpenAIRealtime } from './providers/use-openai-realtime.js';
import { useOfflineSTT } from './providers/use-offline-stt.js';
import { useFakeReplay } from './providers/use-fake-replay.js';
```

而 `App.tsx:12-14` 在元件 render 期就同時實例化所有 provider hook：

```ts
const fake = useFakeReplay();
const realtime = useOpenAIRealtime();
const offline = useOfflineSTT();
```

`useOfflineSTT` 在 `apps/web/src/providers/use-offline-stt.ts:22-38` 以
`setInterval(poll, 3000)` **無條件** 對 `OFFLINE_SERVICE_URL/healthz` 輪詢，
即使使用者未選擇 offline 模式。Bundle 與啟動行為都被 offline 路徑拖累。

`apps/web/src/config.ts`：

```ts
export const OFFLINE_SERVICE_URL: string =
  (import.meta.env.VITE_OFFLINE_SERVICE_URL as string | undefined) ?? 'http://localhost:8000';
```

預設指向 offline 服務，沒有「offline 在此 build 中不存在」的概念。

### 1.4 Settings store 同時定義 online / offline / hybrid 三模式

`apps/web/src/settings/settings-store.ts:11, 74-96`：

```ts
export type ModeId = 'online_full' | 'hybrid_privacy' | 'full_offline';
export const MODE_OPTIONS: ModeOption[] = [
  { id: 'online_full', ... },
  { id: 'hybrid_privacy', ... },
  { id: 'full_offline', ... },
];
```

UI 永遠列出三個模式，沒有 build profile 可以收斂到 online-only。

### 1.5 共用 contracts 是真共用、其餘只是同址

`packages/contracts/package.json` 被 `apps/web` 與 `services/online`（皆
`workspace:*`）真正依賴。`services/offline` 用 Python，因此事件 schema 在
`services/offline/app/pipeline/events.py` 是**手寫複本**，與 TS 版本沒有自動
同步機制——這既是問題也是機會：解耦後仍可保留 contracts 為單一來源，但需要
明確版本策略（見 §5）。

### 1.6 Offline 依賴重量

`services/offline/pyproject.toml` 列出：`whisper-live`、`ctranslate2`、
`sentencepiece`、`opencc-python-reimplemented`、`pyaudiowpatch`。模型目錄
（`services/offline/models/`）已含 OPUS-MT 雙向 CT2 約 158 MB（**需確認 .gitignore**），
尚未含 distil-large-v3 (~1.5 GB) 或未來 TranslateGemma 4B。
`start-dev.bat` 預設指向 conda env `deve`。Online 完全不需要這些，但目前
任何 `pnpm dev:full` 或全 repo build 都會踩到。

### 1.7 文件與 Phase plan 綁定

`docs/PROJECT_STATE.md` 把 P0–P7 排在同一條時間線，P3 (Offline) 已 done、
P4 (Offline 翻譯品質) pending。Online 沒有獨立 release milestone。
`docs/01_ARCHITECTURE_DECISION.md` ~ `04_CLAUDE_CODE_PROMPT.md` 全是 offline
focus。Online 的釋出節奏被 offline 路線圖拖住。

### 1.8 CI / E2E 隱性綁定

`tests/e2e/` 透過 `pnpm test:e2e` 統一跑 Playwright，目前測試假設
online + fake replay。一旦 P4 把 e2e 也加入 offline 流程，CI runner 將需要
裝 Python + uv + WHL + 模型——對 Online-only 釋出極不友善。

---

## 2. 解耦目標

| # | 目標 | 量測方式 |
|---|------|----------|
| G1 | Online 產品可在「無 Python、無 conda、無 WHL、無 CT2、無 OpenCC、無 glossary、無 WASAPI」環境完整 build + 啟動 + 顯示字幕 | 在乾淨 Windows VM 安裝後跑 `pnpm install && pnpm -F web build:online` 並完成 OpenAI Realtime 字幕 demo |
| G2 | Offline 仍可消費同一份 `apps/web` UI shell,不需要 fork UI 程式碼 | Full Offline build 與 Online build 共用 `caption-board/`、`store/`、`settings/`、`packages/contracts` 一字不差 |
| G3 | `packages/contracts` 維持唯一事件 schema 來源；Python 端的 events 仍是手寫但加入 schema 版本檢查 | Contracts repo / 套件版本號嵌入每個 NormalizedEvent；mismatch 時 UI 顯示 health.degraded |
| G4 | Online artifact 可作為小型 Electron 或 SPA + serverless 出貨,安裝包 ≤ 50 MB(不含 Electron runtime) | `pnpm -F web build:online` 產出 `dist/` 與 `services/online/dist/` 總和；CI 設 size-budget |
| G5 | 兩個模式在 CLAUDE.md 規範下仍是 first-class——解耦只影響**交付**,不刪 offline 程式碼,也不在 lightweight build 假裝 offline 存在 | Lightweight Online build 將 `full_offline` ModeOption 在 UI 隱藏(或標 `unavailable in this build`),不是 throw error |
| G6 | Offline P4+ 工作(TranslateGemma、Voxtral、Speaches)在解耦後可獨立 PR,不阻塞 Online release | Offline 與 Online 各自有 release tag,例如 `online@v0.1.0` 與 `offline@v0.4.0` |

非目標(不在本計畫範圍):
- 不重構 offline pipeline 內部(`services/offline/app/pipeline/*`)。
- 不更換 Online provider(仍是 OpenAI Realtime Translation / Whisper)。
- 不引進新的 LLM、不評估中國來源模型(CLAUDE.md 明令禁止)。

---

## 3. 目標架構（三選項比較）

### Option A — 同 monorepo + Build Profile + 動態 Provider Registry

維持現有 `pnpm-workspace.yaml`，在 `apps/web` 加：
- `vite.config.ts` 增加 `mode === 'online-only'` flag。
- `apps/web/src/providers/registry.ts`（新增）依 build flag 用 `import()` 動態載入 provider。
- `apps/web/package.json` 增加 `build:online`、`build:full`。
- `start-dev.bat` 拆成 `start-online.bat`、`start-full.bat`。

```text
meeting_audio/
├── apps/web/                         (共用 UI shell)
│   └── src/providers/registry.ts     (build-time tree-shake)
├── services/online/                  (always shipped)
├── services/offline/                 (only in full build)
└── packages/contracts/               (single source of truth)
```

| 面向 | 評估 |
|------|------|
| Pros | 變動最小；`packages/contracts` 自然共用；P3 的程式碼幾乎不動；e2e 可分兩條 profile 跑 |
| Cons | Repo 還是一坨；CI 默契仍易踩坑；offline 大模型雖不打包但仍在 git history（需確認 `.gitignore` 已排除 `models/`、`*.bin`，需實測）|
| 遷移成本 | 低：1–2 sprint |
| 對 P3 風險 | 極低：不改 offline 程式碼 |
| Launcher 形態 | `start-online.bat`（只啟 web + online）、`start-full.bat`（=現 `start-dev.bat`）|

### Option B — 拆三個 repo，contracts 走 npm

```text
meeting-audio-shell/        (apps/web + provider plugin host)
meeting-audio-online/       (services/online + Online provider plugin)
meeting-audio-offline/      (services/offline + Offline provider plugin)
@meeting-audio/contracts    (npm published)
```

| 面向 | 評估 |
|------|------|
| Pros | 釋出邊界最清楚；CI 完全獨立；可分授權方收費（hypothetical）|
| Cons | 對 contracts 變更要 publish + bump 三個 repo；目前團隊規模（看起來是個人或小團隊）負擔過大；refactor cost 高；P3 程式碼搬遷時容易踩 import 路徑 |
| 遷移成本 | 高：3–5 sprint，含 publish pipeline |
| 對 P3 風險 | 中：所有路徑改寫，e2e 重設 |
| Launcher 形態 | 每個 repo 自己 `npm start`；shell 用 plugin discovery |

### Option C — 同 monorepo 雙 app

```text
apps/
├── web-online/    (lightweight shell, online provider only)
├── web-full/      (full shell, all providers)
└── web-shared/    (caption-board, store, settings, components)  [packages/]
```

| 面向 | 評估 |
|------|------|
| Pros | UI 差異透過 entry 區隔，build 結果完全分離；不需 dynamic import |
| Cons | UI 程式碼搬到 `packages/web-shared` 是大手術；React 元件的 settings store 是 module-level singleton，搬動時需要謹慎；`apps/web/src/settings/use-settings-store.ts` 的 `settingsStore` singleton 模式需要重構 |
| 遷移成本 | 中：2–3 sprint |
| 對 P3 風險 | 中：UI 重新組織後 P3 的 Settings/AudioSourceSelector 會被搬 |
| Launcher 形態 | 兩個獨立的 vite dev server，連 port 都不同 |

### 建議

**選 Option A，並把它規劃成「將來能升級到 Option B」的中間態。**

理由：
1. 目前 P3 剛 done，P4 還沒開工，**最珍貴的資源是「不要打斷 P3 已驗證的事情」**。Option A 對既有檔案改動最少。
2. `apps/web` 的 UI 狀態與 store 高度耦合於 module singleton（`settingsStore`、`captionStore`），Option C 的程式搬遷風險高、收益低。
3. Contracts 已是 `workspace:*` 真共用，Option A 直接沿用，無需 publish pipeline。
4. Option B 的拆 repo 收益要等到團隊 / 客戶分流時才看得見，現在執行成本超過效益。
5. Option A 留下 `apps/web/src/providers/registry.ts` 作為將來轉 Option B 的天然 seam——provider 變 plugin。

---

## 4. 輕量化 Online 系統評估

Online 真正需要的東西（從 `services/online/src/server.ts` 與
`services/online/src/routes/session.ts:27-72` 可看出）：
- Browser：mic / WebRTC、React caption shell。
- 一個極小 token broker 端點：`POST /session` 換取 OpenAI ephemeral
  `client_secret`，外加 `GET /session/info` 與 `GET /healthz`。
- 唯一 secret：`OPENAI_API_KEY`（`services/online/src/config.ts`）。

三種佈署選項：

### (i) Static SPA + Serverless `/session`

把 `apps/web` 編成靜態檔案丟 CDN（Cloudflare Pages / Vercel），把
`registerSession` 抽成 serverless function（Cloudflare Workers / Vercel
Functions / AWS Lambda）。`OPENAI_API_KEY` 放在 secret manager。

| 面向 | 評估 |
|------|------|
| 安裝大小 | 客端：SPA bundle（gzip < 500 KB 預估，**需實測**）；伺服器端：0（serverless）|
| Key 隔離 | 高：key 永遠在 serverless env，符合 CLAUDE.md 「Never expose API keys in browser code」|
| 延遲 | `/session` 一次 ephemeral token 換手；之後 WebRTC 直連 OpenAI；額外 cold start 約 50–300 ms（**需實測**）|
| 託管成本 | 極低：每月 < $5（OpenAI 用量另計）|
| 企業 IT 安裝阻力 | 高：客戶要連外網、CDN 可能被擋；無法跑於 air-gapped 內網 |
| Time-to-ship | 1–2 週 |

### (ii) 單一 Node binary（Fastify 同時 serve 靜態 + `/session`）

維持現狀但去除 Python 依賴。`services/online` 加 `@fastify/static` plugin，
直接 serve `apps/web/dist/`。封成單一 `node` 程序或 pkg/nexe binary。

| 面向 | 評估 |
|------|------|
| 安裝大小 | Node 22 runtime + node_modules（Fastify + openai SDK + zod 約 30–50 MB）+ SPA dist 數 MB。**需實測**。|
| Key 隔離 | 高：key 在 Node process env，不入 browser |
| 延遲 | 與 (i) 相當；少了 cold start 但多了使用者要自己跑 server |
| 託管成本 | 0（使用者自架）；或部署到 single VPS 約 $5–10/mo |
| 企業 IT 安裝阻力 | 中：要授權跑 Node；可在企業內網跑、可離線安裝 node_modules |
| Time-to-ship | 1 週（最接近現狀）|

### (iii) Electron-only desktop（main process 持 key）

不分前後端，所有東西在 Electron main process 跑。`OPENAI_API_KEY` 由
keytar / OS keychain 保管，main process 透過 IPC 把 ephemeral token 傳給
renderer。

| 面向 | 評估 |
|------|------|
| 安裝大小 | Electron runtime ~ 90 MB + 應用程式 ~ 5 MB |
| Key 隔離 | 中：renderer 仍只看 ephemeral；main process 須做好 contextIsolation。實作上需注意 `node_integration: false` 與 IPC 邊界 |
| 延遲 | 與 (i)/(ii) 相當 |
| 託管成本 | 0；發行成本：code-signing 證書（Win + Mac 約 $200/yr）|
| 企業 IT 安裝阻力 | 中：未簽名安裝包會被擋；簽名後最容易讓非工程使用者安裝 |
| Time-to-ship | 3–4 週（含 packaging、auto-update、簽名）|

### 建議

**主推 (ii) 單一 Node binary 作為 v0.1 Online release，並把 (iii) Electron 排在 v0.2。**

理由：
1. (ii) 是現狀的最小變動：`services/online` 已是 Fastify，加 `@fastify/static` 即可同時 serve UI；省去 Vite dev server 在生產環境出現。
2. CLAUDE.md 「Preferred Stable Stack」已寫 `Electron for stable packaged desktop distribution`，但同時允許 `Local web app is acceptable during MVP development`——(ii) 完美對應 MVP→packaged 的中間態。
3. (i) Serverless 雖然輕，但會卡到部分客戶的「不能連外」需求；本案目標客戶是會議場景，內網 / air-gap 是真實情境。
4. (iii) Electron 留給「給非工程使用者一鍵安裝」階段，作 v0.2。
5. 三個選項都不違反「key 不入 browser」的硬規。

---

## 5. 共用契約管理

### 5.1 `packages/contracts` 維持 single source of truth

TypeScript schema 留在 `packages/contracts/src/index.ts`，由
`@meeting-audio/contracts` 透過 `workspace:*` 給 `apps/web` 與
`services/online` 直接使用。

### 5.2 Python 端的鏡像

`services/offline/app/pipeline/events.py` 是手寫鏡像。建議流程：
- 在 `packages/contracts` 加 `scripts/emit-json-schema.ts`（**規劃中，不本次實作**），產出 `packages/contracts/dist/schema.json`。
- offline 服務於啟動時讀 `schema.json`，比對自家 events 的 shape，不符就在 `/healthz` 顯示 `degraded` 並列出欄位差異。
- 不引入 `datamodel-code-generator` 自動產 Python 程式碼（避免 build 時相依 Node）；只用 schema 做 runtime 驗證。

### 5.3 跨 artifact 的版本策略

採 **lockstep minor + tolerant minor**：
- contracts package version 採 SemVer，例如 `0.2.x`。
- Online build 與 Offline build 各自把 contracts version 寫入自家 NormalizedEvent metadata 欄位（**需在 contracts 加一個 `schemaVersion` 欄位，規劃 phase 2 完成**）。
- UI 看到 source mismatch 時不 crash，只在 `HealthEvent` 標 `degraded` 並 log。
- 實際 publish：本期仍走 monorepo `workspace:*`；若未來轉 Option B，contracts 可一鍵 `npm publish` 給三 repo 共用。

### 5.4 Contracts 變更紀律

- 新增欄位視為 minor，向後相容。
- 改/刪欄位視為 major，必須開 ADR（記入 `docs/DECISIONS.md`）。
- 任何 contracts 變更都必須同時更新：
  - `packages/contracts/src/*.test.ts`
  - `services/offline/app/pipeline/events.py`
  - `apps/web` 任何使用該 type 的點

---

## 6. 遷移階段

每階段都是**規劃**——只描述「要做什麼」與「完成證據」，不寫程式。

### Phase 0 — 計畫批准（entry: 本檔提交；exit: 使用者書面同意）

- 內容：
  - 使用者閱讀並回覆採用 Option A、佈署選 (ii)。
  - 在 `docs/DECISIONS.md` 新增 D-DEC-01「Adopt Option A + Lightweight Online (ii)」。
  - 在 `docs/PROJECT_STATE.md` 加 P3.6 phase「Decoupling」。
- 完成證據：使用者於 PR 上明確 approve，無實作變更。

### Phase 1 — Provider Registry 與 Build Profile（entry: P0 done；exit: `pnpm -F web build:online` 產出可跑 SPA）

- 內容：
  - 規劃 `apps/web/src/providers/registry.ts`，把 `useOpenAIRealtime` 與 `useOfflineSTT` 改為**dynamic import 並由 build flag 決定是否載入**。
  - `apps/web/vite.config.ts` 加 `define: { __INCLUDE_OFFLINE__: ... }`。
  - `apps/web/package.json` scripts 加 `build:online`、`build:full`。
- 完成證據：
  - `pnpm -F web build:online` 產出的 `dist/` 中，`grep -r 'OFFLINE_SERVICE_URL\|use-offline-stt'` 沒有命中（tree-shake 成功）。
  - `pnpm -F web build:full` 產出與目前 `pnpm -F web build` 等價。
  - vitest 全綠。

### Phase 2 — Lightweight Online launcher 與 Fastify static（entry: Phase 1 done；exit: `start-online.bat` 在無 Python VM 跑通）

- 內容：
  - 新增 `start-online.bat`（不含任何 `PYTHON_*`、無 WHL、無 uvicorn 行）。
  - `services/online` 加 `@fastify/static`，serve `apps/web/dist/`，並在 `services/online/src/server.ts` 註冊。
  - `services/online/package.json` 加 `start:bundled` script。
  - `apps/web/src/config.ts` 改成「offline 不存在時不 throw」：當 `__INCLUDE_OFFLINE__ === false`，`OFFLINE_SERVICE_URL` 直接 export `null`。
- 完成證據：
  - 乾淨 Windows VM（無 Python、無 conda、無 uv）安裝 Node 22，跑 `pnpm install && pnpm -F web build:online && pnpm -F online build && pnpm -F online start:bundled`，能在 browser 看到 caption shell 並完成 OpenAI demo。
  - `start-dev.bat` 仍存在，仍能啟動 Full（offline + online）。

### Phase 3 — UI Mode gating 與 Honest unavailable（entry: Phase 2 done；exit: lightweight build UI 不謊報 offline 可用）

- 內容：
  - `apps/web/src/settings/settings-store.ts` 的 `MODE_OPTIONS` 改為由 build flag 過濾。Online-only build 中 `full_offline` 與 `hybrid_privacy` 隱藏（或標 `unavailable in this build`，依 §7 風險決策）。
  - `apps/web/src/App.tsx` 不再無條件 `useOfflineSTT()`。
  - `useOfflineSTT` polling 改為「provider registry 判斷有 offline 才啟動」。
- 完成證據：
  - Online-only build 的 DevTools Network panel 不再對 `:8000/healthz` 發送請求。
  - Playwright e2e 新增 spec：`online-only-build.spec.ts`，驗證 ModeSelector 只剩一個 option。

### Phase 4 — Contracts schemaVersion 與 Python 對齊（entry: Phase 3 done；exit: contracts 變動會在兩端同時失敗 / 同時通過）

- 內容：
  - `packages/contracts/src/common.ts` 加 `SCHEMA_VERSION = "0.2.0"` 常數，並在 NormalizedEvent metadata 帶上。
  - 規劃 `packages/contracts/scripts/emit-json-schema.ts` 並在 contracts build 步驟產出 `dist/schema.json`。
  - `services/offline/app/pipeline/events.py` 啟動時 load schema，記錄到 `/healthz`。
- 完成證據：
  - contracts schema 版本 mismatch 時，`/healthz` 回 `degraded` 並列出欄位差。
  - 對 contracts 加新欄位後，offline test fixture 仍綠（minor 相容）。

### Phase 5 — CI 拆 pipeline、文件分流、Online v0.1.0 release（entry: Phase 4 done；exit: Online 可獨立 tag 出貨）

- 內容：
  - GitHub Actions（或目前 CI）拆 `online-build.yml` 與 `full-build.yml`：online 流程不裝 Python；full 流程跑 `uv sync` + pytest。
  - 文件層級：把 `docs/PROJECT_STATE.md` 拆「Online roadmap」與「Offline roadmap」兩欄，並在 README.md 增加 Quick start (Online only) 區段。
  - 釋出 `online@v0.1.0` tag；`offline` 維持自己的 P4 進度。
- 完成證據：
  - GitHub release 頁有獨立 `online-v0.1.0` 與 `offline-v0.4.0`（或當下 offline 進度）兩條 tag。
  - 新貢獻者依 README Quick start (Online only) 能在 30 分鐘內跑起。

---

## 7. 風險與決策點

### R1 — `start-dev.bat` 是否要保留？

`start-dev.bat` 已經 single-window 化（本次提交完成），假設兩條 stack 都裝。
解耦後它仍對「全功能開發者」有用。**規劃**：保留 `start-dev.bat`（作為 Full 啟動），
新增 `start-online.bat`（作為 Lightweight 啟動）。**決策**：使用者要決定是否把
預設的 `start-dev.bat` 改名 `start-full.bat` 並讓 `start-online.bat` 接手「預設」位置。

### R2 — `apps/web/src/App.tsx:12-14` 同時 `useFakeReplay() / useOpenAIRealtime() / useOfflineSTT()`

如果只是 build flag 隱藏按鈕但 hook 仍跑，offline polling 仍會打 `:8000`。
解耦必須一併把 hook 抽進 registry，靜態 import 換 `await import()`。**風險**：
React hook 要 conditional 載入時，需注意 hooks rules（不能條件呼叫）。
**規劃對策**：在 registry 裡導出固定 `useTranscriptProvider()`，內部依 build
flag 回傳真實 hook 或 noop hook。Phase 1 必須驗 vitest 全綠。

### R3 — CLAUDE.md 「不可假裝 Offline」如何在 lightweight build 表達

CLAUDE.md「Online and Offline Are Both First-Class」段落寫
「Do not implement Offline as a placeholder unless clearly marked as
unavailable in the UI」。Online-only build 兩種選擇：

- **A：完全隱藏 `full_offline` / `hybrid_privacy` mode option。** UI 乾淨，但失去「升級到 full build 可解鎖」的提示。
- **B：保留選項但 disabled，文字寫 `Not included in this build — install full edition`。** 較教育性，但增加 UI 負擔。

**建議 B**，附 tooltip 與 docs 連結，符合 CLAUDE.md「visible states」精神。
**這需要使用者決策。**

### R4 — Offline P4 是否凍結？

不建議凍結。Phase 1–5 都不改 `services/offline/` 內部程式（除 Phase 4 的 schema validation hook），因此 P4 的 TranslateGemma、Voxtral benchmark 可平行進行。**風險**：若 Phase 4 contracts 有新增欄位，offline 端要同步更新——這正是 schema validator 的價值。

### R5 — Contracts 變動的破壞性

目前 contracts 由兩端 `workspace:*` 直接吃，沒有版本緩衝。Phase 4 才導入 schemaVersion。在 Phase 0–3 期間，若 contracts 有破壞性改動，offline `events.py` 會默默不一致。**規劃對策**：Phase 0 結束時凍結 contracts schema 直到 Phase 4 完成。

### R6 — Offline models 是否進 git

`services/offline/models/` 目錄約 158 MB（OPUS-MT 雙向）。**需確認**目前
`.gitignore` 是否已排除 `services/offline/models/`、`*.bin`、`*.pt`。若沒排，
online 開發者 `git clone` 仍會下載 158 MB+ 模型。**必須在 Phase 1 之前驗證
/ 修正 `.gitignore`。**

### R7 — `concurrently` 與 npm scripts 的耦合

根 `package.json` 的 `dev` script 包含 `pnpm -F online dev`，目前同時新增的
`dev:full` 包含 Python 啟動。Online-only 開發者跑根目錄 `pnpm dev` 是 OK 的，
但 `dev:full` 會試圖啟 Python。**規劃對策**：`dev` 維持現樣（web + online），
`dev:full` 仍是兩條 stack，並在 README 標清楚。

### 使用者必須在 Phase 1 開始前決策的事

| ID | 決策 | 預設建議 |
|----|------|----------|
| D-1 | 採用 Option A 還是 B 還是 C | A |
| D-2 | Lightweight Online 部署選 (i)(ii)(iii) | (ii) |
| D-3 | R3：unavailable mode 隱藏 vs disabled 顯示 | disabled 顯示 |
| D-4 | `start-dev.bat` 是否更名為 `start-full.bat` | 是 |
| D-5 | Phase 0–4 期間 contracts 是否凍結 | 是 |
| D-6 | Online v0.1.0 是否需含 Hybrid Privacy（hybrid 需要 offline STT） | 不含；只 Online Full |

---

## 8. 建議下一步

**只做一件事：請使用者書面 approve 本檔的 D-1 ~ D-6 共 6 項決策（建議全採預設值），然後在 `docs/DECISIONS.md` 開 D-DEC-01「Adopt Option A + Lightweight Online (ii) decoupling plan」。**

完成這一步後才進入 Phase 1 的 Provider Registry 設計討論。在此之前**任何 code 不動**。

---

## Critical Files for Implementation

- `C:\Develop\meeting_audio\apps\web\src\App.tsx` — UI shell 起點，App.tsx:6-8 與 12-14 是 provider 三載入點，Phase 1/3 改 dynamic registry。
- `C:\Develop\meeting_audio\apps\web\src\providers\use-offline-stt.ts` — `useOfflineSTT` 內部第 22-38 行的 `setInterval` polling 是 online-only build 的最大噪音來源，Phase 3 必改。
- `C:\Develop\meeting_audio\apps\web\src\settings\settings-store.ts` — `MODE_OPTIONS`（11、74-96 行）決定 UI 看得到哪些模式，Phase 3 build flag 過濾的核心。
- `C:\Develop\meeting_audio\services\online\src\server.ts` — Phase 2 加 `@fastify/static` 把 SPA 一起 serve，是 Lightweight Online (ii) 的落地點。
- `C:\Develop\meeting_audio\start-dev.bat` — Phase 2 拆出 `start-online.bat` 的對照樣板，現有腳本的 Python/path 邏輯在 online build 完全不需要。
