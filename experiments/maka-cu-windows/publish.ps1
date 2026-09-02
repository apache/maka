param(
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'out'),
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$helperProject = Join-Path $PSScriptRoot 'src/MakaCuWindows.csproj'
$fixtureProject = Join-Path $PSScriptRoot 'fixture/HangWindowFixture/HangWindowFixture.csproj'
$publishDir = Join-Path $OutputRoot 'publish'
$fixtureDir = Join-Path $OutputRoot 'fixture'

New-Item -ItemType Directory -Force -Path $publishDir, $fixtureDir | Out-Null
if (-not $NoBuild) {
  dotnet publish $helperProject -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:PublishTrimmed=false -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $publishDir
  if ($LASTEXITCODE -ne 0) { throw "helper publish failed with exit code $LASTEXITCODE" }
  dotnet publish $fixtureProject -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:PublishTrimmed=false -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $fixtureDir
  if ($LASTEXITCODE -ne 0) { throw "fixture publish failed with exit code $LASTEXITCODE" }
}

$helperExe = Join-Path $publishDir 'maka-cu-windows.exe'
$fixtureExe = Join-Path $fixtureDir 'maka-cu-windows-fixture.exe'
if (-not (Test-Path -LiteralPath $helperExe)) { throw "missing published helper: $helperExe" }
if (-not (Test-Path -LiteralPath $fixtureExe)) { throw "missing published fixture: $fixtureExe" }

$sdk = (dotnet --version).Trim()
$files = @($helperExe, $fixtureExe) | ForEach-Object {
  $item = Get-Item -LiteralPath $_
  $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
  [ordered]@{ path = $item.FullName; bytes = $item.Length; sha256 = $hash }
}
$manifest = [ordered]@{
  protocol = 'maka.cu.windows/0'
  targetFramework = 'net8.0-windows10.0.22621.0'
  runtime = 'win-x64'
  sdk = $sdk
  selfContained = $true
  singleFile = $true
  trimmed = $false
  nativeLibrariesForSelfExtract = $true
  signature = 'none'
  distributionReady = $false
  files = $files
  generatedUtc = [DateTime]::UtcNow.ToString('O')
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputRoot 'manifest.json') -Encoding utf8
Write-Output "published helper: $helperExe"
Write-Output "published fixture: $fixtureExe"
Write-Output (Get-Content -LiteralPath (Join-Path $OutputRoot 'manifest.json') -Raw)
