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
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

    private sealed class Document
    {
        internal Form Form;
        internal TextBoxBase Text;
        internal RichTextBox Sibling;
        internal TextBox PrivacyControl;
        internal List<Label> BudgetLabels = new List<Label>();
    }

    private sealed class CountedEdit : TextBox
    {
        internal int BodyReads;
        internal int SelectionReads;
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x000D) BodyReads++;
            if (message.Msg == 0x00B0) SelectionReads++;
            base.WndProc(ref message);
        }
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
    private sealed class InputTrial
    {
        internal string Id;
        internal string Name;
        internal Document Document;
        internal long Deadline;
        internal string Text;
        internal string Rtf;
        internal bool Pressed;
        internal bool Released;
    }
    private static InputTrial Trial;
    private static bool InputWitnessing;

    private static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

    private static void InputContext(InputTrial trial)
    {
        Document document = trial.Document;
        RichTextBox rich = document.Text as RichTextBox;
        if (GetForegroundWindow() != document.Form.Handle || !document.Text.Focused ||
            !IsWindowVisible(document.Form.Handle) || !IsWindowVisible(document.Text.Handle))
            throw new InvalidOperationException("Physical input lost its exact focused source.");
        if (rich != null && (rich.Text != trial.Text || rich.Rtf != trial.Rtf))
            throw new InvalidOperationException("Physical input changed the hidden Rich context.");
    }

    private static void InputReceipt(Form form, TextBoxBase text, string phase,
        string key, bool control, string button)
    {
        if (!InputWitnessing) return;
        try
        {
            InputTrial trial = Trial;
            if (trial == null || trial.Document.Text != text ||
                Now() > trial.Deadline || trial.Released)
                throw new InvalidOperationException("Unexpected, late or duplicate physical receipt.");
            InputContext(trial);
            bool expected = trial.Name == "return" ? key == "Enter" && !control :
                trial.Name == "shortcut" ? key == "A" && (phase == "release" || control) :
                key == null && button == "Left";
            if (!expected || (phase == "press" ? trial.Pressed : !trial.Pressed))
                throw new InvalidOperationException("Physical receipt does not match the armed request.");
            if (phase == "press") trial.Pressed = true;
            else trial.Released = true;
            Emit(new { type = "input.received", requestId = trial.Id, phase = phase,
                at = Now(), key = key, control = control, button = button,
                processIdentifier = Process.GetCurrentProcess().Id,
                windowID = form.Handle.ToInt64(), inputWindowID = text.Handle.ToInt64(),
                contextPreserved = true, hiddenPresent = trial.Rtf != null,
                foreground = Foreground() });
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            Environment.Exit(1);
        }
    }

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
        bool richTest = Environment.GetEnvironmentVariable("MAKA_HISTORY_WINDOWS_RICH_EDIT_TEST") == "1";
        bool rich = key == "one" && richTest;
        TextBoxBase text = rich ? (TextBoxBase)new RichTextBox() : new CountedEdit();
        text.MaxLength = 200000;
        text.Location = new Point(16, 50);
        text.Size = new Size(425, password ? 30 : 150);
        text.Multiline = !password;
        if (text is TextBox) ((TextBox)text).UseSystemPasswordChar = password;
        text.AccessibleName = "Synthetic note body";
        text.KeyDown += delegate(object sender, KeyEventArgs args) {
            if (args.KeyCode == Keys.Enter || (args.Control && args.KeyCode == Keys.A))
            {
                InputReceipt(form, text, "press", args.KeyCode.ToString(), args.Control, null);
                // Keep KeyUp observable; SuppressKeyPress would suppress it too.
                if (rich && InputWitnessing) args.Handled = true;
            }
        };
        text.KeyPress += delegate(object sender, KeyPressEventArgs args) {
            if (rich && InputWitnessing && (args.KeyChar == '\r' || args.KeyChar == '\n' || args.KeyChar == '\x01'))
                args.Handled = true;
        };
        text.KeyUp += delegate(object sender, KeyEventArgs args) {
            if (args.KeyCode == Keys.Enter || args.KeyCode == Keys.A)
                InputReceipt(form, text, "release", args.KeyCode.ToString(), args.Control, null);
        };
        text.MouseDown += delegate(object sender, MouseEventArgs args) {
            InputReceipt(form, text, "press", null, false, args.Button.ToString());
        };
        text.MouseUp += delegate(object sender, MouseEventArgs args) {
            InputReceipt(form, text, "release", null, false, args.Button.ToString());
        };
        form.Controls.Add(label);
        form.Controls.Add(text);
        RichTextBox sibling = null;
        TextBox privacyControl = null;
        if (rich || (key == "two" && richTest))
        {
            text.Size = new Size(425, 65);
            sibling = new RichTextBox();
            sibling.Location = new Point(16, 125);
            sibling.Size = new Size(425, 65);
            sibling.AccessibleName = "Synthetic sibling editor";
            sibling.Text = "SYNTHETIC_" + Token + "_RICH_SIBLING_BODY";
            form.Controls.Add(sibling);
            if (rich)
            {
                privacyControl = new TextBox();
                privacyControl.Location = new Point(16, 200);
                privacyControl.Size = new Size(425, 24);
                privacyControl.UseSystemPasswordChar = true;
                privacyControl.Text = "SYNTHETIC_" + Token + "_RICH_PASSWORD";
                privacyControl.Visible = false;
                form.Controls.Add(privacyControl);
            }
        }
        // Materialize every HWND before recording so creation is not confused
        // with the A -> B -> A foreground transition under test.
        IntPtr handle = form.Handle;
        return new Document { Form = form, Text = text, Sibling = sibling, PrivacyControl = privacyControl };
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
                if (action == "inputArm")
                {
                    string name = (string)command["name"];
                    if (Trial != null || Control.ModifierKeys != Keys.None ||
                        Control.MouseButtons != MouseButtons.None ||
                        (name != "return" && name != "shortcut" && name != "drag" && name != "click"))
                        throw new InvalidOperationException("Physical request cannot be armed.");
                    Document armDocument = Documents[(string)command["window"]];
                    RichTextBox armRich = armDocument.Text as RichTextBox;
                    Trial = new InputTrial { Id = (string)command["requestId"], Name = name,
                        Document = armDocument, Deadline = Convert.ToInt64(command["deadline"]),
                        Text = armDocument.Text.Text, Rtf = armRich == null ? null : armRich.Rtf };
                    if (Trial.Deadline <= Now() || Trial.Deadline - Now() > 12000 ||
                        (armRich != null && (!Trial.Rtf.Contains(@"\v") ||
                            !Trial.Text.Contains("SYNTHETIC_" + Token + "_HIDDEN_RICH_RUN") ||
                            !Trial.Text.Contains("SYNTHETIC_" + Token + "_BODY_A"))))
                        throw new InvalidOperationException("Physical request lacks a live hidden-context witness.");
                    InputContext(Trial);
                    InputWitnessing = true;
                    Emit(new { type = "ack", id = command["id"], action = action,
                        requestId = Trial.Id, at = Now(), contextPreserved = true,
                        hiddenPresent = Trial.Rtf != null,
                        inputWindowID = armDocument.Text.Handle.ToInt64(), foreground = Foreground() });
                    return;
                }
                if (action == "inputRetire")
                {
                    if (Trial == null || Trial.Id != (string)command["requestId"] || !Trial.Released)
                        throw new InvalidOperationException("Cannot retire an unmatched physical request.");
                    Pending = command;
                    ActivationStarted = Lifetime.ElapsedMilliseconds;
                    return;
                }
                if (Trial != null)
                    throw new InvalidOperationException("Retire physical input before changing its source.");
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
                if (action == "readCounts")
                {
                    Document countedDocument = Documents[(string)command["window"]];
                    CountedEdit counted = countedDocument.Text as CountedEdit;
                    if (counted == null) throw new InvalidOperationException("Expected standard Edit counter.");
                    Emit(new { type = "ack", id = command["id"], bodyReads = counted.BodyReads,
                        selectionReads = counted.SelectionReads, foreground = Foreground() });
                    return;
                }
                if (action != "show" && action != "edit" && action != "select" && action != "privacy")
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
                    ((TextBox)document.Text).UseSystemPasswordChar = (bool)command["password"];
                }
                if (action == "privacy")
                {
                    if (document.PrivacyControl == null)
                        throw new InvalidOperationException("Privacy action requires the Rich sibling fixture.");
                    document.PrivacyControl.Visible = (bool)command["visible"];
                }
                else if (action == "select")
                    document.Text.Select(Convert.ToInt32(command["start"]), Convert.ToInt32(command["length"]));
                else
                    document.Text.Text = (string)command["text"];
                if (action != "privacy" && command.ContainsKey("hidden"))
                {
                    RichTextBox rich = document.Text as RichTextBox;
                    string hidden = (string)command["hidden"];
                    string visible = (string)command["text"];
                    if (rich == null || !System.Text.RegularExpressions.Regex.IsMatch(
                        hidden + visible, @"^[A-Z0-9_a-f]+$"))
                        throw new InvalidOperationException("Hidden run requires synthetic RichTextBox markers.");
                    rich.Rtf = @"{\rtf1\ansi " + visible + @"{\v " + hidden + "}}";
                    if (!rich.Rtf.Contains(@"\v"))
                        throw new InvalidOperationException("Synthetic hidden run was not retained.");
                }
                if (action == "show")
                {
                    document.Form.Show();
                    ShowWindow(document.Form.Handle, 5);
                    foreach (Control control in document.Form.Controls)
                        if (control != document.PrivacyControl || control.Visible)
                            ShowWindow(control.Handle, 5);
                    document.Form.BringToFront();
                    document.Form.Activate();
                    document.Text.Focus();
                    SetForegroundWindow(document.Form.Handle);
                }
                Pending = command;
                ActivationStarted = Lifetime.ElapsedMilliseconds;
            }
            if (Pending != null && (string)Pending["action"] == "inputRetire")
            {
                InputContext(Trial);
                if (Control.ModifierKeys == Keys.None && Control.MouseButtons == MouseButtons.None)
                {
                    Emit(new { type = "ack", id = Pending["id"], action = "inputRetire",
                        requestId = Trial.Id, at = Now(), released = true, contextPreserved = true,
                        hiddenPresent = Trial.Rtf != null, foreground = Foreground() });
                    Trial = null;
                    Pending = null;
                }
                else if (Lifetime.ElapsedMilliseconds - ActivationStarted >= 2000)
                    throw new InvalidOperationException("Physical input did not release all keys/buttons.");
            }
            else if (Pending != null)
            {
                Document document = Documents[(string)Pending["window"]];
                if (GetForegroundWindow() == document.Form.Handle && document.Text.Focused &&
                    IsWindowVisible(document.Form.Handle) && IsWindowVisible(document.Text.Handle))
                {
                    StringBuilder nativeClass = new StringBuilder(128);
                    if (GetClassName(document.Text.Handle, nativeClass, nativeClass.Capacity) <= 0)
                        throw new InvalidOperationException("Synthetic input class lookup failed.");
                    Emit(new {
                        type = "ack", id = Pending["id"], action = Pending["action"],
                        window = Pending["window"], windowID = document.Form.Handle.ToInt64(),
                        processIdentifier = Process.GetCurrentProcess().Id,
                        title = document.Form.Text, text = document.Text.Text,
                        inputWindowID = document.Text.Handle.ToInt64(),
                        inputClass = nativeClass.ToString(),
                        inputPoint = document.Text.PointToScreen(new Point(20, 20)),
                        selectedText = document.Text.SelectedText, selectionStart = document.Text.SelectionStart,
                        password = document.Text is TextBox && ((TextBox)document.Text).UseSystemPasswordChar,
                        siblingWindowID = document.Sibling == null ? 0 : document.Sibling.Handle.ToInt64(),
                        siblingVisible = document.Sibling != null && IsWindowVisible(document.Sibling.Handle),
                        siblingFocused = document.Sibling != null && document.Sibling.Focused,
                        privacyVisible = document.PrivacyControl != null && document.PrivacyControl.Visible,
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
                Point pointer;
                GetCursorPos(out pointer);
                Emit(new { type = "heartbeat", at = Now(), foreground = Foreground(), pointer = pointer,
                    pointerWindowID = WindowFromPoint(pointer).ToInt64() });
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
