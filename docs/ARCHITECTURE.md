# ARCHITECTURE.md

> System architecture. Read together with [`CLAUDE.md`](../CLAUDE.md) and
> [`REFERENCE.md`](../REFERENCE.md).

## 雲端／地端模組邊界（2026-11-03）

`services/online` 與 `services/offline` 的 Node／Python 程序分離維持不變。前端地端專屬實作與 Hybrid 編排已各自收攏；這是現行依賴邊界，不以搬資料夾替代離線品質驗收。

| 位置                                               | 責任／允許依賴                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/web/src/providers/offline/`                  | 地端 WebSocket adapter、STT hook 與專屬測試；可用共用 capture／contracts，不匯入雲端 adapter。         |
| `apps/web/src/providers/hybrid/`                   | 地端 STT＋雲端文字 MT 的唯一編排點；依賴 offline adapter 與文字端點，不把 cloud client 放進 Python。   |
| `apps/web/src/providers/local-mode-controller.ts`  | UI 能力介面；不依賴任一地端實作。                                                                      |
| `apps/web/src/providers/local-mode-unavailable.ts` | 雲端版明確不可用能力；不連地端、不取得音源，Start 明確拒絕。                                           |
| `apps/web/src/providers/` 其他現有模組             | 雲端 adapter、共用 capture／PCM／VAD、恢復、事件交付及跨模式測試；本輪保留雲端檔案位置。               |
| `packages/contracts/`                              | 共用標準化事件，provider 不得把原始服務格式傳給 UI；修改此層須評估兩端。                               |
| `services/offline/app/capture/`、`app/pipeline/`   | WASAPI、ASR、stabilizer、MT dispatcher、MT、後處理與事件工廠；維持現有職責拆分。                       |
| `services/online/src/storage/`                     | 目前與 API broker 同程序的本機 SQLite 保存；它是本機平台功能，不能因目錄名稱就當成需要外送的雲端模型。 |

App 透過 `@meeting-audio/offline-stt`／`@meeting-audio/hybrid` 取得控制器。完整版本的 TypeScript／Vite 對應真實實作；雲端版本對應 unavailable 能力。舊 Offline／Hybrid 會議在雲端版仍可檢視／匯出，但 Continue 明確停用並說明原因，不能靜默改成雲端送音。

### 建置與防止跨界引用

- `pnpm -F web build`：完整前端，檢查地端與 Hybrid 程式及測試。
- `pnpm -F web build:online`：`tsconfig.online.json`＋`vite.online.config.ts`；不把地端實作／測試放進編譯集合，保留 production 環境設定的載入語意。
- managed `service:start` 與 Windows／Unix online ZIP 使用 online 編譯邊界；不啟動 Python／模型。未把測試加入啟動路徑。
- Vite 雲端建置禁止載入 `providers/offline/`／`providers/hybrid/`。`pnpm test:boundaries` 用真正的 TypeScript program／Vite build 注入地端型別／載入失敗，驗雲端不受影響、full 仍檢查地端，並驗新增直接引用會被拒絕。一般 `pnpm test` 包含這個檢查。
- PCM worklet、Silero VAD、OpenCC 與 capture lease 同樣服務雲端功能；不得誤刪為「地端專屬」。共用平台／contracts 的變更可能合理影響兩端，不能承諾零回歸。

已確認的地端契約錯標、runtime／模型資源問題與後續開工順序，見[本輪檢閱](evals/2026-11-03-module-boundary-review.md)。相關程式／設定未變更時沿用既有驗證，不因重開服務重跑。

---

## 1. Layered Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Interface / Routing  (apps/web — Vite + React + TS)         │
│  - scenario picker     - mode selector  - caption board       │
│  - summary sidebar     - health surface                       │
└──────────────▲──────────────────────────────▲────────────────┘
               │ normalized events             │ normalized events
               │ (TranscriptEvent, ...)        │
┌──────────────┴───────────────┐  ┌────────────┴───────────────┐
│  Online Realtime Layer        │  │  Offline Local Layer        │
│  (services/online — Fastify)  │  │  (services/offline — Python)│
│  - OpenAI session endpoint    │  │  - WhisperLive / fw STT     │
│  - SDP/token broker           │  │  - VAD + streaming policy   │
│  - WebSocket bridge for       │  │  - OPUS-MT / CTranslate2    │
│    backend audio              │  │  - WASAPI loopback (Win)    │
└───────────────────────────────┘  └────────────────────────────┘
```

Mode selection decides routing per track: Online Full uses cloud adapters,
Full Offline uses local STT/MT, and Hybrid Privacy explicitly composes local
STT with online text MT. Each track has one active STT owner; all adapters
emit normalized events into the shared UI and persistence path.

---

## 2. Packages and Services

| Path                  | Role                                               | Stack                      |
| --------------------- | -------------------------------------------------- | -------------------------- |
| `apps/web/`           | Renderer UI: caption board, mode/scenario controls | Vite + React + TS          |
| `services/online/`    | OpenAI session bridge, key isolation               | Node 22 + Fastify          |
| `services/offline/`   | Local STT/MT bridge, audio capture                 | Python 3.11 + FastAPI + uv |
| `packages/contracts/` | Normalized event schemas (TS + zod)                | TS                         |
| `tests/e2e/`          | Cross-app Playwright tests                         | Playwright                 |
| `scripts/`            | Bootstrap and doctor                               | PowerShell + bash          |

---

## 3. Data Flow (P0 — fake replay path)

```
fake-transcript.json
        │
        ▼
FakeReplayProvider ──► caption store (bounded ring buffer)
                              │
                              ▼
                        CaptionBoard (React)
```

This is the **canonical regression harness** for the caption path.

## 3a. Data Flow (Online Realtime — implemented)

OpenAI uses WebRTC with same-key WebSocket fallback, then an alternate server
key only after authentication rejection. Gemini uses v1beta constrained
WebSocket with server-minted ephemeral tokens. Both adapters emit the same
normalized events into the caption store. Cross-provider recovery reuses the
audio capture lease and preserves meeting history; a user-requested fresh start
finishes the previous provider's tail before clearing the store.

```
mic / tab audio (browser)
        │
        ▼
WebRTC ◄─── short-lived token from services/online (which holds API key)
        │
        ▼
OpenAI Realtime Translation ──► provider adapter ──► normalized events
                                                            │
                                                            ▼
                                                       caption store
                                                            │
                                                            ▼
                                                       CaptionBoard
```

OpenAI storage segmentation may emit an optional normalized `continuationOf`
link for hard duration boundaries. The live view reads one predecessor's bounded
tail; history and export keep the original segment text. Renewal additionally
keeps one retired transport for a bounded final drain: its late deltas update
only the captured old segment ID, in a single final batch, while new live
captions continue independently.

## 3b. Data Flow (Full Offline implementation — usability not accepted)

The code path below exists, but is not evidence of a usable offline meeting
system. User-reported latency/quality failures and later diagnostics supersede
older completion claims. See [current evidence and limitations](evals/2026-10-22-offline-calibration.md).

```
audio source (mic / WASAPI loopback)
        │
        ▼
WhisperLive / faster-whisper (separate process, default distil-large-v3)
        │ partial / revised / final segments
        ▼
services/offline (Python) — SegmentStabilizer
        │ normalized transcript events ──────────────────────┐
        │ finalized text → bounded MT queue (non-blocking)    │
        ▼                                                    │
OPUS-MT / CTranslate2 → OpenCC / glossary → translation events │
        │                                                    │
        └───────────────────┬────────────────────────────────┘
                            ▼
WebSocket → OfflineSTTProvider → caption store → CaptionBoard
```

The implementation uses `whisper_live.server`, not WhisperLiveKit. MT caller
timeouts do not terminate an already-running executor thread. Granite direct
audio translation is not implemented; it cannot replace a text-only MT call
without audio segmentation and honest source-transcript/event alignment.

---

## 4. Event Contracts

All defined in `packages/contracts`. UI imports types from there only.

- `TranscriptEvent` — { provider, mode, source, segmentId, status, text, startMs, endMs?, confidence?, revisionOf? }
- `TranslationEvent` — { provider, mode, sourceSegmentId, status, sourceText, targetText, sourceLanguage, targetLanguage, updatedAt }
- `HealthEvent` — { component, state, message?, timestamp }
- `AudioLevelEvent` — { source, rmsDb, peakDb, timestamp }

Statuses:

- Transcript: `partial | revised | final`
- Translation: `draft | refined | final`
- Health: `idle | requesting_permission | connecting | connected | reconnecting | degraded | failed | stopped | no_audio_track | silence | model_loading | offline_unavailable | api_error`

See [`CLAUDE.md`](../CLAUDE.md) §"Required Transcript/Translation Event Semantics" and §"Reliability Requirements".

---

## 5. Provider Abstraction

Every audio/STT/MT integration implements an interface that emits the
contracts above. The UI never imports OpenAI / WhisperLiveKit / Argos
SDKs directly.

P0 ships only `FakeReplayProvider`. Future providers:

- `OpenAIRealtimeProvider` (P2)
- `OfflineSTTProvider` wrapping WhisperLiveKit (P3)
- `OfflineMTProvider` wrapping Argos (P4)
- `MicrophoneAudioProvider` / `BrowserTabAudioProvider` / `WindowsLoopbackAudioProvider`

---

## 6. Process / Port Map

日常 Windows 入口以 `pnpm service:status/start/stop` 為準：工作區 owner 持有 named pipe，單一 HTTP 子程序同時提供 production web 與 online API。首次可選可用埠，後續重啟固定原 origin。owner 只建置一次，子程序故障沿同一份建置最多重啟 3 次／60 秒；Stop 先撤銷重啟意圖，再停止持有的 child handle。沒有新增管理 HTTP 埠或系統服務。W08.1 程序復原已完成本機驗收；正式 bundle 的 Gemini 翻譯原頁保存接續一案已驗，其他前端接續資格仍屬 W08.2。下表是獨立 HMR／完整離線開發入口，不應與日常服務無目的地重複啟動。

| Process           | Port (default) | How to start                                                     |
| ----------------- | -------------- | ---------------------------------------------------------------- |
| Web (Vite dev)    | 5173           | `pnpm -F web dev`                                                |
| Online (Fastify)  | 8787           | `pnpm -F online dev`                                             |
| Offline (FastAPI) | 8000           | `cd services/offline && uv run uvicorn app.main:app --port 8000` |

All ports are overridable via `.env`.

### 純字幕與持久化（2026-10-08）

`captionTask` 區分 translation 與 transcription。純字幕經 `TranscriptionSession` 選擇 `OpenAITranscriptionProvider` 或 `GeminiTranscriptionProvider`，共用原生 capture／Silero VAD；各自 broker 簽發短效憑證，瀏覽器不取得長效 key。供應商協定轉成 contracts transcript／health／audio-level 事件後，字幕 coalescer 與 archive 分流。

純字幕 Silero 模型由 `transcription-vad.worker.ts` 單獨持有，初始化與推論不在 UI 主執行緒執行；`transcription-vad.ts` 負責單一待回覆請求、期限、取消與終止。既有 `transcription-audio.ts` 仍持有收音節點、重採樣、有界幀佇列與尾音 drain，沒有新增收音 owner。每個音訊 adapter 一個 worker，候選續期才暫時重疊；PCM 傳副本，模型狀態不跨 worker 轉移。初始化／推論期限與錯誤行為見 FAILURE_MODES；本機效能證據不代表真服務或低效能裝置已放行。

Gemini 手動 activity 與文字 segment 分開管理：同 activity 可有多個 final，直到 generationComplete 才退休並送下一個 activity。收音持續，短暫排隊最多 256 訊息；Stop 等待未完成 generation 與佇列，5 秒期限耗盡留下缺口。final 後的純音訊幀不建立空文字片段；字幕時間使用擷取區間估計，無字級時間時可能重疊。

archive 先寫獨立 IndexedDB outbox，經 loopback token 與 writer lease 批次送出；SQLite worker 的事件與投影在同一交易內提交後才回 ACK。UI 最近 200 段只是 viewport，完整逐字稿由 SQLite 分頁讀取。人工校訂以 optimistic revision 保留原稿與事件；TXT／JSON／SRT 從已提交 snapshot 匯出。中斷、未完成辨識、未存資料分別顯示，重連不代表缺口已補回。SQLite 原生執行環境目前在 Node 24.14 驗證；純字幕離線與真實雲端辨識品質仍待驗收。

---

## 7. Future Topology (post-MVP)

When packaged with Electron (P7):

- Main process spawns `services/online` and `services/offline` as sidecars
- Renderer keeps the same web URL contract — IPC only for OS-only features
  (window controls, file dialogs, native audio enumeration)
- No code under `apps/web` should branch on Electron vs browser; that
  branching lives in a thin adapter layer
