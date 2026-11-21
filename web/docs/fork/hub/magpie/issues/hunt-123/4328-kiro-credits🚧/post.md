Host-side half of #4328 — the ledger is ready to record Kiro's per-request credits the moment the plugin names them. Thank you @jailbreak07 for the precise map of both gaps.

**What's wrong**

Kiro replies carry a `meteringEvent` with what each request cost (`{"unit":"credit","usage":<n>}`), but no Kiro row on the Usage page has a `credits`. The Chat path has carried WorkBuddy's `usage.credit` into the ledger since #2512; the Messages path silently drops the same figure.

**Root cause**

`aUsage` — the usage struct `decodeAnthropic` reads `message_start` and `message_delta` events with — has no credit field, so `aUsage.usage()` (`internal/gateway/anthropic.go:1381`, `:1408`) never set `Usage.Credits`, and a plugin answering `/v1/messages` had no way to say what a request cost. Nothing else was missing: `Usage.add` copies credits (`internal/gateway/ir.go:574`), the ledger record carries `call.Usage.Credits` (`internal/gateway/gateway.go:4817`), and `Totals.count` sums them (`internal/usage/usage.go:845`).

**The fix**

Read `credit` into `Usage.Credits` in `aUsage.usage()`, the way `cUsage.usage()` reads WorkBuddy's: a said `0` stays a said `0` (a free request is known to cost none), a negative is no cost. Read, never told — `anthropic()` leaves it out, as it already leaves out `magpie_cache_unknown`.

<details>
<summary>diff (product file; the full patch is at the bottom)</summary>

```diff
diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
index 4b9ddbbf0..545c133e7 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -1392,6 +1392,12 @@ type aUsage struct {
 	// Kiro caches but tells only credits, never tokens (zeewell on X).
 	// It is read, never told: anthropic() leaves it false.
 	CacheUnknown bool `json:"magpie_cache_unknown,omitempty"`
+	// Credit is what the reply said the request cost in its plan's
+	// credits, as cUsage's: Kiro's plugin sums the meteringEvents Kiro
+	// costs a request with into its last message_delta's usage
+	// (yetone/magpie#4328). It is read, never told: anthropic() leaves it
+	// out.
+	Credit *float64 `json:"credit,omitempty"`
 }
 
 type aCacheCreation struct {
@@ -1401,6 +1407,9 @@ type aCacheCreation struct {
 
 func (u aUsage) usage() Usage {
 	out := Usage{Input: u.InputTokens, Output: u.OutputTokens, CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens, cacheUnknown: u.CacheUnknown}
+	if c := u.Credit; c != nil && *c >= 0 {
+		out.Credits = c
+	}
 	if c := u.CacheCreation; c != nil {
 		out.cacheCreationReported = true
 		out.cacheCreationHasCounts = c.Ephemeral5m+c.Ephemeral1h > 0
```

</details>

`git am applies it as is; SHA-256 first 16: a8454f7000cc4919`

**Verification**

| Check | Result |
|---|---|
| RED | `TestKiroCreditsReachTheLedger` before the fix: whole / streamed / translated-for-a-Chat-client / free all fail `credits <nil>, want 0.4 / 1.25 / 1.25 / 0` |
| Targeted | `go test -tags nogui -run 'TestKiroCreditsReachTheLedger\|TestCacheUnknown\|TestChatCacheUnknown\|TestPlanCredits\|TestCacheCounted\|TestCacheUnknownNotTold' ./internal/gateway/` — ok |
| Full package | `go test -tags nogui -timeout 25m ./internal/gateway/...` — ok 637.1s, no failures |
| Race | `go test -race -tags nogui -run 'TestKiroCreditsReachTheLedger' ./internal/gateway/` — ok 2.4s |
| gofmt / vet / build | `tr -d '\r'` gofmt clean on both files; `go vet -tags nogui ./internal/gateway/` exit 0; `go build -tags nogui ./...` exit 0 |
| Ablation | `internal/gateway/anthropic.go` reverted to 2741b749f, test kept: the same 4 cases go red |
| After rebase | rebased onto 247794c61 (tip), targeted rerun ok |

Sibling faces checked, nothing changed there on purpose:

- rg over the whole tree for `kiro\|credit\|metering`: the ledger side is this one struct; no other reader of `meteringEvent` exists in this repo (the plugin's event loop lives in the plugins repo, `@magpie-community/opencode-kiro-auth`).
- The same reporter's `kiro-rotation` branch (`jailbreak07/magpie`, commits 3353bda6 and b2e5f2b3 — the #4031 rotation-refusal face, #4386's used-up accounts still asked) touches `internal/gateway/fallback.go`, `internal/gateway/gateway.go` and its refusal/resting tests; `rg -i 'credit\|metering\|aUsage'` over its diff hits only pre-existing docs prose about Codex credit caps. Different face from this ledger one, no overlap — shipping independently.
- Not addressed here, still open: #3430 (the same `aUsage` gap for reasoning tokens, a different field) and #3321 (daily totals attributing credits to a day, not a request).

Not verified: no live Kiro account from here — the streams in the test are the plugin's real shapes (opencode-kiro-auth 0.1.16, as captured in `cache_unknown_test.go`) extended with the `credit` field the issue asks the plugin to emit, so a row gains its `credits` only once the plugin half (summing `meteringEvent.usage` into the last `message_delta.usage` as `credit`, beside `magpie_cache_unknown`) lands in the plugins repo. AI use: the patch and tests were written by GLM-5.3-Flash (ZCode) under my direction; I've read the whole diff and ran every check above myself.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

<details>
<summary>patch (git am format, applies as is)</summary>

```patch
From 0d25886acb9ce2399ac234ac12444dabd3e06458 Mon Sep 17 00:00:00 2001
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
index 4b9ddbbf0..545c133e7 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -1392,6 +1392,12 @@ type aUsage struct {
 	// Kiro caches but tells only credits, never tokens (zeewell on X).
 	// It is read, never told: anthropic() leaves it false.
 	CacheUnknown bool `json:"magpie_cache_unknown,omitempty"`
+	// Credit is what the reply said the request cost in its plan's
+	// credits, as cUsage's: Kiro's plugin sums the meteringEvents Kiro
+	// costs a request with into its last message_delta's usage
+	// (yetone/magpie#4328). It is read, never told: anthropic() leaves it
+	// out.
+	Credit *float64 `json:"credit,omitempty"`
 }
 
 type aCacheCreation struct {
@@ -1401,6 +1407,9 @@ type aCacheCreation struct {
 
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

Branch with the commit: fix/4328-kiro-credits (head 0d25886acb9ce2399ac234ac12444dabd3e06458)
