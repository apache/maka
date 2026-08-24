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

$ErrorActionPreference = 'Stop'

function Read-Exact([IO.Stream]$Stream, [byte[]]$Buffer) {
  $offset = 0
  while ($offset -lt $Buffer.Length) {
    $count = $Stream.Read($Buffer, $offset, $Buffer.Length - $offset)
    if ($count -eq 0) { throw 'Broker returned a truncated response' }
    $offset += $count
  }
}

$launcher = Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipeSuffix = "maka-sandbox-ci-$PID"
$pipeName = "\\.\pipe\$pipeSuffix"
$launch = @{
  version = 1
  requestId = 'pipe-smoke-launch'
  executable = $launcher
  arguments = @('--self-probe')
  cwd = Split-Path -Parent $launcher
  readRoots = @()
  writeRoots = @()
  network = 'restricted'
  environment = @{}
}
$digestInput = Join-Path $env:RUNNER_TEMP "maka-windows-digest-$PID.json"
$launch | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $digestInput -Encoding utf8
$digest = (& $launcher --launch-digest $digestInput 2>&1) -join ''
Remove-Item -LiteralPath $digestInput -Force
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^[a-f0-9]{64}$') {
  throw "Unable to compute launch digest: $digest"
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $launcher
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.ArgumentList.Add('--broker-serve-once')
$start.ArgumentList.Add($pipeName)
$start.ArgumentList.Add($sid)
$start.ArgumentList.Add($digest)
$server = [Diagnostics.Process]::Start($start)

$client = $null
try {
  $client = [IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $pipeSuffix,
    [IO.Pipes.PipeDirection]::InOut,
    [IO.Pipes.PipeOptions]::None
  )
  $client.Connect(10000)
  $request = @{
    version = 1
    requestId = 'pipe-smoke'
    clientPid = $PID
    clientNonce = '0123456789abcdef0123456789abcdef'
    profileDigest = $digest
    launch = $launch
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 5 -Compress))
  $prefix = [BitConverter]::GetBytes([uint32]$payload.Length)
  $client.Write($prefix, 0, $prefix.Length)
  $client.Write($payload, 0, $payload.Length)
  $client.Flush()

  $responsePrefix = [byte[]]::new(4)
  Read-Exact $client $responsePrefix
  $responseLength = [BitConverter]::ToUInt32($responsePrefix, 0)
  if ($responseLength -eq 0 -or $responseLength -gt 65536) {
    throw "Broker returned invalid response length: $responseLength"
  }
  $responsePayload = [byte[]]::new($responseLength)
  Read-Exact $client $responsePayload
  $response = [Text.Encoding]::UTF8.GetString($responsePayload) | ConvertFrom-Json
  if ($response.requestId -ne 'pipe-smoke' -or
      $response.outcome.kind -ne 'completed' -or
      $response.outcome.exitCode -ne 0) {
    throw "Unexpected broker response: $($response | ConvertTo-Json -Compress)"
  }
  Write-Host "Secure broker pipe AppContainer launch verified: $($response | ConvertTo-Json -Compress)"
} finally {
  if ($client) { $client.Dispose() }
  if (-not $server.WaitForExit(10000)) {
    $server.Kill($true)
    throw 'Broker server did not exit after serving one request'
  }
  if ($server.ExitCode -ne 0) {
    throw "Broker server failed: $($server.StandardError.ReadToEnd())"
  }
  $server.Dispose()
}
