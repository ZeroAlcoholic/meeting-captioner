# 收音與連續性 Implementation Plan

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐項施工；分派遵守當時授權。以下保留施工細節，執行狀態與證據以主清單為準，checkbox 不代表現況功能不存在。

**Goal:** 收對音源、偵測斷流、保全短中斷音訊，並安全續期、同服務恢復及 OpenAI／Gemini 交互接管。

**最新排序：** [主工作清單：兩家交互備援，Gemini 第二金鑰後排](2026-10-15-meeting-hardening-checklist.md)。A4 包含兩家雙向交互接管，是主線必做；只有 Gemini 第二 key 延後。各廠一 key 可驗收，不依賴 N1 或離線模型。

**Architecture:** 沿用 normalized events／provider adapters／capture lease。將可跨 provider 的 capture 與有界 PCM 保全提升至會議／track 生命週期，恢復協調消費結構化故障與能力；先單軌、後雙軌。

**Tech Stack:** 現有 TypeScript、React、Web Audio、Vitest、Chrome Playwright；不先新增音訊框架。

**Spec:** [診斷與場域契約](../specs/2026-10-15-meeting-resilience-design.md)

**精簡與效能約束：** 遵守[主清單](2026-10-15-meeting-hardening-checklist.md)的「流暢與穩定」「Clean code」條件。下列新增檔名為候選落點；優先沿用既有模組／測試，沒有實際責任或生命週期邊界就不建檔，不預建通用框架。

## Global Constraints

- 字幕 render 不等待保存、重播、模型載入或診斷寫檔；所有 queue 有單位／容量／溢出策略。
- 不新增付費測試、不落盤錄音、不把翻譯 provider 當純轉寫備援、不靜默換裝置。
- Windows shell 一次只執行一個；日常服務先 status，不另起 8787/8000。整合測試使用隔離測試服務與資料目錄。
- 每項先重現失敗，再最小修改，再功能／邊界驗證、diff 審查及文件更新；既有通過測試不得降弱。
- 文件中的新 interfaces 為預定新增；既有 provider 的 API 可透過小型 adapter 對接，不一次重寫全部 provider。

## A1 — 場景能力與開會前自檢（F01/F04）

**Files:** 修改 `apps/web/src/settings/settings-store.ts`、`components/ScenarioPicker.tsx`、`components/SessionLauncher.tsx`、`components/SettingsPanel.tsx`、`components/PureCaptionWorkspace.tsx`；新增 `apps/web/src/providers/meeting-capabilities.ts`、`apps/web/src/components/MeetingPreflight.tsx` 及對應測試；更新 `docs/AUDIO_SOURCES.md`。

**Interfaces（新增）:**

```ts
type MeetingCapability = {
  purpose: 'transcription' | 'translation';
  capture: 'mic' | 'display' | 'wasapi';
  status: 'unavailable' | 'unverified' | 'ready';
  reason?: string;
  maxTracks: 1 | 2;
};
```

`ready` 只表示當前必要路徑已通過預檢，不表示真人品質保證。金鑰存在僅可標 configured；首次開會前不得偷偷付費測試。

- [ ] 在 `settings-store.test.ts` 加失敗回歸：full build hybrid 的可用性必須與 `maxTracks` 一致；選 hybrid 不能回傳只收 mic 的 ready session。online-only 的 Hybrid Privacy 與 Hybrid Meeting 分別驗證。
- [ ] 先修選項誤導，將尚無分軌標明不可用與原因；同時保留 A5 待交付，不能關選項就勾 A5。
- [ ] 預檢顯示實際裝置、分享結果是否有 audio、實際 sampleRate／DSP、每軌 PCM／音量、本機保存可用、服務 build／purpose；可取消試音且釋放全部資源。
- [ ] Chrome 測取消權限、未分享音訊、錯場景、服務不可用、已保存舊會議；都能保留歷史並有唯一下一步。
- [ ] 執行 `pnpm -F web exec vitest run src/settings/settings-store.test.ts src/providers/meeting-capabilities.test.ts`；新增 `tests/e2e/meeting-preflight.spec.ts` 並由既有 Chrome config 跑實際操作；更新 capability 表及 diff 審查。

## A2 — 收音生命週期、裝置選擇與進展監督（F04/F06/F15）

**Files:** 修改 `providers/audio-engine.ts`、`microphone-audio-provider.ts`、`display-media-audio-provider.ts`、`capture-lease.ts`、`components/HealthRow.tsx`、`SettingsPanel.tsx`；新增 `providers/capture-health.ts`、`capture-health.test.ts`，擴充 `tests/e2e/native-audio.spec.ts`。

**Interfaces（新增，給 A3/A4）:**

```ts
interface CaptureProgress {
  trackId: string;
  captureEpoch: string;
  lastFrameAtMs: number; // performance.now，僅同頁比較
  capturedSamples: number;
  sampleRate: number;
  trackState: 'live' | 'ended';
  muted: boolean;
  contextState: 'running' | 'suspended' | 'closed';
}
```

裝置持久設定保存偏好，不把 browser deviceId 當跨 profile 永久識別。devicechange 後重新枚舉；裝置 label 可用前後都要正確顯示。

- [ ] 加失敗案例：frame 停止但 track live／頁面 visible；context suspend；mute/unmute；audio ended 後遲來 connected；Stop 後 devicechange。斷流偵測不可依賴新 frame 才啟動。
- [ ] 用獨立 timer 檢查 lastFrame；active 狀態最後 frame 後 2 秒內顯示 capture-stalled。對 mute、ended、permission、sleep 分類，不由 transport 蓋掉收音錯誤。
- [ ] `statechange`、`devicechange`、mute/unmute、visibility／pageshow 加入同一可取消 owner；context resume 仍沿用既有 deadline，不增設無限 resume loop。
- [ ] 提供 mic 裝置選擇；同一裝置重取成功才續接，切換其他裝置需明確操作；分享 ended 保留會議並提供重新分享按鈕。
- [ ] 每次重新取得 capture 增加 epoch；wall-clock 長跳躍只產生估計 sleep gap，sample clock 不偽造樣本。
- [ ] Chrome 原生測 frame freeze、visible suspend、foreground/background、Stop cancellation；USB/BT/HDMI、實體 sleep/lock 列 V2 人工實機測。跑 `pnpm -F web exec vitest run src/providers/capture-health.test.ts src/providers/capture-lease.test.ts src/providers/audio-engine.test.ts`，再跑 native audio config 的受影響案例，保存時間序證據。

## A3 — 會議級音訊保全與補送資格（F02/F06）

**Files:** 新增 `providers/meeting-audio-buffer.ts`、`meeting-audio-buffer.test.ts`；修改 `transcription-audio.ts`、`capture-lease.ts`、`transcription-session.ts`、兩家 transcription providers；新增 `packages/contracts/src/audio-range.ts` 共用 SampleRange，沿用 `meeting-event.ts` 既有 GapRecord，不另建重複 gap schema；擴充 schema tests／保存相容性。VAD pre-roll 不取代此 buffer。

**Interfaces（新增）:**

```ts
interface AudioFrame {
  trackId: string;
  captureEpoch: string;
  startSample: number;
  sampleRate: 16000;
  pcm: Float32Array;
}
interface SampleRange {
  trackId: string;
  captureEpoch: string;
  from: number;
  to: number; // exclusive
}
interface BufferRead {
  frames: AudioFrame[];
  missing: SampleRange[];
}
// MeetingAudioBuffer(capacitySamples: number)
// append(frame: AudioFrame): SampleRange[]  // 返回被覆寫的區間
// read(range: SampleRange): BufferRead
// clear(): void
```

不能在幀 hot path 無界配置；實作固定容量 backing storage，read 只給有界區段。多軌由 A5 分開建立。先量現有 VAD／resampler 與 buffer 寫入成本，只有實際阻塞超標才移 worker；不得在主執行緒為每幀建立大型 JSON、序列化全文或寫診斷檔。

- [ ] 建立紅測，覆蓋跨 epoch 拒混、尾端不足、容量覆寫、精確 missing、Stop 清空及任意 frame 大小；最小例：

```ts
const ring = new MeetingAudioBuffer(8);
ring.append({
  trackId: 'mic',
  captureEpoch: 'e1',
  startSample: 0,
  sampleRate: 16000,
  pcm: new Float32Array(6),
});
expect(
  ring.append({
    trackId: 'mic',
    captureEpoch: 'e1',
    startSample: 6,
    sampleRate: 16000,
    pcm: new Float32Array(6),
  }),
).toEqual([{ trackId: 'mic', captureEpoch: 'e1', from: 0, to: 4 }]);
expect(ring.read({ trackId: 'mic', captureEpoch: 'e1', from: 0, to: 12 }).missing).toEqual([
  { trackId: 'mic', captureEpoch: 'e1', from: 0, to: 4 },
]);
```

- [ ] 將 frame 保全掛在 VAD 前；capture 與 buffer owner 不隨 provider reconnect dispose。明確訂 60 秒 Float32 3.84 MB／track，metadata 另外量測；不把 provider 內的發話佇列稱為保全。
- [ ] 依 sample range 記 captured/submitted/provider-completed，不能用 send 成功刪掉未確認資料；capacity 覆寫轉 gap event，交既有 archive 保存。
- [ ] SampleRange 的 from/to 對應既有 GapRecord.startSample/endSample；captureEpoch 維持 string，sampleRate 明示。新增欄位需讓舊 envelope／outbox 可讀，不直接以 strict schema 拒絕既有會議。
- [ ] ring 回傳的是被覆寫範圍；協調層扣除已確認保全的區間後才標 gap，正常淘汰已完成音訊不能誤報漏音。無精確上游 ACK 者記 estimated 與待核對，不捏造 sample completion。
- [ ] 建立 `tests/e2e/audio-replay-contract.spec.ts`：受控上游慢讀／丟 ACK／半段斷線／新線拒絕；計數音訊驗證無誤刪或未標示丟棄。
- [ ] 為每 provider 記 replay capability：rate/活動順序/併發/對齊來源／證據日期。真上游未知先標 unverified；授權小額 probe 之後才標可補送。沒有加速能力時選 live 優先＋待補處理，不建無限落後 queue。
- [ ] 跑 `pnpm -F web exec vitest run src/providers/meeting-audio-buffer.test.ts src/providers/transcription-audio.test.ts src/providers/transcription-audio-adapter.test.ts`；以原生 sample 計數驗證續期時擷取沒有被 dispose，提交容量／失敗政策與 snapshot diff。

## A4 — 同服務恢復、雙向跨廠接管與停字監督（F02/F03/F05/F06）

**Depends:** 基本重連／限流／停字與交互接管依 A2，音訊補送另依 A3。W03 不等 W04 重播資格；OpenAI／Gemini 各一 key，無 N1/N3/N4 前置。

**Files:** 修改 `transcription-session.ts`、`meeting-recovery.ts`、`recovery-attempt.ts`、兩家 transcription providers、`PureCaptionWorkspace.tsx`、`App.tsx`；擴充相應 tests 與 `tests/e2e/meeting-recovery.spec.ts`。先在既有 `meeting-recovery.ts`／`recovery-attempt.ts` 加必要分類／純函式及測試，避免 UI 解讀錯誤字串；不另建 recovery-policy manager 或第二套恢復狀態機。

**Interfaces（新增）:**

```ts
type RecoveryFailure = {
  layer: 'audio' | 'transport' | 'provider';
  kind: 'network' | 'auth' | 'rate-limit' | 'unsupported' | 'stalled' | 'permission' | 'ended';
  provider: 'openai' | 'gemini';
  retryNotBeforeMs?: number; // monotonic deadline，重建時不得清掉
  attemptId: string;
};
type CandidateStage = 'connecting' | 'ready' | 'adopted' | 'retired';
```

`ready` 是協定／媒體就緒；`effective content` 是另外的進展時間點，不能互換。

- [ ] 紅測：old alive＋candidate fail、candidate late ready after Stop、新舊都回 final、同句重複、auth/permanent 拒絕、Retry-After=60、OpenAI→Gemini／Gemini→OpenAI、目的端失敗、兩家皆失敗、原廠比候選先恢復、Gemini 第二 key 未配置。
- [ ] 先確認同 provider／同帳號允許候選併發；不允許時走有界重連並標示缺口，不偷偷換 key/provider。允許時保留健康主線直到候選 ready；單一 adoption point 轉所有權；原線停止送音並有界 drain，drain 的事件不能覆蓋新 live。重連保留 meetingId，segment identity 歸 sample/utterance owner，不由文字去重。
- [ ] A3 合格 replay 僅補缺區；不合格時維持 live 並顯示待核對／待補處理。Stop 不送新 backlog，已送尾文以原有 5 秒 drain 上限處理；清除 RAM 音訊前將未補區間轉 unrecoverable，不能顯示仍可會後補回。
- [ ] 將兩家 mint 的 status/Retry-After 帶成 RecoveryFailure；暫時網路退避與限流冷卻分開，永久拒絕不無限燒重試；保留手動重試。純字幕整體網路嘗試期限不能被 mint／socket 各自重設。
- [ ] 建立目的感知候選 factory：transcription→transcription、translation→translation；兩家實際 capability／允許清單決定候選。單廠自救與雙向接管都要完整，移除假的 backend availability bookkeeping；不以 Gemini 第二 key 作可接管前置。
- [ ] 有音／speech-active 但無有效內容或 pending commit 長時間未完成時報 stale，先診斷 audio/transport/provider；閾值以固定語料量測後登錄，必測 60 秒安靜無重連、30 秒連續發言有持續輸出、generation 卡住不靠 queue 滿才知。
- [ ] 跑 `pnpm -F web exec vitest run src/providers/transcription-session.test.ts src/providers/meeting-recovery.test.ts src/providers/recovery-attempt.test.ts src/providers/openai-transcription-provider.test.ts src/providers/gemini-transcription-provider.test.ts`；Chrome 重跑純字幕／翻譯故障矩陣與原生續期，分別記故障發現、ready、首有效字與 gap，不用假時鐘當長測。

## A5 — 真混合會議 separate_tracks（F01/F15）

**Depends:** A1–A4 的主線部分、D1；語者識別不在此任務。兩軌先驗所選服務併發能力；每軌可依 A4 交互接管且來源身分不變，無雙軌 session 資格則單軌獨立放行。

**Files:** 修改 `capture-lease.ts`（只支援 mic／remote 兩軌 owner，不建通用 registry）、`settings-store.ts`、`App.tsx`、`PureCaptionWorkspace.tsx`、`packages/contracts/src/transcript-event.ts`、`meeting-event.ts`、caption store／export；優先在 `capture-lease.ts`／既有 session owner 擴充；僅當雙軌生命週期確有獨立責任才抽 `providers/meeting-tracks.ts`，沿用 fixture 並新增 `tests/e2e/separate-tracks.spec.ts`。

**Interfaces:** 使用 A3 `trackId/captureEpoch`；來源標籤 mic/remote 不是人名。最多兩軌，各有 A2 progress、A3 buffer、A4 transport owner；共享 meetingId、寫入租約，segmentId 全域唯一。

- [ ] 紅測：兩軌 sample clock 起點不同仍正確保存；mic ended 不停 remote；remote picker cancel 不假裝雙軌 ready；Pause/Stop 全部釋放；舊格式匯出仍可讀。
- [ ] 雙軌各沿用一個 `createStoreBoundHandlers` 實例；每個實例保持單軌最新 partial，final 直接投遞同一 archive。不要把兩軌塞入同一 slot，也不另建合併器或佇列管理器。共用 caption store 須保留最多兩軌的 live 狀態，final 僅清除所屬片段；不建立第二份 store。
- [ ] 實作兩個獨立來源的啟停、source label、故障與字幕呈現。各軌內排序精確、跨軌時間估計明示；不把兩軌 PCM 混在一起、不以文字相同移除疑似回聲。
- [ ] 開始前顯示兩路雲端計費與實際路由；耳機／會議硬體／喇叭回聲風險可理解，DSP preset 由 V1 實測選定。
- [ ] Chrome 兩路 deterministic `LOCAL-n`／`REMOTE-n` 驗證 capture→event→archive→export；再實機 mic＋Teams/Zoom／分頁同時講話與單來源故障，記重複遠端語音、漏句與人工操作數。
- [ ] 跑 `pnpm -F web exec vitest run src/providers/coalesce-handlers.test.ts src/providers/capture-lease.test.ts src/store/caption-store.test.ts`、contracts tests、Chrome separate-tracks 與保存整合；只有 V1/V2 雙來源通過後，A1 capability 才允許正式 hybrid。

2026-10-16 W11.1 邊界核對：現有 OpenAI/Gemini hooks 已各自建立 handler；新增交錯兩軌測試確認各軌只排一個 callback、各保留最新 partial、全部事件與兩個 final 進同一 archive。原 coalescer 12 項通過（`.cache/w11-coalescer-boundary.log`）。這只證明 batching 可沿用，**不代表雙軌畫面或收音已完成**；共用 store 仍只有一個 livePartial，capture-lease 仍為單一 live/acquiring owner。後續最小順序為既有 capture owner 支援 mic/remote 兩槽 → 同一 store/UI 的兩軌 live 與 final 清除 → 既有 session 啟停/單軌故障/保存整合。保留原場域與併發驗收，不先啟用 hybrid 能力旗標。

## 收工條件

- [ ] A1–A5 各有直接功能證據；A3 上游資格不支持的 provider 明列限制，依賴它的無缺口宣稱不放行。
- [ ] 更新 `AUDIO_SOURCES.md`、`FAILURE_MODES.md`、`ARCHITECTURE.md`、`PROJECT_STATE.md` 與總藍圖狀態；附原生測試 build/hash、音源、採樣率與未驗項。
- [ ] fresh diff review 無越界清理；保留既有未提交內容。是否建立 commit 依當時授權與工作樹隔離策略，不 `git add .`。
