# P2-ONLINE 長跑執行契約

> **任務代號**：`P2-ONLINE`
> **全名**：階段 2 線上路徑長跑 —— failover 斷窗 ≤3 s、講話時 0 個 >50 ms 停頓、UI 零跨級宣稱
> **範圍界線**：只有 OpenAI Realtime 與 Gemini Live Translate 兩條線上路徑。
> Offline／Hybrid／summary／Electron 全部不在此代號之下（代號寫死範圍，避免長跑中途擴張）。
> **規模**：14 項，三段（S1 自動 12 項／S2 人工 1 項／S3 收尾 1 項）加兩道閘門。
>
> 建立 2026-08-12。目標文件＝[GOAL_PHASE_2.md](GOAL_PHASE_2.md)（分支 `docs/goal-phase-2`，`bfe2bdd`）。
> 本檔是**執行面**契約與進度總帳：把 14 項任務包成一次長跑，並定義中斷後如何續跑。
> GOAL 定義「做什麼、憑什麼算數」；本檔定義「怎麼跑、在哪停、怎麼接回來」。

## 為什麼要有這份檔

長任務會跨越多次 context 壓縮。壓縮後唯一還在的是 git 與本檔。
因此規則是：**每完成一項就 commit 並回填下方總帳一行**。
沒回填的工作視同沒做過——續跑時以總帳為準，不以記憶為準。

---

## 分段：不是一條龍，是三段加兩道閘門

一次跑完全部 14 項在物理上不可能，因為其中兩項需要真人開口說話。
誠實的切法如下。

### S1 自動段（無人值守，12 項）

序 0 → 序 6，即 E1、E2、baseline、A1、A4、A2、A3、B1、B2、D1、C2、C3。

這一段我可以連續跑完，中途只在下方兩道閘門停下。

**S1 的驗收邊界必須說清楚**：B1／B2 在自動段只能做到「停頓來源移除 ＋ 全套測試綠」。
**數字②（連續講話 10 分鐘、主執行緒 0 個 >50 ms long task）需要 DevTools 人工錄製，
併入 S2**。自動段不得宣稱數字② 已達成——那會是跨級宣稱。

數字①（failover 斷窗 ≤3 s）則可在自動段完成判定：量尺是 e2e 故障注入時間戳，
機器可跑、可證偽。

### 閘門 G1：E2 判定要升級型號

E2 若查出更新的專用翻譯型號，改 pin 會影響手測環境，屬計畫外變更。
**停下，列「改哪一行、舊值、回退方式」給使用者裁決後再動。**
若判定現行 pin 即當日最新（預期路徑），不停，直接續跑。

### 閘門 G2：S1 完成，交付 S2 手測

S1 全綠後停下，向使用者提出手測計畫（幾段、各幾分鐘、用哪把 key），
**經同意才開始燒配額**。

### S2 人工段（需要使用者）

- 真實會議手測：兩個 provider 各一次、中途手動切換一次、Stop 一次。
- Gemini 那次拆 32 ms／100 ms 兩段（D2），讀 `lagP50/P95`。
- 同場錄 DevTools Performance，補完 B1／B2 的數字②。

我能做的：寫好逐步操作腳本、在旁讀數、落檔。開口說話與按錄製鍵必須是人。

### S3 收尾段（自動，1 項）

C1 延遲文案，依 S2 產出的實測數字改寫。跑完整套驗收，寫階段 2 結案報告。

---

## 停止條件（觸發即停，不自行繞過）

1. 任一項落入 `blocked` 三類之一（外部不可逆待授權／計畫資源真缺／已依證偽記錄）。
2. `tests/e2e/online-keepalive.spec.ts` 等既有回歸網轉紅且原因非預期。
   **不得為過測放寬斷言**——放寬即等於刪掉這一輪的保護網。
3. 需要改動 GOAL 的硬規則才能繼續（zod enum、模型 pin、靜默 fallback、
   `tests/fixtures/upstream-contracts/`、key 處理）。
4. 累積 3 項連續失敗且無新資訊——停下重新診斷，不進入盲試迴圈。

「難／久／繁瑣／不確定」**不是**停止條件。正確映射是拆小、checkpoint、跑完。

---

## 每項的收尾儀式（一致，不省略）

1. 改動 → 跑該層測試（web／online／contracts／e2e 擇相關者）。
2. 新增的回歸測試須先在未修狀態失敗，貼修前／修後兩份輸出。
3. commit（conventional commits，一項一 commit，訊息寫清「為何」不只「做了什麼」），
   **body 末尾固定帶一行 `Run: P2-ONLINE / <序>-<ID>`**（例：`Run: P2-ONLINE / 2-A1`）。
   代號進 commit 的用意是可稽核：`git log --grep='Run: P2-ONLINE'` 一次撈出整條長跑，
   壓縮後重建進度不必依賴記憶，也不會跟同分支上的其他改動混在一起。
4. 回填下方總帳：狀態、commit sha、證據位置。

## 總帳（唯一真相，續跑時先讀這裡）

狀態用五標記：`completed` ／ `partial` ／ `running` ／ `deferred(附因)` ／ `blocked`。

「commit」欄填 commit trailer 的 `<序>-<ID>`，不填 sha——sha 在寫這一行的當下還不存在，
事後補填反而容易漏。用 `git log --grep='Run: P2-ONLINE / 0-E1'` 即可定位到該 commit。

| 序  | 任務                      | 段  | 狀態      | commit | 證據                                                               |
| --- | ------------------------- | --- | --------- | ------ | ------------------------------------------------------------------ |
| 0   | E1 上游型號實查           | S1  | completed | 0-E1   | `docs/MODEL_RECENCY_2026-08-12.md`                                 |
| 0   | E2 pin 裁決               | S1  | completed | 0-E2   | 同上（E2 裁決節）；G1 未觸發                                       |
| 1   | 數字① baseline 量測       | S1  | completed | 1-BASE | `docs/FAILOVER_BASELINE_2026-08-12.md`（A1 31162 ms／A3 30207 ms） |
| 2   | A1 Gemini 故障訊號提前    | S1  | completed | 2-A1   | 31055 → **2014 ms**（同一把 DOM 探針；web 296 綠、e2e 32 綠）      |
| 2   | A4 Gemini Stop 收尾       | S1  | pending   | —      | —                                                                  |
| 3   | A2 Standby 熱備           | S1  | pending   | —      | —                                                                  |
| 4   | A3 OpenAI 故障續期        | S1  | pending   | —      | —                                                                  |
| 5   | B1 latency-monitor 持久化 | S1  | pending   | —      | —                                                                  |
| 5   | B2 保存寫入非同步         | S1  | pending   | —      | —                                                                  |
| 6   | D1 chunk 註解修真         | S1  | pending   | —      | —                                                                  |
| 6   | C2 單 provider 啟動       | S1  | pending   | —      | —                                                                  |
| 6   | C3 音訊失敗狀態           | S1  | pending   | —      | —                                                                  |
| 7   | 真實會議手測（含 D2）     | S2  | pending   | —      | —                                                                  |
| 8   | C1 延遲文案               | S3  | pending   | —      | —                                                                  |

## 終局驗收（S3 之後跑一次）

```bash
pnpm -r test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:e2e
```

測試數只能增加。基準以序 1 當次重跑的數字為準（GOAL 內 7/30 的數字已標未重驗）。

階段 2 的結案條件＝數字①（≤3 s，機器可證）＋數字②（0 個 long task，人工錄製）
＋ UI 無跨級宣稱，三者皆有證據落檔。缺任何一項就是 `partial`，不寫成完成。
