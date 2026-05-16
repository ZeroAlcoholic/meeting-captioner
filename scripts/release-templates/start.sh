#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Node 22+ check ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [error] Node.js was not found in PATH."
  echo "          Install Node 22 or newer from https://nodejs.org, then re-run this script."
  echo ""
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "  [error] Node.js $NODE_MAJOR is too old. Required: 22 or newer."
  echo "          Install from https://nodejs.org, then re-run this script."
  echo ""
  exit 1
fi

# ── OPENAI_API_KEY check (system env only — no .env file support) ──────
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo ""
  echo "  [error] OPENAI_API_KEY is not set in your environment."
  echo ""
  echo "  This release reads the key from the system/user environment ONLY."
  echo "  Pick one of the methods below, then re-run start.sh:"
  echo ""
  echo "    Persistent — add to your shell's rc file:"
  echo "      echo 'export OPENAI_API_KEY=\"sk-proj-...\"' >> ~/.bashrc   # or ~/.zshrc, ~/.profile"
  echo "      source ~/.bashrc"
  echo ""
  echo "    Session only — applies to this terminal:"
  echo "      export OPENAI_API_KEY='sk-proj-...'"
  echo "      ./start.sh"
  echo ""
  exit 1
fi

# ── Bundle integrity check ─────────────────────────────────────────────
if [ ! -f "$ROOT/server/dist/server.bundle.cjs" ]; then
  echo ""
  echo "  [error] server/dist/server.bundle.cjs missing — the release looks incomplete."
  echo "          Re-extract the zip; do not move individual files around."
  echo ""
  exit 1
fi

export WEB_DIST_PATH="$ROOT/web"
export LOG_FORMAT=json
cd "$ROOT"

echo ""
echo "  meeting-audio (online)"
echo "  ----------------------"
echo "   Open in browser: http://localhost:8787"
echo "   Press Ctrl+C to stop."
echo ""

exec node server/dist/server.bundle.cjs
