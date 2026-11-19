# AUDIO_SOURCES.md

> Audio source selection, scenario presets, and policy.
> See [`CLAUDE.md`](../CLAUDE.md) §"Audio Source Selection Is Scenario-Based".

---

## Scenarios (UI presets)

### 目前交付能力（2026-10-15，W01.1 部分修正）

下表是產品目標，不代表每個場景已可用。目前 full 與 online-only build
都僅可選單一音源：Physical → mic；Online Meeting Caption Box → system
（線上使用 browser display capture，離線路徑使用 WASAPI）。
Hybrid Meeting 的 mic＋remote `separate_tracks` 尚未實作，兩種 build
均顯示不可用及原因；真正雙軌仍屬 W11/A5，未完成。
Hybrid Privacy 是本機 STT＋雲端翻譯的處理模式，與混合會議雙軌不同；
full build 仍保留該模式，online-only 因未包含 offline STT 而停用。

設定 store 拒絕不可用場景，保留目前音源。既有 Hybrid Meeting 偏好載入時
保留原有 mic/system，改選對應的單源場景並顯示更正提示，不自動開始收音。
雙軌與實機場域資格仍須另行驗收。

### 開會前本機試音（W01.2）

翻譯與純字幕入口共用「本機試音」。按下後才透過既有 capture lease
取得選定 mic／browser display 音源；瀏覽器分享仍在點擊當下呼叫，保留
使用者啟用。試音期間禁止其他設定、開始與恢復操作；結束試音才開始會議。
面板顯示 PCM 是否前進、音量與靜音，展開可查看實際 track 名稱、數量、
來源 sampleRate、PCM context sampleRate 及瀏覽器回報的 EC／NS／AGC；
未回報的格式不以設定值冒充。沒有 PCM 與有 PCM 但靜音分開顯示。

試音不建立辨識連線、不載入 VAD／模型、不錄音或清除既有字幕。
取消會釋放 lease、worklet、連線與回呼；尚未答覆的權限視窗無法由網頁關閉，
但晚到的音源會立即停止，不能覆蓋取消後新取得的音源。

本機 `/healthz` 只確認 broker 可連線與金鑰設定；不代表雲端辨識已驗證。
保存檢查沿用 archive 的 IndexedDB 初始化及 `/local/bootstrap` 真實資料庫讀取，
不建立假會議或取得寫入租約；「保存服務可用」不是完整寫入驗證。
翻譯尚未接完整地端逐字稿保存，面板明示此限制；純字幕實際保存以會議狀態為準。
離線／Hybrid 的 system 路徑為 WASAPI，目前明示尚不支援此預檢，
不把 browser display 的結果當作 WASAPI 資格，亦不測離線模型。

本機受控驗證：`meeting-preflight.spec.ts` 由既有 native-audio Chrome config
執行，涵蓋兩種 purpose × mic/display、拒絕權限、無 audio track、PCM 無進展、
靜音、broker／保存不可用、權限等待中取消及歷史保留。使用原生 Chrome
AudioContext／AudioWorklet／MediaStream 與振盪器替代實體收音；不是實機音源資格。

| Scenario                       | Sources                                                     | Policy                              | UI default                            |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| **Physical Meeting**           | microphone                                                  | exclusive                           | mic only                              |
| **Online Meeting Caption Box** | browser tab audio / browser system audio / Windows loopback | exclusive                           | tab audio (web) or loopback (desktop) |
| **Hybrid Meeting**             | remote meeting audio + local mic                            | separate_tracks                     | both, separate streams                |
| **Advanced Manual**            | user picks                                                  | exclusive / separate_tracks / mixed | (none)                                |

### Why scenarios

Raw multi-select with arbitrary device combinations is a foot-gun: it
encourages users to mix mic + system audio, which causes echo and
duplicated captions. Scenarios push users toward sane defaults.

---

## Source Implementations (provider names)

- `MicrophoneAudioProvider` — `getUserMedia({ audio: true })`
- `BrowserTabAudioProvider` — `getDisplayMedia({ audio: true })`
- `WindowsLoopbackAudioProvider` — Python sidecar via PyAudioWPatch
- `BackendAudioBridgeProvider` — generic WebSocket audio frame producer

---

## Policies

- **exclusive**: only one source active. Other sources are stopped on switch.
- **separate_tracks**: multiple sources active, kept as separate streams,
  transcripts merged in store by timestamp.
- **mixed**: multiple sources mixed in Web Audio. Requires explicit user
  consent and surfaces a warning about echo and timing drift.

Default for any new scenario: **exclusive**, unless the scenario definition
overrides.

---

## Failure Modes (must be visible in UI)

### Browser capture progress — W02.1

`capture-health.ts` 的監測由現有音訊消費端持有；Gemini、OpenAI WebSocket、
純字幕 VAD 前與 offline browser mic 使用實際 PCM callback 計數。
獨立 timer 在最後有效 frame 後 2 秒內產生停流事件（主執行緒可執行時）；
持續收到靜音 PCM 不算停流。mute、context suspended/closed、track ended
各有 normalized reason，主畫面與設定列顯示原因；新消費端也須收到真 frame 才清除舊故障。

OpenAI WebRTC 另用既有 worklet 的 4 Hz counter-only 模式監測本機 capture，
不複製 PCM，也不將此訊號當作 RTP 或雲端辨識進展。候選 transport 不發布健康事件；
Stop/Pause 解除監測及回呼，收音故障不觸發既有 receive-wedge 雲端重連。
前景 Chrome 合成音源停幀已驗翻譯與純字幕，另驗原生 WebRTC context 暫停／恢復。
這不是實體 USB/BT/HDMI、WASAPI、睡眠／鎖定或真人辨識資格；這些仍列 W02.2/H1。

- permission denied
- no device found
- track ended unexpectedly
- silence > N seconds (configurable)
- displayMedia stream has no audio track
- WASAPI device removed / changed

See [`FAILURE_MODES.md`](FAILURE_MODES.md) for the full state list.

### Browser device continuity — W02.2

翻譯與純字幕共用麥克風選擇器。空值明示「作業系統預設麥克風」；選定實際裝置後，
`getUserMedia` 使用 `deviceId: { exact: id }`，失敗不退回預設。裝置清單隨
`devicechange` 及授權狀態更新，沒有名稱時顯示未授權提示；`default`／
`communications` 別名不當成可識別的硬體選項。離線／混合模式的 browser mic
也沿用選定 ID；WASAPI 仍由服務端管理，未宣稱瀏覽器可選其 loopback 裝置。

既有 capture lease 的會議 retention 持有恢復意圖，不另建 capture owner。
成功取得音源時記住實際 `getSettings().deviceId`；結束後僅在原本的具體 ID
重新出現，且 microphone permission 仍為 granted 時，自動重取一次並接續同一會議。
無法識別實際裝置、權限需重新詢問或拒絕時保留人工入口，不反覆要求權限。
不同裝置不會自動替代。分享結束或遭拒時只提供「重新分享音訊」，不自動開 picker。
Stop／Pause 在等待清理之前撤銷恢復意圖；晚到 enumeration、拒絕或音源 grant
不得影響新一輪會議或復活舊收音。

capture health 的既有 timer、visibilitychange、pageshow 或真 frame callback
若觀察到超過 5 秒的 wall-clock 間隔，會發布「疑似休眠或排程中斷」估計區間。
時鐘校正也可能造成此現象，因此不宣稱實際休眠或無漏音。
同一 MediaStream 共用 capture epoch，新 grant 使用新 epoch；這是音源身份，
不是跨 consumer 的 sample clock。新缺口使用 `GapRecord` 的 wall-clock-only
`estimated` 格式，不捏造 startSample、endSample 或 sampleRate；主畫面顯示提示，
純字幕保存到既有逐字稿 archive。既有 sample-aligned gap 格式繼續相容。

H1 實體驗證仍須另做：USB 麥克風拔插、不同麥克風替代、BT／HDMI／USB 音訊切換、
實際休眠／鎖定與恢復，以及 WASAPI loopback。各次記錄所選與實際 device ID、
收音故障／恢復時間、是否出現人工 picker、Stop 後 OS 收音指示是否結束；
受控 Chrome 合成音源測試不代替這些硬體資格。

---

## Open Questions

- Should "Advanced Manual" be hidden behind a developer flag in early builds?
- What is the silence threshold default (5s? 15s?) and is it scenario-specific?
- Process-specific WASAPI capture (Win 10 2004+) vs full system loopback —
  worth the complexity?
