Refresh of my patch above, not a redesign: the same commit rebased onto current `upstream/main` (`4716a77ff9f8`) and the verification re-run.

**Status re-check (today):** upstream's `aUsage` still reads no `credit` — the struct carries `CacheUnknown`, `OutputTokensDetails` and now `Iterations` (the advisor face, #6977), no `Credit` field. The plugin half stands (`e0930b1de`: mover installs 0.1.29, whose note reads "…for magpie's Usage page to read once the gateway takes it on /v1/messages (#4328, plugins#823)"; the mover minimum has since moved to 0.1.41 through rate/trial-credit faces, none reaching the gateway decode). The host half below is still the missing receiving end.

**Rebase:** zero conflicts — upstream's touches to `internal/gateway/anthropic.go` since the branch's base are the adaptive-effort (`AsksAdaptively`), advisor-iterations (`aIteration`) and tool-block faces, none reaching the credit read; `git range-diff` of the move reports the one commit as fully equal (`=`), the hunk positions shifted with the file's growth, nothing else.

**Evidence** (darwin/arm64, upstream/main `4716a77ff9f8` + this commit):

| check | result |
| --- | --- |
| RED | on a clean `upstream/main` tree with only this commit's test file added: `TestKiroCreditsReachTheLedger` fails on all four credited shapes — `kiro_credits_test.go:61: credits <nil>, want 0.4 / 1.25 / 1.25 / 0` (whole / streamed / translated-for-a-Chat-client / free) |
| named tests | `TestKiroCreditsReachTheLedger` + the cache-unknown family (`TestCacheUnknown`, `TestChatCacheUnknown`, `TestPlanCredits`, `TestCacheCounted`, `TestCacheUnknownNotTold`) green; under `-race` green 2.645s |
| ablation | the `Credit` field and its `usage()` read taken out of `internal/gateway/anthropic.go` (`git diff --cached --stat`: 1 file, 9 deletions — the two logic hunks alone, no file revert) → the same four shapes go red with the same signature → restored → green |
| full package | `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/...` — the package carries 73 failures on this machine (932.4s), the identical set red on the same-recipe base run at `upstream/main` (975.8s, 76 there) — zero tip-only failures; the class is this machine's environment, not the commit: the real claude install on PATH pollutes the CLI-shim fixtures (68 `TestClaude*` bridge/TUI/session faces plus `TestAutoModeClassifierOnTheClaudeBridge` and `TestRefusalRetriesClaudeSubscription` — the shim sees the real tool's extra `--version` run, the `4 runs` signature), and a few reach real endpoints or the responses face (`TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` asks opencode.ai and is answered 429/401, `TestOpenAIProviderTurnsGoOverWebSocketByDefault`, `TestOpenAIProviderSocketOffNeverDials`); the base run carries the same set plus `TestKiroCreditsReachTheLedger` red by design (the RED check: this commit's test file on a tree without the fix) and two flaky members of the same claude-shim class that pass at the tip (`TestClaudeReplayFitsATallImage`, `TestClaudeTUIConversationKeepsItsFolderWhenTheCallerMoves`); the Kiro credits family green at the tip |
| am gate | `git format-patch -1 --zero-commit` of the branch head am'd as is onto a clean `upstream/main` (`4716a77ff9f8`) checkout: applies clean, the replayed tree is byte-identical to the branch tip's tree (`fe0d00b94cb51a3ed4dc1e1661eb156aecb7342c`), author preserved |
| gofmt / diff-check | `gofmt -l` clean on both touched files; `git diff --check` clean |
| vet ×3 | `go vet -tags nogui ./internal/gateway/` under GOOS=darwin, GOOS=linux, GOOS=windows — all three exit 0, no diagnostics |
| build ×3 | `go build -tags nogui ./...` under GOOS=darwin, GOOS=linux, GOOS=windows — all three exit 0, no output |

Sibling faces checked, nothing to change there:

- `rg` over the tree: the only readers of `metering` are this patch's struct comment and its test, plus the mover's history note in `internal/provider/migrate_kiro.go` — no other reader of `meteringEvent` exists in this repo (the plugin's event loop lives in the plugins repo).
- The carry chain is all present upstream and untouched: `Usage.Credits` and its copy in `Usage.add` (`internal/gateway/ir.go`), the ledger records carrying `call.Usage.Credits` (`internal/gateway/gateway.go`), the record/totals fields and `FormatCredits` (`internal/usage/usage.go`).
- The precedents keep their own faces: `cUsage` (`internal/gateway/chat.go`) reads WorkBuddy's `credit` with the same said-0/negative semantics this patch mirrors; `cliUsage` (Claude subscription) and `rUsage` (Responses) carry no per-request credit figure — their vendors say none, and the Codex "credits" faces (`codex_limits.go`, `search_quota.go`) are account-level windows for rotation, not the per-call ledger credit.

Not verified: no live Kiro account from here — the fixtures play the plugin's real reply shapes (0.1.29's `credit` beside `magpie_cache_unknown`) against the same ledger read; a live Kiro row gaining its `credits` stays the report's capture.

Patch: `43dbe5bcc19fa583` (sha256[:16]).

**Branch:** [`hunt-20261111-rf-4328`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4328) @ `dfdeca78c814d5ff371dce8d36ef669e922aaae2` — one commit on `upstream/main` (`4716a77ff9f8`).

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details>
<summary>patch (git am format, applies as is)</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 10:05:35 +0800
Subject: [PATCH] gateway: a reply's credits reach the ledger on the Messages
 path too (#4328)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

aUsage read no credit, so a plugin answering /v1/messages — Kiro's, whose
replies sum the meteringEvents Kiro costs a request with into the last
message_delta's usage — could not say what a request cost, and no Kiro
row on the Usage page had a credits. Read credit into Usage.Credits the
way the Chat path has read WorkBuddy's since #2512; the record and the
totals already carry call.Usage.Credits. A said 0 stays a said 0, and a
negative one is no cost.

Fixes #4328

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/anthropic.go         |  9 ++++
 internal/gateway/kiro_credits_test.go | 65 +++++++++++++++++++++++++++
 2 files changed, 74 insertions(+)
 create mode 100644 internal/gateway/kiro_credits_test.go

diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
index 432f10ce3..cbc9c1ec5 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -1564,6 +1564,12 @@ type aUsage struct {
 	// Kiro caches but tells only credits, never tokens (zeewell on X).
 	// It is read, never told: anthropic() leaves it false.
 	CacheUnknown bool `json:"magpie_cache_unknown,omitempty"`
+	// Credit is what the reply said the request cost in its plan's
+	// credits, as cUsage's: Kiro's plugin sums the meteringEvents Kiro
+	// costs a request with into its last message_delta's usage
+	// (yetone/magpie#4328). It is read, never told: anthropic() leaves it
+	// out.
+	Credit *float64 `json:"credit,omitempty"`
 	// OutputTokensDetails says how many of the output tokens were
 	// thinking, as Copilot counts them on a message_delta: the reasoning
 	// count the other protocols' usage carries (completion_tokens_details,
@@ -1603,6 +1609,9 @@ type aOutputDetails struct {
 
 func (u aUsage) usage() Usage {
 	out := Usage{Input: u.InputTokens, Output: u.OutputTokens, CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens, cacheUnknown: u.CacheUnknown}
+	if c := u.Credit; c != nil && *c >= 0 {
+		out.Credits = c
+	}
 	if c := u.CacheCreation; c != nil {
 		out.cacheCreationReported = true
 		out.cacheCreationHasCounts = c.Ephemeral5m+c.Ephemeral1h > 0
diff --git a/internal/gateway/kiro_credits_test.go b/internal/gateway/kiro_credits_test.go
new file mode 100644
index 000000000..bacb048c4
--- /dev/null
+++ b/internal/gateway/kiro_credits_test.go
@@ -0,0 +1,65 @@
+package gateway
+
+import (
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// The Kiro plugin's replies, once it sums the meteringEvents Kiro costs
+// its requests with ({"unit":"credit","usage":<n>}): the last
+// message_delta's usage names the request's credits beside
+// magpie_cache_unknown, as the issue asks it to (yetone/magpie#4328).
+// The Usage page showed no credits on a Kiro row: aUsage read no credit,
+// though the Chat path has read WorkBuddy's since #2512.
+const (
+	kiroCreditsStream = "event: message_start\n" +
+		`data: {"type":"message_start","message":{"id":"msg_k1","type":"message","role":"assistant","model":"claude-sonnet-4.5","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}` + "\n\n" +
+		"event: content_block_delta\n" +
+		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}` + "\n\n" +
+		"event: message_delta\n" +
+		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":19,"magpie_cache_unknown":true,"credit":1.25}}` + "\n\n" +
+		"event: message_stop\n" +
+		`data: {"type":"message_stop"}` + "\n\n"
+	kiroCreditsJSON = `{"id":"msg_k2","type":"message","role":"assistant","model":"claude-sonnet-4.5","content":[{"type":"text","text":"OK."}],"stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":1,"magpie_cache_unknown":true,"credit":0.4}}`
+	kiroFreeCredits = `{"id":"msg_k3","type":"message","role":"assistant","model":"claude-sonnet-4.5","content":[{"type":"text","text":"OK."}],"stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":1,"magpie_cache_unknown":true,"credit":0}}`
+	kiroNoCredits   = `{"id":"msg_k4","type":"message","role":"assistant","model":"claude-sonnet-4.5","content":[{"type":"text","text":"OK."}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`
+	kiroBadCredits  = `{"id":"msg_k5","type":"message","role":"assistant","model":"claude-sonnet-4.5","content":[{"type":"text","text":"OK."}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"credit":-3}}`
+)
+
+// TestKiroCreditsReachTheLedger: the credits a reply on the Messages path
+// names reach the ledger's record, as WorkBuddy's do on the Chat path
+// (#2512). A free request's credit 0 is a said 0, not an unknown one, and
+// a credit no reply said — or a negative one, which is no cost — leaves
+// the row uncredited.
+func TestKiroCreditsReachTheLedger(t *testing.T) {
+	const messages = `{"model":"fake/m1","max_tokens":20,"messages":[{"role":"user","content":"Say just OK."}]}`
+	const streamed = `{"model":"fake/m1","max_tokens":20,"stream":true,"messages":[{"role":"user","content":"Say just OK."}]}`
+	const chat = `{"model":"fake/m1","messages":[{"role":"user","content":"Say just OK."}]}`
+	for _, c := range []struct {
+		name, ctype, reply, path, request string
+		want                              *float64
+	}{
+		{"whole reply", "application/json", kiroCreditsJSON, "/v1/messages", messages, ptr(0.4)},
+		{"streamed", "", kiroCreditsStream, "/v1/messages", streamed, ptr(1.25)},
+		// a translated request is always streamed from the vendor
+		{"translated for a Chat client", "", kiroCreditsStream, "/v1/chat/completions", chat, ptr(1.25)},
+		{"a free request", "application/json", kiroFreeCredits, "/v1/messages", messages, ptr(0.0)},
+		{"no credit said", "application/json", kiroNoCredits, "/v1/messages", messages, nil},
+		{"a negative credit", "application/json", kiroBadCredits, "/v1/messages", messages, nil},
+	} {
+		t.Run(c.name, func(t *testing.T) {
+			setup(t, provider.Anthropic, &fake{ctype: c.ctype, reply: c.reply})
+			if code, body := post(t, c.path, c.request); code != 200 {
+				t.Fatalf("gateway: %d %s", code, body)
+			}
+			r := lastUsage(t)
+			switch {
+			case c.want == nil && r.Credits != nil:
+				t.Fatalf("credits %v from a reply that said none", *r.Credits)
+			case c.want != nil && (r.Credits == nil || *r.Credits != *c.want):
+				t.Fatalf("credits %v, want %v", r.Credits, *c.want)
+			}
+		})
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
