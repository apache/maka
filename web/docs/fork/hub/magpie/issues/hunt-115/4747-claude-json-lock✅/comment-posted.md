Took this one (commented `take` above). Here is the fix, following the direction in the issue.

**What changed.** The Library's MCP writes went through `mcpFile.putEntry` and `mcpFile.del` (`internal/library/mcp.go`, the file `targets.go` gives the claude agent: `mcpFile{Path: claudeJSON(), Format: fmtClaude}`) with no lock held: the file was read and written back bare, and a save of Claude Code's own between the two — project state, tips, usage counters — was lost. The lock helpers move out of `internal/provider` into a small `internal/claudelock` package; `putClaudeLogin` keeps its #4532 behavior through thin wrappers (`claudeRefreshLocks`, `claudeConfigLock`, and its `errClaudeLocked` message unchanged); and `putEntry`/`del` take `<the file's real path>.lock` around the `.claude.json` read-modify-write when the file they write is that one. `settings.json` and every other file the Library writes stay as they were: no lock of Claude Code's is known for them.

**How the lock is taken.** The way Claude Code does (2.1.316, its bundled proper-lockfile, its saver `gi`): a directory made with mkdir at the file's real path plus `.lock`, stale after 10s, held and touched every 2s until released; one not touched past its stale time is taken over, as Claude Code takes a left one over. While Claude Code holds it, the write waits — up to 20s, then the server's write fails with nothing changed and the sync reports why (fail closed, nothing half written). A WSL distro's copy is left as it was: the Claude Code there saves under a lock in the distro's own files, and the distro's path never compares equal to this machine's `claudeJSON()`.

Verification (macOS, arm64, `-tags nogui`):

| Check | Result |
|---|---|
| `go test ./internal/library -run TestClaudeJSONMCP` — new: `TestClaudeJSONMCPWaitsForClaudeCodesLock` (holds the lock dir, touches it, the server is not saved while held and goes in once it is let go, no lock left behind) and `TestClaudeJSONMCPTakesAStaleLock` (one older than 10s is taken over) | red on the old code ("saved while Claude Code held its lock"; a stale lock left behind), green now; ablation: reverting only `internal/library/mcp.go` to the parent turns both red again |
| `go test ./internal/library ./internal/provider` | ok (library 84s, provider 110s) |
| `go test ./internal/provider -run TestClaudeSwitch` — the #4532 lock tests on the moved code (refresh/legacy/config, stale takeover, held past the wait) | all PASS |
| race on the lock tests of both packages | ok |
| `gofmt -l` on the touched files; `go vet` on `internal/library`, `internal/provider`, `internal/claudelock` for darwin, linux and windows | clean |
| `go build -tags nogui` for darwin, linux and windows | ok |

Not verified: a real Claude Code saving the file while a real sync runs (its saves are sub-second and can't be produced on demand), and the file beside a Claude Code running in a WSL distro.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(library): MCP writes to Claude Code's .claude.json take its save lock (#4747) — git am applies it as is; SHA-256 first 16: 7de2c043551a0823</summary>

```diff
From b7a5a8f13e2b7c51f9aa0e2bd6fa248c76720d72 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 19:14:27 +0800
Subject: [PATCH] fix(library): MCP writes to Claude Code's .claude.json take
 its save lock (#4747)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the Library gave Claude Code its MCP servers by reading
~/.claude.json (or $CLAUDE_CONFIG_DIR's) and writing it back with no
lock held, while Claude Code saves the same file often (project state,
tips, usage counters) under a lock of its own, <the file's real
path>.lock: a save of its own between the Library's read and write was
lost. The lock helpers move out of internal/provider into a small
claudelock package (the mkdir lock Claude Code 2.1.316 takes, stale
after 10s for this file), putClaudeLogin keeps its #4532 behavior
through wrappers, and the Library's mcpFile.putEntry and mcpFile.del
take <file>.lock around the .claude.json read-modify-write: they wait
while Claude Code holds it, take over one left stale, and fail the
server's write with nothing changed when it holds one past 20s. A WSL
distro's copy is left as it was: the Claude Code there saves under a
lock in the distro's own files.

Run (mote, -tags nogui):
- TestClaudeJSONMCPWaitsForClaudeCodesLock and
  TestClaudeJSONMCPTakesAStaleLock (internal/library): red on the old
  code (saved while Claude Code held the lock; a stale lock left
  behind), green now.
- go test ./internal/library ./internal/provider -tags nogui: both
  packages green, the #4532 lock tests among them (TestClaudeSwitch…
  refresh/legacy/config, stale takeover, held past the wait).
- race on the lock tests of both packages; go vet on the three touched
  packages for darwin, linux and windows; gofmt clean; go build -tags
  nogui for darwin, linux and windows.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudelock/claudelock.go         | 100 ++++++++++++++++++
 internal/library/claude_json_lock_test.go |  92 +++++++++++++++++
 internal/library/mcp.go                   |  29 ++++++
 internal/provider/claude_lock.go          | 120 +++++-----------------
 internal/provider/claude_lock_test.go     |   7 +-
 5 files changed, 251 insertions(+), 97 deletions(-)
 create mode 100644 internal/claudelock/claudelock.go
 create mode 100644 internal/library/claude_json_lock_test.go

diff --git a/internal/claudelock/claudelock.go b/internal/claudelock/claudelock.go
new file mode 100644
index 000000000..936148616
--- /dev/null
+++ b/internal/claudelock/claudelock.go
@@ -0,0 +1,100 @@
+// Package claudelock takes the mkdir locks Claude Code holds while it
+// saves its files, taken as Claude Code takes them (2.1.316, its bundled
+// proper-lockfile): a lock is a directory made with mkdir, held while it
+// stands and let go by removing it. Its holder touches it every few
+// seconds; one not touched for longer than the lock's stale time is left
+// by a holder that died, and is taken over.
+package claudelock
+
+import (
+	"errors"
+	"fmt"
+	"os"
+	"path/filepath"
+	"time"
+)
+
+var (
+	// Wait is how long a caller waits for Claude Code to let a lock go.
+	// A refresh holds them for one token request; Claude Code itself
+	// gives up after five tries a second or two apart.
+	Wait = 20 * time.Second
+	// poll is how often a held lock is looked at again.
+	poll = 100 * time.Millisecond
+	// touch is how often a lock magpie holds is touched, as Claude
+	// Code's update (5s for the refresh locks, half the stale time for
+	// ~/.claude.json's), so it never reads as left behind.
+	touch = 2 * time.Second
+)
+
+const (
+	// RefreshStale is how long a lock Claude Code refreshes its sign-in
+	// under may stand untouched (.oauth_refresh.lock, ~/.claude.lock).
+	RefreshStale = 60 * time.Second
+	// ConfigStale is how long the lock Claude Code saves ~/.claude.json
+	// under may stand untouched.
+	ConfigStale = 10 * time.Second
+)
+
+// ErrHeld is a lock Claude Code held past Wait.
+var ErrHeld = errors.New("Claude Code is saving its settings: try again in a moment")
+
+// Config takes the lock Claude Code saves the config file path under: at
+// the file's real path (proper-lockfile resolves it) plus ".lock". A
+// file whose folder isn't there yet (Claude Code never run) has no lock
+// to wait for.
+func Config(path string) (release func(), err error) {
+	if r, err := filepath.EvalSymlinks(path); err == nil {
+		path = r
+	}
+	if fi, err := os.Stat(filepath.Dir(path)); err != nil || !fi.IsDir() {
+		return func() {}, nil
+	}
+	return Take(path+".lock", ConfigStale)
+}
+
+// Take makes the lock directory path, waiting while another holds it and
+// taking over one left stale. Held, it is touched until released.
+func Take(path string, stale time.Duration) (release func(), err error) {
+	deadline := time.Now().Add(Wait)
+	for {
+		err := os.Mkdir(path, 0o755)
+		if err == nil {
+			break
+		}
+		if !os.IsExist(err) {
+			return nil, fmt.Errorf("take Claude Code's lock %s: %w", path, err)
+		}
+		if fi, serr := os.Stat(path); serr == nil && time.Since(fi.ModTime()) > stale {
+			// its holder died without letting it go: Claude Code takes
+			// such a lock over the same way
+			if os.Remove(path) == nil {
+				continue
+			}
+		}
+		if time.Now().After(deadline) {
+			return nil, ErrHeld
+		}
+		time.Sleep(poll)
+	}
+	stop, done := make(chan struct{}), make(chan struct{})
+	go func() {
+		defer close(done)
+		t := time.NewTicker(touch)
+		defer t.Stop()
+		for {
+			select {
+			case <-stop:
+				return
+			case <-t.C:
+				now := time.Now()
+				_ = os.Chtimes(path, now, now)
+			}
+		}
+	}()
+	return func() {
+		close(stop)
+		<-done
+		_ = os.Remove(path)
+	}, nil
+}
diff --git a/internal/library/claude_json_lock_test.go b/internal/library/claude_json_lock_test.go
new file mode 100644
index 000000000..75110d29a
--- /dev/null
+++ b/internal/library/claude_json_lock_test.go
@@ -0,0 +1,92 @@
+package library
+
+import (
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// #4747: a server given to Claude Code is written into its .claude.json
+// under the lock Claude Code saves the file under (<the file's real
+// path>.lock, a directory): held while the file is read and written back,
+// or a save of its own between the two — project state, tips, usage
+// counters — is lost.
+
+// A server is not written while Claude Code holds the lock, and goes in
+// once it lets it go, the lock taken and let go as Claude Code takes and
+// lets its own go.
+func TestClaudeJSONMCPWaitsForClaudeCodesLock(t *testing.T) {
+	h := sandbox(t)
+	profile := filepath.Join(h, ".claude.json")
+	write(t, profile, "{}\n")
+	lock := profile + ".lock"
+	if err := os.Mkdir(lock, 0o755); err != nil { // Claude Code holds it
+		t.Fatal(err)
+	}
+	done := make(chan *Result, 1)
+	errs := make(chan error, 1)
+	go func() {
+		r, err := SaveServer("", Server{Name: "fs", Transport: "stdio", Command: "npx", Args: []string{"-y", "@mcp/fs"}, Agents: []string{"claude"}})
+		done <- r
+		errs <- err
+	}()
+	// it waits as long as the lock is held, and touched
+	for range 5 {
+		select {
+		case <-done:
+			t.Fatal("saved while Claude Code held its lock")
+		case <-time.After(100 * time.Millisecond):
+		}
+		now := time.Now()
+		_ = os.Chtimes(lock, now, now)
+	}
+	if err := os.Remove(lock); err != nil { // Claude Code lets it go
+		t.Fatal(err)
+	}
+	select {
+	case r := <-done:
+		if err := <-errs; err != nil {
+			t.Fatal(err)
+		}
+		if len(r.Problems) > 0 {
+			t.Fatalf("problems: %+v", r.Problems)
+		}
+	case <-time.After(30 * time.Second):
+		t.Fatal("the server never went in after the lock was let go")
+	}
+	if got := read(t, profile); !strings.Contains(got, "@mcp/fs") {
+		t.Fatalf("the server isn't in .claude.json:\n%s", got)
+	}
+	if _, err := os.Stat(lock); !os.IsNotExist(err) {
+		t.Fatalf("the lock left behind: %v", err)
+	}
+}
+
+// A lock its holder left (not touched for longer than Claude Code's stale
+// time for the file, 10s) is taken over, as Claude Code does.
+func TestClaudeJSONMCPTakesAStaleLock(t *testing.T) {
+	h := sandbox(t)
+	profile := filepath.Join(h, ".claude.json")
+	write(t, profile, "{}\n")
+	lock := profile + ".lock"
+	if err := os.Mkdir(lock, 0o755); err != nil {
+		t.Fatal(err)
+	}
+	old := time.Now().Add(-2 * time.Minute)
+	_ = os.Chtimes(lock, old, old)
+	r, err := SaveServer("", Server{Name: "fs", Transport: "stdio", Command: "npx", Args: []string{"-y", "@mcp/fs"}, Agents: []string{"claude"}})
+	if err != nil {
+		t.Fatal(err)
+	}
+	if len(r.Problems) > 0 {
+		t.Fatalf("problems: %+v", r.Problems)
+	}
+	if got := read(t, profile); !strings.Contains(got, "@mcp/fs") {
+		t.Fatalf("the server isn't in .claude.json:\n%s", got)
+	}
+	if _, err := os.Stat(lock); !os.IsNotExist(err) {
+		t.Fatalf("the lock left behind: %v", err)
+	}
+}
diff --git a/internal/library/mcp.go b/internal/library/mcp.go
index b5228a86e..5a26e6ba8 100644
--- a/internal/library/mcp.go
+++ b/internal/library/mcp.go
@@ -8,6 +8,7 @@ import (
 	"io/fs"
 	"maps"
 	"math"
+	"path/filepath"
 	"regexp"
 	"slices"
 	"sort"
@@ -21,6 +22,7 @@ import (
 	"gopkg.in/yaml.v3"
 
 	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/claudelock"
 	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/filememo"
 	"github.com/yetone/magpie/internal/imagemcp"
@@ -1335,6 +1337,13 @@ func (f *mcpFile) putEntry(s *Server, o ordered) error {
 		}
 		return nil
 	}
+	// Claude Code saves the file under its own lock: read and written
+	// back under it, or a save of its own between the two is lost (#4747)
+	release, err := f.claudeLock()
+	if err != nil {
+		return err
+	}
+	defer release()
 	// Pi's files, or Desktop's, all of them or none
 	return edit.Atomically(func() error {
 		for _, a := range f.also() {
@@ -1379,6 +1388,13 @@ func (f *mcpFile) del(name string) error {
 	case fmtHermes:
 		return edit.DelYAML(f.Path, f.key()+"."+name)
 	}
+	// Claude Code saves the file under its own lock: read and written
+	// back under it, or a save of its own between the two is lost (#4747)
+	release, err := f.claudeLock()
+	if err != nil {
+		return err
+	}
+	defer release()
 	return edit.Atomically(func() error {
 		for _, a := range f.also() {
 			if err := a.del(name); err != nil {
@@ -1405,6 +1421,19 @@ func (f *mcpFile) del(name string) error {
 	}, f.files()...)
 }
 
+// claudeLock takes the lock Claude Code saves its .claude.json under,
+// when the file f writes is that one (claudeJSON): held while it is read
+// and written back, or a save of its own between the two is lost
+// (#4747). No other file of the library's has a lock of Claude Code's to
+// take, and a distro's copy isn't this machine's file: the Claude Code
+// there saves under a lock in the distro's own files.
+func (f *mcpFile) claudeLock() (func(), error) {
+	if f.Format != fmtClaude || filepath.Clean(f.Path) != filepath.Clean(claudeJSON()) {
+		return func() {}, nil
+	}
+	return claudelock.Config(f.Path)
+}
+
 // ---- Codex's TOML ---------------------------------------------------------
 
 // delCodex takes out the server's table and the tables under it ([…env]),
diff --git a/internal/provider/claude_lock.go b/internal/provider/claude_lock.go
index a98a8eab1..c6fccc7e1 100644
--- a/internal/provider/claude_lock.go
+++ b/internal/provider/claude_lock.go
@@ -2,49 +2,26 @@ package provider
 
 import (
 	"errors"
-	"fmt"
 	"os"
 	"path/filepath"
-	"time"
 
 	"github.com/yetone/magpie/internal/appdir"
+	"github.com/yetone/magpie/internal/claudelock"
 )
 
-// Claude Code's own locks, taken as Claude Code takes them (2.1.316, its
-// bundled proper-lockfile): a lock is a directory made with mkdir, held
-// while it stands and let go by removing it. Its holder touches it every
-// few seconds; one not touched for longer than the lock's stale time is
-// left by a holder that died, and is taken over.
-//
-// Claude Code refreshes its sign-in under two of them, in this order:
-// <config dir>/.oauth_refresh.lock, then the older <config dir>.lock
-// (~/.claude.lock), both stale after 60s. Under them it reads the sign-in
-// again, posts the refresh token, and writes back the new pair. A switch
-// that read the sign-in it was replacing while a refresh ran kept that
-// account's refresh token as it was before the refresh: spent, and the
-// account signed out of magpie on its next use (#4532). It saves
-// ~/.claude.json under <that file>.lock, stale after 10s, while it may
-// hold the refresh locks: so it is taken after them, as Claude Code does.
+// Claude Code refreshes its sign-in under two of its own locks, in this
+// order: <config dir>/.oauth_refresh.lock, then the older <config
+// dir>.lock (~/.claude.lock), both stale after 60s. Under them it reads
+// the sign-in again, posts the refresh token, and writes back the new
+// pair. A switch that read the sign-in it was replacing while a refresh
+// ran kept that account's refresh token as it was before the refresh:
+// spent, and the account signed out of magpie on its next use (#4532).
+// It saves ~/.claude.json under <that file>.lock, stale after 10s, while
+// it may hold the refresh locks: so it is taken after them, as Claude
+// Code does. The locks are mkdir locks, taken as Claude Code takes them
+// (claudelock).
 
-var (
-	// claudeLockWait is how long a switch waits for Claude Code to let a
-	// lock go. A refresh holds them for one token request; Claude Code
-	// itself gives up after five tries a second or two apart.
-	claudeLockWait = 20 * time.Second
-	// claudeLockPoll is how often a held lock is looked at again.
-	claudeLockPoll = 100 * time.Millisecond
-	// claudeLockTouch is how often a lock magpie holds is touched, as
-	// Claude Code's update (5s for the refresh locks, half the stale
-	// time for ~/.claude.json's), so it never reads as left behind.
-	claudeLockTouch = 2 * time.Second
-)
-
-const (
-	claudeRefreshStale = 60 * time.Second
-	claudeConfigStale  = 10 * time.Second
-)
-
-// errClaudeLocked is a lock Claude Code held past claudeLockWait.
+// errClaudeLocked is a lock Claude Code held past claudelock.Wait.
 var errClaudeLocked = errors.New("Claude Code is refreshing its sign-in: try again in a moment")
 
 // claudeRefreshLocks takes the locks Claude Code refreshes its sign-in
@@ -56,78 +33,33 @@ func claudeRefreshLocks() (release func(), err error) {
 	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
 		return func() {}, nil
 	}
-	first, err := takeClaudeLock(filepath.Join(dir, ".oauth_refresh.lock"), claudeRefreshStale)
+	first, err := claudelock.Take(filepath.Join(dir, ".oauth_refresh.lock"), claudelock.RefreshStale)
 	if err != nil {
-		return nil, err
+		return nil, claudeHeld(err)
 	}
 	resolved := dir
 	if r, err := filepath.EvalSymlinks(dir); err == nil {
 		resolved = r
 	}
-	legacy, err := takeClaudeLock(resolved+".lock", claudeRefreshStale)
+	legacy, err := claudelock.Take(resolved+".lock", claudelock.RefreshStale)
 	if err != nil {
 		first()
-		return nil, err
+		return nil, claudeHeld(err)
 	}
 	return func() { legacy(); first() }, nil
 }
 
-// claudeConfigLock takes the lock Claude Code saves ~/.claude.json under:
-// at the file's real path (proper-lockfile resolves it) plus ".lock".
+// claudeConfigLock takes the lock Claude Code saves ~/.claude.json under.
 func claudeConfigLock() (release func(), err error) {
-	p := claudeProfilePath()
-	if r, err := filepath.EvalSymlinks(p); err == nil {
-		p = r
-	}
-	if fi, err := os.Stat(filepath.Dir(p)); err != nil || !fi.IsDir() {
-		return func() {}, nil
-	}
-	return takeClaudeLock(p+".lock", claudeConfigStale)
+	release, err = claudelock.Config(claudeProfilePath())
+	return release, claudeHeld(err)
 }
 
-// takeClaudeLock makes the lock directory path, waiting while another
-// holds it and taking over one left stale. Held, it is touched until
-// released.
-func takeClaudeLock(path string, stale time.Duration) (release func(), err error) {
-	deadline := time.Now().Add(claudeLockWait)
-	for {
-		err := os.Mkdir(path, 0o755)
-		if err == nil {
-			break
-		}
-		if !os.IsExist(err) {
-			return nil, fmt.Errorf("take Claude Code's lock %s: %w", path, err)
-		}
-		if fi, serr := os.Stat(path); serr == nil && time.Since(fi.ModTime()) > stale {
-			// its holder died without letting it go: Claude Code takes
-			// such a lock over the same way
-			if os.Remove(path) == nil {
-				continue
-			}
-		}
-		if time.Now().After(deadline) {
-			return nil, errClaudeLocked
-		}
-		time.Sleep(claudeLockPoll)
+// claudeHeld says a lock Claude Code held past the wait as a switch's
+// own: the one waiting on a refresh, not on a save.
+func claudeHeld(err error) error {
+	if errors.Is(err, claudelock.ErrHeld) {
+		return errClaudeLocked
 	}
-	stop, done := make(chan struct{}), make(chan struct{})
-	go func() {
-		defer close(done)
-		t := time.NewTicker(claudeLockTouch)
-		defer t.Stop()
-		for {
-			select {
-			case <-stop:
-				return
-			case <-t.C:
-				now := time.Now()
-				_ = os.Chtimes(path, now, now)
-			}
-		}
-	}()
-	return func() {
-		close(stop)
-		<-done
-		_ = os.Remove(path)
-	}, nil
+	return err
 }
diff --git a/internal/provider/claude_lock_test.go b/internal/provider/claude_lock_test.go
index f8c4943be..0b0df3763 100644
--- a/internal/provider/claude_lock_test.go
+++ b/internal/provider/claude_lock_test.go
@@ -8,6 +8,7 @@ import (
 	"testing"
 	"time"
 
+	"github.com/yetone/magpie/internal/claudelock"
 	"github.com/yetone/magpie/internal/filelock"
 )
 
@@ -134,9 +135,9 @@ func TestClaudeSwitchStaleAndHeldLocks(t *testing.T) {
 	})
 	t.Run("held", func(t *testing.T) {
 		home, cred := claudeLockAccounts(t)
-		w := claudeLockWait
-		claudeLockWait = 300 * time.Millisecond
-		t.Cleanup(func() { claudeLockWait = w })
+		w := claudelock.Wait
+		claudelock.Wait = 300 * time.Millisecond
+		t.Cleanup(func() { claudelock.Wait = w })
 		if err := os.Mkdir(home+"/.claude.lock", 0o755); err != nil {
 			t.Fatal(err)
 		}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4747-claude-json-lock](https://github.com/ggbdpq/magpie/tree/fix/4747-claude-json-lock) (head `b7a5a8f13e2b7c51f9aa0e2bd6fa248c76720d72`).
