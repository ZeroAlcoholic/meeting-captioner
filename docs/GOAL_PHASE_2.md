# GOAL — 階段 2：完善線上版本

> 建立 2026-07-30。取代藍圖 [BLUEPRINT_2026-07-29.md](BLUEPRINT_2026-07-29.md) 第 4 節階段 2。
> 前置：階段 1 已合併（`dbd35a4`）。
> 2026-07-31 開工前校正：補上量尺定義、A2 可見狀態、C1 證據層級、chunk 決策、開工序（見各節與末段）。

## 上位裁決（2026-07-28 使用者明令，本文件全體服從）

**即時性 > 費用**；**強制最新專用模型**。費用不作否決條件。

最新模型現況已達成，本輪不新增任務，只上鎖（見「硬規則」）：

| 項目   | 現況（2026-07-31 親驗）                                                               | 測試鎖                |
| ------ | ------------------------------------------------------------------------------------- | --------------------- |
| OpenAI | `services/online/src/routes/session.ts:161` 硬編 `gpt-realtime-translate`             | `session.test.ts:112` |
| Gemini | `services/online/src/config.ts:51-53` zod enum 僅 `gemini-3.5-live-translate-preview` | `gemini.test.ts:57`   |

## GOAL

**線上版本在真實會議中不斷、不卡、不騙。**

範圍只有兩條路徑：OpenAI Realtime、Gemini Live Translate。
Offline／Hybrid 這一輪完全不動。

---

## 三件事

### A. 不斷 —— 切換與續期不留空白

| 任務                   | 現況（已親驗）                                                             | 完成條件                                                                     |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A1 Gemini 故障訊號提前 | 要跑完 5 次 backoff（1+2+4+8+16 s）才發 `failed`，約 31 秒                 | 3 秒內發出可切換訊號                                                         |
| A2 Standby 熱備        | 另一個 provider 的 token 不預鑄、麥克風不跨 provider 共用 → 切換要從零開始 | 切換時不重新要麥克風、不等 token；**切換有非侵入可見指示、歷史逐字稿不清空** |
| A3 OpenAI 故障續期     | 排程續期近無縫；**故障觸發**的續期首次重試 backoff 30 秒                   | 斷字幕窗量出來並壓到 3 秒內                                                  |
| A4 Gemini Stop 收尾    | Stop 未送 `audioStreamEnd`／未 drain                                       | 最後一句話不會掉                                                             |

**數字①：failover 斷字幕窗 ≤ 3 秒**（現況約 31 秒）。這是這一輪唯一大幅改善的指標。

**數字① 的量尺（A1／A2／A3 共用，先建再改）**：`tests/e2e/online-mock.ts` 故障注入的時間戳
→ 下一個 caption 事件的時間戳之差。**不是手感、不是 DevTools 目視。**
開工第一件事＝在未修狀態錄 baseline（預期 Gemini ~31 s、OpenAI 故障續期 ~30 s）並貼進 PR，
這同時履行下方「新增回歸測試必須先在未修狀態失敗」。

A2 的可見指示屬「不騙」要求：3 秒內悄悄換 provider＝使用者不知道字幕來源已變，
等同靜默失敗。歷史保留為 CLAUDE.md 硬規則（provider switch 不得清逐字稿）。
**基礎設施已有半套**：`apps/web/src/providers/failover.ts` 已是跨模型一鍵切換的
決策模組（`show`／`fromLabel`／`toLabel`／`target`），A2 只需把它擴到「自動接手也可見」，
不必新造 UI 元件。

### B. 不卡 —— 講話時畫面不停頓

| 任務                      | 現況（已親驗）                                                                                                                                           | 完成條件                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| B1 latency-monitor 持久化 | `apps/web/src/providers/latency-monitor.ts:203-219`（`maybePersist`）每 15 秒在事件路徑上內聯 `JSON.stringify` + `localStorage.setItem` + `console.info` | 移出熱路徑（idle callback），**取樣語意不得改動** |
| B2 開啟保存時的寫入       | `apps/web/src/store/caption-persistence.ts` 的 `flush`（:300）與 `persist`（:306）同步 `writeSnapshot`（階段 1 後只在使用者開啟保存時發生）              | 非同步排程                                        |

B1 的限制條件很重要：latency-monitor 是 C1 唯一的數據來源，
只准搬移「何時寫出」，不准改動 `ttfcMs`／`lagMs`／`durMs` 的定義或取樣時機，
否則 B1 會把 C1 的證據來源弄斷。

**已知第三停頓源，本輪不動**：`apps/web/src/caption-board/CaptionBoard.tsx:382`
每個 delta 讀 `scrollHeight` 造成回流，7/28 稽核判 sub-ms 可接受。
明文記錄以免下輪重複稽核。

**數字②：連續講話 10 分鐘，主執行緒 0 個 > 50 ms 停頓。**
量法：Chrome DevTools Performance 錄一段，看 long task。不建量測管線。
已知代理落差：long task = 0 不保證字幕節奏平順；節奏由手測主觀確認，不另立指標。

### C. 不騙 —— UI 只講實測

| 任務                | 現況                                                    | 完成條件                                            |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| C1 延遲文案         | 部分宣稱無實測背書                                      | 只標 arrival-proxy 區間並就地註明量法；沒量過的不寫 |
| C2 單 provider 啟動 | healthz 的 `ok` 只看 OpenAI key、完全不看 Gemini        | 只有 OpenAI 或只有 Gemini 也能乾淨啟動並正確顯示    |
| C3 音訊失敗狀態     | 初始化失敗未一律轉 `failed`；source metadata 有不實欄位 | 失敗可見、metadata 誠實                             |

**C2 的精確現況（2026-07-31 親驗，原稿「假設兩個 key 都在」方向錯誤）**：

- server **不會**拒絕啟動：`services/online/src/config.ts:26` 的 `OPENAI_API_KEY` 是 `optional()`。
- 真正的缺陷是 Gemini 隱形：`services/online/src/routes/healthz.ts:35-38` 的 `ok`
  只由 OpenAI key ＋ OpenAI reachability 決定，Gemini key 完全不入 `components`；
  `config.ts:88` 無 OpenAI key 時印 `MISSING`；`scripts/setup.ps1:88-94` 只檢查 OpenAI。
  → Gemini-only 部署會被自家健康檢查判成壞的。
- 因此 C2 的完成條件是 **healthz 分別回報兩個 backend 的可用性**，
  `ok` 改為「至少一個 backend 可用」，啟動診斷與 setup 腳本同步。

**C2 的驗證方式（本機三把 key 都在系統環境變數）**：
`OPENAI_API_KEY`（User, 167 ch）、`OPENAI_API_KEY_AUDIO`（User, 164 ch）、
`GEMINI_API_KEY`（Machine, 39 ch）——依 STRICT 政策只從系統環境讀，不吃 `.env`。
所以 **不得用刪除／`setx` 清空系統變數來驗證**（不可逆、會弄壞手測環境）。
合法做法：起子行程時只覆寫該行程的環境（PowerShell `$env:X=''`、
或 vitest 內 `process.env` stub），三種組合各測一次：OpenAI-only／Gemini-only／both。

**C1 的證據層級（本輪唯一合法級別）**：本輪不建 speech→paint 管線，
唯一儀器是 `latency-monitor.ts`，它自己在 `:9-17` 聲明是 **arrival-based proxy，非 microphone-truth**：

- `ttfcMs` ＝ transport `connecting` → 首個 translation 事件（連線到首字）
- `lagMs` ＝ 段首事件 → 該段首譯（段落開始串流後多快出譯文）

因此 UI 文案**只准**寫這兩種量法的觀測區間，並就地標明是哪一種；
**不得**寫成「說話到上字幕 X 秒」——那是跨級宣稱，違反本文件末條硬規則。
若日後要宣稱 speech→paint，需另做拍手／對嘴 marker 手測，不在本輪。

### D. 順手 —— Gemini chunk 的 screening 級比較

上位裁決是即時性優先，而現行 32 ms 是已知較慢的一組，不能整輪放著不管。
但也不為此建音檔夾具。做法：**寄生在已排定的真實會議手測上，零額外成本**。

| 任務         | 做法                                                                       | 完成條件                                   |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------ |
| D1 註解修真  | `gemini-live-provider.ts:21-22` 改中立敘述，註明 7/28 反向觀測             | 註解不再宣稱 32 ms 更快                    |
| D2 screening | Gemini 手測跑兩段：32 ms 與 100 ms 各一段，讀 latency-monitor `lagP50/P95` | 落檔一組數字，用**晉級／淘汰**級詞彙下結論 |

用詞紀律：樣本量只夠 screening。允許「100 ms 晉級、32 ms 淘汰」這類措辭；
**禁止**寫成「已證實 100 ms 更快」或任何模組級判決。若兩段差距落在噪音內，
結論就寫「未分出勝負，維持現值」——那也是合法終態。

---

## 不做（這一輪明確排除）

- **Gemini chunk 的模組級 A/B 判決** —— 要下模組級判決必須先有固定音檔回放夾具，
  否則兩次量的是不同輸入。不值得為此建夾具。
  **但不維持現狀不動**：現行 32 ms（`apps/web/src/providers/gemini-live-provider.ts:28`）
  是 7/28 稽核**實測較慢**的組態（32 ms 組 3927 ms vs 100 ms 組 3313 ms），
  而 `:21-22` 的註解卻寫著「shaving ~32 ms off felt latency」——與實測相反，
  這本身就是 C 區「不騙」的漏網之魚。本輪處理方式（見下方 D）：
  註解改中立敘述 ＋ 順手在已排定的真實會議手測裡做 screening 級比較。
- **Offline 全部**（WHL 延遲地板、瀏覽器 chunk、MT 預熱）。順帶記錄：藍圖說的「調 WHL `min_chunk`」不存在該參數，真正的地板是庫內硬編 `duration < 1.0`（`whisper_live/backend/base.py:86-88`），將來要動得先決定是否 patch 函式庫。
- **CI**（`.github/` 目前不存在）—— 等真的要交辦外部再建。
- summary pipeline、Electron、多語向矩陣、費用 A/B。

---

## 開工序（有依賴關係，不得平行亂跳）

| 序  | 項目                  | 為何在這個位置                                      |
| --- | --------------------- | --------------------------------------------------- |
| 1   | 數字① baseline 量測   | 沒有 baseline，A 區「壓到 3 秒」不可證偽            |
| 2   | A1、A4                | 改動小、風險低，先拿分                              |
| 3   | A2                    | 動到雙 provider 生命週期，需 keepalive e2e 全程回歸 |
| 4   | A3                    | 依賴 1 的量尺                                       |
| 5   | B1、B2                | B1 需維持 latency-monitor 語意（C1 的資料來源）     |
| 6   | D1、C2、C3            | 與量測無關的誠實性修復                              |
| 7   | 真實會議手測（含 D2） | 產出 C1 需要的實測數字                              |
| 8   | C1                    | **必須最後**：文案依賴 7 產生的數字                 |

---

## 驗收

改完跑這幾條，全綠：

```bash
pnpm -r test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:e2e
```

基準（2026-07-30 重跑）：web 295／online 65／contracts 19／e2e 30 passed。測試數只能增加。
`tests/e2e/online-keepalive.spec.ts` 是 A 區的既有回歸網，不得放寬。

加上一次真實會議手測：兩個 provider 各跑一次、中途手動切換一次、Stop 一次。
Gemini 那次拆成 32 ms／100 ms 兩段（D2）。手測會燒真 key 配額，屬計畫內的不可逆動作：
執行前先列「要跑幾段、各約幾分鐘、用哪個 key」再開始。

新增的回歸測試必須先在未修狀態失敗（貼修前／修後兩份輸出），否則證明不了它在測什麼。

## 硬規則

- 不改 `tests/fixtures/upstream-contracts/`、不改 key 處理、不重錄 fixture。
- **不得放寬 `GEMINI_LIVE_MODEL` 的 zod enum、不得改動 OpenAI 的硬編模型、不得新增任何靜默 fallback。**
  這是階段 1（`13f6311`）修出來的最新模型保證，兩個測試鎖不得移除。
- caption path 不得被任何非字幕工作阻塞。
- 不得為過測而放寬斷言。
- UI 只宣稱有實測背書的能力，且**宣稱不得跨越證據層級**（見 C1 證據層級段）。
