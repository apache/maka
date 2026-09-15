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
if (-not $TestOnly -or $env:MAKA_HISTORY_WINDOWS_WPF_TEST -ne '1') {
    throw 'WPF acceptance requires explicit test-only opt in.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -ne 'Desktop') {
    throw 'Build the fixture with Windows PowerShell 5.1 and .NET Framework WPF.'
}
if ($OutputAssembly -notmatch '^[a-zA-Z]:\\' -or
    [IO.Path]::GetFileName($OutputAssembly) -notmatch '^maka-history-wpf-[a-f0-9]{32}\.exe$' -or
    [IO.File]::Exists($OutputAssembly)) {
    throw 'OutputAssembly must be a new, absolute, local run-specific executable.'
}

# The unique executable is the only admitted app; never allowlist PowerShell.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, UIAutomationProvider, UIAutomationTypes
$references = @(
    'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll',
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.Visual].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location,
    [System.Windows.Automation.Provider.IValueProvider].Assembly.Location,
    [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location
)
$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

internal sealed class UnsupportedSelectionButton : Button
{
    internal static int SelectionCalls;
    protected override AutomationPeer OnCreateAutomationPeer()
    {
        return new UnsupportedSelectionPeer(this);
    }
}

internal sealed class UnsupportedSelectionPeer : ButtonAutomationPeer, ITextProvider
{
    internal UnsupportedSelectionPeer(Button owner) : base(owner) { }
    public override object GetPattern(PatternInterface pattern)
    {
        return pattern == PatternInterface.Text ? this : base.GetPattern(pattern);
    }
    public ITextRangeProvider[] GetSelection()
    {
        UnsupportedSelectionButton.SelectionCalls++;
        throw new NotImplementedException("Synthetic optional selection is not implemented.");
    }
    public ITextRangeProvider DocumentRange { get { throw new NotImplementedException(); } }
    public SupportedTextSelection SupportedTextSelection { get { return SupportedTextSelection.None; } }
    public ITextRangeProvider[] GetVisibleRanges() { throw new NotImplementedException(); }
    public ITextRangeProvider RangeFromChild(IRawElementProviderSimple child) { throw new NotImplementedException(); }
    public ITextRangeProvider RangeFromPoint(Point point) { throw new NotImplementedException(); }
}

internal static class WpfHistoryFixture
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);

    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object OutputLock = new object();
    private static readonly Stopwatch Lifetime = Stopwatch.StartNew();
    private static volatile bool InputEnded;
    private static volatile bool Finished;
    private static Window Window;
    private static StackPanel Panel;
    private static Control Editor;
    private static PasswordBox Password;
    private static IntPtr Hwnd;
    private static string Mode;
    private static int EditorInstance;
    private static Dictionary<string, object> Pending;
    private static long PendingAt;

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
        IntPtr hwnd = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return new { windowID = hwnd.ToInt64(), processIdentifier = pid };
    }

    private static string Body()
    {
        Button button = Editor as Button;
        if (button != null) return (string)button.Content;
        TextBox plain = Editor as TextBox;
        if (plain != null) return plain.Text.Replace("\r\n", "\n");
        FlowDocument document = ((RichTextBox)Editor).Document;
        return new TextRange(document.ContentStart, document.ContentEnd).Text.TrimEnd('\r', '\n').Replace("\r\n", "\n");
    }

    private static void SetBody(string text)
    {
        Button button = Editor as Button;
        if (button != null) { button.Content = text; return; }
        TextBox plain = Editor as TextBox;
        if (plain != null) plain.Text = text;
        else
        {
            FlowDocument document = ((RichTextBox)Editor).Document;
            document.Blocks.Clear();
            document.Blocks.Add(new Paragraph(new Run(text)));
        }
    }

    private static void SelectEditor(string mode)
    {
        if (mode == Mode) return;
        if (mode != "textbox" && mode != "richtextbox" && mode != "button" && mode != "unsupported-selection")
            throw new InvalidOperationException("Unknown editor.");
        Panel.Children.Clear();
        Password = null;
        Panel.Children.Add(new TextBlock { Text = "Synthetic WPF notes", Margin = new Thickness(0, 0, 0, 12) });
        if (mode == "textbox") Editor = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap };
        else if (mode == "richtextbox") Editor = new RichTextBox { Document = new FlowDocument() };
        else if (mode == "button") Editor = new Button();
        else Editor = new UnsupportedSelectionButton();
        Editor.Height = 170;
        Editor.FontSize = 18;
        AutomationProperties.SetName(Editor, "Synthetic editor");
        AutomationProperties.SetAutomationId(Editor, "synthetic-editor");
        Panel.Children.Add(Editor);
        Mode = mode;
        EditorInstance++;
    }

    private static void SetPassword(bool enabled, string secret)
    {
        if (enabled)
        {
            if (Password != null) throw new InvalidOperationException("PasswordBox already present.");
            Password = new PasswordBox { Height = 32, Margin = new Thickness(0, 12, 0, 0) };
            AutomationProperties.SetName(Password, "Synthetic credential");
            Password.Password = secret;
            Panel.Children.Add(Password);
        }
        else if (Password != null)
        {
            Password.Clear();
            Panel.Children.Remove(Password);
            Password = null;
        }
    }

    private static bool Ready()
    {
        return GetForegroundWindow() == Hwnd && IsWindowVisible(Hwnd) &&
            Window.IsActive && Editor.IsVisible && Editor.ActualHeight > 0 &&
            Editor.IsKeyboardFocusWithin &&
            (Password == null || (Password.IsVisible && Password.ActualHeight > 0));
    }

    private static void DescribePeer(AutomationPeer peer, string root, int parent, int depth,
        List<object> nodes, HashSet<AutomationPeer> seen, Stopwatch timer, ref bool truncated)
    {
        if (peer == null) throw new InvalidOperationException("Synthetic control has no automation peer.");
        if (nodes.Count >= 64 || depth > 8 || timer.ElapsedMilliseconds >= 250 || !seen.Add(peer))
        {
            truncated = true;
            return;
        }
        // Inspect only owned peer metadata; never invoke Value or TextRange getters.
        List<AutomationPeer> children = peer.GetChildren();
        int index = nodes.Count;
        nodes.Add(new {
            index = index, parent = parent, depth = depth, root = root,
            peerType = peer.GetType().FullName, className = peer.GetClassName(),
            role = peer.GetAutomationControlType().ToString(),
            password = peer.IsPassword(), offscreen = peer.IsOffscreen(),
            valuePattern = peer.GetPattern(PatternInterface.Value) != null,
            textPattern = peer.GetPattern(PatternInterface.Text) != null,
            childCount = children == null ? 0 : children.Count
        });
        if (timer.ElapsedMilliseconds >= 250) truncated = true;
        if (children == null) return;
        foreach (AutomationPeer child in children)
        {
            DescribePeer(child, root, index, depth + 1, nodes, seen, timer, ref truncated);
            if (truncated) break;
        }
    }

    private static object PeerDiagnostics()
    {
        List<object> nodes = new List<object>();
        HashSet<AutomationPeer> seen = new HashSet<AutomationPeer>();
        Stopwatch timer = Stopwatch.StartNew();
        bool truncated = false;
        DescribePeer(UIElementAutomationPeer.CreatePeerForElement(Editor),
            "editor", -1, 0, nodes, seen, timer, ref truncated);
        if (Password != null && !truncated)
            DescribePeer(UIElementAutomationPeer.CreatePeerForElement(Password),
                "password", -1, 0, nodes, seen, timer, ref truncated);
        return new {
            source = "owned-wpf-peers", assembly = typeof(TextBoxAutomationPeer).Assembly.FullName,
            nodes = nodes, truncated = truncated, elapsedMs = timer.ElapsedMilliseconds
        };
    }

    private static void Tick(object sender, EventArgs args)
    {
        try
        {
            if (InputEnded) { Application.Current.Shutdown(); return; }
            string line;
            if (Pending == null && Commands.TryDequeue(out line))
            {
                Pending = Json.Deserialize<Dictionary<string, object>>(line);
                string action = (string)Pending["action"];
                if (action != "show" && action != "edit" && action != "password" && action != "inspect")
                    throw new InvalidOperationException("Unknown fixture action.");
                if (action != "show" && !Ready())
                    throw new InvalidOperationException("Fixture lost visible foreground/focus before command.");
                if (action == "show")
                {
                    SetPassword(false, "");
                    SelectEditor((string)Pending["mode"]);
                    Window.Show();
                    ShowWindow(Hwnd, 5);
                    Window.Activate();
                    SetForegroundWindow(Hwnd);
                }
                if (action == "password")
                    SetPassword((bool)Pending["enabled"], Pending.ContainsKey("secret") ? (string)Pending["secret"] : "");
                if (Pending.ContainsKey("text")) SetBody((string)Pending["text"]);
                if (action != "inspect")
                {
                    Window.UpdateLayout();
                    Editor.Focus();
                }
                PendingAt = Lifetime.ElapsedMilliseconds;
                return; // Let WPF layout/render/automation notifications run before acknowledging.
            }
            if (Pending == null) return;
            if (!Ready())
            {
                if (Lifetime.ElapsedMilliseconds - PendingAt >= 2000)
                    throw new InvalidOperationException("WPF fixture did not reach visible foreground readiness.");
                return;
            }
            if ((string)Pending["action"] == "inspect" && Pending.ContainsKey("selectionProbe"))
            {
                Emit(new {
                    type = "ack", id = Pending["id"], action = Pending["action"],
                    processIdentifier = Process.GetCurrentProcess().Id, windowID = Hwnd.ToInt64(),
                    title = Window.Title, mode = Mode, foreground = Foreground(),
                    selectionCalls = UnsupportedSelectionButton.SelectionCalls
                });
                Pending = null;
                return;
            }
            if ((string)Pending["action"] == "inspect" &&
                Pending.ContainsKey("peers") && (bool)Pending["peers"])
            {
                object peers = PeerDiagnostics();
                if (!Ready()) throw new InvalidOperationException("Fixture lost foreground during peer inspection.");
                Emit(new {
                    type = "ack", id = Pending["id"], action = Pending["action"],
                    processIdentifier = Process.GetCurrentProcess().Id, windowID = Hwnd.ToInt64(),
                    title = Window.Title, mode = Mode, editorInstance = EditorInstance,
                    foreground = Foreground(), metadataOnly = true, peers = peers
                });
                Pending = null;
                return;
            }
            Emit(new {
                type = "ack", id = Pending["id"], action = Pending["action"],
                processIdentifier = Process.GetCurrentProcess().Id, windowID = Hwnd.ToInt64(),
                title = Window.Title, mode = Mode, editorInstance = EditorInstance,
                text = Body(), password = Password != null,
                passwordLength = Password == null ? 0 : Password.Password.Length,
                foreground = Foreground()
            });
            Pending = null;
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            Application.Current.Shutdown(1);
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false, true)) { AutoFlush = true });
            if (Environment.GetEnvironmentVariable("MAKA_HISTORY_WINDOWS_WPF_TEST") != "1" ||
                args.Length != 2 || !Environment.UserInteractive ||
                !System.Text.RegularExpressions.Regex.IsMatch(args[1], "^[a-f0-9]{32}$"))
                throw new InvalidOperationException("Interactive test-only opt in is required.");
            using (Process parent = Process.GetProcessById(Int32.Parse(args[0])))
            {
                IntPtr retainedParent = parent.Handle;
                if (parent.HasExited || parent.SessionId != Process.GetCurrentProcess().SessionId)
                    throw new InvalidOperationException("Fixture must share the Node parent's interactive session.");
                Thread watchdog = new Thread(delegate() {
                    long eofAt = -1;
                    while (!Finished)
                    {
                        if (parent.HasExited || Lifetime.ElapsedMilliseconds >= 125000) Environment.Exit(2);
                        if (InputEnded && eofAt < 0) eofAt = Lifetime.ElapsedMilliseconds;
                        if (eofAt >= 0 && Lifetime.ElapsedMilliseconds - eofAt > 1500) Environment.Exit(2);
                        Thread.Sleep(100);
                    }
                });
                watchdog.IsBackground = true;
                watchdog.Start();
                try
                {
                    Thread reader = new Thread(delegate() {
                        try
                        {
                            string line;
                            while ((line = Console.In.ReadLine()) != null)
                            {
                                if (line.Length > 16384) throw new InvalidOperationException("Oversized fixture command.");
                                Commands.Enqueue(line);
                            }
                        }
                        catch (Exception error)
                        {
                            Emit(new { type = "error", message = error.Message });
                        }
                        finally { InputEnded = true; }
                    });
                    reader.IsBackground = true;
                    reader.Start();
                    RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
                    Application app = new Application();
                    Panel = new StackPanel { Margin = new Thickness(20) };
                    Window = new Window {
                        Title = "Maka synthetic WPF " + args[1], Width = 620, Height = 380,
                        Left = 60, Top = 60, ResizeMode = ResizeMode.NoResize, Content = Panel
                    };
                    SelectEditor("textbox");
                    Hwnd = new WindowInteropHelper(Window).EnsureHandle();
                    DispatcherTimer timer = new DispatcherTimer(DispatcherPriority.ApplicationIdle);
                    timer.Interval = TimeSpan.FromMilliseconds(50);
                    timer.Tick += Tick;
                    timer.Start();
                    Emit(new {
                        type = "ready", processIdentifier = Process.GetCurrentProcess().Id,
                        sessionId = Process.GetCurrentProcess().SessionId, windowID = Hwnd.ToInt64(),
                        administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)
                    });
                    int result = app.Run();
                    timer.Stop();
                    return result;
                }
                finally
                {
                    Finished = true;
                    watchdog.Join(500);
                }
            }
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            return 1;
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $references `
    -OutputAssembly $OutputAssembly -OutputType WindowsApplication
[Console]::Out.WriteLine('synthetic-wpf-fixture-built')
