#!/usr/bin/env bash
# Start WhisperLiveKit + offline service as two independent processes.
# WHL_MODEL env var controls the model (default: distil-large-v3, ~1.5 GB on first run).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$ROOT/.venv/Scripts/python"   # Windows Git Bash path
# Fallback to Unix path if needed
if [[ ! -x "$PYTHON" ]]; then
    PYTHON="$ROOT/.venv/bin/python"
fi

if [[ ! -x "$PYTHON" ]]; then
    echo "ERROR: venv not found. Run: cd services/offline && python -m venv .venv && pip install -e ."
    exit 1
fi

export WHL_MODEL="${WHL_MODEL:-distil-large-v3}"

echo "[offline] Starting WhisperLiveKit (model: $WHL_MODEL) on port 9090..."
"$PYTHON" "$ROOT/run_whl.py" &
WHL_PID=$!

cleanup() {
    kill "$WHL_PID" 2>/dev/null || true
    wait "$WHL_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[offline] Waiting 3 s for WHL to initialise socket..."
sleep 3

echo "[offline] Starting offline service on port 8000..."
"$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir "$ROOT"
