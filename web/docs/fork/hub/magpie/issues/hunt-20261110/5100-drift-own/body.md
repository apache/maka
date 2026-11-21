Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `c6eded857`, branch [`fix/5100-drift-own-claude`](https://github.com/ggbdpq/magpie/tree/fix/5100-drift-own-claude). No upstream commits on the own-session marking path in this range.

Two corroborating reports since the patch landed, both pointing at the same bridge path — @jerrychoi (11-05, macOS/arm64, 0.1.2965: Desktop-Code conversation in `~/.claude/history.jsonl`, "bypassed" banner with `ANTHROPIC_BASE_URL` pinned to the gateway) and @laweit-lxy (11-06, Windows 11 ARM64, 0.1.3131: same pairing with timestamps aligned against `applied.json`). Both are exactly the false positive this patch stops: the bridge's sessions get marked as magpie's own, so a Desktop-only conversation no longer reads as Claude Code sneaking past.

Verification on the new base:

- `TestClaudeDriftOwnSessions`, `TestClaudeBridgeSessionIsMagpiesOwn`, `TestWarmClaudeSaysItsOwnSession`, `TestClaudeHelperSessionIsMagpiesOwn` green.
- Ablation on the new base: `IsOwnSession` fixed false → the drift-own and bridge-session tests red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `6f3bbd6583420f82`. Real CLI/Desktop pairing stays NOT-RUNNABLE here — the two reports above are the live evidence.

Generated-by: GLM-5.3-Flash (ZCode)
