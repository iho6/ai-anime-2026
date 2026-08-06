# Install CPython 3.11 onto the Seagate next to this repo (sibling python311/).
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\install_portable_python.ps1
param(
  [string]$Version = "3.11.9",
  [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $TargetDir) {
  $TargetDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "..\python311"))
}

$exeName = "python-$Version-amd64.exe"
$url = "https://www.python.org/ftp/python/$Version/$exeName"
$installer = Join-Path $env:TEMP $exeName

Write-Host "[portable-python] TargetDir = $TargetDir"
if (Test-Path -LiteralPath (Join-Path $TargetDir "python.exe")) {
  Write-Host "[portable-python] Already installed: $(Join-Path $TargetDir 'python.exe')"
  & (Join-Path $TargetDir "python.exe") --version
  exit 0
}

Write-Host "[portable-python] Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing

Write-Host "[portable-python] Installing (quiet)…"
$args = @(
  "/quiet",
  "TargetDir=$TargetDir",
  "InstallAllUsers=0",
  "PrependPath=0",
  "Include_launcher=0",
  "Include_test=0",
  "Include_doc=0",
  "Include_pip=1",
  "Shortcuts=0",
  "AssociateFiles=0"
)
$p = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
if ($p.ExitCode -ne 0) {
  throw "Python installer failed with exit code $($p.ExitCode)"
}

$py = Join-Path $TargetDir "python.exe"
if (-not (Test-Path -LiteralPath $py)) {
  throw "Installer finished but python.exe missing at $py"
}

Write-Host "[portable-python] Ensuring pip…"
& $py -m ensurepip --upgrade
& $py -m pip install --upgrade pip "setuptools<82" wheel
& $py --version
Write-Host "[portable-python] Done. Prefer this interpreter via dev.ps1 (auto) or ANIME2026_PYTHON=$py"
