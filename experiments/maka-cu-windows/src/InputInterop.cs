using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

// WinUser.h INPUT ABI.  The union is sized by MOUSEINPUT on both x86 and
// x64, not by KEYBDINPUT.  Keeping all three members here is important even
// though this helper only emits keyboard input: SendInput validates cbSize
// against sizeof(INPUT) before it accepts the batch.
[StructLayout(LayoutKind.Sequential)]
struct INPUT
{
    public uint type;
    public INPUTUNION U;
}

[StructLayout(LayoutKind.Explicit)]
struct INPUTUNION
{
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
}

[StructLayout(LayoutKind.Sequential)]
struct MOUSEINPUT
{
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
struct KEYBDINPUT
{
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
struct HARDWAREINPUT
{
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
}

static class InputAbi
{
    public static int InputSize => Marshal.SizeOf<INPUT>();
    public static int UnionSize => Marshal.SizeOf<INPUTUNION>();
    public static int MouseInputSize => Marshal.SizeOf<MOUSEINPUT>();
    public static int KeyboardInputSize => Marshal.SizeOf<KEYBDINPUT>();
    public static int HardwareInputSize => Marshal.SizeOf<HARDWAREINPUT>();
    public static int TypeOffset => Marshal.OffsetOf<INPUT>(nameof(INPUT.type)).ToInt32();
    public static int UnionOffset => Marshal.OffsetOf<INPUT>(nameof(INPUT.U)).ToInt32();
    public static int SendInputCbSize => InputSize;
}

readonly record struct SendInputReport(int Requested, uint Inserted, int CbSize, int LastError)
{
    public bool Complete => Inserted == (uint)Requested;

    public JsonObject ToJson() => new()
    {
        ["requested"] = Requested,
        ["inserted"] = Inserted,
        ["cbSize"] = CbSize,
        ["lastError"] = LastError,
        ["complete"] = Complete,
    };
}
