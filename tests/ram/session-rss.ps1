# Measure peak RSS of one real `dsh-cli` turn, including its runtime child.
#
# The CLI itself is a thin Node process; the DSH SDK runtime it spawns is the
# expensive part. This measures the whole tree so the number is honest rather
# than the CLI-only figure from `npm run ram:check`.
#
# Usage:
#   pwsh -File tests/ram/session-rss.ps1 [-Prompt "Reply with exactly: PONG"]

param(
  [string]$Prompt = 'Reply with exactly: PONG',
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entry = Join-Path $root 'src/main.js'
$mib = 1MB

function Get-TreeProcesses([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($rootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId)
        $changed = $true
      }
    }
  }
  return @($ids)
}

$stdout = New-TemporaryFile
$stderr = New-TemporaryFile
$proc = Start-Process -FilePath node `
  -ArgumentList @($entry, 'run', $Prompt, '--timeout', '120s') `
  -WorkingDirectory $root -PassThru -NoNewWindow `
  -RedirectStandardOutput $stdout.FullName -RedirectStandardError $stderr.FullName

$rootPid = [int]$proc.Id
$peakTree = 0
$peakChild = 0
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
  $ids = Get-TreeProcesses $rootPid
  $treeTotal = 0
  $childTotal = 0
  foreach ($id in $ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $p) { continue }
    $treeTotal += $p.WorkingSet64
    if ($id -ne $rootPid) { $childTotal += $p.WorkingSet64 }
  }
  if ($treeTotal -gt $peakTree) { $peakTree = $treeTotal }
  if ($childTotal -gt $peakChild) { $peakChild = $childTotal }
  Start-Sleep -Milliseconds 150
}
$sw.Stop()

if (-not $proc.HasExited) {
  $proc.Kill()
  Write-Warning 'the turn exceeded the measurement window; numbers are a lower bound'
} else {
  $proc.WaitForExit()
}

$answer = (Get-Content $stdout.FullName -Raw -ErrorAction SilentlyContinue)
$diagnostics = (Get-Content $stderr.FullName -Raw -ErrorAction SilentlyContinue)
Remove-Item $stdout.FullName, $stderr.FullName -ErrorAction SilentlyContinue

[pscustomobject]@{
  exitCode         = $proc.ExitCode
  elapsedSeconds   = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  peakTreeRssMiB   = [math]::Round($peakTree / $mib, 1)
  peakChildRssMiB  = [math]::Round($peakChild / $mib, 1)
  answer           = ($answer ?? '').Trim()
  stderr           = ($diagnostics ?? '').Trim()
} | ConvertTo-Json
