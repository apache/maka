Refresh of my patch above, not a redesign: the same commit rebased onto current `upstream/main` (`e6bf4adf1`) and the verification re-run — the branch had drifted ~1300 commits since its last rebase (November 6, onto `326e72f4c`). Main still ends such a refusal at `errUntrusted` without naming the folder (`internal/claudetui/tui.go`, the `ready()` case), `folder` is still computed right there (`os.Getwd()`, #4830), and no upstream commit touches the file or the bridge's consumer of the prefix (`claude_subscription.go` `saidOnEnd(claudetui.Untrusted)`) since — the diagnostic gap this patch closes is still the only one.

Unchanged, as before: the 502 retry loop itself is gone on main (`59fdab0af` runs the turn in magpie's own folder); what this patch fixes is the diagnostic half — every line of the rare surfaced refusal names the actual folder and the way out, in the same prefix the bridge reads, with no auto-trust added.

<details><summary>patch: claudetui: the trust refusal says which folder, and how to trust it (#4779) — git am applies it as is; SHA-256 first 16: e8adff2a70ff302e</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 05:54:49 +0800
Subject: [PATCH] claudetui: the trust refusal says which folder, and how to
 trust it (#4779)

WillSuo-Github: Codex through the bridge, Claude Code ended before it
answered magpie's initialize, asking whether to trust a folder the
message never named, and the turn came back a 502 a client asks again
and again. The 502 is gone since startTrusted (59fdab0af), the turn
running in magpie's own folder; the reason, though, in every log line
of the failure and in the rare run whose retry never comes (the
stderr's read missing its 2s window, the caller gone), still said "the
folder" only, though ready knew which (os.Getwd, #4830), and said
nothing the user could do.

The refusal now names the folder and the way out: run Claude Code once
in it as yourself and choose to trust it. What the bridge reads to
retry the turn (Untrusted, saidOnEnd) and what the Usage card reads
(claude-tui's first line) are unchanged, both matching the prefix.

Run (this tree, darwin/arm64):
- go test ./internal/claudetui is ok (61s), TestShimNamesTheUntrustedFolder
  new; at the parent's tui.go it is red, the stderr then naming no
  folder and saying nothing to do.
- go test -race -run 'TestShim|TestRun' ./internal/claudetui is ok.
- go test -tags nogui -timeout 25m ./internal/gateway/... is ok (632s).
- go vet ./internal/claudetui ./internal/gateway is clean, gofmt -l is
  clean, go build ./... is ok (the gui cgo and ld warnings are the
  parent's).

Fixes #4779

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudetui/tui.go      |  8 +++++---
 internal/claudetui/tui_test.go | 21 +++++++++++++++++++++
 2 files changed, 26 insertions(+), 3 deletions(-)

diff --git a/internal/claudetui/tui.go b/internal/claudetui/tui.go
index 93b038916..f5986b21f 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -503,8 +503,6 @@ func (s *shim) late(d time.Duration) string {
 	return fmt.Sprintf("Claude Code %s in the %s its caller waits for it: %s", doing, d.Round(100*time.Millisecond), s.lastScreen())
 }
 
-var errUntrusted = errors.New(Untrusted + ", which only its user answers")
-
 // signIn is what Claude Code's interactive mode shows where it is not
 // signed in, as -p may be (CLAUDE_CODE_OAUTH_TOKEN, a container whose
 // ~/.claude.json has no onboarding done): nothing the helper may answer.
@@ -590,7 +588,11 @@ func (s *shim) ready() error {
 		s.doing.Store(doing)
 		switch {
 		case strings.Contains(p, "trust this folder") && os.Getenv(TrustEnv) != "1":
-			return errUntrusted
+			// the folder named, or the user doesn't know what to trust,
+			// and the failure's log line says "the folder" only (#4779,
+			// WillSuo-Github). The prefix (Untrusted) is what the bridge
+			// reads to retry the turn in a folder of magpie's (startTrusted)
+			return fmt.Errorf("%s (%s), which only its user answers: run Claude Code once in it as yourself and choose to trust it", Untrusted, folder)
 		case strings.Contains(words, "Bypass Permissions mode") && os.Getenv(BypassEnv) != "1":
 			return fmt.Errorf("Claude Code's interactive mode runs in Bypass Permissions mode and asks to accept it, which only its user answers: %s", s.lastScreen())
 		case signIn.MatchString(p):
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index 650b35de5..7cc180775 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -884,6 +884,27 @@ func TestShimNeverPrints(t *testing.T) {
 	}
 }
 
+// A folder Claude Code asks whether to trust is one only its user
+// answers for, and the helper ends saying so: it said "the folder"
+// without saying which, so the user didn't know what to trust, and the
+// failure's log line named no directory either (#4779, WillSuo-Github).
+// The turn itself is answered in magpie's own folder since (startTrusted
+// in the gateway), so this message is for the logs, and for the rare run
+// whose retry never comes.
+func TestShimNamesTheUntrustedFolder(t *testing.T) {
+	wd, _ := os.Getwd()
+	out, stderr, err := runEnds(t, t.TempDir(), []string{"FAKE_TRUST=1"})
+	if err == nil || strings.Contains(out, "print mode") {
+		t.Fatalf("ended %v, wrote %q", err, out)
+	}
+	if !strings.Contains(stderr, "claude-tui: Claude Code asks whether to trust the folder (") || !strings.Contains(stderr, wd) || !strings.Contains(stderr, "run Claude Code once in it") {
+		t.Fatalf("stderr %q", stderr)
+	}
+	if strings.Contains(stderr, "-p") {
+		t.Fatalf("stderr %q", stderr)
+	}
+}
+
 // The first message waits for Claude Code to have listed the tools of
 // magpie's tool server, which it connects as its prompt shows: sent at
 // the prompt, it was answered without the agent's tools (MinhuWang on X,
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-4779`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4779) (head `7a83cc39d778d49ae2ea0df64ee48447bb6df7a4`), rebased onto current `upstream/main` (`e6bf4adf1`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (on `e6bf4adf1` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `go test ./internal/claudetui` (whole package) | ok (125s) |
| `TestShimNamesTheUntrustedFolder` | green with the patch; at the parent's two hunks (the `errUntrusted` var and the `ready()` return, both back at the parent's form) it is red, the stderr then reading `Claude Code asks whether to trust the folder, which only its user answers` — no folder, no way out, the report's gap verbatim |
| `go test -race -run 'TestShim\|TestRun' ./internal/claudetui` | ok (126s, run on the identical patch one tip earlier — zero commits touching the package or the prefix consumer in between) |
| `gofmt -l` on the two touched files | prints nothing |
| `go vet ./internal/claudetui` | clean |
| `go build`/`GOOS=linux` of the package | clean |

**Siblings**: the bridge's retry trigger reads the `claudetui.Untrusted` prefix (`claude_subscription.go:1369`, `saidOnEnd`), a Contains match — the message keeps the prefix, so the retry is untouched. The Usage card reads the first `claude-tui:` line up to its first `: ` — it now shows the folder too. The `Bypass Permissions` refusal in the same switch stays as main has it; the newer answered<3 trust/Bypass answering path is untouched by this patch.

**Not verified**: the reporter's macOS machine and real Claude Code asking the trust question through Codex (the package tests use a scripted fake display); the Usage card's rendering in the GUI.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
