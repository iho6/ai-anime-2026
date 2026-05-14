param(
  [string]$ApiHost = "127.0.0.1",
  [int]$ApiPort = 8000,
  [int]$FrontendPort = 3000,
  [string]$VenvDir = ".venv",
  [switch]$SkipPythonInstall,
  [ValidateSet("minimal", "full")]
  [string]$BootstrapMode = "minimal"
)

$ErrorActionPreference = "Stop"
$ScriptStart = Get-Date

function Get-ElapsedText {
  return ("+{0:hh\:mm\:ss}" -f ((Get-Date) - $ScriptStart))
}

function Write-MetaLog {
  param([string]$Message)
  Write-Host ("[meta] {0} {1}" -f (Get-ElapsedText), $Message)
}

$RepoRoot = $PSScriptRoot
$VenvPath = Join-Path $RepoRoot $VenvDir
$VenvPython = Join-Path $VenvPath "Scripts\python.exe"

$FrontendDir = Join-Path $RepoRoot "ui\frontend"
$RequirementsPy = Join-Path $RepoRoot "requirements.txt"

function Kill-ListenersOnPort {
  param([int]$Port)
  $pids = (& netstat.exe -ano 2>$null) |
    Select-String "LISTENING" |
    Where-Object { $_ -match ":$Port\s" } |
    ForEach-Object { ($_ -split '\s+')[-1] } |
    Where-Object { $_ -match '^\d+$' } |
    Sort-Object -Unique
  if (-not $pids) { return }
  Write-MetaLog "Port $Port in use; killing PID(s): $($pids -join ', ')"
  foreach ($id in $pids) {
    try { Stop-Process -Id ([int]$id) -Force -ErrorAction Stop } catch {}
  }
}

function Ensure-BootstrapPythonDeps {
  Write-MetaLog "Ensuring minimal Python deps (FastAPI/uvicorn) in venv..."
  & $VenvPython -m pip install --upgrade pip "setuptools<82" wheel
  # Keep this list small; must cover imports at API startup.
  # services.character_storage imports requests; FastAPI needs python-multipart for File/Form.
  & $VenvPython -m pip install fastapi "uvicorn[standard]" pydantic starlette requests python-multipart
  Write-MetaLog "Minimal deps installed"
}

function Ensure-NodeNpm {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($npm -and $node) { return }

  Write-MetaLog "npm/node not found; installing Node.js LTS via winget..."
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "npm/node not found and winget is unavailable. Install Node.js (LTS) and ensure npm is on PATH, then retry."
  }

  & $winget.Source install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install failed with exit code $LASTEXITCODE" }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not ($npm -and $node)) {
    throw "Node.js installed but npm/node not found on PATH in this session. Open a new terminal and re-run dev.ps1."
  }

  Write-MetaLog ("Node ready: {0}, npm {1}" -f (& node.exe --version), (& npm.cmd --version))
}

function Ensure-GitLfs {
  try {
    & git.exe lfs version *> $null
    if ($LASTEXITCODE -eq 0) { return }
  } catch {}

  Write-MetaLog "git-lfs not found; installing Git LFS via winget..."
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "git-lfs not found and winget is unavailable. Install Git LFS and retry."
  }

  & $winget.Source install -e --id GitHub.GitLFS --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install failed with exit code $LASTEXITCODE" }

  try {
    & git.exe lfs version *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "Git LFS installed but not found on PATH in this session. Open a new terminal and re-run dev.ps1."
    }
  } catch {
    throw "Git LFS installed but not usable in this session. Open a new terminal and re-run dev.ps1."
  }
}

function Resolve-PythonExe {
  try {
    $py = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
    if ($py) { return $py }
  } catch {}

  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# --- Kill stale listeners before doing anything ---
Kill-ListenersOnPort $ApiPort
Kill-ListenersOnPort $FrontendPort
Kill-ListenersOnPort 8188

# --- Python venv ---
$PythonExe = Resolve-PythonExe
if (-not $PythonExe) {
  throw "Python not found. Install Python and ensure `py` or `python` is on PATH."
}

if (-not (Test-Path $VenvPython)) {
  Write-MetaLog "Creating venv at: $VenvPath"
  & $PythonExe -m venv $VenvPath
  Write-MetaLog "Venv creation completed"
}

if (-not (Test-Path $VenvPython)) {
  throw "Failed to create venv python at: $VenvPython"
}

if ($SkipPythonInstall) {
  Write-MetaLog "Skipping Python package install (-SkipPythonInstall)"
} elseif ($BootstrapMode -eq "minimal") {
  Ensure-BootstrapPythonDeps
} else {
  Write-MetaLog "Upgrading pip tooling in venv..."
  & $VenvPython -m pip install --upgrade pip "setuptools<82" wheel

  Write-MetaLog "Installing Python requirements into venv..."
  & $VenvPython -m pip install -r $RequirementsPy
  Write-MetaLog "Python requirements installation completed"
}

# --- Git LFS (full bootstrap only) ---
Ensure-GitLfs
if ($BootstrapMode -eq "full") {
  Write-MetaLog "Fetching Git LFS assets (git lfs pull)..."
  Push-Location $RepoRoot
  try {
    & git.exe lfs install --local *> $null
    & git.exe lfs pull
    if ($LASTEXITCODE -ne 0) {
      throw "git lfs pull failed (auth required). Configure GitHub credentials for this repo, then rerun dev.ps1 or run: git lfs pull"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-MetaLog "Skipping git lfs pull (minimal mode). Run with -BootstrapMode full to fetch LFS assets."
}

# --- Frontend deps ---
Ensure-NodeNpm

if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
  Write-MetaLog "Installing frontend dependencies (npm install)..."
  Push-Location $FrontendDir
  try {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-MetaLog "Frontend dependency installation completed"
} else {
  Write-MetaLog "Frontend dependencies already present (node_modules exists)"
}

# --- Launch ---
Write-MetaLog "Starting backend: uvicorn on $ApiHost`:$ApiPort"
Write-MetaLog "Starting frontend: next dev on port $FrontendPort"

try {
  $backendCmd = "& `"$VenvPython`" -m uvicorn ui.api.main:app --host `"$ApiHost`" --port $ApiPort --ws-ping-interval 20 --ws-ping-timeout 600"

  $frontendCmd = "Set-Location -LiteralPath `"$FrontendDir`"; & npm.cmd run dev -- --port $FrontendPort"

  Write-MetaLog "Starting backend in new terminal..."
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $backendCmd) -WorkingDirectory $RepoRoot | Out-Null

  Write-MetaLog "Starting frontend in new terminal..."
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $frontendCmd) -WorkingDirectory $FrontendDir | Out-Null

  $FrontendUrl = "http://localhost:$FrontendPort"
  Write-MetaLog "Waiting for frontend then opening browser: $FrontendUrl"
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri $FrontendUrl -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        Start-Process $FrontendUrl | Out-Null
        Write-MetaLog "Browser opened"
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
} catch {
  Write-MetaLog ("Launcher error: {0}" -f $_.Exception.Message)
  exit 1
}

Write-MetaLog "Launcher finished"
exit 0
