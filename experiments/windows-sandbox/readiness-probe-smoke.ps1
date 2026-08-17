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
# confined child. A clean exit 0 proves the host can actually create and enforce
# the boundary — this is what the runtime's `isAvailable` fails closed on, so it
# must never regress into file-presence-only availability.
$firstOutput = & $launcher --readiness-probe 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Readiness probe did not succeed: exit=$LASTEXITCODE output=$($firstOutput -join "`n")"
}

# Availability is memoized per host, but the probe itself must be repeatable:
# a second run proves the confined child and Job teardown leave no residue that
# blocks the next probe.
$secondOutput = & $launcher --readiness-probe 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Readiness probe was not repeatable: exit=$LASTEXITCODE output=$($secondOutput -join "`n")"
}

# The probe takes no arguments; passing one must fail closed rather than silently
# ignore unexpected input.
$rejected = & $launcher --readiness-probe unexpected 2>&1
if ($LASTEXITCODE -eq 0) {
  throw "Readiness probe accepted an unexpected argument: $($rejected -join "`n")"
}

$global:LASTEXITCODE = 0
Write-Host 'Production-identity readiness probe verified: exit 0, repeatable, argument-rejecting'
