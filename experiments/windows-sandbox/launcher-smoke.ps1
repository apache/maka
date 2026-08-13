$ErrorActionPreference = 'Stop'

$launcherRoot = Join-Path $PSScriptRoot 'launcher'
$launcher = Join-Path $launcherRoot 'target\debug\maka-windows-sandbox-spike.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$requestPath = Join-Path $env:RUNNER_TEMP 'maka-windows-sandbox-request.json'
$request = @{
  version = 1
  requestId = 'ci-process-containment'
  executable = $launcher
  arguments = @('--self-probe')
  cwd = $launcherRoot
  readRoots = @()
  writeRoots = @()
  network = 'enabled'
  environment = @{
    SystemRoot = $env:SystemRoot
  }
}
$request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding utf8

$output = & $launcher $requestPath
if ($LASTEXITCODE -ne 0) {
  throw "Launcher exited with $LASTEXITCODE"
}
$probe = $output | ConvertFrom-Json
if ($probe.restrictedToken -ne $true) {
  throw 'Child process did not receive a restricted token'
}
if ($probe.inJob -ne $true) {
  throw 'Child process was not created inside the Job Object'
}
Write-Host "Restricted token and atomic Job membership verified: $output"
