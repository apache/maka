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
    [Parameter(Mandatory = $true)][string]$OutputAssembly,
    [switch]$TestOnly
)

$ErrorActionPreference = 'Stop'
if (-not $TestOnly -or $env:MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST -ne '1') {
    throw 'Synthetic interactive acceptance requires explicit test-only opt in.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The fixture requires Windows and Windows PowerShell 5.1.'
}
if (-not [IO.Path]::IsPathRooted($OutputAssembly) -or
    [IO.Path]::GetFileName($OutputAssembly) -notmatch '^maka-history-fixture-[a-f0-9]{32}\.exe$' -or
    [IO.File]::Exists($OutputAssembly)) {
    throw 'OutputAssembly must be a new, absolute, run-specific fixture executable.'
}

# A separate executable gives native policy a unique app ID. Allowlisting
# powershell.exe would also authorize unrelated, potentially personal windows.
$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Maka synthetic history fixture")]
[assembly: System.Reflection.AssemblyDescription("Maka synthetic history fixture")]
[assembly: System.Reflection.AssemblyProduct("Maka synthetic history fixture")]

internal static class HistoryFixture
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    private sealed class Document
    {
        internal Form Form;
        internal TextBox Text;
        internal List<Label> BudgetLabels = new List<Label>();
    }

    private static readonly Dictionary<string, Document> Documents = new Dictionary<string, Document>();
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Stopwatch Lifetime = Stopwatch.StartNew();
    private static readonly object OutputLock = new object();
    private static volatile int BlockId;
    private static volatile bool InputEnded;
    private static Process Parent;
    private static Dictionary<string, object> Pending;
    private static long ActivationStarted;
    private static long LastHeartbeat;
    private static string Token;

    private static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }
    }

    private static object Foreground()
    {
        IntPtr window = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        return new { windowID = window.ToInt64(), processIdentifier = pid };
    }

    private static Document MakeDocument(string key, bool password, bool privateTitle)
    {
        Form form = new Form();
        form.Text = "Maka synthetic " + Token + (privateTitle ? " InPrivate" : " document");
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(key == "two" ? 520 : 30, 60);
        form.ClientSize = new Size(460, 230);
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.ShowIcon = false;
        Label label = new Label();
        label.Text = "Synthetic acceptance notes";
        label.Location = new Point(16, 16);
        label.AutoSize = true;
        TextBox text = new TextBox();
        text.Location = new Point(16, 50);
        text.Size = new Size(425, password ? 30 : 150);
        text.Multiline = !password;
        text.UseSystemPasswordChar = password;
        text.AccessibleName = "Synthetic note body";
        form.Controls.Add(label);
        form.Controls.Add(text);
        // Materialize every HWND before recording so creation is not confused
        // with the A -> B -> A foreground transition under test.
        IntPtr handle = form.Handle;
        return new Document { Form = form, Text = text };
    }

    private static void Tick(object sender, EventArgs args)
    {
        try
        {
            if (InputEnded)
            {
                Application.Exit();
                return;
            }
            string line;
            if (Pending == null && Commands.TryDequeue(out line))
            {
                Dictionary<string, object> command = Json.Deserialize<Dictionary<string, object>>(line);
                string action = (string)command["action"];
                if (action == "close")
                {
                    Emit(new { type = "ack", id = command["id"], action = action });
                    Application.Exit();
                    return;
                }
                if (action == "block")
                {
                    BlockId = Convert.ToInt32(command["id"]);
                    long blockedAt = Lifetime.ElapsedMilliseconds;
                    Emit(new { type = "ack", id = command["id"], action = action });
                    // Do not pump STA/COM messages while waiting. The input
                    // reader releases this block once native failure is proven.
                    while (BlockId != 0 && !InputEnded)
                    {
                        if (Lifetime.ElapsedMilliseconds - blockedAt >= 25000)
                            throw new InvalidOperationException("Synthetic UI block was not released within its budget.");
                        Thread.Sleep(20);
                    }
                    BlockId = 0;
                    if (InputEnded)
                    {
                        Application.Exit();
                        return;
                    }
                    Emit(new { type = "unblocked", id = command["id"], foreground = Foreground() });
                    return;
                }
                if (action != "show" && action != "edit" && action != "select")
                    throw new InvalidOperationException("Unknown fixture action.");
                string key = (string)command["window"];
                Document document = Documents[key];
                if (command.ContainsKey("budget"))
                {
                    foreach (Label label in document.BudgetLabels) { document.Form.Controls.Remove(label); label.Dispose(); }
                    document.BudgetLabels.Clear();
                    if ((bool)command["budget"])
                    {
                        document.Form.ClientSize = new Size(460, 540);
                        for (int row = 0; row < 8; row++)
                        {
                            Label label = new Label();
                            label.Text = "SYNTHETIC_BUDGET_" + row.ToString() + "_" + new string('x', 5000);
                            label.Location = new Point(16, 220 + row * 36);
                            label.Size = new Size(425, 30);
                            document.BudgetLabels.Add(label);
                            document.Form.Controls.Add(label);
                        }
                    }
                    else document.Form.ClientSize = new Size(460, 230);
                }
                if (action != "show" && (GetForegroundWindow() != document.Form.Handle ||
                    !document.Text.Focused || !IsWindowVisible(document.Form.Handle) ||
                    !IsWindowVisible(document.Text.Handle)))
                    throw new InvalidOperationException("Pure edit requires an already focused visible document.");
                if (command.ContainsKey("password"))
                {
                    if (key != "password") throw new InvalidOperationException("Only the password fixture can toggle secrecy.");
                    document.Text.UseSystemPasswordChar = (bool)command["password"];
                }
                if (action == "select")
                    document.Text.Select(Convert.ToInt32(command["start"]), Convert.ToInt32(command["length"]));
                else
                    document.Text.Text = (string)command["text"];
                if (action == "show")
                {
                    document.Form.Show();
                    ShowWindow(document.Form.Handle, 5);
                    foreach (Control control in document.Form.Controls) ShowWindow(control.Handle, 5);
                    document.Form.BringToFront();
                    document.Form.Activate();
                    document.Text.Focus();
                    SetForegroundWindow(document.Form.Handle);
                }
                Pending = command;
                ActivationStarted = Lifetime.ElapsedMilliseconds;
            }
            if (Pending != null)
            {
                Document document = Documents[(string)Pending["window"]];
                if (GetForegroundWindow() == document.Form.Handle && document.Text.Focused &&
                    IsWindowVisible(document.Form.Handle) && IsWindowVisible(document.Text.Handle))
                {
                    Emit(new {
                        type = "ack", id = Pending["id"], action = Pending["action"],
                        window = Pending["window"], windowID = document.Form.Handle.ToInt64(),
                        processIdentifier = Process.GetCurrentProcess().Id,
                        title = document.Form.Text, text = document.Text.Text,
                        selectedText = document.Text.SelectedText, selectionStart = document.Text.SelectionStart,
                        password = document.Text.UseSystemPasswordChar,
                        foreground = Foreground()
                    });
                    Pending = null;
                }
                else if (Lifetime.ElapsedMilliseconds - ActivationStarted >= 2000)
                {
                    throw new InvalidOperationException("Synthetic window could not acquire foreground focus.");
                }
            }
            if (Lifetime.ElapsedMilliseconds - LastHeartbeat >= 250)
            {
                Emit(new { type = "heartbeat", foreground = Foreground() });
                LastHeartbeat = Lifetime.ElapsedMilliseconds;
            }
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            Environment.Exit(1);
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false, true)) { AutoFlush = true });
            if (Environment.GetEnvironmentVariable("MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST") != "1" ||
                args.Length != 2 || !Environment.UserInteractive)
                throw new InvalidOperationException("Interactive test-only opt in is required.");
            Token = args[1];
            Parent = Process.GetProcessById(Int32.Parse(args[0]));
            // Hold the process handle; a reused PID cannot extend fixture lifetime.
            IntPtr parentHandle = Parent.Handle;
            if (Parent.SessionId != Process.GetCurrentProcess().SessionId || Parent.HasExited)
                throw new InvalidOperationException("Fixture and Node parent must share an interactive session.");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Documents.Add("one", MakeDocument("one", false, false));
            Documents.Add("two", MakeDocument("two", false, false));
            Documents.Add("password", MakeDocument("password", true, false));
            Documents.Add("private", MakeDocument("private", false, true));
            Dictionary<string, long> windows = new Dictionary<string, long>();
            foreach (KeyValuePair<string, Document> pair in Documents)
                windows.Add(pair.Key, pair.Value.Form.Handle.ToInt64());
            Emit(new {
                type = "ready", processIdentifier = Process.GetCurrentProcess().Id,
                sessionId = Process.GetCurrentProcess().SessionId, windows = windows
            });
            Thread reader = new Thread(delegate() {
                try
                {
                    JavaScriptSerializer inputJson = new JavaScriptSerializer();
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        Dictionary<string, object> command = inputJson.Deserialize<Dictionary<string, object>>(line);
                        if ((string)command["action"] == "unblock")
                        {
                            int id = Convert.ToInt32(command["id"]);
                            if (id <= 0 || id != BlockId)
                                throw new InvalidOperationException("Unblock must match the active block.");
                            BlockId = 0;
                        }
                        else Commands.Enqueue(line);
                    }
                }
                catch (Exception error)
                {
                    Emit(new { type = "error", message = error.Message });
                }
                finally
                {
                    InputEnded = true;
                    BlockId = 0;
                }
            });
            reader.IsBackground = true;
            reader.Start();
            Thread watchdog = new Thread(delegate() {
                while (!InputEnded && !Parent.HasExited && Lifetime.ElapsedMilliseconds < 165000)
                    Thread.Sleep(250);
                if (!InputEnded) Environment.Exit(2);
            });
            watchdog.IsBackground = true;
            watchdog.Start();
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 40;
            timer.Tick += Tick;
            timer.Start();
            Application.Run();
            timer.Dispose();
            foreach (Document document in Documents.Values) document.Form.Dispose();
            Parent.Dispose();
            return 0;
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            return 1;
        }
    }
}
'@

$iconPath = "$OutputAssembly.ico"
Add-Type -AssemblyName System.Drawing
$iconFile = [IO.File]::Open($iconPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    [Drawing.SystemIcons]::Application.Save($iconFile)
} finally {
    $iconFile.Dispose()
}
try {
    $compiler = New-Object System.CodeDom.Compiler.CompilerParameters
    $compiler.CompilerOptions = "/win32icon:`"$iconPath`" /target:winexe"
    $compiler.GenerateExecutable = $true
    $compiler.OutputAssembly = $OutputAssembly
    $compiler.ReferencedAssemblies.AddRange(@(
        'System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'
    ))
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    try {
        $result = $provider.CompileAssemblyFromSource($compiler, $source)
        if ($result.Errors.HasErrors) {
            throw (($result.Errors | ForEach-Object { $_.ToString() }) -join "`n")
        }
    } finally {
        $provider.Dispose()
    }
} finally {
    [IO.File]::Delete($iconPath)
}
[Console]::Out.WriteLine('synthetic-fixture-built')
