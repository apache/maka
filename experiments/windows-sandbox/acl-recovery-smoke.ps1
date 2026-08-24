# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

param(
  [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$launcher = if ($LauncherPath) {
  $LauncherPath
} else {
  Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox.exe'
}
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$workRoot = Join-Path $tempRoot "maka-acl-recovery-$PID"
$ledgerRoot = Join-Path ([IO.Path]::GetTempPath()) 'maka-sandbox-acl-ledgers'
# findstr exits 0 on match and nonzero on denial, and takes plain argv — no
# cmd.exe quote-parsing pitfalls inside the AppContainer.
$findstrExe = Join-Path $env:SystemRoot 'System32\findstr.exe'
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

function Get-AppContainerSid {
  param([string]$RequestId)
  $sid = (& $launcher --appcontainer-sid $RequestId 2>&1) -join ''
  if ($LASTEXITCODE -ne 0 -or $sid -notmatch '^S-1-15-2-') {
    throw "Unable to resolve AppContainer SID for ${RequestId}: $sid"
  }
  return $sid
}
# A fake AppContainer-shaped SID nothing else uses: pre-existing ACEs that
# recovery and cleanup must leave untouched.
$markerSid = 'S-1-15-2-1999999999-1888888888-1777777777-1666666666-1555555555-1444444444-1333333333'

function New-LaunchRequest {
  param(
    [string]$Name,
    [string[]]$Arguments,
    [string[]]$ReadRoots,
    [string[]]$ExactReadRoots,
    [Nullable[int]]$TimeoutMs,
    [string]$Executable = $findstrExe
  )
  $request = [ordered]@{
    version = 1
    requestId = $Name
    executable = $Executable
    arguments = $Arguments
    cwd = $env:SystemRoot
    readRoots = $ReadRoots
    writeRoots = @()
    network = 'restricted'
    environment = @{}
  }
  if ($ExactReadRoots) { $request.exactReadRoots = $ExactReadRoots }
  if ($null -ne $TimeoutMs) { $request.timeoutMs = $TimeoutMs }
  $path = Join-Path $workRoot "$Name.json"
  $request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
  return $path
}

function Get-Acl-Text { param([string]$Path) (& icacls.exe $Path 2>&1) -join "`n" }

try {
  # --- Existing-ACE preservation + subtree vs exact grants -------------------
  $dataRoot = Join-Path $workRoot 'data'
  New-Item -ItemType Directory -Path $dataRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $dataRoot 'ok.txt') -Value 'subtree-read' -Encoding ascii
  & icacls.exe $dataRoot /grant "*$markerSid`:(OI)(CI)RX" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to seed marker ACE' }

  $subtree = New-LaunchRequest -Name 'subtree-read' `
    -Arguments @('/c:subtree-read', "$dataRoot\ok.txt") -ReadRoots @($dataRoot)
  $subtreeSid = Get-AppContainerSid 'subtree-read'
  & $launcher --appcontainer $subtree *> $null
  if ($LASTEXITCODE -ne 0) { throw "subtree read launch failed: exit=$LASTEXITCODE" }

  $exact = New-LaunchRequest -Name 'exact-read' `
    -Arguments @('/c:subtree-read', "$dataRoot\ok.txt") `
    -ReadRoots @($dataRoot) -ExactReadRoots @($dataRoot)
  $exactSid = Get-AppContainerSid 'exact-read'
  & $launcher --appcontainer $exact *> $null
  if ($LASTEXITCODE -eq 0) {
    throw 'exact-directory grant unexpectedly allowed reading a child file'
  }

  $dataAcl = Get-Acl-Text $dataRoot
  $childAcl = Get-Acl-Text (Join-Path $dataRoot 'ok.txt')
  if ($dataAcl -match [regex]::Escape($subtreeSid) -or
      $childAcl -match [regex]::Escape($subtreeSid) -or
      $dataAcl -match [regex]::Escape($exactSid) -or
      $childAcl -match [regex]::Escape($exactSid)) {
    throw "AppContainer grants were not removed after launch: $dataAcl"
  }
  if ($dataAcl -notmatch [regex]::Escape($markerSid) -or
      $childAcl -notmatch [regex]::Escape($markerSid)) {
    throw "Pre-existing marker ACE was destroyed by cleanup: $dataAcl"
  }

  # --- Concurrency: parallel launches on distinct roots ----------------------
  $jobs = @()
  $concurrentRoots = @()
  for ($index = 0; $index -lt 10; $index++) {
    $root = Join-Path $workRoot "concurrent-$index"
    New-Item -ItemType Directory -Path $root | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'ok.txt') -Value "concurrent-$index" -Encoding ascii
    $concurrentRoots += $root
    $requestPath = New-LaunchRequest -Name "concurrent-$index" `
      -Arguments @('/c:concurrent', "$root\ok.txt") -ReadRoots @($root) -TimeoutMs 120000
    $jobs += Start-Job -ScriptBlock {
      param($Launcher, $Request)
      $output = & $Launcher --appcontainer $Request 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join ' | ') }
    } -ArgumentList $launcher, $requestPath
  }
  $results = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job
  $failed = @($results | Where-Object { $_.ExitCode -ne 0 })
  if ($failed.Count -gt 0) {
    $detail = ($failed | ForEach-Object { "exit=$($_.ExitCode) output=$($_.Output)" }) -join "`n"
    throw "Concurrent launches failed:`n$detail"
  }
  foreach ($root in $concurrentRoots) {
    if ((Get-Acl-Text $root) -match 'S-1-15-2-') {
      throw "Concurrent launch left AppContainer grants on ${root}"
    }
  }
  $leftover = @(Get-ChildItem -LiteralPath $ledgerRoot -Filter '*.json' -ErrorAction SilentlyContinue)
  if ($leftover.Count -gt 0) {
    throw "Concurrent launches left ACL ledgers behind: $($leftover.Name -join ', ')"
  }

  # --- Killed-broker recovery ------------------------------------------------
  $staleRoot = Join-Path $workRoot 'kill-recovery'
  New-Item -ItemType Directory -Path $staleRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $staleRoot 'ok.txt') -Value 'kill-recovery' -Encoding ascii
  # The launcher's own --stdio-probe --sleep keeps the sandboxed child alive
  # without needing network or console features inside the AppContainer.
  $sleepRequest = New-LaunchRequest -Name 'kill-recovery' -Executable $launcher `
    -Arguments @('--stdio-probe', '--sleep', '50') -ReadRoots @($staleRoot) -TimeoutMs 120000
  $killRecoverySid = Get-AppContainerSid 'kill-recovery'
  $emptyStdin = Join-Path $workRoot 'empty-stdin.bin'
  [IO.File]::WriteAllBytes($emptyStdin, @())
  $broker = Start-Process -FilePath $launcher -ArgumentList @('--appcontainer', $sleepRequest) `
    -RedirectStandardInput $emptyStdin `
    -RedirectStandardOutput (Join-Path $workRoot 'kill-stdout.txt') `
    -RedirectStandardError (Join-Path $workRoot 'kill-stderr.txt') `
    -NoNewWindow -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline -and
         (Get-Acl-Text $staleRoot) -notmatch [regex]::Escape($killRecoverySid)) {
    Start-Sleep -Milliseconds 200
  }
  if ((Get-Acl-Text $staleRoot) -notmatch [regex]::Escape($killRecoverySid)) {
    Stop-Process -Id $broker.Id -Force -ErrorAction SilentlyContinue
    throw 'Killed-broker scenario never observed the AppContainer grant'
  }
  Stop-Process -Id $broker.Id -Force
  Wait-Process -Id $broker.Id -ErrorAction SilentlyContinue
  $staleLedgers = @(Get-ChildItem -LiteralPath $ledgerRoot -Filter '*.json' -ErrorAction SilentlyContinue)
  if ($staleLedgers.Count -eq 0) {
    throw 'Killing the broker mid-launch left no ledger to recover'
  }

  # The next launch must replay the stale ledger and remove the dead broker's
  # grants before establishing its own.
  $recovery = New-LaunchRequest -Name 'recovery' `
    -Arguments @('/c:subtree-read', "$dataRoot\ok.txt") -ReadRoots @($dataRoot)
  & $launcher --appcontainer $recovery *> $null
  if ($LASTEXITCODE -ne 0) { throw "Recovery launch failed: exit=$LASTEXITCODE" }
  if ((Get-Acl-Text $staleRoot) -match [regex]::Escape($killRecoverySid)) {
    throw 'Recovery did not remove the dead broker''s AppContainer grants'
  }
  $remaining = @(Get-ChildItem -LiteralPath $ledgerRoot -Filter '*.json' -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    throw "Recovery left ACL ledgers behind: $($remaining.Name -join ', ')"
  }

  Write-Host 'ACL recovery verified: ACE preservation, exact roots, 10-way concurrency, killed-broker replay'
} finally {
  & icacls.exe $workRoot /remove "*$markerSid" /T /L /Q 2>$null | Out-Null
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
