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

// Bounded UIA event subscription probe. Registers, waits, unregisters.
// Success here only means handlers were installed; it does not mean Chrome
// exposed a complete web tree.
using System.Text.Json.Nodes;
using System.Windows.Automation;

if (args.Length < 2
    || !long.TryParse(args[0], out var hwnd)
    || hwnd <= 0
    || !int.TryParse(args[1], out var waitMs)
    || waitMs <= 0)
{
    Console.Error.WriteLine("usage: UiaWakeProbe <hwnd> <waitMs>");
    return 2;
}

waitMs = Math.Clamp(waitMs, 1, 5000);
var events = 0;
var structure = 0;
var focus = 0;
string? error = null;
var subscribed = false;
AutomationElement? target = null;
StructureChangedEventHandler? structureHandler = null;
AutomationFocusChangedEventHandler? focusHandler = null;

try
{
    target = AutomationElement.FromHandle(new IntPtr(hwnd));
    if (target is null)
    {
        error = "target_window_not_found";
    }
    else
    {
        structureHandler = (_, _) => { Interlocked.Increment(ref events); Interlocked.Increment(ref structure); };
        focusHandler = (_, _) => { Interlocked.Increment(ref events); Interlocked.Increment(ref focus); };
        Automation.AddStructureChangedEventHandler(target, TreeScope.Subtree, structureHandler);
        Automation.AddAutomationFocusChangedEventHandler(focusHandler);
        subscribed = true;
        Thread.Sleep(waitMs);
    }
}
catch (Exception ex)
{
    error = ex.GetType().Name + ": " + ex.Message;
}
finally
{
    if (subscribed)
    {
        try { if (target is not null && structureHandler is not null) Automation.RemoveStructureChangedEventHandler(target, structureHandler); } catch { }
        try { if (focusHandler is not null) Automation.RemoveAutomationFocusChangedEventHandler(focusHandler); } catch { }
    }
}

var result = new JsonObject
{
    ["subscribed"] = subscribed,
    ["waitMs"] = waitMs,
    ["hwnd"] = hwnd,
    ["events"] = events,
    ["structureChanged"] = structure,
    ["focusChanged"] = focus,
    ["error"] = error,
    ["note"] = "subscription_success_does_not_mean_web_tree_ready",
};
Console.WriteLine(result.ToJsonString());
return error is null && subscribed ? 0 : 1;
