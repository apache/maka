@yetone @Suge8's fix from this issue, carried: a replayed history's words with a line naming an image file were dropped when an image piece followed, in interactive mode — a compacted conversation told to a new Claude Code ("76 messages, 4 images") reached it as "[Image #1] … [Image #4]" and the closing notes, the model answering "you only sent 4 screenshots", and the missing words showing up in the next prompt, out of order (#5548). The diff below is Suge8's patch as posted, applied to current `main`; the regression test and the fake that models Claude Code 2.1.318's paste handler are new.

**Root cause** (Suge8's diagnosis, checked against `internal/claudetui/tui.go` on `main`): Claude Code 2.1.318's paste handler tests each pasted line against `/\.(png|jpe?g|gif|webp)$/i`, and a matching line is tried as an image file before the words are taken in — a relative name asks the clipboard first, so the take-in runs late. `send` pasted the next piece right away, waiting only for the last text piece (`shown`), and Claude Code, keeping a single pasting flag, takes any paste's end as the end of pasting: the image path pasted next ended the words' take-in, `shown` found the closing text, and the Enter 150 ms later sent a draft holding the image and the closing text alone. The words landed in the next prompt, one turn late.

**The fix** (Suge8's, as posted): `send` waits for every text piece to show before it pastes the next — a piece is shown when a `[Pasted text #N` numbered past the message's last paste appears (images and long pasted text share Claude Code's numbering, so `send` keeps one counter for both) or its tail appears; a timeout still passes as before (#5001's tolerance). The cost is one showing, only for a message with such a line.

<details><summary>patch: claudetui: every pasted piece waits for its showing before the next (#5548, Suge8) — git am applies it as is; SHA-256 first 16: e13dfbf7b15580c9</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 11:25:45 +0800
Subject: [PATCH] claudetui: every pasted piece waits for its showing before
 the next (#5548, Suge8)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A replayed history whose words hold a line naming an image file lost
those words when an image piece followed: Claude Code 2.1.318's paste
handler tests each pasted line against /\.(png|jpe?g|gif|webp)$/i, and
a matching line is tried as an image file before the words are taken
in — a relative name asks the clipboard first, so the take-in runs
late. send pasted the next piece right away, waiting only for the last
text piece (shown), and Claude Code, keeping a single pasting flag,
takes any paste's end as the end of pasting: the image path pasted
next ended the words' take-in, shown found the closing text, and the
Enter 150ms later sent a draft holding the image and the closing text
alone. The words landed in the next prompt, one turn late: a
compacted conversation told to a new Claude Code ("76 messages, 4
images") reached it as "[Image #1] … [Image #4]" and the closing
notes, and the model answered "you only sent 4 screenshots" (#5548,
Suge8).

Now send waits for every text piece to show before it pastes the next:
a piece is shown when a "[Pasted text #N" numbered past the message's
last paste appears — images and long text share Claude Code's
numbering, so send keeps one counter for both — or its tail appears.
A timeout still passes as before, and the cost is one showing, only
for a message with such a line.

The fix is Suge8's, carried as posted on #5548. The regression drives
the shim and a fake Claude Code whose paste handler models 2.1.318's
by Suge8's helper log (a chunk with an image-named line taken in
400ms late, superseded by the next paste's end, its words landing
after the Enter), so the shape is unit-tested without an account.
On mote with tui.go at the parent: TestShimReplayKeepsItsTextBeforeAnImage
FAIL ("the replayed history's words missed their turn: … echo: [Image
#2:red]\n\n(The images above, then the codeword.)"); with the fix it
passes, and ./internal/claudetui passes whole.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudetui/replay_image_test.go | 28 ++++++++++++
 internal/claudetui/tui.go               | 59 ++++++++++++++----------
 internal/claudetui/tui_test.go          | 60 ++++++++++++++++++++++++-
 3 files changed, 123 insertions(+), 24 deletions(-)
 create mode 100644 internal/claudetui/replay_image_test.go

diff --git a/internal/claudetui/replay_image_test.go b/internal/claudetui/replay_image_test.go
new file mode 100644
index 000000000..ff04953c3
--- /dev/null
+++ b/internal/claudetui/replay_image_test.go
@@ -0,0 +1,28 @@
+package claudetui
+
+import (
+	"encoding/base64"
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+// A replayed history whose words hold a line naming an image file loses
+// those words when an image follows: 2.1.318's paste handler tries each
+// pasted line as an image file before it takes the words in, so they are
+// taken in late, and the end of the image path pasted next ends that
+// take-in — the words land after the Enter, one turn late (#5548, Suge8).
+// send waits for every text piece to show before it pastes the next, so
+// the replayed words go out with their image.
+func TestShimReplayKeepsItsTextBeforeAnImage(t *testing.T) {
+	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
+	history := "The codeword is MANGO.\nSome notes.\nfoo.png\nmore notes."
+	msg := `[{"type":"text","text":` + strconvQuote(history) + `},` +
+		`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + b64("red") + `"}},` +
+		`{"type":"text","text":"(The images above, then the codeword.)"}]`
+	out := runShim(t, []string{"FAKE_SLOW_PASTE=1"}, append([]string{fakePath(t)}, pArgs...), []string{msg}, 2)
+	said, _ := json.Marshal(out[1])
+	if !strings.Contains(string(said), "MANGO") {
+		t.Errorf("the replayed history's words missed their turn: %s", said)
+	}
+}
diff --git a/internal/claudetui/tui.go b/internal/claudetui/tui.go
index efa23a956..39bf0ff47 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -1191,20 +1191,25 @@ func pasteClean(text string) string {
 	}, text)
 }
 
-// send pastes a message's pieces into Claude Code's prompt, each image
-// once the prompt shows the one before (its file is read as it is pasted,
-// and words pasted meanwhile would come before it), and presses Enter,
-// again while the message hasn't reached the transcript: an Enter that
-// lands while the paste is still being taken in is part of it.
+// send pastes a message's pieces into Claude Code's prompt, each once the
+// prompt shows the one before, and presses Enter, again while the message
+// hasn't reached the transcript: an Enter that lands while the paste is
+// still being taken in is part of it. A piece is taken in a moment after
+// it is pasted where Claude Code reads a file for it: an image's path, and
+// words with a line that names an image file ("a.jpg" in an ls), which it
+// tries as one before it takes the words. Claude Code takes any paste
+// ending as the end of pasting, so a piece pasted meanwhile that is taken
+// first lets Enter send the message without the words, and they show in
+// the prompt after it (2.1.318).
 func (s *shim) send(pieces []piece) error {
 	s.rowsMu.Lock()
 	before, busy := s.rows, s.busy
 	s.rowsMu.Unlock()
-	text, image := "", 0
+	marker := 0
 	for i, p := range pieces {
+		var err error
 		if p.image != "" {
-			var err error
-			if image, err = s.pasteImage(s.path(p.image), image); err != nil {
+			if marker, err = s.pasteImage(s.path(p.image), marker); err != nil {
 				return err
 			}
 			continue
@@ -1221,10 +1226,9 @@ func (s *shim) send(pieces []piece) error {
 		if _, err := io.WriteString(s.pty, "\x1b[200~"+p.text+"\x1b[201~"); err != nil {
 			return err
 		}
-		text = p.text
-	}
-	if err := s.shown(text); err != nil {
-		return err
+		if marker, err = s.shown(p.text, marker); err != nil {
+			return err
+		}
 	}
 	time.Sleep(150 * time.Millisecond)
 	for try := 0; try < 4; try++ {
@@ -1264,8 +1268,9 @@ func (s *shim) path(path string) string {
 }
 
 // pasteImage pastes an image file's path, and waits for the prompt to show
-// it taken as an image: one numbered past after, the message's image
-// before it. It returns the number shown.
+// it taken as an image: one numbered past after, the message's paste
+// before it (Claude Code numbers images and long pasted text alike). It
+// returns the number shown.
 func (s *shim) pasteImage(path string, after int) (int, error) {
 	s.clearScreen()
 	if _, err := io.WriteString(s.pty, "\x1b[200~"+path+"\x1b[201~"); err != nil {
@@ -1296,11 +1301,16 @@ func shownWait(n int) time.Duration {
 	return pasteWait + time.Duration(n/(64<<10))*time.Second
 }
 
+var textShown = regexp.MustCompile(`\[Pasted text #(\d+)`)
+
 // shown waits for the prompt to show pasted text: its last words, or
-// Claude Code's "[Pasted text" for a long one. Text "" waits for nothing.
-func (s *shim) shown(text string) error {
+// Claude Code's "[Pasted text #<n>" for a long one, numbered past after,
+// the message's paste before it: the prompt drawn again shows those
+// before. It returns the number shown, after where the words show
+// themselves. Text "" waits for nothing.
+func (s *shim) shown(text string, after int) (int, error) {
 	if text == "" {
-		return nil
+		return after, nil
 	}
 	tail := strings.TrimSpace(text)
 	if i := strings.LastIndexByte(tail, '\n'); i >= 0 {
@@ -1310,22 +1320,25 @@ func (s *shim) shown(text string) error {
 		tail = string(r[len(r)-16:])
 	}
 	shownBy := time.After(shownWait(len(text)))
-shown:
 	for {
 		p := s.plain()
-		if strings.Contains(p, "Pasted text") || tail != "" && strings.Contains(strings.Join(strings.Fields(p), " "), strings.Join(strings.Fields(tail), " ")) {
-			break
+		for _, m := range textShown.FindAllStringSubmatch(p, -1) {
+			if n, _ := strconv.Atoi(m[1]); n > after {
+				return n, nil
+			}
+		}
+		if tail != "" && strings.Contains(strings.Join(strings.Fields(p), " "), strings.Join(strings.Fields(tail), " ")) {
+			return after, nil
 		}
 		select {
 		case <-s.changed:
 		case <-time.After(100 * time.Millisecond):
 		case <-shownBy:
-			break shown
+			return after, nil
 		case <-s.exited:
-			return fmt.Errorf("Claude Code ended (%v): %s", s.exit, s.lastScreen())
+			return 0, fmt.Errorf("Claude Code ended (%v): %s", s.exit, s.lastScreen())
 		}
 	}
-	return nil
 }
 
 // transcript is the session's transcript, "" before Claude Code writes it.
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index d43a3c752..7df6151af 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -10,6 +10,7 @@ import (
 	"os"
 	"os/exec"
 	"path/filepath"
+	"regexp"
 	"slices"
 	"strconv"
 	"strings"
@@ -18,6 +19,11 @@ import (
 	"time"
 )
 
+// fakeImageName matches a pasted chunk with a line that is an image file's
+// name, as Claude Code 2.1.318's paste handler tests each pasted line by:
+// one is tried as an image file before the words are taken in.
+var fakeImageName = regexp.MustCompile(`(?m)\.(png|jpe?g|gif|webp)[ \t]*$`)
+
 // The test binary is also the shim (MAGPIE_TUI_TEST=shim) and a fake
 // Claude Code (MAGPIE_TUI_TEST=claude): interactive, it shows a prompt,
 // writes each line typed into its transcript as a turn answered "echo:
@@ -300,6 +306,16 @@ func fakeClaude(args []string) {
 	var mu sync.Mutex
 	var typed, paste strings.Builder
 	pasting, images := false, 0
+	// FAKE_SLOW_PASTE: the paste handler of 2.1.318, whose take-in of a
+	// chunk with a line naming an image file runs late (it tries the name
+	// as an image file first), who numbers images and long pasted text
+	// alike, and who takes any paste's end as the end of pasting: a take-in
+	// another paste ended lands its words after the next Enter, one turn
+	// late (#5548, Suge8's helper log)
+	slowPaste := os.Getenv("FAKE_SLOW_PASTE") == "1"
+	marks := 0 // images and long pasted text, numbered alike in that mode
+	slowDone := 0
+	var pending []string
 	// retry is what an "r" draws while /usage's panel says it couldn't
 	// load the figures, nil when it says nothing of the kind
 	var retry []byte
@@ -320,9 +336,22 @@ func fakeClaude(args []string) {
 				continue
 			}
 			p := paste.String()
+			if slowPaste {
+				// an end of any paste ends a take-in still running
+				mu.Lock()
+				slowDone++
+				mu.Unlock()
+			}
 			if b, err := os.ReadFile(p); err == nil && strings.HasPrefix(filepath.Base(p), "image-") {
-				images++
+				if slowPaste {
+					marks++
+				} else {
+					images++
+				}
 				n := images
+				if slowPaste {
+					n = marks
+				}
 				go func() {
 					time.Sleep(200 * time.Millisecond)
 					mu.Lock()
@@ -332,6 +361,26 @@ func fakeClaude(args []string) {
 				}()
 				continue
 			}
+			if slowPaste && fakeImageName.MatchString(p) {
+				// a line naming an image file: the words are tried as an
+				// image first, so they are taken in late
+				marks++
+				n, gen := marks, slowDone
+				go func() {
+					time.Sleep(400 * time.Millisecond)
+					mu.Lock()
+					defer mu.Unlock()
+					if slowDone > gen {
+						// another paste ended meanwhile, and these words
+						// land after the next Enter, one turn late
+						pending = append(pending, p)
+						return
+					}
+					typed.WriteString(p)
+					fmt.Printf("[Pasted text #%d +%d lines]", n, strings.Count(p, "\n"))
+				}()
+				continue
+			}
 			mu.Lock()
 			typed.WriteString(p)
 			mu.Unlock()
@@ -354,6 +403,15 @@ func fakeClaude(args []string) {
 		mu.Lock()
 		line := typed.String()
 		typed.Reset()
+		if slowPaste && len(pending) > 0 {
+			// a take-in another paste ended lands its words in the next
+			// prompt, one turn late
+			for _, w := range pending {
+				typed.WriteString(w)
+				fmt.Print(w)
+			}
+			pending = nil
+		}
 		mu.Unlock()
 		if listed != "" {
 			if _, err := os.Stat(listed); err != nil {
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5548-replay-image-text`](https://github.com/ggbdpq/magpie/tree/fix/5548-replay-image-text) (head `e096007aa8ca14754b69595f20d6b1c8c22ee0a8`), rebased onto current `upstream/main` (`9e6687e3a`); on a fresh checkout `git am` applies clean. The `tui.go` hunk is Suge8's patch verbatim; the two test files are the regression.

| Check | Result |
| --- | --- |
| `TestShimReplayKeepsItsTextBeforeAnImage` (new) | red before the fix — the sent draft was `echo: [Image #2:red]\n\n(The images above, then the codeword.)`, the history's words one turn late, matching Suge8's helper log shape — pass after |
| `./internal/claudetui/ -tags nogui -count=1` | ok (109.3s pre-rebase, 115.5s on `9e6687e3a`), zero failures |
| `go test -tags nogui ./...` (temp HOME, pinned Go caches) | 85 packages ok; `TestMothX`, `TestProxyCheckSaysAProxyPassedBy` and `TestHostToldTheGatewayAddress` fail — the first two are this machine's known pre-existing reds (the proxy at 127.0.0.1:7897), the third fails the same, byte-identical message, on a clean `upstream/main` `665b9aff1` worktree (stale `MAGPIE_ADDR` after a port move, `host_addr_test.go:78`); none in `internal/claudetui`, all pre-existing, listed as failures with their cause |
| targeted `-race` (`-run '^TestShim'`, includes the new test) | ok (117.5s on `9e6687e3a`) |
| `gofmt -l internal/claudetui/tui.go internal/claudetui/tui_test.go internal/claudetui/replay_image_test.go` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean |
| Ablation | `git checkout HEAD~1 -- internal/claudetui/tui.go` (Suge8's hunk reverted, tests kept) turns `TestShimReplayKeepsItsTextBeforeAnImage` red with the same lost-words shape; restored, green |
| Re-verified on upstream/main `9e6687e3a` | the branch started at `665b9aff1`; `git fetch upstream` found the tip moved to `9e6687e3a` (a claudetui commit — the Claude in Chrome offer guard), rebased, and the targeted test, the shim `-race` family and the package were re-run green on the rebased head before this post |

**Not verified**: a real Claude Code 2.1.318 driven through a real subscription account — Suge8's own live verification (unpatched: text lost 3/3 with the `png` shape; patched: text arrives 2/2, `foo.png` mid-sentence and no-image cases arrive, `go test ./internal/claudetui/` passing) stands as theirs and is not re-run here. The regression models the handler from Suge8's helper log (a chunk with an image-named line taken in late, superseded by the next paste's end, its words landing after the Enter) at the PTY level, without an account. The "Also seen" face — Claude Code attaching every existing image a replayed history names on its own line — is Claude Code's own behavior and is not addressed by this fix, as Suge8 noted.

**Attribution**: the fix is @Suge8's, carried as posted on this issue — please credit it to them (the subject carries their name). The regression test and the fake are AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
