Refreshed, not redesigned — rebased onto current `upstream/main` (`10c331531`, 569 commits past `0d99261dc`, the branch's original base). The cherry-pick landed clean on the same seam: `clientWorkDir` (`internal/gateway/claude_subscription.go:538`) kept its body through upstream's rework of this file (only its doc grew, to name `clientNamedWorkPlace`), the `canEnter` probe still sits inside it before any directory is returned, and upstream's trust check (`b.untrustedHere`) still composes after it at the call layer — the same shape this patch was written against. Upstream has not taken the fix (`git log -S TestClaudeCallersWorkDirItCannotEnterIsNotUsed` empty; no `canEnter` on main), and `e7980ed95`'s changes to the same file (the streaming-branch region) don't touch these hunks.

Verification on the new base (`10c331531` + this commit; upstream has since advanced to `4ae833f84` — no commit on that range touches the patch's four files, checked again at post time):
| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run TestClaudeCallersWorkDirItCannotEnterIsNotUsed ./internal/gateway -v` | PASS (0.80s) — not SKIP: this host runs as a normal user, so the chmod-000 fixture exercises the guard |
| `go test -tags nogui -count=1 -run TestClaudeCallersWorkDir ./internal/gateway -v` | both tests PASS (`ItCannotEnterIsNotUsed`, `ElsewhereIsNotUsed`; 1.844s) |
| same set with `-race` | ok (3.242s) |
| `go test -tags nogui -count=1 ./internal/provider` | 205.1s, zero failures |
| `go test -tags nogui -count=1 -timeout 60m ./internal/gateway` | 993.3s, zero failures |
| `gofmt -l` on the four touched files; `go vet -tags nogui ./internal/gateway` | clean; clean |
| `GOOS=linux go build -tags nogui ./...`; `GOOS=windows` (+ windows `go vet`) | ok; ok; clean |

Ablation re-done on the new base, the mutation the logic hunk alone: the `canEnter` guard lifted out of `clientWorkDir` (11 lines, the `claude_workdir_enter_*` platform files untouched) → `TestClaudeCallersWorkDirItCannotEnterIsNotUsed` red with the reported signature verbatim (`fork/exec …/claude: permission denied` on a run that tried to work in the 000 folder) → restored → the whole `TestClaudeCallersWorkDir` set green (1.950s).

**Siblings** (re-checked on the new base): `canEnter` has the one call site (the guard at line 553) and the two platform definitions; `clientWorkDir` has the one reader (line 1044), which the guard sits ahead of, so every path that returns a directory passes the probe. When the guard says no, the run takes magpie's own folder (`claudeWorkDir`) and the caller's named directory is still told as the environment (`req.envElsewhere`, line 1053) — the fallback this fix leans on is unchanged upstream. The `claude_workdir_test.go` and both platform files carried zero drift since the original base, so the diff is byte-identical to the November 4/9 patches apart from hunk line numbers.

**Not verified**: a real Docker container running magpie as nonroot against a root-owned workdir (the reporter's environment; the chmod-000 fixture is the same shape at unit scale) — NOT-RUNNABLE here as before.

The patch below `git am`s clean onto a tree at `10c331531`.

**Patch**: <details><summary>patch: claude: a folder the caller names that magpie may not enter is not worked in — git am applies it as is; SHA-256 first 16: 0b179a06d0a2906f</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
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
index 2e6814a79..071d7416e 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -550,6 +550,17 @@ func clientWorkDir(req *Request) string {
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
index b24f47cbd..966917d8a 100644
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


````

</details>

Branch with the commit: [fix/4314-workdir-permission](https://github.com/ggbdpq/magpie/tree/fix/4314-workdir-permission) (head `5faa03e64b1ef838469b7ac422feb9234858a21c`; author `ggbdpq` unchanged from the original patch).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`. Credit for the report stays with @Cotory.
