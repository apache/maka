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

// Feasibility spike v0 — supervised C#/.NET Windows helper for maka-cu
// (child of apache/maka#3785). Line-delimited JSON-RPC 2.0 on stdio.
// All UIA work runs on a dedicated MTA thread; the protocol loop lives on the
// main thread. stdin EOF (parent died / pipe closed) exits the process.
//
// Spike checks implemented in v0:
//   1. long-lived startup/handshake          — initialize
//   2. one MTA UIA observation               — observe (bounded tree)
//   3. one semantic action (ValuePattern)    — act set_value / click_element;
//      typed outcome + atomic snapshot spend BEFORE dispatch + pre/post
//      revalidation (pid + startTime + windowGeneration) + readback
//   4. target-window WGC capture             — capture (CreateForWindow)
//   5. cancellation with settlement          — $/cancel (before/after dispatch)
//   6. recovery after hung provider          — supervision lives host-side

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;

const string PROTOCOL = "maka.cu.windows/0";
const int MAX_TREE_NODES = 2000;
const int MAX_TREE_DEPTH = 32;
const int MAX_TREE_MILLIS = 2000;
const int MAX_TREE_RENDER_DEPTH = 4;   // spike render: shallow skeleton only
const int SHUTDOWN_GRACE_MS = 1000;
const int MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const int CANCEL_GRACE_MS = 2000;
const int MAX_IN_FLIGHT = 32;
const int MAX_SNAPSHOTS = 64;
const uint COINIT_MULTITHREADED = 0;
const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

Console.OutputEncoding = new UTF8Encoding(false);

var registry = new ConcurrentDictionary<string, SnapshotEntry>();
var inbox = new BlockingCollection<UiaWork>(MAX_IN_FLIGHT);
var active = new ConcurrentDictionary<UiaWork, byte>();
var requests = new ConcurrentDictionary<string, UiaWork>();
var uiaThread = new Thread(() => UiaLoop(inbox, active, requests, registry)) { IsBackground = true, Name = "uia-mta" };
uiaThread.Start();

while (Console.ReadLine() is { } line)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    JsonObject? request;
    try { request = JsonNode.Parse(line) as JsonObject; }
    catch (JsonException) { WriteLine(ErrorRpc(null, -32700, "parse_error")); continue; }
    if (request is null)
    { WriteLine(ErrorRpc(null, -32600, "invalid_request")); continue; }

    string? method;
    JsonNode? id;
    JsonNode prms;
    try
    {
        if (request["jsonrpc"] is not JsonValue rpc || !rpc.TryGetValue<string>(out var rpcVersion) || rpcVersion != "2.0")
        { WriteLine(ErrorRpc(null, -32600, "invalid_request")); continue; }
        method = request["method"] is JsonValue methodValue && methodValue.TryGetValue<string>(out var parsedMethod) ? parsedMethod : null;
        id = request["id"]?.DeepClone();
        prms = request["params"] ?? new JsonObject();
    }
    catch (Exception) { WriteLine(ErrorRpc(null, -32600, "invalid_request")); continue; }
    if (method is null) { WriteLine(ErrorRpc(id, -32600, "invalid_request_method")); continue; }
    if (method == "$/cancel")
    {
        var cancellation = MarkCancelled(prms, inbox, active, requests);
        // A JSON-RPC notification has no response, including cancellation
        // notifications. Request form remains useful to the driver.
        if (id is not null) WriteLine(ResultRpc(id, cancellation));
        continue;
    }
    if (method == "shutdown")
    {
        WriteLine(ResultRpc(id, new JsonObject { ["ok"] = true }));
        inbox.CompleteAdding();
        // Graceful shutdown is bounded. A provider that ignores cancellation
        // cannot keep the helper alive indefinitely; the supervisor may also
        // force-terminate it after the same 2-second grace.
        await Task.Delay(SHUTDOWN_GRACE_MS);
        Environment.Exit(0);
    }
    _ = HandleRequestAsync(method, id, prms, inbox, active, requests, registry);
}
// stdin EOF: the supervising host is gone (or piped input ended). No orphans.
Environment.Exit(0);

static void WriteLine(string s)
{
    // Keep protocol input/control independent from a slow or abandoned
    // stdout pipe. The bounded queue fails closed after a short admission
    // bound; stdin EOF can therefore still reach the process exit path.
    RpcOutput.Enqueue(s);
}

static void WriteResponse(JsonNode? id, JsonObject? result, (int code, string message)? error)
{
    var line = error is { } e ? ErrorRpc(id, e.code, e.message) : ResultRpc(id, result);
    if (Encoding.UTF8.GetByteCount(line) > MAX_RESPONSE_BYTES)
        line = ErrorRpc(id, -32002, "response_too_large");
    WriteLine(line);
}

static async Task HandleRequestAsync(string? method, JsonNode? id, JsonNode prms,
    BlockingCollection<UiaWork> inbox, ConcurrentDictionary<UiaWork, byte> active,
    ConcurrentDictionary<string, UiaWork> requests,
    ConcurrentDictionary<string, SnapshotEntry> registry)
{
    try
    {
        if (method == "initialize") { WriteLine(ResultRpc(id, InitializeResult())); return; }
        if (method is not ("list_windows" or "observe" or "act" or "capture" or "debug_sleep"))
        { WriteLine(ErrorRpc(id, -32601, $"method_not_found: {method}")); return; }
        var work = new UiaWork(method, prms) { Id = id?.DeepClone() };
        requests[work.Key] = work;
        if (!inbox.TryAdd(work))
        { requests.TryRemove(work.Key, out _); WriteLine(ErrorRpc(id, -32000, "request_queue_full")); return; }
        var (result, error) = await work.Tcs.Task;
        WriteResponse(id, result, error is null ? null : (-32001, error));
    }
    catch (InvalidOperationException)
    {
        WriteLine(ErrorRpc(id, -32000, "helper_shutting_down"));
    }
    catch (Exception ex)
    {
        WriteLine(ErrorRpc(id, -32603, $"internal_error: {ex.Message}"));
    }
}

static JsonObject MarkCancelled(JsonNode prms, BlockingCollection<UiaWork> inbox,
    ConcurrentDictionary<UiaWork, byte> active, ConcurrentDictionary<string, UiaWork> requests)
{
    // A malformed cancellation must be a typed no-op. Indexing a JsonValue
    // here would otherwise throw on the protocol reader thread.
    if (prms is not JsonObject parameters)
        return new JsonObject
        {
            ["cancelled"] = false,
            ["reason"] = "invalid_cancel_params",
            ["settlement"] = "original_request_must_settle",
            ["graceMs"] = CANCEL_GRACE_MS,
        };
    var requested = parameters["id"]?.DeepClone();
    UiaWork? target = null;
    if (requested is not null)
        target = requests.Values.FirstOrDefault(w => JsonEqual(w.Id, requested));
    else
        target = active.Keys.FirstOrDefault() ?? inbox.FirstOrDefault();
    if (target is not null) target.RequestCancel();
    return new JsonObject
    {
        ["cancelled"] = target is not null,
        ["pendingRequestId"] = target?.Id?.DeepClone(),
        ["settlement"] = "original_request_must_settle",
        ["graceMs"] = CANCEL_GRACE_MS,
    };
}

static bool JsonEqual(JsonNode? a, JsonNode? b) => a is not null && b is not null && a.ToJsonString() == b.ToJsonString();

static JsonObject InitializeResult() => new()
{
    ["protocol"] = PROTOCOL,
    ["executor"] = new JsonObject
    {
        ["name"] = "maka-cu-windows",
        ["language"] = "csharp-dotnet8",
        ["spikeStage"] = "v0",
    },
    ["capabilities"] = new JsonObject
    {
        ["observation"] = new JsonObject { ["uia"] = true, ["wgc"] = true },
        ["semanticActions"] = new JsonArray("set_value", "click_element"),
        ["input"] = new JsonObject
        {
            ["foreground"] = false,
            ["globalPointer"] = false,
            ["postMessage"] = false,
            ["sendInput"] = false,
        },
        ["capture"] = new JsonObject { ["targetWindowWgc"] = true, ["screenRect"] = false },
    },
    ["limits"] = new JsonObject
    {
        ["maxTreeNodes"] = MAX_TREE_NODES,
        ["maxTreeDepth"] = MAX_TREE_DEPTH,
        ["maxTreeMillis"] = MAX_TREE_MILLIS,
        ["maxResponseBytes"] = MAX_RESPONSE_BYTES,
        ["shutdownGraceMs"] = SHUTDOWN_GRACE_MS,
    },
    ["deadlines"] = new JsonObject { ["handshake"] = 10, ["request"] = 20, ["cancelGrace"] = 2 },
    ["generation"] = RuntimeIdentity.HelperGeneration,
    ["signature"] = "none",
    ["distributionReady"] = false,
    ["runtime"] = "net8.0-windows",
};

static string ErrorRpc(JsonNode? id, int code, string message) =>
    new JsonObject
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    }.ToJsonString();

static string ResultRpc(JsonNode? id, JsonObject? result) =>
    new JsonObject
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["result"] = result ?? new JsonObject(),
    }.ToJsonString();

// ---- UIA lane -------------------------------------------------------------

static void UiaLoop(BlockingCollection<UiaWork> inbox, ConcurrentDictionary<UiaWork, byte> active,
    ConcurrentDictionary<string, UiaWork> requests, ConcurrentDictionary<string, SnapshotEntry> registry)
{
    _ = RpcInterop.CoInitializeEx(IntPtr.Zero, COINIT_MULTITHREADED);
    foreach (var work in inbox.GetConsumingEnumerable())
    {
        active[work] = 0;
        try
        {
            // Cancellation settlement: an op cancelled while still queued
            // must never dispatch (before-dispatch cancel ⇒ no mutation).
            if (work.Cancelled && work.Op != "act")
            {
                work.Tcs.TrySetResult((null, "cancelled"));
                continue;
            }
            if (work.Cancelled && work.Op == "act")
            {
                work.Tcs.TrySetResult((CancelQueuedAct(work, registry), null));
                continue;
            }
            if (work.Op != "act" && !work.TryBeginDispatch())
            {
                work.Tcs.TrySetResult((null, "cancelled"));
                continue;
            }
            (JsonObject? result, string? error) = work.Op switch
            {
                "list_windows" => ListWindows(),
                "observe" => Observe(work.Params, registry),
                "act" => Act(work.Params, work, registry),
                "capture" => WgcCapture.Capture(work.Params),
                "debug_sleep" => DebugSleep(work.Params),
                _ => (null, $"unsupported_uia_op:{work.Op}"),
            };
            work.Tcs.TrySetResult((result, error));
        }
        catch (Exception ex)
        {
            work.Tcs.TrySetResult((null, $"uia_error: {ex.GetType().Name}: {ex.Message}"));
        }
        finally { active.TryRemove(work, out _); requests.TryRemove(work.Key, out _); }
    }
}

static JsonObject? CancelQueuedAct(UiaWork work, ConcurrentDictionary<string, SnapshotEntry> registry)
{
    var snapshotId = work.Params["snapshotId"]?.GetValue<string>();
    if (snapshotId is not null) registry.TryRemove(snapshotId, out _);
    return CancelledOutcome();
}

/// Typed outcome for a mutating op cancelled before dispatch: refused, no
/// mutation occurred, snapshot already spent.
static JsonObject? CancelledOutcome() => new()
{
    ["outcome"] = new JsonObject
    {
        ["tier"] = "cancelled-before-dispatch",
        ["path"] = "none",
        ["status"] = "refused",
        ["reason"] = "cancelled_before_dispatch",
        ["effect"] = "none",
        ["snapshotSpent"] = true,
        ["verification"] = "no_mutation",
    },
};

/// Spike-only test hook: blocks the UIA lane for N ms so queued ops can be
/// deterministically cancelled before dispatch. Bounded; never used by the
/// product path (check 6's blocked-provider fixture is a real UIA provider
/// call, not this).
static (JsonObject?, string?) DebugSleep(JsonNode prms)
{
    var ms = prms["ms"]?.GetValue<int>() ?? 0;
    if (ms < 0 || ms > 5000) return (null, "invalid_ms");
    Thread.Sleep(ms);
    return (new JsonObject { ["sleptMs"] = ms }, null);
}

static (JsonObject?, string?) ListWindows()
{
    var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    var arr = new JsonArray();
    long seen = 0;
    foreach (AutomationElement el in all)
    {
        if (seen++ >= 64) break;
        try
        {
            arr.Add(new JsonObject
            {
                ["hwnd"] = (long)el.Current.NativeWindowHandle,
                ["pid"] = (long)el.Current.ProcessId,
                ["title"] = Truncate(el.Current.Name ?? "", 256),
                ["className"] = Truncate(el.Current.ClassName ?? "", 128),
                ["isOffscreen"] = el.Current.IsOffscreen,
            });
        }
        catch (ElementNotAvailableException) { /* window vanished mid-enumeration */ }
    }
    return (new JsonObject { ["windows"] = arr }, null);
}

static (JsonObject?, string?) Observe(JsonNode prms, ConcurrentDictionary<string, SnapshotEntry> registry)
{
    AutomationElement target;
    long? requestedHwnd = prms["hwnd"] is null ? null : prms["hwnd"]!.GetValue<long>();
    if (requestedHwnd is not long h || h <= 0)
        return (null, "explicit_hwnd_required");
    target = AutomationElement.FromHandle(new IntPtr(h));
    if (target is null) return (null, "target_window_not_found");

    var hwnd = (long)target.Current.NativeWindowHandle;
    var pid = (uint)target.Current.ProcessId;
    var startTime = ProcessStartTime(pid);
    var windowGen = WgcCapture.WindowGeneration(target);
    if (startTime is not long)
        return (null, "target_process_start_time_unavailable");
    if (windowGen is not string)
        return (null, "target_window_generation_unavailable");
    if (registry.Count >= MAX_SNAPSHOTS)
        return (null, "snapshot_registry_full");

    var snapshot = new SnapshotEntry(hwnd, pid, startTime.Value, windowGen, target);
    var rootToken = snapshot.AddElement(target);

    var sw = Stopwatch.StartNew();
    var nodes = new JsonArray();
    var count = 1;
    nodes.Add(BuildNode(target, rootToken));
    count = Walk(target, nodes, snapshot, count, 1, sw);
    count = FindActionable(target, nodes, snapshot, count, sw);

    var id = $"snap-{Guid.NewGuid():N}";
    registry[id] = snapshot;

    var result = new JsonObject
    {
        ["snapshotId"] = id,
        ["protocol"] = PROTOCOL,
        ["target"] = new JsonObject
        {
            ["hwnd"] = hwnd,
            ["pid"] = pid,
            ["processStartTimeUtc"] = DateTime.FromFileTimeUtc(startTime.Value).ToString("O"),
            ["title"] = Truncate(target.Current.Name ?? "", 256),
            ["windowGeneration"] = windowGen,
        },
        ["capture"] = new JsonObject
        {
            ["path"] = "capture_rpc",
            ["status"] = "separate",
        },
        ["tree"] = new JsonObject
        {
            ["rootToken"] = rootToken,
            ["nodeCount"] = count,
            ["truncated"] = count >= MAX_TREE_NODES || sw.ElapsedMilliseconds >= MAX_TREE_MILLIS,
            ["elapsedMs"] = sw.ElapsedMilliseconds,
            ["nodes"] = nodes,
        },
    };
    // Response-size cap (check 2: bound text/response size): drop trailing
    // nodes until the serialized tree fits, then flag truncated.
    while (nodes.Count > 0 && Encoding.UTF8.GetByteCount(result.ToJsonString()) > MAX_RESPONSE_BYTES)
    {
        nodes.RemoveAt(nodes.Count - 1);
        result["tree"]!["nodeCount"] = nodes.Count;
        result["tree"]!["truncated"] = true;
    }
    return (result, null);
}

/// Level-by-level cached walk over the top few levels only. Each node's
/// children are fetched with a children-scoped properties-only CacheRequest
/// (one small provider call per node, ms budget enforced between nodes).
/// Deliberately shallow: enumerating Chromium's full DOM subtree blocks for
/// minutes on individual FindAll calls, so actionable elements are found by
/// targeted FindFirst instead (see FindActionable).
static int Walk(AutomationElement parent, JsonArray nodes, SnapshotEntry snap, int count, int depth, Stopwatch sw)
{
    if (count >= MAX_TREE_NODES || depth >= MAX_TREE_RENDER_DEPTH || sw.ElapsedMilliseconds >= MAX_TREE_MILLIS)
        return count;

    var request = new CacheRequest { TreeScope = TreeScope.Element };
    request.Add(AutomationElement.NameProperty);
    request.Add(AutomationElement.AutomationIdProperty);
    request.Add(AutomationElement.ClassNameProperty);
    request.Add(AutomationElement.ControlTypeProperty);
    request.Add(AutomationElement.IsEnabledProperty);
    request.Add(AutomationElement.IsOffscreenProperty);
    request.Add(AutomationElement.BoundingRectangleProperty);
    request.Add(AutomationElement.NativeWindowHandleProperty);
    request.Add(AutomationElement.ProcessIdProperty);
    request.Add(AutomationElement.IsPasswordProperty);

    AutomationElementCollection children;
    try
    {
        using (request.Activate())
        {
            children = parent.FindAll(TreeScope.Children, Condition.TrueCondition);
        }
    }
    catch (ElementNotAvailableException) { return count; }

    foreach (AutomationElement child in children)
    {
        if (count >= MAX_TREE_NODES || sw.ElapsedMilliseconds >= MAX_TREE_MILLIS) return count;
        var token = snap.AddElement(child);
        nodes.Add(BuildCachedNode(child, token));
        count++;
        count = Walk(child, nodes, snap, count, depth + 1, sw);
    }
    return count;
}

/// Targeted discovery of actionable elements: one FindFirst per supported
/// control type short-circuits at the first match, so the provider never
/// enumerates the full subtree. Found elements are LIVE (no cache request),
/// so pattern probing works on them. Cached render nodes cannot probe
/// patterns (patterns are not cached — that was prohibitively slow on
/// Chromium), so actionable candidates always come from this pass.
static int FindActionable(AutomationElement root, JsonArray nodes, SnapshotEntry snap, int count, Stopwatch sw)
{
    ControlType[] actionable =
    {
        ControlType.Edit, ControlType.ComboBox, ControlType.Button, ControlType.Hyperlink,
        ControlType.CheckBox, ControlType.RadioButton, ControlType.ListItem,
        ControlType.TabItem, ControlType.MenuItem,
    };
    foreach (var ct in actionable)
    {
        if (count >= MAX_TREE_NODES || sw.ElapsedMilliseconds >= MAX_TREE_MILLIS) return count;
        AutomationElement? found;
        try
        {
            found = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
        }
        catch (ElementNotAvailableException) { continue; }
        catch (System.Runtime.InteropServices.COMException) { continue; }
        if (found is null) continue;
        var token = snap.AddElement(found);
        nodes.Add(BuildNode(found, token)); // live node: Current props + pattern probe
        count++;
    }
    return count;
}

static JsonObject BuildNode(AutomationElement el, string token)
{
    try
    {
        var bounds = el.Current.BoundingRectangle;
        var patterns = ProbePatterns(el);
        return new JsonObject
        {
            ["token"] = token,
            ["controlType"] = el.Current.ControlType.ProgrammaticName,
            ["name"] = Truncate(el.Current.Name ?? "", 256),
            ["automationId"] = Truncate(el.Current.AutomationId ?? "", 128),
            ["className"] = Truncate(el.Current.ClassName ?? "", 128),
            ["isEnabled"] = el.Current.IsEnabled,
            ["isOffscreen"] = el.Current.IsOffscreen,
            ["bounds"] = new JsonArray(Fin(bounds.X), Fin(bounds.Y), Fin(bounds.Width), Fin(bounds.Height)),
            ["patterns"] = patterns,
            // Live value readback for Value-pattern nodes (used by the
            // driver to verify mutations / absence of mutations).
            ["value"] = patterns.Any(p => p?.GetValue<string>() == "Value") ? ReadValueLive(el) : null,
        };
    }
    catch (ElementNotAvailableException)
    {
        return new JsonObject
        {
            ["token"] = token,
            ["controlType"] = "(unavailable)",
            ["name"] = "(element_died)",
            ["isEnabled"] = false,
            ["bounds"] = new JsonArray(0, 0, 0, 0),
            ["patterns"] = new JsonArray(),
        };
    }
}

/// Reads the current value of a ValuePattern element (live nodes only; the
/// caller must have already established the Value pattern).
static string ReadValueLive(AutomationElement el)
{
    try
    {
        if (TryGetPattern(el, ValuePattern.Pattern, out var p, out var cached))
        {
            var vp = (ValuePattern)p;
            var v = Flavor(cached, () => vp.Cached.Value, () => vp.Current.Value);
            return Truncate(v ?? "", 256);
        }
    }
    catch (Exception) { /* element died or provider hiccup */ }
    return "";
}

static JsonObject BuildCachedNode(AutomationElement el, string token)
{
    var bounds = el.Cached.BoundingRectangle;
    return new JsonObject
    {
        ["token"] = token,
        ["controlType"] = el.Cached.ControlType.ProgrammaticName,
        ["name"] = Truncate(el.Cached.Name ?? "", 256),
        ["automationId"] = Truncate(el.Cached.AutomationId ?? "", 128),
        ["className"] = Truncate(el.Cached.ClassName ?? "", 128),
        ["isEnabled"] = el.Cached.IsEnabled,
        ["isOffscreen"] = el.Cached.IsOffscreen,
        ["bounds"] = new JsonArray(Fin(bounds.X), Fin(bounds.Y), Fin(bounds.Width), Fin(bounds.Height)),
        // Cached nodes carry no cached patterns (pattern caching is
        // prohibitively slow on Chromium); actionable candidates come from
        // the targeted FindActionable pass and are built with BuildNode.
        ["patterns"] = new JsonArray(),
    };
}

/// Pattern detection is the expensive part (live per-pattern provider calls).
/// Only probe types that plausibly carry a pattern; everything else returns []
/// (a Chrome-sized tree is mostly Pane/Group/Document — this keeps RPCs ~0).
static JsonArray ProbePatterns(AutomationElement el)
{
    var patterns = new JsonArray();
    try
    {
        var t = GetControlType(el);
        if (t == ControlType.Edit || t == ControlType.ComboBox)
        {
            if (TryGetPattern(el, ValuePattern.Pattern, out _, out _)) patterns.Add("Value");
            if (TryGetPattern(el, InvokePattern.Pattern, out _, out _)) patterns.Add("Invoke");
        }
        else if (t == ControlType.Button || t == ControlType.Hyperlink || t == ControlType.MenuItem)
        {
            if (TryGetPattern(el, InvokePattern.Pattern, out _, out _)) patterns.Add("Invoke");
        }
        else if (t == ControlType.CheckBox || t == ControlType.RadioButton)
        {
            if (TryGetPattern(el, TogglePattern.Pattern, out _, out _)) patterns.Add("Toggle");
        }
        else if (t == ControlType.ListItem || t == ControlType.DataItem || t == ControlType.TabItem)
        {
            if (TryGetPattern(el, SelectionItemPattern.Pattern, out _, out _)) patterns.Add("SelectionItem");
        }
    }
    catch (ElementNotAvailableException) { /* treat as no patterns */ }
    return patterns;
}

static ControlType GetControlType(AutomationElement el)
{
    try { return el.Cached.ControlType; }
    catch (InvalidOperationException) { return el.Current.ControlType; }
    catch (ElementNotAvailableException) { return ControlType.Window; }
}

/// Pattern retrieval that works for both cached elements (children walked
/// under a CacheRequest) and live elements (root from FromHandle). A cached
/// element throws InvalidOperationException on Current-pattern requests, and
/// a live element has no cached values; try the matching flavor first.
static bool TryGetPattern(AutomationElement el, AutomationPattern pattern, out object patternObj, out bool cached)
{
    patternObj = null!;
    cached = false;
    try
    {
        if (el.TryGetCachedPattern(pattern, out var p))
        {
            patternObj = p;
            cached = true;
            return true;
        }
    }
    catch (InvalidOperationException) { /* element has no cache (root) */ }
    catch (ElementNotAvailableException) { return false; }
    try
    {
        return el.TryGetCurrentPattern(pattern, out patternObj);
    }
    catch (InvalidOperationException) { return false; } // cached element, pattern not cached
    catch (ElementNotAvailableException) { return false; }
}

/// Reads a pattern property from whichever flavor the pattern came in, with
/// a cross-flavor fallback (cached patterns reject .Current and vice versa).
static T Flavor<T>(bool cached, Func<T> fromCache, Func<T> fromCurrent)
{
    try { return cached ? fromCache() : fromCurrent(); }
    catch (InvalidOperationException) { return cached ? fromCurrent() : fromCache(); }
}

static bool? GetIsPassword(AutomationElement el)
{
    try { return el.Cached.IsPassword; }
    catch (InvalidOperationException) { return el.Current.IsPassword; }
    catch (ElementNotAvailableException) { return null; }
    catch (COMException) { return null; }
}

static (JsonObject?, string?) Act(JsonNode prms, UiaWork work, ConcurrentDictionary<string, SnapshotEntry> registry)
{
    if (prms is not JsonObject parameters) return (null, "invalid_params");
    var snapId = parameters["snapshotId"]?.GetValue<string>();
    var token = parameters["elementToken"]?.GetValue<string>();
    var op = parameters["op"]?.GetValue<string>();
    if (snapId is null || token is null || op is null) return (null, "missing_required_param");
    if (op is not ("set_value" or "click_element")) return (null, $"unsupported_op:{op}");
    string? value = null;
    if (op == "set_value")
    {
        if (parameters["value"] is not JsonValue valueNode || !valueNode.TryGetValue<string>(out value))
            return (null, "invalid_value");
    }
    var postDispatchDelay = parameters["debugPostDispatchDelayMs"]?.GetValue<int>() ?? 0;
    if (postDispatchDelay is < 0 or > 3000) return (null, "invalid_debugPostDispatchDelayMs");

    if (!registry.TryGetValue(snapId, out var snap)) return (null, "snapshot_spent_or_unknown");

    // Revalidate target identity before dispatch: HWND alive, owning PID
    // unchanged, process incarnation unchanged, window generation unchanged.
    // Fail closed. (Window generation is a fingerprint — see WgcCapture.
    // When either value cannot be computed, the action is refused.
    var hwnd = new IntPtr(snap.Hwnd);
    var nowStart = ProcessStartTime(snap.Pid);
    var nowGen = WgcCapture.WindowGeneration(hwnd);
    var stale = !RpcInterop.IsWindow(hwnd)
        || snap.Pid != OwningPid(hwnd)
        || nowStart is not long || snap.StartTimeUtc != nowStart
        || nowGen is not string || snap.WindowGen != nowGen
        || snap.HelperGeneration != RuntimeIdentity.HelperGeneration;
    if (stale)
    {
        registry.TryRemove(snapId, out _);
        return (null, "stale_target_revalidate_failed");
    }

    if (!snap.TryGetElement(token, out var el)) return (null, "element_token_unknown_in_snapshot");

    // Atomic snapshot spend BEFORE dispatch (check 3): the snapshot is
    // consumed by this attempt regardless of dispatch outcome or cancellation.
    registry.TryRemove(snapId, out _);

    (string status, string? reason, string verification) = op switch
    {
        // The CAS is deliberately inside the pattern helper, immediately
        // before the provider mutator. Pattern lookup/readback may block.
        "set_value" => SetValueVerified(el, value!, work.TryBeginDispatch),
        "click_element" => ClickVerified(el, work.TryBeginDispatch),
        _ => ("refused", $"unsupported_op:{op}", "none"),
    };

    // Fixture-only timing hook used to exercise cancellation after the
    // provider has received the mutation. The value has already been
    // delivered before this delay; cancellation therefore cannot claim that
    // the action was undone.
    if (postDispatchDelay > 0 && status != "refused") Thread.Sleep(postDispatchDelay);

    // Post-dispatch target revalidation (check 3): if the window/process
    // incarnation changed while the action ran, the outcome is unknown.
    if (status != "refused")
    {
        var postStart = ProcessStartTime(snap.Pid);
        var postGen = WgcCapture.WindowGeneration(hwnd);
        var postStale = !RpcInterop.IsWindow(hwnd)
            || snap.Pid != OwningPid(hwnd)
            || postStart is not long || snap.StartTimeUtc != postStart
            || postGen is not string || snap.WindowGen != postGen;
        if (postStale)
        {
            status = "unknown";
            reason = "target_died_during_action";
            verification = "post_revalidation_failed";
        }
    }

    // (spend already happened atomically before dispatch)

    return (new JsonObject
    {
        ["outcome"] = new JsonObject
        {
            ["tier"] = "uia-pattern",
            ["path"] = op == "set_value" ? "value_pattern" : op == "click_element" ? "invoke_toggle_selection" : "none",
            ["status"] = status,
            ["reason"] = reason,
            ["effect"] = status == "verified" ? (op == "set_value" ? "value_set" : "invoked")
                : status == "unknown" ? "possibly_dispatched" : "none",
            ["snapshotSpent"] = true,
            ["verification"] = verification,
        }
    }, null);
}

static (string status, string? reason, string verification) SetValueVerified(AutomationElement el, string value, Func<bool> beginDispatch)
{
    if (!TryGetPattern(el, ValuePattern.Pattern, out var p, out var cached)) return ("refused", "value_pattern_unavailable", "none");
    var vp = (ValuePattern)p;
    if (Flavor(cached, () => vp.Cached.IsReadOnly, () => vp.Current.IsReadOnly)) return ("refused", "value_pattern_readonly", "none");
    // .NET Core's UIAutomationClient has no ValuePatternInformation.IsPassword;
    // read the element-level UIA_IsPasswordPropertyId instead.
    var isPassword = GetIsPassword(el);
    if (isPassword is null) return ("refused", "password_state_unavailable", "none");
    if (isPassword.Value) return ("refused", "password_field_refused", "none");
    if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
    try { vp.SetValue(value); }
    catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
    catch (InvalidOperationException) { return ("unknown", "element_not_available_after_dispatch", "readback_unavailable"); }

    // Post-dispatch readback: confirm the value actually landed (check 3).
    try
    {
        var actual = Flavor(cached, () => vp.Cached.Value, () => vp.Current.Value);
        if (actual == value) return ("verified", null, "value_readback_match");
        return ("unknown", $"value_readback_mismatch (got '{Truncate(actual, 60)}')", "value_readback_mismatch");
    }
    catch (ElementNotAvailableException) { return ("unknown", "element_died_during_action", "readback_unavailable"); }
    catch (InvalidOperationException) { return ("unknown", "readback_unavailable_after_dispatch", "readback_unavailable"); }
}

static (string status, string? reason, string verification) ClickVerified(AutomationElement el, Func<bool> beginDispatch)
{
    // Prefer state-verifiable patterns (SelectionItem/Toggle) over Invoke so
    // the outcome can be read back; Invoke has no state contract and may have
    // side effects (e.g. a desktop icon Invoke opens the file).
    if (TryGetPattern(el, SelectionItemPattern.Pattern, out var sp, out var sc))
    {
        var sel = (SelectionItemPattern)sp;
        if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
        try { sel.Select(); }
        catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
        catch (InvalidOperationException) { return ("unknown", "select_failed_after_dispatch", "readback_unavailable"); }
        try
        {
            var selected = Flavor(sc, () => sel.Cached.IsSelected, () => sel.Current.IsSelected);
            if (selected) return ("verified", null, "selection_readback_selected");
            return ("unknown", "selection_not_selected_after_action", "readback_mismatch");
        }
        catch (Exception) { return ("unknown", "selection_readback_unavailable", "readback_unavailable"); }
    }
    if (TryGetPattern(el, TogglePattern.Pattern, out var tp, out var tc))
    {
        var tgl = (TogglePattern)tp;
        ToggleState before;
        try { before = Flavor(tc, () => tgl.Cached.ToggleState, () => tgl.Current.ToggleState); }
        catch (Exception) { return ("unknown", "toggle_prestate_unreadable", "readback_unavailable"); }
        if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
        try { tgl.Toggle(); }
        catch (ElementNotAvailableException) { return ("unknown", "element_died_during_toggle", "readback_unavailable"); }
        catch (InvalidOperationException) { return ("unknown", "toggle_failed", "readback_unavailable"); }
        try
        {
            var after = Flavor(tc, () => tgl.Cached.ToggleState, () => tgl.Current.ToggleState);
            if (after != before) return ("verified", null, "toggle_state_readback_changed");
            return ("unknown", "toggle_state_unchanged_after_action", "readback_mismatch");
        }
        catch (Exception) { return ("unknown", "toggle_readback_unavailable", "readback_unavailable"); }
    }
    if (TryGetPattern(el, InvokePattern.Pattern, out var ip, out _))
    {
        if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
        try { ((InvokePattern)ip).Invoke(); }
        catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
        catch (InvalidOperationException) { return ("unknown", "invoke_failed_after_dispatch", "readback_unavailable"); }
        // Invoke has no observable state contract; dispatch success is the
        // verification level for this path.
        return ("verified", null, "invoke_dispatched_no_state_readback");
    }
    return ("refused", "no_invoke_toggle_selection_pattern", "none");
}

static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

/// Bounding rectangles of offscreen elements can be +/-Infinity, which
/// System.Text.Json refuses to serialize; map non-finite floats to 0.
static double Fin(double v) => double.IsFinite(v) ? v : 0d;

static uint OwningPid(IntPtr hwnd)
{
    RpcInterop.GetWindowThreadProcessId(hwnd, out var pid);
    return pid;
}

static long? ProcessStartTime(uint pid)
{
    var h = RpcInterop.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return null; // UIPI/elevation: no query right; revalidation degrades to HWND+PID
    try
    {
        return RpcInterop.GetProcessTimes(h, out var creation, out _, out _, out _) ? creation : null;
    }
    finally { _ = RpcInterop.CloseHandle(h); }
}

sealed class UiaWork
{
    // 0=pending/prevalidation, 1=provider dispatch has begun, 2=cancelled
    // before dispatch. The CAS is the serialization point between cancel and
    // a mutating UIA call.
    private int _dispatchState;
    public string Op { get; }
    public JsonNode Params { get; }
    public JsonNode? Id { get; init; }
    public string Key { get; } = Guid.NewGuid().ToString("N");
    public volatile bool Cancelled;
    public TaskCompletionSource<(JsonObject? result, string? error)> Tcs { get; } = new();

    public UiaWork(string op, JsonNode prms)
    {
        Op = op;
        Params = prms;
    }

    public void RequestCancel()
    {
        Cancelled = true;
        _ = Interlocked.CompareExchange(ref _dispatchState, 2, 0);
    }

    public bool TryBeginDispatch() =>
        Interlocked.CompareExchange(ref _dispatchState, 1, 0) == 0;
}

/// Snapshot registry entry. Element tokens are opaque and resolve only here;
/// the AutomationElement COM proxies live on the UIA lane thread.
sealed class SnapshotEntry
{
    private readonly List<(string token, AutomationElement el, int[]? runtimeId)> _elements = new();
    public long Hwnd { get; }
    public uint Pid { get; }
    public long StartTimeUtc { get; }
    public string WindowGen { get; }
    public string HelperGeneration { get; }
    public AutomationElement Root { get; }

    public SnapshotEntry(long hwnd, uint pid, long startTimeUtc, string windowGen, AutomationElement root)
    {
        Hwnd = hwnd;
        Pid = pid;
        StartTimeUtc = startTimeUtc;
        WindowGen = windowGen;
        HelperGeneration = RuntimeIdentity.HelperGeneration;
        Root = root;
    }

    public string AddElement(AutomationElement el)
    {
        if (_elements.Count >= 2000)
            throw new InvalidOperationException("snapshot_element_limit");
        // Tokens must not be reusable across snapshots: a caller mixing an
        // old token with a new snapshot must fail closed.
        var token = $"el-{Guid.NewGuid():N}";
        _elements.Add((token, el, RuntimeId(el)));
        return token;
    }

    public bool TryGetElement(string token, out AutomationElement el)
    {
        foreach (var (t, e, savedRuntimeId) in _elements)
        {
            if (t == token)
            {
                // RuntimeId is stable for the retained provider element. If
                // it was unavailable at either point, refuse rather than
                // silently treating a recycled provider proxy as identical.
                var currentRuntimeId = RuntimeId(e);
                if (savedRuntimeId is null || currentRuntimeId is null || !savedRuntimeId.SequenceEqual(currentRuntimeId))
                {
                    el = null!;
                    return false;
                }
                el = e;
                return true;
            }
        }
        el = null!;
        return false;
    }

    static int[]? RuntimeId(AutomationElement el)
    {
        try { return el.GetRuntimeId(); }
        catch (ElementNotAvailableException) { return null; }
        catch (COMException) { return null; }
        catch (InvalidOperationException) { return null; }
    }
}

static class RpcInterop
{
    [DllImport("ole32.dll")]
    public static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationTime, out long lpExitTime, out long lpKernelTime, out long lpUserTime);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}

static class RuntimeIdentity
{
    // A fresh helper process owns a unique namespace for snapshots/tokens.
    // The process id is retained for readable diagnostics but is not the
    // generation value because Windows may reuse a pid.
    public static readonly string HelperGeneration = $"{Environment.ProcessId}-{Guid.NewGuid():N}";
}

static class RpcOutput
{
    static readonly BlockingCollection<string> Queue = new(64);
    static RpcOutput()
    {
        var writer = new Thread(() =>
        {
            foreach (var line in Queue.GetConsumingEnumerable())
            {
                try
                {
                    Console.Out.WriteLine(line);
                    Console.Out.Flush();
                }
                catch { Environment.Exit(2); }
            }
        }) { IsBackground = true, Name = "rpc-stdout-writer" };
        writer.Start();
    }

    public static void Enqueue(string line)
    {
        if (!Queue.TryAdd(line, millisecondsTimeout: 100))
            Environment.Exit(2);
    }
}
