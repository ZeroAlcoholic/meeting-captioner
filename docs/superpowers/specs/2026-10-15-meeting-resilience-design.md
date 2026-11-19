# 會議場域強固化：診斷與工作藍圖

日期：2026-10-15。狀態：診斷與施工規劃交付，產品尚未依本藍圖修改或驗收。

**最新範圍校正：OpenAI／Gemini 兩家交互備援必須有，納入主線；只有 Gemini 第二把金鑰備援放最後。** 兩家各一把可用 key 即可驗收，不依賴 N1。施工排序以[主工作清單 W01–W12](../plans/2026-10-15-meeting-hardening-checklist.md)為準；原先把所有備援後排的解讀已撤銷。

## 1. 目標與範圍

讓操作者在支援的場域中，能確認收對聲音、輕鬆開始會議、看懂故障、自動恢復可恢復的故障，會後取得可核對的完整紀錄。可靠性涵蓋音源、傳輸、辨識、文字保存、服務與使用流程，不以「WebSocket 重連成功」代替會議恢復。

暫定第一批：Windows 筆電、Chrome、1–2 小時線上會議及小型實體會議；混合雙來源、公司受限網路與全離線均有必要工作與獨立放行門檻。這是尚未收到場域偏好時的排序假設，不排除其他場域。大型會議廳、任意硬體／網路、無限長斷網與睡眠中持續收音，不作通用保證。

本輪不改產品程式、不安裝依賴、不啟動付費 API、不更換模型、不啟停日常服務。摘要、議題脈絡與自動語者不是強固化前置；保留原藍圖，排在本輪可靠性門檻之後。

## 2. 診斷基準與證據等級

- 工作樹 HEAD：`67f635cba6787b5078c8105389beb1aba2b6837d`，大量既有 tracked/untracked 修改；HEAD 不能代表目前產品內容。施工前須保存本次實際涉及檔案的雜湊與差異。
- 本輪 runtime：Node `v24.14.0`；指定 Python `C:\Programs\miniforge3\envs\deve\python.exe`。
- `pnpm service:status`：`stopped`。本輪沒有已啟動服務的端到端驗證。
- 本輪重跑 7 檔、80 項單元／回歸全部通過，命令見第 10 節；證明現有受控邏輯，不證明真實收音或雲端可靠性。
- Python 模組探測：`whisper_live=false`、`pyaudiowpatch=false`；`ctranslate2/sentencepiece/fastapi=true`。能 import 不等於模型能推論。
- 10/12 的四路 30 分鐘 Chrome 原生音訊／受控上游長測是歷史證據；純字幕各 151 段持久保存並核對 TXT/JSON，但 OpenAI 1、Gemini 3 個推估續期缺口。[原報告](../../MEETING_CALIBRATION_2026-10-12.md)
- 下表分為 **S 程式直接確認**、**I 架構推論待重現**、**H 歷史實測**、**U 未量測**。未重現的風險不能寫成已發生的資料遺失。

| ID／優先級 | 診斷與因果                                                                                                     | 決定性程式／證據                                                                                                           | 處置                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| F01 P0 S   | full build 混合場景宣稱 mic＋remote 分軌，`setScenario` 實際只選 mic；全域 capture slot 也不是雙軌             | `settings-store.ts:100,358`；`capture-lease.ts:48`；`PureCaptionWorkspace.tsx:187`                                         | A1 先讓能力／選項一致，A5 真正交付雙軌；隱藏選項不算需求完成   |
| F02 P0 S/H | 純字幕續期先 `provider.stop()` 再 `connect()`；收音 pipeline 隨 provider 處置                                  | `transcription-session.ts:31–58`；10/12 缺口紀錄                                                                           | A3 分離會議擷取生命週期，A4 候選接管與缺口補處理               |
| F03 P0 S   | 純字幕恢復重用同一 factory，沒有跨廠自動接管；翻譯已有自救／跨廠恢復                                           | `transcription-session.ts:80–98`；`meeting-recovery.ts`；`App.tsx`                                                         | A4 依 purpose 與實際 capability 選候選，不用翻譯模型替代純轉寫 |
| F04 P0 S   | lease 的 live track／connected 不等於 PCM 在前進；可見頁面上的 context suspend、mute 與裝置變更無完整監督      | `capture-lease.ts:79–81,141–169`；`microphone-audio-provider.ts:123`；`display-media-audio-provider.ts:106`                | A2 獨立擷取心跳、裝置及 context 生命週期                       |
| F05 P1 S   | 純字幕 broker 傳 Retry-After，但兩家 client 只把非 2xx 轉成字串錯誤；session 仍一般退避                        | `routes/transcription.ts`、`routes/gemini-transcription.ts`；兩家 transcription provider 的 mint 回應處理                  | A4 結構化失敗／冷卻；不能將翻譯的 Retry-After 支援推廣到純字幕 |
| F06 P1 S/U | 純字幕無獨立「持續有語音但上游不產字」監督；Gemini 靠有界 inputQueue 最後爆滿，OpenAI silence 計時依賴新 PCM   | `gemini-transcription-provider.ts:455–570`；`openai-transcription-provider.ts:377–394`                                     | A2 分層進展量測、A4 停字偵測；不能在安靜房間重連風暴           |
| F07 P0 S   | SQLite archive 只接純字幕 UI；翻譯仍是舊快照路徑                                                               | `PureCaptionWorkspace.tsx:173,276`；`caption-store.ts`；`meeting-archive-client.ts:recordTranslation` 尚未接翻譯事件主路徑 | D1 全模式接同一 archive，保留明確保存政策                      |
| F08 P0 I   | managed port fallback 改 origin；舊 origin IDB 未 ACK 內容新 origin 看不到，AppData SQLite 不變無法解決        | `managed-service.mjs:181–187`；`meeting-outbox.ts:IndexedDbMeetingStore`                                                   | D2 先跨埠重現，再穩定 origin／舊來源救援                       |
| F09 P1 S   | writer 已有 timeout、terminate、重建與 cooldown；不應重寫一套。RAM／IDB／DB／衍生檔各有不同失敗邊界            | `meeting-repository.ts:40,63,86`；`routes/meetings.ts:67–84`；`meeting-outbox.ts`                                          | D3 補跨邊界故障閉環與可見缺失，沿用已驗證原語                  |
| F10 P1 S/U | 有 DB backup 原語與測試，缺完整使用者還原／異碟備份流程；同磁碟副本不能防磁碟故障                              | `meeting-writer.worker.ts:311–313`；repository tests                                                                       | D4 使用者備份、還原、升級相容與資料核對                        |
| F11 P1 S   | CLI 啟動 detached host 後退出；host crash 可再次 start，並非自動重啟                                           | `scripts/service.mjs:92–125`                                                                                               | D5 有界 supervisor＋穩定 origin；停止意圖優先                  |
| F12 P1 S   | Gemini 單 key；沒有專案層 proxy 路徑驗收                                                                       | `services/online/src/config.ts`、`routes/gemini*.ts`                                                                       | N2 主線網路驗證；N1 第二 Gemini key 最後處理                   |
| F13 P1 S/H | 離線目前缺必要依賴，health engine 名稱與實際 WHL bridge 混淆；zh→en 重複與 MT timeout 不釋放 worker 有歷史證據 | 本輪 import 探測；`main.py:246`、`pipeline/asr.py:108,302`；10/06 報告                                                     | N3 真推論資格閘門與修復；不把離線當現成救援                    |
| F14 P1 S   | WASAPI health 報 not_implemented，卻會建立 capture task；背景錯誤到清理才 await 並吞掉                         | `main.py:263–266,326–357`；`capture/wasapi_loopback.py`                                                                    | N3 task supervision、endpoint 變更、丟音帳及 queue 時間上限    |
| F15 P1 U   | meeting DSP 關 EC/NS/AGC 的優劣、BT/HDMI 熱插拔、遠講／插話／回聲沒有本輪真實量測                              | `microphone-audio-provider.ts:10–65`；10/12 品質限制                                                                       | V1 場域素材與 DSP A/B；不從註解推論最佳聲學設定                |

以上路徑未冠前綴時：TS providers 位於 `apps/web/src/providers/`，store 位於 `apps/web/src/store/`，設定位於 `apps/web/src/settings/`；routes/storage 位於 `services/online/src/`；Python 位於 `services/offline/app/`。行號為本輪快照，施工以符號定位。

### 必須修正的舊結論

1. 60 秒 PCM 緩衝不等於 60 秒語音必然補回。上游是否允許加速重播、活動順序、併發、時間對齊、費用與真辨識品質，需 A3/A4 實測。不能先承諾「7 次缺口變 0」。
2. 程式已有 VAD pre-roll、worklet buffer、Gemini activity queue；缺的是**跨 provider 生命週期的會議級可追蹤保全**，不是所有形式的 buffer 都不存在。
3. 翻譯恢復、純字幕恢復與音源恢復是不同路徑，不能共用一個完成標記。
4. `NODE_USE_ENV_PROXY` 已存在於本機 Node 24.14.0；先測現成能力，再決定是否新增 ProxyAgent。服務端 proxy 也不等於瀏覽器 WSS／WebRTC 可以穿過公司網路。[Node 24.14 文件](https://nodejs.org/download/release/v24.14.0/docs/api/cli.html#node_use_env_proxy1)
5. 分享選擇器須遵守使用者授權，可能取得只有影像、沒有聲音的 stream；停止分享後不能承諾無手勢自動重開。[W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
6. `live` track 可以 muted；裝置消失、track ended 與暫時 mute 需不同處置。[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

## 3. 方案選擇

| 方案                                                                                 | 收益／代價                                                   | 決策                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| 只補 timeout、重試常數                                                               | 小改動，但收音掉幀、雙軌、保存與網路資格仍空缺               | 不足以滿足本目標                                |
| 沿用 adapters、capture lease、normalized events、archive，補會議擷取所有權與場域資格 | 修到真路徑；只在擷取與恢復邊界擴充，不重寫 UI/provider 系統  | 採用                                            |
| 立即 Electron 化＋全天候雙供應商／本機模型熱備                                       | 額外打包、成本、硬體與隱私複雜度；不能直接解決聲學與資料錯誤 | 非本輪前置；網路／硬體證據證明 web 不足後另評估 |

所有新型別和檔案在各施工計畫中標為**預定新增**，不暗示目前已有。支援表／驗收結果才決定可用場景；沒有依賴的模式不能出現在自動備援名單。

## 4. 場域、操作與恢復契約

| 場域                      | 預設音源／政策                              | 必驗風險                                       | 放行依賴                                    |
| ------------------------- | ------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| S1 個人耳麥／筆電小型實體 | 明確 mic、exclusive；近講與多人預設分開     | 低音量、遠近講者、空調、插話、USB 拔插         | A1–A4、D1–D5、V1–V3                         |
| S2 瀏覽器 Meet／媒體分頁  | 使用者選分頁且分享音訊；mic 預設 off        | 漏勾音訊、錯分頁、停止分享、背景分頁           | 同上＋實際 Chrome 分享驗證                  |
| S3 桌面 Teams／Zoom       | 系統分享或已驗 WASAPI endpoint；exclusive   | 系統通知、HDMI/BT 輸出變更、不同視窗是否有音訊 | S2＋N3（僅選 WASAPI 時）                    |
| S4 實體＋遠端混合會議     | mic＋remote separate_tracks，永不默認 mixed | 回聲重複、兩時鐘、雙費用、單軌失敗             | A5、V1 的兩來源實機驗收                     |
| S5 公司內網／VPN／Proxy   | 已驗 network profile；先確認兩段網路路徑    | DNS/TLS、proxy auth、WSS/UDP 封鎖、key 權限    | N2、A4 雙向接管、V2 內外網矩陣；不依賴 N1   |
| S6 全離線／禁止外送       | 本機 STT/MT 及本機資產；禁止雲端接管        | 模型未就緒、GPU/CPU 壓力、timeout、無網路      | N3 真推論與流量攔截；其餘保存／音源要求不減 |
| S7 休眠／鎖屏／投影       | 會前電源狀態提示；醒後回同場會議            | CPU 暫停、timer 跳躍、來源／輸出換機           | A2、D5、V2 實體 sleep/lock 分別測           |

### 使用流程

- 開會前：選場景與 purpose → 確認裝置／來源 → 5–10 秒本機試音，展示每軌音量、PCM 活動與實際 DSP → 顯示服務、模式與保存就緒 → 開始。試音不呼叫付費辨識；「收到音訊」不寫成「辨識品質通過」。
- 會議中：主要只保留開始／暫停／繼續／停止、字體／全螢幕；收音、連線、字幕進展、保存分層顯示。故障提示包含影響來源、是否仍在保存及唯一下一步。
- 可自動恢復：活音源上的暫時網路錯誤、可用候選、已分類的限流冷卻、worker／broker 暫時故障。使用者無須知道 token／SDP。
- 需人介入：權限拒絕、停止分享、實體裝置拔除無可用原裝置、授權／帳務永久拒絕、持續 crash、磁碟滿。提供一個具體修復入口，不反覆彈 picker、不偷偷換來源。
- Stop/Pause 停止新音訊擷取與雲端送音；停止後只可有有界的已送尾文排空、本機文字保存。本輪不落盤錄音，Stop 清除 PCM；尚未補處理的區間轉為 unrecoverable 並明示。不能先清 buffer 卻承諾會後還能補回。Pause 的舊 PCM 同樣清除，Resume 開新 captureEpoch。
- 結案區分：已停止收音／仍待存／已保存但待核對／完整核對完成／已知缺口。原稿、校訂與譯文各有版本與來源。

## 5. 必要資料與生命週期設計

### 5.1 會議 owns capture，provider owns transport

meeting → track → captureEpoch → 連續 sample position；provider session/attempt 是另一維度。同一 live capture 可供候選驗證，但只有被採用者能發布主線事件；退役者僅可提交歸屬既有 utterance 的尾文。所有副作用帶 generation，Stop／新會議撤銷舊 generation。

單軌先落地；A5 才將現有全域 lease 擴為 mic／remote 兩軌 owner，不建通用 registry。不要在 A3 同時重寫所有 provider。翻譯 WebRTC 保留原 stream 路徑，PCM 監測／補處理以旁路接入，不能為了共用 PCM 強迫改 WS。

### 5.2 音訊完整性

- 預定 PCM 基準：每軌 16 kHz mono Float32，60 秒上限＝960,000 samples＝3,840,000 bytes；若存 PCM16 為 1,920,000 bytes。不得把 Float32 預算算成 1.9 MB。兩軌分別有上限並計總額。
- 在 VAD 前保留有界 frame、sample clock、track/epoch；不以 VAD 排除的聲音等於無有效發言。VAD／重取樣排程不能阻塞 render thread，真實負載驗收才決定是否移 worker。
- 分別記 captured、submitted、provider-completed、durable-text 四種水位；`socket.send()` 成功只證明本機排隊，不是上游已辨識。
- 上游沒有 sample ACK 或穩定 utterance ID 時，provider-completed 只能記估計活動範圍與依據，不能偽裝精確水位。A3 資格測試須證明如何對齊；無法證明時保留待核對區間。
- ring 滿時覆寫最舊未保全區間也必須生成 gap。故障超過容量、renderer crash、電腦睡眠、track ended 不能由 RAM 重播憑空補回。
- 新連線追趕能力先做受控協定＋授權真服務資格。若上游只能 1x 送音，不得把舊音排在 live 前讓延遲永久累積；保住即時主線，缺口留待合格本機補處理或另行授權的離線式處理。
- 去重依音訊區間／utterance 所有權／revision；相同句子可能是刻意重複。無可靠對齊時保留兩個候選並標待核對，不能字串相同就刪原話。
- `recovered` 只表示選定區間完成補處理且已保存，仍不保證語音辨識零錯誤。estimated gap 與 sample-exact gap 分開。

### 5.3 恢復與健康

分類：audio-permission、audio-ended、capture-stalled、transport-network、auth、rate-limit、unsupported-capability、storage-retryable、storage-permanent。Retry-After 對 provider／key 槽生效並跨重建保留；網路錯誤不自動宣稱 IP 被拒。

單次網路嘗試有整體 deadline，階段不能各自重設而無限拖長；保留現有翻譯 12 秒上限。純字幕現況 30 秒以上組合需量測後改為同樣可取消的整體預算。授權 picker 與本機模型冷啟動另報階段，不能誤算成網路超時。

PCM 不前進先修收音；有 PCM 但無語音不切 provider；有明確語音／已 commit 活動且長時間無內容才升級停字恢復。保留舊歷史不等於已補回文字。

### 5.4 保存與部署

沿用 SQLite worker、IDB outbox、commit receipt、writer lease，不新增第二個資料庫。純字幕與翻譯共用保存語意；舊 retention 設定遷移要可見，符合已明示的地端完整保存需求。

資料庫 ACK 已確認的文字 RPO 為 0（限本機儲存媒體正常）；未 ACK 但 IDB committed 的資料在同 origin/profile 可重送。RAM only、清除瀏覽資料、磁碟故障與異 profile 不能保證此 RPO。

managed origin 第一次分配後固定記錄 host＋port；重啟先重用。固定埠被其他程序占用時停止自動換 origin，明示原因；不殺占埠者。需要換 origin 必須可見遷移流程及舊 origin 救援，無法存取舊 origin 就標「待救援未知」，不得顯示待存 0。保留現有首次碰撞安全選埠能力。

為處理 host 死亡，最小外部 owner 優先沿用現有 launcher/IPC，必要才抽局部 supervisor；不新增通用程序管理系統或 HTTP 管理埠。workspace owner 持有 named pipe，child 保留單一 UI/API HTTP 程序；最大 3 次／60 秒自動復原，之後停於 failed。Stop 先撤銷 restart intent，再關 child；同 build snapshot 原 origin 重啟，不在會中自動 build/update。

## 6. 驗收門檻（目標，不是現有能力宣稱）

流暢度量測與 clean code 施工界線以[主清單共同放行條件](../plans/2026-10-15-meeting-hardening-checklist.md)為準：新增前景 event→DOM 與操作回應 p95≤100 ms／p99≤250 ms 目標，保留既有 long-task 門檻；實測未通過不得宣稱流暢。沿用 recovery、capture、coalescer、archive 等現有責任，計畫中的新檔名不是必建清單，不為規劃項目數預建平台。

| 面向       | 必須量測與通過的判準                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 場景正確   | 宣稱雙軌則兩路均有獨立 PCM／event／保存證據；單軌故障不停止另一軌；無虛構語者                                                                                                                       |
| 權限／停止 | Stop/Pause 後無新收音與雲端 PCM；所有恢復計時器取消；尾文排空有期限；權限失敗不反覆開 picker                                                                                                        |
| 收音卡住   | 正常 active、非 sleep 時，以最後 PCM 為基準 2 秒內偵測停幀並顯示狀態；靜音不當作斷流                                                                                                                |
| 恢復       | 既有翻譯受控接管 ≤3 秒目標保留，不以 token ready 代替有效字幕；計時從故障注入到首有效內容，另列故障發現耗時。真網路不能套用 mock 數字；超標列未過，不偷偷放寬                                       |
| 完整性     | 受控連續計數音訊跨正常續期、3/10/30 秒中斷：擷取／送出區間與確定性輸出無非預期缺漏／重複；真 ASR 另計錯辨，不假定文字序號天然可靠                                                                   |
| 超出能力   | 90 秒斷網、sleep、renderer crash 明示不可保全區間；不得因刪 gap 紀錄而通過                                                                                                                          |
| 保存       | 已 ACK 全量 100% 可取回；normal finalize pending=0；原稿／校訂／譯文／manifest 同 revision 一致；磁碟錯誤不假成功                                                                                   |
| 品質       | 沿用真人評測目標：逐場景中文 CER≤10%、英文 WER≤15%、critical terms recall≥95%、純字幕首字 p95≤2s、final p95≤3s；否定、金額、日期、責任歸屬逐例列錯。翻譯另以人工語意對照評分，不用 CER 冒充翻譯品質 |
| 效能       | 每個 queue 記單位、容量、溢出策略；2 小時 LOCAL 原生長測，跨多次續期；結束 tracks/peers/timers 回到基線，ring 不超預算；穩態 heap 與 CPU/延遲趨勢無持續惡化，具體機型與基線一同保存                 |
| 易用性     | 每場景至少 3 次獨立啟動；不看工程文件完成「選場景→試音→開始→故障恢復→結案匯出」。記操作數、耗時、失敗原因；可自動恢復故障人工救援 0 次，權限／硬體例外明列，不混入平均                              |

上述所有場景不必一次全部通過才能改善日常版，但未通過的場景不能標「正式支援」。首個日常版只放行完成 V3 的 S1/S2；S3/S4/S5/S6 分別累加門檻，不能永久留作假選項。

## 7. 分階段施工與依賴

施工唯一入口：[主工作清單 W01–W12](../plans/2026-10-15-meeting-hardening-checklist.md)。各包列前置、工作 checkbox、驗收與範圍；細節沿用 A/D/N/V。

1. **W01/W02（A1/A2）**：場景能力、試音、音源與裝置生命週期、故障可見。
2. **W03/W04（A4/A3）**：先完成同服務自救與 OpenAI↔Gemini 雙向接管，再整合有界 PCM／各服務補送資格；基本恢復不等待重播能力。翻譯、純字幕各自驗收，不能互相替代。
3. **W05–W07（D1–D4）**：全量保存、origin、故障閉環、備份還原，可與第二階段獨立推進。
4. **W08/W09（D5/N2）**：服務有界復原與公司網路兩段路徑。Gemini 第二 key 不是公司網路驗收前置。
5. **W10–W12（V1/A5/V2/V3）**：聲學、真雙軌、兩家各一 key 的整合／雙向接管、長測及場域放行。
6. **最後 B00/B02（N1）**：第二 Gemini key 取得且另行開工後，才做同廠內換 key。N3/N4 本機能力依實際資源獨立驗收，不當雙雲端主線前置。

細部施工文件：

- [A：收音、同廠恢復與跨廠接管](../plans/2026-10-15-capture-continuity.md)
- [D：保存與日常服務](../plans/2026-10-15-durability-service.md)
- [N/V：網路、場域驗收與條件式能力](../plans/2026-10-15-venue-release.md)

## 8. 舊計畫對照與完成追蹤

| 舊項目                  | 新工作         | 處置                                                         |
| ----------------------- | -------------- | ------------------------------------------------------------ |
| R1–R4 翻譯恢復          | A2/A4/V2       | 保留已實作能力；補純字幕差異與新故障矩陣，不重新宣稱全部未做 |
| T6/T7 PCM／純字幕續期   | A3/A4          | 拆出上游補送資格；修正「buffer 即保證零缺口」                |
| T8/T9 Gemini key／proxy | N1/N2          | N2 兩段網路先驗；N1 Gemini 第二 key 後排                     |
| L1、B1–B4               | D1–D4          | 純字幕已有主幹；翻譯接入、origin、真失敗／還原仍必要         |
| L2                      | A3/A4/N3/V2    | 短中斷保全與延後本機補處理分開；不可恢復缺口不隱藏           |
| R5/V1、T10–T13          | V1–V3          | 歷史受控長測保留，另列最新 build、真人、網路及還原證據       |
| C/D/E、T14/T15          | 原會議功能藍圖 | 保留但非本輪前置；不增加摘要／語者工作拖延可靠性             |

完成只能以任務測試、原生邊界、場域實測及放行記錄逐級勾選。未通過上游能力 spike 可交付「能力不支援」證據，但不能把依賴它的恢復功能標完成。

## 9. 外部條件與可繼續工作

尚缺：代表性真人錄音及人工稿的使用／外送範圍、指定機型與 USB/BT/HDMI 裝置、可測公司網路及 proxy／CA 設定、真 API 長測預算。這些只阻擋相應場域／品質放行，不阻擋本機 fault injection、來源生命週期、保存與介面施工。

預設不錄音落盤、不自動把 backlog 送另一家未允許的雲端、不關 TLS 驗證、不改系統電源設定、不換 Python runtime。若需雲端跨廠候選，會前選定允許 provider 清單與可見費用範圍；只有已配置且同 purpose 合格者可入列。

## 10. 本輪驗證與限制

本輪已執行：

```powershell
pnpm -F web exec vitest run src/providers/transcription-session.test.ts src/providers/meeting-recovery.test.ts src/providers/transcription-audio.test.ts src/providers/transcription-audio-adapter.test.ts src/providers/capture-lease.test.ts src/store/meeting-archive-client.test.ts src/store/meeting-outbox.test.ts
```

結果：7 檔、80 項通過。另完成 service status、runtime/import 探測、程式路徑交叉核對及文件審查。未新增產品測試案例、未跑完整 regression、未重跑 Chrome/硬體/雲端長測，因本輪交付為診斷與藍圖。開工後不得以本輪 80 項通過取代各任務新的驗收。
