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
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, UIAutomationProvider, UIAutomationTypes, UIAutomationClient
$references = @(
    'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll',
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.Visual].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location,
    [System.Windows.Automation.Provider.IValueProvider].Assembly.Location,
    [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location,
    [System.Windows.Automation.AutomationElement].Assembly.Location
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
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

internal static class WpfQpcClock
{
    internal static string Nanoseconds(long counter, long frequency)
    {
        if (counter <= 0 || frequency <= 0)
            throw new InvalidOperationException("Invalid QPC counter or frequency.");
        // Match Node 24.18.1 libuv win/util.c uv__hrtime, including division order.
        double scaledFrequency = (double)frequency / 1000000000;
        double result = (double)counter / scaledFrequency;
        if (result >= 18446744073709551616.0)
            throw new InvalidOperationException("QPC nanoseconds exceed UInt64.");
        return checked((ulong)result).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    internal static string Sample()
    {
        if (!Environment.Is64BitProcess || !Stopwatch.IsHighResolution)
            throw new InvalidOperationException("QPC readiness requires 64-bit high-resolution Stopwatch.");
        return Nanoseconds(Stopwatch.GetTimestamp(), Stopwatch.Frequency);
    }
}

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
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public uint size, flags;
        public IntPtr active, focus, capture, menuOwner, moveSize, caret;
        public int left, top, right, bottom;
    }

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
    private static Run BodyRun;
    private static string Witness;
    private static TextBox FirstField, SecondField;
    private static Dictionary<string, object> Armed;
    private static volatile object IdentityResult;
    private static volatile string IdentityError;
    private static bool ReadingIdentity;
    private static readonly bool RecorderMode =
        Environment.GetEnvironmentVariable("MAKA_HISTORY_WINDOWS_WPF_RECORDER_TEST") == "1";

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

    private static long InputWindow()
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(Hwnd, out pid);
        GuiThreadInfo info = new GuiThreadInfo();
        info.size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo));
        if (pid != Process.GetCurrentProcess().Id || !GetGUIThreadInfo(thread, ref info) ||
            info.active != Hwnd || info.focus != Hwnd)
            throw new InvalidOperationException("Synthetic WPF keyboard host is not the root HWND.");
        return info.focus.ToInt64();
    }

    private static string FieldName()
    {
        return Editor == FirstField ? "one" : Editor == SecondField ? "two" : null;
    }

    private static void FocusField(string field)
    {
        if (Mode != "fields" || (field != "one" && field != "two"))
            throw new InvalidOperationException("Unknown synthetic field.");
        Editor = field == "one" ? FirstField : SecondField;
        Editor.Focus();
    }

    private static void ReceivedKey(object sender, KeyEventArgs args)
    {
        if (Armed == null || sender != Editor) return;
        bool control = (Keyboard.Modifiers & ModifierKeys.Control) != 0;
        string name = args.Key == Key.Return && !control ? "return" :
            args.Key == Key.A && control ? "shortcut" : null;
        if (name == null || name != (string)Armed["name"]) return;
        long keyDownAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Ready()) throw new InvalidOperationException("Physical key lost synthetic focus.");
        string field = FieldName();
        TextBox receivedBy = (TextBox)Editor;
        long host = InputWindow();
        string key = args.Key.ToString();
        Dictionary<string, object> request = Armed;
        Armed = null;
        // Change focus before the recorder can revalidate the buffered key.
        // Do not manufacture input, mark the key handled, or change its payload.
        if (request.ContainsKey("switchTo")) FocusField((string)request["switchTo"]);
        Window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(delegate() {
            DateTimeOffset settled = DateTimeOffset.UtcNow;
            Emit(new {
                type = "input.received", requestId = request["requestId"], name = name,
                key = key, control = control, field = field,
                fieldAfter = FieldName(), editorInstance = EditorInstance,
                processIdentifier = Process.GetCurrentProcess().Id, windowID = Hwnd.ToInt64(),
                inputWindowID = host, foreground = Foreground(), password = Password != null,
                selectionStart = receivedBy.SelectionStart, selectionLength = receivedBy.SelectionLength,
                bodyLength = receivedBy.Text.Length, keyDownAt = keyDownAt,
                settledAt = settled.ToUnixTimeMilliseconds(), timestamp = settled.ToString("o")
            });
        }));
    }

    private static void BeginIdentity()
    {
        string field = FieldName();
        string automationId = AutomationProperties.GetAutomationId(Editor);
        int pid = Process.GetCurrentProcess().Id;
        IntPtr hwnd = Hwnd;
        ReadingIdentity = true;
        IdentityResult = null;
        IdentityError = null;
        // An external UIA view is needed for the complete engine runtime ID.
        // Keep the STA pumping; this MTA reads only the owned focused element.
        Thread reader = new Thread(delegate() {
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                AutomationElement focused = AutomationElement.FocusedElement;
                if (root.Current.ProcessId != pid || root.Current.NativeWindowHandle != hwnd.ToInt32() ||
                    focused.Current.ProcessId != pid || focused.Current.AutomationId != automationId ||
                    focused.Current.FrameworkId != "WPF" || !focused.Current.HasKeyboardFocus ||
                    focused.Current.IsOffscreen || focused.Current.IsPassword)
                    throw new InvalidOperationException("Synthetic UIA focus identity disagrees with WPF.");
                AutomationElement ancestor = focused;
                int depth = 0;
                while (!Automation.Compare(ancestor, root))
                {
                    if (++depth > 16 || ancestor.Current.ProcessId != pid)
                        throw new InvalidOperationException("Synthetic UIA focus left its root.");
                    ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
                    if (ancestor == null) throw new InvalidOperationException("Missing synthetic UIA ancestor.");
                }
                int[] runtimeId = focused.GetRuntimeId();
                int[] rootRuntimeId = root.GetRuntimeId();
                if (runtimeId.Length == 0 || runtimeId.Length > 32 ||
                    rootRuntimeId.Length == 0 || rootRuntimeId.Length > 32 ||
                    !Automation.Compare(focused, AutomationElement.FocusedElement) ||
                    GetForegroundWindow() != hwnd)
                    throw new InvalidOperationException("Synthetic UIA identity changed during inspection.");
                IdentityResult = new {
                    field = field, automationId = automationId, framework = focused.Current.FrameworkId,
                    runtimeId = runtimeId, rootRuntimeId = rootRuntimeId,
                    processIdentifier = pid, windowID = hwnd.ToInt64(), inputWindowID = InputWindow()
                };
            }
            catch (Exception error) { IdentityError = error.Message; }
        });
        reader.IsBackground = true;
        reader.SetApartmentState(ApartmentState.MTA);
        reader.Start();
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
            BodyRun = new Run(text);
            document.Blocks.Add(new Paragraph(BodyRun));
        }
    }

    private static void SelectEditor(string mode)
    {
        if (mode == Mode) return;
        if (mode != "textbox" && mode != "richtextbox" && mode != "button" &&
            mode != "unsupported-selection" && !(RecorderMode && mode == "fields"))
            throw new InvalidOperationException("Unknown editor.");
        Panel.Children.Clear();
        Password = null;
        Panel.Children.Add(new TextBlock { Text = "Synthetic WPF notes", Margin = new Thickness(0, 0, 0, 12) });
        FirstField = SecondField = null;
        if (mode == "textbox" || mode == "fields") Editor = new TextBox {
            AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        else if (mode == "richtextbox") Editor = new RichTextBox {
            Document = new FlowDocument(), VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        else if (mode == "button") Editor = new Button();
        else Editor = new UnsupportedSelectionButton();
        Editor.Height = 170;
        Editor.FontSize = 18;
        AutomationProperties.SetName(Editor, "Synthetic editor");
        AutomationProperties.SetAutomationId(Editor, "synthetic-editor");
        Panel.Children.Add(Editor);
        if (mode == "fields")
        {
            FirstField = (TextBox)Editor;
            FirstField.Height = 80;
            AutomationProperties.SetAutomationId(FirstField, "synthetic-editor-one");
            SecondField = new TextBox {
                Height = 80, FontSize = 18, Margin = new Thickness(0, 8, 0, 0),
                AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto
            };
            AutomationProperties.SetName(SecondField, "Synthetic second editor");
            AutomationProperties.SetAutomationId(SecondField, "synthetic-editor-two");
            Panel.Children.Add(SecondField);
            foreach (TextBox field in new [] { FirstField, SecondField })
                field.AddHandler(Keyboard.PreviewKeyDownEvent, new KeyEventHandler(ReceivedKey), true);
        }
        Mode = mode;
        EditorInstance++;
    }

    private static object ScrollWitness()
    {
        if (String.IsNullOrEmpty(Witness)) return null;
        string body = Body();
        int index = body.IndexOf(Witness, StringComparison.Ordinal);
        if (index < 0) throw new InvalidOperationException("Missing synthetic scroll witness.");
        Rect bounds;
        double offset, extent, viewport;
        TextBox plain = Editor as TextBox;
        if (plain != null)
        {
            bounds = plain.GetRectFromCharacterIndex(index);
            offset = plain.VerticalOffset; extent = plain.ExtentHeight; viewport = plain.ViewportHeight;
        }
        else
        {
            RichTextBox rich = (RichTextBox)Editor;
            TextPointer point = BodyRun.ContentStart.GetPositionAtOffset(index, LogicalDirection.Forward);
            bounds = point.GetCharacterRect(LogicalDirection.Forward);
            offset = rich.VerticalOffset; extent = rich.ExtentHeight; viewport = rich.ViewportHeight;
        }
        bool visible = !bounds.IsEmpty && bounds.Top >= 0 && bounds.Bottom <= Editor.ActualHeight;
        return new { witness = Witness, visible = visible, offset = offset, extent = extent, viewport = viewport };
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
            if (Armed != null)
            {
                string witnessedQpcNs = WpfQpcClock.Sample();
                long witnessedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (!Ready()) throw new InvalidOperationException("Armed synthetic input lost focus.");
                Emit(new {
                    type = "input.ready", requestId = Armed["requestId"], field = FieldName(),
                    editorInstance = EditorInstance, inputWindowID = InputWindow(),
                    foreground = Foreground(), password = Password != null, witnessedAt = witnessedAt, witnessedQpcNs = witnessedQpcNs
                });
            }
            string line;
            if (Pending == null && Commands.TryDequeue(out line))
            {
                Pending = Json.Deserialize<Dictionary<string, object>>(line);
                string action = (string)Pending["action"];
                bool inputAction = RecorderMode &&
                    (action == "focus" || action == "identity" || action == "arm" || action == "disarm");
                if (action != "show" && action != "edit" && action != "password" &&
                    action != "inspect" && action != "scroll" && !inputAction)
                    throw new InvalidOperationException("Unknown fixture action.");
                if (action != "show" && !Ready())
                    throw new InvalidOperationException("Fixture lost visible foreground/focus before command.");
                if (action == "show")
                {
                    Witness = null;
                    SetPassword(false, "");
                    SelectEditor((string)Pending["mode"]);
                    Window.Show();
                    ShowWindow(Hwnd, 5);
                    Window.Activate();
                    SetForegroundWindow(Hwnd);
                }
                if (action == "password")
                    SetPassword((bool)Pending["enabled"], Pending.ContainsKey("secret") ? (string)Pending["secret"] : "");
                if (action == "focus") FocusField((string)Pending["field"]);
                if (action == "disarm") Armed = null;
                if (action == "arm")
                {
                    if (Armed != null || Mode != "fields" || (string)Pending["field"] != FieldName() ||
                        ((string)Pending["name"] != "return" && (string)Pending["name"] != "shortcut"))
                        throw new InvalidOperationException("Invalid synthetic input request.");
                    Armed = Pending;
                }
                if (action == "identity") BeginIdentity();
                if (Pending.ContainsKey("text")) SetBody((string)Pending["text"]);
                if (action == "scroll")
                {
                    Witness = (string)Pending["witness"];
                    bool end = (string)Pending["position"] == "end";
                    TextBox plain = Editor as TextBox;
                    if (plain != null) { if (end) plain.ScrollToEnd(); else plain.ScrollToHome(); }
                    else { if (end) ((RichTextBox)Editor).ScrollToEnd(); else ((RichTextBox)Editor).ScrollToHome(); }
                }
                if (action != "inspect" && action != "identity" && action != "arm" && action != "disarm")
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
            if (ReadingIdentity)
            {
                if (IdentityError != null) throw new InvalidOperationException(IdentityError);
                if (IdentityResult == null)
                {
                    if (Lifetime.ElapsedMilliseconds - PendingAt > 2000)
                        throw new InvalidOperationException("Synthetic UIA identity query timed out.");
                    return;
                }
                Emit(new {
                    type = "ack", id = Pending["id"], action = Pending["action"],
                    processIdentifier = Process.GetCurrentProcess().Id, windowID = Hwnd.ToInt64(),
                    title = Window.Title, mode = Mode, editorInstance = EditorInstance,
                    foreground = Foreground(), identity = IdentityResult
                });
                ReadingIdentity = false;
                Pending = null;
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
                scroll = ScrollWitness(),
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
                        if (parent.HasExited || Lifetime.ElapsedMilliseconds >= (RecorderMode ? 205000 : 125000))
                            Environment.Exit(2);
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
                                if (line.Length > 131072) throw new InvalidOperationException("Oversized fixture command.");
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
