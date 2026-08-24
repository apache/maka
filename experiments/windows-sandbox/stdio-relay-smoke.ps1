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
$workRoot = Join-Path $tempRoot "maka-stdio-relay-$PID"
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

function Invoke-RelayLaunch {
  param(
    [string[]]$ChildArguments,
    [byte[]]$StdinBytes,
    [Nullable[int]]$TimeoutMs
  )
  $requestPath = Join-Path $workRoot "request-$([guid]::NewGuid().ToString('N')).json"
  $stdinPath = Join-Path $workRoot 'stdin.bin'
  $stdoutPath = Join-Path $workRoot 'stdout.bin'
  $stderrPath = Join-Path $workRoot 'stderr.txt'
  [IO.File]::WriteAllBytes($stdinPath, $StdinBytes)
  $request = [ordered]@{
    version = 1
    requestId = "stdio-relay-$PID"
    executable = $launcher
    arguments = $ChildArguments
    cwd = Split-Path -Parent $launcher
    readRoots = @()
    writeRoots = @()
    network = 'restricted'
    environment = @{}
  }
  if ($null -ne $TimeoutMs) { $request.timeoutMs = $TimeoutMs }
  $request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding utf8
  $process = Start-Process -FilePath $launcher `
    -ArgumentList @('--appcontainer', $requestPath) `
    -RedirectStandardInput $stdinPath `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -NoNewWindow -PassThru -Wait
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = [IO.File]::ReadAllText($stdoutPath)
    Stderr = [IO.File]::ReadAllText($stderrPath)
  }
}

function Assert-Probe {
  param($Result, [byte[]]$Payload, [string]$Case)
  if ($Result.ExitCode -ne 0) {
    throw "${Case}: relay launch failed: exit=$($Result.ExitCode) stderr=$($Result.Stderr)"
  }
  # stdout must be exactly the child's single JSON response: the relay owns
  # the response channel and nothing else may leak into it.
  $document = $null
  try {
    $document = $Result.Stdout.Trim() | ConvertFrom-Json
  } catch {
    throw "${Case}: stdout is not a single JSON document: $($Result.Stdout)"
  }
  $sha = [BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash($Payload)
  ).Replace('-', '').ToLowerInvariant()
  if ($document.echoBytes -ne $Payload.Length -or $document.sha256 -ne $sha) {
    throw "${Case}: child did not receive the exact stdin payload: $($Result.Stdout)"
  }
  if ($Result.Stderr -notmatch '"appContainer":true' -or
      $Result.Stderr -notmatch 'stdio-probe: diagnostics stay on stderr') {
    throw "${Case}: diagnostics did not stay on stderr: $($Result.Stderr)"
  }
}

try {
  # Small payload roundtrip.
  $small = [Text.Encoding]::UTF8.GetBytes('stdio-relay-small-payload')
  Assert-Probe -Result (Invoke-RelayLaunch -ChildArguments @('--stdio-probe') -StdinBytes $small) `
    -Payload $small -Case 'small'

  # Empty stdin must still reach the child as immediate EOF.
  Assert-Probe -Result (Invoke-RelayLaunch -ChildArguments @('--stdio-probe') -StdinBytes @()) `
    -Payload @() -Case 'eof'

  # Large payload (5 MiB, below the runtime's 8 MiB response cap).
  $large = [byte[]]::new(5MB)
  [Random]::new(20260815).NextBytes($large)
  Assert-Probe -Result (Invoke-RelayLaunch -ChildArguments @('--stdio-probe') -StdinBytes $large) `
    -Payload $large -Case 'large'

  # Timeout: a child sleeping past timeoutMs must be killed and reported.
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $timedOut = Invoke-RelayLaunch -ChildArguments @('--stdio-probe', '--sleep', '60') `
    -StdinBytes @() -TimeoutMs 2000
  $stopwatch.Stop()
  if ($timedOut.ExitCode -eq 0 -or $timedOut.Stderr -notmatch 'timeout') {
    throw "timeout: broker did not enforce timeoutMs: exit=$($timedOut.ExitCode) stderr=$($timedOut.Stderr)"
  }
  if ($stopwatch.Elapsed.TotalSeconds -gt 30) {
    throw "timeout: broker took $($stopwatch.Elapsed.TotalSeconds)s to enforce a 2s timeout"
  }

  Write-Host 'Filesystem-worker stdio relay verified: roundtrip, EOF, large payload, stdout purity, timeout kill'
} finally {
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
