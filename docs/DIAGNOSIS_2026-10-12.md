# 專案診斷與近期 Claude Code 工作收尾（2026-10-12）

## 結論與範圍

核對目前未提交工作目錄、10/08 純字幕與逐字稿交付、10/09–10 的術語／延遲／切換報告，並以目前程式重新驗證。Git 最新提交仍在 08/28，不能只審 HEAD 或把全部未提交成果算成本輪改動。本輪未 commit、reset、切分支或啟動付費 API。

本輪修復的是已交付功能與驗收入口的實際缺陷；T6–T15、真人混語品質及真實網路／長會議驗收不因此完成。

## 已重現與修復

| 問題                                     | 直接證據                                                 | 修正                                                                              |
| ---------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 預設 JS 測試被 Python cache 阻斷         | `pnpm test` 在 web `.pytest_cache` EPERM，中止前端探索   | Vite/Vitest 明確探索 `src/**/*.test.{ts,tsx}`，完整原有測試仍執行                 |
| 預設 E2E 無法啟動瀏覽器                  | 缺少指定版本的 Chromium headless executable              | 使用已安裝 Chrome；沿用同程序 Vite setup，避免 Windows shell 子程序收尾問題       |
| OpenAI 舊測試替身過時                    | Chrome 實際顯示 `ctx.resume is not a function`           | 使用既有共用 `online-mock`；保留字幕、健康狀態及缺 key 的斷言                     |
| production 純字幕被預設 dev suite 誤收集 | `pure-captions` 依賴獨立 production globalSetup 與資料庫 | 從 dev suite 排除，仍以專用 config 完整執行，沒有移除測試                         |
| 交接中 Pause 只停一個 provider           | 新 Chrome 回歸按 Pause 後仍有 1 個 live capture track    | 先記錄恢復模式，再停止兩家與 OpenAI 計費計時；取消晚到的 start                    |
| 舊 provider 停止覆蓋新線 connected       | 兩 hook 新回歸均收到 loser 的 stopped health             | 交接退役保留共用健康狀態；一般 Stop 仍發布 stopped                                |
| 同廠已恢復，失敗備援卻覆蓋 UI            | Chrome 顯示 Gemini `api_error`，但 OpenAI 已恢復         | hooks 保留各自 normalized health；交接結束由真正保留的後端恢復畫面狀態            |
| 永久性保存錯誤無限重送                   | HTTP 400 新回歸在 60 秒內多次送出同批資料                | 400／413／422 暫停自動 HTTP 重送，IDB 佇列與後續字幕照常保留；明確提示與手動重試  |
| 格式檢查掃描不可讀 cache                 | 原指令回 exit 2 卻先印「All matched files」              | CLI 排除不可讀 cache 探索，ignore 排除生成物；14 個既有格式差異只做 Prettier 整理 |

保存故障另以兩家正式 bundle、Chrome 原生音訊／VAD／IDB／SQLite 驗證：拒絕期間新音訊繼續、只送一次拒絕請求、停止後可完成重送、重載／校訂／TXT 匯出仍正確。測試檔首 8 秒是數位靜音，PCM 進展使用下一次 12 秒循環語音作判準，沒有把 VAD 靜音誤判成停機。

## 本輪驗證

環境：Node 24.14.0、pnpm 9.12.0、指定 deve Python、Google Chrome。

- `pnpm test`：32 contracts＋668 web＋157 online＝857 通過。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm format:check` 通過。
- `node --test scripts/managed-service.test.mjs scripts/mixed-caption-eval.test.mjs scripts/mixed-caption-predictions.test.mjs`：18 通過。
- 指定 Python 執行 `-m pytest services/offline/tests -q -p no:cacheprovider`：85 通過。
- 針對性 Chrome：19 項既有與新增操作回歸通過；追加失敗備援競態等 3 項通過。
- production 純字幕：OpenAI／Gemini 2 項通過，程序正常退出；OpenAI 包含 renderer crash／ACK 遺失，兩家包含新增 HTTP 400、重載／校訂／匯出／360px 與 1280px／鍵盤全螢幕。
- 完整預設 E2E：50 通過（3.9 分鐘），含 2,000 段歷史／90 秒字幕負載，0 個超過 50 ms 長任務。
- 原生翻譯音訊／WebRTC：6 通過，涵蓋 worklet HTTP 503、16/48 kHz、延遲 setup、斷線與 RTP 候選失敗。
- 最後 review 另以兩家單元測試重現 audio failed → 同步 stopped 回呼污染 health cache，調整快取至最終發布事件。修正後 857 項重跑全過、12 個相關 Chrome 交接案例全過，型別／lint／格式再次通過；沒有把修正前的整套結果當成修正後全套重跑。
- 最終差異檢查通過。掃描實際 managed build 的 10 個瀏覽器文字資產、比對當前環境 3 個已配置 key，0 個資產包含 key；未輸出任何 key 值。

## 日常服務與操作

已從停止狀態透過 `pnpm service:start` 建立最新 production build；重複 start 回傳同 instance 且 `reused: true`。

- URL：`http://127.0.0.1:43871`
- instance：`4192acb9-dd25-4b70-823a-663ecb6b0114`
- build：`d81cd62e40526438192eab9ac3ab98fdfce21d7420bd0218f18a769dfe9cc3d0`
- `healthz` HTTP 200、配置可用，SQLite bootstrap `storageAvailable: true`，資料目錄為 `%LOCALAPPDATA%\MeetingAudio`。
- Chrome 實際開啟 production URL，Demo 產生中英文字幕、停止後可切入純字幕，0 個 pageerror。此部署檢查封鎖雲端會話建立，沒有測試真實 ASR。

日後以 `pnpm service:status` 取得實際 URL；更新程式需 `pnpm service:stop` 再 `pnpm service:start`。本次已有未提交成果皆保留，沒有自動提交。

本輪日誌位於 `.cache/diagnosis-2026-10-12/`；純字幕畫面及 trace 位於 `.cache/pure-e2e-results/`。mock、原生本機與真雲端證據分開，以上沒有新增真雲端辨識品質證據。建置仍有既存 CJS `import.meta` 警告（bundle 使用指定 worker path 分支）、Node SQLite experimental 警告與 Python SWIG deprecation 警告。

## 仍未完成的產品與外部驗收

1. 真人混語 gold corpus／人工稿及 CER／WER／關鍵詞、否定／金額／版本號正確率；T4 斷句門檻三組評測尚無真人依據。
2. T6 記憶體 PCM 環形緩衝、T7 純轉寫續期先通後斷及中斷重播未交付。本輪修的是既有翻譯模式的跨廠交接，不是純轉寫無缺口續期。
3. T8／T9 Gemini 備用 key、proxy 及 T11 真實內外網切換尚未驗收；不能以強制 key 槽位測試代替。
4. 真雲端長會議、真人全稿四向核對、缺口補回、語者與摘要後續階段仍開放；沒有啟用落盤錄音或文字外送摘要。
5. 指定 Python 環境目前確實缺 `whisper_live`、`pyaudiowpatch`。85 項回歸不代表離線 ASR／WASAPI 可用；既有 MT 推論品質／逾時隔離問題亦未在本輪修復。
6. 刷新後 writer lease 的短暫唯讀與明確重新取權仍是既有多分頁安全規則，未改成自動搶權。

「本機已保存」代表已提交的文字，不代表沒有漏辨識。歷史 60 分鐘長測是當時版本的受控上游紀錄，本輪短測不更新為新的 60 分鐘或真實會議證據。
