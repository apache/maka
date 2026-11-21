This is a refresh of my patch from Nov 10 (comment 6769628237 — branch `fix/5923-claude-run-quiet-term`, head 418ae0e2225192bcd0779f8f5fc8071ced6c07aa, patch sha256[:16] `5ad79ac027c728d9`), re-verified against today's main and re-landed where upstream moved it. That branch is superseded by the one below; nothing else in the story changed.

## What moved under the patch

5c02be05b moved agy onto the community agent plugin and deleted `internal/cli/agy_cli.go`, so the old patch's third face no longer applies. Its successor — the generic `magpie <agent> run` (`startRun`, internal/cli/start_cli.go), the launch command of agy and of any agent plugin with launch — gets the same two lines, and now covers every agent magpie starts this way, not only agy. The other two faces are untouched upstream: `internal/cli/claude_launch_cli.go` and `internal/applog/applog.go` are byte-identical since the old base (ca7a39291), and their hunks land as they were.

Root cause, as before: `magpie claude run` hands the terminal to Claude Code but never moves the standard logger off stderr — `applog.Start` is the desktop app's (internal/cli/gui_on.go:66) — so an Antigravity account's `loadCodeAssist` / `fetchAvailableModels` / quota summary lines (internal/provider/google.go) draw over Claude Code's input and status lines. `applog.Quiet` (carried unchanged) sends the logger to magpie's log file alone while the session runs and answers a function that brings stderr back; what the launcher itself says to the user it prints on stderr itself, and the child's own output isn't the logger's.

## Verification (darwin/arm64, main at 9c33839de, head 0a83bd03fc1ccec2)

| Check | Result |
| --- | --- |
| `TestStartRunLogsBesideTheAgentGoToTheLog` (new, the re-landed start face) | red before the fix at this tip (the logger still on the terminal; no app.log), green after — written red-first today |
| `TestClaudeRunLogsBesideTheSessionGoToTheLog` (carried, claude face) | green; red again with its hunk fully reverted (call and import) |
| `TestQuiet` (carried, internal/applog) | green; red with the restore's `log.SetOutput(prev)` taken out |
| `TestAgyRun`, `TestClaudeRun` (existing) | green, unchanged |
| whole `internal/cli`, `-count=1 -timeout 25m` | 3 failures, the same three red at the parent commit (TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr, TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr, TestUpdateFindsAMagpieThatWroteNoRecord — each reads a real gateway record this machine has; nothing the patch touches) |
| whole `internal/applog`, `-count=1` | ok |
| `-race`: whole `internal/applog`, and the four tests above | ok |
| gofmt; `go vet -tags nogui` on both packages | clean |
| `GOOS=linux|windows|darwin go build -tags nogui ./...` | ok |
| `git am` on a clean tree at upstream/main (9c33839de) | zero conflict, tree identical (8aadc44c) |

## Ablation

- claudeRun's two `applog.Quiet` lines (and the import) reverted: the session test red — logger back on the terminal, app.log absent (the pty run's shape from the first post).
- startRun's two lines (and import) reverted: the new test red, same shape.
- `Quiet`'s redirect fork (`log.SetOutput(w)` plus the `active.Swap`) taken out: both face tests red ("the logger still wrote to the terminal beside …").
- `Quiet`'s restore fork (`log.SetOutput(prev)`) taken out: `TestQuiet` and the session test's final check red ("restore left the logger at …").
- Removing only a call site while keeping its import is a build failure (the import exists for the call) — the reds above are whole-hunk reverts.

---
**Source**: reported in this issue (Lanturewen); patch first posted here on Nov 10, refreshed against today's main.

**Siblings**: `rg -n "log.SetOutput" --type go` — only internal/applog itself (Start/Stop/Quiet and Quiet's restore); `applog.Quiet` has exactly the two wired callers. Other children `internal/cli` starts beside a terminal: the launcher's own word is `fmt.Fprintln(os.Stderr, …)` (not the logger, stays on screen), one-shot alerts (osascript/zenity — no screen of theirs), claude_run_{unix,windows}.go (the claude face, covered), start_exec_windows.go (the start face, covered; on Unix `syscall.Exec` replaces magpie and the log's fd doesn't outlive it). `magpie claude-desktop` starts an app and shares no terminal; `magpie tui` is #1677's, whose patch left the pollution part there; the subscription bridge's claude writes into the serving magpie's log (app.log/serve.log) already.

**When the read fails**: a log that can't be opened leaves the logger where it was and the answered restore restores nothing (the comment on `Quiet` says so; `TestQuiet` covers the working path) — unchanged from the first post.

**Not verified**: a real Antigravity account refreshing beside a real session on this build; the Windows beside-agent waiting path of the start face (reasoning plus start_exec_windows.go's inherited fds, no Windows run); the reporter's v0.1.3545.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt-20261112-t1-5923](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5923) (head `0a83bd03fc1ccec2`).

**Patch**: <details><summary>patch: cli: a claude-magpie session keeps magpie's log off its terminal (#5923, Lanturewen on X) — git am applies it as is; SHA-256 first 16: 9cfc79685bcc88e4</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 03:25:10 +0800
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
terminal. The same goes for `magpie <agent> run` (startRun, agy's and an
agent plugin's launch command): on Windows magpie waits beside the agent
with the fds inherited, so magpie's log would draw over its screen the
same way; on Unix magpie is replaced by the agent (syscall.Exec), where
the call is beside a process about to vanish and the log's fd doesn't
outlive magpie.

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
 internal/cli/claude_launch_cli.go      |  8 +++
 internal/cli/claude_launch_cli_test.go | 79 ++++++++++++++++++++++++++
 internal/cli/start_cli.go              |  7 +++
 internal/cli/start_cli_test.go         | 55 ++++++++++++++++++
 6 files changed, 201 insertions(+)

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
diff --git a/internal/cli/start_cli.go b/internal/cli/start_cli.go
index ef00a6100..d5768be0a 100644
--- a/internal/cli/start_cli.go
+++ b/internal/cli/start_cli.go
@@ -9,6 +9,7 @@ import (
 	"strings"
 
 	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/applog"
 	"github.com/yetone/magpie/internal/proc"
 )
 
@@ -89,6 +90,12 @@ var startExec = startExecOS
 var startLook = proc.Look
 
 func startRun(s agent.Starting, args []string) error {
+	// the terminal is the agent's while it runs, and on Windows magpie
+	// waits beside it (Unix replaces magpie with the agent): what magpie
+	// logs there would overwrite its screen, as it would claude-magpie's
+	// (#5923), so magpie's log goes to magpie's log file until it's done
+	restore := applog.Quiet()
+	defer restore()
 	path, err := startLook(s.Bin)
 	if err != nil {
 		return fmt.Errorf("%s isn't installed, or isn't on your PATH", s.Bin)
diff --git a/internal/cli/start_cli_test.go b/internal/cli/start_cli_test.go
index 5555606ce..e61796dc8 100644
--- a/internal/cli/start_cli_test.go
+++ b/internal/cli/start_cli_test.go
@@ -2,12 +2,15 @@ package cli
 
 import (
 	"errors"
+	"io"
+	"log"
 	"os"
 	"path/filepath"
 	"slices"
 	"strings"
 	"testing"
 
+	"github.com/yetone/magpie/internal/applog"
 	"github.com/yetone/magpie/internal/gateway"
 )
 
@@ -104,3 +107,55 @@ func TestAgyRun(t *testing.T) {
 		t.Fatalf("no agy: %v", err)
 	}
 }
+
+// The terminal is the agent's while `magpie agy run` runs: what magpie
+// logs beside it — an account's models asked again, the shape of #5923's
+// lines — goes to magpie's log, not to that screen, and the logger is
+// back on stderr once the agent is done.
+func TestStartRunLogsBesideTheAgentGoToTheLog(t *testing.T) {
+	home := helpHome(t)
+	t.Setenv("GEMINI_API_KEY", "users-own")
+	t.Setenv("GOOGLE_GEMINI_BASE_URL", "")
+	settings := filepath.Join(home, ".gemini", "antigravity-cli", "magpie-settings.json")
+	os.MkdirAll(filepath.Dir(settings), 0o755)
+	os.WriteFile(settings, []byte(`{"model": "magpie/deepseek/pro", "modelProvider": "gemini"}`), 0o644)
+
+	oldExec, oldLook := startExec, startLook
+	t.Cleanup(func() { startExec, startLook = oldExec, oldLook })
+	before := log.Writer()
+	inSession := make(chan io.Writer, 1)
+	startExec = func(b, n string, a, e []string) error {
+		log.Printf("antigravity someone@example.com: fetchAvailableModels at https://daily-cloudcode-pa.googleapis.com: 20 models, 13 kept")
+		inSession <- log.Writer()
+		return nil
+	}
+	real := filepath.Join(home, "bin", "agy")
+	startLook = func(b string) (string, error) {
+		if b != "agy" {
+			return "", errors.New("looked for " + b)
+		}
+		return real, nil
+	}
+
+	if _, err := runOut(t, "agy", "run", "-p", "hi"); err != nil {
+		t.Fatal(err)
+	}
+	select {
+	case beside := <-inSession:
+		if beside == before {
+			t.Error("the logger still wrote to the terminal beside the agent's run")
+		}
+	default:
+		t.Fatal("the agent never started")
+	}
+	logged, err := os.ReadFile(applog.Path())
+	if err != nil {
+		t.Fatalf("reading magpie's log: %v", err)
+	}
+	if !strings.Contains(string(logged), "fetchAvailableModels") {
+		t.Errorf("magpie's log has no line from beside the agent's run:\n%s", logged)
+	}
+	if log.Writer() != before {
+		t.Fatalf("the logger is at %v, want it back where it was", log.Writer())
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
