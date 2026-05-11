<#
  scripts/setup.ps1 — Bootstrap Meeting Audio on a fresh Windows machine.
  Idempotent. Safe to re-run.
#>

[CmdletBinding()]
param(
  [switch]$AutoInstall = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

function Write-Ok    ($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err   ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Step  ($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }

function Test-Command([string]$Name) {
  try { Get-Command $Name -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

function Confirm-Install([string]$Name) {
  if ($AutoInstall) { return $true }
  $reply = Read-Host "  $Name is missing. Install now? (y/N)"
  return $reply -match '^(y|yes)$'
}

# --- Tool checks ---
Write-Step 'Checking prerequisites'

if (-not (Test-Command 'git')) {
  Write-Err 'git is not installed. Install Git for Windows from https://git-scm.com/download/win and re-run.'
  exit 1
}
Write-Ok "git $(git --version | ForEach-Object { ($_ -split ' ')[2] })"

if (-not (Test-Command 'node')) {
  Write-Err 'Node.js is not installed. Install Node 22 LTS from https://nodejs.org/ and re-run.'
  exit 1
}
$nodeVersion = (node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 22) {
  Write-Err "Node $nodeVersion is too old. Need Node >= 22 LTS."
  exit 1
}
Write-Ok "node $nodeVersion"

if (-not (Test-Command 'pnpm')) {
  if (Confirm-Install 'pnpm') {
    Write-Host '  installing pnpm via npm...'
    npm install -g pnpm
  } else {
    Write-Err 'pnpm is required. Install with: npm install -g pnpm'
    exit 1
  }
}
Write-Ok "pnpm $(pnpm --version)"

$pythonCmd = $null
foreach ($c in @('python', 'python3', 'py')) {
  if (Test-Command $c) { $pythonCmd = $c; break }
}
if (-not $pythonCmd) {
  Write-Warn2 'Python 3.11+ not found. Offline service (services/offline) will not run.'
  Write-Warn2 'Install from https://www.python.org/ if you need it for P3+.'
} else {
  Write-Ok "python ($pythonCmd) $(& $pythonCmd --version)"
}

if (-not (Test-Command 'uv')) {
  if (Confirm-Install 'uv') {
    Write-Host '  installing uv via winget...'
    winget install --id=astral-sh.uv -e --accept-source-agreements --accept-package-agreements
  } else {
    Write-Warn2 'uv not installed. Skip Python deps. Install: winget install astral-sh.uv'
  }
} else {
  Write-Ok "uv $(uv --version)"
}

# --- .env ---
Write-Step 'Configuring .env'
$envPath = Join-Path $repoRoot '.env'
$envExample = Join-Path $repoRoot '.env.example'
if (-not (Test-Path $envPath)) {
  Copy-Item $envExample $envPath
  Write-Ok '.env created from .env.example (edit to add OPENAI_API_KEY for P2+)'
} else {
  Write-Ok '.env already exists (left untouched)'
}

# --- pnpm install ---
Write-Step 'Installing JS/TS workspace dependencies'
pnpm install
Write-Ok 'pnpm install complete'

# --- uv sync (optional) ---
if (Test-Command 'uv') {
  Write-Step 'Installing Python (offline service) dependencies'
  Push-Location (Join-Path $repoRoot 'services/offline')
  try { uv sync } finally { Pop-Location }
  Write-Ok 'uv sync complete'
}

# --- Doctor ---
Write-Step 'Running doctor'
& (Join-Path $PSScriptRoot 'doctor.ps1')

# --- Next steps ---
Write-Step 'Next steps'
Write-Host '  pnpm dev                     # web (5173) + online (8787)' -ForegroundColor White
Write-Host '  cd services/offline; uv run uvicorn app.main:app --port 8000' -ForegroundColor White
Write-Host '  pnpm test                    # run all unit tests' -ForegroundColor White
Write-Host '  pnpm exec playwright install chromium && pnpm test:e2e' -ForegroundColor White
Write-Host ''
