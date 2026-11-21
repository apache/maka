**Follow-up to my analysis above** ([full diagnosis](https://github.com/yetone/magpie/issues/4863#issuecomment-6616369515)): I've implemented Option 1 from it — a run that dies while parked on its reply's tool calls now leaves its session on the shelf, and the request carrying the tool results (a client compaction among them) goes on from that session instead of a new Claude Code being told the whole conversation.

**What's changed**

- `park` now takes the key the results' request arrives under (the turn key through the reply — what a turn kept idle waits by) and records it on the run.
- A run that dies while it waits — its Claude Code exits, or the oversized budget lets it go — shelves its session at that key (`shelveParked`, from `removeRun`) instead of the session file being deleted: the same way a run let go past `idleMost` leaves its session for the next turn.
- The results, and the turn they end, `unshelve` it and go on from it, told only the messages since. `continueWith` clears the recorded key, and the `parkLongest` / `parkedMost` / `oversized` comments and the oversized let-go log line say so now.

**Root cause** — one line from the analysis above: a run parked on tool calls fell through all three ways the bridge keeps a conversation going (`park` computed no shelf key, `shelve` wants an idle key, `removeRun` deleted the session file), so the results' request found neither a run nor a shelf entry and `replaySession` wrote the whole history again — a prefix Anthropic's cache has never seen.

**The fix** — `git am` applies the patch below as is:

<details>
<summary>patch (git am applies it as is; SHA-256 first 16: <code>7cebfb1554d8e421</code>)</summary>

```patch
From 605b14910720c90e7c85a1382b87eb14e5e7c1ab Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 00:42:45 +0800
Subject: [PATCH] claude bridge: a run that dies parked on tool calls shelves
 its session
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A run parked on its reply's tool calls that dies — its Claude Code
exits, or the oversized budget lets it go — fell through every way the
bridge keeps a conversation going: park computes no key to wait under,
so shelve, which wants an idle key, never took its session, and
removeRun deleted the session file. The request carrying the results —
a client compaction among them — then found no run and nothing on the
shelf, and replaySession told a new Claude Code the whole conversation
in one message, a prefix Anthropic's cache has never seen: the whole
history read and written again (#4863, the same write #5043's retry
left open and #3808's turn after a cancelled one ends at).

park now takes the key the results' request arrives under — turnKey
through the reply, what a turn kept idle waits by — and a run that
dies while it waits shelves its session there (shelveParked), the way
one let go past idleMost leaves its for the next turn. The results,
and the turn they end, unshelve it and go on from it, told only the
messages since. park's oversized let-go dies this way too, so its
session is kept as well, and its log and the parkLongest, parkedMost
and oversized comments say so now.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/busy_test.go                 |   2 +-
 internal/gateway/claude_rss.go                |   6 +-
 internal/gateway/claude_subscription.go       |  54 +++++-
 .../claude_subscription_park_shelf_test.go    | 173 ++++++++++++++++++
 4 files changed, 223 insertions(+), 12 deletions(-)
 create mode 100644 internal/gateway/claude_subscription_park_shelf_test.go

diff --git a/internal/gateway/busy_test.go b/internal/gateway/busy_test.go
index 7016fab72..f70637445 100644
--- a/internal/gateway/busy_test.go
+++ b/internal/gateway/busy_test.go
@@ -78,7 +78,7 @@ func TestBusy(t *testing.T) {
 	if b := s.Busy(); b.Tools != 0 {
 		t.Fatalf("a run not waiting: %+v", b)
 	}
-	run.park()
+	run.park("")
 	if b := s.Busy(); b.Tools != 1 || !b.Any() {
 		t.Fatalf("a run waiting on tool results: %+v", b)
 	}
diff --git a/internal/gateway/claude_rss.go b/internal/gateway/claude_rss.go
index cb7fbd1e7..3698ed0f9 100644
--- a/internal/gateway/claude_rss.go
+++ b/internal/gateway/claude_rss.go
@@ -59,9 +59,9 @@ func claudeRunBudget() (int64, string) {
 // (2 a whole turn, 3 a run that waits on tool calls), and logs what it
 // holds either way: a run's growth across turns is in the log, for an OOM
 // to be put down to the process it was. One waiting on its caller's tool
-// results has no session to shelve there: let go, it is started anew with
-// the whole conversation, which Anthropic's cache has not seen, so it is
-// let go only past half as much again.
+// results has no idle key to be shelved by: let go, it dies waiting, and
+// leaves its session on the shelf where the results go by (shelveParked),
+// so it is let go only past half as much again.
 func (r *subscriptionRun) oversized(share int64) (string, bool) {
 	r.mu.Lock()
 	t := r.tree
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index ee2432b74..02a5fb38f 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -137,8 +137,9 @@ const (
 
 // parkLongest is how long a run started anew for each turn (Cursor)
 // waits on its caller's tool results. A caller that quit, or was stopped,
-// sends none; one whose tool ran longer gets its answer all the same, from a
-// run started with the whole conversation, as its next turn would be.
+// sends none; one whose tool ran longer gets its answer all the same, from
+// a run resumed of the session the dead one left on the shelf (#4863), as
+// a next turn is.
 var parkLongest = 5 * time.Minute
 
 // A run whose reply called nothing but a tool that ends its caller's turn
@@ -155,7 +156,7 @@ var (
 // once they have waited parkLongest, the longest waiting let go first: a
 // caller stopped with its calls unanswered (a subagent its workflow ended)
 // sends none, and each is a Claude Code process. One let go that does get
-// its results is started anew with the whole conversation.
+// its results goes on from the session it left on the shelf (#4863).
 const parkedMost = 16
 
 type subscriptionRun struct {
@@ -350,6 +351,12 @@ type subscriptionRun struct {
 	// began waiting on them
 	asked    []string
 	parkedAt time.Time
+	// parkKey is where the request carrying those results comes by
+	// (turnKey through the reply, park): a run that dies while it waits on
+	// the calls leaves its session on the shelf there, for the results —
+	// and the turn they end — to go on from, as a next turn goes on from a
+	// shelved one (#4863). Under mu.
+	parkKey string
 
 	// started is when it was started, and active when its turn under way
 	// began (r.mu), for `magpie claude-code runs` (claudeRunList)
@@ -2172,7 +2179,8 @@ func (r *subscriptionRun) ended(req *Request, said, stop string, ok bool) {
 		r.abortFor("its reply failed or was cut short")
 		return
 	case stop == "tool":
-		r.park()
+		reply := Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: said}}}
+		r.park(turnKey(r.owned(), req, append(req.Messages[:len(req.Messages):len(req.Messages)], reply)))
 		return // it waits on its tool calls
 	case r.stdin == nil:
 		return // it ends by itself
@@ -2389,6 +2397,21 @@ func (b *subscriptionBridge) shelve(run *subscriptionRun) {
 	}
 }
 
+// shelveParked leaves the session of a run that died waiting on its reply's
+// tool calls on the shelf at key, where the request carrying the results
+// goes by (#4863): a parked run has no idle key of its own, so the key is
+// the one park was given. A run let go while it waits (oversized, 3) dies
+// this way too, its session kept as one let go past idleMost keeps its,
+// and the results' turn goes on from it instead of a new Claude Code being
+// told the whole conversation.
+func (b *subscriptionBridge) shelveParked(run *subscriptionRun, key string) {
+	b.mu.Lock()
+	run.idleKey, run.idleAt = key, time.Now()
+	b.shelve(run)
+	run.idleKey = ""
+	b.mu.Unlock()
+}
+
 // unshelve takes the saved session a request's conversation goes on
 // from, if there is one: its next turn, asked of the account, model and
 // settings it had.
@@ -3024,8 +3047,11 @@ func (r *subscriptionRun) answered(raw json.RawMessage) {
 
 // park leaves the run waiting on its reply's tool calls: parkLongest for
 // a run started anew for each turn, finalGrace when they end the caller's
-// turn, and among the parkedMost longest waiting otherwise.
-func (r *subscriptionRun) park() {
+// turn, and among the parkedMost longest waiting otherwise. key is where
+// the results' request comes by, for the session to be shelved at should
+// the run die waiting (removeRun), as one let go past idleMost leaves
+// its for the next turn.
+func (r *subscriptionRun) park(key string) {
 	r.mu.Lock()
 	final := len(r.asked) > 0
 	for _, name := range r.asked {
@@ -3033,6 +3059,7 @@ func (r *subscriptionRun) park() {
 	}
 	now := time.Now()
 	r.parkedAt = now
+	r.parkKey = key
 	// the calls just made answer the conversation the run last heard
 	for id, l := range r.lines {
 		if l.seq > r.parkedSeq && l.told == "" {
@@ -3053,7 +3080,7 @@ func (r *subscriptionRun) park() {
 		return
 	}
 	if why, over := r.oversized(3); over {
-		log.Printf("claude: Claude Code pid %d (%s) is let go while it waits on tool calls: %s; their results go to a new one told the whole conversation", r.pid(), r.model, why)
+		log.Printf("claude: Claude Code pid %d (%s) is let go while it waits on tool calls: %s; their results go on from the session it leaves on the shelf", r.pid(), r.model, why)
 		r.abortFor(why)
 		return
 	}
@@ -5212,6 +5239,7 @@ func (r *subscriptionRun) continueWith(results []Part, said string, tools []brid
 	}
 	r.mu.Lock()
 	r.parkedAt = time.Time{}
+	r.parkKey = ""
 	r.mu.Unlock()
 	ch := r.attach()
 	if r.begin != nil {
@@ -5856,8 +5884,18 @@ func (b *subscriptionBridge) removeRun(run *subscriptionRun) {
 	b.mu.Unlock()
 	_ = os.RemoveAll(run.tmp)
 	run.mu.Lock()
-	sid, sessions, shelved := run.sessionID, run.sessions, run.shelved
+	sid, sessions, shelved, parkKey := run.sessionID, run.sessions, run.shelved, run.parkKey
 	run.mu.Unlock()
+	if !shelved && parkKey != "" {
+		// it died waiting on its reply's tool calls: its session is the
+		// conversation as Claude Code asked it of Anthropic, whose cache
+		// has it — on the shelf where the results go by, not deleted
+		// (#4863)
+		b.shelveParked(run, parkKey)
+		run.mu.Lock()
+		shelved = run.shelved
+		run.mu.Unlock()
+	}
 	if !shelved {
 		removeSession(sessions, sid)
 	}
diff --git a/internal/gateway/claude_subscription_park_shelf_test.go b/internal/gateway/claude_subscription_park_shelf_test.go
new file mode 100644
index 000000000..9e8222181
--- /dev/null
+++ b/internal/gateway/claude_subscription_park_shelf_test.go
@@ -0,0 +1,173 @@
+package gateway
+
+import (
+	"encoding/json"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"runtime"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+// deadClaude stands in for Claude Code whose every process dies as soon as
+// it has said its reply's tool calls: a crash, an update, the machine's OOM
+// killer. What it said is on its output, what its caller got back is whole.
+// It keeps its session as Claude Code does, a file under its config
+// folder's project for the folder it works in, the one --resume names when
+// it is given one. Each process's arguments and the lines it was told go to
+// its own log.
+func deadClaude(t *testing.T) string {
+	t.Helper()
+	if runtime.GOOS == "windows" {
+		t.Skip("a shell script stands in for Claude Code")
+	}
+	home := t.TempDir()
+	testenv.SetHome(t, home)
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Setenv("TMPDIR", t.TempDir())
+	t.Setenv("CLAUDE_CODE_TMPDIR", t.TempDir())
+	config := filepath.Join(home, ".claude")
+	t.Setenv("CLAUDE_CONFIG_DIR", config)
+	logs := t.TempDir()
+	dir := t.TempDir()
+	script := `#!/bin/sh
+log=` + logs + `/$$
+echo "args $*" > $log
+sid=s$$
+prev=
+for a in "$@"; do
+  if [ "$prev" = "--resume" ]; then sid=$a; fi
+  prev=$a
+done
+proj="$CLAUDE_CONFIG_DIR/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
+mkdir -p "$proj"
+file="$proj/$sid.jsonl"
+echo '{"type":"system","subtype":"init","session_id":"'$sid'"}'
+while read -r line; do
+  case $line in *'"type":"control_request"'*)
+    id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
+    echo '{"type":"control_response","response":{"subtype":"success","request_id":"'$id'"}}'
+    continue ;;
+  esac
+  echo "told $line" >> $log
+  printf '%s\n' "$line" >> "$file"
+  echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"claude-sonnet-5","usage":{"input_tokens":1}}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"reading"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__magpie__read"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'
+  echo '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}}'
+  echo '{"type":"stream_event","event":{"type":"message_stop"}}'
+  exit 7
+done
+`
+	testenv.Program(t, filepath.Join(dir, "claude"), script)
+	t.Setenv("PATH", dir+string(filepath.ListSeparator)+os.Getenv("PATH"))
+	return logs
+}
+
+// askDead sends body as a Claude subscription request and says the reply's
+// first words.
+func askDead(t *testing.T, s *Server, body string) string {
+	t.Helper()
+	rec := httptest.NewRecorder()
+	var u Usage
+	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
+	if code, msg := s.serveClaudeSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, p, "claude-sonnet-5", []byte(body), &u); code != 200 {
+		t.Fatalf("%d %s", code, msg)
+	}
+	var res struct {
+		Content []struct{ Text string } `json:"content"`
+	}
+	json.Unmarshal(rec.Body.Bytes(), &res)
+	if len(res.Content) == 0 {
+		t.Fatalf("no answer: %s", rec.Body)
+	}
+	return res.Content[0].Text
+}
+
+// bodyOf turns messages into a request body offering read.
+func bodyOf(t *testing.T, msgs string) string {
+	t.Helper()
+	return `{"model":"claude-sonnet-5","max_tokens":100,"system":"be brief","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + msgs + `]}`
+}
+
+// logsOf is each process's log, the arguments it started with first.
+func logsOf(t *testing.T, dir string) map[string]string {
+	t.Helper()
+	out := map[string]string{}
+	entries, _ := os.ReadDir(dir)
+	for _, e := range entries {
+		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
+		out[e.Name()] = string(b)
+	}
+	return out
+}
+
+// #4863: a run parked on its reply's tool calls dies — its Claude Code
+// exits, or the oversized budget lets it go — and its session file went
+// with it (removeRun): no run waits, and nothing is on the shelf where the
+// results' request comes by. A client whose turn the results end — a
+// compaction among them (pi compacts mid-conversation) — is told the whole
+// conversation in one message, a prefix Anthropic has never cached, and
+// writes all of it again. The run's session is now shelved where the
+// results arrive, and that turn goes on from it, told the results alone.
+func TestClaudeRunDeadWhileParkedLeavesItsSession(t *testing.T) {
+	logs := deadClaude(t)
+	s := New()
+	t.Cleanup(s.subscription.abortAll)
+
+	// the turn's reply calls the client's read tool, and its Claude Code
+	// dies saying it
+	first := askDead(t, s, bodyOf(t, rmsg("user", "read the file")))
+	if first == "" {
+		t.Fatal("no answer")
+	}
+	for deadline := time.Now().Add(10 * time.Second); ; {
+		s.subscription.mu.Lock()
+		n := len(s.subscription.runs)
+		s.subscription.mu.Unlock()
+		if n == 0 {
+			break
+		}
+		if time.Now().After(deadline) {
+			t.Fatal("the run that died on its calls was never taken off the bridge")
+		}
+		time.Sleep(10 * time.Millisecond)
+	}
+
+	// the results come with the whole conversation, as a client sends them
+	msgs := rmsg("user", "read the file") + `,` + rmsg("assistant", first) +
+		`,{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read","input":{}}]}` +
+		`,{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"the file says hello"}]}`
+	before := logsOf(t, logs)
+	again := askDead(t, s, bodyOf(t, msgs))
+	if again == "" {
+		t.Fatal("no answer to the results")
+	}
+	after := logsOf(t, logs)
+	for p, l := range after {
+		if _, ok := before[p]; ok {
+			continue
+		}
+		// the run that went on with the results resumed the dead run's
+		// session, told the results alone; told whole, the conversation
+		// was one message with the first turn in it
+		if !strings.Contains(l, "--resume ") {
+			t.Fatalf("the results went to a new Claude Code told the whole conversation:\n%s", l)
+		}
+		told := l[strings.LastIndex(l, "\ntold "):]
+		if !strings.Contains(told, "the file says hello") || strings.Contains(told, "read the file") {
+			t.Fatalf("the run that went on with the results was told other than the results:\n%s", told)
+		}
+		return
+	}
+	t.Fatalf("no new run answered the results: %v", after)
+}
-- 
2.50.1 (Apple Git-155)
```
</details>

**Verification** (all run locally at the rebased head `605b14910`, darwin/arm64):

| Check | Result |
| --- | --- |
| `go test ./internal/gateway -run 'TestClaudeRunDeadWhileParkedLeavesItsSession' -count=1` | ok (~2.4s; re-run green after the rebase too) |
| `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | ok, 699s, no failures |
| `gofmt -l` on the four touched files | clean |
| `go vet -tags nogui ./internal/gateway` | clean |
| Ablation: revert the two product files, keep the new test | the test FAILs through the replay path (the results went to a new Claude Code told the whole conversation); files restored after |
| `go test -race -tags nogui -run 'TestClaudeRunDeadWhileParkedLeavesItsSession'` | ok (~3.3s) |

**Not verified**: against a real 427K-token session or a Claude Max account (no such session was run, nothing was measured on the reporter's build); on Windows or WSL (the test's stand-in Claude Code is a shell script and skips itself there).

**Attribution**: AI-written (via ZCode); I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: https://github.com/ggbdpq/magpie/tree/fix/4863-replay-cache-diagnose (head `605b14910720c90e7c85a1382b87eb14e5e7c1ab`)

Thanks to @jsk644102-art for the report and the logs the diagnosis reads.
