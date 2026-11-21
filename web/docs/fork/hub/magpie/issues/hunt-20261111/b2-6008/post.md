Confirmed, and fixed: the removal of a gone project swallowed the record cleanup's failure and deleted the entry's ledger with it, which is exactly the residue you described. Branch [hunt-20261111-b2-6008-gone-project-cleanup](https://github.com/ggbdpq/magpie/tree/hunt-20261111-b2-6008-gone-project-cleanup) at `b488b2ddc42a12a33cf7197193716cdfef2313d6` (base `87dfc0d0b8f97a2ff540308007658c428b79584b`).

**The swallow and what it leaves.** `RemoveProject`'s gone-folder branch (internal/library/projects.go:461-467 at 87b3af765, identical at 87dfc0d0b) runs `l.syncClaudeLocal(p, nil, func(string, error) {})` — every `fail` the cleanup raises is dropped — and then deletes the entry unconditionally. The cleanup that can genuinely fail: `claudelock.Config` waits up to 20s for Claude Code's save lock and gives up with `ErrHeld` (claudelock.go:24, "try again in a moment"); `DelJSON`/`SetJSON` fail when `~/.claude.json` can't be read or written; the Root-changed path clears through `clearClaudeLocal`, same failures. When that happens the entry and its `p.Claude` ledger leave the list together, so the `disabledMcpServers` names and the `mcpServers.magpie` entry nobody will ever remove again. Your rebuild scenario, split by what the residue is: the disabled names are Claude Code's own semantics and come back silently the moment a repository exists at the path again; the hub entry is a URL ending in `~<projectKey>`, a hash of the folder (project_git.go:144) — rebuilt at the same path it hashes the same and the router routes it to whatever project is registered there now; at another path nobody claims it and Claude Code is left connecting to a key that answers for nothing.

**The fix keeps the entry on the failure.** The branch now collects the cleanup's first error and fails the removal with it; `change` does not save then (library.go:341-344), so the entry, its ledger (`p.Claude`, which `syncClaudeLocal` keeps conservative on failures — a `DelJSON` that failed keeps the name in `rec.Servers`, a `disabledMcpServers` write that failed keeps `rec.Off`), and the residue all stay consistent, the error reaches the GUI and the CLI (library.go:790, library_project_cli.go:74), and removing again — or the next sync — retries the cleanup. This mirrors the treatment the neighboring branch already gives a folder that couldn't be looked at (#3510): unknown state keeps the records.

**RED, green, and the removal back to red.** The new test holds Claude Code's save lock (`<h>/.claude.json.lock`, fresh) with `claudelock.Wait` shortened, removes a gone project that had turned `fs` off for claude, and requires the removal to fail and the entry to survive with its ledger; then it lets the lock go and requires the retry to finish the job — entry gone, `disabledMcpServers` cleared.

| Check | Result |
| --- | --- |
| New test at `87dfc0d0b` without the fix (product file reverted, test kept) | red: "the removal went through while the record's cleanup failed" (2.29s) |
| With the fix | green; the retry after the lock is let go clears the record |
| `internal/library` whole, `-count=1` | ok 147.611s, no failures |
| gofmt / go vet | clean |
| The removal's other tests (`...WhoseFolderIsGone`, `...WhoseFolderCantBeRead`, `TestProjectServerOff`, `TestProjectSkillOff`) | green with the fix |

**Siblings checked.** The empty `fail` was the only one (rg for `func(string, error) {}` over internal/library: this site alone, now gone). `syncClaudeLocal`'s other caller passes the failure into the `Result` the card shows (projects.go:143); its contract is unchanged. `clearClaudeLocal`'s other caller (the Root-changed path) already surfaces through the same `fail`. The `keep` branch keeps its #514 semantics untouched. Failure reading: `~/.claude.json` unreadable at cleanup time now fails the removal instead of pretending it cleared; the next attempt reads it again.

Source: magpie at `87dfc0d0b8f97a2ff540308007658c428b79584b` for the red baseline and the fix; the three commits upstream since touch site, usage and groups only, so nothing here drifts. Not verified: a real Claude Code holding its lock for the full 20s window (the test shortens `Wait`; the lock's mkdir mechanics are the package's own and are exercised as they run) — everything else above ran here. Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>Patch</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 05:53:04 +0800
Subject: [PATCH] fix(library): keep a gone project whose record cleanup failed
 (#6008)

What changed: RemoveProject of a folder that's gone cleared Claude
Code's record of the project with a fail that swallowed every error,
and removed the entry either way - a cleanup that failed (Claude Code
holding its save lock, a file unreadable) left the disabled servers
and a hub entry in ~/.claude.json with no ledger to clear them by,
and a repository rebuilt at the same path got them back silently.
The cleanup's first error now fails the removal: the entry and its
ledger stay, the error reaches the caller, and removing it again
once the record answers finishes the job.

Run: TestRemoveProjectWhoseFolderIsGoneKeepsItWhenTheCleanupFails is
red at 87dfc0d0b (the removal goes through with the lock held) and
green with this; the removal's other tests, the project off tests and
the whole internal/library package ran green (4.4s); gofmt and go vet
are clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/project_scope_test.go | 38 ++++++++++++++++++++++++++
 internal/library/projects.go           | 15 ++++++++--
 2 files changed, 51 insertions(+), 2 deletions(-)

diff --git a/internal/library/project_scope_test.go b/internal/library/project_scope_test.go
index edb4bfcb4..966e61d44 100644
--- a/internal/library/project_scope_test.go
+++ b/internal/library/project_scope_test.go
@@ -9,6 +9,9 @@ import (
 	"strings"
 	"testing"
 
+	"time"
+
+	"github.com/yetone/magpie/internal/claudelock"
 	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/gateway"
 )
@@ -262,3 +265,38 @@ func TestProjectWorktreeFollows(t *testing.T) {
 		t.Errorf("trees after: %v", v.Projects[0].Trees)
 	}
 }
+
+// A gone project's removal clears Claude Code's record of it first, and a
+// cleanup that failed must not take the project's ledger with it (#6008):
+// the entry stays on the list, the error surfaces, and removing it again
+// once the record answers finishes the job.
+func TestRemoveProjectWhoseFolderIsGoneKeepsItWhenTheCleanupFails(t *testing.T) {
+	h, proj := scopeProject(t)
+	ok(t)(ProjectServerOff(proj, "fs", []string{"claude", "codex"}))
+	if err := os.RemoveAll(proj); err != nil {
+		t.Fatal(err)
+	}
+	// Claude Code holds its save lock over ~/.claude.json: the cleanup can't run
+	lock := filepath.Join(h, ".claude.json.lock")
+	if err := os.MkdirAll(lock, 0o755); err != nil {
+		t.Fatal(err)
+	}
+	wait := claudelock.Wait
+	claudelock.Wait = 300 * time.Millisecond
+	t.Cleanup(func() { claudelock.Wait = wait })
+	if _, err := RemoveProject(proj, false); err == nil {
+		t.Fatal("the removal went through while the record's cleanup failed")
+	}
+	if v, _ := Read(nil); len(v.Projects) != 1 || len(v.Projects[0].ServersOff["fs"]) == 0 {
+		t.Fatalf("projects after the failed cleanup: %+v", v.Projects)
+	}
+	// the lock let go, the removal finishes and the record is cleared
+	os.RemoveAll(lock)
+	ok(t)(RemoveProject(proj, false))
+	if v, _ := Read(nil); len(v.Projects) != 0 {
+		t.Errorf("projects after the retry: %+v", v.Projects)
+	}
+	if got := anyStrs(claudeRecord(t, h, proj)["disabledMcpServers"]); len(got) != 0 {
+		t.Errorf("disabledMcpServers after the retry: %v", got)
+	}
+}
diff --git a/internal/library/projects.go b/internal/library/projects.go
index 22d7a3a7d..cd1c1ee02 100644
--- a/internal/library/projects.go
+++ b/internal/library/projects.go
@@ -459,9 +459,20 @@ func RemoveProject(dir string, keep bool) (*Result, error) {
 		// that answers with an error) isn't known to be gone: its records
 		// stay, and the removal goes as before.
 		if fi, err := os.Stat(p.Dir); errors.Is(err, os.ErrNotExist) || err == nil && !fi.IsDir() {
-			// Claude Code's record of it isn't in the folder
+			// Claude Code's record of it isn't in the folder, and goes with
+			// the entry; one the record's cleanup couldn't clear (a lock
+			// held, a file unreadable) keeps the entry, its ledger with it,
+			// so a later removal tries again (#6008)
 			p.ServersOff = nil
-			l.syncClaudeLocal(p, nil, func(string, error) {})
+			var cleanup error
+			l.syncClaudeLocal(p, nil, func(_ string, err error) {
+				if cleanup == nil {
+					cleanup = err
+				}
+			})
+			if cleanup != nil {
+				return fmt.Errorf("clearing Claude Code's record of %s: %w", p.Dir, cleanup)
+			}
 			l.Projects = slices.DeleteFunc(l.Projects, func(x *Project) bool { return x == p })
 			return nil
 		}
-- 
2.50.1 (Apple Git-155)
```

</details>

SHA-256 (first 16): be4b8e96f225b6ed
