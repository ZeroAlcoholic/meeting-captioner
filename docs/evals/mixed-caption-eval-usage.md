# A0 真人混語語料離線評分

此工具只讀取本機檔案，不呼叫 API、不新增套件。既有 24 個提示題不能直接當 gold：必須錄製真人音訊，再由人員依實際錄音校正參考逐字稿。`referenceKind` 是來源聲明，SHA-256 僅驗證檔案一致性；工具無法證明錄音是真人、逐字稿正確，或 train/test 未洩漏，仍需人工審查。

```powershell
node scripts/mixed-caption-eval.mjs path/to/manifest.json path/to/predictions.json test
node --test scripts/mixed-caption-eval.test.mjs
```

stdout 輸出 JSON；exit 0 表示已觀測資料過門檻、1 表示未過、2 表示輸入或檔案驗證失敗。可以重新導向至本機報告。即使 exit 0，`productionReady` 一律 false；小樣本不能證明正式可用。

manifest 範例結構（SHA 值請填實際錄音的值，不能原樣使用）：

```json
{
  "version": 1,
  "samples": [
    {
      "id": "speaker01-session01-01",
      "scenario": "technical-code-switch",
      "split": "test",
      "audio": "audio/speaker01-session01-01.wav",
      "sha256": "填入64字元小寫SHA256",
      "referenceKind": "human-transcribed",
      "reference": "今天 deploy API",
      "criticalTerms": ["API"],
      "speechStartMs": 100,
      "speechEndMs": 1100
    }
  ]
}
```

predictions 格式：

```json
{
  "version": 1,
  "samples": [
    {
      "id": "speaker01-session01-01",
      "text": "今天 deploy API",
      "firstTextMs": 500,
      "finalTextMs": 1500
    }
  ]
}
```

所有時間以同一個音訊播放起點的單調時鐘毫秒表示。首字延遲 = firstTextMs − speechStartMs；final 延遲 = finalTextMs − speechEndMs。firstTextMs 指 UI 首次呈現非空文字，finalTextMs 指該語料完整最終文字到達。缺少量測請省略欄位，不能填 0。每筆需是完整可對齊的 utterance；跨句串流須先以實際 item 關聯整理，不可按完成事件到達順序盲配。

工具拒絕不明欄位、重複／不明 IDs、錯誤 split、SHA 不符、路徑越界、無效時間及非人工參考稿。manifest 必須全屬指定的 `test` 或 `validation` split；事先以說話者／錄音 session 分組切分，不能將同一段或同一錄音衍生片段分散至調校與評估。工具不自動選樣或忽略其他 split。

評分規則：

- NFKC、英文小寫；中文只取 Han 字元，英文以 ASCII 字母／數字（含字內 apostrophe）切詞。標點／空白不計分，不做繁簡轉換。中英分流會忽略跨語言詞序，需搭配逐例人工檢查；非 Han／非英文語音不在此評分範圍。
- 分場景以字／詞數加權的 Levenshtein edit distance 計算 CER／WER；無該語言參考字詞則比率為 null，若仍有該語言插入錯誤，門檻不通過。
- critical terms 必須實際出現在參考稿；NFKC／大小寫不敏感、保留詞內標點與空格，檢查英文詞邊界。逐例回報漏失；每例每個 term 算一次，非重複次數。沒有 term 的場景 recall 為 null。
- 缺少 prediction 以空字串計入刪除錯誤，並明列缺樣本；缺少延遲也明列。任何缺樣本／缺延遲都不通過。延遲 p95 為 nearest-rank，少量樣本時接近最大值。
- 固定品質門檻：各有樣本場景 **CER ≤ 10%、WER ≤ 15%、critical terms recall ≥ 95%**；整體 **首字 p95 ≤ 2000 ms、final p95 ≤ 3000 ms**。整份語料必須有中文、英文與 critical terms 才能通過。這些門檻不因樣本少而放寬；未涵蓋場景與 sample-size sufficiency 仍須在 A0 審查列明。
