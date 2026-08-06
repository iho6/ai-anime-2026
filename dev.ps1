param(
  [string]$ApiHost = "127.0.0.1",
  [int]$ApiPort = 8000,
  [int]$FrontendPort = 3000,
  [string]$VenvDir = ".venv",
  [switch]$SkipPythonInstall,
  [switch]$KillPorts,
  [switch]$ForcePipInstall,
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
# Sibling on the same drive as the repo (Seagate portable layout).
$OnDrivePythonDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "..\python311"))
$OnDrivePythonExe = Join-Path $OnDrivePythonDir "python.exe"

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

# Bump when expanding the minimal set so existing envs refresh once (v1 lacked numpy/Pillow).
$PipSentinel = Join-Path $VenvPath ".pip-minimal-ok.v2"

function Ensure-BootstrapPythonDeps {
  if ((Test-Path $PipSentinel) -and -not $ForcePipInstall) {
    Write-MetaLog "Minimal deps sentinel present - skipping pip (use -ForcePipInstall to refresh)"
    return
  }
  Write-MetaLog "Ensuring minimal Python deps for ui.api.main cold start..."
  & $VenvPython -m pip install pip "setuptools<82" wheel
  # Keep this list small; must cover ui.api.main import-time deps (not full Comfy/GPU stack).
  # requests: character_storage; python-multipart: FastAPI File/Form;
  # numpy: services.clip_coloring; Pillow: utils.image_utils via utils package init.
  & $VenvPython -m pip install fastapi "uvicorn[standard]" pydantic starlette requests python-multipart "numpy>=1.25.0" Pillow
  $null | Out-File $PipSentinel -Encoding utf8
  Write-MetaLog "Minimal deps installed"
}

function Refresh-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-WingetUserPackage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageId
  )

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { return $false }

  # Prefer per-user installs to avoid UAC/admin prompts.
  & $winget.Source install -e --id $PackageId --scope user --accept-package-agreements --accept-source-agreements
  Refresh-SessionPath
  return $true
}

function Test-NodeNpmReady {
  Refresh-SessionPath
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  return [bool]($npm -and $node)
}

function Ensure-NodeNpm {
  if (Test-NodeNpmReady) { return }

  Write-MetaLog "npm/node not found; installing Node.js LTS via winget (user scope)..."
  if (-not (Install-WingetUserPackage -PackageId "OpenJS.NodeJS.LTS")) {
    throw "npm/node not found and winget is unavailable. Install Node.js (LTS) and ensure npm is on PATH, then retry."
  }

  if (-not (Test-NodeNpmReady)) {
    throw "Node.js installed but npm/node not found on PATH in this session. Open a new terminal and re-run dev.ps1."
  }

  Write-MetaLog ("Node ready: {0}, npm {1}" -f (& node.exe --version), (& npm.cmd --version))
}

function Test-GitLfsReady {
  Refresh-SessionPath
  try {
    & git.exe lfs version *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Ensure-GitSafeDirectory {
  # Portable HDD / another Windows user: Git blocks the checkout until the path
  # is listed in safe.directory (user global config; no admin required).
  Refresh-SessionPath
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { return }

  $safePath = ((Resolve-Path -LiteralPath $RepoRoot).Path) -replace '\\', '/'
  $listed = @()
  try {
    $listed = & git.exe config --global --get-all safe.directory 2>$null
  } catch {}
  if ($listed -contains $safePath) { return }

  Write-MetaLog "Adding git safe.directory for portable checkout: $safePath"
  & git.exe config --global --add safe.directory $safePath
  if ($LASTEXITCODE -ne 0) {
    Write-MetaLog "Warning: could not add git safe.directory (git exit $LASTEXITCODE)"
  }
}

function Ensure-GitLfs {
  # Modern Git for Windows already ships git-lfs; refresh PATH in case a prior
  # winget install updated User PATH but this shell still has the old value.
  if (Test-GitLfsReady) { return }

  Write-MetaLog "git-lfs not found; installing Git for Windows (includes Git LFS) via winget (user scope)..."
  if (-not (Install-WingetUserPackage -PackageId "Git.Git")) {
    throw "git-lfs not found and winget is unavailable. Install Git for Windows (or Git LFS) and retry."
  }

  # Do not fall back to GitHub.GitLFS: its silent installer aborts when Git is
  # under the per-user path (AppData\Local\Programs\Git).
  if (Test-GitLfsReady) { return }

  throw "Git LFS is not usable in this session. Open a new terminal and re-run dev.ps1 (or install Git for Windows manually)."
}

function Get-OnDrivePythonExe {
  if ($env:ANIME2026_PYTHON -and (Test-Path -LiteralPath $env:ANIME2026_PYTHON)) {
    return (Resolve-Path -LiteralPath $env:ANIME2026_PYTHON).Path
  }
  if (Test-Path -LiteralPath $OnDrivePythonExe) {
    return (Resolve-Path -LiteralPath $OnDrivePythonExe).Path
  }
  return $null
}

function Resolve-PythonExe {
  # Prefer Seagate-local CPython so .venv can travel with the drive.
  $onDrive = Get-OnDrivePythonExe
  if ($onDrive) { return $onDrive }

  try {
    $py = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
    if ($py) { return $py }
  } catch {}

  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notmatch 'WindowsApps\\python\.exe$') {
    return $cmd.Source
  }
  return $null
}

function Read-PyvenvCfg {
  param([Parameter(Mandatory = $true)][string]$CfgPath)
  $cfg = @{
    Home = $null
    Executable = $null
    Command = $null
    Lines = @()
  }
  if (-not (Test-Path -LiteralPath $CfgPath)) { return $cfg }
  $cfg.Lines = @(Get-Content -LiteralPath $CfgPath)
  foreach ($line in $cfg.Lines) {
    if ($line -match '^\s*home\s*=\s*(.+)\s*$') { $cfg.Home = $Matches[1].Trim() }
    elseif ($line -match '^\s*executable\s*=\s*(.+)\s*$') { $cfg.Executable = $Matches[1].Trim() }
    elseif ($line -match '^\s*command\s*=\s*(.+)\s*$') { $cfg.Command = $Matches[1].Trim() }
  }
  return $cfg
}

function Test-VenvPythonProbe {
  try {
    & $VenvPython -c "import sys; raise SystemExit(0 if sys.prefix else 1)" *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Repair-VenvDrivePaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BasePython
  )
  # Rewrite pyvenv.cfg home/executable/command onto the current on-drive (or host)
  # interpreter and current repo path. Keeps site-packages; does not wipe .venv.
  $cfgPath = Join-Path $VenvPath "pyvenv.cfg"
  if (-not (Test-Path -LiteralPath $cfgPath)) { return $false }
  if (-not (Test-Path -LiteralPath $VenvPython)) { return $false }
  if (-not (Test-Path -LiteralPath $BasePython)) { return $false }

  $baseResolved = (Resolve-Path -LiteralPath $BasePython).Path
  $baseHome = Split-Path -Parent $baseResolved
  $venvResolved = (Resolve-Path -LiteralPath $VenvPath).Path
  $cfg = Read-PyvenvCfg -CfgPath $cfgPath

  $needsRewrite = $false
  if (-not $cfg.Home -or -not (Test-Path -LiteralPath $cfg.Home)) { $needsRewrite = $true }
  elseif ((Resolve-Path -LiteralPath $cfg.Home).Path -ne (Resolve-Path -LiteralPath $baseHome).Path) {
    $needsRewrite = $true
  }
  if ($cfg.Executable -and -not (Test-Path -LiteralPath $cfg.Executable)) { $needsRewrite = $true }
  if (-not (Test-VenvPythonProbe)) { $needsRewrite = $true }
  if (-not $needsRewrite) { return $true }

  Write-MetaLog "Repairing pyvenv.cfg to base: $baseResolved (keep packages)"
  $newLines = @()
  $sawHome = $false
  $sawExe = $false
  $sawCmd = $false
  foreach ($line in $cfg.Lines) {
    if ($line -match '^\s*home\s*=') {
      $newLines += "home = $baseHome"
      $sawHome = $true
    } elseif ($line -match '^\s*executable\s*=') {
      $newLines += "executable = $baseResolved"
      $sawExe = $true
    } elseif ($line -match '^\s*command\s*=') {
      $newLines += "command = $baseResolved -m venv $venvResolved"
      $sawCmd = $true
    } else {
      $newLines += $line
    }
  }
  if (-not $sawHome) { $newLines = @("home = $baseHome") + $newLines }
  if (-not $sawExe) { $newLines += "executable = $baseResolved" }
  if (-not $sawCmd) { $newLines += "command = $baseResolved -m venv $venvResolved" }
  Set-Content -LiteralPath $cfgPath -Value $newLines -Encoding ascii

  if (Test-VenvPythonProbe) {
    Write-MetaLog "Venv probe OK after path repair"
    return $true
  }
  Write-MetaLog "Venv probe still failing after path repair"
  return $false
}

function Get-VenvNotReadyReason {
  # Returns $null when the venv is usable on this machine; otherwise a short reason.
  # Missing host ``home`` alone is not fatal when Repair-VenvDrivePaths can relink.
  $cfgPath = Join-Path $VenvPath "pyvenv.cfg"
  if (-not (Test-Path $VenvPython)) { return "venv python missing: $VenvPython" }
  if (-not (Test-Path $cfgPath)) { return "pyvenv.cfg missing" }

  if (Test-VenvPythonProbe) { return $null }

  $cfg = Read-PyvenvCfg -CfgPath $cfgPath
  if ($cfg.Home -and -not (Test-Path -LiteralPath $cfg.Home)) {
    return "pyvenv.cfg home not found: $($cfg.Home)"
  }
  if ($cfg.Executable -and -not (Test-Path -LiteralPath $cfg.Executable)) {
    return "pyvenv.cfg executable not found: $($cfg.Executable)"
  }
  return "venv python probe failed"
}

function Test-VenvReady {
  return ($null -eq (Get-VenvNotReadyReason))
}

function Ensure-Venv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostPython
  )

  if (Test-VenvReady) { return }

  # Prefer relocating an existing .venv onto the current base Python (portable HDD).
  if ((Test-Path -LiteralPath $VenvPath) -and (Test-Path -LiteralPath $VenvPython)) {
    $reason = Get-VenvNotReadyReason
    Write-MetaLog "Venv not ready ($reason); attempting path repair…"
    if (Repair-VenvDrivePaths -BasePython $HostPython) {
      if (Test-VenvReady) { return }
    }
  }

  if (Test-Path -LiteralPath $VenvPath) {
    Write-MetaLog "Venv irreparable; recreating at: $VenvPath"
    Remove-Item -LiteralPath $VenvPath -Recurse -Force
  } else {
    Write-MetaLog "Creating venv at: $VenvPath"
  }

  Remove-Item -Path $PipSentinel -ErrorAction SilentlyContinue
  & $HostPython -m venv $VenvPath

  # Ensure cfg points at the base we just used (important when base is on-drive).
  $null = Repair-VenvDrivePaths -BasePython $HostPython

  $after = Get-VenvNotReadyReason
  if ($after) {
    throw "Failed to create usable venv at: $VenvPath ($after)"
  }
  Write-MetaLog "Venv creation completed"
}

# --- Kill stale listeners (opt-in: -KillPorts) ---
if ($KillPorts) {
  Kill-ListenersOnPort $ApiPort
  Kill-ListenersOnPort $FrontendPort
  Kill-ListenersOnPort 8188
}

# --- Python venv ---
$PythonExe = Resolve-PythonExe
if (-not $PythonExe) {
  throw @"
Python not found for portable bootstrap.

Install CPython 3.11 onto the Seagate next to this repo (recommended):
  TargetDir = $OnDrivePythonDir
  Official installer: https://www.python.org/downloads/release/python-3119/
  Quiet example:
    python-3.11.9-amd64.exe /quiet TargetDir=`"$OnDrivePythonDir`" InstallAllUsers=0 PrependPath=0 Include_pip=1 Include_launcher=0 Include_test=0 Shortcuts=0

Or set ANIME2026_PYTHON to a python.exe on this drive, or install host Python 3.11 and ensure ``py -3.11`` / ``python`` is on PATH.
"@
}

if ($PythonExe -like "$OnDrivePythonDir*") {
  Write-MetaLog "Using on-drive Python: $PythonExe"
} else {
  Write-MetaLog "Using host Python (prefer $OnDrivePythonExe for portable Seagate setups): $PythonExe"
}

Ensure-Venv -HostPython $PythonExe

if ($SkipPythonInstall) {
  Write-MetaLog "Skipping Python package install (-SkipPythonInstall)"
} elseif ($BootstrapMode -eq "minimal") {
  Ensure-BootstrapPythonDeps
} else {
  Write-MetaLog "Upgrading pip tooling in venv..."
  & $VenvPython -m pip install --upgrade pip "setuptools<82" wheel

  Write-MetaLog "Installing/refreshing PyTorch stack (ANIME2026_TORCH_PROFILE)…"
  & $VenvPython -c "from services.pytorch_setup import ensure_pytorch_stack; ensure_pytorch_stack()"

  Write-MetaLog "Installing Python requirements into venv..."
  & $VenvPython -m pip install -r $RequirementsPy
  Write-MetaLog "Python requirements installation completed"
}

# --- Git LFS (full bootstrap only) ---
Ensure-GitLfs
Ensure-GitSafeDirectory
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
