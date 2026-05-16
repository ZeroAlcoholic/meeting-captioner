#!/usr/bin/env bash
# Quick guard against accidental re-introduction of offline-only modules into
# the online-slim bundle. Builds the web app with VITE_DEPLOYMENT_MODE=online
# and grep-checks the output for symbols that should have been tree-shaken.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../apps/web" && pwd)"

cd "$WEB_DIR"
rm -rf dist
VITE_DEPLOYMENT_MODE=online pnpm run build > /tmp/online-build.log 2>&1
echo "Built online-slim bundle:"
ls -la dist/assets/*.js | awk '{print "  " $5 " bytes  " $9}'

BUNDLE_PATH=$(ls dist/assets/index-*.js | head -1)
BUNDLE_SIZE=$(stat -c '%s' "$BUNDLE_PATH" 2>/dev/null || stat -f '%z' "$BUNDLE_PATH")
GZIP_SIZE=$(gzip -c "$BUNDLE_PATH" | wc -c)

# Soft upper bounds based on a 2026-05-16 snapshot:
#   raw  ~1.36 MB, gzip ~545 KB. Most of the bulk is React + opencc-js dicts,
#   which both builds need. Tune these up ONLY for deliberate features;
#   tune down whenever waste is found.
RAW_MAX=1500000  # 1.5 MB raw — leaves ~140 KB headroom
GZIP_MAX=560000  # 560 KB gzipped — leaves ~15 KB headroom

echo "  raw  $BUNDLE_SIZE bytes (max $RAW_MAX)"
echo "  gzip $GZIP_SIZE bytes (max $GZIP_MAX)"

FAIL=0
if [ "$BUNDLE_SIZE" -gt "$RAW_MAX" ]; then
  echo "  ❌ raw size exceeds budget"
  FAIL=1
fi
if [ "$GZIP_SIZE" -gt "$GZIP_MAX" ]; then
  echo "  ❌ gzip size exceeds budget"
  FAIL=1
fi

# Check for offline-only symbols that should not appear in the slim bundle.
FORBIDDEN_PATTERNS=(
  "OfflineSTTProvider"
  "wasapi"
  "pcm-worklet"
  "audioWorklet.addModule"
)
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if grep -q "$pat" "$BUNDLE_PATH"; then
    echo "  ❌ found forbidden symbol in slim bundle: $pat"
    FAIL=1
  fi
done

if [ $FAIL -eq 0 ]; then
  echo "  ✅ slim-bundle audit passed"
else
  echo ""
  echo "Slim-bundle audit FAILED. See $BUNDLE_PATH and /tmp/online-build.log."
  exit 1
fi
