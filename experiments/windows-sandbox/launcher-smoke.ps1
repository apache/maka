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

$output = & $launcher $requestPath
if ($LASTEXITCODE -ne 0) {
  throw "Launcher exited with $LASTEXITCODE"
}
if ($output -notmatch '"restrictedToken":true') {
  throw 'Child process did not receive a restricted token'
}
if ($output -notmatch '"inJob":true') {
  throw 'Child process was not created inside the Job Object'
}
Write-Host "Restricted token and post-create Job membership verified: $output"
