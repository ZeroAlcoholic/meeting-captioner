# 診斷檢閱與精準藍圖（2026-07-29）

- 基礎文件：[PROJECT_DIAGNOSTIC_COMBINED_2026-07-28.md](PROJECT_DIAGNOSTIC_COMBINED_2026-07-28.md)
- 本文件性質：對該報告的檢閱裁決＋三路延遲深稽核補充＋分階段工作清單（單一真相源）
- 裁決基準（使用者 2026-07-28 明令）：**即時性 > 費用**；**強制最新專用模型**（OpenAI `gpt-realtime-translate`、Gemini `gemini-3.5-live-translate-preview`）

## 1. 對 7/28 合併報告的檢閱裁決

報告事實層（A/B 級證據）**成立**，五項 P0 已逐一在工作樹親驗屬實。但其修復清單是「嚴重度排序」而非「執行排序」，且有六個盲點，本藍圖已修正：

1. **Dirty working tree 是第 0 個 P0**：37 修改檔＋23 新檔未提交，Gemini setup 回歸是工作樹引入（HEAD 原本正確）。不先切 commit，所有修復無法歸因。
2. **O-1／O-15／gate#2 同根因**：mock fixture 由實作反推。統一解法＝真實探針錄製 golden frames 作為契約單一真相源，mock/unit 從它生成。
3. **O-2 用鎖切換取代原子 handoff**：running 期間鎖 mode/scenario/backend 切換（先 Stop），原子 handoff 屬過度工程。
4. **費用類 A/B 全面降級**：AUDIO modality 保留（現場回報 TEXT-only 較慢）；modality 與 chunk 決策只看 speech→paint 延遲量測。
5. **F-2/F-3 不實文案下架是最便宜修復**，提前執行，不等實作補齊。
6. **Release gate 校準單機部署形態**：LAN 用 loopback-only 一刀解；4h soak 降 1h＋bounded heap；多語向矩陣 defer。

## 2. 三路延遲深稽核補充結論（2026-07-28，file:line 已親驗）

### 線上

- OpenAI 上行近理論最佳（WebRTC 原生軌 ~+20ms，不經 worklet；`openai-realtime-provider.ts:451`）。852ms 首字為模型端，客戶端無可再壓。
- Gemini 現行 32ms chunk（`gemini-live-provider.ts:28`）是實測較慢組態（3927ms vs 100ms 組 3313ms）；setup 1007 回歸在 `:414-424`。
- **Failover 是冷備**：standby token 不預鑄（`use-openai-realtime.ts:96`、`use-gemini-live.ts:71`）、麥克風不跨 provider 共用、Gemini failed 訊號需 ~31s（5 次 backoff）。
- OpenAI 排程續期近無縫；故障觸發續期有真實斷字幕窗（首次重試 backoff 30s）。

### Web 熱路徑（大多已最佳化，勿重做）

僅存三個停頓源：`caption-store.ts:475-479` 連續講話每 ~5s 在 final 內同步 stringify+localStorage（持久化改 opt-in 即消除）；`latency-monitor.ts:193-206` 每 15s 內聯 summary+localStorage（移 idle callback）；`CaptionBoard.tsx:379-383` 每 delta scrollHeight 回流（sub-ms，觀察即可）。
已確認良好：live/history memo 隔離、33ms coalesce、字幕文字零 CSS transition、O(400) capped 段落分組、token 預鑄＋TLS preconnect、make-before-break。

### Offline

- 最大未調校槓桿：**WHL min_chunk/step 從未設定**（內部 ~1s 累積主導 partial 延遲）。
- 瀏覽器 offline chunk 256ms（Gemini 為 32ms）；MT 無啟動預熱（首句吃 CT2 載入，最多 5s）。
- S-1 精確化：MT 飽和阻塞時當則訊息 caption 已先送（`asr.py:227-228` 先於 `:233`），阻的是下一則；修法仍是 cap-wait 移出 recv_loop。
- 原 production 啟動腳本帶 `--reload`（dev 模式）；已於 1.6／`2adcd78` 移除。

### 最新模型保證現狀

- OpenAI：已硬編鎖死（`session.ts:159/146`）✅
- Gemini：原缺口為 `GEMINI_LIVE_MODEL: z.string()` 任意覆寫＋瀏覽器端 native-audio 靜默 fallback；已於 1.2／`13f6311` 改為 exact model 與 fail-fast。

## 3. 已完成項（2026-07-29）

- ✅ **OpenAI 雙 key 自動切換**：主 key `OPENAI_API_KEY`（網域受限 service account）被上游 401/403 拒絕時，自動改用 `OPENAI_API_KEY_AUDIO` 重試一次並黏著切換；429/5xx/逾時不切。涵蓋 /session、/translate、/healthz（新增 `openai_key_slot`）。新模組 `services/online/src/openai-keys.ts`＋12 個新測試，online service 60/60 綠、tsc 通過。RUNBOOK 已更新。
  - 待辦尾巴：用真受限 key 打一次 `POST /session` smoke，確認 slot 轉 `audio`。
  - 注意：`OPENAI_API_KEY_AUDIO` 為 setx 新增，既有終端機行程看不到，需新開終端機重啟伺服器。

## 4. 分階段工作清單

### 階段 0：基準固定（0.5 天）

| #   | 任務                                                                                  | 驗收                     |
| --- | ------------------------------------------------------------------------------------- | ------------------------ |
| 0.1 | 工作樹依功能切可驗證 commit（含 3. 的 key failover）；Gemini setup 回歸段不照現狀提交 | 每 commit 測試綠、可歸因 |
| 0.2 | 真實 upstream smoke 腳本（雙 provider），錄去敏 golden frames 入 repo                 | 本機可跑、frames 落檔    |

### 階段 1：P0——正確性、隱私、最新模型（2–3 天）

| #   | 任務                                                                                                  | 依據              |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| 1.1 | Gemini transcription 欄位還原 setup 頂層；connect() 等 setupComplete；fixture 改由 golden frames 生成 | O-1＋O-3          |
| 1.2 | Gemini model allowlist（zod enum 僅允許最新 translate model）；native-audio fallback 改啟動即失敗     | O-7、最新模型保證 |
| 1.3 | 字幕持久化改 opt-in 預設關閉（同時消除 F4/F5 熱路徑停頓）                                             | F-1               |
| 1.4 | running 期間鎖 mode/scenario/backend 切換；Stop 保證釋放 mic/WS                                       | O-2、O-12         |
| 1.5 | MT cap-wait 移出 recv_loop（獨立 dispatcher＋bounded queue＋drop-oldest＋degraded 事件）              | S-1               |
| 1.6 | 預設綁 127.0.0.1（run_whl.py＋start scripts）；移除 production `--reload`                             | S-3               |

#### 階段 1 收尾狀態（2026-07-30）

| 項目                                     | 證據                                                                                                                                                                      | 狀態               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 0.2 / 1.1 real upstream golden contracts | `3089e3d`/`3e6a30d`；probe、4 個去敏/shape/read-back 測試與 fail-closed verifier 已備妥；live fixture、provider test clientFrame 比對與 E2E mock serverFrame 消費仍待完成 | ⏳ 未驗證          |
| 1.1 / 1.2 Gemini setup/model             | `13f6311`；setupComplete/close/timeout、exact model、無 fallback 測試                                                                                                     | ✅ local gate 通過 |
| 1.3 retention opt-in                     | `c587fc2`；default-off、race-safe clear、UI/E2E                                                                                                                           | ✅ local gate 通過 |
| 1.4 active-session lock                  | `7dd2362`；mode/scenario/backend/language lock、Stop 資源計數                                                                                                             | ✅ local gate 通過 |
| 1.5 MT dispatcher                        | `b67d810`；FIFO、drop-oldest、degraded、cancel/no-late-emit                                                                                                               | ✅ local gate 通過 |
| 1.6 loopback launch                      | `2adcd78`；8 policy tests、Bash syntax                                                                                                                                    | ✅ local gate 通過 |
| release hygiene                          | `171c05b`/`68125d4`；format/lint/Ruff/typecheck/build、完整測試矩陣與無 process-listener 測試洩漏                                                                         | ✅ 通過            |

因此目前是「程式實作完成、外部契約證據未完成」，**不得宣告階段 1
完成**。只有真實 probe 成功、兩份去敏 fixture 通過 read-back verifier 與
人工去敏檢查、provider unit/E2E mock 直接消費 golden frames，並重跑完整
gate 後，才能把 0.2/1.1 與整個階段改為完成。

### 階段 2：即時性強化（2–3 天）

| #   | 任務                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| 2.1 | 可稽核 speech→paint 延遲管線（marker → normalized event → DOM paint；JSONL＋p50/p95 入 repo）——一切調校的量尺，先建 |
| 2.2 | Failover 熱備：standby token 預鑄（至少 degraded 時）、麥克風 stream 跨 provider 共用、Gemini failed 訊號提前       |
| 2.3 | Gemini chunk A/B（32 vs 100ms，足量樣本）採勝者；同管線驗證 AUDIO 確實比 TEXT 快（判準＝延遲）                      |
| 2.4 | Offline 三連：WHL min_chunk 調校、瀏覽器 chunk 降階測試、MT 啟動預熱                                                |
| 2.5 | 熱路徑停頓清除：latency-monitor persist 移 idle callback；opt-in 持久化開啟時 flush 非同步排程                      |
| 2.6 | OpenAI 故障續期斷字幕窗量測與收斂                                                                                   |

### 階段 3：可靠性與誠實性（約 2 天）

3.1 Gemini stop 送 audioStreamEnd＋drain；MT pending session fence（O-5、S-2）。3.2 音訊初始化失敗轉 failed、source metadata 修真（O-4、O-11）。3.3 healthz/start scripts 支援 OpenAI-only／Gemini-only／both（O-8）。3.4 下架不實文案，延遲宣稱改用 2.1 實測值（F-2、F-3、O-13）。3.5 Offline MT readiness 檢查與 UI 顯示（S-4）。

### 階段 4：驗證與收尾（2–3 天）

4.1 30–60 分鐘真實會議 E2E＋1h soak＋bounded heap。4.2 Gemini v1beta 遷移＋constrained token 1011 重測矩陣。4.3 OpenAI 續期改 `session.created.session.expires_at`＋margin（保留 fallback）。4.4 供應鏈 7 high 升級、format/ruff。4.5 stabilizer `_slices` prune（S-6）。

### 明確 Defer

TEXT/AUDIO 費用 A/B（決策只看延遲，併入 2.3）；Electron；summary pipeline 實作；Hybrid separate tracks 實作；多語向／多人統計矩陣；4h soak（降 1h）。

## 5. Release gate（校準單機部署形態後）

1. 兩 provider 鎖最新專用模型，禁止靜默降級。
2. release 前真實 upstream contract smoke（golden frames）。
3. speech onset → caption paint 完整量測（p50/p95 入檔）。
4. 30–60 分鐘會議無縫續期／resumption、不錯配不漏尾句。
5. 模式／scenario／provider 切換零殘留收音與計費連線。
6. caption path 在 MT/summary/storage/網路故障下不被阻塞。
7. 預設不持久化逐字稿；預設不暴露 LAN；key 不進 browser/log。
8. UI 只宣稱有實測背書的能力與延遲。

## 6. 風險提示

- 1.1 動 fixture 前必須先有 0.2 golden frames，否則重蹈 fixture 反推實作。
- 2.2 麥克風共用動到雙 provider 生命週期，需 keepalive e2e 回歸。
- 1.3 已改為預設不保存；設定文案與測試必須持續鎖住明確 opt-in 與關閉即刪除語意。
- 4.2 constrained token 有 1011 歷史，需完整矩陣重測。

總估 9–12 個工作天。階段 0＋1 的完成條件仍是「兩個最新模型真實可用＋隱私合規」；目前因 0.2 live probe 未執行，尚未達成。階段 2 完成＝即時性有量測背書；階段 3–4 完成才談 production ready。
