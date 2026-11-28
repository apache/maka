# Installs NSH (the `nsh` CLI and its prebuilt runtimes) from a GitHub release.
#
#   irm https://nsh.dev/install.ps1 | iex
#
# $env:NSH_VERSION      a release tag such as v0.1.0 (default: the latest release)
# $env:NSH_INSTALL_DIR  where the distribution goes (default: %LOCALAPPDATA%\nsh);
#                       nsh finds its runtimes next to bin\nsh.exe, so the
#                       directory stays whole
#
# Its bin directory is added to the user's PATH. Running the script again
# updates it. Works with Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repository = 'longbridge/nsh'
$dir = if ($env:NSH_INSTALL_DIR) { $env:NSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'nsh' }
$version = if ($env:NSH_VERSION) { $env:NSH_VERSION } else { 'latest' }

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$asset = switch ($arch) {
    'AMD64' { 'nsh-windows-x86_64.zip' }
    'ARM64' { 'nsh-windows-arm64.zip' }
    default { throw "nsh: no prebuilt NSH for Windows $arch; see https://nsh.dev/docs/installation" }
}
$platform = $asset -replace '^nsh-|\.zip$', ''
# Windows PowerShell 5.1 may not offer TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Name the release before downloading it: `releases/latest` redirects to
# `releases/tag/<tag>`. The download then uses that tag, so a release
# published meanwhile cannot mix in. Without an answer it falls back to
# the `latest` download URL.
if ($version -eq 'latest') {
    try {
        $request = [Net.WebRequest]::Create("https://github.com/$repository/releases/latest")
        $request.Method = 'HEAD'
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try {
            $location = $response.Headers['Location']
        } finally {
            $response.Close()
        }
        if ($location -match '/releases/tag/([^/?#]+)$') { $version = $Matches[1] }
    } catch {
    }
}
$url = if ($version -eq 'latest') {
    "https://github.com/$repository/releases/latest/download/$asset"
} else {
    "https://github.com/$repository/releases/download/$version/$asset"
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("nsh-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $zip = Join-Path $work $asset
    if ($version -eq 'latest') {
        Write-Host "Installing the latest NSH release for $platform"
    } else {
        Write-Host "Installing NSH $version for $platform"
    }
    Write-Host "Downloading $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    # GitHub serves it as application/octet-stream: bytes in PowerShell 5.1.
    $sum = (Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256").Content
    if ($sum -is [byte[]]) { $sum = [Text.Encoding]::ASCII.GetString($sum) }
    $expected = ($sum.Trim() -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
    if ($actual -ne $expected) {
        throw "nsh: the checksum of $asset does not match"
    }

    Expand-Archive -Path $zip -DestinationPath $work
    $extracted = Join-Path $work 'nsh'
    if (-not (Test-Path (Join-Path $extracted 'bin\nsh.exe'))) {
        throw "nsh: $asset holds no nsh\bin\nsh.exe"
    }

    # Replace the whole directory: runtimes of an older release must not stay.
    $parent = Split-Path -Parent $dir
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if (Test-Path $dir) {
        try {
            Remove-Item -Recurse -Force $dir
        } catch {
            throw "nsh: cannot replace $dir (is nsh or one of its hosts running?): $_"
        }
    }
    Move-Item -Path $extracted -Destination $dir
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

$bin = Join-Path $dir 'bin'
$installed = & (Join-Path $bin 'nsh.exe') --version
Write-Host "Installed $installed to $dir"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = if ($userPath) { $userPath -split ';' | Where-Object { $_ } } else { @() }
if ($entries -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (@($entries) + $bin) -join ';', 'User')
    $env:Path = "$env:Path;$bin"
    Write-Host "Added $bin to your PATH; open a new terminal to use nsh there."
}
