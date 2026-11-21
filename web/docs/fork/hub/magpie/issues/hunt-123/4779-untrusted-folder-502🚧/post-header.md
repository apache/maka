Patch attached below (`git am` format), one commit on top of upstream/main d8b3749ef. AI-written (GLM-5.3-Flash via ZCode), author ggbdpq.

**TL;DR** The 502 retry loop this issue reports is already gone on main: 59fdab0af (landed the evening of this report, in v0.1.2860 and later) runs such a turn in magpie's own folder instead of failing, so upgrading alone removes the loop seen on 0.1.2605. What stayed broken is the diagnostic half of the report, and that is what the attached patch fixes: the trust refusal now names the actual folder and says how to trust it, in every line it surfaces. No auto-trust is added anywhere.

## Summary

- Why it looked like this on 0.1.2605: the bridge runs Claude Code interactively in the caller's folder, and in the user's own account magpie deliberately leaves the folder-trust question to the user (no `MAGPIE_CLAUDE_TUI_TRUST` there), so the helper ends at once with `claude-tui: Claude Code asks whether to trust the folder, which only its user answers`. Up to 11-01 that run became `-p`; since e5f66f8a6 nothing runs as `-p`, so the turn failed as a 502 ("you can retry your request"), and the client asked again with backoff — each retry spawning a Claude Code that died the same way in 0–1s. That matches the collected logs exactly (7 tries, ~35s per request, each pid ending after 1s).
- The fix already on main (59fdab0af, lwjef on X, same failure family): when initialize ends on the trust question in the caller's folder under the user's own account, the gateway remembers that folder for 10 minutes (`passedOver`) and starts the run once more in magpie's own folder, telling the model the caller's folder (the `envElsewhere` path used for a caller on another computer). The turn is answered, nothing is trusted for the user, and the folder is tried again after 10 minutes. `TestClaudeTUIUntrustedFolderAnswered` holds it. The report's four asks against that design below.
- What this patch adds (asks 1 and 2, for the lines the retry can't reach): every log line of such a failure said "the folder" without saying which — the `claude: claude-tui: ...` line the gateway logs, and the stderr tail a client still sees on the rare surfaces where the retry never comes (the stderr read missing its 2s window in `saidOnEnd`, or the caller already gone). `ready()` already knew the folder (`os.Getwd()`, added for #4830's "asked whether to trust \<folder\>, not answered") but left it out of the reason. The refusal now carries it and the way out:

  - before: `claude-tui: Claude Code asks whether to trust the folder, which only its user answers`
  - after: `claude-tui: Claude Code asks whether to trust the folder (/Users/you/project), which only its user answers: run Claude Code once in it as yourself and choose to trust it`

  What reads this text is unchanged: the bridge triggers the retry on the prefix (`claudetui.Untrusted`, a Contains match), and the Usage card parses the first `claude-tui:` line up to its first `: ` — the folder now shows on the card too.

## Deliberately not done

- No auto-trust of a caller's folder. The report asks for none ("不替用户信任项目是设计"), and the design that the user's own account's trust questions are theirs is kept; the turn being answered from magpie's own folder changes no trust record.
- No 400 / do-not-retry classification. Since 59fdab0af the turn succeeds instead of failing with a better status, which serves ask 3 more thoroughly than a status code would; a refusal that still surfaces is not one a client can fix by retrying either way, but codifying that now would fight the working design.
- The executable path, version and config directory stay out of the message (ask 1 allows log-only for those); the directory the question is about is the load-bearing part and is now in every line.

## Point by point on the report's asks

| Ask | State on main | This patch |
| --- | --- | --- |
| 1. the error carries the actual directory | the retry's log line names it (`startTrusted`); the refusal itself didn't | the refusal names it, wherever it surfaces |
| 2. an actionable way to authorize | none in the message | "run Claude Code once in it as yourself and choose to trust it" |
| 3. not mistaken for a retryable 502 | fixed by 59fdab0af — the turn is answered (v0.1.2860+) | unchanged, prefix-compatible |
| 4. docs on per-folder trust and interactive mode | `docs/subsystems/claude-subscription-bridge.md` describes the whole flow at main | unchanged |

## Verification (this tree, darwin/arm64)

| Check | Result |
| --- | --- |
| `go test ./internal/claudetui` (whole package) | ok (61s) |
| `TestShimNamesTheUntrustedFolder` (new) | red at the parent's tui.go — stderr then named no folder and said nothing to do, the exact wording in this issue's logs; green with the patch |
| `go test -race -run 'TestShim\|TestRun' ./internal/claudetui` | ok |
| `go test -tags nogui -timeout 25m ./internal/gateway/...` | ok (632s) |
| `go vet ./internal/claudetui ./internal/gateway` | clean |
| `gofmt -l` on the touched files | clean |
| `go build ./...` | ok (the gui cgo and ld warnings are the parent's) |
| Ablation | product file only reverted to d8b3749ef: the new test fails again, same wording as the issue's logs |

AI use: written by GLM-5.3-Flash (ZCode); author ggbdpq.

- [x] patch attached in `git am` format, applies on upstream/main d8b3749ef
- [x] no auto-trust added; trust records unchanged for callers' folders
- [x] the retry trigger (`saidOnEnd`, `claudetui.Untrusted` prefix) and the Usage card's parsing are unaffected

<details>
<summary>patch (<code>git am</code>) — 0001-claudetui-trust-refusal.patch</summary>

```patch
From ff661481186d854c01ada26628e3c5706283ad5c Mon Sep 17 00:00:00 2001
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
index d96403437..738373f8b 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -406,8 +406,6 @@ func (s *shim) late(d time.Duration) string {
 	return fmt.Sprintf("Claude Code %s in the %s its caller waits for it: %s", doing, d.Round(100*time.Millisecond), s.lastScreen())
 }
 
-var errUntrusted = errors.New(Untrusted + ", which only its user answers")
-
 // signIn is what Claude Code's interactive mode shows where it is not
 // signed in, as -p may be (CLAUDE_CODE_OAUTH_TOKEN, a container whose
 // ~/.claude.json has no onboarding done): nothing the helper may answer.
@@ -479,7 +477,11 @@ func (s *shim) ready() error {
 		s.doing.Store(doing)
 		switch {
 		case strings.Contains(p, "trust this folder") && os.Getenv(TrustEnv) != "1":
-			return errUntrusted
+			// the folder named, or the user doesn't know what to trust,
+			// and the failure's log line says "the folder" only (#4779,
+			// WillSuo-Github). The prefix (Untrusted) is what the bridge
+			// reads to retry the turn in a folder of magpie's (startTrusted)
+			return fmt.Errorf("%s (%s), which only its user answers: run Claude Code once in it as yourself and choose to trust it", Untrusted, folder)
 		case signIn.MatchString(p):
 			return fmt.Errorf("Claude Code's interactive mode asks to sign in: %s", s.lastScreen())
 		case firstRun.MatchString(words):
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index 80395cdfb..f2912a7d7 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -635,6 +635,27 @@ func TestShimNeverPrints(t *testing.T) {
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

SHA-256 (first 16): `f904f7e447d9c751`

Branch: https://github.com/ggbdpq/magpie/tree/fix/4779-untrusted-folder-502 (head ff661481186d854c01ada26628e3c5706283ad5c)
