Independent verification of @chocolatemale's attached fix — **VERDICT: PASS**. The fix is theirs (branch [`fix/tui-trust-cursor-redraw`](https://github.com/chocolatemale/magpie/tree/fix/tui-trust-cursor-redraw), commit `0c9f9b5`); I only reproduced the failure and re-validated the fix on current `upstream/main`. This is not my work and I claim none of it.

**Not verified here** (first, per honesty): the real Claude Code 2.1.318 end-to-end run on macOS (that's the reporter's own validation), native Windows/Linux runtimes, and the Bypass Permissions screen under cursor-only redraws (see the sibling note below). Everything below is Go-test-level on `upstream/main` `12a9970d6`, darwin/arm64, go1.26.8, temporary `HOME`, private build cache, `-count=1`.

**What the fix does** (theirs): in `ready()`, match `trustNo`/`trustYes` against the currently rendered terminal grid from `s.looks()` instead of the ANSI-stripped history from `plain()` — cursor-only arrow redraws no longer hide "Yes" behind an old selected "No". The `MAGPIE_CLAUDE_TUI_TRUST` gate, the 300 ms settled-selection check, the answer limit and the untrusted-folder refusal are untouched. Test side adds a `FAKE_TRUST=diff` mode that draws both labels once and then moves only the `❯` marker, plus the regression `TestShimTrustCursorOnlyRedraw`; three files, 24 insertions, 2 deletions.

**Independent reproduction (red → green, verbatim):**

1. The commit's base `331f201` is 199 commits behind today's `main`, and `git apply` fails on the docs and `tui.go` hunks (`#5042` inserted the `bypassYes` line right after the changed line; the docs paragraph's test list also changed). I carried the change over by hand with the same semantics: only `trustNo`/`trustYes` move to the grid; `bypassYes` keeps reading the stripped history exactly as on `main`. Test and doc hunks are the reporter's, unchanged. Carrier commit `2463a75f3` with the reporter's authorship preserved, patch attached below.
2. Committed first, then ablated the production file only (`git checkout HEAD~1 -- internal/claudetui/tui.go`, regression test kept) — red:

```text
=== RUN   TestShimTrustCursorOnlyRedraw
    tui_test.go:1272: the shim wrote 0 lines of 3 in 30s: []
--- FAIL: TestShimTrustCursorOnlyRedraw (30.01s)
FAIL
FAIL	github.com/yetone/magpie/internal/claudetui	30.259s
```

Matching the reporter's quoted failure byte for byte, and it is behavioral (the stall), not a compile error.

3. Restored the fix — green:

```text
=== RUN   TestShimTrustCursorOnlyRedraw
--- PASS: TestShimTrustCursorOnlyRedraw (2.33s)
PASS
ok  	github.com/yetone/magpie/internal/claudetui	2.568s
```

4. Full package `go test ./internal/claudetui -count=1`: `ok github.com/yetone/magpie/internal/claudetui 110.761s`. `go vet ./internal/claudetui` clean.
5. Focused matrix: existing full-redraw trust test `TestShimTrustsWhenTold` PASS (2.35s), `TestShimAcceptsBypassDisclaimer` PASS (2.24s), new regression PASS (2.24s).
6. Sibling scan: `trustNo`/`trustYes` have exactly one call site in the repo (`tui.go:548`, the fixed line); the only other `lastAt` in the block is `bypassYes` (`tui.go:549`), deliberately left on the stripped history as `#5042` merged it; `looks()` is used in one pre-existing place with the same current-grid semantics. The `TrustEnv`/`BypassEnv` opt-in gates still read the plain text — unchanged, as the issue states. One observation, not a defect of this fix: if Claude Code ever cursor-redraws the Bypass Permissions disclaimer the same way it redraws the trust prompt, `bypassYes` on stripped history could stall the same way — out of scope here.

**Rebase carrier patch** (git-am format, applies on `12a9970d6`, author kept as @chocolatemale; the fix itself is entirely theirs):

```diff
From 2463a75f3dba3da73a3d454073685a24f091a639 Mon Sep 17 00:00:00 2001
From: chocolatemale <chocolatemale@users.noreply.github.com>
Date: Thu, 5 Nov 2026 17:02:30 +0800
Subject: [PATCH] claudetui: read trust selection from the rendered terminal
 grid

Port of chocolatemale/magpie 0c9f9b5 (issue #5366) onto upstream/main
12a9970d6. The trust block gained a bypassYes term (#5042) since the
original base 331f201, so the hunk was applied by hand: trustNo/trustYes
now match the current grid from looks(), bypassYes keeps reading the
plain history as on main. Test and doc hunks carried over unchanged.

Claude Code 2.1.318 redraws only the selection arrow after a navigation
key. Reading stripped terminal history keeps seeing No selected and
prevents initialization. Match the current grid instead, retaining the
trust opt-in and settled-selection checks.
---
 docs/subsystems/claude-subscription-bridge.md |  3 ++-
 internal/claudetui/tui.go                     |  3 ++-
 internal/claudetui/tui_test.go                | 20 +++++++++++++++++++
 3 files changed, 24 insertions(+), 2 deletions(-)

diff --git a/docs/subsystems/claude-subscription-bridge.md b/docs/subsystems/claude-subscription-bridge.md
index d51bb6210..ab9a93b5e 100644
--- a/docs/subsystems/claude-subscription-bridge.md
+++ b/docs/subsystems/claude-subscription-bridge.md
@@ -318,7 +318,8 @@ on Discord). `TestClaudeTUIUntrustedFolderKeepsItsSession`,
 `TestClaudeTUIFolderTrustedLaterRunInAtOnce` and
 `TestClaudeTrustedFolders` hold it. The question opens on "No, exit", and a key
 sent as it is first drawn can be lost to its being drawn again, so the
-helper presses ↓ until "Yes" is the last choice drawn and Enter only once
+helper reads the current terminal grid (Claude Code can redraw only the
+selection arrow), presses ↓ until "Yes" is selected and Enter only once
 it has stayed so for 300ms (`ready`, `trustSettle`). Pressing Enter blind
 chose "No, exit" in the real gateway, and no run started.

diff --git a/internal/claudetui/tui.go b/internal/claudetui/tui.go
index 522498b1b..cfe77482b 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -544,7 +544,8 @@ func (s *shim) ready() error {
 			// first. A key sent as the question is first drawn can be lost
 			// to its being drawn again on No, so Enter goes only to a Yes
 			// drawn trustSettle ago and not drawn over since.
-			no, yes := lastAt(trustNo, p), lastAt(trustYes, p)
+			drawn, _ := s.looks()
+			no, yes := lastAt(trustNo, drawn), lastAt(trustYes, drawn)
 			if b := lastAt(bypassYes, p); b > yes {
 				yes = b
 			}
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index be1ad81bf..c72966772 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -45,7 +45,20 @@ func TestMain(m *testing.M) {
 func fakeTrust(r *bufio.Reader, always bool) {
 	var mu sync.Mutex
 	yes, deaf := false, true
+	drawn := false
 	draw := func() {
+		if os.Getenv("FAKE_TRUST") == "diff" {
+			if !drawn {
+				fmt.Print("\x1b[2J\x1b[HDo you trust this folder?\r\n  No, exit\r\n  Yes, I trust this folder\r\n")
+				drawn = true
+			}
+			if yes {
+				fmt.Print("\x1b[2;1H \x1b[3;1H❯")
+			} else {
+				fmt.Print("\x1b[3;1H \x1b[2;1H❯")
+			}
+			return
+		}
 		marks := map[bool]string{true: "\x1b[38;2;177;185;249m❯\x1b[39m", false: " "}
 		fmt.Printf("\x1b[2GDo\x1b[5Gyou\x1b[9Gtrust\x1b[15Gthis\x1b[20Gfolder?\r\n\x1b[2G%s\x1b[4GNo,\x1b[8Gexit\r\n\x1b[2G%s\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n", marks[!yes], marks[yes])
 	}
@@ -1254,3 +1267,10 @@ func TestShimEndedAfterLastWordsRead(t *testing.T) {
 		})
 	}
 }
+
+func TestShimTrustCursorOnlyRedraw(t *testing.T) {
+	out := runShim(t, []string{"FAKE_TRUST=diff", TrustEnv + "=1"}, append([]string{fakePath(t)}, pArgs...), []string{"hello"}, 3)
+	if out[0]["subtype"] != "init" || out[1]["type"] != "assistant" {
+		t.Fatalf("got %v, want an interactive turn", out)
+	}
+}
--
2.50.1 (Apple Git-155)
```

Verification run by ggbdpq; fix and patch authorship remain @chocolatemale's. AI assistance was used for the verification tooling and this comment.
