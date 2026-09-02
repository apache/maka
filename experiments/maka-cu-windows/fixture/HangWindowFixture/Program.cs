// SPDX-License-Identifier: Apache-2.0
//
// Deterministic test fixture for the maka-cu-windows spike (checks 4-6 and
// identity cases). A WinForms window with a TextBox (ValuePattern), a Button
// (InvokePattern) and a static Label. Stdin line protocol:
//   freeze    - block the UI thread (message pump stops -> window becomes
//               Not Responding -> UIA provider calls block: a REAL blocked
//               provider call, not a sleep inside the helper)
//   unfreeze  - resume the UI thread
//   cover     - show a larger, topmost solid-red window over the main window
//   uncover   - hide the cover
//   recreate  - close + recreate the main window (new HWND, new generation)
//   shutdown  - exit
// stdout:
//   READY <pid> <hwnd>
//   SIZE <w> <h>   (physical window rect via GetWindowRect, after recreate too)

using System.Runtime.InteropServices;
using System.Windows.Forms;

var fixture = new Fixture();
fixture.Run();

sealed class Fixture
{
    const string WindowTitle = "maka-cu-windows-fixture";

    Form _form = null!;
    Form? _cover;
    readonly ManualResetEventSlim _freezeEvent = new(false);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int valueSize);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    public void Run()
    {
        // WGC reports physical pixels. Set per-monitor awareness before any
        // WinForms handle is created so SIZE and capture ContentSize agree.
        _ = SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        CreateForm();
        // The independent ApplicationContext does not auto-show a form.
        _form.Show();

        var reader = new Thread(() =>
        {
            while (Console.ReadLine() is { } line)
            {
                try
                {
                    switch (line.Trim())
                    {
                        case "freeze":
                            // Runs on the UI thread; the pump stops while it waits.
                            _freezeEvent.Reset();
                            _form.BeginInvoke(() =>
                            {
                                Console.WriteLine("FROZEN");
                                Console.Out.Flush();
                                _freezeEvent.Wait();
                            });
                            break;
                        case "unfreeze":
                            _freezeEvent.Set();
                            Console.WriteLine("UNFROZEN");
                            Console.Out.Flush();
                            break;
                        case "cover": OnUi(ShowCover); break;
                        case "uncover": OnUi(HideCover); break;
                        case "recreate": OnUi(Recreate); break;
                        case "shutdown": OnUi(() => Application.Exit()); return;
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"CMD_ERROR {ex.GetType().Name}: {ex.Message}");
                    Console.Out.Flush();
                }
            }
        }) { IsBackground = true, Name = "cmd-reader" };
        reader.Start();

        // Use an independent application context so a test recreation can
        // dispose the original form without ending the message loop.
        Application.Run(new ApplicationContext());
    }

    void OnUi(Action a)
    {
        Form f;
        lock (this) { f = _form; }
        f.Invoke(a);
    }

    void CreateForm()
    {
        var form = new Form
        {
            Text = WindowTitle,
            Width = 480,
            Height = 360,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.White,
        };
        var label = new Label
        {
            Text = "maka-cu-windows-fixture static content",
            AutoSize = true,
            Location = new Point(16, 16),
        };
        var input = new TextBox
        {
            Name = "fixture-input",
            Text = "",
            Width = 300,
            Location = new Point(16, 48),
        };
        var button = new Button
        {
            Name = "fixture-button",
            Text = "fixture-button",
            Width = 120,
            Location = new Point(16, 88),
        };
        var sentinel = new Panel
        {
            Name = "fixture-sentinel",
            BackColor = Color.LimeGreen,
            Width = 80,
            Height = 50,
            Location = new Point(360, 220),
        };
        form.Controls.Add(label);
        form.Controls.Add(input);
        form.Controls.Add(button);
        form.Controls.Add(sentinel);
        form.FormClosed += (sender, _) =>
        {
            // Recreate disposes the old form after installing the replacement;
            // only the current top-level form owns application shutdown.
            lock (this)
            {
                if (ReferenceEquals(sender, _form)) Application.Exit();
            }
        };

        lock (this) { _form = form; }
        form.Shown += (_, _) => PrintSize();
    }

    void PrintSize()
    {
        IntPtr h = _form.Handle;
        if (GetWindowRect(h, out var r))
        {
            Console.WriteLine($"READY {Environment.ProcessId} {h.ToInt64()}");
            Console.WriteLine($"SIZE {r.Right - r.Left} {r.Bottom - r.Top}");
            // WGC excludes invisible resize borders. Keep this physical
            // capture contract separate from the outer GetWindowRect value.
            if (DwmGetWindowAttribute(h, 9, out var frame, Marshal.SizeOf<RECT>()) == 0)
                Console.WriteLine($"CAPTURE_SIZE {frame.Right - frame.Left} {frame.Bottom - frame.Top}");
            Console.Out.Flush();
        }
    }

    void Recreate()
    {
        var old = _form;
        old.Hide();
        CreateForm();
        _form.Show();
        old.Dispose();
    }

    void ShowCover()
    {
        if (_cover is not null && !_cover.IsDisposed) return;
        var main = _form;
        var b = main.Bounds;
        b.Inflate(60, 60);
        _cover = new Form
        {
            Text = "maka-cu-windows-fixture-cover",
            StartPosition = FormStartPosition.Manual,
            Bounds = b,
            BackColor = Color.Red,
            TopMost = true,
            ShowInTaskbar = false,
        };
        _cover.Show(main);
        _cover.BringToFront();
        Console.WriteLine("COVERED");
        Console.Out.Flush();
    }

    void HideCover()
    {
        if (_cover is null || _cover.IsDisposed) return;
        _cover.Close();
        _cover = null;
        Console.WriteLine("UNCOVERED");
        Console.Out.Flush();
    }
}
