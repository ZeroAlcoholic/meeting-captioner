# 線上字幕診斷 — 2026-09-11

## 目標與範圍

本次使用者明確優先要求：**線上模型必須順、快、保持最新且品質好**。
工作排序以線上字幕的實際延遲、連續性與翻譯品質為準；離線、Hybrid、摘要與
打包不擴充。這取代 `PLAN_2026-08-28.md` 將 Summary 排為下一個開發主項的順序。

## 第三輪：正式應用、真實音訊與 API

使用 12.75 秒英文合成語音，內容包含明天 9:30、營收增加 12%、週五前交報告、
不取消專案、9 月 15 日複查。透過 Chrome 原生 getUserMedia／音訊處理管線注入 WAV，
執行正式前端與本機正式服務，使用真實 OpenAI／Gemini API；未送使用者會議內容。

實際結果：

- OpenAI WebRTC、Gemini 均持續出現繁中字幕；正式畫面已核對。
- 刻意使 SDP 回 401 後，真正 OpenAI WebSocket 仍能翻出全部五項資訊；
  僅故障觸發為注入，後續音訊傳輸和模型輸出沒有 mock。
- 另一個只有 OPENAI_API_KEY_AUDIO 的服務實際選用 audio slot，正常收音及出字。
- 同一頁 OpenAI → 暫停／恢復 → Gemini → OpenAI 均重新出字，歷史保留。
- 主動關閉實際 socket 後，Gemini 與 OpenAI WS 均自行重新連線並翻譯後續語音。
  本次各一次 socket 重開為 1,302／2,864 ms；不是首字幕延遲或 P95。
- OpenAI WebRTC 與 WS 各以同一句語音播放兩遍，僅把續期建議時間縮至 18 秒，
  其餘媒體與雲端推論均為真實路徑。多次換線後由 UI 匯出文字，兩次日期、
  週五與否定句均保留；每輪至少完成兩次舊連線尾譯接收。
- 上述停止後，擷取 track 均 ended，peer／socket 均 closed。

實際缺陷及修正：

- 12 秒硬分段曾把「九月十五／日」、「我們不會／取消」拆開，導致大字只剩尾字
  或遺失否定上下文。現在 normalized transcript 可帶 continuationOf；展示只取前一段
  有界尾文，最多 160 UTF-16 單位，不遞迴、不改寫歷史或匯出原文。
  已用單元、Chrome DOM 及真實模型輸出重測。
- 開場 SDP 201 曾過早顯示正在聆聽。現在等 PC connected 或真正 session 事件；
  正式 Chrome 觀察到 permission → connecting → listening，listening 時 PC 已 connected。
  WS 初次備援等待也維持連線中提示。
- WebRTC 續期原在候選 SDP 完成就關掉健康舊連線。現在等候選真正 connected，
  換線前再檢查一次；失敗、關閉或 10 秒逾時保留舊線；Stop 取消候選與等待。
- 真實重複語音進一步揭露：換線即關舊連線會丟掉尚未送回的尾譯，修正前兩遍
  語音匯出只剩一份日期／週五／否定句。現在新線接手後，舊線停止送音訊、
  送出 session.close，獨立接收尾譯並更新原段，不干擾新字幕。session.closed
  後保留 250 ms 靜默寬限以接收晚到原文，上限 10 秒，最多一條待收尾連線。
  錯誤、上限或 Stop 保留已收到文字並關線；Stop 立即釋放收音，不承諾待譯尾文全回。

不要把成功樣本當作完美品質：早期 2 秒前置靜音的 OpenAI 開場曾缺字；改以
8 秒前置靜音確認連線就緒後原文完整，並修正上述過早提示，沒有宣稱提供開場預錄。
相同音訊不同輪次仍出現 OpenAI 把 meeting 翻成「媒體」、Gemini 漏掉 Friday，
及 OpenAI 重連靜音時多出「還有」。這些是已觀察到的模型品質限制，未隱藏或改寫。
本次未建立真實會議的延遲排名，未實測 Teams／Zoom、遠距多人及整場 60–90 分鐘。

最終回歸：web 382、online 86、contracts 20 通過；尾譯修正後 Chrome 全集 38 案例全過。
過程中補齊舊 mock 的原生 connectionState 與 sender.replaceTrack／session.close 行為，
沒有放寬斷言。保留 2,000 段歷史、90 秒持續字幕仍量得零個 >50 ms 長任務。
最終建置 JS 820.99 kB／gzip 612.95 kB，未宣稱初載更快。

本機證據保存在 .cache/live-final-results.json、live-lifecycle-results.json、
live-reconnect-results.json、live-renew-drain-results.json、
live-ws-renew-drain-results.json 及 final-\*.png。續期結果含 UI 匯出全文；
WS 此輪仍有開頭誤譯及漏掉「明天」，尾譯修復不代表翻譯完全正確。
下方第一、二輪數字為歷史結果。

## 第二輪校準：環境、雙管道與版本

第二輪新增重點為不同環境的 KEY 選用與實際連線。以下是本輪直接證據，
不沿用 8/20 公司 KEY 在特定網路被拒絕的結論：

| 目前環境的真實檢查 | 結果                                           | 範圍                               |
| ------------------ | ---------------------------------------------- | ---------------------------------- |
| OpenAI primary     | mint 200、WebSocket `session.created`、SDP 201 | 專用 translation endpoint          |
| OpenAI audio       | mint 200、WebSocket `session.created`、SDP 201 | 專用 translation endpoint          |
| Gemini             | v1beta mint 200、WebSocket `setupComplete`     | 現行模型與既有 golden setup schema |

三組 KEY 目前皆存在於 process environment。檢查只輸出 slot／HTTP status／
握手成功與否，沒有輸出密鑰、token 或 SDP。沒有擷取或送出會議音訊；
SDP 使用 Chrome 建立但未接上媒體的 audio transceiver。因此這是**真實握手證據**，
不是完整音訊出字、不同辦公室／VPN 網路、延遲或品質的驗收。

本輪修正：

- Windows／Bash 發行版啟動器原只接受 primary，錯擋 audio-only 與 Gemini-only。
  現在任一有效 KEY 即可啟動；Windows 改用 ASCII、CRLF 與 Node 讀環境變數，
  避免 CMD 解析 Unicode／換行或直接展開 KEY 的問題。實際啟動器用三種單 KEY
  與無 KEY 環境共八個案例驗證，bundle 用測試入口隔離，不呼叫供應商。
- KEY 去除頭尾空白，純空白視為未設定；audio-only 的 startup 診斷不再誤報 MISSING。
- OpenAI 的通用 1008 policy close 不再當作 auth；`ip_not_authorized` 等明確原因
  仍可切 KEY，普通 payload 或 request number 不會切換帳號。
- Gemini token、WebSocket 與維護用 probe 一起改成 v1beta；專用模型未更換。
  依 [現行官方指南](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
  及本輪真實 `setupComplete` 驗證，這是協定相容性更新，沒有宣稱推論變快。
- Gemini 加入工作階段 generation 檢查。初始 token、reconnect token 與 worklet
  晚完成時，不能復活已停止的流程、換掉／關掉新連線或污染新工作階段的 health。
  六個 regression 先重現失敗，再修正。
- 同 provider 在麥克風權限等待期間重啟，共用 pending acquire，避免重複 claim
  音訊 lease；兩個額外案例驗證重啟接管與停止後釋放晚到的 grant。
- 真實 Chrome 重現「未完成句子 → Stop → 立即新 Start」把舊 final 寫回新會議。
  `handleStartGemini` 現在先停止舊 drain 並 flush，再 `beginSession` 清空。
- 同大版本相容更新：Fastify 5.8.5 → 5.12.3、Zustand 5.0.13 → 5.0.15、
  OpenCC 1.3.1 → 1.4.2；鎖檔同步更新。版本依 npm registry 查核；
  [Zustand release](https://github.com/pmndrs/zustand/releases/tag/v5.0.15)
  與 [OpenCC release](https://github.com/nk2028/opencc-js/releases/tag/v1.4.2)
  另有官方變更紀錄。沒有把版本號當作延遲改善的證據。

不同環境的操作與 30 分鐘 key demotion 恢復條件，見 [RUNBOOK](RUNBOOK.md)。
模型版本與框架套件版本分開評估；React、Vite、TypeScript 等另有跨大版本更新，
此輪不把框架遷移混入 provider 修正，也不宣稱所有依賴已是最新。

第二輪最終回歸（包含上述套件更新）：

| 檢查                   | 結果                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| web／online／contracts | 356／86／19 tests 全通過；online 含八個實際 launcher 環境案例                                    |
| Chrome 整合            | 37 tests 全通過，含未完成句子 Stop 後立即 Fresh Start 隔離                                       |
| 模擬故障 → DOM 字幕    | Gemini→OpenAI 2,140 ms；OpenAI 續期失敗恢復 1,139 ms                                             |
| 2,000 段歷史字幕負載   | 90 秒持續更新，0 個 >50 ms 主執行緒長任務，含陽性控制                                            |
| 靜態／建置             | typecheck、ESLint（只排除既有不可存取的 `.pytest_cache`）、web/service build、server bundle 通過 |

OpenCC 更新後主 JS 為 816.68 kB／gzip 611.75 kB（更新前 786.12／586.19 kB），
仍有 >500 kB 建置警告。已驗證負載期間順暢；本輪沒有量測慢網路首次載入，
因此不將字典更新解讀為下載或啟動更快。套件管理器原使用工作區外的舊 store，
本輪依現有 lockfile 在工作區 store 重建依賴後才更新三個指定套件；未變更全域
pnpm 設定。正式驗證在更新後執行，暫存連線 probe 已清除。

## 第一輪發現的證據缺口

- 原 `caption-longtask.spec.ts` 在載入 2,000 段歷史後按 Fresh Start，
  `App.startRealCore(false)` 會呼叫 `beginSession` 清空字幕。
  因此過去「2,000 段 + 90 秒無長任務」的結論不能成立。
  新增啟動後歷史仍存在的畫面斷言，已在 Chrome 重現失敗：歷史實際為空。
  修正測試使用 Continue，並在負載前後檢查種子歷史仍存在。
- 原有 338 個 web、77 個 online、19 個 contracts 測試可通過，
  但未涵蓋 WebSocket 準備期事件提前流入、音訊準備卡住，以及非認證錯誤切換金鑰。
- 自動化 mock 傳輸只能驗證應用流程；不能據此宣稱真實模型的 P50/P95、翻譯品質
  或完整會議的可靠度已達標。

## 本次修正

| 已證實問題                                                          | 修正與回歸證據                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 新 WebSocket 的字幕可在接管前改寫共用分段                           | `open()` 保持事件緩衝，由 provider 完成舊分段後 `activate()`；單元與瀏覽器驗證新舊字幕分離                       |
| 收到 `session.created` 就取消 deadline，音訊 worklet 卡住可永久等待 | 10 秒 deadline 涵蓋完整音訊準備；逾時、錯誤與關閉共用清理，晚完成的 worklet 不會復活節點                         |
| WS 網路或本機音訊錯誤也會切換／降級金鑰                             | 僅認證拒絕分類進入 alternate key；同時保留 SDP 與 WS 錯誤原因                                                    |
| 續期候選在接管前已關閉，仍可能拆掉健康舊連線                        | 在 flush／detach 前檢查候選；失敗保留舊連線                                                                      |
| 效能測試量到清空歷史後的會議                                        | 改用 Continue，負載前直接斷言 active store 有 2,000 段，結束後仍保留歷史且持續出字                               |
| 離線模型首次握手暫時失敗後停留 loading                              | 在調整優先順序前完成的小修正：TCP 持續可達時重試未成功握手，且最多一個 probe；涵蓋 WAIT、timeout、OSError 後恢復 |

上述線上生命週期缺陷先以回歸測試重現失敗，再修正。瀏覽器新增測試使用
production WS transport、provider、normalized store 與 React；僅替換外部網路
及音訊擷取邊界，驗證字幕交接、同一麥克風復用與 Stop 資源釋放。

### 已知限制

- 第一輪保留的 WS 1008 認證分類問題，已於第二輪修正並加入正反案例。
- `/session` 的 `rejectedSlot` 可影響整個服務的 key 偏好。若將服務暴露於不可信
  client，需另外驗證部署存取控制或將拒絕訊號綁定 session；本次未做部署安全驗收。
- 第一、二輪尚未送音訊；第三輪真實推論結果見上方，仍未證明完整長會議品質與延遲。

## 模型查核（當日官方資料）

| 用途                | 現行／候選                          | 判斷                                                                             |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| OpenAI 專用串流翻譯 | `gpt-realtime-translate`            | 官方目前仍推薦此模型做持續語音翻譯；保留現有主路徑                               |
| Gemini 專用串流翻譯 | `gemini-3.5-live-translate-preview` | 官方目前仍列此模型，Preview、尚無公布關閉日；保留現有路徑                        |
| OpenAI 低延遲轉錄   | `gpt-live-transcribe`               | 官方推薦的 live STT，支援 `delay`、詞彙與多語提示；須另接文字翻譯，列入 A/B 候選 |
| Gemini 低延遲轉錄   | `gemini-3.5-transcribe-live`        | 8/26 GA；interim/final 串流，須另接文字翻譯，列入 A/B 候選                       |

9/2 新出的 Gemini 3.8 Flash 是通用模型，不能直接替換 Live Translate 的
WebSocket 翻譯協定。OpenAI 官方也明確區分語音助理與持續翻譯 session。
**最新通用模型不等於最快的字幕管線。**

Google Live Translate 官方建議 100 ms 音訊封包。專案目前為 32 ms；
既有 8/28 小樣本量測無法支持改為 100 ms 會降低首譯文延遲，本次不盲改。
官方文件與現有已錄製 handshake fixture 的 transcription 欄位層級有出入，
也不能只憑範例文字改動已驗證協定。

官方來源：

- [OpenAI 模型目錄](https://developers.openai.com/api/docs/models)
- [OpenAI Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation)
- [OpenAI Realtime transcription 與延遲設定](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Gemini Live Translate 模型](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview)
- [Gemini Live Translate 指南](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
- [Gemini 更新紀錄](https://ai.google.dev/gemini-api/docs/changelog)
- [Gemini 模型生命週期](https://ai.google.dev/gemini-api/docs/deprecations)

## 驗證結果

| 檢查              | 結果與證據範圍                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Vitest            | web 343／28 files、online 77／7 files、contracts 19／4 files 全通過                                        |
| Python            | offline 85 全通過；2 個既有 SWIG deprecation warnings；Ruff 通過                                           |
| Chrome 瀏覽器整合 | 36 全通過；Google Chrome 152.0.7977.83，外部 provider／capture 為 mock                                     |
| 字幕歷史負載      | 保留 2,000 段，10 Hz 驅動 90 秒，0 個 >50 ms 長任務；150 ms 人為阻塞陽性控制有被偵測                       |
| 應用故障恢復      | Gemini→OpenAI 2,129 ms；OpenAI 續期失敗後恢復 1,151 ms，均量至 DOM 出字；mock 網路，非模型延遲             |
| 靜態與建置        | typecheck、ESLint、production build 通過；建置仍有既有 >500 kB chunk 警告，主 JS 786.12 kB／gzip 586.19 kB |

環境限制與重現方式：

- `pnpm test` 與 `pnpm lint` 的全目錄掃描會遇到既有
  `apps/web/.pytest_cache` 權限錯誤；未變更該目錄 ACL。完整 web 測試均在 `src`，
  改以 `pnpm -F @meeting-audio/web exec vitest run --dir src --silent` 執行。
  online 使用 `pnpm -F @meeting-audio/online exec vitest run --silent`，
  contracts 使用 `pnpm -F @meeting-audio/contracts test`。
- ESLint 使用 `pnpm exec eslint . --ignore-pattern '**/.pytest_cache/**'`，
  僅排除 Python cache；型別與建置使用原有 `pnpm typecheck`、`pnpm build`。
- Python 使用指定的 `C:\Programs\miniforge3\envs\deve\python.exe` 執行 pytest；
  Ruff 使用既有 `services/offline/.venv/Scripts/ruff.exe`，未啟用該環境的 Python。
- Playwright bundled Chromium 未安裝，改用已安裝 Chrome。
  `.cache/audit-playwright.config.ts` 繼承正式設定，只指定 `channel: 'chrome'`、
  將 test/output 目錄設為絕對路徑，及關閉 webServer 自動管理，搭配獨立 Vite。
  執行 `pnpm exec playwright test --config .cache/audit-playwright.config.ts --reporter=line`。
  測試門檻未放寬，完整 36 tests 測量期間 source 保持不變。

## 下一個有決策價值的實驗

以同一份代表性英語／中英夾雜會議音訊，對照兩個現行翻譯模型與
「Live STT → 串流文字翻譯」候選。分別量測：

1. 語音開始 → 第一個有意義譯文出現在畫面（P50/P95）。
2. 連續字幕的停頓分布、句末完成延遲、斷線到下一段字幕的空窗。
3. 數字、專有名詞、否定句、換人發言與漏譯；品質不得以速度交換而隱瞞。
4. 長會議的主執行緒長任務、heap 趨勢、續期與跨模型交接。

現有 `window.__latency` 與 Field Test 可輔助收集應用事件，但沒有語音時間對齊
及雙語參考答案，就不能完整回答上述延遲與品質問題。乾淨合成音只適合篩選，
不能代替真實會議驗收。第一、二輪未送音訊；第三輪已送合成測試語音，但沒有新增模型速度排名。
