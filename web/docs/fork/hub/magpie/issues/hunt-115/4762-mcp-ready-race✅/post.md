Took this one (commented `take` above). Here is the fix.

**What the race is.** In the interactive mode, `start` takes the run's first message once the helper answers `initialize` — and the helper answers it as soon as Claude Code shows its prompt. Claude Code connects the bridge's MCP server (`--mcp-config`, the `claude-mcp-helper` subprocess) in parallel with that startup, so the first message could be pasted, and the first request sent upstream, before `tools/list` came back: the request carried `tools: []` and the model answered with no tools, or wrote its calls as words. The log in the report is exactly that order — first request at :34.448, `tools/list` at :34.646.

**What changed.** The helper now tells magpie when Claude Code has listed its tools: its `tools/list` handler posts `{"ready":true}` to the callback it already uses for tool calls, before it answers. `mcpCall` takes that word and closes the run's `mcpReady`; `start` holds the interactive mode's first message until the word arrives — bounded by `mcpReadyWait` (5s), so a helper that never connects holds the turn no longer than that and the turn goes out without the tools, as it did before (fail open). Once per run: a re-list mid-turn (ToolSearch's `list_changed`) says ready again and is absorbed. A run in `claude -p` is unchanged — it takes its first message at launch, with no prompt to wait beside, and the report and the repro are the interactive mode. Warmups and `/usage` runs carry no `--mcp-config` at all, so there is nothing for them to wait on.

Verification (macOS, arm64, `-tags nogui`):
| Check | Result |
|---|---|
| `go test ./internal/gateway -run TestClaudeTUIFirstTurn` — new: `TestClaudeTUIFirstTurnWaitsForMCPTools` (the run's first message is not told while the tools are unlisted; the ready word opens the gate; saying ready twice is taken once, 200 both times) and `TestClaudeTUIFirstTurnGoesWhenToolsNeverLoad` (no word, the turn still answers, after waiting out the 5s bound) | red on the parent ("the first turn went out before the tools were listed: 200"; "didn't wait out the tools' loading: 26ms"), green now; reverting only `internal/gateway/claude_subscription.go` and `internal/claudebridge/mcp.go` to the parent turns both red again |
| `go test ./internal/gateway ./internal/claudebridge` | both packages green (gateway 588s, claudebridge 4s) |
| `-race` on the new tests and on `./internal/claudebridge` | ok |
| `gofmt -l` on the touched files | clean |
| `go vet ./internal/gateway ./internal/claudebridge` for darwin, linux and windows | clean |
| `go build -tags nogui` for darwin, linux and windows | ok |

Known cost: the gateway package's four interactive-mode tests now each wait out the 5s bound (their helper stand-ins exec the fake Claude Code directly and never connect the MCP helper), about +20s on that package's suite. If that bothers CI, the stand-in helpers can be taught to run the real `claude-mcp-helper` and say ready — left out here to keep the diff small.

Not verified: a real Claude Code racing a real helper (the tests drive the same callback the helper posts to, and the helper's `tools/list` post is exercised by its position in the handler, not by a live Claude Code); the wait's behavior on a machine slow enough that MCP connect outlasts 5s — there the turn goes out without the tools, as it does today.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: the interactive mode's first turn waits for the MCP tools (#4762) — git am applies it as is; SHA-256 first 16: cb988dd75d5a8cb3</summary>

```diff
From cc7299653aafd8eabea79ddc6d8328458fccb9f8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 19:27:40 +0800
Subject: [PATCH] gateway: the interactive mode's first turn waits for the MCP
 tools (#4762)

minhuw: a first request went upstream with tools: [], and Claude Code's
tools/list to the bridge's helper came 200ms after. The interactive mode
takes its first message once the prompt shows, and the helper connects
as Claude Code starts: the two race, and the model answered with no
tools, or wrote its calls as words.

The helper now tells magpie at its callback when Claude Code has listed
its tools, and the interactive mode's first message waits for that word
before it is told - no longer than mcpReadyWait (5s), for a helper that
never connects: the turn goes out without the tools then, as it did
before. A run in claude -p is unchanged: it takes its first message at
launch, with no prompt to wait beside.

Fixes #4762

Run:
- go test -tags nogui -run 'TestClaudeTUIFirstTurn' ./internal/gateway:
  the new tests red before (the first turn went out before the tools
  were listed: 200; didn't wait out the tools' loading: 26ms), green
  after
- go test -tags nogui ./internal/gateway ./internal/claudebridge
- go test -race -tags nogui -run 'TestClaudeTUIFirstTurn' ./internal/gateway
- go vet -tags nogui ./internal/gateway ./internal/claudebridge;
  GOOS=linux and GOOS=windows go vet on both; gofmt -l clean

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudebridge/mcp.go                  | 23 +++++
 internal/gateway/claude_subscription.go       | 61 ++++++++++++--
 internal/gateway/claude_tui_mcp_ready_test.go | 84 +++++++++++++++++++
 3 files changed, 163 insertions(+), 5 deletions(-)
 create mode 100644 internal/gateway/claude_tui_mcp_ready_test.go

diff --git a/internal/claudebridge/mcp.go b/internal/claudebridge/mcp.go
index fc03b0fc3..3e1aafece 100644
--- a/internal/claudebridge/mcp.go
+++ b/internal/claudebridge/mcp.go
@@ -147,6 +147,12 @@ func RunMCP(args []string) error {
 					listed = nil
 				}
 				toolsMu.Unlock()
+				// Claude Code has the tools only once this answer is in,
+				// so magpie hears of the listing first: its first turn of
+				// the interactive mode waits for that word, that its first
+				// request never goes upstream with no tools (#4762). Best
+				// effort: a run magpie has let go is told nothing.
+				tellReady(client, callbackURL)
 			case "tools/call":
 				var p struct {
 					Name      string          `json:"name"`
@@ -208,3 +214,20 @@ func newCallID() string {
 	_, _ = rand.Read(b[:])
 	return "call_" + hex.EncodeToString(b[:])
 }
+
+// tellReady tells magpie, at the call back, that Claude Code has listed
+// its tools. Whatever the answer, the listing goes on: the word is a
+// courtesy, not a hand magpie holds up.
+func tellReady(client *http.Client, callbackURL string) {
+	req, err := http.NewRequest(http.MethodPost, callbackURL, strings.NewReader(`{"ready":true}`))
+	if err != nil {
+		return
+	}
+	req.Header.Set("Content-Type", "application/json")
+	res, err := client.Do(req)
+	if err != nil {
+		return
+	}
+	_, _ = io.Copy(io.Discard, res.Body)
+	res.Body.Close()
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 5a6a6ce0b..e5fec1ab1 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -182,9 +182,15 @@ type subscriptionRun struct {
 	clientMarks   bool
 	lean          bool // started with leanSystem as its system prompt
 	tui           bool // Claude Code's interactive mode (claudeTUI)
-	cacheTail     string
-	cachePrefix   cachePrefix
-	timer         *time.Timer
+	// mcpReady is closed once Claude Code has listed the bridge's MCP
+	// tools (the helper's ready word, mcpToolsReady): the interactive
+	// mode's first message waits for it (start), that its first request
+	// never goes upstream with no tools (#4762)
+	mcpReady    chan struct{}
+	readyOnce   sync.Once
+	cacheTail   string
+	cachePrefix cachePrefix
+	timer       *time.Timer
 
 	// Claude Code's input, kept open for the next turn; owner is the account
 	// it runs as (owned, named once in its life when it started unnamed:
@@ -1006,7 +1012,7 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 	}
 	cmd.Stdout, cmd.Stderr = stdoutW, stderrW
 
-	run := &subscriptionRun{bridge: b, token: token, model: model, cmd: cmd, tmp: tmp, schema: len(req.Format.schema()) > 0, pending: map[string]chan mcpToolResult{}, stdin: stdin, effort: req.Effort, sessions: sessions, started: time.Now()}
+	run := &subscriptionRun{bridge: b, token: token, model: model, cmd: cmd, tmp: tmp, schema: len(req.Format.schema()) > 0, pending: map[string]chan mcpToolResult{}, stdin: stdin, effort: req.Effort, sessions: sessions, started: time.Now(), mcpReady: make(chan struct{})}
 	run.owner.Store(&owner)
 	run.names = bridgeNames(req.Tools)
 	run.safeguardBeta = req.SafeguardBeta
@@ -1091,6 +1097,23 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 		run.sessionID = from.session
 		run.mu.Unlock()
 	}
+	if tui {
+		// Claude Code connects its MCP server as it starts, and takes the
+		// first message once its prompt shows: the first request went
+		// upstream with no tools, and the model answered without them
+		// (#4762). The helper says when Claude Code has listed its tools
+		// (mcpCall's ready), and the first message waits for that word —
+		// bounded: a helper that never connects holds the turn no longer
+		// than mcpReadyWait, and the turn goes out without the tools as
+		// it did before.
+		select {
+		case <-run.mcpReady:
+		case <-time.After(mcpReadyWait):
+		case <-ctx.Done():
+			run.abort()
+			return nil, nil, ctx.Err()
+		}
+	}
 	line, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": prompt}})
 	if err := run.tell(line); err != nil {
 		run.abort()
@@ -1112,6 +1135,14 @@ var (
 	tuiInitWait = claudetui.ReadyWait + 2*controlWait
 )
 
+// mcpReadyWait is how long the interactive mode's first message waits for
+// Claude Code to have listed the bridge's MCP tools, once its prompt
+// shows. The helper answers tools/list as Claude Code connects it, so the
+// word normally arrives before the prompt does and the wait is over as
+// start gets there; the bound is for a helper that never connects, whose
+// turn goes out without the tools rather than not at all (mcpToolsReady).
+var mcpReadyWait = 5 * time.Second
+
 // controlUnanswered is a control request Claude Code took and didn't
 // answer in time.
 type controlUnanswered struct{ what string }
@@ -4686,8 +4717,20 @@ func (b *subscriptionBridge) mcpCall(w http.ResponseWriter, r *http.Request) {
 		ToolCallID string          `json:"tool_call_id"`
 		Name       string          `json:"name"`
 		Arguments  json.RawMessage `json:"arguments"`
+		Ready      bool            `json:"ready"`
 	}
-	if json.Unmarshal(body, &call) != nil || call.ToolCallID == "" {
+	if json.Unmarshal(body, &call) != nil {
+		http.Error(w, "invalid tool call", http.StatusBadRequest)
+		return
+	}
+	if call.Ready && call.ToolCallID == "" {
+		// the helper's word that Claude Code has listed the run's tools;
+		// the interactive mode's first message waits for it (start)
+		run.mcpToolsReady()
+		w.WriteHeader(http.StatusOK)
+		return
+	}
+	if call.ToolCallID == "" {
 		http.Error(w, "invalid tool call", http.StatusBadRequest)
 		return
 	}
@@ -4877,6 +4920,14 @@ func (r *subscriptionRun) launch() error {
 	return nil
 }
 
+// mcpToolsReady is the helper's word that Claude Code has listed the
+// run's MCP tools (mcpCall's ready). Once, however many times the helper
+// says it over the run's life: the interactive mode's first message waits
+// for the one that matters (start), and a list mid-turn says again.
+func (r *subscriptionRun) mcpToolsReady() {
+	r.readyOnce.Do(func() { close(r.mcpReady) })
+}
+
 // tell writes line to Claude Code's input. Wait closes that input as
 // Claude Code exits, and a write after it failed "write |1: file already
 // closed", which said nothing of why: one Claude Code no longer reads says
diff --git a/internal/gateway/claude_tui_mcp_ready_test.go b/internal/gateway/claude_tui_mcp_ready_test.go
new file mode 100644
index 000000000..4b4d0c4e8
--- /dev/null
+++ b/internal/gateway/claude_tui_mcp_ready_test.go
@@ -0,0 +1,84 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+	"time"
+)
+
+// The interactive mode's first turn went upstream while Claude Code was
+// still connecting the bridge's MCP server: the request carried no tools,
+// and the model answered "no tools available", or wrote its calls as words
+// (#4762). The helper now says when Claude Code has listed its tools, and
+// start holds the run's first message until then — no longer than
+// mcpReadyWait, for a helper that never connects.
+
+// The first message waits for the tools: not told while the helper's list
+// is still off, told once magpie has the ready word.
+func TestClaudeTUIFirstTurnWaitsForMCPTools(t *testing.T) {
+	h, _ := tuiHelperHarness(t, "")
+	said := make(chan int, 1)
+	go func() { code, _ := h.askCode("rules", "hi"); said <- code }()
+
+	var token string
+	for deadline := time.Now().Add(5 * time.Second); token == ""; {
+		h.s.subscription.mu.Lock()
+		for k, r := range h.s.subscription.runs {
+			if r.tui {
+				token = k
+			}
+		}
+		h.s.subscription.mu.Unlock()
+		if time.Now().After(deadline) {
+			t.Fatal("no run started")
+		}
+		time.Sleep(time.Millisecond)
+	}
+	time.Sleep(300 * time.Millisecond)
+	select {
+	case code := <-said:
+		t.Fatalf("the first turn went out before the tools were listed: %d", code)
+	default:
+	}
+
+	r := httptest.NewRequest("POST", "/_magpie/claude-mcp/"+token, strings.NewReader(`{"ready":true}`))
+	r.SetPathValue("token", token)
+	rec := httptest.NewRecorder()
+	h.s.subscription.mcpCall(rec, r)
+	if rec.Code != 200 {
+		t.Fatalf("the ready word: %d %s", rec.Code, rec.Body.String())
+	}
+	select {
+	case code := <-said:
+		if code != 200 {
+			t.Fatalf("%d", code)
+		}
+	case <-time.After(10 * time.Second):
+		t.Fatal("the turn never went out after the tools were listed")
+	}
+
+	// the helper says ready again as the run goes on (a list mid-turn
+	// says it too): the word is taken once, and said so
+	r2 := httptest.NewRequest("POST", "/_magpie/claude-mcp/"+token, strings.NewReader(`{"ready":true}`))
+	r2.SetPathValue("token", token)
+	rec = httptest.NewRecorder()
+	h.s.subscription.mcpCall(rec, r2)
+	if rec.Code != 200 {
+		t.Fatalf("ready again: %d %s", rec.Code, rec.Body.String())
+	}
+}
+
+// A helper that never lists the tools holds the first message no longer
+// than the wait: the turn goes out without the tools, as it did before.
+// The floor is mcpReadyWait's default; the two move together.
+func TestClaudeTUIFirstTurnGoesWhenToolsNeverLoad(t *testing.T) {
+	h, _ := tuiHelperHarness(t, "")
+	started := time.Now()
+	if code, msg := h.askCode("rules", "hi"); code != 200 {
+		t.Fatalf("%d %s", code, msg)
+	}
+	if d := time.Since(started); d < 5*time.Second {
+		t.Fatalf("the first turn didn't wait out the tools' loading: %s", d)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4762-mcp-ready-race](https://github.com/ggbdpq/magpie/tree/fix/4762-mcp-ready-race) (head `cc7299653aafd8eabea79ddc6d8328458fccb9f8`).
