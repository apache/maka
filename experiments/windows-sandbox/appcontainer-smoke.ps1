$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$launcher = Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$requestPath = Join-Path $tempRoot "maka-windows-appcontainer-$PID.json"
$secretPath = Join-Path $tempRoot "maka-windows-appcontainer-secret-$PID.txt"
$allowedRoot = Join-Path $tempRoot "maka-windows-appcontainer-allowed-$PID"
$allowedReadPath = Join-Path $allowedRoot 'read.txt'
$allowedWritePath = Join-Path $allowedRoot 'write.txt'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
'must-not-be-readable' | Set-Content -LiteralPath $secretPath -Encoding utf8
New-Item -ItemType Directory -Path $allowedRoot | Out-Null
[IO.File]::WriteAllText($allowedReadPath, 'allowed-read')
$request = @{
  version = 1
  requestId = 'appcontainer-smoke'
  executable = $launcher
  arguments = @(
    '--boundary-probe',
    $secretPath,
    $allowedReadPath,
    $allowedWritePath,
    "$port"
  )
  cwd = Split-Path -Parent $launcher
  readRoots = @($allowedRoot)
  writeRoots = @($allowedRoot)
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
      $rendered -notmatch '"atomicJob":true' -or
      $rendered -notmatch '"fileDenied":true' -or
      $rendered -notmatch '"allowedRead":true' -or
      $rendered -notmatch '"allowedWrite":true' -or
      $rendered -notmatch '"networkDenied":true') {
    throw "AppContainer boundary was not established: exit=$exitCode output=$rendered"
  }
  $acl = (& icacls.exe $allowedRoot 2>&1) -join "`n"
  if ($acl -match 'S-1-15-2-') {
    throw "AppContainer ACL was not restored after launch: $acl"
  }
  Write-Host "AppContainer token and atomic Job boundary verified: $rendered"
} finally {
  $listener.Stop()
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $allowedRoot -Recurse -Force -ErrorAction SilentlyContinue
}
