using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Interop;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        var mode = args.FirstOrDefault() ?? "delayed";
        var app = new Application();
        var field = new DelayedField(mode);
        var window = new Window { Title = "maka-value-readback-fixture", Width = 440, Height = 160, Content = field };
        // WPF otherwise derives the Window UIA name from its sole TextBox
        // content. Keep identity stable except in the explicit invalidation case.
        if (mode != "name-change") AutomationProperties.SetName(window, "maka-value-readback-fixture");
        window.Loaded += (_, _) => Emit(new { kind = "ready", pid = Environment.ProcessId, hwnd = new WindowInteropHelper(window).Handle.ToInt64(), mode });
        _ = Task.Run(() =>
        {
            while (Console.ReadLine() is { } line)
                if (line == "shutdown") { window.Dispatcher.Invoke(window.Close); break; }
        });
        app.Run(window);
    }
    internal static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
}

internal sealed class DelayedField(string mode) : TextBox
{
    internal string Mode => mode;
    internal string Actual = "";
    internal int Mutations;
    internal readonly Stopwatch SinceMutation = new();
    protected override AutomationPeer OnCreateAutomationPeer() => new DelayedPeer(this);
}

internal sealed class DelayedPeer(DelayedField field) : FrameworkElementAutomationPeer(field), IValueProvider
{
    protected override string GetNameCore() => "Readback target";
    protected override string GetAutomationIdCore() => "readback-target";
    protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Edit;
    protected override string GetClassNameCore() => "ValueReadbackFixture";
    protected override bool IsPasswordCore() => field.Mode == "password" || (field.Mode == "protect-after-write" && field.Mutations > 0);
    public override object? GetPattern(PatternInterface patternInterface) => patternInterface == PatternInterface.Value ? this : base.GetPattern(patternInterface);
    public bool IsReadOnly => false;
    public string Value
    {
        get
        {
            if (field.Mutations == 0) return "";
            if (field.Mode == "read-error") throw new ElementNotAvailableException();
            if (field.Mode == "never" || field.SinceMutation.ElapsedMilliseconds < 350) return "";
            return field.Actual;
        }
    }
    public void SetValue(string value)
    {
        field.Mutations++;
        field.Actual = value;
        field.Text = value;
        field.SinceMutation.Restart();
        // Independent application evidence, not helper readback. The visible
        // field changes immediately while UIA intentionally lags behind it.
        Program.Emit(new { kind = "mutation", value, count = field.Mutations });
        if (field.Mode == "throw-after-write") throw new InvalidOperationException("provider threw after mutation");
    }
}
