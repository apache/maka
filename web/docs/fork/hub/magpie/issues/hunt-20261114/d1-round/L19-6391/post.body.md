The spare comes back from the switch with the sign-in it was last refreshed to, and is usable the next time the account it replaced runs out.

**What happens** (the reporter's timeline, on current main): A is spent, magpie hands B to Claude Code ("signed it in to B"), and a run or usage read behind the hand-over makes B's config directory again from `logins.json` (#4750 — `claudeSavedDir` does not refuse a Held account), holding B's pre-hand-over sign-in. Claude Code serves on B for the hour and refreshes its own copy. When A has room again, the switch back saves that refreshed copy as B's in `logins.json` (`switchSavedLogin` upserts the live login) but forgets only the directory of the account switched *in* — B's stale directory stays. The next run on B then goes through `claudeSavedDir` → `syncClaudeDir` → `takeClaudeDir`, which takes the directory's sign-in whenever its tokens differ from the saved ones, with no regard for which is newer (`internal/provider/claude_dirs.go`, `takeClaudeDir`): the spent pre-hand-over copy replaces the fresh one in `logins.json`. Claude Code in the directory refreshes the spent token, is refused, empties the sign-in, and the next sync marks B refused — `502 Claude Code could not authenticate this account` from then on, exactly as reported.

**Reproduction**: `TestClaudeDirOlderSignInKeepsTheSavedOne` (new) sets a saved account up with a fresh sign-in in `logins.json` and the older pre-hand-over one in its directory, as the switch back leaves them, and calls `claudeSavedDir`. Without the fix, `logins.json` takes the directory's older sign-in and the directory keeps it; with the fix, `logins.json` is unchanged and the directory is made again from the saved sign-in.

**Root cause**: `takeClaudeDir` treats "tokens differ" as "the directory is newer", which only holds when the directory is the holder Claude Code has been running on. When the directory was made again behind a switch, the opposite is true: the saved login is the copy the switch back saved from Claude Code's own refreshed sign-in, and the directory's is spent. Taking it is the same class as the import bug #4532 already fixed by newer-wins ("a Claude import never writes an older sign-in over a newer one").

**Fix**: in `syncClaudeDir`, a directory sign-in whose `expiresAt` is older than the saved login's is not taken; `has=false` makes `claudeSavedDir` clear what was there and write the saved sign-in into the directory, as it already does when the directory holds none. The account comes back usable whichever way the directory came to hold an older copy. Clearing first also removes a stale per-directory keychain item, which would otherwise shadow the fresh file on a Mac (`readClaudeDir` prefers the item).

---
**Source**: reported in #6391 (Crosery, production logs and file dates); mechanism confirmed by reading current main and by the test.

**Red without the fix** (claude_dirs.go ablated back to the parent `e730a14dc`, test kept):
```
--- FAIL: TestClaudeDirOlderSignInKeepsTheSavedOne (0.08s)
    claude_dir_older_test.go:79: logins.json took the directory's tok-max@x.com over the saved tok-max-fresh
    claude_dir_older_test.go:84: the directory runs on tok-max@x.com, not the saved sign-in
```
The same red on the parent commit `a8fa771a` first showed it. With the fix: `ok`.

**Siblings**: `takeClaudeDir` has one caller (`syncClaudeDir`); its three callers keep their semantics with `has=false` — `syncSavedClaude` writes nothing (`changed=false`), `claudeSavedDir` makes the directory from the saved sign-in (the heal), `switchSavedLogin` discards `has` and switches in the fresh saved target. The Codex face has no same-class path: a Codex account held in another of its folders is refused at the switch (`codexHeldIn`), so a spent copy is never taken over a fresh one. Imports already do newer-wins by `expiresAt` (`claudeNewerKept`, #4532); this guard follows that precedent. #4750 (the directory made again while the account is live) stays open and composes with this — this patch stops the loss either way.

**When the read fails**: an unreadable directory sign-in (`readClaudeDir` ok=false) is treated as no sign-in, as before: the directory is made again from `logins.json`, which holds the freshest copy. Only the parsed-but-older case is new.

| Check | Result |
|---|---|
| `go test ./internal/provider -run TestClaudeDirOlderSignInKeepsTheSavedOne -tags nogui`, ablated | FAIL, both assertions, output above |
| same, fix restored | ok 1.171s |
| `go test ./internal/provider -tags nogui -count=1` | one failure, TestResolveVia — fails the same on the parent commit alone (`Get "https://gw.invalid:58207/v1": EOF`, this machine's proxy); the new test passes |
| targeted and directory/switch-adjacent tests, `-race` | ok 2.958s |
| `gofmt -l` / `go vet -tags nogui` | clean / ok |
| `GOOS=linux, windows, darwin go build -tags nogui` | all ok |

**Not verified**: a real two-account gateway hand-over with Claude Code 2.1.322 on Debian (the reporter's environment — no real accounts here); the keychain-shadow half of the fix on a real macOS keychain (tests run with the keychain off, the item-clearing call is the existing `clearClaudeDir`); a directory whose `expiresAt` equals the saved one's while tokens differ keeps the current take behavior.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: claude: a saved account's directory sign-in older than the saved one is not taken over it (#6391) — git am applies it as is; SHA-256 first 16: 853983c6d927ffa1</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 14 Nov 2026 08:01:49 +0800
Subject: [PATCH] claude: a saved account's directory sign-in older than the
 saved one is not taken over it (#6391)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A spare handed to Claude Code comes back from the switch signed out
when its own config directory was made again meanwhile (#4750): the
directory keeps the sign-in from before the hand-over, Claude Code
refreshes its own copy while it serves on the account, and the switch
back saves that as the account's. The next run on the account then took
the directory's older sign-in over the fresh saved one — takeClaudeDir
takes whatever tokens differ — so the spent copy replaced the fresh one
in logins.json, the refresh in the directory was refused and emptied,
and every request on the account failed till it is signed in again.

The directory's sign-in is now left to the saved one when it is older
(the later expiresAt is the newer, as the imports' newer-wins, #4532):
has=false has claudeSavedDir make the directory from the saved sign-in
again, so the account comes back usable whichever way the directory
came to hold an older copy. What was there is cleared first, so an
older keychain item cannot shadow the fresh file on a Mac.

Run (-tags nogui, GOCACHE private, parent e730a14dc):
- TestClaudeDirOlderSignInKeepsTheSavedOne: red with claude_dirs.go
  ablated back to the parent (test kept; the same red on the parent
  commit a8fa771a6 first showed it), green with the fix restored.
- go test ./internal/provider: one failure, TestResolveVia, failing the
  same on the parent commit alone (Get "https://gw.invalid:58207/v1":
  EOF, this machine's proxy); the new test passed in the full run.
- targeted and directory/switch-adjacent tests with -race: ok
- gofmt clean, go vet ok, GOOS linux/windows/darwin build ok

Generated-by: GLM-5.3-Flash (ZCode)
(#6391, ggbdpq)
---
 internal/provider/claude_dir_older_test.go | 86 ++++++++++++++++++++++
 internal/provider/claude_dirs.go           | 17 +++++
 2 files changed, 103 insertions(+)
 create mode 100644 internal/provider/claude_dir_older_test.go

diff --git a/internal/provider/claude_dir_older_test.go b/internal/provider/claude_dir_older_test.go
new file mode 100644
index 000000000..3134a4656
--- /dev/null
+++ b/internal/provider/claude_dir_older_test.go
@@ -0,0 +1,86 @@
+package provider
+
+// A spare handed to Claude Code comes back from the switch with the
+// sign-in it was last refreshed to (#6391, Crosery): the account's config
+// directory, made again behind the hand-over (#4750), keeps the sign-in
+// from before it, and Claude Code refreshes its own copy meanwhile. The
+// directory's older sign-in must not be taken over the saved one, or the
+// spent copy replaces the fresh one in logins.json and the next refresh in
+// the directory empties it, the account signed out.
+
+import (
+	"strings"
+	"testing"
+	"time"
+)
+
+func TestClaudeDirOlderSignInKeepsTheSavedOne(t *testing.T) {
+	claudeThree(t)
+	if err := SwitchLogin("claude", "team@x.com · Acme"); err != nil {
+		t.Fatal(err)
+	}
+	var maxUser string
+	for _, l := range readLogins() {
+		if strings.HasPrefix(l.User, "max@") {
+			maxUser = l.User
+		}
+	}
+	if maxUser == "" {
+		t.Fatal("no saved max account")
+	}
+	// max's directory, as a run queued behind the hand-over makes it
+	// (#4750): it holds the sign-in the account was saved with
+	if _, err := claudeSavedDir(maxUser); err != nil {
+		t.Fatal(err)
+	}
+	dir := claudeAccountDir(maxUser)
+	if c, ok := readClaudeDir(dir); !ok || c.OAuth.AccessToken != "tok-max@x.com" {
+		t.Fatalf("the directory does not hold the saved sign-in: ok=%v, %s", ok, c.OAuth.AccessToken)
+	}
+	// the hand-over makes the account Claude Code's own, Claude Code
+	// refreshes its copy over the hour it serves, and the switch back
+	// saves that as the account's: logins.json holds the fresh sign-in,
+	// the directory the one from before the hand-over
+	loginsMu.Lock()
+	ls := readLogins()
+	for i := range ls {
+		if strings.HasPrefix(ls[i].User, "max@") {
+			c, ok := parseClaudeCredentials(ls[i].Auth)
+			if !ok {
+				t.Fatal("max's saved sign-in doesn't parse")
+			}
+			c.OAuth.AccessToken = "tok-max-fresh"
+			c.OAuth.RefreshToken = "r-max-fresh"
+			c.OAuth.ExpiresAt = time.Now().Add(2 * time.Hour).UnixMilli()
+			b, err := c.marshal()
+			if err != nil {
+				t.Fatal(err)
+			}
+			ls[i].Auth = b
+		}
+	}
+	if err := writeLogins(ls); err != nil {
+		t.Fatal(err)
+	}
+	loginsMu.Unlock()
+	forgetAccountCaches()
+
+	// the next run on the account: its directory is made again from the
+	// saved sign-in, not the directory's older one taken over it
+	if _, err := claudeSavedDir(maxUser); err != nil {
+		t.Fatal(err)
+	}
+	loginsMu.Lock()
+	defer loginsMu.Unlock()
+	for _, l := range readLogins() {
+		if strings.HasPrefix(l.User, "max@") {
+			c, _ := parseClaudeCredentials(l.Auth)
+			if c.OAuth.AccessToken != "tok-max-fresh" {
+				t.Errorf("logins.json took the directory's %s over the saved %s", c.OAuth.AccessToken, "tok-max-fresh")
+			}
+		}
+	}
+	if c, ok := readClaudeDir(dir); !ok || c.OAuth.AccessToken != "tok-max-fresh" {
+		t.Errorf("the directory runs on %s, not the saved sign-in", c.OAuth.AccessToken)
+	}
+}
diff --git a/internal/provider/claude_dirs.go b/internal/provider/claude_dirs.go
index c9b67e28b..07da57b75 100644
--- a/internal/provider/claude_dirs.go
+++ b/internal/provider/claude_dirs.go
@@ -294,6 +294,12 @@ func claudeSavedDir(user string) (string, error) {
 	if err := os.MkdirAll(dir, 0o700); err != nil {
 		return "", err
 	}
+	// the sign-in that was there is out first, so the one the saved login
+	// has is the directory's only holder: an older one left in the
+	// directory's keychain item would shadow the fresh file on a Mac, and
+	// be read back over it the next look. Nothing there, this removes
+	// nothing.
+	clearClaudeDir(dir)
 	if err := writePrivate(filepath.Join(dir, ".credentials.json"), append(b, '\n')); err != nil {
 		return "", err
 	}
@@ -429,6 +435,17 @@ func syncClaudeDir(l *savedLogin) (has, changed bool, err error) {
 	c, ok := readClaudeDir(claudeAccountDir(l.User))
 	switch {
 	case ok:
+		// a directory sign-in older than the saved one (#6391): the
+		// directory was made again behind a switch (#4750) and the holder
+		// the agent itself runs on refreshed meanwhile, so the directory's
+		// is spent. Taking it would replace the fresh sign-in with the
+		// spent one, and the next refresh in the directory would empty it,
+		// the account signed out. has=false has claudeSavedDir make the
+		// directory from the saved one instead, as when it holds none.
+		if old, ook := parseClaudeCredentials(l.Auth); ook && old.OAuth.ExpiresAt > 0 &&
+			c.OAuth.ExpiresAt > 0 && c.OAuth.ExpiresAt < old.OAuth.ExpiresAt {
+			return false, false, nil
+		}
 		changed, err = takeClaudeDir(l, c)
 		return true, changed, err
 	case c.cleared():
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt-20261114-d1-6391](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-6391) (head `f05bac995…`).
