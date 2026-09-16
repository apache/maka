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
    [switch]$InPrivate,
    [string]$WitnessUrl
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
if ($WitnessUrl) {
    $url = [Uri]$WitnessUrl
    $token = [regex]::Match($Title, '^Maka history ([a-f0-9]{32}) ').Groups[1].Value
    if ($env:MAKA_HISTORY_WINDOWS_BROWSER_INPUT_TEST -ne '1' -or $Focus -or $InPrivate -or
        $url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or
        $url.AbsolutePath -ne "/$token/physical" -or $url.Query -or $url.Fragment) {
        throw 'Witness mode requires the exact opt-in synthetic input document.'
    }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    Add-Type -ReferencedAssemblies @(
        'System.dll',
        [System.Windows.Rect].Assembly.Location,
        [System.Windows.Automation.AutomationElement].Assembly.Location,
        [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location
    ) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

public static class HistoryBrowserWitness
{
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiInfo {
        public uint size, flags;
        public IntPtr active, focus, capture, menu, move, caret;
        public int left, top, right, bottom;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    public static volatile bool Done;
    private static Process Parent, Browser;
    public static void Start(int parent, int browser) {
        Parent = Process.GetProcessById(parent);
        Browser = Process.GetProcessById(browser);
        IntPtr parentHandle = Parent.Handle, browserHandle = Browser.Handle;
        var input = new Thread(delegate() {
            while (Console.ReadLine() != null) {}
            Done = true;
        });
        input.IsBackground = true;
        input.Start();
        var watchdog = new Thread(delegate() {
            var clock = Stopwatch.StartNew();
            while (!Done) {
                if (Parent.HasExited || Browser.HasExited || clock.Elapsed.TotalSeconds > 205)
                    Environment.Exit(1);
                Thread.Sleep(100);
            }
        });
        watchdog.IsBackground = true;
        watchdog.Start();
    }
    private static IntPtr Host(IntPtr root, int pid) {
        uint owner;
        uint thread = GetWindowThreadProcessId(root, out owner);
        var info = new GuiInfo();
        info.size = (uint)Marshal.SizeOf(typeof(GuiInfo));
        if (owner != pid || GetForegroundWindow() != root ||
            !GetGUIThreadInfo(thread, ref info) || info.active != root ||
            info.focus == IntPtr.Zero || (info.flags & 0x1e) != 0 ||
            GetAncestor(info.focus, 2) != root)
            throw new InvalidOperationException("Synthetic browser host lost focus.");
        GetWindowThreadProcessId(info.focus, out owner);
        if (owner != pid) throw new InvalidOperationException("Foreign input host.");
        return info.focus;
    }
    private static int[] Id(AutomationElement element) {
        int[] id = element.GetRuntimeId();
        if (id == null || id.Length == 0 || id.Length > 32)
            throw new InvalidOperationException("Missing bounded UIA runtime ID.");
        return id;
    }
    public static object Read(long window, int pid, string url) {
        DateTime sampled = DateTime.UtcNow;
        var clock = Stopwatch.StartNew();
        IntPtr hwnd = new IntPtr(window);
        IntPtr host = Host(hwnd, pid);
        AutomationElement root = AutomationElement.FromHandle(hwnd);
        AutomationElement focus = AutomationElement.FocusedElement;
        if (root.Current.ProcessId != pid || root.Current.NativeWindowHandle != hwnd.ToInt32() ||
            focus == null || focus.Current.ProcessId != pid ||
            focus.Current.ControlType != ControlType.Edit || focus.Current.FrameworkId != "Chrome" ||
            !focus.Current.HasKeyboardFocus || focus.Current.IsOffscreen)
            throw new InvalidOperationException("Synthetic Chromium field is not focused.");
        AutomationElement current = focus, document = null;
        ValuePattern source = null;
        int depth = 0;
        while (!Automation.Compare(current, root)) {
            if (++depth > 32 || current.Current.ProcessId != pid)
                throw new InvalidOperationException("Focused field left owned ancestry.");
            if (document == null && current.Current.ControlType == ControlType.Document) {
                object pattern;
                if (!current.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ||
                    !String.Equals(((ValuePattern)pattern).Current.Value, url, StringComparison.Ordinal) ||
                    current.Current.IsOffscreen)
                    throw new InvalidOperationException("Document lacks its exact synthetic URL.");
                document = current;
                source = (ValuePattern)pattern;
            }
            current = TreeWalker.RawViewWalker.GetParent(current);
            if (current == null) throw new InvalidOperationException("Missing owned UIA root.");
        }
        if (document == null) throw new InvalidOperationException("No owning web Document.");
        string name = focus.Current.Name;
        string field = name == "Synthetic editor one" ? "one" :
            name == "Synthetic editor two" ? "two" : null;
        if (field == null) throw new InvalidOperationException("Unexpected synthetic field label.");
        int[] fieldId = Id(focus), documentId = Id(document), rootId = Id(root);
        bool password = focus.Current.IsPassword;
        if (Host(hwnd, pid) != host || !Automation.Compare(focus, AutomationElement.FocusedElement) ||
            !String.Equals(source.Current.Value, url, StringComparison.Ordinal) ||
            clock.ElapsedMilliseconds > 500)
            throw new InvalidOperationException("Synthetic identity changed during inspection.");
        return new {
            valid = true, field = field, password = password, framework = "Chrome",
            processIdentifier = pid, windowID = window, inputWindowID = host.ToInt64(),
            runtimeId = fieldId, documentRuntimeId = documentId, rootRuntimeId = rootId,
            documentUrl = url,
            witnessedAt = (long)(sampled - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds
        };
    }
}
'@
    [HistoryBrowserWitness]::Start($ParentProcessId, $BrowserProcessId)
    while (-not [HistoryBrowserWitness]::Done) {
        try {
            $value = [HistoryBrowserWitness]::Read($window.ToInt64(), $BrowserProcessId, $WitnessUrl)
            $value | ConvertTo-Json -Depth 5 -Compress
        } catch {
            [ordered]@{ valid = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
        Start-Sleep -Milliseconds 100
    }
    exit 0
}
[ordered]@{
    windowID = $window.ToInt64()
    processIdentifier = $BrowserProcessId
    title = [HistoryBrowserWindow]::ReadTitle($window)
    inPrivate = $InPrivate.IsPresent
} | ConvertTo-Json -Compress
