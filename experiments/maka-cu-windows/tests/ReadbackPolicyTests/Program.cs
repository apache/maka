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
