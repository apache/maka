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

var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "cases.json")))!.AsArray();
foreach (var item in cases)
{
    var test = item!;
    long now = 0;
    int index = 0;
    bool cancelled = test["cancelInitially"]?.GetValue<bool>() ?? false;
    var samples = test["samples"]!.AsArray();
    var result = ValueReadback.Run(() =>
    {
        var sample = samples[Math.Min(index++, samples.Count - 1)]!;
        now += sample["advanceMs"]?.GetValue<long>() ?? 0;
        cancelled |= sample["cancel"]?.GetValue<bool>() ?? false;
        return (sample["match"]?.GetValue<bool>() ?? false, sample["stopReason"]?.GetValue<string>());
    }, () => cancelled, () => now, ms => { if (test["frozenClock"]?.GetValue<bool>() != true) now += ms; });
    var expected = test["expected"]!;
    if (result.status != expected["status"]!.GetValue<string>()
        || result.verification != expected["verification"]!.GetValue<string>()
        || result.attempts != expected["attempts"]!.GetValue<int>()
        || result.elapsedMs != expected["elapsedMs"]!.GetValue<long>()
        || result.maxMillis != 1000 || result.intervalMillis != 50)
        throw new Exception($"FAIL {test["name"]}: {result}");
    Console.WriteLine($"PASS {test["name"]}");
}
Console.WriteLine($"PASS {cases.Count}/{cases.Count} shared readback cases");
