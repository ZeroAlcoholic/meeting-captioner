# Meeting Audio

Meeting-grade live caption, translation, and semi-realtime summary system.

Supports both:

- **Online Realtime** — OpenAI Realtime Translation / Whisper, browser audio via WebRTC, backend audio via WebSocket
- **Offline Local** — WhisperLive / faster-whisper、OPUS-MT / CTranslate2、本機收音與 Windows WASAPI loopback；目前實作尚未通過會議級品質與延遲驗收。

## Windows 日常啟動：單一專用服務

在已安裝本專案 dependencies、Node.js 24.14（本輪驗證版本）的環境執行：

```powershell
pnpm service:start
pnpm service:status
pnpm service:stop
```

也可執行根目錄 `start-service.cmd`。`start` 會建置線上正式版並在背景啟動，
輸出的 `url` 才是實際網址；首次優先使用 <http://127.0.0.1:43871/>，首次被占用時
改用 OS 分配的可用埠，此後固定沿用。固定埠被占用會明確失敗，不自動換網址，避免
遺失對原瀏覽器待存資料的存取。**重複 start 會重用同一工作區的服務，不會再開一份。**

日常服務只有一個 Node 程序、一個 HTTP 埠，網頁與 API 同來源，不啟動 Vite、
Python 或未就緒的離線辨識。這是線上專用入口；完整模式與開發模式仍使用原指令。
更新程式後請先 `service:stop` 再 `service:start`；對正在運作的服務再次 start
不會擅自重建／中斷會議。

控制通道採 Windows named pipe，以工作區實際路徑識別 owner；不依埠號或殘留 PID
停止程序。狀態與記錄在 `.cache/meeting-service/`，不保存 API key。
詳見 [服務管理與隔離](docs/RUNBOOK.md#managed-windows-service-2026-10-06)。

地端逐步開發的模組／建置邊界見 [架構文件](docs/ARCHITECTURE.md)。`pnpm -F web build:online` 單獨建置雲端版；`pnpm -F web build` 建置完整版本。地端實作／Hybrid 分別位於 `providers/offline/`、`providers/hybrid/`，雲端建置拒絕跨入這兩個目錄；共用 PCM／VAD／事件契約仍由兩端使用。`pnpm test:boundaries` 驗證此隔離，一般測試也包含它，日常啟動不跑測試。

選「純字幕（繁中＋原文）」可使用 OpenAI 或 Gemini 專用轉寫，並保存完整地端逐字稿、原稿及人工校訂。
OpenAI 的 `OPENAI_API_KEY` 為主用、`OPENAI_API_KEY_AUDIO` 為備援；Gemini 使用 `GEMINI_API_KEY`，皆只放伺服器環境變數。
以「停止並保存」核對待保存資料與已知缺口，再由會議紀錄匯出 TXT／JSON／SRT。原始錄音目前未留存。
純字幕留存需要原生 `node:sqlite`；操作與資料位置見 [RUNBOOK](docs/RUNBOOK.md)。

> **Project status:** 雙雲端純字幕與逐字稿已完成本機驗證；真實雲端品質及後續會議功能仍在驗收／規劃中。See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

---

## Quick Start (Fresh Machine)

### Prerequisites

- **git**
- **Node.js 24.14**（本輪驗證版本；https://nodejs.org/）
- **Python 3.11+** (https://www.python.org/) — `uv` can also install Python for you
- The bootstrap script will install **pnpm** and **uv** if missing.

### Windows (PowerShell)

```powershell
git clone <repo-url> meeting_audio
cd meeting_audio
.\scripts\setup.ps1            # installs pnpm/uv if missing, runs install
.\scripts\doctor.ps1           # verifies environment
pnpm dev                       # starts web + online stub
# In another terminal:
cd services\offline
uv run uvicorn app.main:app --port 8000
```

### macOS / Linux (bash)

```bash
git clone <repo-url> meeting_audio
cd meeting_audio
./scripts/setup.sh
./scripts/doctor.sh
pnpm dev
# In another terminal:
cd services/offline && uv run uvicorn app.main:app --port 8000
```

Then open http://localhost:5173 and click **Start Fake Replay** to verify the caption path.

---

## Repository Layout

```
apps/web/              # Vite + React + TS — caption board UI
services/online/       # Fastify — OpenAI session bridge
services/offline/      # FastAPI — local STT/MT
packages/contracts/    # Shared TS event schemas (TranscriptEvent, ...)
docs/                  # Architecture, decisions, runbook, test plan
scripts/               # Bootstrap and environment doctor
tests/e2e/             # Playwright cross-app tests
```

---

## Project Documents

- [`CLAUDE.md`](CLAUDE.md) — Project constitution, non-negotiable rules
- [`REFERENCE.md`](REFERENCE.md) — Technical reference index
- [`AGENTS.md`](AGENTS.md) — Coding-agent (Codex) instructions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System architecture
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — Day-to-day commands and troubleshooting
- [`docs/TODO.md`](docs/TODO.md) — Active work and backlog

---

## Environment Variables

**Strict policy: NO `.env` files.** All env vars are read from the user's system environment only. There is a guard test (`services/online/src/server.test.ts`) that fails the build if `dotenv` is re-introduced.

Set these in your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.profile`) or via Windows `setx`:

### Online service (`services/online`)

| Variable                     | Required              | Default                 | Purpose                                            |
| ---------------------------- | --------------------- | ----------------------- | -------------------------------------------------- |
| `OPENAI_API_KEY`             | yes (for Online mode) | —                       | Server-side OpenAI key. Never sent to the browser. |
| `ONLINE_PORT`                | no                    | `8787`                  | Fastify bind port.                                 |
| `ONLINE_CORS_ORIGIN`         | no                    | `http://localhost:5173` | CORS allow-list (single origin).                   |
| `OPENAI_TIMEOUT_MS`          | no                    | `10000`                 | Hard ceiling on upstream `client_secrets` call.    |
| `SESSION_RATE_LIMIT_PER_MIN` | no                    | `30`                    | Token-bucket cap on `POST /session` per remote IP. |
| `SESSION_RENEW_MS`           | no                    | `1500000`               | Browser session lifetime before renewal (25 min).  |

### Offline service (`services/offline`)

| Variable              | Required | Default                                       | Purpose                                                            |
| --------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `OFFLINE_PORT`        | no       | `8000`                                        | FastAPI bind port.                                                 |
| `OFFLINE_CORS_ORIGIN` | no       | `http://localhost:5173,http://localhost:5174` | CORS allow-list (comma-separated).                                 |
| `WHL_MODEL`           | no       | (see `run_whl.py`)                            | WhisperLiveKit model selector.                                     |
| `OMP_NUM_THREADS`     | no       | `8`                                           | Thread count for OpenMP/MKL (set before importing faster-whisper). |

### Web app (`apps/web`, build-time only — `VITE_` prefix)

| Variable                | Required | Default                 | Purpose                                                |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------ |
| `VITE_ONLINE_BASE_URL`  | no       | `http://localhost:8787` | Online service URL the browser hits.                   |
| `VITE_OFFLINE_BASE_URL` | no       | `http://localhost:8000` | Offline service URL.                                   |
| `VITE_DEPLOYMENT_MODE`  | no       | `full`                  | `online` 排除地端 bundle；需要編譯隔離時使用 `build:online`。 |

### Setting `OPENAI_API_KEY`

```bash
# Linux / macOS — persist in shell profile
echo 'export OPENAI_API_KEY="sk-proj-..."' >> ~/.bashrc   # or ~/.zshrc
```

```powershell
# Windows — persist across sessions
setx OPENAI_API_KEY "sk-proj-..."
# (open a new terminal for the change to take effect)
```

---

## Security & Privacy

- OpenAI API keys are **server-side only** — never sent to the browser.
- Offline mode does **not** call any cloud service.
- Transcripts are in-memory by default. Persistent storage requires explicit opt-in.

See [`CLAUDE.md`](CLAUDE.md) for full rules.
