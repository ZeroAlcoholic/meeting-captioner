# 2026-10-06 本機深入診斷與啟動紀錄

## 結論與範圍

目前工作區的正式前端及線上服務已重新建置並啟動於
<http://127.0.0.1:8787/>。Chrome 實際開啟此網址，Demo 原文與譯文可顯示，
未觀察到 pageerror。這是本機執行證據，不是雲端翻譯或長會議驗收。

離線 FastAPI 已啟動於 `127.0.0.1:8000`，但 `/healthz` 回報 `ok:false`：
指定 Python 環境缺少 `whisper_live`、`pyaudiowpatch`，9090 沒有辨識引擎。
因此完整 Offline／Hybrid 辨識流程目前不能使用。未改用專案 `.venv`，未下載模型或安裝套件。

本次沒有更動產品程式碼、既有測試或驗收門檻；保留原有大量未提交修復。
本次文件只增加診斷紀錄與 PROJECT_STATE 最新狀態。未啟動付費 API 驗證。

## 已確認問題

### 1. 離線辨識／系統音訊套件缺漏

- Runtime：`C:\Programs\miniforge3\envs\deve\python.exe`，Python 3.12.12。
- `importlib.util.find_spec`：`whisper_live`、`pyaudiowpatch` 不存在。
- `services/offline/run_whl.py:25` 實際匯入 `whisper_live.server.TranscriptionServer`。
- FastAPI 可啟動，但 ASR health 為 `unavailable`；WASAPI 為 `not_implemented`。
- 文件沿用 WhisperLiveKit 名稱，實際依賴為 `whisper-live`，不能只憑名稱判斷引擎已安裝。

### 2. 中翻英本機模型有可重現的重複輸出

直接執行正式 `app.pipeline.translation.translate`，使用現有 CT2 模型，
並設定 Hugging Face／Transformers offline 環境。兩次執行得到相同文字：

- 英文 `The meeting starts at nine tomorrow morning.` → `會議明天早上九點開始`。
- 中文 `我們明天上午九點開會。` →
  `We have a meeting tomorrow morning at 9 a.m. tomorrow morning at 9 a.m. at 9 a.m.. We have a meeting tomorrow morning at 9 a.m. at 9 a.m.. We have a meeting tomorrow morning at 9 a.m. at 9 a.m. at the meeting.`

可確認推論可執行，也可確認此測例品質不合格。尚未隔離模型轉換、tokenizer
或解碼參數各自的責任；不能將單句結果泛化為整體品質評分，也未用裁字掩蓋重複。
保存的第二次推論耗時約 0.232／0.434 秒，不代表即時串流端到端延遲。

### 3. 翻譯逾時不能釋放已執行的 worker

`services/offline/app/pipeline/translation.py:114` 的 `_run_in_executor_with_timeout`
以 `asyncio.wait_for` 包住單一 worker 的 `run_in_executor`。註解宣稱逾時能釋放
executor slot，但已開始的同步工作不會因此終止。

受控重現：僅在獨立診斷程序將期限設為 50 ms，第一個工作等待 Event，第二個工作
只呼叫 `Event.set`。兩次都逾時，第二個工作從未執行。最後釋放 Event 並 shutdown，
沒有留下阻塞執行緒，也沒有修改服務或產品常數。

這證明目前機制只能限制 caller 等待，不能復原卡住的翻譯 worker；
不代表本次真的遇到 CT2 deadlock，也不證明字幕接收本身會停止。
後續修復需保留字幕隔離，並驗證逾時後下一筆翻譯能實際完成。

### 4. 預設診斷／驗證命令受快取與舊規則影響

- `pnpm test` 在 `apps/web/.pytest_cache` 發生 `EPERM scandir`，不是測試 assertion 失敗。
- 對各 package 執行 Vitest 並排除 `**/.pytest_cache/**` 後，全部 JS 測試通過。
  排除的只有 Python 快取，未刪除、跳過或更改任何產品測試。
- `pnpm lint` 同樣先遇到快取存取錯誤；排除該快取後又掃入 `.cache` 內正式 bundle，
  產生 2,389 errors／4 warnings。另排除 `.cache/**` 後原始碼 lint 為零錯誤。
- `scripts/doctor.ps1:27` 使用非指定的 `python`；第 37 行將 `.env` 存在視為正常，
  與目前服務只讀系統環境變數的政策衝突。本次沒有照它的提示建立 `.env`。

這些預設命令仍未修復，不能回報原始 `pnpm test`／`pnpm lint` 已通過。

## 執行與證據

環境：Node 24.14.0、pnpm 9.12.0、指定 Python 3.12.12、已安裝 Google Chrome。
採逐一 shell 呼叫；`Get-NetTCPConnection` 被拒絕存取，改以 `netstat` 和實際 HTTP 查證。

| 檢查                                           | 本次結果                            | 證據限制                                            |
| ---------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `pnpm build`、online `bundle`                  | 通過                                | Vite 仍有 >500 kB bundle 提示                       |
| Contracts Vitest                               | 20 通過                             | 契約測試                                            |
| Web Vitest，排除 Python 快取                   | 523 通過                            | 含加速時鐘／mock，不代表真實長會議                  |
| Online Vitest，排除 Python 快取                | 90 通過                             | 本機服務測試                                        |
| 指定 Python `-m pytest -q -p no:cacheprovider` | 85 通過、2 個 SWIG 棄用警告         | 不代表缺少的 ASR／WASAPI 可運作                     |
| `pnpm typecheck`                               | 通過                                | 靜態檢查                                            |
| ESLint，排除 Python 快取及 `.cache/**`         | 通過                                | 原始命令仍有上列問題                                |
| Chrome 正式 bundle 原生音訊                    | 6 通過                              | 原生 PCM／本機 RTP；上游受控，沒有真雲端語意        |
| Chrome 接續／故障恢復整合                      | 26 通過（2.4 分鐘）                 | mock 上游；含跨模型接管、Retry 歷史、Stop、反覆換線 |
| Chrome 正式服務頁面                            | Demo 原文／譯文出現、pageerror 為空 | 僅示範字幕路徑                                      |
| 本機 CT2 推論                                  | 雙方向可執行                        | 中翻英測例重複，不算品質合格                        |
| 現有環境三個 key 的完整值掃描                  | web assets 與本次診斷輸出未命中     | 不是所有形式的秘密外洩稽核                          |

Chrome 原生音訊涵蓋 16／48 kHz、socket drop、真 HTTP Worklet 503 復原、
延遲初始化，以及候選正常／提早關閉的 WebRTC 路徑。

所有本次機器可讀結果、原始 logs 與畫面位於 `.cache/diagnosis-2026-10-06/`：
`runtime-evidence.json`、`browser.json`、`running-app.png`、`local-mt.json`、
`mt-timeout.json`、`build.log`、`web-unit.log`、`online-unit.log`、
`offline-tests.log`、`native-audio.log`、`continuity.log`。

## 啟動身分與操作

- 網頁／線上服務：`http://127.0.0.1:8787/`，Node PID `39748`。
- 離線橋接服務：`http://127.0.0.1:8000/healthz`，Python PID `40612`。
- 兩者隱藏視窗、綁定 loopback；stdout／stderr 另存本次 `.cache` 目錄。
- 前端入口資產：`index-kwLv84Cg.js`。
- 前端 SHA-256：`f29dce521494a3272cf8516ce442b317df1d170f400f5ed0cbb10a86114bd6b8`。
- 後端 SHA-256：`623b389dc14be845832b37783b4e18cb9baae7adfcaea4bcc76850d9c6b76ee8`。
- `/session/info` 列出 OpenAI 與 Gemini；不含 key 值。
- `/healthz` 的 `openai_reachability` 為 `unknown`，key configured 不等於已連上雲端。

此網址已確認是本專案，與前次紀錄中 8787 的其他應用不同；不代表使用者其他
發行 ZIP／捷徑也已更新。本次服務沒有開始實際收音或付費翻譯。

## 尚未驗證／下一步

未執行新的付費 API、實體麥克風／Teams 系統收音、校準後連續 60 分鐘原生 LOCAL soak，
也未完成既有自動 LOG／TEXT 保存與 PCM 缺口補錄需求。既有 R5／V1 gate 保持開啟。

優先讓目前線上版本完成剩餘原生長測與核准預算的真 API 驗收。
另排程修復預設工具命令；離線恢復依賴時須使用指定 runtime，再處理 MT 逾時復原
及中翻英品質，不以本機單元測試取代上述運行驗收。
