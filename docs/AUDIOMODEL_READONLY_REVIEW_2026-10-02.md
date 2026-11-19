# audiomodel 唯讀參考：另一套會議翻譯方案的可行性

範圍：唯讀 `C:\Develop\audiomodel` 的 README、demo／static 程式與設計／review 文件；
未修改、啟動、import 執行該專案，未下載模型、未呼叫翻譯 API。部分 artifacts 目錄不可讀，
本結論依實際主程式與可讀文件，不宣稱已驗證其所有歷史測試結果。

## 結論

可以成為另一套系統的 ASR 前半段，但它目前不是完整翻譯系統。
不需要因「只有 ASR」而否定方案，也不能把 OpenCC 繁中字形轉換當成英翻中。
現階段建議作為本機原文／缺口辨識候選，維持 meeting_audio 的專用即時翻譯主線。
獨立另一套產品屬後續選項，本次沒有建立或切換任何正式系統。

## 已讀取的具體能力

| 項目         | 證據                                                                           | 結論                                                  |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 本機串流 ASR | `demo/native.py:96` 載入 Nemotron 3.5 ASR Q8 GGUF，經原生 NeMo C ABI／CUDA     | 是原文辨識，不是跨語言翻譯                            |
| 支援語言入口 | `demo/server.py:91` 接受 zh-CN／auto／en-US；`static/app.js:448` UI 固定 zh-CN | 後端有英文入口；現有 UI 不能直接當英文會議已整合      |
| 繁中處理     | `demo/text.py` OpenCC s2tw＋正字置換                                           | 不能將英文語意翻為中文                                |
| QC           | engine／rules／workflow 使用原文修訂與保險規則                                 | 不需移植到會議翻譯產品                                |
| 本機紀錄     | `demo/audit.py` 依通話 JSONL append、修訂差異與 final snapshot                 | 可參考事件／revision 追溯，不是直接符合新持久保存方案 |
| 保存耦合     | `demo/server.py:266` await audit 後才送 WS；audit 只 file.flush                | 慢磁碟可能延後字幕；未提供每次 fsync 的斷電耐久承諾   |
| 自動恢復     | README 明示不暗中重連舊 session；前端積壓 >2 秒會 fail 並要求重新開始          | 不能當現成「零人工救援」解法                          |
| 容量／時間   | server 每通 7200 秒上限；audit 每通 32 MiB；最多 4 路                          | 需改為有界接續與容量管理，不能直接套入長會議驗收      |

官方模型卡定位為多語 ASR，列 English 與 Mandarin 的辨識支援，並非英中翻譯模型；
支援語言不等於本機 Q8／目前 UI 已通過相同品質驗收。
[NVIDIA 模型卡](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)。

## 可成立的兩種翻譯組合

1. **本機 ASR＋本機文字翻譯**：audio → Nemotron → 原文 → MT → 譯文。
   沒有雲端推論用量；但會用本機 CPU／GPU，需驗英文、中英混講、術語、繁中翻譯品質與延遲。
   meeting_audio 已有 `services/offline/app/pipeline/translation.py` 的 CTranslate2／OPUS-MT
   路徑可先評估，不能僅因有程式／模型檔就宣稱可用或品質相當。
2. **本機 ASR＋文字翻譯 API**：音訊留在本機，文字以段落／修訂送翻譯。
   不必維持雲端音訊 session，但仍有網路、文字資料外送、配額與費用。
   meeting_audio 的 `use-hybrid-mode.ts`／`routes/translate.ts` 已有相關路徑。
   不能先宣稱一定比較便宜或更快，需按實際字量、修訂頻率與品質比較。

兩者都不需要把介面做成互動聊天。ASR 出錯會傳到翻譯；只等 final 可能變慢，
對每個 partial 都翻則可能產生修訂抖動與重複成本。需要穩定片段政策、revision-aware
佇列與不覆蓋新 live 的歷史修訂。LOG／TEXT 保存、去重、恢復和匯出仍全部 LOCAL。

## 最小試驗與採用條件

- 保持參考專案唯讀；在 meeting_audio 隔離測試介面，先以保存過的 normalized 範例測契約。
- 本機模型實測另列明確工作，不在唯讀參考階段啟動；共用 8787 連接埠須避開。
- 移除保險規則的資料流耦合，適配原文／revision／時間基準，而非整套 UI 複製。
- 優先比較固定 5–10 分鐘代表性語料的原文品質、MT 品質、GPU 用量、延遲與人工救援次數。
  這是候選試驗設計，不是本輪已執行的成果；不包含自動付費測試。
- 通過才將其列為 T09 補錄 provider 或獨立 ASR＋MT 支線；未通過不延誤現有連線缺陷修復。
- 參考其 revision／稽核設計，不沿用「保存等待後才出字幕」「積壓要求重啟」「固定兩小時停止」政策。

工程上可組合；目前缺的是經驗證的翻譯與會議級自動恢復，不是完全沒有可重用的基礎。
