Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `fc2b5ae8d`, branch [`fix/5638-mcp-hub-get-sse-tools-list`](https://github.com/ggbdpq/magpie/tree/fix/5638-mcp-hub-get-sse-tools-list). No upstream commits on `mcp_hub.go` in this range.

Verification on the new base:

- `TestHubListsToolsAfterASlowFirstStart`, `TestHubListsToolsNameAMissingServerFast`, `TestHubListsToolsStopTryingAtTheBudget` green.
- Ablation on the new base: the slow-start retry out (`b.slow` never set) → `TestHubListsToolsAfterASlowFirstStart` red (the standard SDK's list comes back empty again); restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `13fa1350f436943e`. Real npx-on-a-cold-machine MCP server stays NOT-RUNNABLE here, as posted (the fake slow-start server covers the shape).

Generated-by: GLM-5.3-Flash (ZCode)
