Rebased onto current `upstream/main` (`0d99261dc`): zero conflicts, head `b6a92c9de`, branch [`fix/4893-sniffer-bench-clean`](https://github.com/ggbdpq/magpie/tree/fix/4893-sniffer-bench-clean). Benchmark-only — the measurement baseline the issue's profile work called for.

On the new base: `BenchmarkUsageSnifferChatChunk` runs clean (9317 ns/op, 19.11 MB/s on an M4 Pro at `-benchtime 10x`; the number any consolidation proposal has to beat). Ablation honestly noted: the benchmark is itself the deliverable — removing it leaves nothing red, as with any measurement addition. Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `9bd6a61c1b37de95`.

Generated-by: GLM-5.3-Flash (ZCode)
