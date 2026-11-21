**The cut short's failure told the client nothing it knows to retry on (#5535).** When Anthropic's stream drops while Claude Code is writing a tool call, magpie fails the reply with "Claude Code's stream from Anthropic was cut short after the reply had begun" — and nothing more. The reply had begun (the call's name and half its arguments were already streamed), so the event's 502 was spent and the words are all the client gets: the stream's `error` event as prose, `type: "api_error"`, the same text through every client shape (internal/gateway/anthropic.go, internal/gateway/chat.go).

**The turn then died untried, and the cache paid.** darwesss-star's client (pi 1.5.0, in OpenBot) retries a failed turn when the error text matches a phrase it knows is transient — "stream was interrupted", "ended without", "terminated", "timeout" (`isRetryableAssistantError` in pi-ai). None matched, so the turn failed for good and the next one rewrote the whole conversation to the subscription's cache: ~187k tokens of an hour's cache, where a same-context retry would have read it whole.

**Root cause.** All three endings of `failed` in the subscription bridge's read loop (internal/gateway/claude_subscription.go — a stream that stops with something shown, one Claude Code never asks again on, one that stops before anything was sent) say "cut short …" with no phrase a retry matcher knows. magpie already words streamed errors for its client's matchers where it must: a streamed 413 carries "(request_too_large)", appended for exactly this reason (#2372 — once the headers have gone, Pi reads only the event's text).

**The fix.** Every ending of `failed` now names the phrase to retry on, the reporter's own wording: "… (stream was interrupted; retry the request)". One emit line covers all three endings; statuses are untouched, and where the status still reaches the client nothing changes but the text.

**Verification.** New `TestClaudeCutStreamMidToolCallWordedToRetry` streams a client tool call half written (its name, then partial arguments) into `message_stop` with no `message_delta` — the reporter's case — and requires the retry phrase in what the client hears: red on upstream/main `416305451` (the event reads `"message":"Claude Code's stream from Anthropic was cut short after the reply had begun"`), green with the fix; the fix alone reverted, red again, restored green. The `TestClaudeCutStream*` family around it — goes on in retry, answered unstreamed, unstreamed tool calls, no answer, after words, output counted — is green unchanged.

| What | Result |
| --- | --- |
| `TestClaudeCutStreamMidToolCallWordedToRetry`, upstream/main `416305451`, without the fix | red: "the failure says nothing a client's own retry reads as transient", the event `"message":"Claude Code's stream from Anthropic was cut short after the reply had begun","type":"api_error"` |
| Same with the fix | green: the message ends "… (stream was interrupted; retry the request)" |
| Ablation (the fix reverted, tests kept) | red again; green once restored |
| `TestClaudeCutStreamGoesOnInRetry`, `TestClaudeCutStreamAnsweredUnstreamed`, `TestClaudeCutStreamUnstreamedToolCalls`, `TestClaudeCutStreamWithNoAnswer`, `TestClaudeCutStreamAfterWords`, `TestClaudeStreamOutputCounted` | green, unchanged |
| gateway whole, `-tags nogui -count=1 -race -timeout 60m` | ran whole in 1520.2s, one failure — the machine's known `TestBrowserKeyOffClosesItsBrowser` (data race, its test vs `browser.go` `watchKey`, both byte-identical to the parent; green directed); everything else passed, `TestClaude*` included |
| Known reds | `TestBrowserKeyOffClosesItsBrowser` fired a data race in the 25m full run — `browser.go` `watchKey` vs `browser_key_test.go`, both byte-identical to the parent commit; it passes directed. The other named reds (`TestMothX`, `TestLaneLimitRoutes`, `TestProxyCheckSaysAProxyPassedBy`) did not fire |
| `gofmt -l internal/gateway`; `go vet -tags nogui ./internal/gateway` (darwin, `GOOS=windows`); `go build -tags nogui ./...` (darwin, `GOOS=windows`) | clean; clean; ok |

**Not verified**: nothing against the reporter's account or pi itself — pi's matcher is the reporter's citation, and earendil-works/pi#11879 stands beside this to read the old wording there too. With this wording, a cut short reads as transient to pi as it stands. The gateway suite under `-race` needs over 25m on this machine (the first full run died at that timeout with its last test 4s in; this one had 60m).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: claude: a cut short's failure words a client's own retry reads as transient (#5535) — git am applies it as is; SHA-256 first 16: ee10a9f123d9d10d</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 03:34:12 +0800
Subject: [PATCH] claude: a cut short's failure words a client's own retry
 reads as transient (#5535)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A stream Anthropic cut short mid tool call failed the reply with
"Claude Code's stream from Anthropic was cut short after the reply had
begun". The reply had begun — the call's name and half its arguments
were already with the client — so the event's 502 was spent and the
words are all the client gets, the stream's error event as prose. A
client that retries on its own wording (pi's isRetryableAssistantError
matches "stream was interrupted", "ended without", "terminated",
"timeout") matched none, gave the turn up untried, and its next turn
wrote the whole conversation to the subscription's cache again —
~187k tokens of an hour's cache on darwesss-star's account, where a
same-context retry would have read it from the cache. Every ending of
failed now carries the phrase to retry on: "… (stream was interrupted;
retry the request)", as the streamed 413 already says
"(request_too_large)" for the same reason (#2372).

Run at 416305451 + this change: TestClaudeCutStreamMidToolCallWordedToRetry
red on the parent (the error event's message carries no phrase a retry
matcher knows), green with the fix; the fix alone reverted, red again,
restored green; the TestClaudeCutStream* family green; gateway whole,
-tags nogui -count=1 -race -timeout 60m ok but for this machine's known
TestBrowserKeyOffClosesItsBrowser, a data race between that test and
browser.go's watchKey, both files byte-identical to the parent, the
test green directed; gofmt -l internal/gateway empty; go vet -tags
nogui ./internal/gateway ok on darwin and GOOS=windows; go build -tags
nogui ./... ok on both.

Fixes #5535

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_cut_stream_test.go | 22 ++++++++++++++++++++++
 internal/gateway/claude_subscription.go    |  9 +++++++--
 2 files changed, 29 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/claude_cut_stream_test.go b/internal/gateway/claude_cut_stream_test.go
index 33bb66f8c..49cbbbf0d 100644
--- a/internal/gateway/claude_cut_stream_test.go
+++ b/internal/gateway/claude_cut_stream_test.go
@@ -196,6 +196,28 @@ func TestClaudeCutStreamAfterWords(t *testing.T) {
 	}
 }
 
+// A stream cut short mid tool call fails the reply with words the client
+// reads as prose, its status already spent on the reply that began: a
+// client that retries on its own wording knows "stream was interrupted",
+// not "cut short after the reply had begun", so the turn failed untried
+// and its next turn wrote the whole conversation to the cache again
+// (#5535). The failure names the phrase to retry on.
+func TestClaudeCutStreamMidToolCallWordedToRetry(t *testing.T) {
+	lines := []string{
+		cutStart,
+		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_w","name":"mcp__magpie__Write","input":{}}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"report.md\",\"content\":\"half o"}}}`,
+		`{"type":"stream_event","event":{"type":"message_stop"}}`,
+	}
+	_, stop, _, _, raw, _, ok := claudeReply(t, &subscriptionRun{}, lines, true)
+	if stop == "end_turn" || ok || !strings.Contains(raw, "cut short after the reply had begun") {
+		t.Fatalf("stop %q, ok %v:\n%s", stop, ok, raw)
+	}
+	if !strings.Contains(raw, "(stream was interrupted; retry the request)") {
+		t.Fatalf("the failure says nothing a client's own retry reads as transient:\n%s", raw)
+	}
+}
+
 // A whole stream's output count is its message_delta's, which the client
 // is told: no usage is lost on the way (#726's first question).
 func TestClaudeStreamOutputCounted(t *testing.T) {
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 75c1d68c2..b7c48440a 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -3815,10 +3815,15 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 		return nil
 	}
 	// failed ends the reply with an error where it was cut short with
-	// nothing to go on in
+	// nothing to go on in. The reply had begun, so the status is spent
+	// and the words are all the client has: named with a phrase its own
+	// retry reads as transient ("stream was interrupted"), the turn is
+	// asked again, and the conversation is not written to the cache
+	// whole again (pi matched none of its phrases and failed untried,
+	// #5535)
 	failed := func(why string) {
 		cut = false
-		r.emit(Event{Kind: KError, Text: "Claude Code's stream from Anthropic was cut short " + why, Status: http.StatusBadGateway, RequestID: reqID})
+		r.emit(Event{Kind: KError, Text: "Claude Code's stream from Anthropic was cut short " + why + " (stream was interrupted; retry the request)", Status: http.StatusBadGateway, RequestID: reqID})
 		r.endSegment()
 	}
 	line := func(b []byte) {
-- 
2.50.1 (Apple Git-155)


```

</details>

Branch with the commit: [fix/5535-tool-call-wording](https://github.com/ggbdpq/magpie/tree/fix/5535-tool-call-wording) (head `7205d593597b7a2a80c83ab001a9338b9aab0827`), on upstream/main `416305451`.
