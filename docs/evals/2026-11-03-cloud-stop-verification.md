# 雲端翻譯 Stop 尾文修復與驗證紀錄

日期：2026-11-03。範圍：現有 OpenAI／Gemini 翻譯的停止、尾文保存及新場隔離；未更換模型、未新增依賴、未啟用音訊補送。

## 結論與修復

1. Gemini Stop 雖保留 bounded drain，socket 接收端卻只接受 running，導致 Stop 後的新尾文及完成訊號全部被丟棄。已允許目前 socket 在 drain 期間只接收內容；錯誤結束 drain，setup／GoAway／resumption 不得恢復健康或重開連線。
2. OpenAI 使用者 Stop 原先立即關閉 transport。現沿用既有退休連線的 snapshot drain，立即停收音、取消恢復，送 session.close 並有界接收尾文。上限維持 10 秒；session.closed 後沿用 250ms grace。hook 回傳完成 Promise；App 與遠端軌等待尾文完成後才結案。替換／unmount／第二次 Stop 仍可強制回收，不讓新場等待舊線。
3. 獨立審查找到 Gemini 同一 frame 的 final 回呼若同步重啟，剩餘 output 可能寫入新 generation；紅測重現後，已在外部回呼／定稿之後核對 generation，截斷舊 frame。

OpenAI WebSocket 關閉語意已核對 [官方指南](https://developers.openai.com/api/docs/guides/realtime-translation#close-a-websocket-session)。WebRTC 沿用專案既有退休連線做法；本輪不將 WS 文件推論為 RTC 真雲端資格。

## 直接證據

- 初始完整單元：37 contracts＋956 web＋211 online＝1,204 項通過，但未涵蓋新增尾文。
- Gemini 尾文、OpenAI 三種收尾、Gemini 同步重啟均先觀察有效紅測；原始日誌：`.cache/cloud-20261103-gemini-red.log`、`cloud-20261103-openai-red.log`、`cloud-20261103-gemini-reentrant-red.log`。
- 最終完整單元：37 contracts＋960 web＋211 online＝**1,208 項通過**；`.cache/cloud-20261103-unit-final.log`。未改門檻、未跳過失敗案例。
- Chrome production 兩家 Stop 尾文→畫面→SQLite→JSON 匯出 **2 案通過**；`.cache/cloud-20261103-stop-browser.log`。雲端與擷取受控，SQLite／瀏覽器／實際下載檔案為真。
- Chrome 連線／續期／跨廠接管／操作／WebSocket 收尾 **20 案通過**；`.cache/cloud-20261103-reliability-browser.log`。此輪在最後 Gemini generation guard 前執行，不冒稱為最終版全矩陣。
- 上述受控跨廠首筆文字觀測為 Gemini→OpenAI 2238ms、OpenAI→Gemini 2160ms；各方向單次觀測，不是真雲端延遲或 p95。
- 最終程式的 Chrome 針對性確認 **5 案通過**：正式建置 `index-BwY0gnmF.js` 的兩家尾文／SQLite／匯出 2 案（6.7 秒）；dev build 的 WebSocket 尾字、Gemini 新場隔離及 20 輪字幕／操作回應量測 3 案（25.0 秒）。日誌：`.cache/cloud-20261103-stop-final-browser.log`、`cloud-20261103-focused-final-browser.log`；不將 dev build 的流暢度量測冒稱 production 效能。
- 最終 typecheck、完整 eslint、build 通過：`.cache/cloud-20261103-{typecheck,lint,build}-final.log`。建置既有大 chunk／bundle import.meta 警告仍在，未以本次 Stop 修補展開無關重構。

## 尚未驗證

未呼叫付費真 API，沒有本次素材／費用範圍的回覆；未取得真人會議品質、公司網路、實體裝置及完整長測的新資格。原有 18／26 LOCAL 與 W12／場域待驗狀態不因這次小範圍修補而變更。收尾 cap 只保全已收到文字，不能保證上游已排空或零漏字。

## 後續啟動與接續規則

依使用者 2026-11-03 指示，**不因重開服務或新工作階段重跑本輪驗證**。以本紀錄、原始日誌及下方版本指紋沿用結果：只有相關程式／設定／runtime／網路或模型有實質變更，才針對變更邊界補驗。日常使用維持 service:status／service:start，不把測試加入啟動路徑。

真 API 品質及場域長測屬一次性待取得的資格，不得用本機通過結果補勾；取得後同樣記錄條件與版本並沿用。NVIDIA 模型調研見 [同日報告](2026-11-03-nvidia-realtime-translation.md)，只屬官方資料調研，未導入產品。

## 最終版本指紋

本輪 Node.js v24.14.0；瀏覽器使用本機 Google Chrome channel。

下列 SHA-256 為本輪驗證後的檔案內容；用於判斷是否需要補驗，不是雲端可用性證明。

```json
{
  "apps/web/src/providers/gemini-live-provider.ts": "78bbf7b94004e569f7faf5818e4294b8ca0f1755f47a15e1a8db0d3454d68cd4",
  "apps/web/src/providers/openai-realtime-provider.ts": "f4dd2886f42be3b039165930a665252144d987a05075f7cc8cbbd70c6f765eff",
  "apps/web/src/providers/gemini-live-provider.test.ts": "36828804d24b69b5e7d6606c5123594bb85074b8db0958f7f18f0cd59ead35eb",
  "apps/web/src/providers/openai-realtime-provider.test.ts": "61efd1af1bd57f9c079185eb24063139b882ab077abaef42067ab03ba8bbd6b4",
  "tests/e2e/translation-archive.spec.ts": "4379129dee8c007afdcbaeee1fe8eaabb82e67550f77251beef9e907d63e537c",
  "apps/web/src/providers/use-openai-realtime.ts": "601c50ded15585fd1d33a7ce48e1a2ec439de3027bfc77c0ea03a051dc69bfa3",
  "apps/web/src/providers/online-hooks-lifecycle.test.ts": "a9b9722b911b8b4d375329b2aabaa83dc597e7be0fa4db7800cb5fabf3bc295b",
  "apps/web/src/App.tsx": "a0a93e45baed3f9041e32b60766ea3db16261c592df0e595f1493504f2b7ca05",
  "apps/web/src/components/RemoteTranslationTrack.tsx": "f50fcceba58c24f2b5fd9df539d5e66bf49108c9c9edabf4a4eed9d0e03ff5cf",
  "tests/e2e/openai-websocket.spec.ts": "799167e182eb8a72469cb88a01d1d50b3a21ecff07cfe4972bc65d373100705f",
  "pnpm-lock.yaml": "eee9a8b432617a8920aa3b8b5cd29ffdb3398eb8cba2c2f87f325dad015484a6"
}
```
