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
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$launcher = (Resolve-Path -LiteralPath $LauncherPath).Path
$launcherDirectory = Split-Path -Parent $launcher
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$workRoot = Join-Path $tempRoot "maka-phase4-adversarial-$PID"
$ledgerRoot = Join-Path ([IO.Path]::GetTempPath()) 'maka-sandbox-acl-ledgers'
$registrySubkey = "Software\Maka\SandboxPhase4\$PID"
$registryPath = "HKCU:\$registrySubkey"
$registryValueName = 'HostSecret'
$pipeShortName = "maka-phase4-host-$PID"
$pipeName = "\\.\pipe\$pipeShortName"
$hostSecretName = 'MAKA_PHASE4_HOST_SECRET'
$listener = $null
$pipe = $null
$quarantinedSid = $null
$quarantineRoot = $null
$quarantinePath = $null

function Write-LaunchRequest {
  param(
    [string]$Name,
    [string[]]$Arguments,
    [string[]]$ReadRoots,
    [string[]]$WriteRoots,
    [string[]]$ExactReadRoots,
    [string[]]$ExactWriteRoots
  )
  $request = [ordered]@{
    version = 1
    requestId = $Name
    executable = $launcher
    arguments = $Arguments
    cwd = Split-Path -Parent $launcher
    readRoots = $ReadRoots
    writeRoots = $WriteRoots
    exactReadRoots = $ExactReadRoots
    exactWriteRoots = $ExactWriteRoots
    network = 'restricted'
    environment = @{ MAKA_PHASE4_ALLOWED = 'allowed' }
    timeoutMs = 120000
  }
  $path = Join-Path $workRoot "$Name.json"
  $requestJson = $request | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($path, $requestJson, [Text.UTF8Encoding]::new($false))
  return $path
}

function Invoke-ExpectedAdmissionFailure {
  param(
    [string]$RequestPath,
    [string]$Pattern,
    [string]$Description
  )
  $result = Invoke-Launcher @('--appcontainer', $RequestPath)
  $output = $result.Output
  $exitCode = $result.ExitCode
  $rendered = $output -join "`n"
  if ($exitCode -eq 0 -or $rendered -notmatch $Pattern) {
    throw "$Description did not fail closed: exit=$exitCode output=$rendered"
  }
  $global:LASTEXITCODE = 0
}

function Invoke-Launcher {
  param([string[]]$Arguments)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $launcher @Arguments 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = @($output)
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-AppContainerSid {
  param([string]$RequestId)
  $sid = (& $launcher --appcontainer-sid $RequestId 2>&1) -join ''
  if ($LASTEXITCODE -ne 0 -or $sid -notmatch '^S-1-15-2-') {
    throw "Unable to resolve AppContainer SID for ${RequestId}: $sid"
  }
  return $sid
}

function Get-Sha256Hex {
  param([string]$Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) | ForEach-Object {
      $_.ToString('x2')
    })
  } finally {
    $sha.Dispose()
  }
}

function Get-AclText {
  param([string]$Path)
  return (& icacls.exe $Path 2>&1) -join "`n"
}

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ledgerRoot -Force | Out-Null

try {
  $outsideRoot = Join-Path $workRoot 'outside'
  $allowedRoot = Join-Path $workRoot 'allowed'
  New-Item -ItemType Directory -Path $outsideRoot, $allowedRoot | Out-Null
  $deniedPath = Join-Path $outsideRoot 'host-secret.txt'
  $allowedReadPath = Join-Path $allowedRoot 'read.txt'
  $allowedWritePath = Join-Path $allowedRoot 'write.txt'
  [IO.File]::WriteAllText($deniedPath, 'must-not-be-readable')
  [IO.File]::WriteAllText($allowedReadPath, 'allowed-read')
  [IO.File]::WriteAllText($allowedWritePath, 'seeded')

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $pipe = [IO.Pipes.NamedPipeServerStream]::new(
    $pipeShortName,
    [IO.Pipes.PipeDirection]::InOut,
    1,
    [IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous
  )
  New-Item -Path $registryPath -Force | Out-Null
  Set-ItemProperty -Path $registryPath -Name $registryValueName -Value 'registry-secret'
  [Environment]::SetEnvironmentVariable($hostSecretName, 'environment-secret', 'Process')

  $probeInputPath = Join-Path $allowedRoot 'adversarial-probe.json'
  $probeJson = [ordered]@{
    deniedPath = $deniedPath
    allowedReadPath = $allowedReadPath
    allowedWritePath = $allowedWritePath
    loopbackPort = $port
    pipeName = $pipeName
    environmentSecretName = $hostSecretName
    registrySubkey = $registrySubkey
    registryValueName = $registryValueName
    parentPid = $PID
  } | ConvertTo-Json
  [IO.File]::WriteAllText($probeInputPath, $probeJson, [Text.UTF8Encoding]::new($false))

  $probeRequest = Write-LaunchRequest -Name "phase4-adversarial-$PID" `
    -Arguments @('--adversarial-probe', $probeInputPath) `
    -ReadRoots @($probeInputPath, $allowedReadPath, $launcherDirectory) `
    -WriteRoots @($allowedWritePath) `
    -ExactReadRoots @($probeInputPath, $allowedReadPath) `
    -ExactWriteRoots @($allowedWritePath)
  $result = Invoke-Launcher @('--appcontainer', $probeRequest)
  $output = $result.Output
  $exitCode = $result.ExitCode
  $rendered = $output -join "`n"
  $requiredEvidence = @(
    '"fileDenied":true',
    '"allowedRead":true',
    '"allowedWrite":true',
    '"tcpDenied":true',
    '"namedPipeDenied":true',
    '"environmentDenied":true',
    '"registryDenied":true',
    '"parentTokenDenied":true',
    '"descendantAppContainer":true',
    '"descendantInJob":true'
  )
  $missingEvidence = @($requiredEvidence | Where-Object { $rendered -notmatch [regex]::Escape($_) })
  $descendantEvidence =
    $rendered -match '"descendantSpawnDenied":true' -or
    ($rendered -match '"descendantAppContainer":true' -and
      $rendered -match '"descendantInJob":true')
  if (-not $descendantEvidence) {
    $missingEvidence += 'descendantSpawnDenied or descendantAppContainer+descendantInJob'
  }
  $missingEvidence = @($missingEvidence | Where-Object {
    $_ -notin @('"descendantAppContainer":true', '"descendantInJob":true')
  })
  if ($exitCode -ne 0 -or $missingEvidence.Count -gt 0) {
    throw "Packaged adversarial probe failed: exit=$exitCode missing=$($missingEvidence -join ', ') output=$rendered"
  }

  # Recursive roots fail admission when any entry redirects to another tree.
  $junctionRoot = Join-Path $workRoot 'junction-root'
  New-Item -ItemType Directory -Path $junctionRoot | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $junctionRoot 'escape') -Target $outsideRoot | Out-Null
  $junctionRequest = Write-LaunchRequest -Name "phase4-junction-$PID" `
    -Arguments @('--self-probe') -ReadRoots @($junctionRoot) -WriteRoots @() `
    -ExactReadRoots @() -ExactWriteRoots @()
  Invoke-ExpectedAdmissionFailure -RequestPath $junctionRequest -Pattern 'reparse point' `
    -Description 'Junction alias admission'

  # Recursive roots also reject a file whose content is reachable through a
  # second hard-link name outside the admitted tree.
  $hardLinkRoot = Join-Path $workRoot 'hardlink-root'
  New-Item -ItemType Directory -Path $hardLinkRoot | Out-Null
  $hardLinkOutside = Join-Path $outsideRoot 'hardlink-source.txt'
  [IO.File]::WriteAllText($hardLinkOutside, 'hardlink-secret')
  New-Item -ItemType HardLink -Path (Join-Path $hardLinkRoot 'alias.txt') `
    -Target $hardLinkOutside | Out-Null
  $hardLinkRequest = Write-LaunchRequest -Name "phase4-hardlink-$PID" `
    -Arguments @('--self-probe') -ReadRoots @($hardLinkRoot) -WriteRoots @() `
    -ExactReadRoots @() -ExactWriteRoots @()
  Invoke-ExpectedAdmissionFailure -RequestPath $hardLinkRequest -Pattern 'multi-link' `
    -Description 'Hard-link alias admission'

  # An unsettled identity is never interpreted or reused by later launches.
  # The synthetic quarantined record carries a live ACE so this verifies both
  # preservation-for-inspection and fresh-identity isolation. The test removes
  # its own synthetic residue in finally.
  $quarantineRequestId = "phase4-unsettled-$PID"
  $quarantinedSid = Get-AppContainerSid $quarantineRequestId
  $quarantineRoot = Join-Path $workRoot 'quarantined-root'
  New-Item -ItemType Directory -Path $quarantineRoot | Out-Null
  & icacls.exe $quarantineRoot /grant "*$quarantinedSid`:(OI)(CI)RX" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to seed quarantined AppContainer ACE' }
  $quarantinePath = Join-Path $ledgerRoot "$(Get-Sha256Hex $quarantineRequestId).json.quarantined"
  [ordered]@{
    version = 2
    requestId = $quarantineRequestId
    appContainerSid = $quarantinedSid
    roots = @([ordered]@{
      path = $quarantineRoot
      read = $true
      write = $false
      readRecursive = $true
      writeRecursive = $false
    })
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $quarantinePath -Encoding utf8

  $recoveryRequestId = "phase4-quarantine-recovery-$PID"
  $recoverySid = Get-AppContainerSid $recoveryRequestId
  if ($recoverySid -eq $quarantinedSid) {
    throw 'A later launch reused the quarantined AppContainer identity'
  }
  $recoveryRequest = Write-LaunchRequest -Name $recoveryRequestId `
    -Arguments @('--self-probe') -ReadRoots @($allowedReadPath) -WriteRoots @() `
    -ExactReadRoots @($allowedReadPath) -ExactWriteRoots @()
  $recoveryResult = Invoke-Launcher @('--appcontainer', $recoveryRequest)
  if ($recoveryResult.ExitCode -ne 0) {
    throw "Launch after quarantined state failed: $($recoveryResult.Output -join "`n")"
  }
  if (-not (Test-Path -LiteralPath $quarantinePath)) {
    throw 'A later launch interpreted or deleted quarantined recovery evidence'
  }
  if ((Get-AclText $quarantineRoot) -notmatch [regex]::Escape($quarantinedSid)) {
    throw 'A later launch removed authority whose Job was not proven empty'
  }

  Write-Host "Phase 4 adversarial matrix verified: $rendered"
} finally {
  $cleanupErrors = [System.Collections.Generic.List[string]]::new()
  if ($listener) {
    try { $listener.Stop() } catch { $cleanupErrors.Add("listener stop: $($_.Exception.Message)") }
  }
  if ($pipe) {
    try { $pipe.Dispose() } catch { $cleanupErrors.Add("pipe dispose: $($_.Exception.Message)") }
  }
  try {
    [Environment]::SetEnvironmentVariable($hostSecretName, $null, 'Process')
  } catch {
    $cleanupErrors.Add("environment cleanup: $($_.Exception.Message)")
  }
  if (Test-Path -LiteralPath $registryPath) {
    try {
      Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction Stop
    } catch {
      $cleanupErrors.Add("registry cleanup: $($_.Exception.Message)")
    }
  }
  if ($quarantineRoot -and $quarantinedSid) {
    $aclCleanupOutput = & icacls.exe $quarantineRoot /remove "*$quarantinedSid" /T /L /Q 2>&1
    $aclCleanupExitCode = $LASTEXITCODE
    if ($aclCleanupExitCode -ne 0) {
      $cleanupErrors.Add(
        "quarantined ACE cleanup failed: exit=$aclCleanupExitCode output=$($aclCleanupOutput -join ' ')"
      )
    }
  }
  if ($quarantinePath) {
    if (Test-Path -LiteralPath $quarantinePath) {
      try {
        Remove-Item -LiteralPath $quarantinePath -Force -ErrorAction Stop
      } catch {
        $cleanupErrors.Add("quarantine ledger cleanup: $($_.Exception.Message)")
      }
    }
    if (Test-Path -LiteralPath $quarantinePath) {
      $cleanupErrors.Add("quarantine ledger still exists: $quarantinePath")
    }
  }
  if ($quarantineRoot -and (Test-Path -LiteralPath $quarantineRoot)) {
    try {
      if ((Get-AclText $quarantineRoot) -match [regex]::Escape($quarantinedSid)) {
        $cleanupErrors.Add("quarantined ACE still exists: $quarantinedSid")
      }
    } catch {
      $cleanupErrors.Add("quarantined ACE verification: $($_.Exception.Message)")
    }
  }
  if (Test-Path -LiteralPath $workRoot) {
    try {
      Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop
    } catch {
      $cleanupErrors.Add("work root cleanup: $($_.Exception.Message)")
    }
  }
  if (Test-Path -LiteralPath $workRoot) {
    $cleanupErrors.Add("work root still exists: $workRoot")
  }
  if ($cleanupErrors.Count -gt 0) {
    throw "Phase 4 adversarial matrix cleanup failed: $($cleanupErrors -join '; ')"
  }
}

$global:LASTEXITCODE = 0
exit 0
