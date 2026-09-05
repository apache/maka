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
$PSNativeCommandUseErrorActionPreference = $false

$launcher = Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipeSuffix = "maka-sandbox-client-ci-$PID"
$pipeName = "\\.\pipe\$pipeSuffix"
$manifestPath = Join-Path $env:RUNNER_TEMP "maka-windows-broker-client-$PID.json"
$launch = @{
  version = 1
  requestId = 'broker-client-smoke-launch'
  executable = $launcher
  arguments = @('--self-probe')
  cwd = Split-Path -Parent $launcher
  readRoots = @()
  writeRoots = @()
  network = 'restricted'
  environment = @{}
}
$digestInput = Join-Path $env:RUNNER_TEMP "maka-windows-client-digest-$PID.json"
$launch | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $digestInput -Encoding utf8
$digest = (& $launcher --launch-digest $digestInput 2>&1) -join ''
Remove-Item -LiteralPath $digestInput -Force
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^[a-f0-9]{64}$') {
  throw "Unable to compute launch digest: $digest"
}
$manifest = @{
  version = 1
  requestId = 'broker-client-smoke'
  clientPid = 0
  clientNonce = '0123456789abcdef0123456789abcdef'
  profileDigest = $digest
  launch = $launch
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $launcher
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardError = $true
$start.ArgumentList.Add('--broker-serve-once')
$start.ArgumentList.Add($pipeName)
$start.ArgumentList.Add($sid)
$start.ArgumentList.Add($digest)
$server = [Diagnostics.Process]::Start($start)

try {
  $output = & $launcher --broker-client $pipeName $manifestPath 2>&1
  $exitCode = $LASTEXITCODE
  $rendered = $output -join "`n"
  if ($exitCode -ne 0) {
    throw "Broker client AppContainer launch failed: exit=$exitCode output=$rendered"
  }
  if (Test-Path -LiteralPath $manifestPath) {
    throw 'Broker client left its launch manifest on disk'
  }
  if (-not $server.WaitForExit(10000)) {
    $server.Kill($true)
    throw 'Broker server did not exit after the client exchange'
  }
  if ($server.ExitCode -ne 0) {
    throw "Broker server failed: $($server.StandardError.ReadToEnd())"
  }
  Write-Host "Broker client PID binding, manifest cleanup, and AppContainer launch verified: $rendered"
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  if (-not $server.HasExited) { $server.Kill($true) }
  $server.Dispose()
}

exit 0
