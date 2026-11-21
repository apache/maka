```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 21:19:07 +0800
Subject: [PATCH] claude: an interactive run whose exec the kernel refuses as
 too big is answered as claude -p (NickWilde18)

The interactive mode's Claude Code is given its safeguards in one
environment entry (CLAUDE_CODE_EXTRA_BODY), read once as it starts. In a
long auto-mode conversation the classifier context the client sends
grows turn by turn (#4804), and where one exec string carries no more
than the kernel allows (Linux's MAX_ARG_STRLEN, 131072; macOS holds no
per-string bound), the exec of the helper failed "argument list too
long" for magpie's own binary: the turn was answered 502, Claude Code
asked again, and every try failed the same way, so the conversation went
on nowhere (#4978).

The exec's own error is caught now, on every OS, where no bound of
magpie's guesses one: errors.Is(err, syscall.E2BIG) at the run's launch.
macOS keeps taking the entries of 128KB and more it takes today, and a
run the kernel does refuse is answered by claude -p, whose safety
context goes over stdin, instead of failing again; the interactive mode
is tried first again on the next turn, whose entry may be smaller after
a compaction.

A claude -p run's exec carries no string a request grows but
--json-schema, the answer's schema: refused over one, the request is
answered 400, its schema's size said (execTooBig), where the E2BIG was a
502 every account was asked in turn and rested some (#4778).

Reported by NickWilde18 in #4978, with the sizes measured and the
environment entry named; phylipppp-zzy's Linux v0.1.2888 fails on every
turn of a long auto-mode conversation, and its turns are answered now.

Fixes #4978

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/claude-subscription-bridge.md | 19 ++++
 internal/gateway/claude_e2big_test.go         | 92 +++++++++++++++++++
 internal/gateway/claude_room_test.go          |  2 +-
 internal/gateway/claude_subscription.go       | 58 +++++++++++-
 internal/gateway/ir.go                        |  7 ++
 5 files changed, 173 insertions(+), 5 deletions(-)
 create mode 100644 internal/gateway/claude_e2big_test.go

diff --git a/docs/subsystems/claude-subscription-bridge.md b/docs/subsystems/claude-subscription-bridge.md
index d51bb6210..bccf34282 100644
--- a/docs/subsystems/claude-subscription-bridge.md
+++ b/docs/subsystems/claude-subscription-bridge.md
@@ -362,6 +362,25 @@ turn whose reply had begun, and Off are never asked again
 (`thirdPartyRefused` says why). Settings' own value is not changed.
 `claude_tui_refusal_test.go` holds each case.
 
+A second exception is an exec the kernel refuses for size (`E2BIG`,
+"argument list too long", #4978): the interactive mode's Claude Code is
+given its safeguards in one environment entry (`CLAUDE_CODE_EXTRA_BODY`)
+read as it starts, and a long auto-mode conversation's classifier context
+(#4804) grows that entry past what one exec string may carry on Linux,
+where the exec of the helper failed with magpie's own binary named — the
+turn was answered 502, Claude Code asked again, and every try failed the
+same way. The exec's own error is caught (`startRun`,
+`errors.Is(err, syscall.E2BIG)`), on every OS, where no bound of magpie's
+guesses one: macOS, which holds no per-string bound, keeps taking entries
+of 128KB and more it takes today. The turn is answered by `claude -p`,
+whose safeguards go over stdin (`Request.tuiEnvTooBig`, `claudePrint`
+code `extra-body`), and the interactive mode is tried first again on the
+next turn, whose entry may be smaller after a compaction. A `-p` run's
+exec carries no string a request grows but `--json-schema`: refused over
+one, the request is answered 400, its schema's size said
+(`execTooBig`, `claude_e2big_test.go`), where the E2BIG was a 502 every
+account was asked in turn (#4778).
+
 A JSON schema is answered through an answer tool of magpie's
 (`claude_tui_schema.go`): interactive Claude Code takes `--json-schema`
 and does nothing with it (2.1.316, a real run: its result's
diff --git a/internal/gateway/claude_e2big_test.go b/internal/gateway/claude_e2big_test.go
new file mode 100644
index 000000000..e82e55bac
--- /dev/null
+++ b/internal/gateway/claude_e2big_test.go
@@ -0,0 +1,92 @@
+package gateway
+
+import (
+	"io/fs"
+	"net/http/httptest"
+	"os/exec"
+	"strconv"
+	"strings"
+	"syscall"
+	"testing"
+
+	"github.com/yetone/magpie/internal/proc"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// fakeE2BIG stands for a kernel refusing an exec for size: one of the
+// strings the run would carry is longer than one exec string may be
+// (E2BIG, "argument list too long", #4978). refuse says which commands it
+// refuses; the others start as they would.
+func fakeE2BIG(t *testing.T, refuse func(cmd *exec.Cmd) bool) {
+	t.Helper()
+	old := startTree
+	startTree = func(cmd *exec.Cmd) (*proc.Tree, error) {
+		if refuse(cmd) {
+			return nil, &fs.PathError{Op: "fork/exec", Path: cmd.Path, Err: syscall.E2BIG}
+		}
+		return proc.StartTree(cmd)
+	}
+	t.Cleanup(func() { startTree = old })
+}
+
+// The interactive mode's Claude Code is given its safeguards in one
+// environment entry (CLAUDE_CODE_EXTRA_BODY), read once as it starts. In
+// a long auto-mode conversation the classifier context the client sends
+// grows turn by turn (#4804), and where one exec string carries no more
+// than the kernel allows, the exec of the helper failed "argument list
+// too long" for magpie's own binary: the turn was answered 502, Claude
+// Code asked again, and every try failed the same way, so the
+// conversation went on nowhere (#4978). Such a turn is answered as
+// claude -p, whose safeguards go over stdin, and the interactive mode is
+// tried first again on the next turn.
+func TestClaudeTUIEnvTooBigRunsAsPrint(t *testing.T) {
+	h := tuiScriptHarness(t, `echo "extra ${CLAUDE_CODE_EXTRA_BODY-unset}" >> $log`)
+	fakeE2BIG(t, func(cmd *exec.Cmd) bool { return cmd.Path == claudeTUIHelper })
+	h.extra = safeguards
+	code, msg := h.askCode("rules", "hi")
+	if code != 200 {
+		t.Fatalf("the turn whose interactive exec was refused was not answered: %d %s", code, msg)
+	}
+	runs := h.runs()
+	if len(runs) != 1 {
+		t.Fatalf("%d runs started, want the one claude -p answered: %v", len(runs), runs)
+	}
+	var log string
+	for _, said := range runs {
+		log = said
+	}
+	if !strings.Contains(log, "apply_flag_settings") || !strings.Contains(log, "classifier_context") {
+		t.Fatalf("the print run's safeguards didn't go over stdin: %s", log)
+	}
+	if !strings.Contains(log, "extra unset") {
+		t.Fatalf("the print run was given the safeguards in an environment entry: %s", log)
+	}
+}
+
+// Beside the interactive mode's safeguards, one exec string of a claude
+// -p run can grow with what a client's request asks: --json-schema, the
+// answer's schema. The exec refused over it is the request's 400, its
+// size said, where the E2BIG was a 502 every account was asked in turn
+// and rested some (#4778, #4978).
+func TestClaudePrintSchemaTooBigRefused(t *testing.T) {
+	h := newScriptHarness(t, "ok", "")
+	fakeE2BIG(t, func(*exec.Cmd) bool { return true })
+	schema := `{"type":"object","properties":{"title":{"type":"string"}}}`
+	h.extra = `"output_config":{"format":{"type":"json_schema","schema":` + schema + `}},`
+	body := `{"model":"claude-sonnet-5","max_tokens":100,` + h.extra + `"system":"rules","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hi"}]}`
+	var u Usage
+	rec := httptest.NewRecorder()
+	code, msg := h.s.serveClaudeSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, h.p, "claude-sonnet-5", []byte(body), &u)
+	if code != 400 {
+		t.Fatalf("a schema too big for one exec argument was not refused: %d %s", code, msg)
+	}
+	if !strings.Contains(msg, "schema") || !strings.Contains(msg, strconv.Itoa(len(schema))) {
+		t.Fatalf("the refusal doesn't say the schema's size: %s", msg)
+	}
+	if retryable(code, rec.Body.Bytes()) {
+		t.Fatalf("the refusal is asked of the next account: %s", rec.Body.String())
+	}
+	if runs := h.runs(); len(runs) != 0 {
+		t.Fatalf("%d runs were started for a request refused before its exec", len(runs))
+	}
+}
diff --git a/internal/gateway/claude_room_test.go b/internal/gateway/claude_room_test.go
index eca4a8754..594b00201 100644
--- a/internal/gateway/claude_room_test.go
+++ b/internal/gateway/claude_room_test.go
@@ -85,7 +85,7 @@ func (h *resumeHarness) askCode(system string, said ...string) (int, string) {
 		}
 		msgs = append(msgs, fmt.Sprintf(`{"role":"user","content":%q}`, m))
 	}
-	body := `{"model":"claude-sonnet-5","max_tokens":100,"system":"` + system + `","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + strings.Join(msgs, ",") + `]}`
+	body := `{"model":"claude-sonnet-5","max_tokens":100,` + h.extra + `"system":"` + system + `","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + strings.Join(msgs, ",") + `]}`
 	var u Usage
 	return h.s.serveClaudeSubscription(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, h.p, "claude-sonnet-5", []byte(body), &u)
 }
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 75c1d68c2..02b3eb39a 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -57,6 +57,7 @@ import (
 	"strings"
 	"sync"
 	"sync/atomic"
+	"syscall"
 	"time"
 	"unicode/utf8"
 
@@ -891,7 +892,8 @@ func (b *subscriptionBridge) start(ctx context.Context, req *Request, model, con
 	var full *claudeFull
 	var refused *cliSchemaRefused
 	var tui *tuiRefusal
-	if err != nil && (from != nil || req.replayed) && !errors.As(err, &full) && !errors.As(err, &refused) && !errors.As(err, &tui) && ctx.Err() == nil {
+	var big *execTooBig
+	if err != nil && (from != nil || req.replayed) && !errors.As(err, &full) && !errors.As(err, &refused) && !errors.As(err, &tui) && !errors.As(err, &big) && ctx.Err() == nil {
 		log.Printf("claude: Claude Code could not go on from the conversation's saved session (%v); a new one is told the whole conversation", err)
 		req.branch, req.told = nil, true
 		return b.startTrusted(ctx, req, model, configDir, owner, nil)
@@ -1178,7 +1180,7 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 	// runs them interactively. A run it can't take is refused, never made
 	// -p: a refused request never ran, and isn't the last run
 	tui, code := claudeTUI(req, binary)
-	if !tui && code != "off" && code != "no-shim" && code != thirdPartyCode {
+	if !tui && code != "off" && code != "no-shim" && code != thirdPartyCode && code != extraBodyCode {
 		cleanup()
 		return nil, nil, &tuiRefusal{claudeTUIErr(claudeNotTUIWhy(req, binary))}
 	}
@@ -1300,6 +1302,32 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 	if err != nil {
 		_, _ = stdout.Close(), stderr.Close()
 		b.removeRun(run)
+		if errors.Is(err, syscall.E2BIG) {
+			// the kernel refused the exec: one of the strings it would
+			// have carried is longer than one exec string may be. In the
+			// interactive mode that is the safety context, one
+			// environment entry read as the run starts, which a long
+			// auto-mode conversation's classifier context grows past
+			// (#4978, #4804): the exec failed "argument list too long"
+			// for magpie's own binary, the turn was answered 502, Claude
+			// Code asked again, and every try failed the same way, so
+			// the conversation went on nowhere. The turn is answered by
+			// claude -p, whose safety context goes over stdin, and the
+			// interactive mode is tried first again on the next turn. A
+			// -p run's exec carries no string a request grows but
+			// --json-schema: refused over it, the request's size is
+			// said, a 400 no account is asked for (#4778).
+			if tui {
+				kept = true
+				req.tuiEnvTooBig = true
+				log.Printf("claude: the interactive run's exec was refused as too big (E2BIG); the turn is answered as claude -p, its safety context over stdin")
+				return b.startRun(ctx, req, model, configDir, owner, from)
+			}
+			if n := len(cliSchema(req.Format.schema())); n > 0 {
+				return nil, nil, &execTooBig{msg: fmt.Sprintf("claude was not started: the exec was refused as too big (E2BIG), and its --json-schema argument carries the request's schema, %d bytes", n)}
+			}
+			return nil, nil, &execTooBig{msg: "claude was not started: the exec was refused as too big (E2BIG)"}
+		}
 		return nil, nil, err
 	}
 	go func() {
@@ -1433,6 +1461,7 @@ func claudePrint(req *Request, binary claudeCLI) (code, why string) {
 	}{
 		{urlImages(req.Messages) > 0, "image", "an image known by its URL"},
 		{req.tuiRefused, thirdPartyCode, "Anthropic refused this agent's system prompt in the interactive mode as a third-party app's"},
+		{req.tuiEnvTooBig, extraBodyCode, "the safety context is too big for one environment entry"},
 	} {
 		if c.is {
 			return c.code, c.why
@@ -5702,9 +5731,13 @@ func (r *subscriptionRun) finish() {
 	}
 }
 
+// startTree is launch's proc.StartTree, a var for the tests of an exec a
+// kernel refused for size (#4978).
+var startTree = proc.StartTree
+
 // launch starts the run's agent, to end with all it starts.
 func (r *subscriptionRun) launch() error {
-	t, err := proc.StartTree(r.cmd)
+	t, err := startTree(r.cmd)
 	if err != nil {
 		return err
 	}
@@ -6524,9 +6557,10 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, fro
 		var full *claudeFull
 		var refused *cliSchemaRefused
 		var tui *tuiRefusal
+		var big *execTooBig
 		if errors.As(err, &full) {
 			code = 503
-		} else if errors.As(err, &refused) || errors.As(err, &tui) {
+		} else if errors.As(err, &refused) || errors.As(err, &tui) || errors.As(err, &big) {
 			code = 400
 		}
 		return writeError(w, from, code, name+": "+err.Error()), err.Error()
@@ -6658,6 +6692,22 @@ func thirdPartySaid(name string, code int, msg string) bool {
 // because Anthropic refused its agent's prompt in the interactive mode.
 const thirdPartyCode = "third-party"
 
+// extraBodyCode is claudePrint's code for a run that is claude -p because
+// its interactive exec was refused as too big (E2BIG): the safeguards
+// ride one environment entry there, and claude -p's go over stdin.
+const extraBodyCode = "extra-body"
+
+// execTooBig is an exec a kernel refused for size: one argument or
+// environment string of the run it would have started is longer than one
+// exec string may be (E2BIG, "argument list too long"). The same request
+// fails the same way on every account and every try (#4978), so it is
+// the request's 400, neither asked again nor of the next account, where
+// the E2BIG was a 502 every account was asked in turn and rested some
+// (#4778). The sizes of the request's own are said with it.
+type execTooBig struct{ msg string }
+
+func (e *execTooBig) Error() string { return e.msg }
+
 // redoAsPrint is relay's status for an interactive-mode turn Anthropic
 // refused as a third-party app's (#4503, Raven on Discord: Pi in Cindy
 // through group/auto) before any of its reply was said, or reached the
diff --git a/internal/gateway/ir.go b/internal/gateway/ir.go
index 006ce1590..651aaca70 100644
--- a/internal/gateway/ir.go
+++ b/internal/gateway/ir.go
@@ -229,6 +229,13 @@ type Request struct {
 	// such prompts, with the interactive mode on all the same
 	// (thirdPartyPrint)
 	tuiRefused bool
+	// tuiEnvTooBig, for the Claude bridge, is that this request's
+	// interactive run was not started: its safety context as one
+	// environment entry is longer than one exec string may be, which the
+	// exec refused (E2BIG, #4978). Its turn is answered by claude -p,
+	// whose safety context goes over stdin, with the interactive mode
+	// tried first again on the next turn.
+	tuiEnvTooBig bool
 	// hourMarks has the cache marks magpie adds on Anthropic's Messages
 	// (anthropicBody) last an hour: a Responses client's (Codex's), whose
 	// turns are often more than five minutes apart and whose own vendor
-- 
2.50.1 (Apple Git-155)

```

Branch: [fix/4978-arg-bound-goos](https://github.com/ggbdpq/magpie/tree/fix/4978-arg-bound-goos), head `e8ca5da45ce20ad3aab838b229ba167739528933`, on upstream/main `4ef47b3f4d45342c50cda88a50149f12959c5499`.
SHA-256 (first 16) of the patch above: `9ff90b169f47986b`

**Verification**

| Check | Result |
| --- | --- |
| Not verified | the boundary sizes on real machines: a Linux run whose entry crosses the kernel's per-string bound refused and answered as `claude -p` (phylipppp-zzy's v0.1.2888 conversation is the one to watch), and a macOS session in the 128KB–1MB range going on in the interactive mode untouched — left to the reporters, as no machine here carries the other OS |
| `TestClaudeTUIEnvTooBigRunsAsPrint`, `TestClaudePrintSchemaTooBigRefused` on upstream/main without the fix (tests + the `startTree` seam kept, logic out) | red: `502 fork/exec …/magpie: argument list too long` and `502 …/claude: argument list too long` |
| The same two with the fix | green: 200 through one `claude -p` run, its safeguards over stdin; 400 naming the schema's size, not retryable, no run started |
| Ablation (the E2BIG catch reverted, the rest kept) | red, both, with the same messages; restored, green |
| `TestClaudeTUISafeguardsInEnv`, `TestClaudeTUISafeguardsVaryingPartsKeepTheRun`, `TestClaudeTUIRefusalIsNoAccountsFault`, `TestClaudeSchemaRefusedIsAskedOnce`, and the `TestClaude*` family | green, unchanged |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok, 800.1s, nothing failed — this machine's known reds (`TestMothX`, `TestLaneLimitRoutes`, `TestProxyCheckSaysAProxyPassedBy`) did not fire this run |
| Directed `-race` over the spawn family (new tests, safeguards, refusal, schema-refused, room) | ok, 4.4s |
| `gofmt -l` over `internal/`; `go vet -tags nogui ./internal/gateway` (darwin and `GOOS=linux`) | clean; clean |
| `go build -tags nogui ./...` (darwin), the same for `internal/gateway` and `internal/claudetui` under `GOOS=linux`, `internal/gateway` under `GOOS=windows` (where `syscall.E2BIG` compiles and a Windows command-line overflow reports its own error, as it did before) | ok; ok; ok |
| Beside the exec points that carry no per-request string (warmup and its `/usage` runs, provider install, the Library's MCP launches — constants and configuration, surfaced as their own errors) | untouched, each named in the ablation report below |

**Sibling sweep** (every `proc.StartTree`/`proc.CommandContext` caller read): the subscription bridge's launch is the only one whose exec strings grow with a request — the TUI environment entry and `--json-schema` — and both are covered; warmup and `/usage` carry constants; installs and MCP launches carry operator configuration and fail as themselves; WSL runs hand the entry by name through `wslrun.Env`, never across the boundary that refuses, and their launches are caught by the same `errors.Is` all the same.

**AI use**: written with GLM-5.3-Flash (ZCode), under ggbdpq's direction, from yetone's review of the previous patch.

Generated-by: GLM-5.3-Flash (ZCode)
