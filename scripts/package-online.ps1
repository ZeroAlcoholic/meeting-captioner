# Builds and packages the online-slim distribution.
#
# Output: release/meeting-audio-online-<timestamp>/  + matching .zip
#
# Layout (self-contained — no node_modules tree to ship):
#   meeting-audio-online/
#   ├── server/
#   │   └── dist/server.bundle.cjs   (esbuild single-file CJS bundle)
#   ├── web/                          (apps/web built with VITE_DEPLOYMENT_MODE=online)
#   ├── start.bat                     (Windows launcher; verifies Node 22+)
#   ├── start.sh                      (Linux/macOS launcher)
#   ├── .env.example                  (template — user copies to .env)
#   └── README.md                     (3-step setup)
#
# Requires: pnpm 9+, Node 22+. Does NOT touch services/offline or any model files.

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$ReleaseRoot = Join-Path $RepoRoot 'release'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# Build into a timestamped directory; refresh the `meeting-audio-online`
# junction afterwards so a stale file lock never blocks a rebuild.
$StageDir = Join-Path $ReleaseRoot "meeting-audio-online-$Stamp"
$LatestLink = Join-Path $ReleaseRoot 'meeting-audio-online'
$ZipPath = Join-Path $ReleaseRoot "meeting-audio-online-$Stamp.zip"

if (-not (Test-Path $ReleaseRoot)) {
  New-Item -ItemType Directory -Path $ReleaseRoot | Out-Null
}
Write-Host "==> Preparing $StageDir"
New-Item -ItemType Directory -Path $StageDir | Out-Null

# 1. Build the web app in online-slim mode.
Write-Host "==> Building apps/web (VITE_DEPLOYMENT_MODE=online)"
Push-Location (Join-Path $RepoRoot 'apps/web')
try {
  $env:VITE_DEPLOYMENT_MODE = 'online'
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'apps/web build failed' }
} finally {
  Remove-Item Env:\VITE_DEPLOYMENT_MODE
  Pop-Location
}

# 2. Type-check then esbuild-bundle the online service into a single CJS file.
#    The bundle inlines every runtime dep (@fastify/cors, @fastify/static,
#    fastify, openai, dotenv, zod, @meeting-audio/contracts) so the release
#    needs NO node_modules tree — sidesteps pnpm's absolute-path symlinks
#    being shredded by Windows zip tools.
Write-Host "==> Bundling services/online (esbuild)"
Push-Location (Join-Path $RepoRoot 'services/online')
try {
  pnpm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'services/online typecheck failed' }
  pnpm run bundle
  if ($LASTEXITCODE -ne 0) { throw 'services/online bundle failed' }
} finally {
  Pop-Location
}

# 3. Copy the bundle into the staging tree.
$ServerOut = Join-Path $StageDir 'server'
$ServerDist = Join-Path $ServerOut 'dist'
Write-Host "==> Copying server bundle -> $ServerDist"
New-Item -ItemType Directory -Path $ServerDist | Out-Null
Copy-Item -Force (Join-Path $RepoRoot 'services/online/dist/server.bundle.cjs') $ServerDist

# 4. Copy the built web assets; strip the offline PCM worklet which is
#    irrelevant to the online build (OpenAI Realtime uses WebRTC, not PCM).
$WebOut = Join-Path $StageDir 'web'
Write-Host "==> Copying apps/web/dist -> $WebOut"
Copy-Item -Recurse -Force (Join-Path $RepoRoot 'apps/web/dist') $WebOut
$PcmWorklet = Join-Path $WebOut 'pcm-worklet.js'
if (Test-Path $PcmWorklet) { Remove-Item -Force $PcmWorklet }

# 5. Drop launchers + README. Deliberately NO .env.example — the slim
#    distribution reads OPENAI_API_KEY from system env only.
$LaunchersDir = Join-Path $RepoRoot 'scripts/release-templates'
Write-Host "==> Writing launchers + README"
Copy-Item -Force (Join-Path $LaunchersDir 'start.bat') $StageDir
Copy-Item -Force (Join-Path $LaunchersDir 'start.sh') $StageDir
Copy-Item -Force (Join-Path $LaunchersDir 'README.md') $StageDir

# 6. Zip the staging directory for distribution.
Write-Host "==> Creating $ZipPath"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path "$StageDir/*" -DestinationPath $ZipPath -CompressionLevel Optimal

# 7. Refresh the `meeting-audio-online` junction so callers can pin a stable
#    path. Best-effort — failure does not block the zip artifact.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
try {
  $li = Get-Item -LiteralPath $LatestLink -Force -ErrorAction SilentlyContinue
  if ($null -ne $li) {
    if ($li.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      cmd /c rmdir "$LatestLink" 2>$null | Out-Null
    } else {
      Remove-Item -Recurse -Force $LatestLink -ErrorAction SilentlyContinue
    }
  }
  cmd /c mklink /J "$LatestLink" "$StageDir" 2>&1 | Out-Null
} catch {
  Write-Host "  (could not refresh meeting-audio-online junction — zip is the authoritative artifact)"
}
$ErrorActionPreference = $prev
$global:LASTEXITCODE = 0

Write-Host ""
Write-Host "Done."
Write-Host "  Staging dir : $StageDir"
Write-Host "  Latest link : $LatestLink"
Write-Host "  Zip archive : $ZipPath"
$ZipSize = (Get-Item $ZipPath).Length / 1MB
Write-Host ("  Zip size    : {0:N2} MB" -f $ZipSize)
$BundleSize = (Get-Item (Join-Path $ServerDist 'server.bundle.cjs')).Length / 1KB
Write-Host ("  Server bundle : {0:N0} KB" -f $BundleSize)
