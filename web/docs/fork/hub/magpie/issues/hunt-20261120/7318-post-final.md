Carrying @mouettxy's branch (`forward-hook-notices`, commit `d49e05f2`) — author kept on the commit — and verified at the current main (`c2e6e4aa8`). The fix is theirs as written (cherry-picked, no conflicts); added on my side: this verification.

**What the fix does** (theirs): `withHookNotices` walks the messages after the last assistant turn, collects each hook's notice from the text that follows a tool result (`PostToolUse:Write hook additional context: …`, `PostToolUse:Edit hook blocking error from command: …`, `Stop hook feedback: …`), leaves the bare `hook success:` out, and appends them to the end of the last result in a `<system-reminder>` — the same shape `withTaskNotices` uses. Wired at the one place results go back to the run (`serveSubscriptionAs`). That is exactly the face this issue reports: PostToolUse `additionalContext`, PostToolUse `decision: block` (exit 2) and PreToolUse `additionalContext` now reach the run's model; the bare success stays out, and the user's own words stay out (#2060's rule — the existing tests keep it, and the new ones pin it).

| Element | Evidence (darwin/arm64, upstream/main `c2e6e4aa8` + this commit) |
| --- | --- |
| RED (wiring out) | `TestClaudeHookNoticesGoWithTheResults` with only the serve line unwired: `claude_hook_notice_test.go:118: the result "hi" lacks "hi\n\n<system-reminder>\n"` |
| GREEN | both new tests green on the carry (ok 1.3s); the whole hook-notice family (6 tests) green |
| Ablation | the same unwired line → the same red; restored → green |
| Touched package, full | `go test -tags nogui -timeout 45m -count=1 ./internal/gateway` → 933.8s, 72 reds; base `c2e6e4aa8` same recipe → 73 reds; comm of the two red sets: zero tip-only (base-only: `TestClaudeTUIResumedSessionIsGivenItsInstructions`, the known flaky family) |
| `-race` | named family green (2.5s) |
| gofmt / `git diff --check` | clean |
| vet ×3 / build ×3 | darwin / linux / windows (`nogui`) all clean |
| git am | the patch below replays cleanly on `c2e6e4aa8`; the replayed tree `86bd0bac1f6bd75e4584f08b3891680cf419147c` equals the branch head's tree; author kept |

NOT-RUNNABLE here: a live Claude Code run with real hooks — the reporter already checked theirs live on a patched build ("with the patched build, a PostToolUse `additionalContext` after `Write` reached the model inside the tool result"); the fixture tests drive the same `continueWith` path a live run takes.

Sibling faces: `withHookNotices` has exactly one reader — the serve wiring (rg over the package); hook notices only exist in the Claude Code subscription path, so there is no other provider face; `withTaskNotices`/`withSkillBodies` untouched.

**Branch with the commit**: [`fix/7318-forward-hook-notices`](https://github.com/ggbdpq/magpie/tree/fix/7318-forward-hook-notices) (head `38540609048241e34715e26b1eefb38156d8de48`). Patch, `git am` ready, sha256[:16] `1ef97eaa8ad68712`:

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Nikita Chaikovsky <lis@chaikovskie.com>
Date: Fri, 20 Nov 2026 10:47:56 +0300
Subject: [PATCH] gateway: a hook's notices reach the run's model with the
 results

---
 internal/gateway/claude_hook_notice_test.go | 26 +++++++-
 internal/gateway/claude_subscription.go     | 70 ++++++++++++++++++++-
 2 files changed, 94 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/claude_hook_notice_test.go b/internal/gateway/claude_hook_notice_test.go
index 9768fd5a7..6d523804f 100644
--- a/internal/gateway/claude_hook_notice_test.go
+++ b/internal/gateway/claude_hook_notice_test.go
@@ -45,7 +45,7 @@ func TestClaudeHookNoticesAreNotTheUsersMessage(t *testing.T) {
 	for name, body := range map[string]string{"2.1.296": cc296Hooks, "reported": reportedHooks} {
 		t.Run(name, func(t *testing.T) {
 			got, said, _ := continuing(t, body)
-			if text := resultText(got); text != "hi" && text != "package a" {
+			if text := resultText(got); !strings.HasPrefix(text, "hi") && !strings.HasPrefix(text, "package a") {
 				t.Fatalf("call-1 was answered %q", text)
 			}
 			if len(said) != 0 {
@@ -106,3 +106,27 @@ func TestAgentNoticeLeavesTheUsersWords(t *testing.T) {
 		}
 	}
 }
+
+// A hook's notices go to the run's model with the result they follow, in a
+// reminder, without the token count or the user's words beside them.
+func TestClaudeHookNoticesGoWithTheResults(t *testing.T) {
+	got, _, _ := continuing(t, cc296HooksAndUser)
+	text := resultText(got)
+	for _, want := range []string{"hi\n\n<system-reminder>\n", "PreToolUse:Bash hook additional context: <context_guidance>prefer ctx_execute</context_guidance>",
+		"PostToolUse:Bash hook additional context: post context here\n</system-reminder>"} {
+		if !strings.Contains(text, want) {
+			t.Fatalf("the result %q lacks %q", text, want)
+		}
+	}
+	if strings.Contains(text, "tokens left") || strings.Contains(text, "also tell me the date") {
+		t.Fatalf("the result took more than the notices: %q", text)
+	}
+}
+
+func TestHookNoticesLeaveSuccessOut(t *testing.T) {
+	got := hookNotices("<system-reminder>\nPostToolUse:Write hook success: ok\n</system-reminder>\n" +
+		"PostToolUse:Edit hook blocking error from command: fix it\n\nStop hook feedback: more")
+	if len(got) != 2 || got[0] != "PostToolUse:Edit hook blocking error from command: fix it" || got[1] != "Stop hook feedback: more" {
+		t.Fatalf("got %q", got)
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 0adadb156..931add459 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -6247,6 +6247,69 @@ func withTaskNotices(results []Part, msgs []Message) []Part {
 	return out
 }
 
+// withHookNotices hands the run what Claude Code's hooks told the model
+// beside the results (hookNotice: "PostToolUse:Write hook additional
+// context: …", "PostToolUse:Edit hook blocking error from command: …"), in
+// a reminder at the end of the last result. #2060 took them out of the
+// user's words, and with that they reached no one: a hook's feedback, a
+// PostToolUse hook's block, never got to the run's model. A hook's bare
+// "success" stays out: it says nothing to act on.
+func withHookNotices(results []Part, msgs []Message) []Part {
+	if len(results) == 0 {
+		return results
+	}
+	i := len(msgs)
+	for i > 0 && msgs[i-1].Role != "assistant" {
+		i--
+	}
+	var notices []string
+	seen := false
+	for _, m := range msgs[i:] {
+		if withImages(m) {
+			continue
+		}
+		for _, p := range m.Parts {
+			switch {
+			case p.Kind == ToolResult:
+				seen = true
+			case p.Kind == Text && seen:
+				notices = append(notices, hookNotices(p.Text)...)
+			}
+		}
+	}
+	if len(notices) == 0 {
+		return results
+	}
+	out := slices.Clone(results)
+	last := &out[len(out)-1]
+	if last.Text != "" {
+		last.Text += "\n\n"
+	}
+	last.Text += "<system-reminder>\n" + strings.Join(notices, "\n\n") + "\n</system-reminder>"
+	return out
+}
+
+// hookNotices is every hook's notice in a text, each up to the next one,
+// the reminder's end, a message of the user's or the token count.
+func hookNotices(text string) []string {
+	var out []string
+	starts := hookNoticeStart.FindAllStringIndex(text, -1)
+	for k, s := range starts {
+		end := len(text)
+		if k+1 < len(starts) {
+			end = starts[k+1][0]
+		}
+		n := text[s[0]:end]
+		if e := hookNoticeEnd.FindStringIndex(n); e != nil {
+			n = n[:e[0]]
+		}
+		if n = strings.TrimSpace(n); n != "" && !hookSuccess.MatchString(n) {
+			out = append(out, n)
+		}
+	}
+	return out
+}
+
 // skillBody is the text Claude Code sends after a Skill call's result:
 // the skill's SKILL.md, headed with where its files are.
 var skillBody = lazyre.New(`^Base directory for this skill: `)
@@ -6334,6 +6397,11 @@ var (
 	// these kinds: "Stop hook is broken: …" may be the user's.
 	hookNoticeLead = `[A-Z][A-Za-z]+(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):`
 	hookNotice     = lazyre.New(`^` + hookNoticeLead)
+	// hookNoticeStart finds a hook's notice anywhere in a text, hookNoticeEnd
+	// where one ends, hookSuccess the notice a hook gives with nothing to say
+	hookNoticeStart = lazyre.New(`(?m)^` + hookNoticeLead)
+	hookNoticeEnd   = lazyre.New(`\n\n(?:<total_tokens>|The user sent )|</system-reminder>`)
+	hookSuccess     = lazyre.New(`^[A-Z][A-Za-z]+(?::\S+)? hook success:`)
 	// tokenCount is Claude Code's count of the tokens left, or used.
 	tokenCount = lazyre.New(`^(?:<total_tokens>[^<]*</total_tokens>|Token usage: \S+; \S+ remaining)$`)
 	// reminderTag is a <system-reminder> tag, open or close.
@@ -7603,7 +7671,7 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, fro
 			run.allowed = allowedTools(req)
 			run.mu.Unlock()
 			run.adviseOn(r.Context(), req, s.adviceRound)
-			events, err = run.continueWith(withTaskNotices(withSkillBodies(results, req.Messages), req.Messages), saidWithResults(req.Messages), more)
+			events, err = run.continueWith(withTaskNotices(withSkillBodies(withHookNotices(results, req.Messages), req.Messages), req.Messages), saidWithResults(req.Messages), more)
 		}
 		if err != nil {
 			// it ended while it waited, or can't take the results: a new
-- 
2.50.1 (Apple Git-155)

```

Attribution: the fix is @mouettxy's (Nikita Chaikovsky, author kept on the commit); AI-written (GLM-5.3-Flash (ZCode)) only carried it onto the current main and ran the verification below.
