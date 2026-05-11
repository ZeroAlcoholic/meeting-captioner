#!/usr/bin/env bash
# scripts/setup.sh — Bootstrap Meeting Audio on a fresh Unix machine. Idempotent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

AUTO_INSTALL=0
[[ "${1:-}" == "--auto" ]] && AUTO_INSTALL=1

color_ok()   { printf '\033[32m  [OK]   %s\033[0m\n' "$1"; }
color_warn() { printf '\033[33m  [WARN] %s\033[0m\n' "$1"; }
color_fail() { printf '\033[31m  [FAIL] %s\033[0m\n' "$1"; }
step()       { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

confirm() {
  if [[ "$AUTO_INSTALL" == "1" ]]; then return 0; fi
  read -r -p "  $1 is missing. Install now? (y/N) " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- Detect platform ---
case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      PLATFORM=other ;;
esac

# --- Tool checks ---
step 'Checking prerequisites'

if ! have git; then
  color_fail 'git not installed.'
  case "$PLATFORM" in
    macos) echo '  install with: brew install git' ;;
    linux) echo '  install via your distro package manager (apt install git, dnf install git, ...)' ;;
  esac
  exit 1
fi
color_ok "git $(git --version | awk '{print $3}')"

if ! have node; then
  color_fail 'node not installed. Install Node 22 LTS from https://nodejs.org/ (or via nvm).'
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  color_fail "Node $(node --version) too old. Need Node >= 22 LTS."
  exit 1
fi
color_ok "node $(node --version)"

if ! have pnpm; then
  if confirm 'pnpm'; then
    echo '  installing pnpm via npm...'
    npm install -g pnpm
  else
    color_fail 'pnpm required. Install: npm install -g pnpm'
    exit 1
  fi
fi
color_ok "pnpm $(pnpm --version)"

if have python3; then
  color_ok "python $(python3 --version)"
elif have python; then
  color_ok "python $(python --version)"
else
  color_warn 'Python 3.11+ not found. Offline service will not run (only needed for P3+).'
fi

if ! have uv; then
  if confirm 'uv'; then
    echo '  installing uv...'
    if [[ "$PLATFORM" == "macos" ]] && have brew; then
      brew install uv
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
      # Add to PATH for this session if installed to ~/.local/bin
      [[ -f "$HOME/.local/bin/uv" ]] && export PATH="$HOME/.local/bin:$PATH"
    fi
  else
    color_warn 'uv not installed. Skip Python deps. (Only needed for P3+.)'
  fi
fi
have uv && color_ok "uv $(uv --version)"

# --- .env ---
step 'Configuring .env'
if [[ ! -f .env ]]; then
  cp .env.example .env
  color_ok '.env created from .env.example (edit to add OPENAI_API_KEY for P2+)'
else
  color_ok '.env already exists (left untouched)'
fi

# --- pnpm install ---
step 'Installing JS/TS workspace dependencies'
pnpm install
color_ok 'pnpm install complete'

# --- uv sync (optional) ---
if have uv; then
  step 'Installing Python (offline service) dependencies'
  ( cd services/offline && uv sync )
  color_ok 'uv sync complete'
fi

# --- Doctor ---
step 'Running doctor'
bash "$REPO_ROOT/scripts/doctor.sh" || true

# --- Next steps ---
step 'Next steps'
cat <<'EOF'
  pnpm dev                     # web (5173) + online (8787)
  cd services/offline && uv run uvicorn app.main:app --port 8000
  pnpm test                    # all unit tests
  pnpm exec playwright install chromium && pnpm test:e2e
EOF
