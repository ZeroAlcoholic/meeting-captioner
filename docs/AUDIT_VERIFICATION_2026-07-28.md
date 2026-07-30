# 診斷複核報告 — 2026-07-28

對前一份「修正版完整診斷報告」的逐條驗證。本文只做**裁決與取證**，未修改任何專案原始碼。

- 驗證日期：2026-07-28
- 驗證基準：工作樹（uncommitted），HEAD = `f847dcd`
- 真實 API 探針：`GEMINI_API_KEY`（39 chars）、`OPENAI_API_KEY`（167 chars）皆存在於系統環境

**一句話結論**：原報告的**代碼層事實幾乎全部屬實**，但**根因排序錯誤**，且**第 7 項修復建議會造成回歸**。真正的 Gemini P0 只有一個原因，而且來自一個**尚未 commit 的工作區改動**。

---

## 一、決定性證據：Gemini setup 握手矩陣（本輪實測）

原報告未隔離「API 版本」與「欄位位置」兩個變因，也未說明其成功樣本走的是 ephemeral token 還是 raw key。本輪以 8 組正交組合、**零音訊、只送一個 setup frame** 重測（成本可忽略）。

| 端點版本 | 認證路徑                      | transcription 欄位位置               | 結果                      |
| -------- | ----------------------------- | ------------------------------------ | ------------------------- |
| v1alpha  | Constrained + ephemeral       | `generationConfig`（**現行工作區**） | ❌ CLOSE 1007             |
| v1alpha  | Constrained + ephemeral       | setup 頂層（**已 commit 版**）       | ✅ `{"setupComplete":{}}` |
| v1alpha  | BidiGenerateContent + raw key | `generationConfig`                   | ❌ CLOSE 1007             |
| v1alpha  | BidiGenerateContent + raw key | setup 頂層                           | ✅ `{"setupComplete":{}}` |
| v1beta   | Constrained + ephemeral       | `generationConfig`                   | ❌ CLOSE 1007             |
| v1beta   | Constrained + ephemeral       | setup 頂層                           | ✅ `{"setupComplete":{}}` |
| v1beta   | BidiGenerateContent + raw key | `generationConfig`                   | ❌ CLOSE 1007             |
| v1beta   | BidiGenerateContent + raw key | setup 頂層                           | ✅ `{"setupComplete":{}}` |

八組錯誤訊息完全相同：

```
Invalid JSON payload received. Unknown name "inputAudioTranscription"
at 'setup.generation_config': Cannot find field.
```

`v1alpha`／`v1beta` 的 `auth_tokens` mint 兩者皆回 200。

### 這推翻了原報告的根因排序

| 原報告根因                             | 裁決                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. 專案使用舊 v1alpha 端點             | **不成立**。v1alpha + Constrained + ephemeral + 正確欄位位置**現在就能通**。值得為未來相容而遷移，但**不是本次失敗的原因**。 |
| 2. transcription 欄位位置不符          | **唯一真因**，且為充分必要條件。                                                                                             |
| 3. token 未用 `liveConnectConstraints` | 與本失敗**無關**（未鎖 token 已成功握手）。                                                                                  |
| 4. mock 測試把錯誤 JSON 鎖成通過       | 屬實，見 §2 #4。這是讓 #2 得以存活的機制。                                                                                   |

### 這是一個未 commit 的回歸

`git diff HEAD -- apps/web/src/providers/gemini-live-provider.ts` 顯示：

- 已 commit 的 `8747078` 把兩欄放在 **setup 頂層**，註解寫「Common top-level fields (verified raw-WS placement 2026-06-09)」。
- 工作區改動把它們搬進 `generationConfig`，理由是跟隨 Google live-translate 文件的範例。

**HEAD 是好的，壞的是尚未提交的工作樹。修復＝還原兩行。**

### Google 文件自身不一致（獨立複查屬實）

- [Live API 參考](https://ai.google.dev/api/live)：`inputAudioTranscription` / `outputAudioTranscription` 列為 `BidiGenerateContentSetup` 的**頂層欄位**。
- [Live Translate 指南](https://ai.google.dev/gemini-api/docs/live-api/live-translate)：raw WS 範例把兩欄放在 `generationConfig` 內。

服務端實作與**前者**一致。文件範例是錯的。

---

## 二、逐條裁決

### 2.1 屬實（已親驗）

| #   | 主張                                    | 證據位置                                                                                                                                                                |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | transcription 欄位在 `generationConfig` | `apps/web/src/providers/gemini-live-provider.ts:414-417` ＋ §1 實測                                                                                                     |
| 2   | 使用 v1alpha 端點                       | `gemini-live-provider.ts:33-34`（屬實，但**非失敗主因**）                                                                                                               |
| 3   | 未等 `setupComplete` 就送 PCM           | `connect()` 於 `ws.onopen` 即 `resolve()`（:343-353）；`start()` 緊接 `startAudioCapture()`（:301-302）                                                                 |
| 4   | mock 測試把錯誤 JSON 鎖成通過           | `gemini-live-provider.test.ts:417-421` 明確斷言頂層為 `undefined`、`generationConfig` 內為 `{}`                                                                         |
| 5   | chunk = 32 ms                           | `gemini-live-provider.ts:28`                                                                                                                                            |
| 6   | UI「2–3 秒」宣稱無專案量測背書          | `apps/web/src/components/SettingsPanel.tsx:12`；repo 內無任何 latency JSON/JSONL 產物                                                                                   |
| 7   | latency-monitor 跨 session 汙染         | `latency-monitor.ts:74-80` — `recordHealth()` 清 `sessionStartMs`/`ttfcMs`/`pending`，**未清 `samples`**                                                                |
| 8   | persist 每次都 append                   | `latency-monitor.ts:186` `[...prior, entry]`，但 :184 註解寫「Replace…if it's THIS session」。15 s 節流 × `PERSIST_HISTORY_CAP=50` → 單場 13 分鐘會議即可把全部歷史擠掉 |
| 9   | `GEMINI_LIVE_MODEL` 無 allowlist        | `services/online/src/config.ts:41` `z.string()`                                                                                                                         |
| 10  | 音源硬編 microphone                     | gemini `:600,:802`；openai `:789,:834,:924,:1042`（`display-media-audio-provider.ts` 明明存在）                                                                         |
| 11  | Gemini-only 發行被 OPENAI_API_KEY 擋    | `scripts/release-templates/start.sh:24`、`start.bat:29` 皆 `exit 1`                                                                                                     |
| 12  | 執行中切換模式只改 UI                   | `apps/web/src/components/ModeSelector.tsx:27` 直接 `setMode()`，無 running 守衛、無 `.stop()`                                                                           |
| 13  | 字幕預設持久化                          | `store/use-caption-store.ts:4` `createCaptionStore()` → `store/caption-store.ts:564` 落到 `DEFAULT_PERSIST_KEY`                                                         |
| 14  | MT 積壓可阻塞 caption 路徑              | `services/offline/app/pipeline/asr.py:232-236` — in-flight ≥10 時於 recv_loop 內 `await asyncio.wait(FIRST_COMPLETED)`                                                  |
| 15  | Hybrid `separate_tracks` 未實作         | 僅存在於 `docs/AUDIO_SOURCES.md:14`，無對應程式碼                                                                                                                       |
| 16  | 相依套件 7 high / 1 moderate            | `pnpm audit --prod` 完全吻合（brace-expansion ReDoS ×7、@fastify/static 授權繞過 ×1）                                                                                   |
| 17  | 測試與 typecheck 綠                     | web **283/283**、online **48/48**、`pnpm -r typecheck` exit 0（較原報告的 69/69 子集更完整）                                                                            |

#### 補充：#12 的內部矛盾

online backend picker（OpenAI↔Gemini）**有**執行中鎖定，`SettingsPanel` props 註解明白寫出理由：「switching it mid-session would hide the running provider's Start/cost UI while the session (and its billing) silently continued」。同一個危害在 `ModeSelector` 完全沒擋。專案已知此風險，只擋了一半。

### 2.2 屬實但描述有偏差

| 項目                             | 修正                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #13 範圍被低估                   | 持久化是**全模式預設開啟**，不是「offline 才寫入」。直接違反 CLAUDE.md「Default retention: in-memory only」與「不得靜默持久化」。**嚴重度應上調。**                                                                           |
| #14 程度需限定                   | MT 為 fire-and-forget，且每筆有 5 s executor timeout（`translation.py:111`）。阻塞只發生在飽和邊界，最壞約 5 s，且當批 transcript 已先 `_put()` 送出。是真缺陷，但不是「積壓即癱瘓」。                                        |
| 「Offline WebSocket 綁 0.0.0.0」 | **指錯 socket**。`services/offline/run_whl.py:70` 綁的是**內部 WhisperLiveKit :9090**（無驗證，確實對 LAN 曝險）。瀏覽器面向的 FastAPI :8000 以 `uvicorn app.main:app --port 8000` 啟動，預設 127.0.0.1。結論成立，位置要改。 |

### 2.3 錯誤 —— 不可照做

#### ❗ 修復建議 #7「OpenAI renewal 改依 `expires_at`，移除固定 25 分鐘」是錯的

這是**類別錯誤**，照做會製造長會議斷字幕。

[OpenAI client_secrets 參考](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets) 明文：`expires_at` 是「the time after which a client secret will no longer be valid for **creating** sessions」，並且「**the session itself may continue after that time once started**」。`expires_after.seconds` 預設 600 s、上限 7200 s。

因此讀到 `expires_at = 3600 s` 只說明 **token 的開窗長度**，**完全不描述 session 上限**。Realtime session 實務上限在 30 分鐘量級（見 [Microsoft Q&A: GPT Realtime maximum session length 30 minutes](https://learn.microsoft.com/en-us/answers/questions/5741275/gpt-realtime-maximum-session-length-30-minutes)）。

`services/online/src/config.ts:48-50` 的既有註解（「sessions cap around 30 min，所以提早在 25 分鐘 make-before-break」）**才是正確的心智模型**。採納 #7 會讓一小時會議在第 ~30 分鐘靜默凍結。

#### ⚠ 修復建議 #4「chunk 改回官方 100 ms」是選擇性引用

- [Live Translate 指南](https://ai.google.dev/gemini-api/docs/live-api/live-translate)：建議 100 ms。
- [Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)：明寫「Send audio in chunks of **20 ms to 40 ms**」與「Send small chunks (**20 ms - 100 ms**) to minimize latency」。

Google 文件在這一點上**與 transcription 欄位一樣自相矛盾**。現行 32 ms 落在官方另一頁的建議區間內。原報告的 n=3 A/B 不足以推翻（報告自身亦承認）。**此條應降級為「待測」，不是「改回」。**

#### ⚠ 修復建議 #2「token 改用 `liveConnectConstraints`」與專案已記錄的反證衝突

`services/online/src/routes/gemini.ts:14-18` 記載：鎖 model 後 client 再送 setup 會被 **1011 Internal error** 關閉，因此**刻意**不鎖。原報告未處理這筆反證。本輪已證實未鎖 token 能正常握手 —— 安全收益存在，但**需先重測 1011 是否仍復現**才能推翻既有決策。

---

## 三、未驗證項

**所有延遲數字**（OpenAI 0.61–0.93 s vs Gemini 3.18–4.02 s）**本輪未複測**。

- 金鑰在環境中，但複測需送 7 秒音訊 × 9 輪，會實際計費，不在指令範圍內。
- 若要複測，必須**先修好 Gemini setup**，否則 Gemini 側量到的仍是失敗路徑。
- 量測前亦須先修 `latency-monitor` 的兩個缺陷（§2.1 #7、#8），否則 `lagP50/P95` 不可用於比較。

`SettingsPanel.tsx:12` 的「約落後 2–3 秒」在取得本專案實測前，應改為引述第三方／官方措辭，不可宣稱為本專案實測結果。

---

## 四、修正後的修復優先序

| 序  | 項目                                                                               | 理由                                                                                                                          |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **還原 transcription 欄位至 setup 頂層**                                           | 撤銷未 commit 的回歸，2 行，解除 Gemini P0。**必須同步修 `gemini-live-provider.test.ts:417-421`**，否則測試會反過來擋住修復。 |
| 2   | 收到 `setupComplete` 才啟動音訊 ＋ setup timeout                                   | 官方要求；目前握手生命週期不正確                                                                                              |
| 3   | 模式切換守衛：切換前停掉執行中 provider                                            | 雲端計費與收音持續中；同類風險已在 backend picker 擋過                                                                        |
| 4   | 持久化預設關閉（全模式），改明示 opt-in                                            | 違反 CLAUDE.md 最高等級的隱私條款                                                                                             |
| 5   | `start.sh`/`start.bat` 改為「OPENAI 或 GEMINI 任一存在即可啟動」                   | 阻斷 Gemini-only 發行                                                                                                         |
| 6   | 音源標記改為真實 source，不再硬編 microphone                                       | 事件契約失真                                                                                                                  |
| 7   | WHL 綁 127.0.0.1（`run_whl.py:70`）                                                | LAN 曝險                                                                                                                      |
| 8   | 加真實 cloud contract smoke test                                                   | 本輪探針可直接改造（見附錄）；mock 不能取代                                                                                   |
| 9   | `GEMINI_LIVE_MODEL` 加 allowlist；`@fastify/static` 升級消 audit                   | —                                                                                                                             |
| 10  | v1alpha → v1beta 遷移                                                              | **未來相容性，非故障修復**；可與 `liveConnectConstraints` 重測一起做                                                          |
| 11  | 重做 speech-marker → paint 延遲量測                                                | 需涵蓋雙語向、mic/system、安靜/噪音、短句/長句、p50/p95/p99                                                                   |
| 12  | latency-monitor：`recordHealth` 清 `samples`、`persistNow` 真正替換同 session 條目 | 否則第 11 項量到的數字仍不可信                                                                                                |

**與原報告的差異**：原 #1（v1alpha）從第 1 位降至第 10 位並改標為相容性工作；原 #7（expires_at）**刪除**；原 #4（100 ms）降級為待測；原 #2（token 鎖定）加上「先重測 1011」前置條件。

---

## 附錄：探針方法

零音訊握手探針，8 組正交組合。每個 ephemeral token `uses:1`，故每次連線 mint 新 token。

```js
// 對每組 (version, authPath, placement)：開 WS → 送一個 setup frame → 記錄
// 第一個 server frame 或 close code/reason。不送任何音訊。
const setupInGenConfig = {
  // 現行工作區
  setup: {
    model,
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
    generationConfig: {
      responseModalities: ['AUDIO'],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: { targetLanguageCode: 'zh-Hant', echoTargetLanguage: false },
    },
  },
};

const setupTopLevel = {
  // 已 commit 的 8747078
  setup: {
    model,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: { targetLanguageCode: 'zh-Hant', echoTargetLanguage: false },
    },
  },
};
```

端點：

- Constrained + ephemeral：`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.{v1alpha|v1beta}.GenerativeService.BidiGenerateContentConstrained?access_token=…`
- Raw key：`…GenerativeService.BidiGenerateContent?key=…`

Token mint：`POST https://generativelanguage.googleapis.com/{version}/auth_tokens?key=…`，body `{ uses:1, expireTime, newSessionExpireTime }`。

### 本輪驗證指令

```
pnpm -r typecheck                        # exit 0
pnpm --filter @meeting-audio/web   test -- --run   # 283/283
pnpm --filter @meeting-audio/online test -- --run  # 48/48
pnpm audit --prod                        # 7 high, 1 moderate
```

---

## 來源

- [Google Live API 參考（BidiGenerateContentSetup schema）](https://ai.google.dev/api/live)
- [Gemini Live Translate 指南](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
- [Gemini Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
- [OpenAI Realtime client_secrets 參考](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets)
- [GPT Realtime 30 分鐘 session 上限](https://learn.microsoft.com/en-us/answers/questions/5741275/gpt-realtime-maximum-session-length-30-minutes)
