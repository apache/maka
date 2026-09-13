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

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'Windows Runtime Host Local IPC trust verification must run on Windows'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$fixturePath = Join-Path $repositoryRoot 'packages/runtime-host/dist/__tests__/fixtures/windows-local-ipc-trust-host.js'
if (-not (Test-Path $fixturePath)) {
  throw "Missing Runtime Host trust fixture: $fixturePath"
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class MakaWindowsPipeTrustProbe
{
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LogonUser(
        string username,
        string domain,
        string password,
        int logonType,
        int logonProvider,
        out SafeAccessTokenHandle token);

    public static string TryOpenAsUser(
        string username,
        string domain,
        string password,
        string pipeName,
        PipeDirection direction)
    {
        SafeAccessTokenHandle token;
        if (!LogonUser(username, domain, password, 2, 0, out token))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "LogonUser failed");
        }

        using (token)
        {
            return WindowsIdentity.RunImpersonated(token, () => TryOpen(pipeName, direction));
        }
    }

    private static string TryOpen(string pipeName, PipeDirection direction)
    {
        try
        {
            using (var client = new NamedPipeClientStream(
                ".",
                pipeName,
                direction,
                PipeOptions.None,
                TokenImpersonationLevel.Identification))
            {
                client.Connect(3000);
                return "connected";
            }
        }
        catch (UnauthorizedAccessException)
        {
            return "access_denied";
        }
        catch (IOException error)
        {
            var win32Code = error.HResult & 0xffff;
            return win32Code == 5 ? "access_denied" : "io_error:" + win32Code;
        }
        catch (TimeoutException)
        {
            return "timeout";
        }
    }
}
'@

function Read-ProcessLine {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $readTask = $Process.StandardOutput.ReadLineAsync()
  if (-not $readTask.Wait($TimeoutMilliseconds)) {
    throw "Timed out waiting for Runtime Host trust fixture output"
  }
  $line = $readTask.Result
  if ($null -eq $line) {
    $stderr = $Process.StandardError.ReadToEnd()
    throw "Runtime Host trust fixture exited before producing output: $stderr"
  }
  return $line
}

$userName = "MakaIpc$(([Guid]::NewGuid().ToString('N')).Substring(0, 8))"
$password = "Maka-Ipc!$([Guid]::NewGuid().ToString('N'))aA1"
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$fixture = $null
$currentUserClients = @()
$createdUser = $false

try {
  New-LocalUser `
    -Name $userName `
    -Password $securePassword `
    -AccountNeverExpires `
    -PasswordNeverExpires | Out-Null
  $createdUser = $true

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command node.exe).Source
  $startInfo.ArgumentList.Add($fixturePath)
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  $candidateFixture = [System.Diagnostics.Process]::new()
  $candidateFixture.StartInfo = $startInfo
  try {
    if (-not $candidateFixture.Start()) {
      throw 'Unable to start Runtime Host trust fixture'
    }
  } catch {
    $candidateFixture.Dispose()
    throw
  }
  $fixture = $candidateFixture

  # The fixture prints readiness only once the endpoint ACL has been applied, so
  # this deadline has to outlast WINDOWS_PIPE_ACL_TIMEOUT_MS in
  # packages/runtime-host/src/control/endpoint.ts -- otherwise this throws first
  # and the fixture's own diagnostic is never read. 45s matches the client
  # readiness budget in packages/runtime-host/src/client/wait-for-ready.ts.
  $ready = Read-ProcessLine -Process $fixture -TimeoutMilliseconds 45000 | ConvertFrom-Json
  if ($ready.type -ne 'ready' -or $ready.endpoint -notmatch '^\\\\\.\\pipe\\(.+)$') {
    throw "Invalid Runtime Host trust fixture readiness: $($ready | ConvertTo-Json -Compress)"
  }
  $pipeName = $Matches[1]

  # Keep enough owner connections open to consume libuv's initial pending pipe
  # instances and force replacement instances before probing the foreign user.
  for ($index = 0; $index -lt 8; $index += 1) {
    $currentUserClient = [System.IO.Pipes.NamedPipeClientStream]::new(
      '.',
      $pipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      [System.IO.Pipes.PipeOptions]::None,
      [System.Security.Principal.TokenImpersonationLevel]::Identification
    )
    try {
      $currentUserClient.Connect(5000)
      $currentUserClients += $currentUserClient
    } catch {
      $currentUserClient.Dispose()
      throw
    }

    $accepted = Read-ProcessLine -Process $fixture -TimeoutMilliseconds 5000 | ConvertFrom-Json
    if ($accepted.type -ne 'accepted' -or $accepted.principalKind -ne 'local_owner') {
      throw "Current-user connection did not receive Local Owner authority"
    }
  }

  foreach ($direction in @(
    [System.IO.Pipes.PipeDirection]::In,
    [System.IO.Pipes.PipeDirection]::Out,
    [System.IO.Pipes.PipeDirection]::InOut
  )) {
    $foreignResult = [MakaWindowsPipeTrustProbe]::TryOpenAsUser(
      $userName,
      $env:COMPUTERNAME,
      $password,
      $pipeName,
      $direction
    )
    if ($foreignResult -ne 'access_denied') {
      throw "Foreign Windows user unexpectedly opened the Local IPC listener ($direction): $foreignResult"
    }
  }

  Write-Output 'Runtime Host Windows Local IPC admitted the current user and denied a foreign user.'
} finally {
  try {
    try {
      foreach ($client in $currentUserClients) {
        $client.Dispose()
      }
    } finally {
      if ($null -ne $fixture) {
        if (-not $fixture.HasExited) {
          $fixture.StandardInput.WriteLine('close')
          $fixture.StandardInput.Flush()
          if (-not $fixture.WaitForExit(5000)) {
            $fixture.Kill($true)
            $fixture.WaitForExit()
          }
        }
        if ($fixture.ExitCode -ne 0) {
          $stderr = $fixture.StandardError.ReadToEnd()
          throw "Runtime Host trust fixture exited with $($fixture.ExitCode): $stderr"
        }
      }
    }
  } finally {
    try {
      if ($null -ne $fixture) {
        $fixture.Dispose()
      }
    } finally {
      if ($createdUser) {
        Remove-LocalUser -Name $userName -ErrorAction Stop
      }
    }
  }
}
