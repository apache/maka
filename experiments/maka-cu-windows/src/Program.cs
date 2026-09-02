// SPDX-License-Identifier: Apache-2.0
//
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
const int MAX_TREE_RENDER_DEPTH = 12;  // bounded deep skeleton; controls are retained
const int MAX_COMPAT_TEXT = 1024;
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
var compatAuthorizations = new ConcurrentDictionary<string, CompatAuthorization>();
var uiaThread = new Thread(() => UiaLoop(inbox, active, requests, registry, compatAuthorizations)) { IsBackground = true, Name = "uia-mta" };
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
    _ = HandleRequestAsync(method, id, prms, inbox, active, requests, registry, compatAuthorizations);
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
    ConcurrentDictionary<string, SnapshotEntry> registry,
    ConcurrentDictionary<string, CompatAuthorization> compatAuthorizations)
{
    try
    {
        if (method == "initialize") { WriteLine(ResultRpc(id, InitializeResult())); return; }
        if (method is not ("list_windows" or "observe" or "act" or "capture" or "debug_sleep" or "authorize_compat"))
        { WriteLine(ErrorRpc(id, -32601, $"method_not_found: {method}")); return; }
        var work = new UiaWork(method, prms) { Id = id?.DeepClone(), CompatAuthorizations = compatAuthorizations };
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
        ["semanticActions"] = new JsonArray("set_value", "click_element", "select", "toggle", "scroll"),
        ["input"] = new JsonObject
        {
            ["foreground"] = false,
            ["globalPointer"] = false,
            ["postMessage"] = false,
            ["sendInput"] = false,
        },
        ["compatibilityInput"] = new JsonObject
        {
            ["enabled"] = true,
            ["default"] = "refused",
            ["ops"] = new JsonArray("compat_type_text", "compat_press_enter"),
            ["requiresAuthorization"] = true,
            ["authorizationTtlMs"] = 5000,
            ["foregroundFocusConfirmed"] = true,
            ["sendInput"] = "single_unicode_or_vk_return",
            // Diagnostic only: this is the exact cbSize passed to Win32 for
            // every compatibility-input batch.  It must match the complete
            // WinUser.h INPUT ABI, including the mouse union member.
            ["inputAbi"] = new JsonObject
            {
                ["pointerSize"] = IntPtr.Size,
                ["inputSize"] = InputAbi.InputSize,
                ["unionSize"] = InputAbi.UnionSize,
                ["mouseInputSize"] = InputAbi.MouseInputSize,
                ["keyboardInputSize"] = InputAbi.KeyboardInputSize,
                ["hardwareInputSize"] = InputAbi.HardwareInputSize,
                ["typeOffset"] = InputAbi.TypeOffset,
                ["unionOffset"] = InputAbi.UnionOffset,
                ["sendInputCbSize"] = InputAbi.SendInputCbSize,
            },
            ["readbackFailure"] = "unknown",
        },
        ["capture"] = new JsonObject { ["targetWindowWgc"] = true, ["screenRect"] = false },
    },
    ["limits"] = new JsonObject
    {
        ["maxTreeNodes"] = MAX_TREE_NODES,
        ["maxTreeDepth"] = MAX_TREE_DEPTH,
        ["maxTreeMillis"] = MAX_TREE_MILLIS,
        ["maxTreeRenderDepth"] = MAX_TREE_RENDER_DEPTH,
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
    ConcurrentDictionary<string, UiaWork> requests, ConcurrentDictionary<string, SnapshotEntry> registry,
    ConcurrentDictionary<string, CompatAuthorization> compatAuthorizations)
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
                "act" => Act(work.Params, work, registry, compatAuthorizations),
                "authorize_compat" => AuthorizeCompat(work.Params, registry, compatAuthorizations),
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
    var limits = ReadTreeLimits(prms);
    var truncatedReasons = new HashSet<string>();

    var sw = Stopwatch.StartNew();
    var nodes = new JsonArray();
    var count = 1;
    var truncated = false;
    nodes.Add(BuildNode(target, rootToken));
    // Actionable discovery runs first so a large render skeleton cannot
    // consume the shared node/time budget before controls are probed.
    // Budget checks between nodes cannot interrupt a stuck COM call.
    var beforeActionable = count;
    count = FindActionable(target, nodes, snapshot, count, 1, limits, sw, truncatedReasons, ref truncated);
    var actionableAdded = count - beforeActionable;
    var beforeRender = count;
    count = Walk(target, nodes, snapshot, count, 1, limits, sw, truncatedReasons, ref truncated);
    var renderAdded = count - beforeRender;

    var id = $"snap-{Guid.NewGuid():N}";
    registry[id] = snapshot;
    var reasonArray = new JsonArray();
    foreach (var reason in truncatedReasons.OrderBy(item => item, StringComparer.Ordinal))
        reasonArray.Add(reason);

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
            ["visitedNodeCount"] = snapshot.VisitedNodes,
            ["maxRawDepthVisited"] = snapshot.MaxRawDepthVisited,
            ["truncated"] = truncated,
            ["truncatedReasons"] = reasonArray,
            ["elapsedMs"] = sw.ElapsedMilliseconds,
            ["limits"] = new JsonObject
            {
                ["maxTreeNodes"] = limits.MaxNodes,
                ["maxTreeMillis"] = limits.MaxMillis,
                ["maxRenderDepth"] = limits.MaxRenderDepth,
                ["maxActionableDepth"] = limits.MaxActionableDepth,
            },
            ["passes"] = new JsonObject
            {
                ["actionableAdded"] = actionableAdded,
                ["renderAdded"] = renderAdded,
            },
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

static TreeLimits ReadTreeLimits(JsonNode prms)
{
    var limits = new TreeLimits(MAX_TREE_NODES, MAX_TREE_MILLIS, MAX_TREE_RENDER_DEPTH, MAX_TREE_DEPTH);
    if (prms["debugLimits"] is not JsonObject debug)
        return limits;
    int ClampLimit(string name, int fallback, int max)
    {
        if (debug[name] is JsonValue value && value.TryGetValue<int>(out var parsed) && parsed > 0)
            return Math.Min(parsed, max);
        return fallback;
    }
    return new TreeLimits(
        ClampLimit("maxTreeNodes", limits.MaxNodes, MAX_TREE_NODES),
        ClampLimit("maxTreeMillis", limits.MaxMillis, MAX_TREE_MILLIS),
        ClampLimit("maxRenderDepth", limits.MaxRenderDepth, MAX_TREE_RENDER_DEPTH),
        ClampLimit("maxActionableDepth", limits.MaxActionableDepth, MAX_TREE_DEPTH));
}

static void MarkTruncated(ref bool truncated, HashSet<string> reasons, string reason)
{
    truncated = true;
    reasons.Add(reason);
}

static bool BudgetExhausted(int count, Stopwatch sw, TreeLimits limits, HashSet<string> reasons, ref bool truncated)
{
    if (count >= limits.MaxNodes)
    {
        MarkTruncated(ref truncated, reasons, "max_nodes");
        return true;
    }
    if (sw.ElapsedMilliseconds >= limits.MaxMillis)
    {
        MarkTruncated(ref truncated, reasons, "max_millis");
        return true;
    }
    return false;
}

/// Level-by-level cached walk over the bounded render skeleton. Each node's
/// children are fetched with a children-scoped properties-only CacheRequest
/// (one small provider call per node, ms budget enforced between nodes).
/// The render depth is intentionally smaller than the actionable traversal;
/// the latter still uses children-scoped queries to find deep controls without
/// issuing a provider-wide Descendants query (see FindActionable).
static int Walk(AutomationElement parent, JsonArray nodes, SnapshotEntry snap, int count, int depth,
    TreeLimits limits, Stopwatch sw, HashSet<string> truncatedReasons, ref bool truncated)
{
    if (BudgetExhausted(Math.Max(count, snap.VisitedNodes), sw, limits, truncatedReasons, ref truncated))
        return count;
    // Permit nodes at the render boundary, and only report truncation when a
    // child would have required walking beyond it. This avoids marking a
    // naturally leaf-shaped tree as truncated merely because its leaf is at
    // the boundary.

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
    catch (ElementNotAvailableException)
    {
        MarkTruncated(ref truncated, truncatedReasons, "element_unavailable");
        return count;
    }
    catch (System.Runtime.InteropServices.COMException)
    {
        MarkTruncated(ref truncated, truncatedReasons, "provider_error");
        return count;
    }

    foreach (AutomationElement child in children)
    {
        if (depth > limits.MaxRenderDepth)
        {
            MarkTruncated(ref truncated, truncatedReasons, "render_depth");
            return count;
        }
        if (BudgetExhausted(Math.Max(count, snap.VisitedNodes), sw, limits, truncatedReasons, ref truncated))
            return count;
        snap.RecordVisit(depth);
        var token = snap.AddElement(child);
        var node = BuildCachedNode(child, token);
        node["rawDepth"] = depth;
        node["parentRuntimeId"] = System.Text.Json.JsonSerializer.SerializeToNode(SnapshotEntry.RuntimeId(parent));
        nodes.Add(node);
        count++;
        count = Walk(child, nodes, snap, count, depth + 1, limits, sw, truncatedReasons, ref truncated);
    }
    return count;
}

/// Targeted discovery of actionable elements. This is a bounded children-only
/// traversal rather than Descendants/FindAll: every actionable element is
/// visited (including multiple controls of the same type), while each node's
/// child query remains scoped and the global node/time/depth budgets still
/// fail closed. Found elements are LIVE (no cache request), so pattern
/// probing works on them. Cached render nodes cannot probe patterns (patterns
/// are not cached — that was prohibitively slow on Chromium), so actionable
/// candidates always come from this pass.
static int FindActionable(AutomationElement root, JsonArray nodes, SnapshotEntry snap, int count, int depth,
    TreeLimits limits, Stopwatch sw, HashSet<string> truncatedReasons, ref bool truncated)
{
    var actionable = new HashSet<ControlType>
    {
        ControlType.Edit, ControlType.ComboBox, ControlType.Button, ControlType.Hyperlink,
        ControlType.CheckBox, ControlType.RadioButton, ControlType.ListItem,
        ControlType.TabItem, ControlType.MenuItem, ControlType.List, ControlType.Tree,
        ControlType.DataGrid, ControlType.ScrollBar, ControlType.Pane,
        // Web scroll containers can be Group/Custom/Document, not only Pane.
        // Probe the container itself; never silently act on an ancestor.
        ControlType.Group, ControlType.Custom, ControlType.Document,
    };
    return FindActionableChildren(root, nodes, snap, count, depth, actionable, limits, sw, truncatedReasons, ref truncated);
}

static int FindActionableChildren(AutomationElement parent, JsonArray nodes, SnapshotEntry snap,
    int count, int depth, HashSet<ControlType> actionable, TreeLimits limits, Stopwatch sw,
    HashSet<string> truncatedReasons, ref bool truncated)
{
    if (BudgetExhausted(Math.Max(count, snap.VisitedNodes), sw, limits, truncatedReasons, ref truncated))
        return count;

    var request = new CacheRequest { TreeScope = TreeScope.Element };
    request.Add(AutomationElement.ControlTypeProperty);
    AutomationElementCollection children;
    try
    {
        using (request.Activate())
        {
            children = parent.FindAll(TreeScope.Children, Condition.TrueCondition);
        }
    }
    catch (ElementNotAvailableException)
    {
        MarkTruncated(ref truncated, truncatedReasons, "element_unavailable");
        return count;
    }
    catch (System.Runtime.InteropServices.COMException)
    {
        MarkTruncated(ref truncated, truncatedReasons, "provider_error");
        return count;
    }

    foreach (AutomationElement child in children)
    {
        if (depth > limits.MaxActionableDepth)
        {
            MarkTruncated(ref truncated, truncatedReasons, "actionable_depth");
            return count;
        }
        if (BudgetExhausted(Math.Max(count, snap.VisitedNodes), sw, limits, truncatedReasons, ref truncated))
            return count;
        // Count every inspected node, including unnamed/non-actionable wrappers.
        // Repeated visits in the render pass also consume the shared budget.
        snap.RecordVisit(depth);

        try
        {
            if (actionable.Contains(child.Cached.ControlType))
            {
                var token = snap.AddElement(child);
                var node = BuildNode(child, token);
                node["rawDepth"] = depth;
                node["parentRuntimeId"] = System.Text.Json.JsonSerializer.SerializeToNode(SnapshotEntry.RuntimeId(parent));
                nodes.Add(node);
                count++;
            }
        }
        catch (ElementNotAvailableException)
        {
            nodes.Add(new JsonObject
            {
                ["token"] = snap.AddElement(child),
                ["controlType"] = "(unavailable)",
                ["name"] = "(element_died)",
                ["isEnabled"] = false,
                ["bounds"] = new JsonArray(0, 0, 0, 0),
                ["patterns"] = new JsonArray(),
            });
            count++;
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            MarkTruncated(ref truncated, truncatedReasons, "provider_error");
        }

        count = FindActionableChildren(child, nodes, snap, count, depth + 1, actionable, limits, sw, truncatedReasons, ref truncated);
        if (truncated && (count >= limits.MaxNodes || sw.ElapsedMilliseconds >= limits.MaxMillis))
            return count;
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
            ["runtimeId"] = System.Text.Json.JsonSerializer.SerializeToNode(SnapshotEntry.RuntimeId(el)),
            ["observationSource"] = "live-patterns",
            ["controlType"] = el.Current.ControlType.ProgrammaticName,
            ["name"] = Truncate(el.Current.Name ?? "", 256),
            ["automationId"] = Truncate(el.Current.AutomationId ?? "", 128),
            ["className"] = Truncate(el.Current.ClassName ?? "", 128),
            ["isEnabled"] = el.Current.IsEnabled,
            ["isOffscreen"] = el.Current.IsOffscreen,
            ["bounds"] = new JsonArray(Fin(bounds.X), Fin(bounds.Y), Fin(bounds.Width), Fin(bounds.Height)),
            ["patterns"] = patterns,
            ["actions"] = ActionNames(patterns),
            // Live value readback for Value-pattern nodes (used by the
            // driver to verify mutations / absence of mutations).
            ["value"] = patterns.Any(p => p?.GetValue<string>() == "Value") ? ReadValueLive(el) : null,
            ["scrollState"] = patterns.Any(p => p?.GetValue<string>() == "Scroll") ? ReadScrollLive(el) : null,
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

static JsonObject? ReadScrollLive(AutomationElement el)
{
    try
    {
        if (!el.TryGetCurrentPattern(ScrollPattern.Pattern, out var p)) return null;
        var current = ((ScrollPattern)p).Current;
        var horizontal = current.HorizontalScrollPercent;
        var vertical = current.VerticalScrollPercent;
        return new JsonObject
        {
            ["source"] = "ScrollPattern.Current",
            ["horizontalPercent"] = double.IsFinite(horizontal) ? horizontal : null,
            ["verticalPercent"] = double.IsFinite(vertical) ? vertical : null,
        };
    }
    catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
    { return null; }
}

static JsonArray ActionNames(JsonArray patterns)
{
    var actions = new JsonArray();
    foreach (var pattern in patterns)
    {
        switch (pattern?.GetValue<string>())
        {
            case "Value": actions.Add("set_value"); break;
            case "Invoke": actions.Add("click_element"); break;
            case "SelectionItem": actions.Add("select"); break;
            case "Toggle": actions.Add("toggle"); break;
            case "Scroll": actions.Add("scroll"); break;
        }
    }
    if (patterns.Any(p => p?.GetValue<string>() is "SelectionItem" or "Toggle")
        && !actions.Any(a => a?.GetValue<string>() == "click_element")) actions.Add("click_element");
    return actions;
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
        ["runtimeId"] = System.Text.Json.JsonSerializer.SerializeToNode(SnapshotEntry.RuntimeId(el)),
        ["observationSource"] = "cached-properties",
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
        if (TryGetPattern(el, ScrollPattern.Pattern, out _, out _)) patterns.Add("Scroll");
        if (TryGetPattern(el, ScrollItemPattern.Pattern, out _, out _)) patterns.Add("ScrollItem");
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

static (JsonObject?, string?) AuthorizeCompat(JsonNode prms,
    ConcurrentDictionary<string, SnapshotEntry> registry,
    ConcurrentDictionary<string, CompatAuthorization> authorizations)
{
    if (prms is not JsonObject parameters) return (null, "compat_authorization_invalid");
    var snapshotId = parameters["snapshotId"]?.GetValue<string>();
    var elementToken = parameters["elementToken"]?.GetValue<string>();
    var op = parameters["op"]?.GetValue<string>();
    if (snapshotId is null || elementToken is null || op is null)
        return (null, "compat_authorization_missing");
    if (op is not ("compat_type_text" or "compat_press_enter"))
        return (null, "compat_unsupported");
    string? payload;
    if (op == "compat_type_text")
    {
        if (parameters["value"] is not JsonValue valueNode || !valueNode.TryGetValue<string>(out payload))
            return (null, "compat_payload_invalid");
    }
    else
    {
        if (parameters.ContainsKey("value")) return (null, "compat_payload_invalid");
        payload = "";
    }
    if (payload.Length > MAX_COMPAT_TEXT || payload.Any(char.IsControl))
        return (null, "compat_payload_invalid");
    if (!registry.TryGetValue(snapshotId, out var snapshot))
        return (null, "snapshot_spent_or_unknown");
    if (!snapshot.TryGetElementIdentity(elementToken, out _, out var runtimeId))
        return (null, "element_token_unknown_in_snapshot");
    if (!TargetIdentityMatches(snapshot))
        return (null, "stale_target_revalidate_failed");
    // Expired authorizations are retained only for one request at most.  This
    // prevents refused/abandoned requests from filling the bounded registry.
    var nowTicks = Stopwatch.GetTimestamp();
    foreach (var entry in authorizations)
    {
        if (entry.Value.ExpiresAtTicks <= nowTicks)
            authorizations.TryRemove(entry.Key, out _);
    }
    if (authorizations.Count >= MAX_SNAPSHOTS)
        return (null, "compat_authorization_registry_full");
    var token = $"auth-{Guid.NewGuid():N}";
    authorizations[token] = new CompatAuthorization(token, snapshotId, elementToken,
        snapshot.Hwnd, snapshot.Pid, snapshot.StartTimeUtc, snapshot.WindowGen,
        snapshot.HelperGeneration, runtimeId, op, payload,
        Stopwatch.GetTimestamp() + (Stopwatch.Frequency * 5));
    return (new JsonObject
    {
        ["authorizationToken"] = token,
        ["snapshotId"] = snapshotId,
        ["elementToken"] = elementToken,
        ["op"] = op,
        ["expiresMs"] = 5000,
    }, null);
}

static (JsonObject?, string?) CompatAct(JsonObject parameters, UiaWork work,
    ConcurrentDictionary<string, SnapshotEntry> registry,
    ConcurrentDictionary<string, CompatAuthorization> authorizations)
{
    var authToken = parameters["authorizationToken"]?.GetValue<string>();
    var snapshotId = parameters["snapshotId"]?.GetValue<string>();
    var elementToken = parameters["elementToken"]?.GetValue<string>();
    var op = parameters["op"]?.GetValue<string>();
    if (authToken is null || snapshotId is null || elementToken is null || op is null)
        return (null, "compat_authorization_missing");
    if (!authorizations.TryGetValue(authToken, out var auth))
        return (null, "compat_authorization_unknown");
    string? payload;
    if (op == "compat_type_text")
    {
        if (parameters["value"] is not JsonValue valueNode || !valueNode.TryGetValue<string>(out payload))
            return (null, "compat_payload_invalid");
    }
    else
    {
        if (parameters.ContainsKey("value")) return (null, "compat_payload_invalid");
        payload = "";
    }
    if (auth.Op != op || auth.SnapshotId != snapshotId ||
        auth.ElementToken != elementToken || auth.Payload != payload ||
        (op is not ("compat_type_text" or "compat_press_enter")))
        return (null, "compat_authorization_mismatch");
    if (Stopwatch.GetTimestamp() > auth.ExpiresAtTicks)
    {
        authorizations.TryRemove(authToken, out _);
        return (null, "compat_authorization_expired");
    }
    if (!authorizations.TryRemove(authToken, out _))
        return (null, "compat_authorization_unknown");
    if (!registry.TryRemove(snapshotId, out var snapshot))
        return (null, "snapshot_spent_or_unknown");
    var hwnd = new IntPtr(snapshot.Hwnd);
    if (snapshot.HelperGeneration != auth.HelperGeneration ||
        snapshot.Hwnd != auth.Hwnd || snapshot.Pid != auth.Pid ||
        snapshot.StartTimeUtc != auth.StartTimeUtc || snapshot.WindowGen != auth.WindowGen ||
        !snapshot.TryGetElementIdentity(elementToken, out var element, out var runtimeId) ||
        !runtimeId.SequenceEqual(auth.RuntimeId) || !TargetIdentityMatches(snapshot))
        return (null, "stale_target_revalidate_failed");
    var focusReason = "focus_or_foreground_not_confirmed";
    if (work.Cancelled || !TryPrepareFocusedTarget(hwnd, element, auth.RuntimeId, out focusReason))
        return CompatOutcome("refused", "focus_refused", "none", "none", true, true, focusReason);
    // This is the final pre-dispatch identity/focus check.  A final cheap
    // foreground read is performed immediately before SendInput below.  The
    // OS can still race focus between checks and dispatch, so target isolation
    // is never claimed to be atomic or fully detectable.
    if (!TryConfirmFocusedTarget(hwnd, auth.RuntimeId, out focusReason) || !TargetIdentityMatches(snapshot))
        return CompatOutcome("refused", "focus_refused", "none", "none", true, true, focusReason);
    if (!work.TryBeginDispatch())
        return CompatOutcome("refused", "cancelled_before_dispatch", "none", "no_mutation", true, true, null);
    if (RpcInterop.GetForegroundWindow() != hwnd)
        return CompatOutcome("refused", "focus_refused", "none", "none", true, true, "foreground_mismatch");

    var result = op == "compat_type_text"
        ? SendUnicodeText(payload)
        : SendReturnKey();
    if (!result.Complete)
        return CompatOutcome("unknown", "send_input_partial_or_failed", "possibly_dispatched", "send_input_unknown", true, true, null,
            null, result.ToJson());
    if (!TargetIdentityMatches(snapshot))
        return CompatOutcome("unknown", "post_dispatch_target_changed", "possibly_dispatched", "post_dispatch_identity_changed", true, true, null);
    if (op == "compat_type_text")
    {
        var readback = ValueReadback.Run(() =>
        {
            try
            {
                if (!TargetIdentityMatches(snapshot) || !auth.RuntimeId.SequenceEqual(SnapshotEntry.RuntimeId(element) ?? Array.Empty<int>()))
                    return (false, "readback_identity_changed");
                if (element.Current.IsPassword) return (false, "readback_password_field_refused");
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var fresh)) return (false, "readback_unavailable");
                var actual = ((ValuePattern)fresh).Current.Value;
                if (actual.EnumerateRunes().Count() > MAX_COMPAT_TEXT) return (false, "readback_value_too_long");
                if (!TargetIdentityMatches(snapshot) || !auth.RuntimeId.SequenceEqual(SnapshotEntry.RuntimeId(element) ?? Array.Empty<int>()))
                    return (false, "readback_identity_changed");
                return (actual == payload, (string?)null);
            }
            catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
            { return (false, "readback_unavailable"); }
        }, () => work.Cancelled);
        return CompatOutcome(readback.status, readback.status == "verified" ? null : readback.verification,
            readback.status == "verified" ? "text_set" : "possibly_dispatched", readback.verification,
            true, true, null, JsonSerializer.SerializeToNode(readback));
    }
    return CompatOutcome("unknown", "compat_enter_readback_unavailable", "possibly_dispatched", "readback_unavailable", true, true, null);
}

static (JsonObject?, string?) CompatOutcome(string status, string? reason, string effect,
    string verification, bool snapshotSpent, bool authorizationSpent, string? focusReason,
    JsonNode? readback = null, JsonNode? sendInput = null)
{
    return (new JsonObject
    {
        ["outcome"] = new JsonObject
        {
            ["tier"] = "compatibility",
            ["path"] = "send_input",
            ["status"] = status,
            ["reason"] = focusReason ?? reason,
            ["effect"] = effect,
            ["snapshotSpent"] = snapshotSpent,
            ["authorizationSpent"] = authorizationSpent,
            ["verification"] = verification,
            ["readback"] = readback,
            ["sendInput"] = sendInput,
        },
    }, null);
}

static bool TargetIdentityMatches(SnapshotEntry snapshot)
{
    var hwnd = new IntPtr(snapshot.Hwnd);
    var nowStart = ProcessStartTime(snapshot.Pid);
    var nowGen = WgcCapture.WindowGeneration(hwnd);
    return RpcInterop.IsWindow(hwnd) && snapshot.Pid == OwningPid(hwnd) &&
        nowStart is long start && start == snapshot.StartTimeUtc &&
        nowGen is string generation && generation == snapshot.WindowGen &&
        snapshot.HelperGeneration == RuntimeIdentity.HelperGeneration;
}

static bool TryPrepareFocusedTarget(IntPtr hwnd, AutomationElement element, int[] expectedRuntimeId, out string reason)
{
    reason = "focus_or_foreground_not_confirmed";
    if (!RpcInterop.IsWindow(hwnd) || RpcInterop.GetAncestor(hwnd, 2) != hwnd)
    { reason = "target_not_top_level_window"; return false; }
    if (!RpcInterop.SetForegroundWindow(hwnd)) { reason = "set_foreground_failed"; return false; }
    var uiaFocusSucceeded = false;
    try { element.SetFocus(); uiaFocusSucceeded = true; } catch { /* fallback below is restricted */ }
    var native = IntPtr.Zero;
    try { native = new IntPtr(element.Current.NativeWindowHandle); } catch { }
    // UIA SetFocus must win for virtual controls such as Chromium web inputs.
    // Win32 SetFocus is only a fallback after UIA failure and only for a real
    // child HWND; never steal focus by targeting the top-level window.
    if (!uiaFocusSucceeded && native != IntPtr.Zero && RpcInterop.IsWindow(native) &&
        RpcInterop.GetAncestor(native, 2) == hwnd)
        _ = RpcInterop.SetFocus(native);
    if (RpcInterop.GetForegroundWindow() != hwnd) { reason = "foreground_mismatch"; return false; }
    try
    {
        var focused = AutomationElement.FocusedElement;
        var focusedRuntime = focused.GetRuntimeId();
        if (!expectedRuntimeId.SequenceEqual(focusedRuntime)) { reason = "focused_element_mismatch"; return false; }
    }
    catch { reason = "focused_element_unavailable"; return false; }
    return true;
}

static bool TryConfirmFocusedTarget(IntPtr hwnd, int[] expectedRuntimeId, out string reason)
{
    reason = "focus_or_foreground_not_confirmed";
    if (RpcInterop.GetForegroundWindow() != hwnd)
    { reason = "foreground_mismatch"; return false; }
    try
    {
        var focused = AutomationElement.FocusedElement;
        if (!expectedRuntimeId.SequenceEqual(focused.GetRuntimeId()))
        { reason = "focused_element_mismatch"; return false; }
    }
    catch { reason = "focused_element_unavailable"; return false; }
    return true;
}

static SendInputReport SendUnicodeText(string value)
{
    if (value.Length > MAX_COMPAT_TEXT || value.Any(char.IsControl))
        return new(0, 0, InputAbi.SendInputCbSize, 0);
    var inputs = new INPUT[value.Length * 2];
    for (var i = 0; i < value.Length; i++)
    {
        inputs[i * 2] = UnicodeInput(value[i], false);
        inputs[(i * 2) + 1] = UnicodeInput(value[i], true);
    }
    return SendInputBatch(inputs);
}

static SendInputReport SendReturnKey()
{
    var inputs = new[] { VirtualKeyInput(0x0D, false), VirtualKeyInput(0x0D, true) };
    return SendInputBatch(inputs);
}

static SendInputReport SendInputBatch(INPUT[] inputs)
{
    var cbSize = InputAbi.SendInputCbSize;
    var inserted = RpcInterop.SendInput((uint)inputs.Length, inputs, cbSize);
    // GetLastError is meaningful only for a failed/partial call. Do not
    // expose a stale process error value on successful dispatch.
    var lastError = inserted == inputs.Length ? 0 : Marshal.GetLastWin32Error();
    return new(inputs.Length, inserted, cbSize, lastError);
}

static INPUT UnicodeInput(char value, bool keyUp) => new()
{
    type = 1,
    U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = value, dwFlags = 0x0004u | (keyUp ? 0x0002u : 0u) } },
};
static INPUT VirtualKeyInput(ushort key, bool keyUp) => new()
{
    type = 1,
    U = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, wScan = 0, dwFlags = keyUp ? 0x0002u : 0u } },
};

static (JsonObject?, string?) Act(JsonNode prms, UiaWork work,
    ConcurrentDictionary<string, SnapshotEntry> registry,
    ConcurrentDictionary<string, CompatAuthorization> compatAuthorizations)
{
    if (prms is not JsonObject parameters) return (null, "invalid_params");
    var snapId = parameters["snapshotId"]?.GetValue<string>();
    var token = parameters["elementToken"]?.GetValue<string>();
    var op = parameters["op"]?.GetValue<string>();
    if (snapId is null || token is null || op is null) return (null, "missing_required_param");
    if (op is "compat_type_text" or "compat_press_enter")
        return CompatAct(parameters, work, registry, work.CompatAuthorizations!);
    if (op == "press_enter")
    {
        return (new JsonObject
        {
            ["outcome"] = new JsonObject
            {
                ["tier"] = "compatibility",
                ["path"] = "unsupported",
                ["status"] = "refused",
                ["reason"] = "unsupported_enter",
                ["effect"] = "none",
                ["snapshotSpent"] = false,
                ["verification"] = "not_dispatched",
            },
        }, null);
    }
    if (op is not ("set_value" or "click_element" or "select" or "toggle" or "scroll"))
        return (null, $"unsupported_op:{op}");
    string? value = null;
    if (op == "set_value")
    {
        if (parameters["value"] is not JsonValue valueNode || !valueNode.TryGetValue<string>(out value))
            return (null, "invalid_value");
        if (value.EnumerateRunes().Count() > MAX_COMPAT_TEXT) return (null, "value_too_long");
    }
    var scrollDirection = parameters["direction"]?.GetValue<string>() ?? "vertical";
    var scrollAmount = parameters["amount"]?.GetValue<string>() ?? "small_increment";
    if (op == "scroll" && scrollDirection is not ("horizontal" or "vertical"))
        return (null, "invalid_scroll_direction");
    if (op == "scroll" && scrollAmount is not ("small_increment" or "small_decrement" or "large_increment" or "large_decrement" or "no_amount"))
        return (null, "invalid_scroll_amount");
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

    if (!snap.TryGetElementIdentity(token, out var el, out var expectedRuntimeId)) return (null, "element_token_unknown_in_snapshot");

    // Atomic snapshot spend BEFORE dispatch (check 3): the snapshot is
    // consumed by this attempt regardless of dispatch outcome or cancellation.
    registry.TryRemove(snapId, out _);

    ValueReadbackReport? readback = null;
    ScrollReadbackReport? scrollReadback = null;
    (string status, string? reason, string verification) = op switch
    {
        // The CAS is deliberately inside the pattern helper, immediately
        // before the provider mutator. Pattern lookup/readback may block.
        "set_value" => SetValueVerified(el, value!, work, snap, expectedRuntimeId, out readback),
        "click_element" => ClickVerified(el, work.TryBeginDispatch),
        "select" => SelectVerified(el, work.TryBeginDispatch),
        "toggle" => ToggleVerified(el, work.TryBeginDispatch),
        "scroll" => ScrollVerified(el, scrollDirection, scrollAmount, work, snap, expectedRuntimeId, out scrollReadback),
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
            ["path"] = op switch
            {
                "set_value" => "value_pattern",
                "click_element" => "invoke_toggle_selection",
                "select" => "selection_item_pattern",
                "toggle" => "toggle_pattern",
                "scroll" => "scroll_pattern",
                _ => "none",
            },
            ["status"] = status,
            ["reason"] = reason,
            ["effect"] = status == "verified" ? op switch
            {
                "set_value" => "value_set",
                "select" => "selected",
                "toggle" => "toggled",
                "scroll" => "scrolled",
                _ => "invoked",
            }
                : status == "unknown" ? "possibly_dispatched" : "none",
            ["snapshotSpent"] = true,
            ["verification"] = verification,
            ["readback"] = scrollReadback is not null ? JsonSerializer.SerializeToNode(scrollReadback)
                : readback is not null ? JsonSerializer.SerializeToNode(readback) : null,
        }
    }, null);
}

static (string status, string? reason, string verification) SetValueVerified(AutomationElement el, string value,
    UiaWork work, SnapshotEntry snapshot, int[] expectedRuntimeId, out ValueReadbackReport? readback)
{
    readback = null;
    // Current-only: a snapshot's cached value is not post-mutation evidence.
    if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out var p)) return ("refused", "value_pattern_unavailable", "none");
    var vp = (ValuePattern)p;
    if (vp.Current.IsReadOnly) return ("refused", "value_pattern_readonly", "none");
    // .NET Core's UIAutomationClient has no ValuePatternInformation.IsPassword;
    // read the element-level UIA_IsPasswordPropertyId instead.
    if (el.Current.IsPassword) return ("refused", "password_field_refused", "none");
    bool SameIdentity() => expectedRuntimeId.Length > 0 && TargetIdentityMatches(snapshot)
        && SnapshotEntry.RuntimeId(el) is int[] current && expectedRuntimeId.SequenceEqual(current);
    if (!SameIdentity()) return ("refused", "stale_target_revalidate_failed", "none");
    if (!work.TryBeginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
    try { vp.SetValue(value); }
    catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
    catch (InvalidOperationException) { return ("unknown", "element_not_available_after_dispatch", "readback_unavailable"); }
    catch (COMException) { return ("unknown", "set_value_failed_after_dispatch", "readback_unavailable"); }

    readback = ValueReadback.Run(() =>
    {
        try
        {
            if (!SameIdentity()) return (false, "readback_identity_changed");
            if (el.Current.IsPassword) return (false, "readback_password_field_refused");
            if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out var fresh)) return (false, "readback_unavailable");
            var actual = ((ValuePattern)fresh).Current.Value;
            if (actual.EnumerateRunes().Count() > MAX_COMPAT_TEXT) return (false, "readback_value_too_long");
            if (!SameIdentity()) return (false, "readback_identity_changed");
            if (el.Current.IsPassword) return (false, "readback_password_field_refused");
            return (actual == value, (string?)null);
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
        { return (false, "readback_unavailable"); }
    }, () => work.Cancelled);
    return (readback.status, readback.status == "verified" ? null : readback.verification, readback.verification);
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

static (string status, string? reason, string verification) SelectVerified(AutomationElement el, Func<bool> beginDispatch)
{
    if (!TryGetPattern(el, SelectionItemPattern.Pattern, out var p, out var cached))
        return ("refused", "selection_item_pattern_unavailable", "none");
    var selection = (SelectionItemPattern)p;
    if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
    try { selection.Select(); }
    catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
    catch (InvalidOperationException) { return ("unknown", "select_failed_after_dispatch", "readback_unavailable"); }
    try
    {
        var selected = Flavor(cached, () => selection.Cached.IsSelected, () => selection.Current.IsSelected);
        return selected
            ? ("verified", null, "selection_readback_selected")
            : ("unknown", "selection_not_selected_after_action", "readback_mismatch");
    }
    catch (Exception) { return ("unknown", "selection_readback_unavailable", "readback_unavailable"); }
}

static (string status, string? reason, string verification) ToggleVerified(AutomationElement el, Func<bool> beginDispatch)
{
    if (!TryGetPattern(el, TogglePattern.Pattern, out var p, out var cached))
        return ("refused", "toggle_pattern_unavailable", "none");
    var toggle = (TogglePattern)p;
    ToggleState before;
    try { before = Flavor(cached, () => toggle.Cached.ToggleState, () => toggle.Current.ToggleState); }
    catch (Exception) { return ("refused", "toggle_state_unavailable", "none"); }
    if (!beginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
    try { toggle.Toggle(); }
    catch (ElementNotAvailableException) { return ("unknown", "element_died_during_dispatch", "readback_unavailable"); }
    catch (InvalidOperationException) { return ("unknown", "toggle_failed_after_dispatch", "readback_unavailable"); }
    try
    {
        var after = Flavor(cached, () => toggle.Cached.ToggleState, () => toggle.Current.ToggleState);
        return after != before
            ? ("verified", null, "toggle_state_readback_changed")
            : ("unknown", "toggle_state_unchanged_after_action", "readback_mismatch");
    }
    catch (Exception) { return ("unknown", "toggle_readback_unavailable", "readback_unavailable"); }
}

static ScrollAmount ParseScrollAmount(string amount) => amount switch
{
    "small_increment" => ScrollAmount.SmallIncrement,
    "small_decrement" => ScrollAmount.SmallDecrement,
    "large_increment" => ScrollAmount.LargeIncrement,
    "large_decrement" => ScrollAmount.LargeDecrement,
    _ => ScrollAmount.NoAmount,
};

static (string status, string? reason, string verification) ScrollVerified(
    AutomationElement el, string direction, string amount, UiaWork work,
    SnapshotEntry snapshot, int[] expectedRuntimeId, out ScrollReadbackReport? readback)
{
    readback = null;
    bool SameIdentity() => expectedRuntimeId.Length > 0 && TargetIdentityMatches(snapshot)
        && SnapshotEntry.RuntimeId(el) is int[] current && expectedRuntimeId.SequenceEqual(current);
    double Percent(ScrollPattern p) => direction == "horizontal" ? p.Current.HorizontalScrollPercent : p.Current.VerticalScrollPercent;
    bool Scrollable(ScrollPattern p) => direction == "horizontal" ? p.Current.HorizontallyScrollable : p.Current.VerticallyScrollable;
    ScrollPattern scroll;
    double before;
    try
    {
        if (!el.TryGetCurrentPattern(ScrollPattern.Pattern, out var p))
            return ("refused", "scroll_pattern_unavailable", "scroll_pattern_unavailable");
        scroll = (ScrollPattern)p;
        before = Percent(scroll);
        var refusal = ScrollReadback.Preflight(before, Scrollable(scroll), amount);
        if (refusal is not null) return ("refused", refusal, refusal);
        if (!SameIdentity()) return ("refused", "stale_target_revalidate_failed", "none");
    }
    catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
    { return ("refused", "scroll_state_unavailable", "scroll_state_unavailable"); }
    if (!work.TryBeginDispatch()) return ("refused", "cancelled_before_dispatch", "no_mutation");
    try
    {
        var value = ParseScrollAmount(amount);
        scroll.Scroll(direction == "horizontal" ? value : ScrollAmount.NoAmount,
            direction == "vertical" ? value : ScrollAmount.NoAmount);
    }
    catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
    { return ("unknown", "scroll_failed_after_dispatch", "scroll_failed_after_dispatch"); }
    readback = ScrollReadback.Run(before, direction, amount, () =>
    {
        try
        {
            if (!SameIdentity()) return (0d, "readback_identity_changed");
            if (!el.TryGetCurrentPattern(ScrollPattern.Pattern, out var fresh)) return (0d, "scroll_readback_unavailable");
            var current = (ScrollPattern)fresh;
            if (!Scrollable(current)) return (0d, "scroll_readback_axis_not_scrollable");
            var percent = Percent(current);
            if (!SameIdentity()) return (0d, "readback_identity_changed");
            return (percent, (string?)null);
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException or COMException)
        { return (0d, "scroll_readback_unavailable"); }
    }, () => work.Cancelled);
    return (readback.status, readback.status == "verified" ? null : readback.verification, readback.verification);
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
    public ConcurrentDictionary<string, CompatAuthorization>? CompatAuthorizations { get; init; }
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

sealed record CompatAuthorization(string Token, string SnapshotId, string ElementToken,
    long Hwnd, uint Pid, long StartTimeUtc, string WindowGen, string HelperGeneration,
    int[] RuntimeId, string Op, string Payload, long ExpiresAtTicks);

readonly record struct TreeLimits(int MaxNodes, int MaxMillis, int MaxRenderDepth, int MaxActionableDepth);

/// Snapshot registry entry. Element tokens are opaque and resolve only here;
/// the AutomationElement COM proxies live on the UIA lane thread.
sealed class SnapshotEntry
{
    public int VisitedNodes { get; private set; } = 1;
    public int MaxRawDepthVisited { get; private set; }
    public void RecordVisit(int depth)
    {
        VisitedNodes++;
        MaxRawDepthVisited = Math.Max(MaxRawDepthVisited, depth);
    }
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

    public bool TryGetElementIdentity(string token, out AutomationElement el, out int[] runtimeId)
    {
        foreach (var (t, e, savedRuntimeId) in _elements)
        {
            if (t != token) continue;
            var currentRuntimeId = RuntimeId(e);
            if (savedRuntimeId is null || currentRuntimeId is null || !savedRuntimeId.SequenceEqual(currentRuntimeId))
            {
                el = null!; runtimeId = Array.Empty<int>(); return false;
            }
            el = e; runtimeId = savedRuntimeId.ToArray(); return true;
        }
        el = null!; runtimeId = Array.Empty<int>(); return false;
    }

    public static int[]? RuntimeId(AutomationElement el)
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

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint cInputs, [In] INPUT[] pInputs, int cbSize);

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
