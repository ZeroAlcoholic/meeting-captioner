# 本專案獨立服務啟動計畫

使用者要求解決 agent 重複啟動及 PORT 互搶。本次只改日常線上服務的生命週期，
不改字幕 provider 或把未就緒離線引擎包成可用功能。

## 設計

- 對 canonical workspace path 雜湊，建立本機 IPC 控制位址。由 OS bind 決定
  唯一 owner；不以 PID 檔、先掃埠再啟動、或程序名稱作為所有權證據。
- owner 取得控制位址後才建置／啟動。重複或同時 start 讀取相同 owner 狀態。
- 日常只啟動一個 Node，服務正式線上版網頁與 API；預設 43871，若實際 bind
  遇 EADDRINUSE／EACCES 則直接 bind port 0，保存並顯示 OS 分配的實際網址。
- 狀態提供 instanceId、workspaceId、PID、buildId、url、phase；HTTP 身分端點
  與 IPC 狀態可交叉確認。停止走本機 IPC 且檢查 instanceId，不依埠號殺程序。
- 每次啟動的 web／server 建置存至自己的快取目錄；後續 repo build 不覆寫
  已服務的 hashed assets。start 重用既有版本；更新使用 stop 再 start。
- 所有控制與狀態檔不保存 API keys。服務只綁 127.0.0.1。
- 舊 dev／release 指令保持相容，文件及 package scripts 明確指定唯一日常入口。

## 實作順序

1. 先加入 Node lifecycle 測試並觀察失敗：同時啟動只一個 owner、占埠時退讓、
   異物服務不被停止、假 instanceId 不可停、殘留 manifest 不算 live instance。
2. 加入 scripts/managed-service.mjs：IPC、身分、HTTP bind、狀態及關閉。
3. 加入 scripts/service-build.mjs 與 scripts/service.mjs：專屬 build、背景啟動、
   start/status/stop；build-bundle 支援受管理的無自動啟動輸出。
4. package scripts／Windows start-service.cmd／README／RUNBOOK／PROJECT_STATE 更新。
5. 跑 lifecycle、既有 online、typecheck、實際 Chrome 正式網址與資產／API；
   受控占用候選埠、重複啟動、停止及重啟均需實測。
6. 驗證前輪由本代理建立的 PID 與身分後，停止舊 8787／8000，只留下新日常服務。

## 完成條件

所有權測試及真實啟動通過；重複 start 回傳相同身分與網址；碰撞不傷其他服務；
停止只影響匹配 instance；實際網頁 Demo 可運作；目前服務網址可透過 status 找回。
不宣稱保留了全球唯一 PORT，也不把本機可用當成真 API 翻譯驗收。

## 本次執行結果

- 支援範圍明確限定 Windows named pipe；不宣稱 POSIX stale socket 自動復原。
- 6 個實際 IPC／HTTP lifecycle 測試通過，含異常 payload 與 kill 後重啟。
- 525 個 web、91 個 online 回歸通過；typecheck、原始 `pnpm lint` 通過。
- 真正占住 43871，並行啟動兩次 CLI，得到同一 instance/PID/fallback URL。
  Chrome Demo 顯示中英字幕；HTTP CORS 不授權原埠 origin；停止後異物服務仍在。
- 實測發現 online-only 的 Hybrid hook 仍探測 8000，先建立失敗測試再修正；
  online-only 零離線探測，full 模式仍保留健康探測。
- 最終啟動於 `http://127.0.0.1:43871`；核對舊 PID、啟動時間與 HTTP 身分後，
  已關閉前輪建立的 8787／8000，僅留下 managed Node。
- 保留證據 `.cache/meeting-service/verification.json`；本次未送音訊到雲端。
