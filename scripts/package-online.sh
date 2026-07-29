#!/usr/bin/env bash
# Linux/macOS equivalent of package-online.ps1. See that file for the
# detailed layout description.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_ROOT="$REPO_ROOT/release"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE_DIR="$RELEASE_ROOT/meeting-audio-online-$STAMP"
LATEST_LINK="$RELEASE_ROOT/meeting-audio-online"
ZIP_PATH="$RELEASE_ROOT/meeting-audio-online-$STAMP.zip"

mkdir -p "$RELEASE_ROOT"
echo "==> Preparing $STAGE_DIR"
mkdir -p "$STAGE_DIR"

echo "==> Building apps/web (VITE_DEPLOYMENT_MODE=online)"
(
  cd "$REPO_ROOT/apps/web"
  VITE_DEPLOYMENT_MODE=online pnpm run build
)

echo "==> Bundling services/online (esbuild)"
(
  cd "$REPO_ROOT/services/online"
  pnpm run typecheck
  pnpm run bundle
)

SERVER_DIST="$STAGE_DIR/server/dist"
echo "==> Copying server bundle -> $SERVER_DIST"
mkdir -p "$SERVER_DIST"
cp "$REPO_ROOT/services/online/dist/server.bundle.cjs" "$SERVER_DIST/"

# KEEP pcm-worklet.js. It used to be stripped as "offline-only", but the Gemini
# Live ONLINE backend captures mic/system audio through this worklet
# (addModule('/pcm-worklet.js')). Removing it 404s the worklet load → Gemini
# sends no audio → connects but produces zero translation in the shipped build.
# (OpenAI Realtime uses WebRTC and does not need it, but it must ship for Gemini.)
echo "==> Copying apps/web/dist -> $STAGE_DIR/web"
cp -r "$REPO_ROOT/apps/web/dist" "$STAGE_DIR/web"

echo "==> Writing launchers + README (no .env — system env only)"
TPL_DIR="$REPO_ROOT/scripts/release-templates"
cp "$TPL_DIR/start.bat" "$STAGE_DIR/"
cp "$TPL_DIR/start.sh" "$STAGE_DIR/"
cp "$TPL_DIR/README.md" "$STAGE_DIR/"
chmod +x "$STAGE_DIR/start.sh"

echo "==> Creating $ZIP_PATH"
rm -f "$ZIP_PATH"
(cd "$STAGE_DIR" && zip -qr "$ZIP_PATH" .)

rm -rf "$LATEST_LINK"
ln -s "$STAGE_DIR" "$LATEST_LINK" 2>/dev/null || true

echo ""
echo "Done."
echo "  Staging dir : $STAGE_DIR"
echo "  Latest link : $LATEST_LINK"
echo "  Zip archive : $ZIP_PATH"
echo "  Zip size    : $(du -h "$ZIP_PATH" | cut -f1)"
echo "  Server bundle : $(du -h "$SERVER_DIST/server.bundle.cjs" | cut -f1)"
