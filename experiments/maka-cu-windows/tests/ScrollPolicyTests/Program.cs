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

using System.Text.Json.Nodes;

var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "cases.json")))!;
static double Percent(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s)
    ? s == "NaN" ? double.NaN : double.PositiveInfinity : n?.GetValue<double>() ?? 0;
int count = 0;
foreach (var t in cases["preflight"]!.AsArray())
{
    var actual = ScrollReadback.Preflight(Percent(t!["percent"]), t["scrollable"]!.GetValue<bool>(), t["amount"]!.GetValue<string>());
    if (actual != t["expected"]?.GetValue<string>()) throw new Exception($"preflight mismatch {t}");
    count++;
}
foreach (var item in cases["readback"]!.AsArray())
{
    var test = item!;
    long now = 0;
    int index = 0;
    bool cancelled = test["cancelInitially"]?.GetValue<bool>() ?? false;
    var samples = test["samples"]!.AsArray();
    var amount = test["amount"]?.GetValue<string>() ?? "large_increment";
    var result = ScrollReadback.Run(40, "vertical", amount, () =>
    {
        var sample = samples[Math.Min(index++, samples.Count - 1)]!;
        now += sample["advanceMs"]?.GetValue<long>() ?? 0;
        cancelled |= sample["cancel"]?.GetValue<bool>() ?? false;
        return (Percent(sample["percent"]), sample["error"]?.GetValue<string>());
    }, () => cancelled, () => now, ms => { if (test["frozenClock"]?.GetValue<bool>() != true) now += ms; });
    var reason = test["reason"]!.GetValue<string>();
    if (result.status != (reason == "scroll_position_readback_changed" ? "verified" : "unknown")
        || result.verification != reason || result.attempts != test["attempts"]!.GetValue<int>()
        || result.elapsedMs != test["elapsedMs"]!.GetValue<long>() || result.samples.Count != result.attempts
        || result.samples.Any(s => s.percent is double p && !double.IsFinite(p))
        || result.maxMillis != 1000 || result.intervalMillis != 50)
        throw new Exception($"FAIL {test["name"]}: {result}");
    count++;
    Console.WriteLine($"PASS {test["name"]}");
}
Console.WriteLine($"PASS {count} shared scroll policy cases");
