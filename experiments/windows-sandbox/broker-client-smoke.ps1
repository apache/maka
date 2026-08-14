$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$launcher = Join-Path $PSScriptRoot 'launcher\target\debug\maka-windows-sandbox-spike.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher binary: $launcher"
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipeSuffix = "maka-sandbox-client-ci-$PID"
$pipeName = "\\.\pipe\$pipeSuffix"
$digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$manifestPath = Join-Path $env:RUNNER_TEMP "maka-windows-broker-client-$PID.json"
$manifest = @{
  version = 1
  requestId = 'broker-client-smoke'
  clientPid = 0
  clientNonce = '0123456789abcdef0123456789abcdef'
  profileDigest = $digest
  launch = @{
    version = 1
    requestId = 'broker-client-smoke-launch'
    executable = $env:ComSpec
    arguments = @('/d', '/c', 'exit 0')
    cwd = $PSScriptRoot
    readRoots = @()
    writeRoots = @()
    network = 'enabled'
    environment = @{}
  }
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
  if ($exitCode -eq 0 -or
      $rendered -notmatch 'atomic_launch_failed' -or
      $rendered -notmatch 'required privilege') {
    throw "Broker client did not fail closed as expected: exit=$exitCode output=$rendered"
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
  Write-Host "Broker client PID binding, manifest cleanup, and atomic failure verified: $rendered"
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  if (-not $server.HasExited) { $server.Kill($true) }
  $server.Dispose()
}

exit 0
