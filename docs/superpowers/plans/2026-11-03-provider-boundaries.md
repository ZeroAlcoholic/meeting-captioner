# 雲端／地端模組隔離施工計畫

日期：2026-11-03。依使用者本輪要求檢閱架構，為後續地端開工整理必要邊界。範圍是既有流程隔離，不重寫字幕、恢復或保存流程。

## 已確認問題與設計

- 實際 online Rollup module graph 仍包含 `offline-stt-provider.ts` 與 `use-hybrid-mode.ts`；只有 offline hook 做 alias 不足以隔離 Hybrid。
- managed 啟動與 ZIP 建置的 TypeScript target 仍包含地端實作及其測試；地端編譯錯誤會阻擋雲端。
- 舊 Hybrid 會議恢復入口未確認 deployment，可能在 online 版啟動地端。歷史須保留，不能靜默改送雲端。

目標目錄：`providers/offline/` 放地端 adapter／hook／專屬測試，`providers/hybrid/` 放跨服務編排及其測試。既有共用 capture、normalized contracts、store、archive 及雲端 providers 保持原位。App 只透過明確 build alias 取得地端／Hybrid 控制器；online 解析成可見 unavailable 的 capability，full 解析實作。

## 執行與驗證

1. 加入實際 TypeScript program／Vite build 的負向邊界測試，先觀察 online 載入地端的失敗。以虛擬 loader／compiler host 注入地端失敗，不修改工作中的產品檔案。
2. 移動地端／Hybrid 前端與專屬測試，更新相對 import；定義共用的小型控制器型別。兩條 alias 同時在 TypeScript 與 Vite 對應；保留 full 的真實地端實作。
3. 新增 online 專用 TypeScript target 與 build 指令，managed／ZIP 改走該 target。Vite online build 禁止跨入地端／Hybrid 實作目錄，取代錯把共用 PCM worklet 當地端的字串判定。
4. 舊地端會議於 online 版顯示無法續用的原因並停用 Continue；原文／譯文／匯出仍可存取，不取得媒體、不連地端。用 Chrome 驗證 offline／hybrid 歷史及正常雲端路徑。
5. 只跑受影響的前端／build／contract 邊界、online/full 建置與短程 Chrome；沿用未變更的 provider 邏輯與既有驗證，不重跑真 API／長測。
6. 更新 ARCHITECTURE／PROJECT_STATE／TODO 與本輪報告，保留版本指紋及未完成的地端契約／runtime／模型資源項目。

## 後續地端順序（本輪不施工）

先修 source／mode 契約語意與跨語言驗證，再處理明確 runtime、模型準備／本地執行分離、資源路徑及已知 stabilizer／MT worker 故障；之後才分別比較 MT、ASR 模型。現有 Python capture／pipeline／dispatcher 分層可保留，不為整理而搬移模型或新建 registry。

共用平台或 contracts 有變更仍可能合理影響兩端；目標是地端專屬修改不進入雲端依賴圖，不承諾所有共用變更零影響。
