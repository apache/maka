Upstream's #4532 work (`403323af7`) landed the cross-process run marks beside a saved account's directory and made `switchSavedLogin` wait on them — but `ForgetLogin` still removed the directory with no look at those marks, which is the removal half of this report: with another magpie process running in the account's directory (a /usage, a warm-up, a keep-alive), `magpie accounts forget claude <account>` took the directory from under that run, and the switch it does first only waits on the *target* account's runs, so it handed nothing over while the removed account's run may still have refreshed its sign-in there.

**The fix** (`internal/provider/logins.go`): `ForgetLogin` for claude now takes the account's in-process run mutex and waits on every other process's run mark up to `claudeRunWait` before it switches away or removes anything, refusing with `errClaudeRunning` past the wait — the same shape `switchSavedLogin` has had since #4532. Nothing is removed under a run, and the saved sign-in stays.

**Siblings** (`forgetClaudeDir` callers, all checked): `forgetLogin`'s removal — this patch; the switch hand-over's removal — runs behind `switchSavedLogin`'s own wait (`403323af7`); a fresh sign-in's replacement of an older saved directory (`signin.go`) — rebuilds a directory at once, left as it is.

**When the read fails**: unchanged — `waitClaudeRuns` frees a stale mark file and goes on, and a file system without locks waits on nothing (the #4532 conventions, reused as they are).

**Red without the fix** (base `a8fa771a6`): new `TestClaudeForgetRefusedWhileAnotherMagpieRunsTheFolder` — with a held run mark, the forget went through (`nil`) and removed the directory; with the fix it is refused with `errClaudeRunning`, the directory and the saved sign-in kept. Ablation (product hunk reverted, test kept) fails the same way.

**Verification**: `internal/provider` in full — the only red is the pre-existing `TestResolveVia` (gw.invalid EOF), which fails the same way on the base commit without this change; `-race` on the lock-test family: ok; `go vet`, `gofmt`: clean; `GOOS` linux/darwin/windows `nogui` builds: ok; `git am` of the patch on a clean `upstream/main` replays a byte-identical tree.

**Not verified**: a real two-process run across two magpie instances (the held-lock fixture is the repo's own convention for another process's run, from #4532's tests); Windows.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt-20261114-d1-3254](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-3254) (head `89a4f11d95bda3e9`).

**Patch**: <details><summary>patch: claude: a forget waits for runs in the account's directory (#3254) — git am applies it as is; SHA-256 first 16: b14aeb1bb6b32591</summary>

````diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 14 Nov 2026 07:50:48 +0800
Subject: [PATCH] claude: a forget waits for runs in the account's directory
 (#3254)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

switchSavedLogin waits on the run marks another magpie's process leaves
beside a saved account's directory (#4532), but ForgetLogin removed the
directory with no look at them: another process's run in it (a /usage, a
warm-up, a keep-alive) had its directory taken from under it, and the
switch ForgetLogin does first handed nothing over — the removed
account's run may still refresh its sign-in there.

ForgetLogin (claude) now takes the account's in-process run mutex and
waits on every other process's run mark up to claudeRunWait, refusing
with errClaudeRunning past it, before it switches away or removes
anything: nothing is removed under a run, and the saved sign-in stays.

Left: forgetClaudeDir's two other callers keep their shape — a fresh
sign-in's replacement of an older saved directory (signin.go) rebuilds
one at once, and the switch hand-over's removal runs behind
switchSavedLogin's own wait.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/claude_lock_test.go | 48 +++++++++++++++++++++++++++
 internal/provider/logins.go           | 12 +++++++
 2 files changed, 60 insertions(+)

diff --git a/internal/provider/claude_lock_test.go b/internal/provider/claude_lock_test.go
index 0b0df3763..880c21b11 100644
--- a/internal/provider/claude_lock_test.go
+++ b/internal/provider/claude_lock_test.go
@@ -269,3 +269,51 @@ func TestSavedClaudeRunHoldsItsLock(t *testing.T) {
 		t.Fatalf("run locks left behind: %v", m)
 	}
 }
+
+// Forgetting an account whose directory a run of another magpie process
+// holds is refused (#3254): the folder and the saved sign-in stay. A lock
+// file whose run ended holds nothing, and the forget goes on.
+func TestClaudeForgetRefusedWhileAnotherMagpieRunsTheFolder(t *testing.T) {
+	t.Run("held", func(t *testing.T) {
+		claudeThree(t)
+		if err := os.MkdirAll(claudeAccountDir("max@x.com"), 0o700); err != nil {
+			t.Fatal(err)
+		}
+		w := claudeRunWait
+		claudeRunWait = 300 * time.Millisecond
+		t.Cleanup(func() { claudeRunWait = w })
+		unlock, held := filelock.Lock(claudeAccountDir("max@x.com")+".run-99999-1.lock", time.Second)
+		if !held {
+			t.Fatal("not held")
+		}
+		defer unlock()
+		if err := ForgetLogin("claude", "max@x.com"); !errors.Is(err, errClaudeRunning) {
+			t.Fatalf("got %v", err)
+		}
+		if _, err := os.Stat(claudeAccountDir("max@x.com")); err != nil {
+			t.Fatalf("the account's directory was removed under the run: %v", err)
+		}
+		if a := savedAuth(t, "max@x.com"); !strings.Contains(a, "r-max") {
+			t.Fatalf("the saved sign-in went with the refused forget: %q", a)
+		}
+	})
+	t.Run("ended", func(t *testing.T) {
+		claudeThree(t)
+		if err := os.MkdirAll(claudeAccountDir("max@x.com"), 0o700); err != nil {
+			t.Fatal(err)
+		}
+		mark := claudeAccountDir("max@x.com") + ".run-99999-1.lock"
+		if err := os.MkdirAll(filepath.Dir(mark), 0o700); err != nil {
+			t.Fatal(err)
+		}
+		if err := os.WriteFile(mark, nil, 0o600); err != nil {
+			t.Fatal(err)
+		}
+		if err := ForgetLogin("claude", "max@x.com"); err != nil {
+			t.Fatal(err)
+		}
+		if _, err := os.Stat(claudeAccountDir("max@x.com")); !os.IsNotExist(err) {
+			t.Fatalf("the forgotten account's directory kept: %v", err)
+		}
+	})
+}
diff --git a/internal/provider/logins.go b/internal/provider/logins.go
index 1fd95d1e0..233e199ae 100644
--- a/internal/provider/logins.go
+++ b/internal/provider/logins.go
@@ -1650,6 +1650,18 @@ func ForgetLogin(agent, user string) error {
 	if pp, ok := pluginOfAgent(agent); ok {
 		return forgetPluginLogin(pp, user)
 	}
+	if agent == "claude" {
+		// nor while a run is in the account's own directory: magpie's own
+		// (a /usage, a warm-up) ends first, and another magpie process's
+		// is refused past the wait (#4532's run marks) — the removal here
+		// would take the directory from under that run (#3254)
+		mu := claudeDirRun(user)
+		mu.Lock()
+		defer mu.Unlock()
+		if err := waitClaudeRuns(user); err != nil {
+			return err
+		}
+	}
 	switch agent {
 	case "copilot":
 		return forgetCopilotLogin(user)
-- 
2.50.1 (Apple Git-155)

````

</details>
