@qiqll — independent verification of your fix, all green on today's `upstream/main`. This is a real data-loss shape (a spend-cap silently gone from providers.json is the worst of the three reproductions), and the `filelock.Strict` + field-level setters design answers the cross-process half that an in-process mutex can't. Your open question is well put for @yetone: "refused after the wait" vs. "proceed unlocked" is the one behavior call this patch makes, and either answer works with the rest of the design.

Rebased (zero conflicts) onto current `upstream/main` and re-verified, author unchanged (yjqi / qiqll) — branch: [`verify/5914-providers-json-lock`](https://github.com/ggbdpq/magpie/tree/verify/5914-providers-json-lock), head `bb07fe6bf`, patch sha256[:16] `7c73c7d127b19692`, `git am` applies clean on a tree at current main.

- Your two interleaving tests green: `TestProvidersTwoCapsBothKept`, `TestProvidersAddKeptWhileCapWritten`.
- Whole `internal/provider` (145s) and `internal/filelock` green; the three UI-facing tests green (`TestProviderCommandsKeepWhatWasSetMeanwhile` cli, `TestTUIProviderKeysKeepWhatWasSetMeanwhile` tui, `TestFailSaysFileBusy` gui).
- Ablation on the new base: `providersMu` swapped for a no-op lock (Take returns nil, Unlock does nothing) → both interleaving tests red with your exact readings ("50% cap read as 0%: written over" / "the provider added meanwhile is gone from providers.json: written over"); restored → green. The seam (`beforeProvidersWrite`) and the tests do pin the race, not just the code path.
- Sibling scan on `b27b66046..tip`: no upstream commits touch `store.go`/`provider.go`'s write path since your base — the 46-file patch carries over as is.
- Not verified here: two real magpie processes contending on one `providers.json` (the lock's cross-process half is covered by `internal/filelock`'s own tests); a real BusyError surfaced through the GUI dialog on Windows.

Generated-by: GLM-5.3-Flash (ZCode)
