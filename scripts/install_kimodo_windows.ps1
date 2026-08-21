# One-shot Windows installer for kimodo + MotionCorrection (.pyd).
# Prefers portable CMake/MinGW under H:\Animation\toolchains (or ANIME2026_TOOLCHAINS),
# else winget for CMake / VS Build Tools. Clones empty kimodo/ gitlink when needed,
# then editable-installs into the repo .venv.
#
# Usage (from repo root; approve UAC only if falling back to VS Build Tools):
#   powershell -ExecutionPolicy Bypass -File scripts\install_kimodo_windows.ps1
param(
  [switch]$SkipVenvActivate
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

$venvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Error "[kimodo] Missing $venvPython — create the venv first (Launch / setup)."
  exit 1
}

# Portable on-drive toolchain (no Program Files / UAC).
$toolchainCandidates = @()
if ($env:ANIME2026_TOOLCHAINS) { $toolchainCandidates += $env:ANIME2026_TOOLCHAINS }
$toolchainCandidates += (Join-Path (Split-Path -Parent $RepoRoot) "toolchains")
$toolchainCandidates += (Join-Path $RepoRoot "toolchains")
foreach ($tc in $toolchainCandidates) {
  $cmakeBin = Join-Path $tc "cmake\bin"
  $mingwBin = Join-Path $tc "mingw64\bin"
  $added = $false
  if (Test-Path (Join-Path $cmakeBin "cmake.exe")) {
    $env:PATH = "$cmakeBin;$env:PATH"
    $added = $true
  }
  if (Test-Path (Join-Path $mingwBin "g++.exe")) {
    $env:PATH = "$mingwBin;$env:PATH"
    $env:CMAKE_GENERATOR = "MinGW Makefiles"
    $added = $true
  }
  if ($added) {
    Write-Host "[kimodo] Using portable toolchain: $tc"
    break
  }
}

if (-not $SkipVenvActivate) {
  $activate = Join-Path $RepoRoot ".venv\Scripts\Activate.ps1"
  if (Test-Path -LiteralPath $activate) {
    Write-Host "[kimodo] Activating .venv…"
    . $activate
  }
}

$env:ANIME2026_FORCE_KIMODO_BUILD = "1"
Remove-Item Env:ANIME2026_SKIP_KIMODO -ErrorAction SilentlyContinue

Write-Host "[kimodo] Bootstrapping (FORCE=1) with $venvPython …"
& $venvPython (Join-Path $RepoRoot "utils\install_kimodo.py")
if ($LASTEXITCODE -ne 0) {
  Write-Error "[kimodo] Install failed (exit $LASTEXITCODE). Fix toolchain, then re-run with FORCE."
  exit $LASTEXITCODE
}

Write-Host "[kimodo] Done."
