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

param(
    [Parameter(Mandatory = $true)][uint32]$BrowserProcessId,
    [Parameter(Mandatory = $true)][uint32]$ParentProcessId,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Title,
    [switch]$Focus,
    [switch]$InPrivate
)

$ErrorActionPreference = 'Stop'
if ($env:MAKA_HISTORY_WINDOWS_BROWSER_TEST -ne '1' -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This fixture requires explicit Windows browser test opt-in.'
}
if (-not [IO.Path]::IsPathRooted($Profile) -or
    [IO.Path]::GetFileName($Profile) -notmatch '^edge-profile-[a-f0-9]{32}$' -or
    $Title -notmatch '^Maka history [a-f0-9]{32} ') {
    throw 'Expected an isolated profile and a synthetic page title.'
}
$browser = Get-CimInstance Win32_Process -Filter "ProcessId = $BrowserProcessId"
if ($null -eq $browser -or $browser.ParentProcessId -ne $ParentProcessId -or
    -not [string]::Equals($browser.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The requested PID is not the Edge process launched by this test.'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HistoryBrowserWindow
{
    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Arguments(string commandLine)
    {
        int count;
        IntPtr memory = CommandLineToArgvW(commandLine, out count);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot parse fixture command line.");
        try {
            var values = new string[count];
            for (int i = 0; i < count; i++)
                values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return values;
        } finally { LocalFree(memory); }
    }

    public static IntPtr Find(uint pid, string title)
    {
        var matches = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr ignored) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            // Never read titles of unrelated windows.
            if (owner != pid || !IsWindowVisible(window)) return true;
            if (ReadTitle(window).IndexOf(title, StringComparison.Ordinal) >= 0) matches.Add(window);
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) throw new InvalidOperationException("Expected exactly one visible synthetic Edge window.");
        return matches[0];
    }

    public static string ReadTitle(IntPtr window)
    {
        var text = new StringBuilder(2048);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static void Focus(IntPtr window)
    {
        ShowWindow(window, 9);
        SetForegroundWindow(window);
    }
}
'@

$arguments = [HistoryBrowserWindow]::Arguments($browser.CommandLine)
if ($arguments -cnotcontains "--user-data-dir=$Profile" -or
    $arguments -notcontains '--remote-debugging-port=0' -or
    (($arguments -contains '--inprivate') -ne $InPrivate.IsPresent)) {
    throw 'Edge command line does not match the isolated test profile/mode.'
}
$window = [HistoryBrowserWindow]::Find($BrowserProcessId, $Title)
if ($Focus) { [HistoryBrowserWindow]::Focus($window) }
if ([HistoryBrowserWindow]::GetForegroundWindow() -ne $window) {
    throw 'Synthetic Edge window is not foreground; no snapshot may be taken.'
}
[ordered]@{
    windowID = $window.ToInt64()
    processIdentifier = $BrowserProcessId
    title = [HistoryBrowserWindow]::ReadTitle($window)
    inPrivate = $InPrivate.IsPresent
} | ConvertTo-Json -Compress
