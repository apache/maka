@yetone the half of #5469 this patch takes is #2, Claude Code ignoring `max_output_tokens` (@frostming: 32 asked, a 1119-token essay came back with `status: "completed"`, where Gemini's and DeepSeek's own APIs stop at the cap and answer `incomplete`, `reason: "max_output_tokens"`). The report's other halves need no new work here: #1, the dropped `input_file`, is the one #5452 already fixes — the reporter's standalone item with `file_data` and `filename` flat on it is exactly the shape that patch parses, and it is still waiting to be picked (commit `0e94896c7`, branch `fix/5452-pdf-translation-loss`), so on 0.1.3115 the file stays dropped until it lands.

**Root cause**: the Claude subscription has no API to cap: its bridge runs Claude Code, and `claudeCLIArgs` (internal/gateway/claude_subscription.go:3458) passes no reply-limit field because Claude Code takes none. Every other route carries the client's cap — the Responses parse keeps it (`responses.go:345`, `MaxTokens: q.MaxOutputTokens`), keyed Anthropic sends it as `max_tokens` (`anthropic.go:1082`), Gemini's sign-in sets `maxOutputTokens` (`codeassist.go:551`) — but the bridge's turn dropped it whole, and nothing downstream re-cuts the reply either (`withMaxOutput` only lowers, `maxoutput.go:73`).

**The fix**: the run carries the client's cap (`replyCap`, set from `req.MaxTokens` where the run is built), and the bridge counts the reply's words against it as they are streamed — magpie's own token estimate, the bytes over four, the same count `estimate` uses for a request's input — and stops telling the client once the cap is used up, ending the reply as one cut at its length (`KStop "length"`), which every reply form already renders as the vendor's own cut would be: `incomplete`, `reason: "max_output_tokens"` (`responses.go:2434`, Anthropic's `stop_reason: "max_tokens"`). The run itself goes on as it would — a one-off's Claude Code finishes its attempt, and a kept run is left whole for the turns after — so the words past the cap are still paid, as with a vendor that streams past before its own cut lands; cutting the run instead would break the conversations a kept run serves. Thinking, sealed reasoning and a tool call's arguments are neither counted nor cut: the bridge's Claude Code offers no budget for them, and cutting a call mid-arguments would leave the client holding a call it can never answer. Following the reporter's own reading, the reply now ends `incomplete` with `reason: "max_output_tokens"`.

<details><summary>patch: gateway: a reply cap the client named holds the Claude bridge's reply — git am applies it as is; SHA-256 first 16: 010e80a7b9b60e87</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 13:12:01 +0800
Subject: [PATCH] gateway: a reply cap the client named holds the Claude
 bridge's reply
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The cap went nowhere on the Claude subscription: a Responses or
Messages request naming max_output_tokens was translated with its
MaxTokens intact, and every translated turn to a keyed Anthropic API
sent it as max_tokens — but the subscription's bridge runs Claude
Code, which takes no such field, so the model wrote past the cap and
the reply went to the client whole, told completed (#5469 frostming:
32 asked, a 1119-token essay came back, status completed, where
Gemini's and DeepSeek's own APIs stop at the cap and say incomplete,
reason max_output_tokens).

The run now carries the cap (replyCap) and the bridge counts the
reply's words against it — magpie's own count of a request's tokens,
its bytes over four — and stops telling the client once the cap is
used up, ending the reply as one cut at its length, the same
incomplete a vendor's own cut is. The run itself goes on as it would:
a one-off's Claude Code finishes its attempt, and a kept run is left
whole for the turns after. Thinking, sealed reasoning and tool calls
are not counted nor cut, as the bridge's Claude Code offers no budget
for them and cutting a call's arguments would break the reply the
client is mid-way acting on.
---
 internal/gateway/automode_test.go            |  2 +-
 internal/gateway/claude_output_drain_test.go |  4 +-
 internal/gateway/claude_reply_cap_test.go    | 44 ++++++++++++++++++++
 internal/gateway/claude_subscription.go      | 40 +++++++++++++++++-
 4 files changed, 87 insertions(+), 3 deletions(-)
 create mode 100644 internal/gateway/claude_reply_cap_test.go

diff --git a/internal/gateway/automode_test.go b/internal/gateway/automode_test.go
index bd6e9f0df..60bc75106 100644
--- a/internal/gateway/automode_test.go
+++ b/internal/gateway/automode_test.go
@@ -688,7 +688,7 @@ for line in sys.stdin:
 	messages := []map[string]any{{"role": "assistant", "content": "seed"}, {"role": "user", "content": "hi"}}
 	var pid string
 	for i, context := range []string{"first", "second", "", "third", "reject"} {
-		b := map[string]any{"model": "claude-sonnet-5", "max_tokens": 64, "stream": false, "messages": messages}
+		b := map[string]any{"model": "claude-sonnet-5", "max_tokens": 400000, "stream": false, "messages": messages}
 		effort := []string{"high", "low"}[i%2]
 		b["thinking"] = map[string]any{"type": "adaptive"}
 		b["output_config"] = map[string]any{"effort": effort}
diff --git a/internal/gateway/claude_output_drain_test.go b/internal/gateway/claude_output_drain_test.go
index 4e18c0bdb..bdde31e2b 100644
--- a/internal/gateway/claude_output_drain_test.go
+++ b/internal/gateway/claude_output_drain_test.go
@@ -39,7 +39,9 @@ echo '{"type":"stream_event","event":{"type":"message_stop"}}'
 	for i := 0; i < 5; i++ {
 		s := New()
 		p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
-		body := `{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"say a lot"}]}`
+		// the cap is one the bridge now holds the reply to itself (replyCap);
+		// the long reply here is what the test reads to the end
+		body := `{"model":"claude-sonnet-5","max_tokens":400000,"stream":true,"messages":[{"role":"user","content":"say a lot"}]}`
 		rec := httptest.NewRecorder()
 		var u Usage
 		s.serveClaudeSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, p, "claude-sonnet-5", []byte(body), &u)
diff --git a/internal/gateway/claude_reply_cap_test.go b/internal/gateway/claude_reply_cap_test.go
new file mode 100644
index 000000000..6b08d0345
--- /dev/null
+++ b/internal/gateway/claude_reply_cap_test.go
@@ -0,0 +1,44 @@
+package gateway
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+// The client named a reply cap (max_output_tokens) and the model is on the
+// Claude subscription, whose bridge's Claude Code takes no such field: the
+// cap went nowhere and the whole reply was made, told completed (#5469
+// frostming: 32 asked, 1119 came back, status completed). The bridge stops
+// the reply's words here once their estimate reaches the cap, and ends the
+// reply as one cut at its length, the same incomplete a vendor's own cut
+// is.
+func TestClaudeReplyStopsAtTheClientCap(t *testing.T) {
+	long := strings.Repeat("ocean wave ", 40) // 440 bytes, far past a 32-token cap
+	deltas := []string{long[:110], long[110:220], long[220:330], long[330:]}
+	lines := []string{
+		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_cap","model":"claude-opus-5-5","usage":{"input_tokens":9,"output_tokens":1}}}}`,
+		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
+	}
+	for _, part := range deltas {
+		b, _ := json.Marshal(part)
+		lines = append(lines, `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":`+string(b)+`}}}`)
+	}
+	lines = append(lines,
+		`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
+		`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1119}}}`,
+		`{"type":"stream_event","event":{"type":"message_stop"}}`,
+		`{"type":"result","subtype":"success","is_error":false,"result":`+func() string { b, _ := json.Marshal(long); return string(b) }()+`}`,
+	)
+	run := &subscriptionRun{replyCap: 32}
+	text, stop, _, _, raw, ended, ok := claudeReply(t, run, lines, true)
+	if stop != "max_tokens" || ended != "length" || !ok {
+		t.Fatalf("stop %q, run ended %q %v:\n%s", stop, ended, ok, raw)
+	}
+	// the estimate is len/4, magpie's own count of a request's tokens: the
+	// words stop at the cap's worth of bytes, the rest of the attempt and
+	// its end_turn are not the client's to hear
+	if want := long[:32*4]; text != want {
+		t.Fatalf("reply %d bytes, want the %d the cap leaves room for:\n%s", len(text), len(want), raw)
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 910607589..d2bf5aa6d 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -186,6 +186,10 @@ type subscriptionRun struct {
 	// schema says the client asked for an answer fitting a JSON schema,
 	// which Claude Code gives as its StructuredOutput call
 	schema bool
+	// replyCap is the reply's token cap the client named (Request.MaxTokens):
+	// the bridge's Claude Code takes no such field, so magpie stops the
+	// reply's words here once their estimate reaches it (#5469)
+	replyCap int
 
 	// the tools its agent was told of, as it started and since
 	tools map[string]bool
@@ -1282,7 +1286,7 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 	}
 	cmd.Stdout, cmd.Stderr = stdoutW, stderrW
 
-	run := &subscriptionRun{bridge: b, token: token, model: model, cmd: cmd, tmp: tmp, schema: len(req.Format.schema()) > 0, pending: map[string]chan mcpToolResult{}, stdin: stdin, effort: req.Effort, sessions: sessions, started: time.Now()}
+	run := &subscriptionRun{bridge: b, token: token, model: model, cmd: cmd, tmp: tmp, schema: len(req.Format.schema()) > 0, pending: map[string]chan mcpToolResult{}, stdin: stdin, effort: req.Effort, sessions: sessions, started: time.Now(), replyCap: req.MaxTokens}
 	run.owner.Store(&owner)
 	run.names = bridgeNames(req.Tools)
 	run.safeguardBeta = req.SafeguardBeta
@@ -3798,8 +3802,36 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 	retold := false      // this reply was told so
 	var pmu sync.Mutex   // held for each line, and by quiet's settle
 	var quiet *time.Timer
+	// The reply cap the client named (replyCap) reaches Claude Code's model
+	// through no field of the bridge's, so the words stop here: once their
+	// estimate — magpie counts a request's tokens as its bytes over four —
+	// uses the cap up, what room is left goes and the reply ends as one cut
+	// at its length, the same incomplete a vendor's own cut is (#5469).
+	// The run itself goes on as it would: a one-off's Claude Code finishes
+	// its attempt, and a kept run is left whole for the turns after.
+	capped := false  // the words stopped, the reply's end said
+	cappedBytes := 0 // what the reply's words have said, in bytes
+	tell := func(s string) string {
+		if capped || s == "" {
+			return ""
+		}
+		if r.replyCap <= 0 {
+			return s
+		}
+		if room := r.replyCap*4 - cappedBytes; len(s) >= room {
+			s = strings.ToValidUTF8(s[:max(room, 0)], "")
+			capped = true
+			log.Printf("claude: the reply's words stopped at the client's cap of %d tokens", r.replyCap)
+			r.emit(Event{Kind: KStop, Stop: "length"})
+		}
+		cappedBytes += len(s)
+		return s
+	}
 	text := func(s string) {
 		if s != "" && !r.schema {
+			if s = tell(s); s == "" {
+				return
+			}
 			shown = true
 			r.emit(Event{Kind: KText, Text: s})
 		}
@@ -3814,6 +3846,12 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 			inside, refused, calls = true, true, textCalls{}
 		} else if why != "" {
 			held, seen := calls.end()
+			if capped {
+				// the reply's end was said where its words stopped; the
+				// attempt's own end and what it held back are not the
+				// client's to hear
+				return
+			}
 			switch {
 			case seen && !theirs && why == "end_turn" && !retold && r.stdin != nil:
 				retell, retold, inside = true, true, true
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5469-claude-max-output-tokens`](https://github.com/ggbdpq/magpie/tree/fix/5469-claude-max-output-tokens) (head `10c291d9da026f4a4a9b3e5fef2c1f21099463a8`), rebased onto current `upstream/main` (`eef99e4bb`); on a fresh checkout `git am` applies clean (am-checked against a fresh checkout of `eef99e4bb`, the applied tree matches).
| Check | Result |
| --- | --- |
| `TestClaudeReplyStopsAtTheClientCap` (new, internal/gateway/claude_reply_cap_test.go) | red before the fix (`end_turn` and the whole essay went out), pass after |
| the two tests the new cut reaches — `TestClaudeLastWordsAreRead` and `TestClaudeBridgeSafeguardContextUpdates` — name a small `max_tokens` (100 / 64) and reply past it, which a keyed Anthropic API would also cut; their caps are raised to what they actually test for (the output drain, the classifier's contexts), intent unchanged | pass, after the adjustment; both green on `eef99e4bb` before the fix |
| `go test -tags nogui -run TestClaude ./internal/gateway/` | ok, zero failures (108s), and `-race -count=1` ok (128s) |
| `go test -tags nogui -timeout 30m -count=1 ./internal/gateway/` | ok (829s), zero failures |
| `go test -tags nogui -timeout 30m -count=1 ./...` (pinned Go caches) | fails on this machine for room alone: the disk filled mid-run (362Mi free), and `internal/gateway` and `internal/gui` report `build failed` where a standalone `go build -tags nogui ./internal/gateway/` and `go vet` are clean; the rest: `TestMothX` (internal/agent) and `TestHostToldTheGatewayAddress` (internal/plugin) fail the same on the untouched tree — both are known pre-existing here |
| `gofmt -l internal/gateway/` | prints nothing |
| `go vet -tags nogui ./internal/gateway/`; `GOOS=linux go vet -tags nogui ./internal/gateway/`; `GOOS=windows go vet -tags nogui ./internal/gateway/` | clean |
| `go build -tags nogui ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build -tags nogui ./...` | clean |
| Ablation | short-circuiting the cap check (`len(s) >= room` → `false`) turns `TestClaudeReplyStopsAtTheClientCap` red (`end_turn`, whole essay); restored, green |
| Re-verified on upstream/main `eef99e4bb` | the branch is cut from it and the commit sits directly on it; nothing rebaased over |

**Not verified**: not tried on a real Claude subscription account — the cap's cut is verified against fake Claude Code streams (the same shapes #726's tests use); on the wire the estimate (bytes/4) will differ from Anthropic's own count, so the cut lands near the cap, not exactly on it, and the usage the turn finally reports still counts everything the model wrote. Thinking tokens are not counted against the cap, so a thinking-heavy reply tells the client more thinking than a keyed Anthropic API would allow at the same `max_tokens`. A schema's `json_schema` reply takes its answer through a tool call, whose arguments are never cut. NOT-RUNNABLE here: no Claude subscription on this machine.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
