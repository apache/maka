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

using System.Diagnostics;

internal sealed record ScrollSample(long elapsedMs, double? percent);
internal sealed record ScrollReadbackReport(string status, string verification, int attempts, long elapsedMs,
    string direction, string amount, double beforePercent, IReadOnlyList<ScrollSample> samples)
{
    public int maxMillis => 1000;
    public int intervalMillis => 50;
    public string source => direction == "horizontal" ? "ScrollPattern.CurrentHorizontalScrollPercent" : "ScrollPattern.CurrentVerticalScrollPercent";
}

internal static class ScrollReadback
{
    public static bool Valid(double percent) => double.IsFinite(percent) && percent >= 0 && percent <= 100;
    public static bool Increment(string amount) => amount is "small_increment" or "large_increment";
    public static string? Preflight(double percent, bool scrollable, string amount)
    {
        if (amount == "no_amount") return "scroll_no_amount";
        if (!scrollable || percent == -1) return "scroll_axis_not_scrollable";
        if (!Valid(percent)) return "scroll_invalid_percent";
        if (Increment(amount) ? percent == 100 : percent == 0) return "scroll_at_boundary";
        return null;
    }

    // Probe is read-only, same element and fresh Current pattern. Never replay a mutation.
    public static ScrollReadbackReport Run(double before, string direction, string amount,
        Func<(double percent, string? stopReason)> probe, Func<bool> cancelled,
        Func<long>? clock = null, Action<int>? sleep = null)
    {
        var watch = Stopwatch.StartNew();
        clock ??= () => watch.ElapsedMilliseconds;
        sleep ??= Thread.Sleep;
        long start = clock();
        int attempts = 0;
        var samples = new List<ScrollSample>();
        ScrollReadbackReport Done(string reason) => new(reason == "scroll_position_readback_changed" ? "verified" : "unknown",
            reason, attempts, Math.Max(0, clock() - start), direction, amount, before, samples);
        while (attempts < 21)
        {
            if (cancelled()) return Done("readback_cancelled_after_dispatch");
            if (clock() - start >= 1000) return Done("scroll_readback_timeout");
            attempts++;
            var sample = probe();
            samples.Add(new(Math.Max(0, clock() - start), sample.stopReason is null && double.IsFinite(sample.percent) ? sample.percent : null));
            // A COM call is not preemptible. A late value cannot verify success.
            if (cancelled()) return Done("readback_cancelled_after_dispatch");
            if (clock() - start >= 1000) return Done("scroll_readback_timeout");
            if (sample.stopReason is not null) return Done(sample.stopReason);
            if (!Valid(sample.percent)) return Done("scroll_readback_invalid_percent");
            if (sample.percent != before)
                return Done((Increment(amount) ? sample.percent > before : sample.percent < before)
                    ? "scroll_position_readback_changed" : "scroll_readback_wrong_direction");
            sleep((int)Math.Min(50, Math.Max(0, 1000 - (clock() - start))));
        }
        return Done("scroll_readback_attempt_limit");
    }
}
