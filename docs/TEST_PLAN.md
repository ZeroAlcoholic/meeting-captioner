# TEST_PLAN.md

## 模組／部署邊界（2026-11-03）

`pnpm test:boundaries` 在 compiler host／Vite loader 虛擬注入地端失敗，驗 online 不載入實作、full 仍驗地端型別，以及錯誤直接引用會被 build 拒絕；不破壞工作中的原始檔。前端地端／Hybrid 單元跟實作放各自目錄，跨模式 capture 與 provider conformance 留共用層。Chrome 的 `deployment-boundaries.spec.ts` 驗 online 下舊地端會議保留／匯出、禁續用、零收音與地端請求；使用 pure-captions fixture，可指定 `PURE_TEST_WEB_DIST`／`PURE_TEST_SERVER_BUNDLE` 核對既有正式產物，不必重建。證據與沿用規則見[架構檢閱](evals/2026-11-03-module-boundary-review.md)；一般啟動不跑測試。

## 雲端 Stop 尾文回歸（2026-11-03）

兩家翻譯須涵蓋 Stop 後才到達的原文／譯文，立即停收音、尾文先保存再結案，SQLite 與 JSON 匯出全文一致；OpenAI WebSocket 另驗 session.close 後的尾字。Gemini 同 frame 回呼同步 Start 不能把剩餘內容寫進新 generation。已有紅綠與 Chrome 證據，範圍／版本見[驗證紀錄](evals/2026-11-03-cloud-stop-verification.md)。依使用者要求，不把重開服務當作重驗理由；僅實質變更補驗對應邊界，未取得真 API／場域資格保持未驗。

## 2026-10-12 會議可用度判準校準

純字幕長測不能以「已知缺口」取代保存成功：Stop 必須顯示已保存且待保存 0 筆。
每分鐘核對 upstream final 與實際畫面序號都有進展；CDP heap 缺失、非有限數或 0 都應失敗。
校訂版匯出須包含首段校訂及其餘所有受控 final 序號，核對遺失、重複與順序。
SQLite 20,100 段案例另核對原稿／校訂稿 JSON 與 TXT，避免把分頁完整性誤當全量匯出。
本輪範圍與最新執行狀態見 [會議校準報告](MEETING_CALIBRATION_2026-10-12.md)。

## 2026-10-12 預設回歸入口

`pnpm test:e2e` 在 Windows 使用 Chrome，其他平台沿用 setup.sh 安裝的 Chromium；
Vite 由測試程序擁有，使用 `127.0.0.1:5207`，不重用使用者的開發服務。
production 純字幕仍須使用下方專用 config，不能混入 dev-server suite。
新增回歸涵蓋交接中 Pause、落選／失敗備援健康狀態、同步 Stop 的來源失敗留存，
以及兩家純字幕 HTTP 400 後保留佇列、繼續收音及明確重試。
本輪結果與證據限制見 [診斷報告](DIAGNOSIS_2026-10-12.md)。

## 純字幕雙雲端與 durable archive 驗收（2026-10-08）

本機測試固定使用已安裝 Chrome，實際 AudioContext／AudioWorklet／Silero／IndexedDB／SQLite，
只替換實體音源與雲端回應；不能當成真實 ASR 準確率。每個 backend 的測試服務綁 loopback port 0、
獨立臨時資料根目錄，teardown 持有自己的 Fastify handle；不與日常 managed 服務爭固定埠。
程序移除 OpenAI/Gemini key，阻擋未指定的非本機 HTTP/WS 與翻譯 endpoints。

```powershell
pnpm -F web build
pnpm -F @meeting-audio/online exec node build-bundle.mjs --managed-output ../../.cache/pure-release/server.cjs
pnpm exec playwright test --config tests/e2e/pure-captions.config.ts
```

音源由 `PURE_TEST_AUDIO` 指向允許使用的 WAV，預設既有 `.cache/live-caption-speech.wav`；
不把這份合成／測試音訊算成真人 gold。runner 記錄 SHA256，取前 12 秒循環供連續原生音訊測試。
短測涵蓋兩家開始／停止／租約更新／重載／校訂／全文匯出。OpenAI 額外驗上游不回 final 時明示缺口，
以及 DB 已提交但 HTTP receipt 遺失後，直接 crash Chrome renderer，再從 IDB 重送且不重複存稿。

長測設定 `PURE_SOAK_MINUTES=60`，兩家各自連續 60 分鐘且平行執行（仍僅一個 shell command）。
每 15 秒觀察原生 PCM、字幕進展、DOM 上限及 JS heap，每分鐘保存 `.cache/pure-soak-results/*/*-soak.json`。
沒有完整時長、正常 Stop／匯出與退出碼成功，不能標成長測通過。定期更新造成的已知缺口必須顯示，
不以「已交付資料」冒充「整段音訊完整辨識」。測試期間保持系統清醒，不能把睡眠時間當成觀察時間。

辨識品質另跑 [混語評測基準](evals/mixed-caption-baseline.md)，24 情境稿不是錄音參考集。
真 API 仍受既有 V1 預算 opt-in；CER/WER、critical errors、term recall、延遲與費用分 backend／場景／holdout 報告。

2026-10-08：819 項回歸、兩家各 60 分鐘原生長測及停止／重載／校訂／匯出通過。另核對實際 SQLite 與 JSON/TXT 的每段資料，並驗證 renderer crash／遺失回執、360px／1280px 與鍵盤全螢幕。數據與限制見 [本機驗證報告](evals/2026-10-08-local-verification.json)。

> Test categories and what counts as evidence.
> See [`CLAUDE.md`](../CLAUDE.md) §"Verification Gates" and §"Required Test Categories".

---

## 接續修復的免費 Chrome 驗證（2026-10-02）

追加原生音訊驗收：先執行 online production web build 與 `pnpm -F @meeting-audio/online bundle`，
再執行 `pnpm exec playwright test --config tests/e2e/native-audio.config.ts`。
此設定把正式 build 複製到 `.cache/native-audio-release`，以不繼承 API keys 的子程序啟動 bundle，
使用 loopback HTTP 503 注入與 Chrome 原生 AudioWorklet，僅實體收音與雲端回應受控。
6 個案例已通過（4 Gemini 原生 PCM、2 OpenAI 原生 loopback RTP）；仍不代表供應商相容性、真實翻譯語意或長時間會議已驗收。

真實時間 LOCAL 長測採 `NATIVE_SOAK_MINUTES=60`，兩路本機端點並行，仍是一個 shell 命令。須保持電腦清醒；系統睡眠、runner 逾時、缺少 Stop 證據都不能算通過。Windows 執行時保留原生命令退出碼：

```powershell
$previousSoakMinutes = $env:NATIVE_SOAK_MINUTES
$nativeSoakExit = 1
try {
  $env:NATIVE_SOAK_MINUTES = '60'
  pnpm exec playwright test --config tests/e2e/native-audio.config.ts
  $nativeSoakExit = $LASTEXITCODE
} finally {
  $env:NATIVE_SOAK_MINUTES = $previousSoakMinutes
}
exit $nativeSoakExit
```

另核對 `.cache/native-soak-results/.last-run.json` 及兩路 `native-soak.json`：狀態均通過、累積完整時長、正常續期與 Stop 釋放音軌證據完整。重新執行前保留上次資料，避免 runner 清空。2026-10-02 那次約 17 分鐘後被系統睡眠中斷，原始資料與 Windows 事件保留於 `.cache/native-soak-interrupted-20261002/`，不可列入完成的 60 分鐘驗收。

量測工具的專用診斷（不屬一般 dev-server E2E；必須使用指定 config）：

- `pnpm exec playwright test --config tests/e2e/native-caption-performance.config.ts`：正式 bundle 的 20／6,000 段歷史、3.125 finals/s 對照；記錄實際耗時與匯出筆數，不另訂寬鬆效能門檻。
- `pnpm exec playwright test --config tests/e2e/assertion-reporting.config.ts`：不啟動瀏覽器的 per-frame Playwright expect／普通條件／Node strict assertion 對照；最多 30,000 frames，協作截止 110 秒。這是量測成本診斷，不能當產品可靠性通過。
- PCM ready／MIME 仍逐框嚴格檢查，使用 Node assertions 避免高頻生成 Playwright steps。不可改成每 N 框才驗證。
- Native 收尾先阻擋新 HTTP、等待已開始的 route callback 完成，再釋放 peers；不以 ignoreErrors 隱藏清理競態。

先執行 `pnpm exec vitest run --config tests/unit/web-regression.config.ts`，
再執行 `pnpm exec playwright test --config tests/e2e/continuity.config.ts`。
單元 config 掃描完整 web／contracts 測試，避開無關的不可讀 Python cache；沒有略過失敗案例。
此專用 config 使用 Chrome 與同程序 Vite global setup／teardown，避免 Windows
透過 pnpm 子程序樹啟停時的收尾卡住。測試用 provider mock；未被 mock 接走的外部
HTTP 與 WebSocket 一律封鎖，不需 KEY，不啟動付費翻譯連線。

案例包含同模型自救、Retry 保留 ID／歷史、雙端失敗後自動恢復、Stop 取消、
無操作跨模型接管、音源 ended、十次加速 GoAway、系統音源分享保留與 Pause／Resume。
十次加速換線屬重複故障回歸，不能稱為兩小時實際會議或真實服務語意完整度證據。
測試期間凍結產品檔案，避免 HMR 干擾；最後回報命令退出碼及所有失敗案例。
真 API／發行版會議驗證另依 [任務清單](superpowers/plans/2026-10-02-meeting-continuity.md)
的預算與證據規則執行。此輪 507 個 web／contracts、90 個 online 服務單元／回歸及 26 個 Chrome 案例通過，詳見
[驗證紀錄與限制](MEETING_CONTINUITY_REPAIR_2026-10-02.md)。

## 線上實測（2026-09-11）

先開實際應用送音訊、看字幕及操作結果，發現問題就修，再做回歸。
目前已用同一段英文測試語音，跑正式前端、Chrome 原生收音管線與真實
OpenAI WebRTC／WebSocket、Gemini；另跑僅 audio KEY 的環境，以及暫停、恢復、
兩模型互切和停止釋放。詳細輸出、發現的缺陷及修正見
[當日診斷紀錄](ONLINE_DIAGNOSIS_2026-09-11.md)。

這些結果不代替實際 Teams／Zoom 系統音訊、遠距多人收音、不同 VPN／網路
或整場長會議的證據；模型誤譯、漏詞也須保留，不能只記錄成功樣本。

## 自動化測試層級

| Level             | Tool                            | Where                            | What it covers                           |
| ----------------- | ------------------------------- | -------------------------------- | ---------------------------------------- |
| Unit              | Vitest                          | `packages/contracts`, `apps/web` | event schema, store reducers, pure logic |
| Component         | Vitest + Testing Library        | `apps/web`                       | React components in isolation            |
| Service unit      | Vitest                          | `services/online`                | route handlers, validators               |
| Service unit (Py) | pytest                          | `services/offline`               | adapters, VAD, streaming policy          |
| Integration       | scripts in `tests/integration/` | spawn services, hit endpoints    | service ↔ contract correctness           |
| E2E               | Playwright                      | `tests/e2e/`                     | full UI flows, fake replay               |
| Stability         | custom harness                  | `tests/stability/`               | long-running memory + reconnect          |

---

## Required Test Categories (from CLAUDE.md)

- [x] event schema normalization — `apps/web/src/providers/provider-conformance.test.ts` validates every event each provider emits against the shared `NormalizedEvent` zod schema; `packages/contracts` schema parse/reject tests
- [x] fake transcript replay — `tests/e2e/fake-replay.spec.ts`, `FakeReplayProvider` conformance
- [x] caption ring buffer bounds — `caption-store.test.ts` (single-burst) + `caption-store.soak.test.ts` (sustained interleaved load) + `paragraph-grouping.property.test.ts`
- [x] provider switch without transcript loss — `mode-switch.spec.ts`, `scenario-switch.spec.ts`, and the cross-model failover path in `online-keepalive.spec.ts`
- [ ] no-audio-track handling
- [ ] audio source ended handling
- [x] silence warning — `openai-realtime-provider.test.ts` (silence_detected after 30 s)
- [x] online API failure — `online-keepalive.spec.ts` (renewal /session 500 → failover banner) + provider unit tests
- [ ] offline server unavailable
- [ ] model loading failure
- [x] translation failure isolation — `caption-store.test.ts` (translation failure isolation suite)
- [ ] summary failure isolation
- [ ] API key leak check (build artifact scan)
- [x] long-running memory stability — `caption-store.soak.test.ts` (5 000-turn soak + 200-session churn, all bounds held)

---

## Acceptable Evidence (per CLAUDE.md §"Verification Gates")

A task is not complete unless it has:

- passing automated tests, or
- Playwright browser verification, or
- screenshot of UI state, or
- reproducible manual test steps documented in the PR/commit, or
- log excerpt without secrets, or
- fake event replay result, or
- offline engine health check, or
- long-running buffer test result.

"It compiles" / "it ran once" is **not** acceptable.

---

## P0 Test Inventory (target)

- `packages/contracts`: schema parse + reject tests for each event type
- `apps/web/store`: ring-buffer eviction at capacity, partial→revised→final transitions
- `tests/e2e/fake-replay.spec.ts`: open page → click Start Fake Replay → assert at least one `final` caption visible

---

## KEEPALIVE reliability verification (T0–T2)

The dual-model online reliability work (zero-gap renewal, persistent reconnect,
cross-model failover) is covered by three automated tiers so its regressions are
caught in CI, not by hand:

### T0 — mock-backend fault-injection e2e (`tests/e2e/online-keepalive.spec.ts`)

Runs the REAL provider → store → caption-board → failover-UI loop in Chromium
against an in-browser mock backend (`tests/e2e/online-mock.ts`) — no cloud key.
`installOnlineMocks(page)` replaces `RTCPeerConnection`/`RTCDataChannel`,
`WebSocket` (Gemini host only), `getUserMedia`/`getDisplayMedia`, and
`AudioContext`, and routes the `/session*` + OpenAI SDP endpoints; the returned
controller injects faults (emit deltas, `session.closed`, fail `/session` from
the Nth call, drop the Gemini socket) and reads counters (microphone vs display
capture acquisitions, peer count). Cases:

- OpenAI deltas render source + target captions and finalize.
- Online Meeting Caption Box (`audioSource: system`) starts both OpenAI and
  Gemini through `getDisplayMedia`, not `getUserMedia`, and captions still
  render through the provider → store → board path. OpenAI adds only audio
  tracks to its peer connection even though display capture includes a disabled
  video track. This proves the architecture can exercise browser/system audio
  for the YouTube/news-playback field test; it does not claim to automate
  Chrome's real screen-share picker. A dedicated e2e also verifies the explicit
  `● Test` UI control records field-test history only after the operator opts
  in, and that app Stop finishes the run.
- Full Offline idle mode does not prewarm OpenAI or Gemini cloud tokens.
- Paused OpenAI/Gemini backend switching persists the resumed backend so crash
  Continue restarts the correct provider.
- `session.closed` → zero-gap renewal: a 2nd peer is built, the mic is REUSED
  (getUserMedia stays at 1), history preserved, new session still captions.
- Repeated renewals (×5) stay zero-gap — mic acquired once, header status never
  blanks (always shows the live backend), peer count == renewals+1.
- OpenAI renewal failure → `failed` health → failover banner → one click
  continues on Gemini with the transcript preserved.
- If the target online backend is unavailable, failover stays hidden and the
  current self-retrying provider is not stopped.
- Gemini renders captions and auto-reconnects after a server-side drop.
- Gemini Live Translate setup is locked by unit test to the speed-first official
  path: `responseModalities:["AUDIO"]`, `inputAudioTranscription`,
  `outputAudioTranscription`, and `translationConfig` inside
  `generationConfig`. Another regression test covers output-first Gemini
  streaming: `outputTranscription` creates a live transcript anchor before the
  draft translation so LiveCaption does not wait for `inputTranscription`.

> The ~30 s wedge detector and the ~31 s Gemini→`failed` backoff are timing-bound
> and remain covered by the fake-timer unit tests (`*-provider.test.ts`), not e2e.

### T1 — soak + zero-gap renewal

- `apps/web/src/store/caption-store.soak.test.ts` — 5 000-turn interleaved
  partial/final + draft/final stream and 200-session begin/clear churn; asserts
  the render-path invariants hold THROUGHOUT: `segments[]` reference stable
  across partial deltas, ring buffer capped at `maxSegments`, translations never
  orphan-leak, and the render feed (`tailSegments` → `groupParagraphsForSide`)
  bounded by `HISTORY_RENDER_SEGMENTS`. (Structural bounds, not raw heap samples
  — deterministic, not GC-noisy.)
- The repeated-renewal e2e above is the zero-gap "mic acquired once across N
  renewals, no blank window" assertion.

### T2 — provider conformance matrix + property tests

- `apps/web/src/providers/provider-conformance.test.ts` — every event emitted by
  OpenAI / Gemini / offline / fake providers (happy + failure flows) is validated
  against `NormalizedEvent`. Enforces "UI consumes normalized events only".
- `apps/web/src/components/GeminiPricingPanel.test.ts` — locks the Gemini Live
  Translate cost chip to AUDIO-mode input + output audio pricing, not the old
  TEXT-output lower bound.
- `apps/web/src/caption-board/paragraph-grouping.property.test.ts` — seeded-PRNG
  property tests for `tailSegments` (length/suffix-identity/reference-stability)
  and `groupParagraphsForSide` (content preservation, ordering, confidence
  fidelity, bounded paragraph count).

Run: `pnpm -F @meeting-audio/web test` (unit incl. T1/T2) and
`pnpm test:e2e` (T0). All green as of 2026-06-12 (251 web unit, 20 e2e).

---

## Phase 1 closure verification (2026-07-30)

| Requirement                                   | Automated evidence                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Gemini exact model/setup/ack/no fallback      | `gemini-live-provider.test.ts`, online config/route tests                                            |
| Retention default-off and race-safe disable   | `caption-persistence.test.ts`, caption-store/settings tests, retention-aware E2E                     |
| Stop-before-switch and resource release       | `mode-switch.spec.ts`, `scenario-switch.spec.ts`, `online-keepalive.spec.ts` capture/peer counters   |
| MT backpressure outside caption receive loop  | `test_translation_dispatcher.py`, `test_asr_session.py`                                              |
| Loopback-only production launch               | `test_launch_policy.py`, `bash -n services/offline/start.sh`                                         |
| Normalized event boundary and bounded history | provider conformance/property/soak tests                                                             |
| Recorded upstream fixture integrity           | `probe-upstream-contracts.test.ts`, `verify:upstream-contracts` (fails closed when files are absent) |

Release matrix last run on 2026-07-30:

```text
pnpm test              # contracts 19, online 65, web 293
pnpm test:e2e          # Playwright 30
pnpm lint              # 0 errors, 0 warnings
pnpm format:check      # pass
pnpm typecheck         # pass
pnpm build             # pass
& 'C:\Programs\miniforge3\envs\deve\python.exe' -m pytest services/offline/tests -q # offline 81
cd services/offline && uv run ruff check . # pass
```

The live-key operation remains separate from CI. Run
`pnpm -F @meeting-audio/online probe:upstream-contracts` only with explicit
credential authorization. Acceptance requires both redacted files under
`tests/fixtures/upstream-contracts/`, a passing
`pnpm -F @meeting-audio/online verify:upstream-contracts`, and a manual check
that no source API key, ephemeral token, session id, or unstable timestamp
remains. The verifier reads both stored artifacts and fails if either file is
missing or violates the exact model/schema contract. The provider unit test
must also compare its emitted setup with the recorded `clientFrame`, and the
E2E mock must source its acknowledgement from the recorded `serverFrame`.

Completed 2026-07-30 with explicit authorization: both live calls passed, no
audio/transcript was sent, `b8029e6` records the redacted fixtures and golden
consumers, the verifier and source-key scans passed, and the complete matrix
above was rerun successfully.

---

## Open Questions

- The Phase 4 real-session soak target remains 30–60 minutes plus a 1-hour
  bounded-heap run; the former 4-hour default is explicitly deferred.

原生 WebRTC 驗收另包含 SDP 候選 503 保留主線、session.created 前 DataChannel 關閉不接管、主線 DC 單獨關閉即續期、Stop 清理。接收端以 inbound RTP packets 增量與 AnalyserNode 解碼 PCM RMS>0 為證；此 Chrome loopback 的 totalAudioEnergy 為0，原值仍寫入 JSON。測試清除 STUN，只涵蓋本機 ICE，不冒充外網 NAT 或真雲端語意。
