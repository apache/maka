This patch was written with AI assistance (GLM-5.3-Flash through ZCode in ggbdpq's session); every check below was run on this machine, darwin/arm64, against current main.

## What's wrong

`claude-magpie` (`magpie claude run`) hands the terminal to Claude Code for the whole session, but magpie's own process keeps logging to that same terminal: the standard logger's output is stderr, and a `magpie claude run` process never points it anywhere else — `applog.Start`, which sends it to `app.log` beside stderr, is the desktop app's (internal/cli/gui_on.go:66). The report's lines are that logger at work: `loadCodeAssist at …`, `fetchAvailableModels with entitlement …`, `quota summary groups:` are `log.Printf` calls in internal/provider/google.go (613, 616, 781, 1087–1091, 1178, 1536), and the report's reading of claude_launch_cli.go and claude_run_unix.go still matches current main line for line.

## The fix

`applog.Quiet()` (new) sends the standard logger to magpie's log file alone while the session runs — the app's own `app.log` (appdir.Logs), with the rotation and the key masking the app's log already has — and answers a function that brings stderr back. `claudeRun` calls it as it takes the terminal and restores when claude is done. What the launcher itself has to say it prints itself (`fmt.Fprintln(os.Stderr, …)` for the gateway down; the returned error for a settings file it couldn't write), and claude's own output isn't the logger's, so all of that stays on the terminal as before.

`magpie agy run` gets the same two lines: on Windows its exec waits beside agy as claude run does beside claude (fds inherited), so magpie's log would draw over agy's screen the same way; on Unix magpie is replaced by agy (`syscall.Exec`), where the call is beside a process about to vanish and the log's fd doesn't outlive magpie (O_CLOEXEC).

## Verification (darwin/arm64, main at ca7a39291)

| Check | Result |
| --- | --- |
| Real path through a pty: a stand-in claude session, a magpie log line every 2 s | before: the terminal byte stream had 6 of magpie's lines between the screen's own redraws (the report's shape), and `app.log` didn't exist. after: 0 lines on the terminal, all 6 in `app.log` |
| `TestClaudeRunLogsBesideTheSessionGoToTheLog` (new) | red before the fix (the logger still on the terminal; no app.log), green after |
| `TestQuiet` (new, internal/applog) | green |
| `TestClaudeRun` (existing) | green, unchanged |
| whole internal/cli and whole internal/applog (-count=1) | ok |
| `-race`: the session test, and all of internal/applog | ok |
| `go vet -tags nogui ./internal/applog ./internal/cli` | ok |
| `git am` on a clean tree at upstream/main (ca7a39291) | zero conflict |

## Ablation

Taking the two `applog.Quiet` lines (and the import) back out of `claudeRun` — claude_launch_cli.go back at the base shape, `git diff --stat` checked — turns the session test red again with the same two failures (the logger on the terminal; no app.log). Restored, green.

## Siblings, and why not

- `magpie agy run` — the same shape on Windows (magpie waits, fds inherited): fixed in the same patch. On Unix `agyExecOS` is `syscall.Exec`: magpie stops existing, nothing left to log.
- `magpie claude-desktop` — starts Claude Desktop as an app; no interactive terminal is shared, and the command ends at once.
- The subscription bridge's Claude (claude-tui-helper) — its pty is held by the magpie that serves the gateway, whose log already goes to app.log / serve.log; the report also names it as not this issue.
- `magpie tui` — what magpie logs beside a TUI's screen is #1677's, whose patch said the log-pollution part was left there; not this report's environment, not touched.

## On versions

The report was made on v0.1.3536, with v0.1.3545 installed and not re-tested by the reporter. This patch is against current main (ca7a39291), where the two files the report reads are unchanged since before v0.1.3536 and the repro ran fresh today (above) — the version gap is covered by today's runs, not by assumption.

## Patch

`git am` ready, sha256[:16] = `5ad79ac027c728d9`; branch: https://github.com/ggbdpq/magpie/tree/fix/5923-claude-run-quiet-term (head 418ae0e2225192bcd0779f8f5fc8071ced6c07aa)

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 10 Nov 2026 22:14:59 +0800
Subject: [PATCH] cli: a claude-magpie session keeps magpie's log off its
 terminal (#5923, Lanturewen on X)

claude-magpie hands the terminal to claude for the session, and
magpie's process kept logging to its stderr beside it: an Antigravity
account's models asked again (loadCodeAssist, fetchAvailableModels, the
quota summary) drew over Claude Code's input and status lines, on and
off for minutes after the session's screen was up (macOS 27.2, Ghostty).

applog.Quiet sends the standard logger to magpie's log file alone while
the session runs (the app's app.log, rotated, keys masked), and brings
stderr back when it's done. What the launcher itself has to say (the
gateway down, a settings file it couldn't write) it prints on stderr
itself, and claude's own output isn't the logger's, so both stay on the
terminal. The same goes for `magpie agy run`, whose Windows exec waits
beside agy as claude run does beside claude (Unix replaces magpie with
agy, which leaves nothing of magpie's to log).

A stand-in session beside a log line every two seconds, run through a
pty: the terminal had six of magpie's lines over the screen's own and
app.log didn't exist; with the change the terminal has none and app.log
has all six.

Siblings, and why not: `magpie claude-desktop` starts an app and doesn't
share the terminal; the Claude Code the subscription bridge keeps on a
pty of its own writes into the serving magpie's log (applog, serve.log)
already; what magpie logs beside `magpie tui`'s screen is #1677's, said
there to be left.

Fixes #5923

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/applog/applog.go              | 27 +++++++++
 internal/applog/applog_test.go         | 25 ++++++++
 internal/cli/agy_cli.go                |  7 +++
 internal/cli/claude_launch_cli.go      |  8 +++
 internal/cli/claude_launch_cli_test.go | 79 ++++++++++++++++++++++++++
 5 files changed, 146 insertions(+)

diff --git a/internal/applog/applog.go b/internal/applog/applog.go
index 7d96abcc7..7876ba768 100644
--- a/internal/applog/applog.go
+++ b/internal/applog/applog.go
@@ -93,6 +93,33 @@ func Stop() {
 	}
 }
 
+// Quiet sends the standard logger's output to the log alone, for a
+// command handing the terminal to an interactive child (`magpie claude
+// run`): what magpie logs beside the session — an account's models asked
+// again, a gateway note — would overwrite the child's screen (#5923).
+// What the command has to say to the user it prints itself, and the
+// child's own output isn't the logger's to write. It answers a function
+// that brings the logger back to where it was; when the log can't be
+// opened, the logger stays there, and the function restores nothing.
+func Quiet() (restore func()) {
+	prev := log.Writer()
+	w, err := open(Path(), Limit)
+	if err != nil {
+		return func() {}
+	}
+	log.SetOutput(w)
+	if was := active.Swap(w); was != nil {
+		was.Close()
+	}
+	return func() {
+		log.SetOutput(prev)
+		_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
+		if w := active.Swap(nil); w != nil {
+			w.Close()
+		}
+	}
+}
+
 // file is a log file rotated at limit bytes.
 type file struct {
 	mu    sync.Mutex
diff --git a/internal/applog/applog_test.go b/internal/applog/applog_test.go
index 2ba741df9..3345b45c8 100644
--- a/internal/applog/applog_test.go
+++ b/internal/applog/applog_test.go
@@ -82,6 +82,31 @@ func TestStartWritesTheLog(t *testing.T) {
 	}
 }
 
+// Quiet sends the standard logger to the log alone, for a command handing
+// the terminal to an interactive child (magpie claude run): what magpie
+// logs beside the session would overwrite the child's screen (#5923),
+// and restore brings stderr back afterwards.
+func TestQuiet(t *testing.T) {
+	before := log.Writer()
+	restore := Quiet()
+	if log.Writer() == before {
+		t.Fatal("the logger still wrote to the terminal beside the session")
+	}
+	log.Println("a line magpie logged beside the session")
+	restore()
+	if log.Writer() != before {
+		t.Fatalf("restore left the logger at %v, want it back where it was", log.Writer())
+	}
+	log.Println("a line after the session")
+	got := read(t, Path())
+	if !strings.Contains(got, "a line magpie logged beside the session") {
+		t.Errorf("the log has no line from beside the session:\n%s", got)
+	}
+	if strings.Contains(got, "a line after the session") {
+		t.Errorf("the log got a line written after restore:\n%s", got)
+	}
+}
+
 // The log goes to stderr as well, as before; a stderr that fails (the app
 // opened from Explorer has none) never keeps a line from the file.
 func TestStderrToo(t *testing.T) {
diff --git a/internal/cli/agy_cli.go b/internal/cli/agy_cli.go
index abea2cd34..e1f740641 100644
--- a/internal/cli/agy_cli.go
+++ b/internal/cli/agy_cli.go
@@ -9,6 +9,7 @@ import (
 	"strings"
 
 	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/applog"
 	"github.com/yetone/magpie/internal/proc"
 )
 
@@ -67,6 +68,12 @@ var agyExec = agyExecOS
 var agyLook = func() (string, error) { return proc.Look("agy") }
 
 func agyRun(args []string) error {
+	// the terminal is agy's while it runs, and on Windows magpie waits
+	// beside it (Unix replaces magpie with agy): what magpie logs there
+	// would overwrite its screen, as it would claude-magpie's (#5923), so
+	// magpie's log goes to magpie's log file until agy is done
+	restore := applog.Quiet()
+	defer restore()
 	bin, err := agyLook()
 	if err != nil {
 		return errors.New("agy isn't installed, or isn't on your PATH")
diff --git a/internal/cli/claude_launch_cli.go b/internal/cli/claude_launch_cli.go
index d53c8574a..988c28c4c 100644
--- a/internal/cli/claude_launch_cli.go
+++ b/internal/cli/claude_launch_cli.go
@@ -7,6 +7,7 @@ import (
 	"slices"
 
 	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/applog"
 	"github.com/yetone/magpie/internal/claudecode"
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/plugin"
@@ -73,6 +74,13 @@ var claudeLetGo = func() {
 }
 
 func claudeRun(args []string) error {
+	// the terminal is claude's for the session: what magpie logs beside it
+	// (an account's models asked again, a gateway note) would overwrite
+	// its screen (#5923), so while claude runs magpie's log goes to
+	// magpie's log file, stderr back when it's done. What the launcher
+	// itself has to say is printed below, on stderr, as before.
+	restore := applog.Quiet()
+	defer restore()
 	bin := claudeFind()
 	if bin == "" {
 		return errors.New("Claude Code isn't installed: install it from https://claude.com/claude-code, " + claudecode.InstallHint)
diff --git a/internal/cli/claude_launch_cli_test.go b/internal/cli/claude_launch_cli_test.go
index 8514d9e38..8173b095d 100644
--- a/internal/cli/claude_launch_cli_test.go
+++ b/internal/cli/claude_launch_cli_test.go
@@ -2,13 +2,17 @@ package cli
 
 import (
 	"errors"
+	"io"
+	"log"
 	"os"
 	"path/filepath"
 	"slices"
 	"strings"
 	"testing"
+	"time"
 
 	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/applog"
 	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/provider"
@@ -105,3 +109,78 @@ func TestClaudeRun(t *testing.T) {
 		t.Fatal("no error without Claude Code")
 	}
 }
+
+// The terminal is claude's for a claude-magpie session: what magpie logs
+// beside it — an account's models asked again, the shape of the report's
+// lines (#5923) — goes to magpie's log, not to that screen, and the
+// logger is back on stderr once the session is done. What the launcher
+// itself has to say (the gateway down) is still on the terminal.
+func TestClaudeRunLogsBesideTheSessionGoToTheLog(t *testing.T) {
+	home := helpHome(t)
+	t.Setenv("CLAUDE_CONFIG_DIR", "")
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Anthropic: "https://example.test", Key: "k",
+		Models: []string{"claude-opus-4-6"}}); err != nil {
+		t.Fatal(err)
+	}
+	oldExec, oldFind, oldUp, oldStart, oldGo := claudeRunExec, claudeFind, claudeGatewayUp, startUp, claudeLetGo
+	t.Cleanup(func() {
+		claudeRunExec, claudeFind, claudeGatewayUp, startUp, claudeLetGo = oldExec, oldFind, oldUp, oldStart, oldGo
+	})
+	claudeFind = func() string { return filepath.Join(home, "bin", "claude") }
+	claudeGatewayUp = func() bool { return false } // the launcher has a word for the user
+	startUp = func() {}
+	claudeLetGo = func() {}
+
+	before := log.Writer()
+	errR, errW, err := os.Pipe()
+	if err != nil {
+		t.Fatal(err)
+	}
+	oldErr := os.Stderr
+	os.Stderr = errW
+	t.Cleanup(func() { os.Stderr = oldErr })
+
+	// the session: claude is on its screen while this runs
+	inSession := make(chan io.Writer, 1)
+	resume := make(chan struct{})
+	claudeRunExec = func(b string, a, _ []string) error {
+		log.Printf("antigravity someone@example.com: fetchAvailableModels at https://daily-cloudcode-pa.googleapis.com: 20 models, 13 kept")
+		inSession <- log.Writer()
+		<-resume
+		return nil
+	}
+
+	done := make(chan error, 1)
+	go func() {
+		_, err := runOut(t, "claude", "run")
+		done <- err
+	}()
+	var beside io.Writer
+	select {
+	case beside = <-inSession:
+	case <-time.After(20 * time.Second):
+		t.Fatal("claude never started")
+	}
+	if beside == before {
+		t.Error("the logger still wrote to the terminal beside claude's session")
+	}
+	logged, err := os.ReadFile(applog.Path())
+	if err != nil {
+		t.Fatalf("reading magpie's log: %v", err)
+	}
+	if !strings.Contains(string(logged), "fetchAvailableModels") {
+		t.Errorf("magpie's log has no line from beside the session:\n%s", logged)
+	}
+	close(resume) // the session is over
+	if err := <-done; err != nil {
+		t.Fatal(err)
+	}
+	errW.Close()
+	said, _ := io.ReadAll(errR)
+	if !strings.Contains(string(said), "the gateway isn't running") {
+		t.Errorf("the launcher's word for a gateway down isn't on the terminal:\n%s", said)
+	}
+	if log.Writer() != before {
+		t.Fatalf("the logger is at %v, want it back where it was", log.Writer())
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

Generated-by: GLM-5.3-Flash (ZCode)
