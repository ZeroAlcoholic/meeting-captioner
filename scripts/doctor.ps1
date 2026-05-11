<#
  scripts/doctor.ps1 — Environment health check. Read-only.
#>

[CmdletBinding()]
param()

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$results = @()
function Add-Result($label, $status, $detail) {
  $script:results += [PSCustomObject]@{ Label = $label; Status = $status; Detail = $detail }
}

function Get-Tool($name, $args) {
  try {
    $v = & $name @args 2>$null
    return ($v | Select-Object -First 1)
  } catch { return $null }
}

# Tools
$gitVer    = Get-Tool 'git' '--version'
$nodeVer   = Get-Tool 'node' '--version'
$pnpmVer   = Get-Tool 'pnpm' '--version'
$pythonVer = Get-Tool 'python' '--version'
$uvVer     = Get-Tool 'uv' '--version'

if ($gitVer)    { Add-Result 'git'    'OK'   $gitVer }    else { Add-Result 'git'    'FAIL' 'not installed' }
if ($nodeVer)   { Add-Result 'node'   'OK'   $nodeVer }   else { Add-Result 'node'   'FAIL' 'not installed' }
if ($pnpmVer)   { Add-Result 'pnpm'   'OK'   $pnpmVer }   else { Add-Result 'pnpm'   'FAIL' 'not installed' }
if ($pythonVer) { Add-Result 'python' 'OK'   $pythonVer } else { Add-Result 'python' 'WARN' 'not installed (only needed for P3+ offline)' }
if ($uvVer)     { Add-Result 'uv'     'OK'   $uvVer }     else { Add-Result 'uv'     'WARN' 'not installed (only needed for P3+ offline)' }

# Files
if (Test-Path '.env')             { Add-Result '.env'         'OK'   'present' }         else { Add-Result '.env'         'WARN' 'missing (run setup.ps1)' }
if (Test-Path 'pnpm-lock.yaml')   { Add-Result 'pnpm-lock'    'OK'   'present' }         else { Add-Result 'pnpm-lock'    'WARN' 'missing (run pnpm install)' }
if (Test-Path 'node_modules')     { Add-Result 'node_modules' 'OK'   'present' }         else { Add-Result 'node_modules' 'WARN' 'missing (run pnpm install)' }
if (Test-Path 'services/offline/.venv') { Add-Result 'py venv' 'OK' 'present' }          else { Add-Result 'py venv'      'WARN' 'missing (cd services/offline; uv sync)' }

# Ports
foreach ($port in 5173, 8787, 8000) {
  $inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  if ($inUse) { Add-Result "port $port" 'WARN' 'in use' }
  else        { Add-Result "port $port" 'OK'   'free' }
}

# Render
Write-Host ''
Write-Host 'Doctor report' -ForegroundColor Cyan
foreach ($r in $results) {
  $color = switch ($r.Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'White' } }
  $tag = switch ($r.Status) { 'OK' { '[OK]  ' } 'WARN' { '[WARN]' } 'FAIL' { '[FAIL]' } default { '[?]   ' } }
  Write-Host ('  {0} {1,-14} {2}' -f $tag, $r.Label, $r.Detail) -ForegroundColor $color
}

$failCount = ($results | Where-Object Status -EQ 'FAIL').Count
$warnCount = ($results | Where-Object Status -EQ 'WARN').Count
Write-Host ''
if ($failCount -gt 0) {
  Write-Host "  $failCount fail / $warnCount warn — fix the FAILs before running dev." -ForegroundColor Red
  exit 1
}
if ($warnCount -gt 0) {
  Write-Host "  $warnCount warn — you can run pnpm dev, but some features may be unavailable." -ForegroundColor Yellow
} else {
  Write-Host '  all green' -ForegroundColor Green
}
