# Windows counterpart to perf-probe.mjs's powermetrics pipeline.
#
# powermetrics attributes CPU/GPU via coalitions because WKWebView's helpers
# reparent to launchd (PPID 1). WebView2's helpers (msedgewebview2.exe:
# browser/renderer/GPU/utility) stay real children of the exe on Windows, so
# there is no coalition-equivalent to reconstruct — a process-tree walk from
# the root pid(s) is the whole attribution story. That walk is redone every
# iteration (not just once up front) for the same reason perf-probe.mjs unions
# pids across the whole window rather than trusting one snapshot: a helper
# that hasn't spawned yet at the start of the window is still ours once it
# does.
#
# CPU comes from the "Process" perf-counter category: `% Processor Time` is
# already normalized so 100% == one core saturated, matching the "1000 ms/s =
# one core" convention perf-probe.mjs's report uses for macOS — so the ms/s
# figure here is `percent * 10`, computed on the Node side. Instances are
# matched to a pid via the companion "ID Process" counter (both counters come
# from the same "Process" category and enumerate instances in the same order).
#
# GPU comes from the "GPU Engine" perf-counter category, whose instance names
# encode the pid (`pid_1234_luid_..._engtype_3D`). A process's GPU load is the
# SUM of its engines (3D, Copy, VideoDecode, ...), which can read above 100%
# since each engine is its own queue — an approximation, not an exact
# powermetrics equivalent, but the same order of magnitude and the only thing
# Windows exposes per-process. The category doesn't exist on machines with no
# WDDM GPU driver loaded (e.g. some VMs/RDP sessions), so its absence is
# caught and reported as "gpu unavailable" rather than silently zeroed.
#
# DWM (Desktop Window Manager) is this app's WindowServer analog: Windows
# bills compositing to dwm.exe's own process, never to the app being
# composited, for the same reason macOS bills it to com.apple.WindowServer.
#
# Params:
#   -RootPids        comma-separated root pids (the app's own pid(s))
#   -Count            number of 1-second samples
#   -OutFile          where to write the JSON array

param(
  # Empty for the baseline scenario (app quit) — Mandatory alone treats an
  # empty string as "no value" and refuses to bind it, so AllowEmptyString is
  # required too.
  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RootPids,
  [Parameter(Mandatory = $true)][int]$Count,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
# Empty for the baseline scenario (app quit) — DWM (the compositor reading) is
# still sampled below regardless of whether there's a root pid to track.
#
# Named $parsedRoots, not $rootPids: PowerShell variable names are
# case-insensitive, so a local $rootPids IS the -RootPids parameter — an
# earlier version of this script assigned over its own input and silently
# tracked nothing every run.
$parsedRoots = @()
if ($RootPids -and $RootPids.Trim() -ne '') {
  $parsedRoots = $RootPids -split ',' | ForEach-Object { [int]$_ }
}

function Get-DescendantPids([int[]]$roots) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $tracked = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $roots) { [void]$tracked.Add($p) }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      $procId = [int]$p.ProcessId
      $ppid = [int]$p.ParentProcessId
      if ($tracked.Contains($ppid) -and -not $tracked.Contains($procId)) {
        [void]$tracked.Add($procId)
        $grew = $true
      }
    }
  }
  return @($tracked)
}

$results = @()

for ($i = 0; $i -lt $Count; $i++) {
  $tracked = Get-DescendantPids $parsedRoots
  $dwmProc = Get-Process -Name 'dwm' -ErrorAction SilentlyContinue | Select-Object -First 1
  $dwmPid = if ($dwmProc) { $dwmProc.Id } else { $null }

  $cpuOnlyPaths = @('\Process(*)\% Processor Time', '\Process(*)\ID Process')
  $gpuAvailable = $true
  try {
    $null = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop
  } catch {
    $gpuAvailable = $false
  }
  $counterPaths = if ($gpuAvailable) { $cpuOnlyPaths + '\GPU Engine(*)\Utilization Percentage' } else { $cpuOnlyPaths }

  # One call, one SampleInterval, so CPU/ID/GPU all describe the same second —
  # sampling them in separate calls would let the app's load drift between calls.
  # GPU Engine instances come and go as processes start/stop GPU work between
  # the availability probe above and this call, which Get-Counter surfaces as
  # a hard error for the WHOLE batch rather than a per-instance one — so a
  # transient failure here must not lose this interval's CPU reading either.
  # Retried a few times (CPU-only after the first failure) before giving up on
  # this one interval, since the same transient race can recur on a busy box.
  $sample = $null
  for ($attempt = 0; $attempt -lt 3 -and -not $sample; $attempt++) {
    try {
      $sample = Get-Counter -Counter $counterPaths -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
    } catch {
      $gpuAvailable = $false
      $counterPaths = $cpuOnlyPaths
      if ($attempt -eq 2) {
        Write-Warning "Skipping one sample interval after repeated Get-Counter failures: $($_.Exception.Message)"
      }
    }
  }
  if (-not $sample) {
    # Still bill this second of elapsed time so the overall window length
    # matches -Count, just with a zeroed reading instead of losing the sample.
    $results += [ordered]@{ tracked = $tracked; processes = @(); dwm = $null; gpuAvailable = $false }
    Start-Sleep -Seconds 1
    continue
  }

  $cpuByInstance = @{}
  $idByInstance = @{}
  $gpuByPid = @{}
  foreach ($cs in $sample.CounterSamples) {
    if ($cs.Path -like '*% Processor Time*') {
      $cpuByInstance[$cs.InstanceName] = $cs.CookedValue
    } elseif ($cs.Path -like '*ID Process*') {
      $idByInstance[$cs.InstanceName] = [int]$cs.CookedValue
    } elseif ($cs.Path -like '*GPU Engine*') {
      if ($cs.InstanceName -match 'pid_(\d+)_') {
        $p = [int]$Matches[1]
        if (-not $gpuByPid.ContainsKey($p)) { $gpuByPid[$p] = 0.0 }
        $gpuByPid[$p] += $cs.CookedValue
      }
    }
  }

  $cpuByPid = @{}
  foreach ($instance in $cpuByInstance.Keys) {
    if ($idByInstance.ContainsKey($instance)) {
      $cpuByPid[$idByInstance[$instance]] = $cpuByInstance[$instance]
    }
  }

  $trackedSet = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $tracked) { [void]$trackedSet.Add($p) }

  $procRows = @()
  foreach ($p in $tracked) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $procRows += [ordered]@{
      pid        = $p
      name       = $proc.ProcessName
      cpuPercent = if ($cpuByPid.ContainsKey($p)) { $cpuByPid[$p] } else { 0.0 }
      gpuPercent = if ($gpuByPid.ContainsKey($p)) { $gpuByPid[$p] } else { 0.0 }
      workingSet = $proc.WorkingSet64
    }
  }

  $dwmRow = $null
  if ($dwmPid) {
    $dwmProcLive = Get-Process -Id $dwmPid -ErrorAction SilentlyContinue
    if ($dwmProcLive) {
      $dwmRow = [ordered]@{
        cpuPercent = if ($cpuByPid.ContainsKey($dwmPid)) { $cpuByPid[$dwmPid] } else { 0.0 }
        gpuPercent = if ($gpuByPid.ContainsKey($dwmPid)) { $gpuByPid[$dwmPid] } else { 0.0 }
      }
    }
  }

  $results += [ordered]@{
    tracked      = $tracked
    processes    = $procRows
    dwm          = $dwmRow
    gpuAvailable = $gpuAvailable
  }
}

$results | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $OutFile -Encoding utf8
