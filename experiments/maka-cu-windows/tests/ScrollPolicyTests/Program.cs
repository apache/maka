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
