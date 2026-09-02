using System.Diagnostics;

// The probe is read-only. Never give this loop a mutation callback.
internal sealed record ValueReadbackReport(string status, string verification, int attempts, long elapsedMs)
{
    public int maxMillis => 1000;
    public int intervalMillis => 50;
    public string source => "ValuePattern.CurrentValue";
}

internal static class ValueReadback
{
    public static ValueReadbackReport Run(Func<(bool match, string? stopReason)> probe, Func<bool> cancelled,
        Func<long>? clock = null, Action<int>? sleep = null)
    {
        var watch = Stopwatch.StartNew();
        clock ??= () => watch.ElapsedMilliseconds;
        sleep ??= Thread.Sleep;
        long start = clock();
        int attempts = 0;
        ValueReadbackReport Done(string reason) => new(reason == "value_readback_match" ? "verified" : "unknown",
            reason, attempts, Math.Max(0, clock() - start));
        while (attempts < 21)
        {
            if (cancelled()) return Done("readback_cancelled_after_dispatch");
            if (clock() - start >= 1000) return Done("value_readback_timeout");
            attempts++;
            var sample = probe();
            // A COM call itself is not interruptible; reject a late match.
            if (cancelled()) return Done("readback_cancelled_after_dispatch");
            if (clock() - start >= 1000) return Done("value_readback_timeout");
            if (sample.stopReason is not null) return Done(sample.stopReason);
            if (sample.match) return Done("value_readback_match");
            sleep((int)Math.Min(50, Math.Max(0, 1000 - (clock() - start))));
        }
        return Done("value_readback_attempt_limit");
    }
}
