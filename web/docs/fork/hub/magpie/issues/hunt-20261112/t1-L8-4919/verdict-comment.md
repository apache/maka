Reading the logs you uploaded after @yetone's reply — they name the remaining cause, and it is not the quota: **the trust question stands drawn on the screen while the read calls it "showed no prompt"**. Your shim screen carries it whole — "Quick safety check: Is this a project you created or one you trust? … 安全指南 › 否，退出。是，我信任此文件夹" — and the log line above it says `claude-tui: Claude Code showed no prompt in the 17s its caller waits for it:`. On the build you were on, the shim keyed the question — its reason text, its answer keys, and the "the user answers it" error — on the older words "trust this folder" alone, so the newer wording was neither named nor answered, and every read or start in a folder nobody had trusted yet burned its whole window out. A signed-in account's read through the interactive mode answers none of it by design (the question is its user's), which is why the waits were the full window.

**Since you last posted, the path that produced this has been removed outright**, along with the concurrent-start pile @shinnqy's "claude 模型长时间没反应" sits on:

- v0.1.3218 (`82403f9f6`, #5582): **/usage is read through `-p`, never the interactive mode** — no trust question can stand between a /usage read and its answer any more, and the reads stop opening idle accounts' 5-hour windows.
- v0.1.3253 (`703eec4ee`, #5579): interactive starts take turns — one Claude Code starts only once the one before it has shown its prompt, so concurrent starts stop piling into 45s timeouts.
- (v0.1.2753, `b4073c06a`, was the first cause yetone fixed: the start screen read as the /usage result.)

You were on ~0.1.2766 when you posted; both later fixes postdate it — a retest on current (or ≥ v0.1.3257) is the first ask.

**The newer wording still has one live face on current main**, in the interactive runs themselves (the bridge's runs, warm-ups): a Claude Code that draws the question this way is neither classified — the run's reason reads "showed no prompt" while the question stands drawn — nor, with TrustEnv set, answered, so the window burns out unnamed. Patched on [hunt-20261112-t1-4919](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-4919) (head `197409571c23cb12`): the question is told by either wording, with the folder named in what the run says it waits on, and with no TrustEnv the run ends at once saying the question is its user's — not at the deadline. **What the answer keys match is left as it was**: the newer form's options reach the shim localized (否，退出。是，我信任此文件夹 in your own screen), and pressing keys by a guess of that layout can pick the exit option — naming the question is as far as this goes without a real fixture of the form.

| check | result |
| --- | --- |
| `TestShimEndsAtItsCallersDeadline/new_trust_unanswered`, parent `f8a00a3be` | FAIL: "showed no prompt in the 3s", the question drawn and unnamed |
| same, with the fix | PASS: "asked whether to trust <work folder>, not answered in the 3s" |
| `TestShimNewTrustIsTheUsers`, parent | FAIL: neither answered nor ended in 30s |
| same, with the fix | PASS 0.11s: ends at once, "asks whether to trust the folder, which only its user answers" |
| ablation (product file back to the parent, tests kept, `88944e519`) | the two reds, verbatim; restored, green |
| `go test ./internal/claudetui` (full, rebased head) | ok 127.3s |
| `-count=1 -race` | ok 129.6s |
| `gofmt -l internal/claudetui`, `go vet ./internal/claudetui` | clean |
| `GOOS=windows`, darwin build | pass |
| `GOOS=linux` build | fails in wails beta.24's own `menu_linux.go` (undefined: pointer) — the dependency's, the same without the patch; `-tags nogui` passes and the touched package builds for linux |
| `git am` on `d85ee9e53` | tree identical (`197409571`) |

**Siblings**: `rg "trust this folder"` on current main — the old key now lives only in the shim's one check; the bridge's untrusted fall-back reads the helper's stderr line (`saidOnEnd(claudetui.Untrusted)`), which the newer wording now produces too, so a client run whose caller folder is untrusted falls to magpie's own folder with the reason named instead of hanging unnamed. **When the read fails**: nothing new is read — the question is named from the screen the shim already holds.

**To close the answer side later** (the maintainer's): the newer form's real option layout — your log carries the antigravity plugin's version, not Claude Code's, so please say which Claude Code your build runs (and whether it is localized in place, since the options in your screen are Chinese beside an English body). A fixture of that form is what the answer keys would need; the reporter's retest on current is what closes this issue's own ask.

**Not verified**: a real Claude Code that draws the newer wording (the fixture here is your screen, flattened — the raw screen's cursor layout is unknown); whether that wording is a Claude Code release's own or a localization patch's; your retest on current.

---
**Source**: reported in #4919; the cause pinned from the logs you uploaded on 11-03, plus the code at `d85ee9e53`.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

**Patch**: <details><summary>patch: claudetui: a trust question of the newer wording is named, and is its user's to answer (#4919) — git am applies it as is; SHA-256 first 16: bb83b9fab22add62</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 02:40:15 +0800
Subject: [PATCH] claudetui: a trust question of the newer wording is named,
 and is its user's to answer (#4919)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A one-off run whose Claude Code draws the trust question as "Quick
safety check: Is this a project you created or one you trust?" ended
"showed no prompt in the 17s its caller waits for it", the question
standing drawn and unnamed: the shim keyed the question, and its answer
keys and its user's-answer error, on the older words "trust this
folder" alone (wzxglobal's app.log, #4919). The question is now told by
either wording: named in what the run says it waits on, and, with no
TrustEnv, answered by nobody and ended at once saying so, instead of
waiting its window out.

What the answer keys match is left as it was: the newer form's options
reach the shim localized (否，退出。是，我信任此文件夹 in the report's
own log), and pressing keys by a guess of the drawn layout can pick the
exit option, so naming the question is as far as this goes without a
real fixture of that form.

Run:
- go test ./internal/claudetui -run 'TestShimEndsAtItsCallersDeadline|TestShimNewTrustIsTheUsers' -count=1:
  new_trust_unanswered FAIL "showed no prompt in the 3s" before, PASS
  "asked whether to trust …, not answered in the" after;
  TestShimNewTrustIsTheUsers FAIL "neither answered nor ended in 30s"
  before, PASS 0.11s after; the older trust, no-prompt and
  TestShimTrustsWhenTold cases green before and after.
- gofmt -l internal/claudetui clean; go vet ./internal/claudetui clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudetui/tui.go      | 15 ++++++++---
 internal/claudetui/tui_test.go | 48 ++++++++++++++++++++++++++++++++++
 2 files changed, 60 insertions(+), 3 deletions(-)

diff --git a/internal/claudetui/tui.go b/internal/claudetui/tui.go
index 93b038916..728e35744 100644
--- a/internal/claudetui/tui.go
+++ b/internal/claudetui/tui.go
@@ -474,6 +474,15 @@ var (
 	trustSettle = 300 * time.Millisecond
 )
 
+// trustAsked says whether a screen draws the trust question, in the words
+// Claude Code has drawn it as: "Do you trust this folder?" once, and now
+// "Quick safety check: Is this a project you created or one you trust?"
+// — wzxglobal's app.log (#4919): the question stood drawn and a /usage
+// read still ended "showed no prompt", its 17s waited out unnamed.
+func trustAsked(s string) bool {
+	return strings.Contains(s, "trust this folder") || strings.Contains(s, "one you trust")
+}
+
 // lastAt is where re's last match in p starts, -1 with none.
 func lastAt(re *lazyre.RE, p string) int {
 	m := re.FindAllStringIndex(p, -1)
@@ -580,7 +589,7 @@ func (s *shim) ready() error {
 		now, _ := s.looks()
 		nowWords := strings.Join(strings.Fields(now+" "+p), " ")
 		doing := "showed no prompt"
-		if strings.Contains(nowWords, "trust this folder") {
+		if trustAsked(nowWords) {
 			doing = asking
 		} else if strings.Contains(nowWords, "Bypass Permissions mode") {
 			doing = bypassAsking
@@ -589,7 +598,7 @@ func (s *shim) ready() error {
 		}
 		s.doing.Store(doing)
 		switch {
-		case strings.Contains(p, "trust this folder") && os.Getenv(TrustEnv) != "1":
+		case trustAsked(p) && os.Getenv(TrustEnv) != "1":
 			return errUntrusted
 		case strings.Contains(words, "Bypass Permissions mode") && os.Getenv(BypassEnv) != "1":
 			return fmt.Errorf("Claude Code's interactive mode runs in Bypass Permissions mode and asks to accept it, which only its user answers: %s", s.lastScreen())
@@ -603,7 +612,7 @@ func (s *shim) ready() error {
 			if err := onboard("terminal", "\x1b"); err != nil {
 				return err
 			}
-		case (strings.Contains(p, "trust this folder") || strings.Contains(words, "Bypass Permissions mode")) && answered < 3:
+		case (trustAsked(p) || strings.Contains(words, "Bypass Permissions mode")) && answered < 3:
 			// the choice is the last one drawn after ❯, "No, exit" at
 			// first. A key sent as the question is first drawn can be lost
 			// to its being drawn again on No, so Enter goes only to a Yes
diff --git a/internal/claudetui/tui_test.go b/internal/claudetui/tui_test.go
index 650b35de5..0222c7804 100644
--- a/internal/claudetui/tui_test.go
+++ b/internal/claudetui/tui_test.go
@@ -89,6 +89,25 @@ func fakeTrust(r *bufio.Reader, always bool) {
 	}
 }
 
+// fakeNewTrust asks whether to trust the folder as a newer Claude Code
+// words it: "Quick safety check: Is this a project you created or one you
+// trust?", its options not the ones the shim's answer keys match —
+// wzxglobal's app.log (#4919): the question stood on the screen and the
+// log still said "showed no prompt", the read waiting its window out.
+// With always, it never listens, as a question whose answer never goes
+// through.
+func fakeNewTrust(r *bufio.Reader, always bool) {
+	draw := func() {
+		fmt.Printf("Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team.) If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. 安全指南 ›\r\n\x1b[38;2;177;185;249m❯\x1b[39m 否，退出。\r\n  是，我信任此文件夹\r\n")
+	}
+	draw()
+	for {
+		if _, err := r.ReadByte(); err != nil {
+			os.Exit(0)
+		}
+	}
+}
+
 // fakeBypass shows Claude Code's Bypass Permissions disclaimer, drawn
 // where it runs with --dangerously-skip-permissions and its config
 // folder hasn't accepted it once (2.1.295): "No, exit" chosen, and drawn
@@ -290,6 +309,9 @@ func fakeClaude(args []string) {
 	if v := os.Getenv("FAKE_TRUST"); v != "" {
 		fakeTrust(r, v == "deaf")
 	}
+	if v := os.Getenv("FAKE_NEWTRUST"); v != "" {
+		fakeNewTrust(r, v == "deaf")
+	}
 	if v := os.Getenv("FAKE_BYPASS"); v != "" {
 		fakeBypass(r, v == "deaf")
 	}
@@ -947,6 +969,13 @@ func TestShimEndsAtItsCallersDeadline(t *testing.T) {
 		// the question a saved account's reads waited out on (#4830,
 		// mydosu): said, with the folder, never "showed no prompt"
 		{"trust unanswered", `{"type":"user","message":{"role":"user","content":"hello"}}`, "asked whether to trust " + wd + ", not answered in the", "trust this folder", []string{"FAKE_TRUST=deaf", TrustEnv + "=1"}},
+		// the same question as a newer Claude Code words it — "Quick
+		// safety check: Is this a project you created or one you trust?",
+		// its options not the ones the answer keys match — said with the
+		// folder, never "showed no prompt" (#4919, wzxglobal's app.log:
+		// the question stood drawn and the read waited its 17s out
+		// unnamed)
+		{"new trust unanswered", `{"type":"user","message":{"role":"user","content":"hello"}}`, "asked whether to trust " + wd + ", not answered in the", "one you trust", []string{"FAKE_NEWTRUST=deaf", TrustEnv + "=1"}},
 		// the disclaimer the spawned claude sat on for 45s, then died in a
 		// loop of them (#5042): said, never "showed no prompt"
 		{"bypass disclaimer unanswered", `{"type":"user","message":{"role":"user","content":"hello"}}`, "asked to accept running in Bypass Permissions mode, not answered in the", "Bypass Permissions mode", []string{"FAKE_BYPASS=deaf", BypassEnv + "=1"}},
@@ -979,6 +1008,25 @@ func TestShimEndsAtItsCallersDeadline(t *testing.T) {
 	}
 }
 
+// The new-form trust question is the user's to answer as the old one is:
+// asked with no TrustEnv, the run ends at once saying so — not at its
+// caller's deadline, "showed no prompt", as it read while the question
+// stood drawn and unnamed (#4919, wzxglobal's app.log).
+func TestShimNewTrustIsTheUsers(t *testing.T) {
+	by := time.Now().Add(30 * time.Second).UnixMilli()
+	start := time.Now()
+	_, stderr, err := runEnds(t, t.TempDir(), []string{"FAKE_NEWTRUST=deaf", DeadlineEnv + "=" + strconv.FormatInt(by, 10)})
+	if err == nil {
+		t.Fatal("the run ended nil")
+	}
+	if !strings.Contains(stderr, Untrusted) {
+		t.Fatalf("stderr %q", stderr)
+	}
+	if d := time.Since(start); d > 10*time.Second {
+		t.Fatalf("ended after %s, the question was up at once", d)
+	}
+}
+
 // Claude Code 2.1.319's Claude in Chrome offer turns away a key sent just
 // after it opens and draws nothing again: the Esc sent the moment it was
 // drawn was lost, and every run waited on it until its caller gave up,
-- 
2.50.1 (Apple Git-155)

```

</details>
