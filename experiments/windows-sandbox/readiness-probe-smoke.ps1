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

# The production-identity readiness probe (RFC §6.4) stands up the real
# AppContainer identity, token, and kill-on-close Job and launches a throwaway
# confined child. Exit 0 alone is not evidence: the probe emits a machine-
# readable attestation of what it verified, and this gate asserts those exact
# fields so removing the exact-SID match, the specific-Job membership check,
# the settlement drain, or the private-desktop placement turns this red rather
# than leaving a hollow exit-0 gate green.
function Assert-ReadinessAttestation {
  param([string]$Rendered, [string]$Phase)
  if ($Rendered -notmatch '"appContainerSidVerified":true' -or
      $Rendered -notmatch '"jobVerified":true' -or
      $Rendered -notmatch '"settled":true' -or
      $Rendered -notmatch '"appContainerSid":"S-1-15-2-' -or
      $Rendered -notmatch '"desktop":"maka-sandbox-desktop\.' -or
      $Rendered -notmatch '"desktopPrivatePlacement":true') {
    throw "Readiness probe ($Phase) did not attest the verified boundary: $Rendered"
  }
}

$firstOutput = & $launcher --readiness-probe 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Readiness probe did not succeed: exit=$LASTEXITCODE output=$($firstOutput -join "`n")"
}
Assert-ReadinessAttestation -Rendered ($firstOutput -join "`n") -Phase 'first run'

# Availability is memoized per host, but the probe itself must be repeatable:
# a second run proves the confined child and Job teardown leave no residue that
# blocks the next probe.
$secondOutput = & $launcher --readiness-probe 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Readiness probe was not repeatable: exit=$LASTEXITCODE output=$($secondOutput -join "`n")"
}
Assert-ReadinessAttestation -Rendered ($secondOutput -join "`n") -Phase 'second run'

# The probe takes no arguments; passing one must fail closed rather than silently
# ignore unexpected input.
$rejected = & $launcher --readiness-probe unexpected 2>&1
if ($LASTEXITCODE -eq 0) {
  throw "Readiness probe accepted an unexpected argument: $($rejected -join "`n")"
}

$global:LASTEXITCODE = 0
Write-Host "Production-identity readiness probe verified: attested SID/Job/settlement/desktop, repeatable, argument-rejecting: $($secondOutput -join ' ')"
