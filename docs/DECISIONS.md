# DECISIONS.md

## 2026-11-03 — 地端前端按能力入口隔離，不重寫共用平台

地端 adapter／hook 與 Hybrid 編排分別放入 `providers/offline/`／`providers/hybrid/`；App 經明確能力 alias 取得，TypeScript 與 Vite 的 full／online 解析一致。online target 不編譯地端實作／測試，build 拒絕跨目錄直接引用；managed 與 ZIP 走同一隔離。完整版本保留原有實作與檢查，雲端版明確 unavailable，不假裝 Start 成功。

舊地端會議在雲端版只保留檢視／匯出，續用明確拒絕，不自動改成雲端送音。共用 capture／PCM／VAD、contracts、呈現與本機保存維持共用，不將地端重構擴成雲端 provider／資料庫搬移。故障注入式架構檢查接進一般測試，不加進服務啟動；未變更的驗證沿用。依據與後續地端 L1–L4 順序見[檢閱報告](evals/2026-11-03-module-boundary-review.md)。

## 2026-10-16 — 雙軌共用資料契約，分開擷取與連線所有權

mic／remote 各使用既有 capture lease owner、session／provider hooks 與 coalescer，僅一份 caption store 與 meeting archive；每軌最多保留一份即時 partial／translation，final 依原 archive 保存。來源不當作語者。遠端接管不改主軌設定，Stop 撤銷兩軌並等候尾文；captureGap 沿用原區間與 capture epoch，不以恢復當下另造缺口。

本機寫入權限遭拒絕時阻擋雲端自動重試，沿既有租約重試及同會議續接，不縮短租約、不共用跨分頁 owner。W11.1 的 LOCAL 工程驗證與 W11.2 的真帳號／硬體資格分開；公開混合會議入口維持停用，Gemini 第二金鑰不作前置。

## 2026-10-15 — 固定原網址，優先使用既有 outbox 救援

Managed service 在既有 runtime.json 保存 originPort；IPC 仍是唯一活動程序所有權依據，
檔案中的 PID 不具權威。舊版合法網址可遷入，後續不得因占埠或明確不同 --port 靜默換址；
失敗保留原埠與資料，外部程序不被探查或終止。恢復原服務後沿用 CLI 的 IPC／HTTP
workspace、instance、build 核對，再以原 Chrome profile 的既有 outbox 重送，ACK 後才結案。
Chrome 已驗跨埠看不到同名 IDB、原網址恢復後重送去重及待存歸零，因此不另建搬移資料庫、
匯入／匯出協定或通用遷移工具。未知更早網址、localhost 別名與其他 profile 不宣稱可自動救援。

## 2026-10-15 — 翻譯沿用 archive，保存與畫面各自固定會議歸屬

App 為線上翻譯取得既有 archive 的 admitted writer，同場重連／接管沿用；provider 事件在 coalesce 前保存。writer 固定 meetingId，partial key 含會議 ID，避免換場尾文污染新場；coalescer 對舊場事件仍保存，但不更新新場畫面。保存啟動期間沿用 MeetingRecovery 的阻擋條件，避免尚未開 provider 就被恢復排程再開另一家；不新增重試 timer／資料庫／outbox。Stop 取消既有 recovery generation，checkpoint 不等待磁碟；結案與歷史遷移仍依 W05 後續驗收，不以畫面暫存當完整 archive。

## 2026-10-15 — 翻譯恢復以有效內容判定，持續停字沿既有排程跨廠

兩家翻譯 provider 的握手與控制訊息只能證明連線存在，不能證明字幕恢復。
恢復中的 hook 因此等待當前 provider 的非空原文或譯文；正常初次啟動仍保留
既有連線語意。原文也算有效內容，避免說話者已使用目標語言時無譯文造成誤判。
純空白 delta 不重設既有 watchdog；原始文字不裁切。

watchdog 沿用持續音訊證據及 30 秒窗口，首次停字先走同廠恢復。相同 owner
再次明確回報 provider 層 stalled 時，下一次握手完成仍發布 failed，交給既有
MeetingRecovery 選擇可用備援。重連進行中仍為 reconnecting，不另建計時器或
打斷該次嘗試；有效內容清除最多累計兩次的狀態，相同 attemptId 不重複計數。
Stop、來源阻擋、永久拒絕與 Retry-After 仍由原所有權與恢復契約負責。

這是有界的同廠恢復機會，不是零漏字或真雲端延遲保證；真服務與場域資格仍由
W12/H2 驗證。W03.4 的本機證據與未驗項維護於主清單及 PROJECT_STATE。

## 2026-10-06 — Windows 日常服務採 workspace owner 與單一同來源入口

由於 agent 啟動容易重複占用 5173／8787／8000，日常線上使用改走
`pnpm service:start/status/stop`。以 canonical workspace path 衍生 Windows named
pipe，先取得 OS 所有權才建置／啟動；不使用 PID 檔或「查埠後再啟動」作鎖。
候選埠 43871 若不能綁定則向 OS 申請 port 0，回報真正網址，不終止異物程序。

正式網頁與 API 共用一個 Node／HTTP origin，managed 模式不授權 CORS；
每次啟動使用獨立 build snapshot，避免其他建置覆寫活躍資產。Stop 使用 pipe
及隨機 instanceId，HTTP 不提供停止入口。重複 start 不自動換版，以免中斷會議。

限 Windows named pipe；保留 HMR／完整離線／舊發行版原入口，不假冒通用 OS
service manager。線上版不可探測常用離線埠，Hybrid hook 已依 deployment mode
停用該探測。此決策不改 provider、模型、雲端驗收與離線功能完成標準。

> Architectural decisions, with the _why_. Decisions are append-only;
> if a decision is reversed, add a new entry that supersedes the old one
> rather than editing history.

Format: lightweight ADR (Architecture Decision Record).

---

## D1 — Use pnpm workspaces for the JS/TS monorepo

**Date:** P0
**Status:** Accepted
**Context:** We have at least three JS packages (web, online service, shared
contracts). Need to share TS types across them without publishing to npm.
**Decision:** Use **pnpm workspaces**.
**Why:** Faster installs, strict node_modules layout (no phantom deps),
disk savings via content-addressable store. CLAUDE.md / REFERENCE.md do
not constrain workspace tool choice.
**Consequences:** Devs need `pnpm` installed (bootstrap script handles it).

---

## D2 — Styling via plain CSS / CSS Modules only

**Date:** P0
**Status:** Accepted
**Context:** Renderer must be lightweight and not depend on heavy UI
frameworks (per `CLAUDE.md` §"Preferred Stable Stack").
**Decision:** Plain CSS or CSS Modules. No Tailwind, no styled-components,
no MUI/Chakra/Mantine.
**Why:** Direct control over typography (caption board needs large,
projector-readable text), no runtime style cost.

---

## D3 — Validate event payloads with zod

**Date:** P0
**Status:** Accepted
**Context:** Provider Abstraction (CLAUDE.md) requires UI to consume
_normalized_ events. We need both compile-time TS types and runtime
validation at provider boundaries.
**Decision:** Use **zod** in `packages/contracts` to define schemas, then
infer TS types from the schemas.
**Why:** Single source of truth for shape + validation; fake replay can
also validate its own JSON input against the same schemas.

---

## D4 — Caption state in a vanilla store, not React top-level state

**Date:** P0
**Status:** Accepted
**Context:** Partial transcript deltas can fire 10+/sec. Putting them in
React top-level state would re-render the whole tree.
**Decision:** Use **Zustand vanilla store**. React subscribes to selectors;
provider modules write to the store directly.
**Why:** Decouples high-frequency writes from React render lifecycle. See
REFERENCE.md §1.2 method note.

---

## D5 — Fake transcript format

**Date:** P0
**Status:** Accepted
**Context:** Need a reproducible source of caption-path test data.
**Decision:** JSON array of `{ tMs, kind: 'transcript' | 'translation',
segmentId, status: 'partial' | 'revised' | 'final', text, ... }`.
**Why:** Hand-writable, diffable in PRs, can be regenerated from real
sessions later.

---

## D6 — Python environment via uv

**Date:** P0
**Status:** Accepted
**Context:** Offline service and future ML stack need a reproducible Python
env. CLAUDE.md / REFERENCE.md do not pin a tool.
**Decision:** Use **uv** with `pyproject.toml`. Ship `requirements.txt`
later if needed for fallback installers.
**Why:** Order-of-magnitude faster than pip, deterministic resolver,
manages Python interpreter version itself.

---

## D7 — Lint/format toolchain

**Date:** P0
**Status:** Accepted
**Decision:** TS — ESLint + Prettier. Python — Ruff (lint + format).
**Why:** Industry default; both ship pre-tuned configs.

---

## D8 — Conventional Commits for git history

**Date:** P0
**Status:** Accepted
**Decision:** Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`, `test:`).
**Why:** Easy to scan, can drive auto-changelog later, well known.

---

## D9 — No Docker for dev/runtime

**Date:** P0
**Status:** Accepted
**Context:** Considered Docker Compose for "easy install on any machine".
**Decision:** Bootstrap scripts (`scripts/setup.*`) instead. No Docker.
**Why:** WASAPI loopback (P3) is essentially impossible inside Windows
containers; Docker Desktop also adds >2 GB and slows dev iteration. The
bootstrap script gets us to "5–10 min on a fresh machine" without it.

---

## D10 — Remote git hosting deferred

**Date:** P0
**Status:** Superseded (2026-08-28) — see "Superseded" below
**Context:** User considered whether to push to GitHub for cross-machine
sync and cloud backup.
**Decision:** **Stay fully local for now.** Re-evaluate when the user
wants to share the repo or sync across machines. Options at that point:
GitHub (private), GitLab, Gitea, self-hosted, or no remote.
**Why:** P0 is a single-machine bootstrap exercise; remote hosting adds
no value yet and forces an unnecessary platform/account decision now.
**How to apply later:** when the user is ready, set up `git remote add
origin <url>` and `git push -u origin main`. No code changes required.

**Superseded (2026-08-28):** the deferral no longer describes reality. The repo
has an `origin` on GitHub (private) and phase-1 closure was merged to `main`
through PR #1, so the platform decision this entry was postponing has already
been made. Recorded here rather than deleted: the entry explains why the project
spent P0–P1 with no remote, which is context the git history alone does not
carry. Nothing here blocks CI or any other remote-side tooling.

---

## D11 — Phase 1 privacy and caption-path defaults

**Date:** 2026-07-30
**Status:** Accepted
**Context:** Session switching, transcript persistence, slow offline MT, and
wildcard service binds could preserve audio/data longer than intended or block
caption reception.
**Decision:** Transcript retention is explicit opt-in and defaults off; active
session configuration is immutable until Stop; offline MT uses one bounded FIFO
queue with drop-oldest rather than waiting in the transcript receive loop; local
production launchers bind WHL/FastAPI to `127.0.0.1` and do not use reload.
**Why:** These defaults mechanically preserve privacy, resource ownership, and
the non-blocking caption-path invariant. Any future relaxation requires an
explicit product decision plus tests; it must not appear as a silent fallback.

---

## D12 — OpenAI key preference and call-stage failover

**Date:** 2026-08-20
**Status:** Accepted
**Context:** `OPENAI_API_KEY` (corporate `sk-svcacct-`, org
`<corporate-org>`) mints ephemeral tokens successfully, serves
normal inference, and even opens a realtime session over the **WebSocket**
transport from this network — but `POST /v1/realtime/**/calls` rejects its
ephemeral tokens with `401 ip_not_authorized` (deterministic, 5/5). The same
SDP with `OPENAI_API_KEY_AUDIO` (`sk-proj-`, a **personal** org) returns 201.
Evidence says this is an upstream enforcement defect on the WebRTC calls
endpoint rather than a missing allowlist entry — see `FAILURE_MODES.md`. Either
way the server cannot observe it: from its side the mint succeeded.
**Decision:** The primary key is **always tried first**. When the browser's SDP
exchange is rejected with 401/403 it reports the minting slot back to
`POST /session` as `rejectedSlot`; the server demotes that slot for
`DEMOTION_TTL_MS` (30 min) and mints from the alternate, and the browser retries
the exchange once on the same half-built peer. Slot NAMES only ever cross the
wire — never key material.
**Why:** Preference order preserves the intended key (billing, org policy) for
every network where it works, while the time-box means a network change
recovers it without a restart or manual edit. Retrying on the existing peer
keeps the added latency to one mint + one POST (measured 2.1 s worst case) and
keeps the make-before-break renewal path gap-free.
**Alternatives rejected:** permanently sticky switching (silently strands the
laptop on the fallback key after one bad network); swapping the env vars by
hand (invisible to anyone else, and wrong on the networks where the corporate
key works); probing the call endpoint at startup (costs a session mint on every
launch and still cannot predict a mid-meeting policy change).

**Governance note (open):** the alternate key belongs to a personal OpenAI
account (org `<personal-org>`), so while the failover is active, corporate meeting
audio and transcripts are processed under a personal account — outside company
billing, retention and data-processing terms. This is acceptable as a
short-lived workaround for an upstream defect, NOT as a steady state. Closing
it means restoring the corporate key on the WebRTC path, or adding the
WebSocket transport that the corporate key is measured to accept.

---

## D13 — Two transports for the OpenAI realtime session

**Date:** 2026-08-20
**Status:** Accepted
**Context:** OpenAI serves the same realtime translation session over WebRTC
(`POST /v1/realtime/**/calls`) and WebSocket
(`wss://api.openai.com/v1/realtime/translations`). The corporate key is
currently refused on the first and accepted on the second (D12). The event
contract is IDENTICAL on both — `session.created`,
`session.input_transcript.delta`, `session.output_transcript.delta`,
`session.closed`, `error` — verified by running a full translation session over
each.
**Decision:** Keep WebRTC as the default transport and add a WebSocket
transport (`apps/web/src/providers/openai-ws-transport.ts`) that the provider
falls back to **before** it falls back to another key. The refusal is cached per
key slot for 30 minutes so repeat starts skip the doomed attempt. Audio for the
WebSocket path reuses the shared AudioWorklet already feeding Gemini and the
offline engine, resampled in the transport to the 24 kHz PCM16 mono the append
event specifies.
**Why:** WebRTC still owns jitter buffering, loss concealment and congestion
control, which a TCP WebSocket cannot match on a lossy link, so it stays first.
But when the choice is "WebSocket in the corporate org" versus "WebRTC in a
personal account", the organisation matters more than the transport: the
alternate key moves meeting audio outside company billing, retention and
data-processing terms. Transport-before-key encodes that priority.
**On the sample rate:** a 16 kHz feed was observed transcribing correctly, but
the append event is documented as 24 kHz PCM16 mono with the rate NOT
configurable (`session.audio.input.format` is rejected as an unknown parameter
on a translation session) and unsupported formats are documented to return a
validation error. Building on undocumented tolerance would also have left a
real hole: when a browser refuses an explicit rate the shared engine falls back
to the hardware default, usually 48 kHz, which a 24 kHz decoder would render as
double-speed garbage. The transport therefore converts from whatever rate the
context reports, carrying interpolation state across chunks so the 32 ms seams
do not click.
**Trade-offs accepted:** on the WebSocket path the browser paces and sends the
PCM itself, so a congested uplink shows up as head-of-line delay rather than
graceful loss concealment; the existing backpressure guard drops frames and
forces a rebuild instead of growing the send buffer without bound. OpenAI also
keeps sending spoken-translation audio deltas that we discard — no documented
way to disable them for a translation session was found (four candidate
`session.update` shapes rejected), which is the same waste the WebRTC path
already pays.
**Alternatives rejected:** a second provider class (would fork the
segmentation, health and renewal logic that both transports share); making
WebSocket the default (gives up WebRTC's media handling on every network,
including the ones where it works); waiting for the upstream fix (leaves the
product broken for an unknown period).

---

## D14 — Separate provider recovery from meeting recovery intent

**Date:** 2026-10-02
**Status:** Implemented; local integration verified. Real-service validation remains pending.
**Context:** A two-second Gemini failure signal caused App to cancel an ongoing
handshake. OpenAI candidate failure could stop a healthy primary. Failed starts
also lost the meeting's retry intent and system-audio ownership.
**Decision:** Keep provider-owned attempts and bounded request deadlines. Report
`reconnecting` during an attempt and `failed` after an unsuccessful attempt;
healthy primary/candidate failure does not become primary failure. App escalates
after a 20-second budget from the first reconnecting/failed outage state, only while the current
attempt is no longer in flight. Connected resets the budget. Both failed starts
retain the same meeting and retry with capped delay. Meeting intent retains a
live capture across these retries; explicit Stop/Pause or ended audio releases it.
**Why:** Counting the budget only after a failed handshake would add another
20 seconds after a potentially 25-second mint/setup attempt. Count the outage
once, while still allowing the active bounded attempt to finish. Repair demonstrated coordination defects without replacing the existing
translation providers or adding a second competing reconnect controller.
**Limits:** Transport readiness is not proof of a new translation. Audio gaps,
server translation quality and real-service long-meeting reliability require
separate evidence. Unsent audio replay and durable local LOG/TEXT storage remain
later tasks per the user's latest priority. No new paid API test is authorized.
**Policy precedence:** The user's explicit automatic local LOG/TEXT requirement
supersedes the earlier default opt-in retention proposal, but the implementation
has not yet delivered that policy; do not describe current snapshots as durable
meeting archives. See the [active task plan](superpowers/plans/2026-10-02-meeting-continuity.md).

---

## D15 — Give network attempts and meeting scheduling separate owners

**Date:** 2026-10-02
**Status:** Implemented; current local unit and Chrome integration regression passed. Real-service acceptance remains pending.
**Context:** Per-stage timeouts allowed a recovery to exceed the blueprint's
12-second attempt budget. Mutable lifecycle signals and observer callbacks could
let stopped work affect a restarted provider. App held several separate clocks.
**Decision:** A shared recovery attempt owns an immutable generation, AbortSignal
and one 12-second deadline. Audio permission waits precede the network attempt;
idle token prewarming still hides mint latency when available. Provider-specific
protocol handling stays in each provider. A small MeetingRecovery object owns
meeting retry timing; App owns capture retention and executing its decisions.
Resource cleanup finishes before terminal observers are notified, and callbacks
cannot continue scheduling work for a retired generation.
**Recovery policy:** Gemini broker/client preserve Retry-After, including CORS
exposure. After two consecutive pre-setup socket closes on resumed attempts,
discard that handle and try a fresh session without clearing meeting history.
This is a bounded fallback, not an invented provider error classification; one
close code, resumable:false or token failure does not prove an invalid handle.
Successful setup resets the count. Fresh-session recovery may lose model context.
**Limits:** A 12-second network deadline does not guarantee translated content
within 12 seconds. Durable archives, PCM replay and real-service acceptance remain
L1/L2/V1. No additional recovery framework, provider abstraction or local storage
implementation is required for this online lifecycle repair.

---

## D16 — Verify native audio independently of transport mocks

**Date:** 2026-10-02
**Status:** Native controlled verification passed; user deployment and cloud acceptance pending.
**Context:** Transport mocks replaced AudioContext/AudioWorklet and concealed
permanently cached loader failure, ignored resume failure and mislabeled PCM.
**Decision:** Keep the shared context, share native operations per context, and
bound each caller's wait without claiming to abort browser APIs that offer no
abort mechanism. Retry an actual worklet rejection once using a new local query
URL because Chrome caches a failed module by URL. Propagate initialization
failure through the actual capture/provider callers; Stop cancels their waits.
Gemini advertises the actual context sample rate. Validate the packaged build
with native Chrome audio, synthetic input and local HTTP fault injection.
**Limits:** Synthetic input plus intercepted provider responses proves this
capture/transport path, not cloud translation accuracy or long-meeting uptime.
The repaired ZIP is separate from the user's unidentified running installation.

### D17 — WebRTC 候選需 session.created，不能只等 pc connected（2026-10-02）

原生 Chrome 證實 connected 早於 DataChannel open，且只補 open 門檻仍會將健康舊線退休給立即關閉的候選。依官方 openai-node 翻譯事件契約，採 pc connected＋DC open＋session.created；候選不送音也能取得此第一個 server event，避免等待首譯文的循環依賴。期限與 Stop 取消沿用原 attempt；候選失敗保留主線，active DC close/error 立即自救。

來源：https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts （RealtimeTranslationSessionCreatedEvent）。mock 補真實協定存在的 ACK；原生 loopback 驗證 RTP 與 decoded PCM。這仍不代表雲端服務相容性或外網 NAT 已驗收。

## D18 — 雙雲端純轉寫與可追溯逐字稿（2026-10-08）

依使用者授權新增獨立 transcription 工作目的，保留既有 translation 路徑。OpenAI 使用 gpt-live-transcribe；Gemini 使用 gemini-3.5-transcribe-live。兩者都採本機 Silero VAD、原生 PCM capture 與各自專用協定，經 normalized transcript events 進入字幕與留存。中文保守轉繁中並保留 rawText、英文與術語；不捏造語者、精準字級時間或置信度。

OpenAI 主用 OPENAI_API_KEY、備用 OPENAI_API_KEY_AUDIO 目前都連官方端點。明確認證拒絕及瀏覽器初連線不明斷線可做有界的另一組 key 嘗試；不明斷線不能推論為 IP 拒絕，429 不切 key。長效 key 僅在伺服器。內外網實際切換與兩家真實 ASR 品質仍須實測，不把協定測試視為雲端驗收。

使用者明確要求逐字稿留存，因此採 IndexedDB durable outbox → loopback 授權 API／單一 writer lease → SQLite worker 交易 ACK。字幕 rendering 不等待存檔。原稿、校訂、事件、缺口分別保存；saved 僅代表持久化確認，不能代表內容完整。匯出等待已提交的校訂作業。原始音訊尚未錄存，辨識缺口不能事後憑文字還原。

語者辨識、帶證據的重點摘要、決策／待辦／議題脈絡屬後續藍圖；先通過混語錄音人工金標與長時間留存驗收，不以摘要填補遺漏字幕。

## D19 — 真實 Gemini 契約與手動斷句順序（2026-10-08）

真雲端測試發現指南 REST 範例混入 SDK 欄位：AuthToken 必須使用 `bidiGenerateContentSetup`，不能直接送 `liveConnectConstraints`。前端接受固定模型的 bare 與 `models/` 名稱。兩者都有失敗重現及修正後真握手證據。

同一合成 WAV 兩輪發生新 activityStart 早於前一段 generationComplete，雲端漏掉整段金額句。採有界暫存與依 generationComplete 依序送段，持續收音、不阻塞字幕 rendering；256 訊息上限與停止期限仍會明確回報缺口。相同音訊真雲端重測，完整 6 段與保存／匯出通過。詳細失敗與成功證據見 [報告](evals/2026-10-08-real-cloud.md)。此結果不替代真人品質或長會議驗收。

## D20 — Gemini final 片段不代表 generation 完成（2026-10-08 Review）

同一 manual activity 允許多個 final。僅 generationComplete 才能退休該 activity，釋放下一段送音與 Stop 等待；不能以收到 final 或短暫無新文字替代協定完成。收音尾幀不自行建立空文字片段；推估時間使用同活動擷取範圍，無新增音訊的多 final 可重疊，不產生零長度或借用下一段時間。缺 final／缺完成訊號仍留下缺口。見 [重現、驗證與限制](evals/2026-10-08-review-followup.md)。

### 2026-10-16 — 還原晚到內容沿既有舊世代保留區保存

明確勾選後，已套用還原的舊待存事件與會議資訊在同一 IDB 交易移入既有 identity 的 retired:世代 前綴，沿用 loss 保留模式，不增加資料庫/依賴/管理器。新世代不自動接收舊事件，舊 store 寫入仍被世代檢查拒絕。重新載入後可下載 JSONL 原始紀錄，下載不刪除本機副本；此檔供資料取回/人工核對，不宣稱可自動重播或重建完整原會議。完整原資料仍以還原前安全備份為準。真 Chrome 同交易失敗回滾、兩目的晚到事件取回與新 SQLite 隔離通過，見 W07 證據。

### 2026-10-16 — managed archive 重啟身分核對

沿用 bootstrap/授權請求及 contracts：managed child 提供 workspaceId/buildId，頁面保存先前身分，重取權限時拒絕工作區/建置改變或身分消失；後端在授權後、handler 前核對寫入標頭。身分不相符不刪除 outbox、不停止仍可運作的字幕連線；回到原身分才可明確重試。正常同 build 重啟仍沿既有 401→bootstrap→lease→去重補存路徑。非 managed 入口維持相容，不假裝具有可核對的 managed 身分。前端單元/後端路由與正式 Chrome 四條主路徑重啟、三種錯誤身分阻擋及明確重試共 7 案已驗；真服務與場域資格仍待驗。

## D21 — 手機網頁版：靜態站＋金鑰存使用者裝置（2026-11-10，使用者核准）

目標是「打開網址就能用」。比較三種做法後由使用者選定：GitHub Pages 靜態站，金鑰由使用者在手機上輸入並只存該瀏覽器（同 eng-coach）；未採用「雲端 Worker 保管金鑰＋通行碼」（要多維護一個後端，通行碼外流等同額度外流）與「筆電當主機＋通道」（筆電須開機，設定最繁）。

這是對「金鑰只能在伺服器端」的**限定例外**，只適用手機版建置：金鑰不進 repo、不進 bundle、不寫入日誌，只送往對應供應商的取憑證端點（Gemini 以標頭而非網址參數傳送），畫面只顯示末四碼，可個別測試／移除或一鍵清除。桌面與 managed 版維持原規則，裝置金鑰程式碼只從手機入口載入，不進其他建置。使用者自負金鑰用量，介面提示設定用量上限。

依使用者同日指示，手機版以輕量與逐字易讀為主：不重建本機保存機制，字幕僅留記憶體，深色底固定。瀏覽器內 broker 回應與伺服器路由同形，provider 不需知道憑證來源。
