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
if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing launcher binary: $launcher" }

$manifestPath = Join-Path $env:RUNNER_TEMP "maka-windows-broker-local-$PID.json"
$digestInput = Join-Path $env:RUNNER_TEMP "maka-windows-local-digest-$PID.json"
$launch = @{
  version = 1
  requestId = 'broker-local-smoke-launch'
  executable = $launcher
  arguments = @('--self-probe')
  cwd = Split-Path -Parent $launcher
  readRoots = @()
  writeRoots = @()
  network = 'restricted'
  environment = @{}
}
$launch | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $digestInput -Encoding utf8
$digest = (& $launcher --launch-digest $digestInput 2>&1) -join ''
Remove-Item -LiteralPath $digestInput -Force
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^[a-f0-9]{64}$') {
  throw "Unable to compute local launch digest: $digest"
}
@{
  version = 1
  requestId = 'broker-local-smoke'
  clientPid = 0
  clientNonce = 'fedcba9876543210fedcba9876543210'
  profileDigest = $digest
  launch = $launch
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

try {
  $output = & $launcher --broker-local $manifestPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "One-shot local broker failed: $($output -join "`n")"
  }
  if (Test-Path -LiteralPath $manifestPath) {
    throw 'One-shot local broker left its launch manifest on disk'
  }
  Write-Host "One-shot local broker lifecycle verified: $($output -join "`n")"
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
}
