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

$launcherRoot = Join-Path $PSScriptRoot 'launcher'
$launcher = Join-Path $launcherRoot 'target\debug\maka-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$capability = & (Join-Path $PSScriptRoot 'atomic-launch-capability.ps1') | ConvertFrom-Json
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$requestPath = Join-Path $tempRoot 'maka-windows-sandbox-atomic-request.json'
$request = @{
  version = 1
  requestId = 'ci-atomic-process-containment'
  executable = $env:ComSpec
  arguments = @('/d', '/c', 'exit 0')
  cwd = $launcherRoot
  readRoots = @()
  writeRoots = @()
  network = 'enabled'
  environment = @{
    SystemRoot = $env:SystemRoot
    PATH = $env:PATH
  }
}
$request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding utf8

try {
  $output = & $launcher --atomic $requestPath 2>&1
  $exitCode = $LASTEXITCODE
  $rendered = $output -join "`n"

  if (-not $capability.atomicCreateProcessAsUserReady) {
    if ($exitCode -eq 0 -or $rendered -match '"atomicJob":true') {
      throw 'Atomic candidate reported success without the required broker privileges'
    }
    Write-Host "Atomic candidate failed closed without broker privileges: $rendered"
    exit 0
  }

  if ($exitCode -ne 0) {
    throw "Atomic launcher exited with ${exitCode}: $rendered"
  }
  if ($rendered -notmatch '"restrictedToken":true' -or
      $rendered -notmatch '"inJob":true' -or
      $rendered -notmatch '"atomicJob":true') {
    throw "Atomic launcher did not prove the complete process boundary: $rendered"
  }
  Write-Host "Restricted token and atomic Job membership verified: $rendered"
} finally {
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
}
