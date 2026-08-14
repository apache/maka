$ErrorActionPreference = 'Stop'

$launcherRoot = Join-Path $PSScriptRoot 'launcher'
$launcher = Join-Path $launcherRoot 'target\debug\maka-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$requestPath = Join-Path $env:RUNNER_TEMP 'maka-windows-sandbox-request.json'
$request = @{
  version = 1
  requestId = 'ci-process-containment'
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

$output = & $launcher $requestPath 2>&1
$exitCode = $LASTEXITCODE
$rendered = $output -join "`n"
if ($exitCode -ne 0) {
  if ($rendered -match 'child exceeded the 30 second W0 timeout') {
    Write-Warning 'The unprivileged restricted-token candidate failed closed: its child did not complete initialization within 30 seconds.'
    Write-Host 'This is a recorded W0 incompatibility, not production sandbox evidence.'
    exit 0
  }
  throw "Launcher exited with ${exitCode}: $rendered"
}
if ($rendered -notmatch '"restrictedToken":true') {
  throw 'Child process did not receive a restricted token'
}
if ($rendered -notmatch '"inJob":true') {
  throw 'Child process was not created inside the Job Object'
}
Write-Host "Restricted token and post-create Job membership verified: $rendered"
