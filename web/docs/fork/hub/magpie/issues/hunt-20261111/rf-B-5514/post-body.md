Refreshed on current `main` (`e6bf4adf1`) — refreshed, not redesigned: same change (the note that says why the advisor never runs on the subscription hop), cherry-picked clean onto today's tip.

**Red without the fix** (bare `e6bf4adf1`, the test from this branch): a Claude Code turn that declares the advisor, routed onto the Claude subscription, went through in silence:

```
--- FAIL: TestClaudeSubscriptionSaysWhenTheAdvisorIsLeftOut
```

(TestClaudeSubscriptionWithoutAnAdvisorSaysNothing is protective: green before the fix too — a turn without the advisor says nothing, as before.)

With the fix: `ok`; the turn logs why the advisor is left out, the gateway's answer unchanged.

**Verification** (all on `e6bf4adf1`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/gateway -run TestClaudeSubscription` | ok 4.9s |
| full `go test -timeout 25m ./internal/gateway` | ok 912.6s, zero failures |
| `gofmt` / `go vet` | clean |
| ablation (the note hunk reverse-applied, tests kept) | red again; restored, green |
| `git am` on detached `e6bf4adf1^` | applies as is; tree identical to the branch head |

**Siblings**: the advisor itself lives in `advisor.go` with its uses in `gateway.go` and `anthropic.go` — untouched; the note sits at the one entry where a Claude Code turn reaches the subscription run (`claude_subscription.go`, the `"advisor_` body check).

**Branch with the commit**: [hunt-20261111-rf-5514](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5514) (head `fa801670baab664c`).

**Not verified**: a real Claude Code session with `/advisor` on a subscription route (the fixture `testdata/claude-code-advisor-turn.json` pins the turn shape).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a Claude Code turn that declares its advisor says why the model never calls it (#5514) — git am applies it as is; SHA-256 first 16: c8046d88c273954c</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 04:13:29 +0800
Subject: [PATCH] gateway: a Claude Code turn that declares its advisor says
 why the model never calls it

UNIARG (#5514): with Claude Code's advisor on (CLAUDE_CODE_ENABLE_
EXPERIMENTAL_ADVISOR_TOOL, advisorModel), every request carries the
server tool {"type": "advisor_20260301", ...}. Through a Remote magpie
to a Claude subscription, the turn is parsed for the bridge that drives
the real Claude Code binary, and that parse leaves server tools out -
the advisor's instructions in the conversation are told to be void -
while the run itself is never started with an advisor. The model could
not call it, the request answered 200, and nothing anywhere said why.

Says it now, once a turn that declares the advisor is served on the
subscription line: the run magpie drives is not started with it, the
tool is left out, and the model is told so. Turns that declare none say
nothing, as before.

Wiring the advisor to the run itself is a separate question: the CLI's
advisor switch is the user's own settings, a kept-alive run serves
callers that disagree on the advisor, and the tool's model is named by
magpie's own ids. Not decided here.

Run: TestClaudeSubscriptionSaysWhenTheAdvisorIsLeftOut red before, green
after; TestClaudeSubscriptionWithoutAnAdvisorSaysNothing green before
and after.
---
 internal/gateway/claude_advisor_note_test.go | 62 ++++++++++++++++++++
 internal/gateway/claude_subscription.go      |  7 +++
 2 files changed, 69 insertions(+)
 create mode 100644 internal/gateway/claude_advisor_note_test.go

diff --git a/internal/gateway/claude_advisor_note_test.go b/internal/gateway/claude_advisor_note_test.go
new file mode 100644
index 000000000..f4a6fd162
--- /dev/null
+++ b/internal/gateway/claude_advisor_note_test.go
@@ -0,0 +1,62 @@
+package gateway
+
+import (
+	"bytes"
+	"context"
+	"fmt"
+	"log"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A turn that declares Claude Code's advisor on the subscription line says
+// so in magpie's log: the run magpie drives is not started with the
+// advisor, so the tool is left out of the request and the model is told it
+// is gone. Said by nobody, the user only saw a model that never calls the
+// advisor, on a 200 (#5514).
+func TestClaudeSubscriptionSaysWhenTheAdvisorIsLeftOut(t *testing.T) {
+	s := New()
+	t.Cleanup(s.subscription.abortAll)
+	body := []byte(`{"model":"claude-sonnet-5","max_tokens":64,` +
+		`"tools":[{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}],` +
+		`"messages":[{"role":"user","content":"Before answering, call the advisor tool once to ask: is 2+2=4? Then reply in one word."}]}`)
+	var logs bytes.Buffer
+	old := log.Writer()
+	log.SetOutput(&logs)
+	t.Cleanup(func() { log.SetOutput(old) })
+	w := httptest.NewRecorder()
+	r := httptest.NewRequest("POST", "/v1/messages", nil)
+	s.serveSubscription(w, r, provider.Anthropic, "Claude Code", "claude-sonnet-5", "test", body, &Usage{},
+		func(context.Context, *Request) (*subscriptionRun, <-chan Event, error) {
+			return nil, nil, fmt.Errorf("no run is started; the note is what the test reads")
+		})
+	if !strings.Contains(logs.String(), "declares Claude Code's advisor") {
+		t.Fatalf("the advisor left out was not said: %q", logs.String())
+	}
+}
+
+// A turn that declares no advisor says nothing: the note is for the advisor
+// alone.
+func TestClaudeSubscriptionWithoutAnAdvisorSaysNothing(t *testing.T) {
+	s := New()
+	t.Cleanup(s.subscription.abortAll)
+	body := []byte(`{"model":"claude-sonnet-5","max_tokens":64,` +
+		`"tools":[{"name":"read","input_schema":{"type":"object"}}],` +
+		`"messages":[{"role":"user","content":"hi"}]}`)
+	var logs bytes.Buffer
+	old := log.Writer()
+	log.SetOutput(&logs)
+	t.Cleanup(func() { log.SetOutput(old) })
+	w := httptest.NewRecorder()
+	r := httptest.NewRequest("POST", "/v1/messages", nil)
+	s.serveSubscription(w, r, provider.Anthropic, "Claude Code", "claude-sonnet-5", "test", body, &Usage{},
+		func(context.Context, *Request) (*subscriptionRun, <-chan Event, error) {
+			return nil, nil, fmt.Errorf("no run is started")
+		})
+	if strings.Contains(logs.String(), "advisor") {
+		t.Fatalf("a turn with no advisor was noted: %q", logs.String())
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 992609a88..5aeaf66b7 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -6972,6 +6972,13 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, fro
 	if err != nil {
 		return writeError(w, from, 400, err.Error()), err.Error()
 	}
+	// Claude Code's advisor (/advisor, advisor.go) is a server tool only the
+	// vendor runs, and the run magpie drives is not started with it: the
+	// parse left it out and told the model it is gone. Said by nobody, the
+	// user only saw a model that never calls the advisor, on a 200 (#5514).
+	if name == "Claude Code" && bytes.Contains(body, []byte(`"advisor_`)) {
+		log.Printf("%s: the turn declares Claude Code's advisor, which the run magpie drives is not started with: the tool is left out, and the model is told it is gone", name)
+	}
 	// output_config's effort is the level the CLI thinks at (--effort), which
 	// works whatever the turn thinks: taken also when the request asks no
 	// thinking, which upstream a reasoning ask would turn on though the
-- 
2.50.1 (Apple Git-155)

```
</details>
