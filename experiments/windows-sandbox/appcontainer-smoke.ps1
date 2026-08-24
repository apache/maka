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
$requestPath = Join-Path $tempRoot "maka-windows-appcontainer-$PID.json"
$secretPath = Join-Path $tempRoot "maka-windows-appcontainer-secret-$PID.txt"
$allowedReadPath = Join-Path $tempRoot "maka-windows-appcontainer-allowed-read-$PID.txt"
$allowedWriteRoot = Join-Path $tempRoot "maka-windows-appcontainer-allowed-write-$PID"
$allowedWritePath = Join-Path $allowedWriteRoot 'write.txt'
$staleRoot = Join-Path $tempRoot "maka-windows-appcontainer-stale-$PID"
$ledgerRoot = Join-Path ([IO.Path]::GetTempPath()) 'maka-sandbox-acl-ledgers'
$ledgerPath = Join-Path $ledgerRoot "stale-$PID.json"
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
'must-not-be-readable' | Set-Content -LiteralPath $secretPath -Encoding utf8
[IO.File]::WriteAllText($allowedReadPath, 'allowed-read')
New-Item -ItemType Directory -Path $allowedWriteRoot | Out-Null
New-Item -ItemType Directory -Path $staleRoot | Out-Null
New-Item -ItemType Directory -Path $ledgerRoot -Force | Out-Null
$staleAppContainerSid = (& $launcher --appcontainer-sid 'stale-smoke' 2>&1) -join ''
if ($LASTEXITCODE -ne 0 -or $staleAppContainerSid -notmatch '^S-1-15-2-') {
  throw "Unable to resolve stale AppContainer SID: $staleAppContainerSid"
}
& icacls.exe $staleRoot /grant "*$staleAppContainerSid`:(OI)(CI)RX" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare stale AppContainer ACL' }
@{
  version = 2
  requestId = 'stale-smoke'
  appContainerSid = $staleAppContainerSid
  roots = @(@{
    path = $staleRoot
    read = $true
    write = $false
    readRecursive = $true
    writeRecursive = $false
  })
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ledgerPath -Encoding utf8
$request = @{
  version = 1
  requestId = 'appcontainer-smoke'
  executable = $launcher
  arguments = @(
    '--boundary-probe',
    $secretPath,
    $allowedReadPath,
    $allowedWritePath,
    "$port"
  )
  cwd = Split-Path -Parent $launcher
  readRoots = @($allowedReadPath)
  writeRoots = @($allowedWriteRoot)
  network = 'restricted'
  environment = @{}
}
$request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding utf8

try {
  $output = & $launcher --appcontainer $requestPath 2>&1
  $exitCode = $LASTEXITCODE
  $rendered = $output -join "`n"
  if ($exitCode -ne 0 -or
      $rendered -notmatch '"appContainer":true' -or
      $rendered -notmatch '"inJob":true' -or
      $rendered -notmatch '"atomicJob":true' -or
      $rendered -notmatch '"fileDenied":true' -or
      $rendered -notmatch '"allowedRead":true' -or
      $rendered -notmatch '"allowedWrite":true' -or
      $rendered -notmatch '"networkDenied":true' -or
      $rendered -notmatch '"desktopPrivatePlacement":true' -or
      $rendered -notmatch '"desktop":"maka-sandbox-desktop\.') {
    throw "AppContainer boundary was not established: exit=$exitCode output=$rendered"
  }
  $readAcl = (& icacls.exe $allowedReadPath 2>&1) -join "`n"
  $writeAcl = (& icacls.exe $allowedWriteRoot 2>&1) -join "`n"
  if ($readAcl -match 'S-1-15-2-' -or $writeAcl -match 'S-1-15-2-') {
    throw "AppContainer ACL was not restored after launch: read=$readAcl write=$writeAcl"
  }
  $staleAcl = (& icacls.exe $staleRoot 2>&1) -join "`n"
  if ($staleAcl -match [regex]::Escape($staleAppContainerSid) -or (Test-Path -LiteralPath $ledgerPath)) {
    throw "Stale AppContainer ACL ledger was not recovered: $staleAcl"
  }

  $junction = Join-Path $allowedWriteRoot 'junction'
  New-Item -ItemType Junction -Path $junction -Target $staleRoot | Out-Null
  $reparseOutput = & $launcher --appcontainer $requestPath 2>&1
  if ($LASTEXITCODE -eq 0 -or ($reparseOutput -join "`n") -notmatch 'reparse point') {
    throw "AppContainer accepted a reparse-point root: $($reparseOutput -join "`n")"
  }
  $global:LASTEXITCODE = 0
  Write-Host "AppContainer token and atomic Job boundary verified: $rendered"
} finally {
  $listener.Stop()
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $allowedReadPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $allowedWriteRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staleRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ledgerPath -Force -ErrorAction SilentlyContinue
}
