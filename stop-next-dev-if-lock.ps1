param(
    [string]$FrontendDir = ""
)

$ErrorActionPreference = "Stop"

function Test-CommandLineLooksLikeThisNext {
    param([string]$CommandLine, [string]$ResolvedFrontend)
    if (-not $CommandLine) { return $false }
    $norm = $CommandLine.ToLowerInvariant()
    $fp = $ResolvedFrontend.ToLowerInvariant().Replace("/", "\")
    if (-not $norm.Contains($fp)) { return $false }
    return ($norm -match "node_modules[\\/]next" -or $norm -match "next[\\/]dist[\\/]server[\\/]lib[\\/]start-server" -or $norm -match "\bnext\b.*\bdev\b")
}

function Test-CmdNextDev {
    param([string]$CommandLine)
    return ($CommandLine -and ($CommandLine -match "\bnext\s+dev\b"))
}

function Test-NpxNextDev {
    param([string]$CommandLine, [string]$Name)
    return ($Name -eq "node.exe" -and $CommandLine -and ($CommandLine -match "npx|npm") -and ($CommandLine -match "\bnext\s+dev\b"))
}

$RepoRoot = $PSScriptRoot
if (-not $FrontendDir) {
    $FrontendDir = Join-Path $RepoRoot "ui\frontend"
}

if (-not (Test-Path -LiteralPath $FrontendDir)) {
    Write-Host "[dev:stop-lock] Frontend directory not found: $FrontendDir"
    exit 1
}

$ResolvedFrontend = (Resolve-Path -LiteralPath $FrontendDir).Path
$lockPath = Join-Path $ResolvedFrontend ".next\dev\lock"
$listenPid = $null
if (Test-Path -LiteralPath $lockPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($lockPath)
        $lockObj = $raw | ConvertFrom-Json
        $listenPid = [int]$lockObj.pid
    }
    catch {
        Write-Host "[dev:stop-lock] Could not read lock file (will match processes by path): $($_.Exception.Message)"
    }
}

$pidsToStop = [System.Collections.Generic.List[int]]::new()

function Add-ChainFromPid {
    param([int]$StartPid)
    $current = $StartPid
    for ($i = 0; $i -lt 12; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $cl = $p.CommandLine
        if (Test-CommandLineLooksLikeThisNext -CommandLine $cl -ResolvedFrontend $ResolvedFrontend) {
            if (-not $pidsToStop.Contains($p.ProcessId)) { $pidsToStop.Add($p.ProcessId) | Out-Null }
        }
        elseif ($p.Name -eq "cmd.exe" -and (Test-CmdNextDev -CommandLine $cl)) {
            if (-not $pidsToStop.Contains($p.ProcessId)) { $pidsToStop.Add($p.ProcessId) | Out-Null }
        }
        else {
            break
        }
        $ppid = [int]$p.ParentProcessId
        if ($ppid -le 0 -or $ppid -eq $p.ProcessId) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ppid" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        $pcl = $parent.CommandLine
        if (Test-CommandLineLooksLikeThisNext -CommandLine $pcl -ResolvedFrontend $ResolvedFrontend) {
            if (-not $pidsToStop.Contains($parent.ProcessId)) { $pidsToStop.Add($parent.ProcessId) | Out-Null }
        }
        elseif (Test-NpxNextDev -CommandLine $pcl -Name $parent.Name) {
            if (-not $pidsToStop.Contains($parent.ProcessId)) { $pidsToStop.Add($parent.ProcessId) | Out-Null }
        }
        else {
            break
        }
        $current = $parent.ProcessId
    }
}

if ($null -ne $listenPid -and $listenPid -gt 0) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $listenPid" -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "[dev:stop-lock] Lock references PID $listenPid but process is gone (stale lock). Removing lock."
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        exit 0
    }
    if (-not (Test-CommandLineLooksLikeThisNext -CommandLine $proc.CommandLine -ResolvedFrontend $ResolvedFrontend)) {
        if (-not ($proc.Name -eq "node.exe" -and $proc.CommandLine -match "start-server")) {
            Write-Host "[dev:stop-lock] Lock PID $listenPid does not match this project Next.js (command line check). Not stopping."
            Write-Host $proc.CommandLine
            exit 1
        }
    }
    Add-ChainFromPid -StartPid $listenPid
}

if ($pidsToStop.Count -eq 0) {
    Write-Host "[dev:stop-lock] Scanning processes for Next.js under this project..."
    $fpLower = $ResolvedFrontend.ToLowerInvariant().Replace("/", "\")
    $candidates = Get-CimInstance Win32_Process | Where-Object {
        $cl = $_.CommandLine
        if (-not $cl) { return $false }
        $n = $cl.ToLowerInvariant().Replace("/", "\")
        if (-not $n.Contains($fpLower)) { return $false }
        return ($n -match "start-server\.js" -or $n -match "next[\\/]dist[\\/]server[\\/]lib[\\/]start-server" -or $n -match "\bnext\s+dev\b")
    }
    if (@($candidates).Count -eq 0) {
        Write-Host "[dev:stop-lock] No running Next.js dev processes found for: $ResolvedFrontend"
        if (Test-Path -LiteralPath $lockPath) {
            try {
                Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
                Write-Host "[dev:stop-lock] Removed stale lock file."
            }
            catch {
                # lock may be held; ignore
            }
        }
        exit 0
    }
    foreach ($c in $candidates) {
        Add-ChainFromPid -StartPid ([int]$c.ProcessId)
    }
}

if ($pidsToStop.Count -eq 0) {
    Write-Host "[dev:stop-lock] Nothing to stop."
    exit 0
}

for ($i = $pidsToStop.Count - 1; $i -ge 0; $i--) {
    $id = $pidsToStop[$i]
    try {
        Stop-Process -Id $id -Force -ErrorAction Stop
        Write-Host "[dev:stop-lock] Stopped PID $id"
    }
    catch {
        Write-Host "[dev:stop-lock] Could not stop PID ${id}: $($_.Exception.Message)"
    }
}

Write-Host "[dev:stop-lock] Done. You can run npm run dev again."
exit 0
