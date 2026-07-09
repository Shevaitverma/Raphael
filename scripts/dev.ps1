<#
  Start every Raphael service on the host for the walking skeleton.

  Infrastructure (Postgres :5433, Redis :6379) must already be running via
  `docker compose up -d postgres redis`. This script builds the Go binaries, ensures the
  agent-svc venv and web deps exist, then launches all five services detached,
  writing logs to .\logs\.

  Usage:   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
           powershell ... -File scripts\dev.ps1 -NoWeb   # skip the Next.js UI
#>
param([switch]$NoWeb)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# --- load .env if present, else fall back to documented defaults -------------
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $kv = $_ -split '=', 2
    if ($kv.Count -eq 2) { [Environment]::SetEnvironmentVariable($kv[0].Trim(), $kv[1].Trim()) }
  }
}
function Def($n, $v) { if (-not [Environment]::GetEnvironmentVariable($n)) { [Environment]::SetEnvironmentVariable($n, $v) } }
Def DATABASE_URL "postgresql://raphael:raphael@localhost:5433/raphael"
Def REDIS_URL    "redis://localhost:6379/0"
Def JWT_SECRET   "dev-only-change-me"
Def DEV_AUTH_ENABLED "true"
Def GATEWAY_PORT "8080"; Def USER_SVC_PORT "8081"; Def CONV_SVC_PORT "8082"; Def AGENT_SVC_PORT "8000"
Def USER_SVC_URL  "http://localhost:8081"
Def CONV_SVC_URL  "http://localhost:8082"
Def AGENT_SVC_URL "http://localhost:8000"
Def OLLAMA_BASE_URL "http://localhost:11434/v1"

# Credential key must be stable across restarts (it decrypts stored keys).
# It goes in .env, which is gitignored. Never a sidecar file in the tree:
# scripts/.dev_enc_key is one `git add -A` away from committing the master key
# for every user's provider credentials.
if (-not $env:CREDENTIAL_ENC_KEY) {
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
  if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path (Split-Path $PSScriptRoot -Parent) ".env.example") $envFile
  }
  $content = Get-Content $envFile -Raw
  if ($content -notmatch '(?m)^CREDENTIAL_ENC_KEY=.+$') {
    Write-Output "generating CREDENTIAL_ENC_KEY into .env ..."
    $b = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $newKey = [Convert]::ToBase64String($b)
    if ($content -match '(?m)^CREDENTIAL_ENC_KEY=') {
      $content = $content -replace '(?m)^CREDENTIAL_ENC_KEY=.*$', "CREDENTIAL_ENC_KEY=$newKey"
    } else {
      $content = $content + "`nCREDENTIAL_ENC_KEY=$newKey`n"
    }
    Set-Content -Path $envFile -Value $content -NoNewline -Encoding ascii
  }
  # re-read .env so the key is in scope
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
      $n = $Matches[1]; $v = $Matches[2].Trim()
      if ($v -and -not (Get-Item -Path "Env:$n" -ErrorAction SilentlyContinue)) { Set-Item -Path "Env:$n" -Value $v }
    }
  }
}
if (-not $env:CREDENTIAL_ENC_KEY) {
  Write-Error "FATAL: CREDENTIAL_ENC_KEY is unset and could not be generated."
  exit 1
}

function Start-Svc($name, $file, $svcArgs, $wd) {
  Start-Process -FilePath $file -ArgumentList $svcArgs -WorkingDirectory $wd `
    -RedirectStandardOutput (Join-Path $logs "$name.out.log") `
    -RedirectStandardError  (Join-Path $logs "$name.err.log") `
    -WindowStyle Hidden -PassThru | Out-Null
  Write-Host "started $name -> logs\$name.*.log"
}

# --- build Go services -------------------------------------------------------
foreach ($svc in "gateway", "user-svc", "conv-svc") {
  Write-Host "building $svc ..."
  Push-Location (Join-Path $root $svc); & go build -o "$svc.exe" ./...; Pop-Location
}

# --- ensure agent-svc venv ---------------------------------------------------
$agent = Join-Path $root "agent-svc"
$venvPy = Join-Path $agent ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Write-Host "creating agent-svc venv ..."
  & python -m venv (Join-Path $agent ".venv")
  & $venvPy -m pip install -q -r (Join-Path $agent "requirements.txt")
}

# --- ensure web deps ---------------------------------------------------------
$web = Join-Path $root "web"
if (-not $NoWeb -and -not (Test-Path (Join-Path $web "node_modules"))) {
  Write-Host "installing web deps ..."
  Push-Location $web; & pnpm install; Pop-Location
}

# --- launch ------------------------------------------------------------------
Start-Svc "conv-svc" (Join-Path $root "conv-svc\conv-svc.exe") @() (Join-Path $root "conv-svc")
Start-Svc "user-svc" (Join-Path $root "user-svc\user-svc.exe") @() (Join-Path $root "user-svc")
Start-Svc "agent-svc" $venvPy @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", $env:AGENT_SVC_PORT) (Join-Path $agent "src")
Start-Svc "gateway"  (Join-Path $root "gateway\gateway.exe") @() (Join-Path $root "gateway")
if (-not $NoWeb) { Start-Svc "web" "pnpm" @("dev") $web }

Write-Host ""
Write-Host "All services launching. agent-svc warms the embedding model at boot (~15-30s)."
Write-Host "Health:  curl http://localhost:8080/healthz"
Write-Host "E2E:     bash scripts/e2e.sh"
