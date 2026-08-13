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

數字①（failover 斷窗 ≤3 s）可在自動段完成判定：量尺是 e2e 故障注入時間戳，
機器可跑、可證偽。

**2026-08-13 更正：數字② 也不必等人工錄製。**
原本寫「需要 DevTools 人工錄製，併入 S2」，那是我的假設，沒查證過。
瀏覽器自己就有 `PerformanceObserver` 的 `longtask` 條目——與 DevTools 顯示的是同一個定義，
只是由頁面自己讀，而且可重跑、可證偽，比目視判讀強。量測見
`tests/e2e/caption-longtask.spec.ts`（真 Chromium、真 store／React／持久化，只有傳輸是 mock）。

### 閘門 G1：E2 判定要升級型號

E2 若查出更新的專用翻譯型號，改 pin 會影響手測環境，屬計畫外變更。
**停下，列「改哪一行、舊值、回退方式」給使用者裁決後再動。**
若判定現行 pin 即當日最新（預期路徑），不停，直接續跑。

### 閘門 G2：S1 完成，交付 S2 手測

S1 全綠後停下，向使用者提出手測計畫（幾段、各幾分鐘、用哪把 key），
**經同意才開始燒配額**。

### S2 人工段（縮小為 D2 一項，且不擋結案）

原本規劃三件事，其中兩件在 S1 期間查證後不需要人：

- 數字② 改由 `longtask` 量測，見上。
- C1 延遲文案的正解不是「填上實測數字」，而是**把沒量過的數字拿掉**
  （完成條件原文：「沒量過的不寫」）。移除不需要真 key。

剩下**只有 D2**：Gemini chunk 32 ms／100 ms 的 screening 比較，需要真人講話與真配額。
它是「順手」項，合法終態包含「未分出勝負，維持現值」，**不在三個結案條件之內**。

### S3 收尾段

C1 延遲文案 ＋ 全套驗收 ＋ 結案報告。已不依賴 S2。

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

| 序  | 任務                      | 段   | 狀態                                       | commit | 證據                                                                                                           |
| --- | ------------------------- | ---- | ------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| 0   | E1 上游型號實查           | S1   | completed                                  | 0-E1   | `docs/MODEL_RECENCY_2026-08-12.md`                                                                             |
| 0   | E2 pin 裁決               | S1   | completed                                  | 0-E2   | 同上（E2 裁決節）；G1 未觸發                                                                                   |
| 1   | 數字① baseline 量測       | S1   | completed                                  | 1-BASE | `docs/FAILOVER_BASELINE_2026-08-12.md`（A1 31162 ms／A3 30207 ms）                                             |
| 2   | A1 Gemini 故障訊號提前    | S1   | completed                                  | 2-A1   | 31055 → **2014 ms**（同一把 DOM 探針；web 296 綠、e2e 32 綠）                                                  |
| 2   | A4 Gemini Stop 收尾       | S1   | completed                                  | 2-A4   | 修前紅／修後綠（web 297 綠、keepalive 14 綠）                                                                  |
| 3   | A2 Standby 熱備           | S1   | completed                                  | 3-A2   | 自動接手 **2020 ms**、擷取只開一次、逐字稿保留（web 305 綠）；A1 的 e2e 併入本項並補上 A2 一條，e2e 維持 32 條 |
| 4   | A3 OpenAI 故障續期        | S1   | completed                                  | 4-A3   | 30031 → **1028 ms**；**數字① 達成**（web 305 綠、e2e 32 綠）                                                   |
| 5   | B1 latency-monitor 持久化 | S1   | completed                                  | 5-B1   | 寫出移到 idle，取樣語意未動。**修前修後皆 0 個長任務——見下方「B 區前提不成立」**                               |
| 5   | B2 保存寫入非同步         | S1   | completed                                  | 5-B2   | 例行寫入移到 idle；`flush` 維持同步。同上                                                                      |
| 6   | D1 chunk 註解修真         | S1   | completed                                  | 6-D1   | 註解改中立敘述並註明 7/28 反向觀測                                                                             |
| 6   | C2 單 provider 啟動       | S1   | completed                                  | 6-C2   | Gemini-only 子行程實測 `ok:true`、`/session/info` 只列 gemini；online 65→68 綠                                 |
| 6   | C3 音訊失敗狀態           | S1   | completed                                  | 6-C3   | 修前紅／修後綠（`degraded`→`failed`、`microphone`→真實來源）；web 305→307 綠                                   |
| 7   | D2 chunk screening        | S2   | deferred（需真人講話＋真配額；非結案條件） | —      | 待手測；合法終態含「未分出勝負，維持現值」                                                                     |
| 8   | C1 延遲文案               | S3   | completed                                  | 8-C1   | 移除無實測背書的「落後語音 2–3 秒」；UI 現在不含任何延遲數字                                                   |
| —   | 數字② 量測                | S1   | completed                                  | 8-N2   | 0 個 >50 ms 長任務（2000 段逐字稿、保存開啟、90 s 驅動；**含儀器控制組**）                                     |
| 後  | Error boundary            | 後補 | completed                                  | 9-EB   | 修前 `body` 全空（白畫面）／修後可讀；e2e 33→34                                                                |

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

**S1 結束時實跑（2026-08-13，六條全綠）**：contracts 19／online 68／web 307／e2e 32。
起點是 contracts 19／online 65／web 295／e2e 30。

階段 2 的結案條件＝數字①（≤3 s）＋數字②（0 個 long task）＋ UI 無跨級宣稱，
三者皆有證據落檔。缺任何一項就是 `partial`，不寫成完成。

## B 區前提不成立（2026-08-13，必須留檔）

B 區是為了修「講話時畫面停頓」而立的。等到真的量了，**那個停頓量不出來**。

在 2000 段逐字稿（`LS_TAIL_SEGMENTS` 上限，也就是這個 app 會寫出的最大負載）、
保存開啟、每秒約 10 個字幕 delta 連續 90 秒的條件下，
**修前與修後都是 0 個超過 50 ms 的長任務**。

過程中先量到三次「0」，後來發現那三次無效——`PerformanceObserver` 沒被觀測到，
因為透過自動化通道直接執行的程式碼不列入 long task 歸因。加了控制組
（頁面自身任務裡刻意阻塞 150 ms，斷言必須被觀測到）之後，量測才可信。
**這條控制組必須永遠留著**：儀器壞掉與主執行緒平順，輸出一模一樣。

因此對 B1／B2 的正確說法是：

- **可以說**：把同步 localStorage 寫入從字幕路徑上移開，是正確的衛生措施；
  數字② 在修後成立，且有可重跑的量測背書。
- **不可以說**：B1／B2 修好了某個實測到的 >50 ms 停頓。那個停頓從未被量到。
  `5-B1 5-B2` 那個 commit 的訊息寫成「able to make the thing they exist to
  observe stutter」，是超出證據的推論，以本節為準。

原始 7/28 稽核把這兩處列為「停頓源」，依據是「同步 I/O 在事件路徑上」的推理，
不是量測。推理方向沒錯，量級估錯了。
