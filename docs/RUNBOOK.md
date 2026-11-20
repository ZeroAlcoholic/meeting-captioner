# RUNBOOK.md

## 純字幕同廠續期資格（W03.2 施工中）

預設仍採串行續期並標記待確認缺口。只有部署者完成該帳號／模型／金鑰的同時連線資格驗證後，才可在服務程序環境設定對應項目為 `true`：

- `OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED`
- `GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED`

兩項只接受 `true`／`false`，未設定為 `false`，錯字會拒絕啟動。設定是部署者的資格宣告，不是服務自行探測成功的證據；兩家可獨立開啟，Gemini 不需要第二把金鑰。更換帳號、模型或可用金鑰後須重新確認；OpenAI 有 alternate key 時，資格須涵蓋可能採用的 key。

資格隨該次 mint 回應交給 adapter，session 依目前主線取得的資格決定續期方式；不是即時撤銷控制。變更設定須依現有服務所有權流程重啟，正在進行的會議先完成停止／保存，不直接殺程序。未取得資格不開旗標，也不以本機受控測試取代 W12.2 真服務驗證。

即使啟用候選續期，切換送音仍標記音訊完整性待確認；W04 補送／區間對齊未完成前不得宣稱零漏音。候選的本機 VAD 成本及完整場域驗收仍依主清單追蹤。

## 純字幕與地端逐字稿（2026-10-08，真雲端品質待驗收）

日常仍只用 `pnpm service:status`／`pnpm service:start`／`pnpm service:stop`；網址取 status，
不要另開固定 8787／8000。此版本的 SQLite worker 與 Web VAD 資產都隨同一份 managed build 發布。
本輪驗證 runtime 為 Node 24.14.0；原生 `node:sqlite` 為必要條件，不支援的 runtime 會顯示保存不可用，不能當成已保存。

1. 在「工作目的」選「純字幕（繁中＋原文）」，選 OpenAI 或 Gemini、音源與收音環境。
2. 開始後中文轉為繁體字形，英文／術語保留；兩家皆為專用轉寫模型，沒有翻譯音訊輸出。
3. 以「停止並保存」等待尾段與持久確認。已保存但有缺口／未完成片段仍需人工核對；ASR final 不等於人工確認正確。
4. 完整會議紀錄從 SQLite 讀取，畫面最近 200 段不限制完整匯出。校訂會新增修訂，原始辨識不覆寫。
5. 意外關閉後由會議清單「繼續此會議」。前一分頁的 writer lease 最長 15 秒過期；若唯讀，先關閉其他寫入分頁，再按「重新檢查寫入權限」。不會自動搶正在使用的分頁。

OpenAI 沿用伺服器環境變數 `OPENAI_API_KEY`（主槽，通常是內網受限 key）及
`OPENAI_API_KEY_AUDIO`（備援槽，可供外網使用）。兩者目前都呼叫官方 OpenAI endpoint。
Mint 的 401/403 與明確 auth/IP rejection 可切到備援；pre-ready 1006 只做一次探測，
不能據此斷言是權限問題。429 不用換 key 規避。若「內網」另有代理位址，需先確認位址與認證規格；不能直接把備援金鑰送給未知代理。
Gemini 使用 server-only `GEMINI_API_KEY`。瀏覽器只取得短效憑證；不要在瀏覽器貼長效 key。

資料預設 `%LOCALAPPDATA%\MeetingAudio`；非 Windows 為 `~/.local/share/MeetingAudio`。
測試可用 `MEETING_DATA_DIR` 隔離，路徑在每個服務建立時固定，更新工作目錄／build 不搬動資料。
API 診斷的 POST 必須使用 JSON，例如 `Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -Uri "$url/local/bootstrap"`；不要輸出或轉貼回應中的本機 token。不支援的表單格式回傳 415，不能當成 SQLite 故障。
一般 online `build/start` 已改用既有 bundle 及伴隨 worker；日常仍優先使用 managed 入口，不同時重複啟動兩者。
主檔 `meetings.sqlite`；逐字稿衍生匯出每 30 秒及結案更新。單一檔案原子替換，SQLite 才是權威來源。
`/meetings/backup` 需本機 token＋writer lease，產生一致性 SQLite 備份；復原時先停止本工作區服務，
保留原資料，再用驗證過的備份置換主檔，重新啟動核對會議／事件／匯出。不得直接覆寫運作中的 DB。
目前不保存原始錄音，也沒有自動語者或摘要功能；缺少音訊時不能保證修復漏辨區間。

## 手機網頁版（2026-11-10）

- 開發：`pnpm -F web dev:mobile`；建置：`pnpm -F web build:mobile`，產物在 `apps/web/dist-mobile/`（純靜態，可放任何 HTTPS 靜態主機）。
- 發佈到 GitHub Pages：把 `dist-mobile/` 內容（加一個空的 `.nojekyll`）推到本 repo 的 `gh-pages` 分支，於 Settings → Pages 選 `gh-pages` 分支根目錄。網址為 `https://zeroalcoholic.github.io/meeting-captioner/`。
- 使用：手機開網址 → 貼上 Gemini（或 OpenAI）金鑰 → 儲存後自動測試 → 開始。可「加入主畫面」。麥克風需要 HTTPS。
- 限制：只支援麥克風；螢幕關閉或切到背景時瀏覽器會停止收音；字幕不存檔，關閉分頁即清除；有 IP 白名單的 OpenAI 金鑰在行動網路會被拒絕。

## Managed Windows service (2026-10-06)

Windows／Node 22+ 的日常入口為 `pnpm service:start`（或根目錄
`start-service.cmd`）。`pnpm service:status` 查詢現有實例、`pnpm service:stop`
停止它；更新程式使用 stop → start，不在會議中自動換版。

- 同一 canonical workspace path 對應同一 named pipe。OS bind 成功的 owner
  才能建置與啟動；同時 start 也只會有一個 owner。Windows 在程序結束／崩潰後
  自動釋放 pipe，殘留 `.cache/meeting-service/runtime.json` 不被當成活服務。
- 首次啟動優先 `127.0.0.1:43871`；首次遇占用／禁止綁定時由 OS 選埠，實際網址以
  status 的 `url` 為準。成功後在既有 `runtime.json` 保存 `originPort`，往後重啟固定使用，
  不因占用而另開網址。舊版狀態檔會採用同 workspace 最後一次的合法 `127.0.0.1` 網址。
  既有網址被占用時明確啟動失敗，保留埠與資料；查看 `service.log`，由使用者處理占用後
  再 start。服務不連線至占用者，也不終止外部程序。
- `node scripts/service.mjs start --port=43872`／`--port=0` 僅供首次選埠；已有固定網址時，
  不同的明確參數會報 `Origin migration required`，不實際變更。已運行時仍重用既有實例。
  不要刪除／重寫 `runtime.json` 來強迫換埠；損壞檔案會保留並拒絕啟動。
- 待存救援優先恢復原網址，以原 Chrome profile 開啟並讓既有 outbox 重送，取得 ACK、
  待存歸零並核對全文後才視為完成。新埠、`localhost` 別名、另一個 Chrome profile
  看不到原 IndexedDB，不代表沒有待存資料；無法恢復原網址時應記為「待救援未知」。
  系統不枚舉其他瀏覽器 profile，也不自動連線至未知舊網址或向占用者送逐字稿。
- 網頁與 API 同來源，managed 模式停用跨來源 CORS 授權；fallback 後不會繼續
  信任原候選埠上的異物網站。只綁 IPv4 loopback，不提供 LAN 分享。
- 工作區 owner 管理一個 Node HTTP 子程序提供線上正式版，不背景啟動 5173／8000／9090。
  OpenAI／Gemini 能否使用仍以設定與實際上游狀態為準，不以 `phase:ready`
  代替上游可用性；沒有 key 時 UI 仍應如實顯示不可用。
- 每次啟動建置到 `.cache/meeting-service/builds/<instanceId>/`，不改目前服務
  的資產。建置成功後只保留最新兩份已完成的建置（新的與交接中可能仍在服務的前一份），
  並刪除中斷的建置；只清有 `<instanceId>.managed-build` 標記的，2026-11-20 前的舊建置不動
  （`scripts/service-build-retention.mjs`）。清理失敗只寫 stderr，不擋服務啟動。status 與 `/_meeting-audio/instance` 提供 workspaceId、instanceId、
  PID、buildId、url；不公開絕對工作區路徑或 key。HTTP 沒有 stop 入口。
- Stop 透過本機 pipe 並核對 instanceId，不使用 taskkill／依 PID 檔終止。
  啟動／重啟期間也接受同 instance 的 Stop；取消建置並等持有的建置子程序 close 後才釋放 owner，晚完成的初始化不再 listen。建置各步有 60 秒期限，start 等待最多 180 秒。
  逾時看 status 與 `service.log`，不要另開相同服務。記錄檔只供診斷。
- W08.1 子程序復原已完成本機驗收；真雲端／場域與 W08.2 仍待驗：自動復原沿同 build/origin，每 60 秒最多 3 次重啟；`restartCount` 是本次 owner 累計，`childInstanceId` 區分子程序。超限回報 failed，查明原因後明確 stop → start 重試。此操作會重新建置，應先停止會議；不自動升級使用中的會議。
- managed 服務的 archive bootstrap 提供 workspaceId/buildId；原頁重取權限時若身分變更或消失，會停止自動補存並保留待存資料。請保留分頁、核對原工作區與版本後重試，勿清除瀏覽器資料。舊版非 managed 入口沒有這項身分資訊，不宣稱有相同的版本核對保證。
- 此管理工具目前只支援 Windows named pipe；其他 OS 保留既有入口，沒有假設
  POSIX filesystem socket 在 crash 後也能自動回收。

驗證：`pnpm test:service` 執行實際 IPC／HTTP 測試，涵蓋同時啟動、異物占埠、
身分不符拒停、殘留狀態檔、建置失敗、異常 IPC 輸入及 crash 後重啟。
正式 app 的受控占埠／Chrome 結果保存在 `.cache/meeting-service/verification.json`。

`pnpm dev` 及舊 ZIP 的 start.bat/start.sh 仍是獨立開發／發行入口，不在此工具
管理範圍；日常請固定使用上述入口，避免另起平行服務。不要手動修改 runtime.json
冒充服務所有權，也不要把 fallback 配置成自動停止陌生程序。

## Online environment and key switching (2026-09-11)

- The service reads process environment at startup; it does not load `.env`.
  Restart from a newly initialized terminal after changing persistent keys.
- `OPENAI_API_KEY` is preferred; `OPENAI_API_KEY_AUDIO` is the alternate.
  Either one alone supports OpenAI. `GEMINI_API_KEY` alone supports Gemini.
  Configure both providers for automatic cross-provider recovery.
- OpenAI tries WebRTC then same-key WebSocket. Only explicit auth rejection
  advances to the other key. Ordinary network/timeout/audio/policy failures
  retain the account. A rejected slot is demoted for 30 minutes; after expiry,
  the next mint tries the preferred slot again. This is not immediate network
  change detection. Restart also clears this in-memory preference.
- `/session/info` exposes available provider names, next OpenAI key slot and
  demotion reason, never key values. Presence does not prove provider reachability.
- Both release launchers accept primary-only, audio-only and Gemini-only
  environments; no-key environments fail before starting the server.
- Gemini uses v1beta token mint and constrained WebSocket together; its model
  remains `gemini-3.5-live-translate-preview`.

Current-network real-audio checks passed through OpenAI WebRTC/WS, Gemini and an
audio-only-key process, with synthetic English. Pause/resume, provider switching,
socket reconnection and Stop release were also exercised. Translation errors
still occurred; see the diagnostic for the exact scope and output evidence.

When rebuilding a running bundled distribution, stop it before replacing web
assets, then restart. Static asset routes are registered at service startup;
replacing hashed assets under a running process can otherwise return 404.

> Day-to-day commands, troubleshooting, and operational notes.

---

## First-time setup

See [`README.md`](../README.md) Quick Start.

TL;DR:

```powershell
# Windows
.\scripts\setup.ps1
.\scripts\doctor.ps1
```

```bash
# Unix
./scripts/setup.sh
./scripts/doctor.sh
```

---

## Phase 1 operating rules

### Local-only production launch

The production-style offline launchers bind both services to loopback and do
not enable Uvicorn reload:

```powershell
.\services\offline\start.bat
```

```bash
./services/offline/start.sh
```

Expected listeners are `127.0.0.1:9090` (WhisperLiveKit) and
`127.0.0.1:8000` (FastAPI). A wildcard/LAN bind is not a supported default.

### Transcript retention

**本機保存逐字稿** is off by default. While off, captions remain in memory for
the current page only and are not restored after reload. Enabling it explicitly
persists the current snapshot. Turning it off immediately removes the app's
localStorage/legacy snapshots and serially clears IndexedDB; the captions still
visible on the current page are not erased. Use Export before reload if the
meeting must be retained as a file.

### Stop before changing session configuration

While a session is running, mode, scenario, online backend, and language pair
are locked. Press **Stop**, wait for the stopped state, then change settings and
start again. Stop releases the active microphone/display track and transport;
there is no supported in-place provider handoff.

### Offline translation pressure

Offline MT is serialized through a FIFO queue with capacity 10. If translation
falls behind, the oldest queued translation is dropped so transcript reception
continues, and the UI receives `translation:degraded`. The current caption
source text remains available; do not restart WHL merely because this health
state appears. Reduce input rate or investigate MT/model performance.

### Live upstream contract probe

This release operation uses real server-side credentials and is never implied by
unit-test success. Obtain explicit authorization before running:

```powershell
pnpm -F @meeting-audio/online probe:upstream-contracts
pnpm -F @meeting-audio/online verify:upstream-contracts
```

Required environment variables: `OPENAI_API_KEY` and `GEMINI_API_KEY`;
`OPENAI_API_KEY_AUDIO` is an optional OpenAI 401/403 fallback. The probe creates
an OpenAI translation client secret, creates a one-use Gemini auth token, and
opens Gemini only long enough to receive `setupComplete`. It sends no audio or
transcript content.

Success writes:

```text
tests/fixtures/upstream-contracts/openai-realtime-translate.json
tests/fixtures/upstream-contracts/gemini-live-translate.json
```

Inspect both files before commit. They must contain placeholders instead of API
keys, ephemeral credentials, ids, and unstable timestamps. A failed or
unauthorized probe is an explicit unverified release operation, not a passing
Phase 1 result. The second command reads both fixtures back through the exact
contract validators and exits non-zero if either file is missing, malformed, or
records a non-dedicated model; it is required in addition to manual secret
inspection. Before accepting Phase 1, also confirm the Gemini provider unit test
imports and compares the recorded `clientFrame`, and `tests/e2e/online-mock.ts`
imports the recorded `serverFrame`; a standalone validator is not a substitute
for those consumers.

Last accepted recording: 2026-07-30 (`b8029e6`). The minimal OpenAI and Gemini
calls passed with explicit authorization; verifier, source-key scans, provider
golden comparison, E2E golden acknowledgement, and the full release matrix all
passed. No audio or transcript content was sent.

---

## Project KEEPALIVE — manual verification (needs live keys / a real meeting)

Automated coverage (238 web unit + 15 Playwright e2e) cannot exercise a real
backend failure, so verify these by hand before relying on a long meeting:

**Cross-model failover (#21):**

1. Set `OPENAI_API_KEY` and `GEMINI_API_KEY` in the system env; start the online
   service + web app; Start OpenAI and confirm captions.
2. Force a backend failure — e.g. disconnect the network for ~40 s, or block
   `api.openai.com` — until the amber pill turns to the red **「OpenAI 連線異常」
   FailoverBanner**.
3. Click **「⇄ 切換到 Gemini 繼續」**. Expect: Gemini starts, the existing
   transcript/history is preserved (NOT cleared), new captions append.
4. Repeat the reverse (Gemini → OpenAI).

**OpenAI zero-gap renewal (#7):** run an OpenAI session for ~26 min (or set a
short `session_renewal_recommended_ms` on the broker for a quick check) and watch
the renewal: captions must keep flowing with no visible gap and the OS mic
indicator must NOT blink off/on.

**Gemini persistent reconnect (#16):** during a Gemini session, drop the network
for >30 s while speaking; expect a `degraded`/`reconnecting` pill, automatic
recovery, and — if the outage is long — the `failed` pill + failover banner while
it keeps retrying.

**Lightweight soak (#18):** run Demo (fake-replay) or a live session for 30–60
min; confirm the board stays responsive, the history scrollback is capped
(`HISTORY_RENDER_SEGMENTS = 400`, full history still exports), and memory stays
bounded (DevTools → Performance memory / heap snapshot trend flat).

---

## Daily Development

```
pnpm dev                  # web + online (concurrently)
pnpm -F web dev           # web only
pnpm -F online dev        # online only
cd services/offline
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000   # offline dev only
```

Open http://localhost:5173.

---

## Tests

```
pnpm test                 # all Vitest unit tests
pnpm -F contracts test    # one workspace
pnpm test:e2e             # Playwright
cd services/offline && uv run pytest
```

### Workspace capacity

`pnpm test` 最後一步是 `pnpm check:capacity`（`scripts/workspace-capacity.mjs`）。`.cache` 上限 400 MB、`.tmp` 1 GB、`release` 200 MB；超過就失敗，並列出最大的項目。不跟隨連結點。

超過時改做這些，不要調高上限：

- `.cache`：驗收結論已寫進文件後，刪掉該輪的 `trace.zip`，保留 log、JSON、截圖。用 `--output=.cache/<名稱>` 跑的驗收，每個失敗案例會留下 10–25 MB 的 trace，Playwright 只清空這次指定的輸出目錄。
- `.tmp`：E2E 只保留最近一輪（`tests/e2e/e2e-temp.mjs`）；其他暫存用完就刪。
- `release`：`scripts/package-online.ps1` 打包成功後會呼叫 `scripts/release-retention.mjs`，只保留最新 3 份 zip 和目前的展開目錄。沒有 `<名稱>.release.json` 標記的舊打包永遠不會被自動刪，因為文件可能引用它們；要刪就先確認沒有被引用。

刪除任何路徑前，先確認文件沒有引用**這個完整路徑**。只比對開頭名稱會誤判，例如引用 `x.log` 不代表引用了同名目錄 `x/`。

---

## Lint / Format / Typecheck

```
pnpm lint                 # eslint
pnpm format:check         # prettier check (cross-platform EOL aware)
pnpm format               # prettier --write
pnpm typecheck            # tsc --noEmit
cd services/offline && uv run ruff check .
```

---

## Default Ports

| Service    | Port | Override env var |
| ---------- | ---- | ---------------- |
| Web (Vite) | 5173 | (Vite default)   |
| Online     | 8787 | `ONLINE_PORT`    |
| Offline    | 8000 | `OFFLINE_PORT`   |

Free a port (Windows):

```powershell
Get-NetTCPConnection -LocalPort 5173 | Select-Object OwningProcess
Stop-Process -Id <pid>
```

Free a port (Unix):

```bash
lsof -i :5173
kill <pid>
```

---

## Git Identity

If `git commit` fails with "Author identity unknown":

```
git config user.email "you@example.com"
git config user.name "Your Name"
```

(omit `--global` to keep it scoped to this repo).

---

## Reinstall From Scratch

```
# Remove deps and lockfiles
rm -rf node_modules apps/*/node_modules services/online/node_modules packages/*/node_modules
rm -rf services/offline/.venv

# Reinstall
pnpm install
cd services/offline && uv sync
```

---

## Common Issues

### `pnpm: command not found`

Run `npm install -g pnpm`, then re-open the shell.

### `uv: command not found`

Windows: `winget install --id=astral-sh.uv -e`
macOS: `brew install uv`
Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

### Port already in use

See "Default Ports" above.

### CRLF warnings on Windows

Expected. Git is normalizing to LF on commit; harmless.

### Playwright browsers not installed

`pnpm exec playwright install`

---

## Closing P0 with commits

See [`PROJECT_STATE.md`](PROJECT_STATE.md) §"Closing P0 — Suggested
Commit Sequence" for a 7-commit Conventional Commits split, or use a
single commit if you prefer.

Steps:

1. Set git identity once (repo-local; CLAUDE.md forbids agents touching
   global git config):
   ```
   git config user.email "you@example.com"
   git config user.name "Your Name"
   ```
2. Run the commit sequence.
3. Verify: `git log --oneline` shows your commits.

## Online Stack Operations

### `/healthz` schema

```json
{
  "ok": true,
  "service": "online",
  "version": "0.0.0",
  "timestamp": "2026-…",
  "components": {
    "apiKey": "configured | missing",
    "openai_reachability": "unknown | ok | degraded",
    "openai_last_change_at": "ISO timestamp",
    "uptime_sec": 123
  }
}
```

`ok` is `true` only when `apiKey === 'configured'` AND
`openai_reachability !== 'degraded'`. The reachability flag is updated
opportunistically on every `/session` call — `/healthz` itself does not
ping OpenAI.

### `/session` failure modes

| Status             | Meaning                                                        | Operator action                                |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------- |
| 200                | Ephemeral token returned with `session_renewal_recommended_ms` | —                                              |
| 400                | Invalid request body (unknown key or bad `langPair`)           | Fix client                                     |
| 429                | Per-IP rate limit (`SESSION_RATE_LIMIT_PER_MIN`) exceeded      | Throttle client; raise env if legitimate       |
| 502                | Upstream network error (DNS, connection refused)               | Check egress firewall                          |
| 503                | `OPENAI_API_KEY` missing                                       | Set env var, restart                           |
| 401/403 persisting | Both OpenAI keys rejected upstream                             | Check key restrictions; see key failover below |

### OpenAI key failover (`OPENAI_API_KEY_AUDIO`)

The primary `OPENAI_API_KEY` may be endpoint/domain-restricted (scoped
service-account policy). Set an alternate private key in the system env as
`OPENAI_API_KEY_AUDIO`: when an upstream call is rejected with 401/403 the
server retries once with the alternate key and sticks to whichever works
(latency-first — no repeated failing round-trips). 429/5xx/timeouts never
trigger a switch. `/healthz` reports the active slot as
`components.openai_key_slot` (`primary` | `audio`). Keys are read from the
system env only — a terminal/service started before `setx` will not see a
newly added key; restart it from a fresh shell.
| 504 | Upstream took longer than `OPENAI_TIMEOUT_MS` | Check OpenAI status page; raise env if needed |
| Upstream 4xx/5xx | Forwarded with **sanitized** message — full body logged server-side only | `pino` log shows raw upstream body |

### Session renewal

- Client renews ~25 min in (`SESSION_RENEW_MS`) before OpenAI's hard 30-min cap.
- Renewal preserves `captionStore` — the meeting transcript is continuous.
- If renewal itself fails, provider emits `health.transport.degraded` and
  retries once after 5 min instead of dying silently.

### ICE restart policy

- 3 attempts, exponential backoff: 3 s → 6 s → 12 s.
- Restart counter resets when ICE returns to `connected` / `completed`.
- After 3 failed attempts, provider emits `health.transport.failed` and stops.

### Graceful shutdown

- `SIGINT` / `SIGTERM` triggers `app.close()` with a 5-second hard timeout.
- `start-dev.bat` Ctrl+C propagates to the online process via `concurrently`.

---

## Diagnosing an OpenAI `SDP exchange failed` error

The error now carries OpenAI's own status, error code, message and a hint, e.g.

```
OpenAI SDP exchange failed (401 ip_not_authorized) — Your IP is not authorized
to make this request. — this network's egress IP is not on the OpenAI
organisation's allowlist for the realtime call endpoint ...
```

**Which transport is live** — the 10-second diagnostic dump in DevTools names
it (`[openai-rt diag] { transport: 'webrtc' | 'websocket', ... }`), and a
fallback announces itself as a `reconnecting` health message ending in
"switching to the WebSocket transport". A session on WebSocket is running the
same OpenAI translation session with the same key; it is not a degraded mode
and it is not the offline path.

Which key is in play, and whether one has been demoted:

```powershell
curl.exe -s http://127.0.0.1:8787/session/info
# → "openaiKeySlot":"primary" | "audio"
#   "openaiKeyDemotion": null | { slot, reason, ageMs }
```

`openaiKeySlot: "audio"` with a demotion recorded means the primary key was
rejected downstream and the alternate took over automatically. The demotion
clears itself after 30 minutes (or on a server restart), so the primary is
re-tried on the next bring-up.

To reproduce the endpoint split by hand — note that a dummy `v=0` body returns
400 for _any_ key because the SDP is parsed before authorization, so use a real
offer captured from the browser:

```powershell
# mint (works even when the realtime call endpoint is blocked)
curl.exe -s -X POST https://api.openai.com/v1/realtime/translations/client_secrets `
  -H "Authorization: Bearer $env:OPENAI_API_KEY" -H "Content-Type: application/json" `
  -d '{\"session\":{\"model\":\"gpt-realtime-translate\",\"audio\":{\"input\":{},\"output\":{\"language\":\"zh\"}}}}'
# then POST a REAL offer SDP to .../translations/calls with the returned ek_...
```

See `docs/FAILURE_MODES.md` §"Call-stage OpenAI key rejection" for the measured
result table.

---

## Reading caption-latency numbers (background monitor)

A passive monitor records caption latency for the running session (no HUD, no
perf cost). To read it during/after a REAL-key session, open DevTools console:

```js
window.__latency.summary(); // current session, per provider: ttfcMs, lagP50/P95, samples
window.__latency.export(); // raw per-segment samples (for analysis)
window.__latency.history(); // last 50 past-session summaries (persisted in localStorage)
```

Metrics are ARRIVAL-based proxies (honest caveat):

- `ttfcMs` — transport 'connecting' → first translation (bring-up felt latency)
- `lagMs` — a segment's first event → its first translation (responsiveness)
- `durMs` — a segment's first event → finalization

It also logs a one-line `[latency] …` summary to the console every ~15 s. Use it
to compare OpenAI vs Gemini on the SAME spoken input and pick the faster backend.
For true spoken-word→on-screen latency, do a clap/marker test against the real
key (the monitor numbers are the repeatable in-app proxy, not microphone-truth).

## YouTube / web-page audio realtime field test

Use this when comparing OpenAI vs Gemini with a real English news video. This is
a field test because browsers require a user gesture and a picker choice for
`getDisplayMedia`; automated e2e only proves the app routes `system` audio to
display capture.

Recording is explicit. Normal use is not recorded unless the operator presses
`● Test`.

1. Start the online service + web app with both `OPENAI_API_KEY` and
   `GEMINI_API_KEY` available to the server.
2. Open a second browser tab or window with a stable English news video. Prefer a
   known segment with continuous speech and minimal music/ads; avoid changing
   videos between providers.
3. In the app, choose Scenario → **Online Meeting Caption Box**. Confirm the 🔊
   chip and the Share system audio hint are visible.
4. Select Online backend → **OpenAI**, then press `● Test`. The button changes to
   `■ Test`, meaning a field-test run is active.
5. Click Start, then in the browser share picker choose the YouTube tab or Entire
   Screen and enable audio sharing.
6. Let the same clip run for 60-120 seconds. Press the app **Stop** button to
   stop the provider and finish the field-test run. Pressing `■ Test` also
   finishes the run without stopping the provider.
7. Rewind the YouTube video to the same timestamp. Switch Online backend →
   **Gemini**, press `● Test`, click Start, share the same YouTube tab/screen
   with audio, run for the same duration, then press **Stop**.
8. Press `⬇ Test` to download the recorded field-test JSON, or inspect it from
   DevTools console:

   ```js
   console.log(
     JSON.stringify(
       {
         fieldHistory: window.__fieldTest.history(),
         latencySummary: window.__latency.summary(),
         latencyHistory: window.__latency.history(),
       },
       null,
       2,
     ),
   );
   ```

Optional markers while a run is active:

```js
window.__fieldTest.mark('first visible caption');
window.__fieldTest.mark('noticeable stall');
```

Manual recorder control remains available for special cases, but should not be
needed for the standard YouTube comparison:

```js
window.__fieldTest.startTimed('YT OpenAI manual', 120_000, 'video title + timestamp');
window.__fieldTest.finish('manual early stop');
```

Compare each run's `runSummary` (`lagP50`, `lagP95`, `durP50`, samples),
`latencySummaryAtFinish`, and captured settings (`onlineProvider`, `audioSource`,
`langPair`). The recorder is arrival-based; for true video-audio-to-screen
latency, record the browser window and caption board together and align on a
visible spoken-word/scene marker.

Pass criteria for venue use: both providers must show non-silent audio levels,
no blank caption board after the first spoken sentence, and no repeated
multi-second stalls. As of 2026-06-29 the Gemini translate path defaults to the
official low-latency Live Translate setup (`AUDIO` response modality +
`outputAudioTranscription` text side channel). If Gemini is still materially
slower on the same clip, inspect per-utterance output-transcription cadence
before changing chunk size; the client audio chunk is already 32 ms.

## Open Questions

- Recommended Node version manager (volta? nvm-windows?) — to be decided
  based on team preference.

## 公司網路與代理（W09，本機路由已驗、公司環境待驗）

目前兩家 broker 的 token/文字請求皆使用 Node 原生 `fetch`。本機 Node 24.14.0 已驗 CONNECT、NO_PROXY、額外 CA 信任、未信任憑證拒絕與代理 407 拒絕；不用另裝 proxy 套件。這不代表公司網路或瀏覽器音訊傳輸已合格。

需要公司代理時，在啟動 Node **之前**於同一個 PowerShell 設定（位址與 CA 檔案須由公司提供）：

```powershell
$env:NODE_USE_ENV_PROXY = '1'
$env:HTTPS_PROXY = 'http://company-proxy.example:8080'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:NODE_EXTRA_CA_CERTS = 'C:\company\approved-ca.pem'
pnpm service:start
```

上述是替換用範例，不能直接當公司設定。保留既有 NO_PROXY 的公司清單並加入 loopback；啟動中的 owner/child 不會讀取新 shell 環境，設定變更須等會議保存完成後 stop/start。專案不自動讀 `.env`。不要把代理帳密貼入診斷輸出，也不要關閉 TLS 驗證。這份本機資格限 Node 24.14.0；舊 runtime 不能只因設定環境變數就視為可用。原生設定說明見 [Node 官方企業網路文件](https://nodejs.org/learn/http/enterprise-network-configuration)。

三條路徑要分開驗收：

| 路徑 | 設定與成功證據 |
| --- | --- |
| Node → provider HTTPS | Node 代理與 CA；兩家的實際 token mint 各自成功才算該路徑可達 |
| Chrome → provider WSS | 由 Chrome/系統的網路與憑證設定決定；Node 代理不會替瀏覽器轉送音訊 |
| Chrome → OpenAI WebRTC media | 另驗實際媒體傳輸與有效字幕；既有 WebSocket fallback 成功也只證明那條替代路徑 |

token 成功但無新字幕時，不能回報整體網路正常；一家不可達由既有雙向備援處理，兩家都受阻則保留內容並顯示失敗/重試。無法從瀏覽器確定 DNS、TLS、代理或防火牆細因時，不猜測。公司/VPN 實測與雙向切換仍待授權環境驗收。

本機原始證據：`.cache/w09-network/result.json`，探針 `.cache/w09-network/probe.mjs`；只使用隔離自簽測試憑證與 loopback，沒有呼叫雲端、外送內容或變更系統信任庫。

原生 Chrome WSS 證據另見 `.cache/w09-network/browser-wss-result.json`。預設 Chrome 拒絕 Node 已信任的測試憑證；成功往返只使用隔離測試瀏覽器的單一 SPKI 例外，不能作為正式部署的憑證設定方式或公司 CA 已驗收的證明。瀏覽器代理的目標 CONNECT 407 另測且拒絕連線。W09.1 本機工程驗收完成，W09.2 公司網路及真服務資格仍待驗。

後端 token 請求的日誌只記固定診斷代碼；不輸出原始例外或上游正文。`UPSTREAM_DNS` 請查 DNS/代理名稱，`UPSTREAM_TLS` 請查憑證與授權 CA，`UPSTREAM_CONNECTION_REFUSED`/`UPSTREAM_CONNECTION_RESET` 請查代理或出口連線，`UPSTREAM_NETWORK_UNREACHABLE` 請查目前網路，`UPSTREAM_TIMEOUT` 表示期限已到。`CLIENT_ABORTED` 是請求端取消；`UPSTREAM_REQUEST_FAILED` 表示無法由已知代碼判定，不能直接推論為防火牆或代理認證。HTTP 回覆另記狀態碼；實測 Node 對 CONNECT 407 未提供可安全判定的專用 cause，需由公司代理端確認。瀏覽器連線錯誤同樣不猜測細因。


## 資料備份與還原（W07，本機操作已驗）

1. 在工作目的列下方展開「資料備份」，按「建立完整備份」。它先嘗試保存本分頁待存內容，再建立所有已保存會議的一致性快照；會議後續新內容繼續保存，但不會回寫這份舊快照。
2. 分別按「下載備份資料庫」及「下載驗證清單」，保留相同 backup-ID 前綴的 `.sqlite` 與 `.manifest.json` 兩個檔案，放在同一資料夾。下載位置依瀏覽器設定，可在瀏覽器設定為每次詢問位置。畫面「已送出下載」不代表磁碟保存已確認，請核對兩個檔案均存在。
3. 請另外保存到外接磁碟等位置；同磁碟副本無法防止磁碟故障。服務端 `backup-UUID/meetings.sqlite` 與 `manifest.json` 會保留，系統不自動刪除舊備份。備份不含錄音。
4. 失敗可重試，原資料不會因建立備份而被替換；若服務版本過舊不支援下載，請更新本機服務後再操作。

還原核心已驗證原稿/譯文/校訂/缺口與安全副本，HTTP/UI 與舊 outbox 隔離已接線；操作步驟見下方。請勿直接覆寫使用中的資料庫。

切換前會保存 `restore-pending.json`；此檔存在代表切換未完成，writer 啟動先驗證所指安全副本並恢復原資料，失敗則拒絕啟動。不可手動刪除紀錄來強迫繼續。`.partial` 目錄不是已發布備份，程序中斷可能留下暫存目錄。成功切換後但回應遺失屬結果未確認，不等同切換未完成。

一致性快照沿用 [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)。已驗真 SQLite、Chrome 下載、Windows 占檔、受控重開/回復寫入失敗及切換前後 worker 退出；未驗實體斷電或真雲端辨識負載。證據見 `.cache/w07-backup-verification.json`。

還原核心會將切換副本升為 SQLite schema 2，建立新的資料世代；正常 schema 1 會議不因此升版，備份讀取支援 schema 1/2。已驗上一版 writer 以 `ARCHIVE_SCHEMA_TOO_NEW` 拒寫且不修改 DB。不要降低 user_version 繞過保護。本機 API 的世代不符會回報 `ARCHIVE_GENERATION_MISMATCH`；瀏覽器 outbox 遇世代不符會保留舊資料、停止重試並顯示唯讀原因；勿清除瀏覽器資料。舊快照世代不符時保留內容並拒絕匯入；本機切換須 pending=0，舊 loss 紀錄保留。測試 worker 恢復時須先重建 online，避免新 routes 配到舊 dist worker。

### 從兩個備份檔案還原（本機工程驗證）

1. 停止會議，等保存與結案完成後再開啟「資料備份」。進行中或暫停時停用還原。
2. 選取同一備份的 `.sqlite` 與 `.manifest.json`，按「匯入並驗證備份」。上限 512 MiB；匯入不變更目前 DB。
3. 驗證成功後勾選取代確認，按「確認還原備份」。系統先保存待存內容並建立目前 DB 的安全副本，再切換。
4. 成功訊息列出安全副本位置；按「重新載入還原後資料」。這是同磁碟副本，不取代異碟備份。重載後選「純字幕（繁中＋原文）」，在「完整會議紀錄」按「重新整理紀錄」並點會議名稱；此清單也包含翻譯會議。可按「匯出完整原始紀錄 JSON」下載原文、譯文及原始事件。
5. 若還原回覆遺失，開啟「資料備份」並按「核對並完成上次還原」。重新開頁仍可讀取待核對紀錄。已套用時不再還原；尚未送達時以同一 ID 重試。剛重新載入而原 lease 未到期，依提示等 15 秒再核對；不會搶其他分頁的權限。
6. 若仍有待存/RAM 晚到內容、其他還原已改變世代或持續儲存錯誤，保留分頁，勿清除瀏覽器資料。晚到內容不會自動刪除或送進新世代；若確認還原已套用，可勾選「若還原已套用，將晚到內容另存於此瀏覽器的舊世代保留區後完成還原」，再按核對。只有已套用才允許此操作；交易失敗會保留原待存資料。成功後重新載入，按「下載舊世代保留紀錄」，確認 JSONL 檔已存好。檔案逐行保留舊世代鍵、會議資訊、原事件及缺口，可用文字編輯器讀取；不會自動匯回新資料庫，下載也不刪除瀏覽器內副本。若確認要放棄尚未套用的還原，按「取消待核對的還原」；成功時保留目前資料與待存內容。已套用或寫入權限未取得時會拒絕取消，請保留資料並核對結果。舊字幕快照不會自動灌回還原後資料庫。
