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
        var field = new ScrollField(mode);
        var window = new Window { Title = "maka-scroll-readback-fixture", Width = 440, Height = 160, Content = field };
        AutomationProperties.SetName(window, "maka-scroll-readback-fixture");
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

internal sealed class ScrollField(string mode) : TextBlock
{
    internal string Mode => mode;
    internal double Before => mode == "at-end" ? 100 : mode == "at-start" ? 0 : 40;
    internal double Actual;
    internal bool Horizontal;
    internal int Mutations;
    internal readonly Stopwatch SinceMutation = new();
    protected override AutomationPeer OnCreateAutomationPeer() => new ScrollPeer(this);
}

internal sealed class ScrollPeer(ScrollField field) : FrameworkElementAutomationPeer(field), IScrollProvider, IScrollItemProvider
{
    protected override string GetNameCore() => "Scroll readback target";
    protected override string GetAutomationIdCore() => "scroll-readback-target";
    protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Pane;
    protected override string GetClassNameCore() => "ScrollReadbackFixture";
    public override object? GetPattern(PatternInterface patternInterface) => patternInterface switch
    {
        PatternInterface.Scroll when field.Mode != "scrollitem-only" => this,
        PatternInterface.ScrollItem => this,
        _ => base.GetPattern(patternInterface),
    };
    public bool HorizontallyScrollable => field.Mode != "no-scroll" && !(field.Mode == "no-scroll-after" && field.Mutations > 0);
    public bool VerticallyScrollable => HorizontallyScrollable;
    public double HorizontalViewSize => 20;
    public double VerticalViewSize => 20;
    public double HorizontalScrollPercent => Position(true);
    public double VerticalScrollPercent => Position(false);
    double Position(bool horizontal)
    {
        if (field.Mode == "no-scroll") return -1;
        if (field.Mode == "invalid-before") return double.NaN;
        // The other axis must remain unchanged, so reading the wrong axis
        // cannot accidentally pass the directional readback test.
        if (field.Mutations == 0 || field.Horizontal != horizontal) return field.Before;
        if (field.Mode == "read-error") throw new ElementNotAvailableException();
        if (field.Mode == "invalid-after") return double.PositiveInfinity;
        if (field.Mode == "late") Thread.Sleep(1100);
        if (field.Mode == "never" || field.SinceMutation.ElapsedMilliseconds < 350) return field.Before;
        return field.Actual;
    }
    public void Scroll(ScrollAmount horizontalAmount, ScrollAmount verticalAmount)
    {
        var amount = horizontalAmount == ScrollAmount.NoAmount ? verticalAmount : horizontalAmount;
        var increment = amount is ScrollAmount.SmallIncrement or ScrollAmount.LargeIncrement;
        field.Mutations++;
        field.Horizontal = horizontalAmount != ScrollAmount.NoAmount;
        field.Actual = field.Before + (increment ? 20 : -20) * (field.Mode == "wrong-direction" ? -1 : 1);
        field.Text = $"Actual position: {field.Actual}; scroll calls: {field.Mutations}";
        field.SinceMutation.Restart();
        Program.Emit(new { kind = "mutation", position = field.Actual, count = field.Mutations,
            horizontalAmount = horizontalAmount.ToString(), verticalAmount = verticalAmount.ToString() });
        if (field.Mode == "name-change") AutomationProperties.SetName(Window.GetWindow(field), "changed-window-generation");
        if (field.Mode == "throw-after-scroll") throw new InvalidOperationException("provider threw after mutation");
    }
    public void SetScrollPercent(double horizontalPercent, double verticalPercent) => throw new NotSupportedException();
    public void ScrollIntoView() => Program.Emit(new { kind = "scroll-item-mutation" });
}
