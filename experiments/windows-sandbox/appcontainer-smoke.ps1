$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$launcher = Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox-spike.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$requestPath = Join-Path $tempRoot "maka-windows-appcontainer-$PID.json"
$request = @{
  version = 1
  requestId = 'appcontainer-smoke'
  executable = $launcher
  arguments = @('--self-probe')
  cwd = Split-Path -Parent $launcher
  readRoots = @()
  writeRoots = @()
  network = 'restricted'
  environment = @{}
}
$request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding utf8

try {
  $output = & $launcher --appcontainer $requestPath 2>&1
  $exitCode = $LASTEXITCODE
  $rendered = $output -join "`n"
  if ($exitCode -ne 0 -or
      $rendered -notmatch '"appContainer":true' -or
      $rendered -notmatch '"inJob":true' -or
      $rendered -notmatch '"atomicJob":true') {
    throw "AppContainer boundary was not established: exit=$exitCode output=$rendered"
  }
  Write-Host "AppContainer token and atomic Job boundary verified: $rendered"
} finally {
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
}
