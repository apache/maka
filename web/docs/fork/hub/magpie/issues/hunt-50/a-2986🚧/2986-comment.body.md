This is the maintainer's re-report of #2450's message (`the panel shown doesn't take the keyboard`), seen once at load ~250 in a full run and passing alone in 4.9s. I could not reproduce it under load: alone `-count=5` and under 150 CPU burners (load 101–125) the test passed 8/8, and on this macOS 15 machine `Show()`'s `orderFrontRegardless` alone makes the panel key within milliseconds, so no timing of `Focus` leaves it not key at the read. The gap is provable by construction though: the check read the key status exactly once, with no retry — `internal/gui/panel_space_darwin_test.go:82` on upstream main, `if !application.InvokeSyncWithResult(w.IsFocused) {`, reached right after a fixed `time.Sleep(500 * time.Millisecond)` (line 70). Whatever delays AppKit's making the panel key past that fixed 500ms — the load the report describes, the same family as #2645's fixed deadlines — turns that one read red while the panel does take the keyboard, just later.

Branch: [`hunt50-a-panel-space`](https://github.com/ggbdpq/magpie/tree/hunt50-a-panel-space), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- The key-status check now waits for the keyboard instead of reading it once: a `waitsFor` helper polls `w.IsFocused` every 20ms for up to 5s — the room the test's show and hide waits already get — and only then consults the #2450 gate, so the failure (`the panel shown doesn't take the keyboard`) still fires exactly where 63be47717 put it, and the session that makes no non-activating panel key still skips the check rather than failing.
- `waitFor` (the show and hide waits) is now written on the same `waitsFor`, so the file has one wait pattern.
- The assertion is not weakened: the panel must still actually take the keyboard; it just may take longer on a loaded machine. Test file only; no product code touched.

## Red before the fix

By construction, honestly — not a natural reproduction (see the opening). With the old single read restored and the panel held not key at the read's moment (hidden just before the check, shown and focused again one second later — the "takes the keyboard only later" state that load produces on macOS 26):

```
--- FAIL: TestPanelJoinsFullScreenSpaces (1.01s)
    panel_space_darwin_test.go:27: panel space: exit status 1
        panel space: made at start: the panel shown doesn't take the keyboard
FAIL
FAIL	github.com/yetone/magpie/internal/gui	2.622s
```

With this fix and the identical induced late keying: `ok github.com/yetone/magpie/internal/gui 4.698s` — the poll saw the panel take the keyboard when it landed, instead of failing at the one read.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Alone ×1 (before the fix, baseline) | `go test -count=1 -run TestPanelJoinsFullScreenSpaces ./internal/gui/` | ok, 1.45s |
| Alone ×5 (before the fix) | same, `-count=5` | ok, 7.7s |
| Under load, ×3 (before the fix) | 150 `yes` burners, load 101–125, `-count=3` | ok, 9.5s — not reproduced |
| Ablation RED | old single read + panel held not key at the read | FAIL, the issue's exact message (above) |
| Ablation GREEN | this fix + the same induced late keying | ok, 4.7s |
| Alone ×3 (after the fix) | `go test -count=1 -run TestPanelJoinsFullScreenSpaces ./internal/gui/` | ok, 3.1s / 2.8s / 2.7s |
| gofmt | `gofmt -l internal/gui/` | clean |
| vet (nogui, darwin) | `go vet -tags nogui ./internal/gui/` | ok (a `-Wenum-conversion` warning in `trayimage_darwin.go` is pre-existing) |
| vet (nogui, cross) | `GOOS=linux` / `GOOS=windows` `go vet -tags nogui ./internal/gui/` | ok, ok |
| vet (cgo, the test's own build tag) | `go vet ./internal/gui/` | ok |

A WindowServer session was available and every run above is a real AppKit run (macOS 15.7.4 arm64, go1.26.8); the child printed `panel space: ok` with no skip line, so this session does make the panel key and the key check ran in full, not through #2450's skip.

## Siblings

- #2450 / 63be47717 is this check's own precedent: it taught the check to ask `sessionKeysPanels` (a plain control panel) before holding the panel to key status, because a session may never make a non-activating panel key. This fix keeps that gate verbatim and only replaces the single read with the wait.
- #2645 is the same family one level up: every real-window AppKit test in this package died at its fixed 20–40s deadline under load, because fixed windows leave no room on a loaded machine. This single-read check was the one remaining fixed window in the panel-space test.
- Other reads in the file: the two `joinsFullScreenSpaces` and one `nonActivating` checks read `collectionBehavior`/`styleMask`, set once at window creation and not settling state, so a single read is sound for them; the post-show `appFrontmost` read (after the same fixed 500ms sleep) could in principle miss a late activation, but that is a different assertion with no reported red, so it is left alone here.

## Not verified

- Not reproduced on macOS 26.2 at load ~250, where the red was seen — this machine is macOS 15.7.4 and tops out near load 125 with burners; the fix is validated against the induced-late-keying ablation instead.
- No full-suite (`go test -timeout 45m ./...`) loaded run; the matrix above is the panel-space test plus formatting and vet.
- `-race` not run: the change is a test-side poll loop, no product concurrency touched.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (0001-gui-the-panel-space-check-waits-for-the-keyboard-ins.patch, sha256 9f56769c55c167b6…)</summary>

```patch
From bea05f94e805d3608a9d3ced03dea65f5be08c07 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 08:08:37 +0800
Subject: [PATCH] gui: the panel-space check waits for the keyboard instead of
 reading it once (#2986)

What changed: TestPanelJoinsFullScreenSpaces' key-status check waits for
the panel to take the keyboard, polling w.IsFocused for up to five
seconds, the room every other wait in the test gets, before it fails. A
waitsFor helper carries the bounded poll, and waitFor (the show and hide
waits) is now written on it. The #2450 gate is unchanged: where the
session makes no non-activating panel key, the check still prints that it
skips rather than fails.

Why: the check read w.IsFocused exactly once, after a fixed 500ms sleep,
with no retry (#2986). The maintainer's hypothesis is that under load
(load average ~250, full 45m run) AppKit has not made the panel key by
the time the single read runs, where alone it has in well under 500ms;
the same family as #2645's fixed deadlines. The panel does take the
keyboard under load, just later; a wait asks for it, a single read
doesn't. The failure message and the session gate are 63be47717's
(#2450), left as they are.

Run (macOS 15.7.4 arm64, go1.26.8, a WindowServer session):
- The failure was not reproduced under load here: alone -count=5 and
  under 150 CPU burners (load 101-125) the test passed 8/8, and on this
  macOS Show's orderFrontRegardless alone makes the panel key within
  milliseconds, so no timing of Focus leaves it not key at the read. By
  construction instead: with the old single read restored and the panel
  held not key at the read (hidden just before it, shown and focused a
  second later), the test failed with the issue's message ("panel space:
  made at start: the panel shown doesn't take the keyboard"); with this
  fix and the same induced late keying, it passed.
- go test -count=1 -run TestPanelJoinsFullScreenSpaces ./internal/gui/,
  alone, three times: ok, 3.1s, 2.8s, 2.7s.
- gofmt -l internal/gui/: clean.
- go vet -tags nogui ./internal/gui/ on GOOS=darwin, linux and windows:
  ok (a -Wenum-conversion warning in trayimage_darwin.go is pre-existing).
- go vet ./internal/gui (cgo, the test file's own build tag): ok.
- Not run: a full-suite loaded run on macOS 26.2, where the red was seen.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/panel_space_darwin_test.go | 17 ++++++++++++++---
 1 file changed, 14 insertions(+), 3 deletions(-)

diff --git a/internal/gui/panel_space_darwin_test.go b/internal/gui/panel_space_darwin_test.go
index db588871..5d7d70e4 100644
--- a/internal/gui/panel_space_darwin_test.go
+++ b/internal/gui/panel_space_darwin_test.go
@@ -45,12 +45,20 @@ func init() {
 		fmt.Printf("panel space: "+format+"\n", a...)
 		os.Exit(1)
 	}
-	waitFor := func(what string, ok func() bool) {
+	// waitsFor gives the AppKit side its room: it polls until ok, up to
+	// five seconds, a loaded machine's share.
+	waitsFor := func(ok func() bool) bool {
 		for deadline := time.Now().Add(5 * time.Second); !ok(); time.Sleep(20 * time.Millisecond) {
 			if time.Now().After(deadline) {
-				fail("timed out waiting until %s", what)
+				return false
 			}
 		}
+		return true
+	}
+	waitFor := func(what string, ok func() bool) {
+		if !waitsFor(ok) {
+			fail("timed out waiting until %s", what)
+		}
 	}
 	check := func(how string) {
 		var w *application.WebviewWindow
@@ -79,7 +87,10 @@ func init() {
 		// active key, a plain titled one either (#2450). A click on the
 		// icon is input, which this test can't make, so where a plain one
 		// isn't made key the check can't tell.
-		if !application.InvokeSyncWithResult(w.IsFocused) {
+		// Under load AppKit makes the panel key later than the fixed wait
+		// above allows, so the key status is waited for, not read once
+		// (#2986).
+		if !waitsFor(func() bool { return application.InvokeSyncWithResult(w.IsFocused) }) {
 			if application.InvokeSyncWithResult(sessionKeysPanels) {
 				fail("%s: the panel shown doesn't take the keyboard", how)
 			}
-- 
2.50.1 (Apple Git-155)
```

</details>
