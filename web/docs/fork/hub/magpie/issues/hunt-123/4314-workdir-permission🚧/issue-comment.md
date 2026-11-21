A folder the caller names is now checked for more than being a folder here: magpie also asks whether it may enter it, and works in its own folder when it may not, as it did for a folder named elsewhere. This fixes the misleading `fork/exec .../claude: permission denied` and restores the pre-680b505 behavior for that folder.

**Root cause.** Since 680b505, `clientWorkDir` (`internal/gateway/claude_subscription.go`) accepted a caller-named directory on `os.Stat` alone, which says the path exists and is a directory -- not that the magpie process may `chdir` into it. In your setup the container's own `/root` (0700, root:root) passes `os.Stat`, so the run kept `cmd.Dir = "/root"`. The `chdir` then failed before Claude Code ever started, and Go reports a child-start failure as `fork/exec <binary>: permission denied` -- pointing at the binary, which was fine. `os.Open`-style checks (your suggestion 1) plus the fallback you expected is what this patch does; a retry after the fact (suggestion 2) would pay the failed start on every request and would also swallow real binary failures.

**Fix.** `clientWorkDir` now asks the kernel whether the folder may be entered (`canEnter`: `access(dir, X_OK)` on unix, where chdir asks the same leave; unchanged behavior on Windows, where Go's reported bits are not the ones a run asks for). A folder that may not be entered is treated like one the caller names elsewhere: the run works in `claudeWorkDir()`, is told the caller's environment is where its tools run, and magpie logs `claude: <dir> is a folder magpie may not enter, working in its own instead` once per request so the misconfiguration is visible. Your `container-root` mount workaround keeps working unchanged, and after this patch becomes unnecessary.

**Verification** (darwin/arm64, Go as committed at `d8b3749e` + this patch):

| Check | Result |
| --- | --- |
| New `TestClaudeCallersWorkDirItCannotEnterIsNotUsed` (chmod-000 folder named by the caller; skips when the test process may enter it anyway, e.g. root) | red on the old code with the exact reported error (`502 fork/exec .../claude: permission denied`), green with the fix |
| Ablation (product files reverted to parent `d8b3749e`, test kept) | red again, same error |
| `go test -tags nogui -timeout 25m ./internal/gateway/...` | ok (595.9s, all green; `TestCodexPoolSaysTheClientsVersion` green in this run) |
| `go test -tags nogui -race` (workdir/runs targeted set) | ok |
| `go build ./...`, `go vet -tags nogui ./internal/gateway/`, `gofmt -l` (touched files) | clean |
| Pre-existing, unrelated: `TestHostToldTheGatewayAddress` (plugin), `TestMothX` (agent), `TestEveryRouteHasACommandOrIsNamed` (cli) | red before and after this patch, untouched by it |

Sibling check: `clientWorkDir` has exactly one caller (`startRun`), and every other `cmd.Dir` in the tree is set to a folder magpie makes for itself, so no other site can hit this.

**AI use.** Written by GLM-5.3-Flash (ZCode), authored and verified by ggbdpq.

<details>
<summary>Patch (git am format) -- SHA-256 (first 16): <code>1b6885ff96bdca93</code></summary>

```patch
From cbd25dc21ca5ab5c6452180a29e7a169c860b52a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 06:04:51 +0800
Subject: [PATCH] claude: a folder the caller names that magpie may not enter
 is not worked in

Since 680b505 a run works in the folder the caller names, which
clientWorkDir checked only with os.Stat: that says the folder exists and
is a folder here, not that magpie may enter it. In a container it may
not: the caller's /root is 0700 root:root and magpie runs as a nonroot
user, and the run's chdir there failed before Claude Code started, which
Go reported as a permission denied on the Claude Code binary itself --
"fork/exec .../claude: permission denied" -- and the binary was fine
(#4314). Every request naming such a folder failed; before 680b505 the
same request worked, in magpie's own folder.

clientWorkDir now asks the kernel whether the folder may be entered
(access's leave, the one chdir asks) and says no folder when it may not,
so the run works in magpie's own folder as of one the caller names
elsewhere, and is told its environment is where its tools run. Windows
keeps the folder as before: the access bits Go reports there are not the
ones a run asks for.

Fixes #4314

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_subscription.go       | 11 +++++++
 .../gateway/claude_workdir_enter_other.go     | 10 ++++++
 .../gateway/claude_workdir_enter_windows.go   |  5 +++
 internal/gateway/claude_workdir_test.go       | 31 +++++++++++++++++++
 4 files changed, 57 insertions(+)
 create mode 100644 internal/gateway/claude_workdir_enter_other.go
 create mode 100644 internal/gateway/claude_workdir_enter_windows.go

diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 6004cebbc..316177920 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -528,6 +528,17 @@ func clientWorkDir(req *Request) string {
 		// to the caller's tools (#4449)
 		return ""
 	}
+	if !canEnter(dir) {
+		// a folder here that magpie may not enter (a container's /root,
+		// 0700 root:root, while magpie runs as a nonroot user) is not
+		// worked in: os.Stat only says it is one here, and a run there
+		// failed to start, its chdir reported as a permission denied on
+		// the Claude Code binary itself, which the binary was not. The
+		// run works in magpie's folder, told the caller's (envElsewhere)
+		// (#4314)
+		log.Printf("claude: %s is a folder magpie may not enter, working in its own instead", dir)
+		return ""
+	}
 	return dir
 }
 
diff --git a/internal/gateway/claude_workdir_enter_other.go b/internal/gateway/claude_workdir_enter_other.go
new file mode 100644
index 000000000..55e856f83
--- /dev/null
+++ b/internal/gateway/claude_workdir_enter_other.go
@@ -0,0 +1,10 @@
+//go:build !windows
+
+package gateway
+
+import "syscall"
+
+// canEnter says the folder is one magpie's process may enter, as a run
+// working there would have to (chdir asks the same leave as access does;
+// 0o1 is X_OK, which syscall has no name for on darwin).
+func canEnter(dir string) bool { return syscall.Access(dir, 0o1) == nil }
diff --git a/internal/gateway/claude_workdir_enter_windows.go b/internal/gateway/claude_workdir_enter_windows.go
new file mode 100644
index 000000000..30cb436e4
--- /dev/null
+++ b/internal/gateway/claude_workdir_enter_windows.go
@@ -0,0 +1,5 @@
+package gateway
+
+// canEnter is true on Windows: the folder is the caller's own to enter,
+// and the access bits Go reports there are not the ones a run asks for.
+func canEnter(string) bool { return true }
diff --git a/internal/gateway/claude_workdir_test.go b/internal/gateway/claude_workdir_test.go
index 114c8601f..424346afe 100644
--- a/internal/gateway/claude_workdir_test.go
+++ b/internal/gateway/claude_workdir_test.go
@@ -241,6 +241,37 @@ func TestClaudeCallersWorkDirElsewhereIsNotUsed(t *testing.T) {
 	}
 }
 
+// A folder the caller names that is here but that magpie may not enter
+// (a container's /root: 0700 root:root, with magpie running as a nonroot
+// user) is not worked in: os.Stat only says it is a folder here, and a
+// run there failed to start, its chdir reported as a permission denied on
+// the Claude Code binary itself. It works in magpie's own folder, told
+// the caller's environment is where its tools run (#4314).
+func TestClaudeCallersWorkDirItCannotEnterIsNotUsed(t *testing.T) {
+	var locked string
+	dirs, work, _, _, told := claudeWorkDirsTold(t, nil, func(home string) string {
+		locked = filepath.Join(home, "locked")
+		if err := os.MkdirAll(locked, 0o700); err != nil {
+			t.Fatal(err)
+		}
+		if err := os.Chmod(locked, 0); err != nil {
+			t.Fatal(err)
+		}
+		if f, err := os.OpenFile(locked, os.O_RDONLY, 0); err == nil {
+			f.Close()
+			t.Skip("the test may enter a folder with no access bits (root)")
+		}
+		return "You are a coding agent.\n - Primary working directory: " + locked
+	})
+	t.Cleanup(func() { os.Chmod(locked, 0o700) })
+	if len(dirs) != 2 || dirs[0] != work || dirs[1] != work {
+		t.Fatalf("working directories %q, want magpie's %s: a folder it may not enter was worked in", dirs, work)
+	}
+	if got := strings.Count(told, "every tool runs in"); got != 2 {
+		t.Fatalf("told the environment is elsewhere in %d of 2 runs, want 2: %s", got, told)
+	}
+}
+
 func btoi(b bool) int {
 	if b {
 		return 1
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/4314-workdir-permission (head cbd25dc21ca5ab5c6452180a29e7a169c860b52a)

Apply with `git am <the patch above>`.
