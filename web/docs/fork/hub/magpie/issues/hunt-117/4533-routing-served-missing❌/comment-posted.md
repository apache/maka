Fixed on `ggbdpq/magpie` branch [`fix/4533-routing-served-missing`](https://github.com/ggbdpq/magpie/tree/fix/4533-routing-served-missing) (head `990d6c5f1`, base `5daba8337`).

**What was wrong**

The row's `served` is the call usage's `Served`, and the usage's `Served` is only what the reply's messages name (`internal/gateway/claude_subscription.go`, `relay`): streamed, each message's model as its events come; whole, the collector's result model. A reply whose messages name no model — no event of it ever carries one — left `Served` empty, and at status 200 the row read as if nothing had answered: `tries [[null, 200]]`, `usage` billed, no `served`.

The missing `ttft` and `flow` read as the other half of the shape: these replies having been asked whole, which isn't timed (#196), so those two are absent by design. And nothing was reused — magpie keeps no reply cache, and the rows carry their own fresh token counts; the reply names no model, that is all.

**The fix**

`relay` now records the model asked for as `served` when the reply names none, both ways a client may ask — streamed and whole:

```go
if usage.Served == "" {
    usage.add(Usage{Served: req.Model})
}
```

The guard keeps a model the reply did name (a fallback's, say): the asked-for model fills an empty `served` alone. The row's `served` and every try's `served` read this same usage, so `tries[].served` is recorded too, as asked.

**Verification**

| Check | Command | Result |
| --- | --- | --- |
| New tests: a reply told whole, a stream, each through both ways a client asks, and a model-named control | `go test ./internal/gateway -run 'TestClaudeReplyWithoutModelRecordsServed\|TestClaudeStreamWithoutModelRecordsServed\|TestClaudeReplyModelKept' -count=1 -tags nogui` | 4 no-model subtests red before (`served ""`), all 6 green after |
| Red without the fix | `internal/gateway/claude_subscription.go` reverted to `5daba8337`, tests kept | the 4 no-model subtests fail, the control passes |
| Race | same targeted set, `-race` | ok |
| Full gateway suite | `go test ./internal/gateway -tags nogui -count=1` | one FAIL: `TestCodexPoolSaysTheClientsVersion` (563s); solo `-count=3` ok — the same single failure the `5daba8337` baseline shows (#4449's run saw it too) |
| gofmt / vet / build | `gofmt -l`; `go vet -tags nogui` and `go build -tags nogui` for darwin, linux, windows | clean, all three vet, all three build |

**Not verified**: a real Claude Code reply that names no model against a real gateway (the tests stand Claude Code's stream-json lines in for its output); which of Claude Code's asks tell their replies without a model is read off the row shapes in this issue, not off its wire.

The usage ingest's empty requested/served models (#3534) is a different pipeline — the ledger's records, not these routing rows — and is not touched here.

---
**Red without the fix** (base `5daba8337`): with `internal/gateway/claude_subscription.go` reverted and the new tests kept, `go test ./internal/gateway -run 'TestClaudeReplyWithoutModelRecordsServed|TestClaudeStreamWithoutModelRecordsServed|TestClaudeReplyModelKept' -tags nogui` fails:
```
--- FAIL: TestClaudeReplyWithoutModelRecordsServed (0.01s)
    --- FAIL: TestClaudeReplyWithoutModelRecordsServed/stream (0.01s)
        claude_served_test.go:39: served "", want "claude-sonnet-5-5"
    --- FAIL: TestClaudeReplyWithoutModelRecordsServed/whole (0.00s)
        claude_served_test.go:39: served "", want "claude-sonnet-5-5"
--- FAIL: TestClaudeStreamWithoutModelRecordsServed (0.00s)
    --- FAIL: TestClaudeStreamWithoutModelRecordsServed/stream (0.00s)
        claude_served_test.go:39: served "", want "claude-sonnet-5-5"
    --- FAIL: TestClaudeStreamWithoutModelRecordsServed/whole (0.00s)
        claude_served_test.go:39: served "", want "claude-sonnet-5-5"
```
With the fix: `ok`.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [fix/4533-routing-served-missing](https://github.com/ggbdpq/magpie/tree/fix/4533-routing-served-missing) (head `990d6c5f1`).

**Patch**: <details><summary>patch: gateway: a claude reply that names no model answers with the one asked for (#4533) — git am applies it as is; SHA-256 first 16: a0a865680999db09</summary>

```patch
From 990d6c5f10816313b7c145f84553a9a8d26dde1e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 21:40:49 +0800
Subject: [PATCH] gateway: a claude reply that names no model answers with the
 one asked for (#4533)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A claude bridge row could read as a 200 that nothing answered: status
200, usage billed, and no served, ttft or flow (21 of a day's 820 claude
rows, tries [[null,200]], 360 tokens out in under 900ms). The row's
served is the usage's, and the usage's Served is what the reply's
messages name; a reply whose messages name no model left it empty. The
absent ttft and flow say the reply was asked whole, which isn't timed
(#196); magpie keeps no reply cache, so nothing was reused — the reply
simply named no model.

relay now records the model asked for as served when the reply names
none, streamed or whole: a 200's row says what replied.

Fixes #4533
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_served_test.go  | 82 +++++++++++++++++++++++++
 internal/gateway/claude_subscription.go | 13 ++++
 2 files changed, 95 insertions(+)
 create mode 100644 internal/gateway/claude_served_test.go

diff --git a/internal/gateway/claude_served_test.go b/internal/gateway/claude_served_test.go
new file mode 100644
index 000000000..d6efa0741
--- /dev/null
+++ b/internal/gateway/claude_served_test.go
@@ -0,0 +1,82 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// claudeServedReply runs lines through readOutput and relay, and returns
+// the usage the call was given.
+func claudeServedReply(t *testing.T, stream bool, lines []string) Usage {
+	t.Helper()
+	run := &subscriptionRun{}
+	segment := run.attach()
+	go run.readOutput(strings.NewReader(strings.Join(lines, "\n") + "\n"))
+	rec := httptest.NewRecorder()
+	var usage Usage
+	code, msg := relay(rec, httptest.NewRequest("POST", "/v1/messages", nil), provider.Anthropic, "Claude Code",
+		&Request{Model: "claude-sonnet-5-5", Stream: stream}, segment, &usage,
+		func() {}, nil, func(string, string, bool) {})
+	if code != 200 || msg != "" {
+		t.Fatalf("reply: %d %s", code, msg)
+	}
+	return usage
+}
+
+// claudeServedCases runs a reply through both ways a client may ask, and
+// wants the usage's Served served.
+func claudeServedCases(t *testing.T, lines []string, want string) {
+	t.Helper()
+	for _, c := range []struct {
+		name   string
+		stream bool
+	}{{"stream", true}, {"whole", false}} {
+		t.Run(c.name, func(t *testing.T) {
+			if got := claudeServedReply(t, c.stream, lines).Served; got != want {
+				t.Fatalf("served %q, want %q", got, want)
+			}
+		})
+	}
+}
+
+// A reply whose messages name no model left the call's usage without
+// Served: the routing row read as a 200 that nothing answered, its reader
+// unable to tell what replied (#4533). The model asked for is recorded
+// instead, as far as the reply names nothing else.
+func TestClaudeReplyWithoutModelRecordsServed(t *testing.T) {
+	// told whole, as a reply Claude Code tells without a stream is
+	claudeServedCases(t, []string{
+		`{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":300}}}`,
+		`{"type":"result","subtype":"success","is_error":false,"result":"hello"}`,
+	}, "claude-sonnet-5-5")
+}
+
+// The same through a stream whose message_start names no model.
+func TestClaudeStreamWithoutModelRecordsServed(t *testing.T) {
+	claudeServedCases(t, []string{
+		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":10,"output_tokens":5}}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
+		`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}}`,
+		`{"type":"stream_event","event":{"type":"message_stop"}}`,
+		`{"type":"result","subtype":"success","is_error":false,"result":"hello"}`,
+	}, "claude-sonnet-5-5")
+}
+
+// A reply that does name its model keeps it: the model asked for fills an
+// empty served alone.
+func TestClaudeReplyModelKept(t *testing.T) {
+	claudeServedCases(t, []string{
+		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_3","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":5}}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
+		`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}}`,
+		`{"type":"stream_event","event":{"type":"message_stop"}}`,
+		`{"type":"result","subtype":"success","is_error":false,"result":"hello"}`,
+	}, "claude-opus-5-5")
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 86e7cb156..385c5a18e 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -5950,6 +5950,14 @@ func relay(w http.ResponseWriter, r *http.Request, from provider.Protocol, name
 		ended(said, stop, failed == "" && r.Context().Err() == nil)
 		// an error event already ended the reply in the client's protocol
 		if failed == "" {
+			// a reply whose messages name no model left the usage without
+			// Served: its row read as a 200 that nothing answered, the
+			// routing log's reader left guessing what replied (#4533).
+			// What answered was, the reply saying nothing else, the model
+			// asked for
+			if usage.Served == "" {
+				usage.add(Usage{Served: req.Model})
+			}
 			enc.finish()
 		}
 		return 200, failed
@@ -5986,6 +5994,11 @@ func relay(w http.ResponseWriter, r *http.Request, from provider.Protocol, name
 	res := col.finish()
 	usage.add(res.Usage)
 	usage.add(Usage{Served: res.Model})
+	// as in a stream: a reply that names no model answers with the one
+	// asked for (#4533)
+	if usage.Served == "" {
+		usage.add(Usage{Served: req.Model})
+	}
 	w.Header().Set("Content-Type", "application/json")
 	w.WriteHeader(200)
 	_, _ = w.Write(renderUsage(from, res, req, usage))
-- 
2.50.1 (Apple Git-155)

```

</details>
