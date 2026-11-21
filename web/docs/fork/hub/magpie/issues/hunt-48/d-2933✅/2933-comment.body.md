Branch: [`hunt48-d-bridge-toolresults`](https://github.com/ggbdpq/magpie/tree/hunt48-d-bridge-toolresults), one commit on top of upstream `e4ac5e87`; the patch below applies with `git am`.

## What changed

A request that returns tool results for a parked run's own calls — by their ids — but whose earlier messages were rewritten since the run last heard them claimed the run and **ended it**. With concurrent Claude Code sessions this request is often not the run's own client: Claude Code's fork sub-agents and `--resume`/`--fork-session` sessions start from the lead's conversation as it stands and answer the very calls the lead's run waits on, by the same `toolu_*` ids. So the impostor's request ended a run whose real owner's results were still in flight; those results then found no run (`tool results no run waiting: the run that made the calls ended 26s ago: magpie ended it`), and the conversation was told to a new Claude Code whole — hundreds of messages rewritten to the prompt cache, which is the fast quota burn and the long wait after each tool call.

The fix keeps the rewrite handling (the rewritten request is still answered by a run of its own, told the conversation as the request has it — the run's agent holds the stale context and must not answer from it), but it no longer ends the run that made the calls: the claim is released and the run goes on waiting `parkLongest` (5 min, the same limit a run whose caller stopped already gets) for the results of the client that has not rewritten anything. When those arrive seconds behind the rewrite's, they are delivered to the run that made the calls, and the cached prefix survives. If they never come, the run is reaped by the same park limit as before. The log line now says where the results went instead of claiming the run was let go.

## Red

- `TestRunLetGoWhenTheClientRewroteTheConversation` (updated): before the patch, a rewritten request ended the run that made the calls, and the run's own results arriving later were answered by a third run told the whole conversation. Failed at `the run that made the calls was ended by another conversation's results` and `the run's call was closed before its own results came`.
- `TestRewrittenRunWaitsParkLongestForItsOwnResults` (new): before the patch, the rewritten request ended the run at once instead of letting it wait `parkLongest` for its own results. Failed at `the run that made the calls was ended at once by another conversation's results`.

## Green

Both tests pass after the patch: the rewritten request is answered by a run of its own; the run that made the calls survives, receives its own results when they come, and is reaped after `parkLongest` if they don't.

Mutations (each breaks a test, then restored):
- dropping `released`'s timer reset → the reap test fails (the run outlives its deadline);
- keeping the claim held (not releasing `resuming`) → the delivery test fails (the run's own results go to a third run).

## Verification

| Check | Result |
|---|---|
| Targeted rewrite tests `-count=1` (RED first) | FAIL as above, then PASS |
| Targeted subscription family `-race -count=1` | ok 9.1s |
| `go test ./internal/gateway/ -run TestClaude -count=1` | ok 31.8s |
| `go test ./internal/gateway/ -count=1` (full package) | ok 326.9s |
| `gofmt -l` on the two changed files | clean |
| `go vet ./internal/gateway/` ×3 | exit 0 |
| `go build ./...` ×3 | exit 0 |

## Siblings

None from this lane.

## Not verified

- Not reproduced against real concurrent Claude Code CLIs with fork sub-agents; the pairing defect itself (a rewritten request ending a run whose owner's results are still coming) is pinned by deterministic in-repo tests, and the reported log sequence (`let go: earlier messages changed` → `no run waiting ... ended 26s/0s ago: magpie ended it` → `a new Claude Code is told the whole conversation: 392 messages`) matches it line for line.
- Two of the reported kill paths are by design and untouched by this patch: the 30-minute turn timer (a tool round longer than 30 min ends the run) and the `idleMost = 6` waiting-run limit (mitigated by the session shelf, which resumes with `--resume` when a session file exists). Making them configurable, as suggested in the issue, would be a separate feature.
- Whether the reporter's remaining occurrences after this patch come from those two limits can be told from the log: this patch removes the `let go: earlier messages changed` line and its `ended Ns ago: magpie ended it` followers; timer and eviction kills log their own words (`it waited as long as it may`, `another run was kept in its place`).

Written with an AI coding agent.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>format-patch</summary>

```
From 1de5d792fdad891d173f0db435f5476d2bbce8bb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 01:18:25 +0800
Subject: [PATCH] gateway: tool results for another conversation's rewrite of a
 run's history no longer end the run that made the calls (#2933)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A request whose tool calls are a parked Claude Code run's own, by their
ids, but whose earlier messages were rewritten since the run last heard
them, claimed the run and ended it: a fork sub-agent or a resumed session
of the same conversation answers the very calls the run waits on, so its
request ended a run whose own results were still to come. The client that
had not rewritten anything then found no run waiting, and its
conversation was told to a new Claude Code whole — hundreds of messages
written to the prompt cache again, at each round a rewrite touched.

The rewrite is still not answered from the run: its agent holds the
conversation from before, and would tell the client a context as large
as ever. But the request is answered by a run of its own, told the
conversation as the request has it, and the run that made the calls goes
on waiting for the results of the client that has not rewritten
anything, parkLongest more, as a run whose caller stopped does — the
results of a concurrent session's client come seconds behind the
rewrite's. The log line says where the results went instead of that the
run was let go.

RED: TestRunLetGoWhenTheClientRewroteTheConversation ended the run at
the rewritten request and found its own results answered by a third run;
TestRewrittenRunWaitsParkLongestForItsOwnResults found the run ended at
once. GREEN: the rewritten request is answered by a run of its own, the
run's own results go on in it, and past parkLongest with no results of
its own it is let go. Mutations: dropping released's timer reset leaves
the run waiting past its reap deadline; keeping the claim held sends the
run's own results to a third run.

Fixes #2933

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_subscription.go       |  34 +++-
 .../claude_subscription_rewrite_test.go       | 153 +++++++++++++++++-
 2 files changed, 172 insertions(+), 15 deletions(-)

diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 0532121e..08e0b7ae 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -910,6 +910,19 @@ func (r *subscriptionRun) claimResume() bool {
 	return true
 }
 
+// released gives up a claimed handoff whose request turned out to carry
+// another conversation's rewrite of the run's: the run goes on waiting for
+// the results of the client that has not rewritten anything, parkLongest
+// more, as a run whose caller stopped does (#2933).
+func (r *subscriptionRun) released() {
+	r.mu.Lock()
+	r.resuming = false
+	r.mu.Unlock()
+	if r.timer != nil {
+		r.timer.Reset(parkLongest)
+	}
+}
+
 // resume hands a conversation's next turn to the run that had its last
 // one, when one is waiting: the user's messages since, and nothing else.
 func (b *subscriptionBridge) resume(req *Request, owner string) (*subscriptionRun, <-chan Event) {
@@ -4107,14 +4120,21 @@ func (s *Server) serveSubscription(w http.ResponseWriter, r *http.Request, from
 		run.abort()
 		run, how = nil, accountChanged
 	}
-	// the client rewrote the conversation since the run's last reply, as Pi
-	// does compacting it mid-turn: the run's agent holds the one from before,
-	// would answer from it, and tell the client a context as large as ever,
-	// so the client compacts again at each tool call. It is let go, and a
-	// run started anew is told the conversation as the client now has it.
+	// the request's conversation was rewritten since the run's last reply —
+	// the client's own, as Pi does compacting it mid-turn, or another
+	// session's: Claude Code's fork sub-agents and resumed sessions answer
+	// the very calls the run waits on, by their ids, and theirs is the
+	// history this request carries. The run's agent holds the conversation
+	// from before, would answer from it, and tell the client a context as
+	// large as ever, so the client compacted again at each tool call: these
+	// results go on in a run of their own, told the conversation as the
+	// request has it. The run that made the calls is not ended for them
+	// (#2933): the results of the client that has not rewritten anything are
+	// still to come, and it goes on waiting for them, parkLongest more, as a
+	// run whose caller stopped does.
 	if run != nil && !run.follows(req.Messages) {
-		log.Printf("%s run on %s let go: earlier messages changed while it waited for tool results", name, model)
-		run.abort()
+		log.Printf("%s on %s: tool results go on in a run of their own: earlier messages changed while the run that made the calls waits for them", name, model)
+		run.released()
 		run, how = nil, ""
 	}
 	// the client offers a tool the run's agent was never told of, as Claude
diff --git a/internal/gateway/claude_subscription_rewrite_test.go b/internal/gateway/claude_subscription_rewrite_test.go
index 0232536f..e54eff64 100644
--- a/internal/gateway/claude_subscription_rewrite_test.go
+++ b/internal/gateway/claude_subscription_rewrite_test.go
@@ -7,6 +7,7 @@ import (
 	"strconv"
 	"strings"
 	"testing"
+	"time"
 
 	"github.com/yetone/magpie/internal/provider"
 )
@@ -14,9 +15,15 @@ import (
 // A client that rewrote its conversation between a tool call and its result,
 // as Pi does compacting it mid-turn, is answered by a run told the
 // conversation as it now is: the run that made the call still holds the one
-// from before, and went on telling the client a context as large as ever, so
-// Pi compacted again at each tool call. A conversation that only went on
+// from before, and would tell the client a context as large as ever, so the
+// client compacted again at each tool call. A conversation that only went on
 // keeps its run.
+//
+// The run that made the calls is not ended by the rewrite: a fork or a
+// resumed session of the same conversation answers the very calls it waits
+// on (#2933), by their ids, and its request must not end a run whose own
+// results are still to come. It waits parkLongest more, as a run whose
+// caller stopped does, and is let go if they never come.
 func TestRunLetGoWhenTheClientRewroteTheConversation(t *testing.T) {
 	s := New()
 	b := s.subscription
@@ -101,12 +108,18 @@ func TestRunLetGoWhenTheClientRewroteTheConversation(t *testing.T) {
 	if got := ask(`[` + conv + `]`); got != "tool_use call_2" || len(started) != 1 {
 		t.Fatalf("a conversation that went on: %q from %d runs", got, len(started))
 	}
-	// the client compacts, and sends call_2's result after its summary
+	// the client compacts, and sends call_2's result after its summary; the
+	// rewrite is answered by a run of its own, and the run that made the
+	// calls goes on waiting for the results of the client that has not
+	// rewritten anything
 	go func(run *subscriptionRun, waiter chan mcpToolResult) {
-		if r, ok := <-waiter; ok {
-			t.Errorf("the run from before the rewrite was handed %v", r)
-			says(run, "from the conversation before")
+		if r, ok := <-waiter; !ok {
+			t.Errorf("the run's call was closed before its own results came")
+			return
+		} else if r.Content[0]["text"] != "B2" {
+			t.Errorf("the run's own results answered %v", r)
 		}
+		says(run, "from the conversation it was told")
 	}(started[0], <-second)
 	rewritten := `[` + user("a summary of the conversation so far") + `,` + call("call_2") + `,` + result("call_2", "B") + `]`
 	if got := ask(rewritten); got != "text from the conversation as it now is" {
@@ -118,7 +131,131 @@ func TestRunLetGoWhenTheClientRewroteTheConversation(t *testing.T) {
 	started[0].mu.Lock()
 	closed := started[0].closed
 	started[0].mu.Unlock()
-	if !closed {
-		t.Fatal("the run from before the rewrite is still waiting")
+	if closed {
+		t.Fatal("the run that made the calls was ended by another conversation's results")
+	}
+	// its own results, a moment later: they go on in the run that made the
+	// calls, which holds the conversation they follow
+	conv += `,` + call("call_2") + `,` + result("call_2", "B2")
+	if got := ask(`[` + conv + `]`); got != "text from the conversation it was told" || len(started) != 2 {
+		t.Fatalf("the run's own results: %q from %d runs", got, len(started))
+	}
+	started[0].mu.Lock()
+	closed = started[0].closed
+	started[0].mu.Unlock()
+	if closed {
+		t.Fatal("the run that made the calls was ended though its results came")
+	}
+}
+
+// nopStdin stands for Claude Code's open input: a run kept for its
+// conversation's next turn, whose park does not reset its timer (parkLongest
+// is what released promises, not what park leaves).
+type nopStdin struct{}
+
+func (nopStdin) Write(p []byte) (int, error) { return len(p), nil }
+func (nopStdin) Close() error                { return nil }
+
+// A run whose conversation was rewritten by another's request goes on
+// waiting parkLongest for the results of the client that has not rewritten
+// anything, and is let go then: a rewrite leaves no Claude Code waiting an
+// hour for results that came by another conversation (#2933).
+func TestRewrittenRunWaitsParkLongestForItsOwnResults(t *testing.T) {
+	oldPark := parkLongest
+	parkLongest = time.Second
+	defer func() { parkLongest = oldPark }()
+
+	s := New()
+	b := s.subscription
+	calls := func(run *subscriptionRun, id string) chan mcpToolResult {
+		waiter := make(chan mcpToolResult, 1)
+		run.mu.Lock()
+		run.pending[id] = waiter
+		run.mu.Unlock()
+		b.mu.Lock()
+		b.calls[id] = run
+		b.mu.Unlock()
+		run.emit(Event{Kind: KStart, MsgID: "m", Model: "claude-sonnet-5"})
+		run.emit(Event{Kind: KToolStart, ID: id, Name: "read"})
+		run.emit(Event{Kind: KToolArgs, Text: "{}"})
+		run.emit(Event{Kind: KStop, Stop: "tool"})
+		run.endSegment()
+		return waiter
+	}
+	says := func(run *subscriptionRun, text string) {
+		run.emit(Event{Kind: KStart, MsgID: "m", Model: "claude-sonnet-5"})
+		run.emit(Event{Kind: KText, Text: text})
+		run.emit(Event{Kind: KStop, Stop: "stop"})
+		run.endSegment()
+	}
+	var started []*subscriptionRun
+	start := func(_ context.Context, req *Request) (*subscriptionRun, <-chan Event, error) {
+		run := &subscriptionRun{bridge: b, token: "run" + strconv.Itoa(len(started)), pending: map[string]chan mcpToolResult{}, stdin: nopStdin{}}
+		b.mu.Lock()
+		b.runs[run.token] = run
+		b.mu.Unlock()
+		events := run.attach()
+		run.timer = time.AfterFunc(time.Hour, func() { run.abortFor("it waited as long as it may") })
+		if len(started) == 0 {
+			calls(run, "call_1")
+		} else {
+			says(run, "from the conversation as it now is")
+		}
+		started = append(started, run)
+		return run, events, nil
+	}
+	ask := func(msgs string) string {
+		t.Helper()
+		body := `{"model":"claude-sonnet-5","max_tokens":100,"tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":` + msgs + `}`
+		rec := httptest.NewRecorder()
+		var u Usage
+		if code, msg := s.serveSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, "Claude Code", "claude-sonnet-5", "", []byte(body), &u, start); code != 200 {
+			t.Fatalf("%d %s", code, msg)
+		}
+		var res struct {
+			Content []struct{ Type, Text, ID string } `json:"content"`
+		}
+		json.Unmarshal(rec.Body.Bytes(), &res)
+		if len(res.Content) == 0 {
+			t.Fatalf("no answer: %s", rec.Body)
+		}
+		return res.Content[0].Type + " " + res.Content[0].Text + res.Content[0].ID
+	}
+	user := func(text string) string { return `{"role":"user","content":` + strconv.Quote(text) + `}` }
+	call := func(id string) string {
+		return `{"role":"assistant","content":[{"type":"tool_use","id":"` + id + `","name":"read","input":{}}]}`
+	}
+	result := func(id, text string) string {
+		return `{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":` + strconv.Quote(text) + `}]}`
+	}
+
+	if got := ask(`[` + user("read a") + `]`); got != "tool_use call_1" {
+		t.Fatalf("the first turn: %q", got)
+	}
+	// a rewritten request for the same call's results: answered by a run of
+	// its own, and the run that made the call is not ended for it
+	rewritten := `[` + user("a summary of the conversation so far") + `,` + call("call_1") + `,` + result("call_1", "A") + `]`
+	if got := ask(rewritten); got != "text from the conversation as it now is" || len(started) != 2 {
+		t.Fatalf("after the rewrite: %q from %d runs", got, len(started))
+	}
+	started[0].mu.Lock()
+	closed := started[0].closed
+	started[0].mu.Unlock()
+	if closed {
+		t.Fatal("the run that made the calls was ended at once by another conversation's results")
+	}
+	// past parkLongest with no results of its own, it is let go
+	deadline := time.Now().Add(10 * time.Second)
+	for {
+		started[0].mu.Lock()
+		closed = started[0].closed
+		started[0].mu.Unlock()
+		if closed {
+			break
+		}
+		if time.Now().After(deadline) {
+			t.Fatal("the run whose conversation was rewritten is still waiting")
+		}
+		time.Sleep(20 * time.Millisecond)
 	}
 }
-- 
2.50.1 (Apple Git-155)

```

</details>
