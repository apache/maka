Refresh of my patch above, not a redesign: the same commit rebased onto `upstream/main` and the verification re-run. `aUsage` is still the one place the Anthropic usage is written, main still carries no `server_tool_use` echo of its own (the nearest upstream commit, `5787d758a`, is the usage page's Web-search row — a different face), so a gateway in front of magpie that bills `usage.server_tool_use.web_search_requests` still sees nothing on this route.

Unchanged, as delivered: the count rides the usage as `server_tool_use.web_search_requests` when searches were run, and the field stays out when none were, as Anthropic sends no such field then.

<details><summary>patch: gateway: the Anthropic usage says how many searches the model ran (#5448) — git am applies it as is; SHA-256 first 16: f781c0ae843a906e</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 00:38:39 +0800
Subject: [PATCH] gateway: the Anthropic usage says how many searches the model
 ran (#5448)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Claude subscription reply's content can carry server_tool_use blocks
(a web search the model ran with the provider's own tool), and magpie
already counts them — but only for its own request log: the Anthropic
usage it writes back carried no server_tool_use at all, so a gateway in
front of magpie that bills web search from usage.server_tool_use.
web_search_requests (new-api) billed nothing on this route (#5448,
aabbccgg; Anthropic's own API tells the count there).

The count rides the usage as server_tool_use.web_search_requests when
searches were run, and stays out when none were, as Anthropic sends no
such field then.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/anthropic.go                 | 12 ++++++++
 .../gateway/anthropic_usage_search_test.go    | 30 +++++++++++++++++++
 2 files changed, 42 insertions(+)
 create mode 100644 internal/gateway/anthropic_usage_search_test.go

diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
index e90ad3ce9..0bf2afa5a 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -1435,6 +1435,15 @@ type aUsage struct {
 	// reads from Claude Code. A vendor that leaves it out is told by its
 	// stream (hidesReasoning, #4545)
 	OutputTokensDetails *aOutputDetails `json:"output_tokens_details,omitempty"`
+	// ServerToolUse says how many searches the model ran with the
+	// provider's own web-search tool, as Anthropic tells them, so a
+	// gateway in front of magpie can bill them (#5448, aabbccgg); none
+	// run, no field
+	ServerToolUse *aServerToolUse `json:"server_tool_use,omitempty"`
+}
+
+type aServerToolUse struct {
+	WebSearchRequests int `json:"web_search_requests"`
 }
 
 type aCacheCreation struct {
@@ -1472,6 +1481,9 @@ func (u Usage) anthropic() aUsage {
 	if u.Reasoning > 0 {
 		out.OutputTokensDetails = &aOutputDetails{ThinkingTokens: u.Reasoning}
 	}
+	if u.searches > 0 {
+		out.ServerToolUse = &aServerToolUse{WebSearchRequests: u.searches}
+	}
 	return out
 }
 
diff --git a/internal/gateway/anthropic_usage_search_test.go b/internal/gateway/anthropic_usage_search_test.go
new file mode 100644
index 000000000..f80d0500c
--- /dev/null
+++ b/internal/gateway/anthropic_usage_search_test.go
@@ -0,0 +1,30 @@
+package gateway
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+// TestAnthropicUsageTellsSearches: the searches a reply says its model ran
+// with the provider's own web-search tool ride the Anthropic usage as
+// server_tool_use.web_search_requests, as Anthropic says them — a gateway
+// in front of magpie bills web search from that field, and every search on
+// the route went unbilled while it was missing (#5448, aabbccgg: two
+// server_tool_use blocks in the content, no server_tool_use in the usage).
+func TestAnthropicUsageTellsSearches(t *testing.T) {
+	b, _ := json.Marshal(Usage{searches: 2}.anthropic())
+	var u struct {
+		ServerToolUse *struct {
+			WebSearchRequests int `json:"web_search_requests"`
+		} `json:"server_tool_use"`
+	}
+	if json.Unmarshal(b, &u) != nil || u.ServerToolUse == nil || u.ServerToolUse.WebSearchRequests != 2 {
+		t.Fatalf("usage %s, want server_tool_use.web_search_requests 2", b)
+	}
+	// none run: the field stays out, as Anthropic sends none
+	b, _ = json.Marshal(Usage{}.anthropic())
+	if strings.Contains(string(b), "server_tool_use") {
+		t.Fatalf("usage %s, no server_tool_use when none ran", b)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-5448`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5448) (head `31c43e1ea9be5cb86f109f8f4c55dd2e6ab40649`), rebased onto `upstream/main` (`4b29709ec`, zero commits touching `internal/gateway/anthropic.go` since — re-checked before posting); on a fresh checkout `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (`GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestAnthropicUsageTellsSearches` | green with the patch |
| Ablation: the `u.searches > 0` write made unreachable (build intact) | red: the usage answers `{"input_tokens":0,...,"cache_creation_input_tokens":0}` with no `server_tool_use`, `want server_tool_use.web_search_requests 2`; restored: green |
| `go test -tags nogui -timeout 40m -count=1 ./internal/gateway/` (whole package) | ok (939.2s), zero failures |
| `gofmt -l` on the two touched files | prints nothing |
| `go vet -tags nogui ./internal/gateway/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` | clean |

**Siblings**: `rg "server_tool_use"` in `internal/gateway` — the block-type flag on stream events (`anthropic.go` `server[ev.Index]`), the streamed block shapes, and the magpie-side search (`Usage.searches`, `ir.go`) are read paths; `aUsage.anthropic()` is the only writer of the reply's usage, which is what new-api bills from. No other protocol's usage carries a server-tool echo to fix (Chat's `prompt_tokens_details` has no such field; Responses' `usage` has no searches face on the relayed route).

**Not verified**: a real new-api deployment billing from the echoed field (the report's environment); a real Claude subscription search turn end to end (the test uses the counted shape from the report).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
