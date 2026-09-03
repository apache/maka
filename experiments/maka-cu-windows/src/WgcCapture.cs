/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// SPDX-License-Identifier: Apache-2.0
//
// WGC capture interop for the spike helper (check 4): target-window capture
// via IGraphicsCaptureItemInterop::CreateForWindow(HWND), one frame acquired
// through a Direct3D11 frame pool, pixels copied through a D3D11 staging
// texture and encoded as PNG so the occlusion test has real bytes to compare.
// No screen-rectangle fallback anywhere: any failure reports
// capture_unavailable with a typed reason.
//
// Also hosts the window-generation fingerprint (check 2 identity), which
// shares the RuntimeId / window-property machinery.

using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Automation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

static class WgcCapture
{
    const uint D3D11_SDK_VERSION = 7;
    const uint D3D_DRIVER_TYPE_HARDWARE = 1;
    const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    const uint D3D11_USAGE_STAGING = 3;
    const uint D3D11_CPU_ACCESS_READ = 0x20000;
    const uint D3D11_MAP_READ = 1;
    const long MAX_CAPTURE_PIXELS = 16_000_000;
    const int MAX_PNG_BYTES = 4 * 1024 * 1024;
    static readonly uint[] FeatureLevels = { 0xb100, 0xb000, 0xa100, 0xa000, 0x9300 }; // 11_1..9_3
    // Not readonly: passed by ref to the CreateForWindow interop call.
    static Guid IID_IDXGIDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    static Guid IID_ID3D11Texture2D = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    static Guid IID_IDirect3DDxgiInterfaceAccess = new("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");
    static Guid IID_IGraphicsCaptureItemInterop = new("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
    // IGraphicsCaptureItem default interface from the Windows SDK ABI.
    static Guid IID_IGraphicsCaptureItem = new("79c3f95b-31f7-4ec2-a464-632ef5d30760");
    const int FRAME_TIMEOUT_MS = 3000;

    [DllImport("d3d11.dll")]
    static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags,
        [In, MarshalAs(UnmanagedType.LPArray)] uint[] featureLevels, uint numLevels, uint sdkVersion,
        out IntPtr device, out uint featureLevel, out IntPtr immediateContext);

    [DllImport("d3d11.dll")]
    static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("combase.dll")]
    static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid riid, out IntPtr factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    static extern int WindowsCreateString(string sourceString, uint length, out IntPtr hstring);
    [DllImport("combase.dll")]
    static extern int WindowsDeleteString(IntPtr hstring);

    [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(IntPtr hwnd, ref Guid riid, out IntPtr item);
        [PreserveSig] int CreateForMonitor(IntPtr hmonitor, ref Guid riid, out IntPtr item);
    }

    // ---- capture RPC (check 4) -------------------------------------------

    public static (JsonObject?, string?) Capture(JsonNode prms)
    {
        Trace("enter");
        long? h = prms["hwnd"]?.GetValue<long>();
        if (h is not long hwnd || hwnd <= 0) return (null, "missing_hwnd");
        if (!RpcInterop.IsWindow(new IntPtr(hwnd))) return (Unavailable("target_window_gone"), null);
        var expectedGen = prms["windowGeneration"]?.GetValue<string>();
        var nowGen = WindowGeneration(new IntPtr(hwnd));
        if (expectedGen is null || nowGen is null || expectedGen != nowGen)
            return (Unavailable(nowGen is null ? "target_window_generation_unavailable" : "stale_target_window_generation"), null);

        // 1. native D3D11 device + immediate context
        int hr = D3D11CreateDevice(IntPtr.Zero, D3D_DRIVER_TYPE_HARDWARE, IntPtr.Zero, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            FeatureLevels, (uint)FeatureLevels.Length, D3D11_SDK_VERSION, out var devicePtr, out _, out var ctxPtr);
        Trace($"d3d11_create hr=0x{hr:X8} device=0x{devicePtr.ToInt64():X} context=0x{ctxPtr.ToInt64():X}");
        if (hr != 0 || devicePtr == IntPtr.Zero)
            return (Unavailable($"d3d11_device_create_failed hr=0x{hr:X8}"), null);
        try
        {
            // 2. IDXGIDevice -> WinRT IDirect3DDevice (documented interop)
            hr = Marshal.QueryInterface(devicePtr, in IID_IDXGIDevice, out var dxgiPtr);
            Trace($"qi_dxgi hr=0x{hr:X8} ptr=0x{dxgiPtr.ToInt64():X}");
            if (hr != 0) return (Unavailable($"dxgi_device_qi_failed hr=0x{hr:X8}"), null);
            try
            {
                hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiPtr, out var winrtDevicePtr);
                Trace($"winrt_device hr=0x{hr:X8} ptr=0x{winrtDevicePtr.ToInt64():X}");
                if (hr != 0 || winrtDevicePtr == IntPtr.Zero)
                    return (Unavailable($"winrt_device_create_failed hr=0x{hr:X8}"), null);
                var d3dDevice = WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(winrtDevicePtr);
                // FromAbi returns a CsWinRT projected object. Release the
                // ABI reference once; cleanup of the projected object is via
                // IDisposable/IClosable, not Marshal.ReleaseComObject.
                Marshal.Release(winrtDevicePtr);
                try
                {
                    // 3. GraphicsCaptureItem via the class object's interop interface
                    var item = CreateItemForWindow(new IntPtr(hwnd), out var itemDiag);
                    Trace($"create_item item={(item is null ? "null" : "ok")} diag={itemDiag}");
                    if (item is null) return (Unavailable($"createforwindow_failed ({itemDiag})"), null);

                    using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                        d3dDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
                    using var session = pool.CreateCaptureSession(item);
                    session.StartCapture();
                    Trace("capture_started");

                    // 4. first frame, bounded wait
                    var sw = Stopwatch.StartNew();
                    Direct3D11CaptureFrame? frame = null;
                    while (sw.ElapsedMilliseconds < FRAME_TIMEOUT_MS && frame is null)
                    {
                        frame = pool.TryGetNextFrame();
                        if (frame is null) Thread.Sleep(40);
                    }
                    if (frame is null) return (Unavailable($"no_frame_within_{FRAME_TIMEOUT_MS}ms"), null);
                    Trace("frame_acquired");

                    using (frame)
                    {
                        var pixelCount = (long)item.Size.Width * item.Size.Height;
                        if (item.Size.Width <= 0 || item.Size.Height <= 0 || pixelCount > MAX_CAPTURE_PIXELS)
                            return (Unavailable($"capture_dimensions_exceed_limit {item.Size.Width}x{item.Size.Height}"), null);
                        // 5. copy the GPU texture to a CPU-readable staging
                        // texture and return a real PNG payload. There is no
                        // screen-rectangle fallback.
                        var (png, reason) = ReadPixels(devicePtr, ctxPtr, frame, item.Size.Width, item.Size.Height);
                        Trace($"read_pixels png={(png is null ? "null" : png.Length.ToString())} reason={reason}");
                        if (png is null) return (Unavailable(reason!), null);
                        if (png.Length > MAX_PNG_BYTES)
                            return (Unavailable($"png_exceeds_limit bytes={png.Length}"), null);
                        var hash = Convert.ToHexString(SHA256.HashData(png));
                        return (new JsonObject
                        {
                            ["status"] = "available",
                            ["path"] = "wgc_createforwindow",
                            ["frame"] = new JsonObject
                            {
                                ["width"] = item.Size.Width,
                                ["height"] = item.Size.Height,
                                ["bytes"] = png.Length,
                                ["format"] = "png",
                                ["base64"] = Convert.ToBase64String(png),
                                ["sha256"] = hash,
                                ["elapsedMs"] = sw.ElapsedMilliseconds,
                            },
                        }, null);
                    }
                }
                finally { d3dDevice.Dispose(); }
            }
            finally { Marshal.Release(dxgiPtr); }
        }
        finally { if (devicePtr != IntPtr.Zero) Marshal.Release(devicePtr); if (ctxPtr != IntPtr.Zero) Marshal.Release(ctxPtr); }
    }

    static JsonObject Unavailable(string reason) => new()
    {
        ["status"] = "unavailable",
        ["path"] = "none",
        ["reason"] = reason,
    };

    static GraphicsCaptureItem? CreateItemForWindow(IntPtr hwnd, out string? diag)
    {
        diag = null;
        var sb = new StringBuilder();
        // RoGetActivationFactory expects an HSTRING class id, not a raw
        // wide-char buffer (StringToHGlobalUni -> E_INVALIDARG).
        var className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        var createHr = WindowsCreateString(className, (uint)className.Length, out var classId);
        if (createHr != 0 || classId == IntPtr.Zero)
        { diag = $"hstring_create=0x{createHr:X8}"; return null; }
        try
        {
            int hr = RoGetActivationFactory(classId, ref IID_IGraphicsCaptureItemInterop, out var factoryPtr);
            sb.Append($"roget=0x{hr:X8}");
            if (hr != 0 || factoryPtr == IntPtr.Zero) { diag = sb.ToString(); return null; }
            var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr);
            try
            {
                sb.Append($" | {IID_IGraphicsCaptureItem:D}:0x");
                hr = interop.CreateForWindow(hwnd, ref IID_IGraphicsCaptureItem, out var itemPtr);
                sb.Append($"{hr:X8}");
                Trace($"create_for_window hr=0x{hr:X8} ptr=0x{itemPtr.ToInt64():X}");
                if (hr == 0 && itemPtr != IntPtr.Zero)
                {
                    try
                    {
                        var item = GraphicsCaptureItem.FromAbi(itemPtr);
                        if (item is not null) { diag = sb.ToString(); return item; }
                    }
                    finally { Marshal.Release(itemPtr); }
                }
            }
            finally { Marshal.ReleaseComObject(interop); }
        }
        finally { WindowsDeleteString(classId); }
        diag = sb.ToString();
        return null;
    }

    // ---- pixel readback via D3D11 staging texture --------------------------

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11Texture2DDesc
    {
        public int Width, Height, MipLevels, ArraySize;
        public int Format;
        public int SampleCount, SampleQuality;
        public uint Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11MappedSubresource
    {
        public IntPtr Data;
        public int RowPitch, DepthPitch;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int CreateTexture2DDelegate(IntPtr self, ref D3D11Texture2DDesc desc, IntPtr initialData, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void CopyResourceDelegate(IntPtr self, IntPtr destination, IntPtr source);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int MapDelegate(IntPtr self, IntPtr resource, uint subresource, uint mapType, uint mapFlags, out D3D11MappedSubresource mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void UnmapDelegate(IntPtr self, IntPtr resource, uint subresource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetInterfaceDelegate(IntPtr self, ref Guid iid, out IntPtr result);

    static T ComMethod<T>(IntPtr comObject, int slot) where T : Delegate
    {
        var vtable = Marshal.ReadIntPtr(comObject);
        var address = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
        return Marshal.GetDelegateForFunctionPointer<T>(address);
    }

    static (byte[]? bytes, string? reason) ReadPixels(IntPtr device, IntPtr context,
        Direct3D11CaptureFrame frame, int width, int height)
    {
        IntPtr sourceTexture = IntPtr.Zero;
        WinRT.IObjectReference? accessRef = null;
        IntPtr stagingTexture = IntPtr.Zero;
        try
        {
            // Get the native ABI pointer from the CsWinRT projection. Calling
            // Marshal.GetIUnknownForObject here can create a CCW rather than
            // expose the underlying IDirect3DSurface object.
            if (frame.Surface is not WinRT.IWinRTObject surfaceObject
                || surfaceObject.NativeObject is not WinRT.IObjectReference surfaceRef)
                return (null, "surface_native_object_unavailable");
            Trace($"surface_native ptr=0x{surfaceRef.ThisPtr.ToInt64():X}");
            accessRef = surfaceRef.As(IID_IDirect3DDxgiInterfaceAccess);
            var access = accessRef.ThisPtr;
            var hr = ComMethod<GetInterfaceDelegate>(access, 3)(access, ref IID_ID3D11Texture2D, out sourceTexture);
            if (hr != 0 || sourceTexture == IntPtr.Zero)
                return (null, $"frame_surface_qi_texture_failed hr=0x{hr:X8}");
            var desc = new D3D11Texture2DDesc
            {
                Width = width, Height = height, MipLevels = 1, ArraySize = 1,
                // DXGI_FORMAT_B8G8R8A8_UNORM, the capture-pool format above.
                Format = 87, SampleCount = 1, SampleQuality = 0,
                Usage = D3D11_USAGE_STAGING, BindFlags = 0,
                CpuAccessFlags = D3D11_CPU_ACCESS_READ, MiscFlags = 0,
            };
            hr = ComMethod<CreateTexture2DDelegate>(device, 5)(device, ref desc, IntPtr.Zero, out stagingTexture);
            if (hr != 0 || stagingTexture == IntPtr.Zero)
                return (null, $"staging_texture_create_failed hr=0x{hr:X8}");
            ComMethod<CopyResourceDelegate>(context, 47)(context, stagingTexture, sourceTexture);
            hr = ComMethod<MapDelegate>(context, 14)(context, stagingTexture, 0, D3D11_MAP_READ, 0, out var mapped);
            if (hr != 0 || mapped.Data == IntPtr.Zero)
                return (null, $"staging_texture_map_failed hr=0x{hr:X8}");
            try
            {
                var bgra = new byte[checked(width * height * 4)];
                for (var y = 0; y < height; y++)
                    Marshal.Copy(IntPtr.Add(mapped.Data, y * mapped.RowPitch), bgra, y * width * 4, width * 4);
                return (EncodePngBgra(bgra, width, height), null);
            }
            finally { ComMethod<UnmapDelegate>(context, 15)(context, stagingTexture, 0); }
        }
        finally
        {
            if (stagingTexture != IntPtr.Zero) Marshal.Release(stagingTexture);
            if (sourceTexture != IntPtr.Zero) Marshal.Release(sourceTexture);
            accessRef?.Dispose();
        }
    }

    static byte[] EncodePngBgra(byte[] bgra, int width, int height)
    {
        using var raw = new MemoryStream();
        for (var y = 0; y < height; y++)
        {
            raw.WriteByte(0); // PNG filter: None
            for (var x = 0; x < width; x++)
            {
                var i = (y * width + x) * 4;
                raw.WriteByte(bgra[i + 2]); raw.WriteByte(bgra[i + 1]);
                raw.WriteByte(bgra[i]); raw.WriteByte(bgra[i + 3]);
            }
        }
        using var compressed = new MemoryStream();
        using (var z = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            raw.Position = 0;
            raw.CopyTo(z);
        }
        using var png = new MemoryStream();
        png.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        WriteChunk(png, "IHDR", Header(width, height));
        WriteChunk(png, "IDAT", compressed.ToArray());
        WriteChunk(png, "IEND", Array.Empty<byte>());
        return png.ToArray();
    }

    static byte[] Header(int width, int height)
    {
        var b = new byte[13];
        WriteBigEndian(b, 0, width); WriteBigEndian(b, 4, height);
        b[8] = 8; b[9] = 6; // RGBA, 8 bits/channel
        return b;
    }

    static void WriteChunk(Stream output, string type, byte[] data)
    {
        var typeBytes = Encoding.ASCII.GetBytes(type);
        WriteBigEndian(output, data.Length); output.Write(typeBytes);
        output.Write(data);
        var crc = 0xffffffffu;
        foreach (var b in typeBytes.Concat(data))
        {
            crc ^= b;
            for (var i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1));
        }
        WriteBigEndian(output, ~crc);
    }

    static void WriteBigEndian(Stream output, int value) => WriteBigEndian(output, unchecked((uint)value));
    static void WriteBigEndian(Stream output, uint value)
    {
        output.WriteByte((byte)(value >> 24)); output.WriteByte((byte)(value >> 16));
        output.WriteByte((byte)(value >> 8)); output.WriteByte((byte)value);
    }
    static void WriteBigEndian(byte[] output, int offset, int value)
    {
        output[offset] = (byte)(value >> 24); output[offset + 1] = (byte)(value >> 16);
        output[offset + 2] = (byte)(value >> 8); output[offset + 3] = (byte)value;
    }

    static void Trace(string message)
    {
        try { Console.Error.WriteLine($"WGC {DateTime.UtcNow:O} {message}"); Console.Error.Flush(); }
        catch { /* diagnostics must never affect protocol */ }
    }

    // ---- window generation fingerprint (check 2) --------------------------

    /// Fingerprint of the current window instance: hwnd + class + title +
    /// bounds + pid + thread + UIA RuntimeId, hashed. Windows exposes no
    /// per-window-instance token; a recreated window normally gets a new HWND
    /// (caught by IsWindow / this hash). True HWND-value reuse with identical
    /// properties is a documented residual limitation (decision record D4).
    /// Null when the fingerprint cannot be computed — callers then degrade to
    /// HWND+PID+startTime checks only.
    public static string? WindowGeneration(IntPtr hwnd)
    {
        try
        {
            var el = AutomationElement.FromHandle(hwnd);
            return el is null ? null : WindowGeneration(el);
        }
        catch (Exception) { return null; }
    }

    public static string? WindowGeneration(AutomationElement root)
    {
        try
        {
            var sb = new StringBuilder();
            var w = (long)root.Current.NativeWindowHandle;
            sb.Append(w).Append('|');
            sb.Append(root.Current.ClassName).Append('|');
            sb.Append(root.Current.Name).Append('|');
            var r = root.Current.BoundingRectangle;
            sb.Append(r.X).Append(',').Append(r.Y).Append(',').Append(r.Width).Append(',').Append(r.Height).Append('|');
            sb.Append((long)root.Current.ProcessId).Append('|');
            _ = RpcInterop.GetWindowThreadProcessId(new IntPtr(w), out var tid);
            sb.Append((long)tid).Append('|');
            try { foreach (var rid in root.GetRuntimeId()) sb.Append(rid).Append(';'); } catch { /* provider-dependent */ }
            using var sha = SHA256.Create();
            return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString())))[..16];
        }
        catch (Exception) { return null; }
    }
}
