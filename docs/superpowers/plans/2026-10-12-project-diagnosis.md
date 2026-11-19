# 2026-10-12 專案診斷與近期工作收尾

**目標：** 核對 10/08–10/10 純字幕、持久化、台灣用詞與失效切換交付，修復可重現缺陷，恢復可用的本機驗收與日常服務。

**依據：** `CLAUDE.md`、`docs/WORK_REPORT_2026-10-10.md`、`docs/PROJECT_STATE.md`、`docs/TODO.md`。保留現有大量未提交變更，不提交、不重置。依使用者本次授權直接執行診斷及必要修復。

**邊界：** 不將此工作擴成摘要／Electron／全新離線模型開發；不以受控上游證明真人辨識品質。不啟動新付費長測。Python 固定使用 `C:\Programs\miniforge3\envs\deve\python.exe`，所有 shell 呼叫循序執行。

## 執行與驗收

基線：預設 `pnpm test` 實際先被 `apps/web/.pytest_cache` 的 EPERM 阻斷。限制 web 探索在 `src/**/*.test.{ts,tsx}` 後，32 contracts、659 web、157 online（848）全數通過。這是測試入口修復，不代表整合驗收完成。

- [x] 重跑 JS、型別、lint 與預設 Chrome E2E；定位近期報告中的七個失敗，保留原始輸出。
- [x] 修正 `tests/e2e/openai-realtime.spec.ts` 過時瀏覽器替身及預設套件與 production 套件的配置邊界；維持字幕與健康狀態斷言。
- [x] 追查 `meeting-archive-client.ts` 永久性拒絕的重試與 UI 呈現；先加入失敗回歸，再做不丟資料、可明確重試的修復。
- [x] 審查近期 `App.tsx`／`meeting-recovery.ts` 的雙 provider 所有權與 Stop／重試；對具體缺陷補測並修正。
- [x] 重建 web 與 service bundle，跑純字幕原生 Chrome 保存／校訂／重載／匯出，以及切換與原生音訊相關回歸；跑 managed service 與 Python 回歸。
- [x] 檢查本輪差異、更新狀態與診斷報告，啟動並核對 managed service 的實際 URL／健康／生產頁面。區分已驗證、本機未交付、缺外部證據的事項。

結果與未完成的產品／外部驗收見 [診斷報告](../../DIAGNOSIS_2026-10-12.md)。本清單完成不等於整體產品或 T6–T15 完成。
