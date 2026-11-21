REFRESHED #3967 (W2-A)
new head: 739627293022a54916b8501bf4e8dac765c24a84
old head: 1573329cb6f1ef7f1ac34553217dbb9613d34382
base: 6f5d48ea0 -> rebase-time tip (zero conflicts; detached worktree, branch locked by legacy /tmp/mg3967)
sha256[:16]: 8d1e07a5e0e392b6
Tests green: TestCountedNothing x4 + TestUsageNeverReportedStaysAnAnswer + TestZenFree x2 + TestSniffChat, -race targeted green
Ablation A red: uncountedReply block out of settle (-6) -> TestCountedNothingFailsOver
Ablation B red: saidUsage gate out -> TestZenFreeAsOpenCode225 + TestZenFreeZeroCostModels
Sibling: upstream fallback.go rework no settle intersection; sniff/ir zero usageReported drift
aron-intframe repro thread credited
