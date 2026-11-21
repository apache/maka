Rebased onto current `upstream/main` (`7e5cebb86`, v0.1.3435): zero conflicts, and `aa3d11d5b..7e5cebb86` touches `internal/gateway/responses.go` not at all, so the patch is byte-for-byte the same fix on the new base. Branch: [`fix/5713-web-search-call-history`](https://github.com/ggbdpq/magpie/tree/fix/5713-web-search-call-history), head `4f60ecbf9`.

Verification on the new base:

- Tests re-run green: `TestResponsesSearchItemReplayed`, `TestSearchHistoryReachesAChatUpstream`, `TestSearchWithoutClaudeThinkingGoesBackAsText`, `TestSearchWithoutClaudeThinkingStaysOut`, `TestUnsearchedConversationUnchanged`, `TestWithoutSearchCalls`, `TestClaudeThinkingAroundMagpieSearchGoesBackAsWritten`.
- Ablation on the new base: the convert-to-text branch back to the silent delete → `TestSearchWithoutClaudeThinkingGoesBackAsText` and `TestSearchHistoryReachesAChatUpstream` red; restored → green.
- Sibling scan: `searchRoundsBack`'s callers and the `isSearch` family unchanged on the new base (no upstream commits in the file since the old base).
- Fresh patch `git am`s clean onto a tree at `7e5cebb86`; sha256[:16] `6d038bd4095df5d1`. Real-client replay stays NOT-RUNNABLE here, as posted (fixture replay covers the wire shape).

Generated-by: GLM-5.3-Flash (ZCode)
