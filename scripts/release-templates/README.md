# meeting-audio (online distribution)

Live caption + Traditional Chinese translation for meetings, powered by
OpenAI Realtime. This is the **online-only** slim build — no offline STT,
no model files, no Python dependencies.

## What's in this folder

```
meeting-audio-online/
├── server/      ← Single-file Node.js bundle (Fastify + OpenAI bridge)
├── web/         ← Static web app (caption board UI)
├── start.bat    ← Windows launcher
├── start.sh     ← macOS / Linux launcher
└── README.md    ← This file
```

> **Security**: There is no `.env` file. The OpenAI API key is read **only**
> from your system / user environment. This keeps the credential out of the
> filesystem entirely — no risk of accidental commit, archival, or
> copy-paste leak.

## Requirements

- **Node.js 22 or newer** — <https://nodejs.org>
- An **OpenAI API key** with access to the Realtime translation API
- Microphone permission in your browser (Chrome / Edge recommended)

## Setup

### 1. Set `OPENAI_API_KEY` in your environment (one-time)

**Windows — persistent** (recommended; survives reboots, applies to every
new terminal and to Explorer double-clicks):

```cmd
setx OPENAI_API_KEY "sk-proj-..."
```

Then **close that window** and open a new one (or just double-click
`start.bat` afterwards — Explorer-launched processes inherit `setx` values).

**Windows — session only** (useful for ad-hoc testing):

```cmd
set OPENAI_API_KEY=sk-proj-...
start.bat
```

**macOS / Linux — persistent**:

```bash
echo 'export OPENAI_API_KEY="sk-proj-..."' >> ~/.bashrc   # or ~/.zshrc, ~/.profile
source ~/.bashrc
```

**macOS / Linux — session only**:

```bash
export OPENAI_API_KEY='sk-proj-...'
./start.sh
```

### 2. Launch

- Windows: double-click `start.bat`
- macOS / Linux: `./start.sh` from a terminal

The launcher prints two diagnostic lines you should see on every start:

```
[config] OPENAI_API_KEY: set in system env (164 chars)
Server listening at http://127.0.0.1:8787
```

If you see `OPENAI_API_KEY: MISSING`, your env var didn't reach this
process — most often because you used `setx` and are still in the **same
terminal** where it was set (you need a new terminal for `setx` to take
effect).

### 3. Open the app

Open `http://localhost:8787` in Chrome or Edge.

- **🎤 Start Real** — begin captioning (you'll be asked for mic permission)
- **F** — fullscreen the caption board
- **Space** — freeze the live caption (history keeps flowing)
- **.** — show / hide the Export and Clear controls

## How it works

- The API key never leaves this process. The browser receives only a
  short-lived ephemeral token to set up the WebRTC connection.
- Audio streams directly from the browser to OpenAI Realtime.
- Caption / translation events stream back through a WebRTC data channel
  and render in the caption board with ~50 ms partial-update throttling.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `🔑 No API Key` chip in the UI | `OPENAI_API_KEY` missing from this process's env. Set it (see Setup), then restart. |
| `OPENAI_API_KEY: MISSING` in console | Same as above — and remember `setx` only affects NEW terminals. |
| `⚠ Online Service Down` chip | Server didn't start — check the launcher console output. |
| `Microphone permission denied` | Allow mic in your browser's site settings, then reload. |
| `Upstream rate-limited` | OpenAI hit a 429 — wait 30 s and retry. |
| Black caption board for >10 s | Click **Retry**; if it persists, restart the server. |
| Want to access from another device on the LAN | Set `ONLINE_HOST=0.0.0.0` in your env. **WARNING:** no auth; only do this on a trusted network. |

## Verifying the install

After `start.bat` / `start.sh` reports the server is listening:

- `http://localhost:8787/healthz` returns `{"ok":true, ...}`
- `http://localhost:8787/session/info` returns `{"hasApiKey":true, ...}`
  (or `false` if your env var didn't get through — see Troubleshooting)

## Privacy

- Transcripts live in memory only; reloading the page wipes them. Use the
  **Export** button (top-right of the caption board) to save a `.txt`.
- No analytics or telemetry. The only network calls are:
  - Browser → `http://localhost:8787` (this server)
  - This server → `https://api.openai.com` (ephemeral token)
  - Browser → OpenAI WebRTC endpoint (direct, no proxy)
