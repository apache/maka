The spawned `claude` of the interactive Claude mode can block on Claude Code's Bypass Permissions disclaimer - "❯ No, exit / Yes, I accept / Enter to confirm" - with no one there to answer it: each run sat on the dialog for 45s (`ReadyWait`), ended, and the next run asked again (the app.log here: `claude: Claude Code showed no prompt in 45s: ───── WARNING: Claude Code running in Bypass Permissions mode … ❯ No, exit  Yes, I accept   Enter to confirm · Esc to cancel`, pids dying in a loop until magpie fell back to `claude -p`).

**When it shows**: the run is in Bypass Permissions mode - the flag is on the bridge's own `-p` arguments, a user's `claude` may be a wrapper that adds it (the reporter's `~/.local/bin/claude`), or the account's default mode may be it - and no settings source the run reads has `skipDangerousModePermissionPrompt` (Claude Code 2.1.295 records the acceptance there itself once it is given, and the next run shows none of it).

**Fix**: the helper answers the disclaimer as it answers the trust question, where `MAGPIE_CLAUDE_TUI_TRUST=1` says the folder or config directory is magpie's: the same ↓ until "Yes, I accept" is the last choice drawn after ❯, then Enter once it has stayed so for 300ms (`trustSettle`), under the same three-answers cap; the disclaimer pairs the same "No, exit", and a key sent as it is first drawn is lost the same way. Where `TrustEnv` isn't set - the account Claude Code is signed in to, in a caller's folder - the disclaimer is its user's to answer: the run ends at once saying so, not after 45s. A disclaimer left unanswered at a run's deadline is named as such ("asked to accept running in Bypass Permissions mode, not answered in the …"), never "showed no prompt".

Two notes beside it: the answering is keys in the helper's own pseudo-terminal, so it does not depend on Bun loading the tap (`BUN_OPTIONS` carries only the reply streaming, tap.go) - a claude that isn't Bun gets the dialog answered all the same, its replies then told whole; and it stacks with the flag settings every spawn passes (#4928) - those carry `disableDeepLinkRegistration` alone, nothing that hides this disclaimer, and settings and keys are different layers.

**Verification** (base `c3593dc49`, head `618c4826c`):

| Check | Result |
| --- | --- |
| Red without the fix (the two product files reverted to base, tests kept) | 3 FAIL: `TestShimNeverPrints` and `TestShimAcceptsBypassDisclaimer` sat 30s with no end and no init; the deadline one named it the way the log here does: `stderr "claude-tui: Claude Code showed no prompt in the 3s its caller waits for it: ───── WARNING: Claude Code running in Bypass Permissions mode In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands. ❯ No, exit Yes, I accept Enter to confirm · Esc to cancel"` |
| Green with the fix (the three bypass tests) | `ok` 6.6s |
| Package full, `-race -tags nogui` | `ok` 69.5s |
| Repository full, `-tags nogui` | 82 packages `ok`; 2 failures that fail on the base commit too, not this diff: `TestMothX` (internal/agent), `TestEveryRouteHasACommandOrIsNamed` (internal/cli) |
| `gofmt -l` on the changed files; `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean; clean |
| `go build ./...`, `GOOS=linux go build -tags nogui ./...`, `GOOS=windows go build ./...` | ok, ok, ok |

**Not verified**: a real Claude Code's disclaimer interaction (the fake draws 2.1.295's screen as the log in this issue quotes it, taken verbatim); the Windows pseudo-console and WSL transports with it; a run shown the trust question and then the disclaimer (both go through the same case, the answer cap shared).

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: claudetui: the Bypass Permissions disclaimer is answered as the trust question is (#5042, luzhuang) - git am applies it as is; SHA-256 first 16: 6756e6b1bd8829ee</summary>

```patch
From 618c4826c1f9056ea7fe382d4f467fe6269bef3d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 20:09:20 +0800
Subject: [PATCH] claudetui: the Bypass Permissions disclaimer is answered as
 the trust question is (#5042, luzhuang)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A claude magpie spawns runs --dangerously-skip-permissions: the flag is
on the bridge's own arguments, a user's claude may be a wrapper that
adds it, and an account's default mode may be Bypass Permissions. Where
no settings source the run reads has skipDangerousModePermissionPrompt,
Claude Code 2.1.295 blocks on its disclaimer — "❯ No, exit / Yes, I
accept, Enter to confirm" — and no one was there to answer it: each run
sat on the dialog for 45s (ReadyWait), ended, and the next run asked
again, so interactive requests failed in a loop (502 or a hung restart)
until magpie fell back to claude -p.

- the helper tells the disclaimer yes where TrustEnv says so, with the
  same ↓-until-"Yes"-then-Enter the trust question gets (its "No, exit"
  pairs the same, and a key sent as it is first drawn is lost the same
  way); Claude Code records the acceptance itself, and the next run is
  shown none of it.
- where TrustEnv isn't set — the account Claude Code is signed in to, in
  a caller's folder — the disclaimer is the user's to answer: the run
  ends at once saying so, not after 45s.
- a disclaimer left unanswered at a run's deadline is named as such
  ("asked to accept running in Bypass Permissions mode, not answered"),
  never "showed no prompt".

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudetui/command.go  |  4 +-
 internal/claudetui/tui.go      | 19 ++++++++-
 internal/claudetui/tui_test.go | 73 ++++++++++++++++++++++++++++++++++
 3 files changed, 93 insertions(+), 3 deletions(-)

diff --git a/internal/claudetui/command.go b/internal/claudetui/command.go
index 7ca70c5e9..c3220e381 100644
--- a/internal/claudetui/command.go
+++ b/internal/claudetui/command.go
@@ -7,7 +7,9 @@ const Command = "claude-tui-helper"
 // to trust the folder it runs in: the bridge sets it for magpie's own
 // folder, and for a caller's in an account folder of magpie's, whose
 // Claude Code no one else runs. Otherwise the question is the user's to
-// answer in their own Claude Code, and the run ends, saying so.
+// answer in their own Claude Code, and the run ends, saying so. The
+// Bypass Permissions disclaimer Claude Code asks over the mode its own
+// run was given is told yes the same way (#5042).
 const TrustEnv = "MAGPIE_CLAUDE_TUI_TRUST"
 
 // DeadlineEnv holds, in Unix milliseconds, when a one-off run's caller
diff --git a/internal/claudetui/tui.go b/internal/claudetui/tui.go
index d96403437..913f6e1b2 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -373,6 +373,9 @@ func (s *shim) lastScreen() string {
 var (
 	trustNo  = regexp.MustCompile(`❯\s*No,\s*exit`)
 	trustYes = regexp.MustCompile(`❯\s*Yes,\s*I trust`)
+	// the Bypass Permissions disclaimer's Yes (#5042): the disclaimer
+	// pairs the same "No, exit" with it as the trust question does
+	bypassYes = regexp.MustCompile(`❯\s*Yes,\s*I accept`)
 	// how long a Yes stays drawn before Enter is pressed on it
 	trustSettle = 300 * time.Millisecond
 )
@@ -434,7 +437,11 @@ var (
 const onboardTries = 3
 
 // ready waits for Claude Code's prompt. Asked whether to trust the folder
-// it runs in, it is told yes, as a person would, when TrustEnv says so.
+// it runs in, it is told yes, as a person would, when TrustEnv says so,
+// and so is the Bypass Permissions disclaimer asked where the claude
+// magpie spawns runs with --dangerously-skip-permissions (a wrapper's own
+// flag, or the account's default mode, #5042); in the user's own Claude
+// Code both are its user's to answer, and the run ends, saying so.
 func (s *shim) ready() error {
 	deadline := time.After(readyWait)
 	answered := 0
@@ -453,6 +460,7 @@ func (s *shim) ready() error {
 		folder = "the folder it runs in"
 	}
 	asking := "asked whether to trust " + folder + ", not answered"
+	bypassAsking := "asked to accept running in Bypass Permissions mode, not answered"
 	onboard := func(screen, key string) error {
 		if shownAt[screen].IsZero() {
 			shownAt[screen] = time.Now()
@@ -475,11 +483,15 @@ func (s *shim) ready() error {
 		doing := "showed no prompt"
 		if strings.Contains(p, "trust this folder") {
 			doing = asking
+		} else if strings.Contains(words, "Bypass Permissions mode") {
+			doing = bypassAsking
 		}
 		s.doing.Store(doing)
 		switch {
 		case strings.Contains(p, "trust this folder") && os.Getenv(TrustEnv) != "1":
 			return errUntrusted
+		case strings.Contains(words, "Bypass Permissions mode") && os.Getenv(TrustEnv) != "1":
+			return fmt.Errorf("Claude Code's interactive mode runs in Bypass Permissions mode and asks to accept it, which only its user answers: %s", s.lastScreen())
 		case signIn.MatchString(p):
 			return fmt.Errorf("Claude Code's interactive mode asks to sign in: %s", s.lastScreen())
 		case firstRun.MatchString(words):
@@ -490,12 +502,15 @@ func (s *shim) ready() error {
 			if err := onboard("terminal", "\x1b"); err != nil {
 				return err
 			}
-		case strings.Contains(p, "trust this folder") && answered < 3:
+		case (strings.Contains(p, "trust this folder") || strings.Contains(words, "Bypass Permissions mode")) && answered < 3:
 			// the choice is the last one drawn after ❯, "No, exit" at
 			// first. A key sent as the question is first drawn can be lost
 			// to its being drawn again on No, so Enter goes only to a Yes
 			// drawn trustSettle ago and not drawn over since.
 			no, yes := lastAt(trustNo, p), lastAt(trustYes, p)
+			if b := lastAt(bypassYes, p); b > yes {
+				yes = b
+			}
 			switch {
 			case yes > no:
 				if yesAt.IsZero() {
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index 80395cdfb..3c51c2a39 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -87,6 +87,57 @@ func fakeTrust(r *bufio.Reader, always bool) {
 	}
 }
 
+// fakeBypass shows Claude Code's Bypass Permissions disclaimer, drawn
+// where it runs with --dangerously-skip-permissions and its config
+// folder hasn't accepted it once (2.1.295): "No, exit" chosen, and drawn
+// again on No once it listens, the keys before that lost. Enter on No
+// exits. With always, it never listens, as a question whose answer never
+// goes through.
+func fakeBypass(r *bufio.Reader, always bool) {
+	var mu sync.Mutex
+	yes, deaf := false, true
+	draw := func() {
+		marks := map[bool]string{true: "\x1b[38;2;177;185;249m❯\x1b[39m", false: " "}
+		fmt.Printf("\x1b[2J\x1b[H───── WARNING: Claude Code running in Bypass\x1b[1CPermissions\x1b[1Cmode\r\n\r\nIn\x1b[1CBypass\x1b[1CPermissions\x1b[1Cmode,\x1b[1CClaude\x1b[1CCode\x1b[1Cwill\x1b[1Cnot\x1b[1Cask\r\nfor\x1b[1Cyour\x1b[1Capproval\x1b[1Cbefore\x1b[1Crunning\x1b[1Cpotentially\r\ndangerous\x1b[1Ccommands.\r\n\r\n\x1b[2G%s\x1b[4GNo,\x1b[8Gexit\r\n\x1b[2G%s\x1b[4GYes,\x1b[9GI\x1b[11Gaccept\r\n\r\n Enter to confirm · Esc to cancel\r\n", marks[!yes], marks[yes])
+	}
+	draw()
+	time.AfterFunc(150*time.Millisecond, func() {
+		if always {
+			return
+		}
+		mu.Lock()
+		defer mu.Unlock()
+		deaf, yes = false, false
+		draw()
+	})
+	for {
+		c, err := r.ReadByte()
+		if err != nil {
+			os.Exit(0)
+		}
+		if c == 0x1b {
+			seq := make([]byte, 2)
+			if _, err := io.ReadFull(r, seq); err != nil {
+				os.Exit(0)
+			}
+			c = seq[1]
+		}
+		mu.Lock()
+		switch {
+		case deaf:
+		case c == 'B' || c == 'A':
+			yes = c == 'B'
+			draw()
+		case c == '\r' && !yes:
+			os.Exit(1)
+		case c == '\r':
+			mu.Unlock()
+			return
+		}
+		mu.Unlock()
+	}
+}
+
 // fakeOnboard shows Claude Code 2.1.316's onboarding where its config
 // folder has none done (FAKE_ONBOARD set): the text style, the security
 // notes, and with "terminal" whether to set up the terminal. Each is
@@ -183,6 +234,9 @@ func fakeClaude(args []string) {
 	if v := os.Getenv("FAKE_TRUST"); v != "" {
 		fakeTrust(r, v == "deaf")
 	}
+	if v := os.Getenv("FAKE_BYPASS"); v != "" {
+		fakeBypass(r, v == "deaf")
+	}
 	// what it was started with, for the test to read
 	_ = os.WriteFile(filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "args"), []byte(strings.Join(args, "\n")), 0o600)
 	// FAKE_TAP: Bun loads the tap BUN_OPTIONS names, which says so, and
@@ -613,6 +667,9 @@ func TestShimNeverPrints(t *testing.T) {
 	}{
 		{"failed start", "something went wrong", []string{"FAKE_FAIL=1"}},
 		{"untrusted folder", "trust the folder", []string{"FAKE_TRUST=1"}},
+		// the disclaimer is the user's to accept in their own Claude Code
+		// (#5042), said at once, not waited out
+		{"bypass disclaimer left to the user", "asks to accept", []string{"FAKE_BYPASS=1"}},
 		// at once, not after readyWait: runEnds waits 30s (#4504)
 		{"asks to sign in", "sign", []string{"FAKE_LOGIN=1"}},
 		{"first-run screens it stays on", "first-run screens", []string{"FAKE_ONBOARD=stuck"}},
@@ -698,6 +755,9 @@ func TestShimEndsAtItsCallersDeadline(t *testing.T) {
 		// the question a saved account's reads waited out on (#4830,
 		// mydosu): said, with the folder, never "showed no prompt"
 		{"trust unanswered", `{"type":"user","message":{"role":"user","content":"hello"}}`, "asked whether to trust " + wd + ", not answered in the", "trust this folder", []string{"FAKE_TRUST=deaf", TrustEnv + "=1"}},
+		// the disclaimer the spawned claude sat on for 45s, then died in a
+		// loop of them (#5042): said, never "showed no prompt"
+		{"bypass disclaimer unanswered", `{"type":"user","message":{"role":"user","content":"hello"}}`, "asked to accept running in Bypass Permissions mode, not answered in the", "Bypass Permissions mode", []string{"FAKE_BYPASS=deaf", TrustEnv + "=1"}},
 		// FAKE_USAGE names no panel: nothing is drawn for /usage
 		{"no /usage panel", `{"type":"command","command":"/usage"}`, "hadn't drawn /usage's panel in the", "", []string{"FAKE_USAGE=" + filepath.Join(t.TempDir(), "none")}},
 		// the banner drawn again and no panel after it: never told as one
@@ -730,6 +790,19 @@ func TestShimTrustsWhenTold(t *testing.T) {
 	}
 }
 
+// The Bypass Permissions disclaimer, drawn where the claude magpie spawns
+// runs with --dangerously-skip-permissions (the user's claude may be a
+// wrapper that adds it, #5042) and the config folder hasn't accepted it
+// once, is answered as the trust question is: in a folder of magpie's, or
+// an account folder of magpie's, told yes. Claude Code records the
+// acceptance itself, and the next run is shown none of it.
+func TestShimAcceptsBypassDisclaimer(t *testing.T) {
+	out := runShim(t, []string{"FAKE_BYPASS=1", TrustEnv + "=1"}, append([]string{fakePath(t)}, pArgs...), []string{"hello"}, 3)
+	if out[0]["subtype"] != "init" || out[1]["type"] != "assistant" {
+		t.Fatalf("got %v, want an interactive turn", out)
+	}
+}
+
 func TestPasteable(t *testing.T) {
 	for _, c := range []struct {
 		in   string
-- 
2.50.1 (Apple Git-155)


```

</details>

**Branch with the commit**: [fix/5042-bypass-dialog](https://github.com/ggbdpq/magpie/tree/fix/5042-bypass-dialog) (head `618c4826c1f9056ea7fe382d4f467fe6269bef3d`).
