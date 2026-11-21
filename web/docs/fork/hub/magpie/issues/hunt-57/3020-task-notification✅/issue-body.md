## Summary

Through the Claude subscription bridge, a background task's `<task-notification>` never reaches the model. Claude Code sends the notification with the next request — the same one that carries the finished tools' results — and the bridge hands the waiting run the results plus only what it reads as the user's words. The notification falls through two filters built for the other tail notices and is dropped, so the model answers as if no task had ended: the main session "waits forever" on a subagent that finished. Direct connections show the notification; this reproduces with masking off, so `redact` is not a factor.

## Cause

The drop is in the Claude bridge's resume path, `saidWithResults` (internal/gateway/claude_subscription.go:3257):

1. Claude Code 2.1.296+ puts the texts that trail a turn's results — hooks' notices, the `<total_tokens>` count, a mid-turn user message — into one `{role: "system"}` message after the results (captured in #2060). A background task's `<task-notification>` travels the same way; the reporter's routing log shows it: a `harness` item of notification size appears in the request's `system` part exactly when the notification is due, beside `results=[Agent, Bash]` — the system message arriving with the results.
2. When the results answer calls a run is waiting on, the bridge resumes it with `continueWith` (internal/gateway/claude_subscription.go:3366): the tool results over MCP, plus `saidWithResults` queued first as a user message (`queue`, internal/gateway/claude_subscription.go:3424).
3. `saidWithResults` skips a system message outright (`case m.Role == "system" || m.Role == "developer"`, internal/gateway/claude_subscription.go:3273 — right for hook notices, #2060) and drops texts its `agentNotice` knows (internal/gateway/claude_subscription.go:3274) — and `agentNotice`'s injected leads include `"<task-notification>"` (internal/gateway/prompt.go:655), put there for turn reading, not delivery. Either shape of the notification — the system message, or the older client's user message of its own — is filtered out. The inner model is never told.
4. Every other path tells it: a run started anew is told the whole conversation, every message rendered (renderClaudePrompt, internal/gateway/claude_subscription.go:2598; renderClaudeTurn, internal/gateway/claude_subscription.go:2886), and a relayed request passes the body as sent. Only the run kept for the results — the common case of a foreground wait, as in the reporter's probe — loses it. That matches the A/B: 2/2 `SEEN` direct, 3/3 `NOT_SEEN` through magpie, with the client's own stream-json emitting the notification on both sides.

## Fix

`saidWithResults` now tells the run a text that carries the notification: a `taskNotice` case (a contains on `<task-notification>`) ahead of the system-message and `agentNotice` cases. Hooks' notices and token counts stay out — #2060's tests are unchanged and hold. The notification is queued to the run's Claude Code as its own message, so the model hears of the finished task the way it does on a request that carries the notification alone.

## Verification

| Check | Command | Result |
|---|---|---|
| Red on base | `go test ./internal/gateway/ -run TestClaudeTaskNotificationGoesOnWithTheResults -count=1` at `f5b01574` | FAIL, both shapes (below) |
| Directed, fixed | same `-run` plus the #2060 and turn tests, `-count=1 -v` | all pass |
| Ablation | fix reverted → red as on base; re-applied → green; `taskNotice` forced `false` → red; restored → green | as expected, each step |
| Race | `go test -race ./internal/gateway/ -run 'TestClaudeTaskNotificationGoesOnWithTheResults|TestClaudeHookNotices|TestClaudeUsersMessageAmongHookNoticesGoesOnAlone|TestTurnInSkipsWhatTheAgentPutIn|TestIntentHoldsPastWhatTheAgentPutIn' -count=1` | ok (2.148s) |
| Format, vet | `gofmt -l` on both touched files; `go vet ./internal/gateway/` | clean |
| Build | `go build ./...` on darwin/arm64; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`; `GOOS=windows GOARCH=amd64 go build ./...` | all ok |
| Full package | `go test ./internal/gateway/ -count=1 -p 1 -timeout 30m` | ok (320.989s) |

## Not verified

- End to end with a real Claude Code 2.1.303 against a Claude subscription: 2.1.303's exact notification bytes are inferred from #2060's captured 2.1.296 shapes and the reporter's routing-log segments, not captured here. The tests cover both known shapes (the system message, and the older user message).
- The direct-connection side (no magpie) is the reporter's A/B, not re-run here.

---

**Source**: reported in #3020 (WardLu, with an A/B probe and routing-log segments)

**Red without the fix** (base `f5b01574`):

```text
=== RUN   TestClaudeTaskNotificationGoesOnWithTheResults
=== RUN   TestClaudeTaskNotificationGoesOnWithTheResults/in_the_system_message
    claude_hook_notice_test.go:85: Claude Code was written [], want the task-notification
=== RUN   TestClaudeTaskNotificationGoesOnWithTheResults/a_message_of_its_own
    claude_hook_notice_test.go:85: Claude Code was written [], want the task-notification
--- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults (0.00s)
    --- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults/in_the_system_message (0.00s)
    --- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults/a_message_of_its_own (0.00s)
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.174s
```

**Siblings**: the gates live only in the Claude bridge — no other bridge reads `saidWithResults`/`agentNotice` (rg over internal/gateway: no consumers in the Codex, OpenCode or desktop subagent paths). The fresh-run prompt path writes the text either way (guard test `TestClaudePromptToldTheTaskNotification` passes on base too); `match` takes only tool results and images, unchanged; `parseAnthropicRequest`'s block-type switch drops unknown block types on translated routes only, and the notification rides in text blocks; `prompt.go`'s `injected` list is observation and turn detection, not delivery, and is untouched.

**When the read fails**: `taskNotice` is a contains on the text part, so a malformed or absent `<task-notification>` falls through to the unchanged filters — skipped as before, no new failure path. `queue`'s timeout path is untouched: if the run's Claude Code never acknowledges the queued message, the results still go on after 2s.

**Not verified**: end to end through a real bridge with a real Claude Code 2.1.303 and a real Claude subscription; the direct-connection side of the A/B.

Branch with the commit: [hunt57-c-task-notification](https://github.com/ggbdpq/magpie/tree/hunt57-c-task-notification) (head `d0a9ef61745d9d9900e26e7c32d05ecb7dacd303`).

**Attribution**: AI-written; the analysis, patch and tests were produced by a coding agent against the repository's own tests and fixtures, and every claim above carries the command that checked it. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: single commit on `f5b01574`, two files, +51/−0. SHA-256 first 16: `b61928472f034f1c`

```patch
From d0a9ef61745d9d9900e26e7c32d05ecb7dacd303 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 21:35:29 +0800
Subject: [PATCH] gateway: saidWithResults no longer drops a background task's
 notice, so a background task-notification survives the trip (#3020)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Claude Code sends a background task's <task-notification> with the next
request: in the {role: "system"} message 2.1.296+ puts its other tail
notices in (#2060), or, older clients, as a text of its own. Through the
Claude subscription bridge, the run waiting on the request's tool results
is handed the results and the words said beside them (saidWithResults)
alone: the system-message case left the notification out, and so did
agentNotice, whose injected leads hold "<task-notification>" from
prompt.go's turn reading. The model went on as if no task had ended, and
a foreground wait on the task had nothing to wait for — the A/B of #3020:
2/2 SEEN direct, 3/3 NOT_SEEN through magpie. A run started anew is told
the whole conversation, notification included; only the run kept for the
results lost it.

saidWithResults tells the run a text that carries the notification
(taskNotice, a contains on the tag) before the system-message and
agentNotice cases; hooks' notices and token counts stay out (#2060's
tests hold).

What changed:
- internal/gateway/claude_subscription.go: taskNotice, and a
  saidWithResults case for it before the two gates; the doc comment says
  where the notification travels and why the run hears of it.
- internal/gateway/claude_hook_notice_test.go: the notification goes on
  with the results in both shapes (red on base f5b01574:
  "Claude Code was written [], want the task-notification"), and a run
  started anew is told it in its prompt.

Run (GOTOOLCHAIN=auto, darwin/arm64):
- go test ./internal/gateway/ -run 'TestClaudeTaskNotificationGoesOnWithTheResults|TestClaudePromptToldTheTaskNotification|TestClaudeHookNotices|TestClaudeUsersMessageAmongHookNoticesGoesOnAlone|TestClaudePromptToldHookNoticesNotAsTheUsers|TestAgentNoticeLeavesTheUsersWords' -count=1 -v: all pass; the two new ones fail on base.
- Ablated: the fix reverted, the two fail as on base; restored, they pass.
  taskNotice forced false, both fail; restored, they pass.
- go test -race on the same -run: ok. gofmt -l on both files: clean.
  go vet ./internal/gateway: clean.
- go build ./... on darwin/arm64, GOOS=linux GOARCH=amd64 -tags nogui,
  GOOS=windows GOARCH=amd64: all ok.
- go test ./internal/gateway/ -count=1 -p 1 -timeout 30m: ok (320.989s).
- Not tried: end to end with a real Claude Code 2.1.303 on a Claude
  subscription. 2.1.303's exact notification bytes are inferred from
  #2060's captured 2.1.296 shapes and the reporter's routing log, not
  captured here.

Fixes #3020

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_hook_notice_test.go | 34 +++++++++++++++++++++
 internal/gateway/claude_subscription.go     | 17 +++++++++++
 2 files changed, 51 insertions(+)

diff --git a/internal/gateway/claude_hook_notice_test.go b/internal/gateway/claude_hook_notice_test.go
index 9768fd5a..54d97b7b 100644
--- a/internal/gateway/claude_hook_notice_test.go
+++ b/internal/gateway/claude_hook_notice_test.go
@@ -36,6 +36,13 @@ const (
 		`{"type":"text","text":"<system-reminder>\n</system-reminder>"}]}]}`
 )
 
+// A background task's completion beside the results (#3020): in the system
+// message 2.1.296+ sends, and as 2.1.296 sent one, a user message of its own.
+var (
+	ccTaskNotificationSystem = hookCallStart + `{"role":"system","content":[{"type":"text","text":` + quote(taskNotification) + `}]}]}`
+	ccTaskNotificationOwn    = hookCallStart + `{"role":"user","content":` + quote(taskNotification) + `}]}`
+)
+
 // A hook's notices and the token count after a tool's results are Claude
 // Code's, not a message of the user's: the results go on in their run with
 // nothing written to its Claude Code as the user's, which told its model
@@ -64,6 +71,33 @@ func TestClaudeUsersMessageAmongHookNoticesGoesOnAlone(t *testing.T) {
 	}
 }
 
+// A background task's <task-notification> rides with the results the way
+// the notices do (#3020): 2.1.303 sends it in the system message beside
+// them; 2.1.296 sent it as a text of its own. It is not the user's words,
+// but the run's model is to hear of the task: a request that carries it
+// alone tells a run started anew it whole, so the run kept for the results
+// hears it too.
+func TestClaudeTaskNotificationGoesOnWithTheResults(t *testing.T) {
+	for name, body := range map[string]string{"in the system message": ccTaskNotificationSystem, "a message of its own": ccTaskNotificationOwn} {
+		t.Run(name, func(t *testing.T) {
+			_, said, _ := continuing(t, body)
+			if len(said) != 1 || !strings.Contains(said[0], "<task-notification>") {
+				t.Fatalf("Claude Code was written %q, want the task-notification", said)
+			}
+		})
+	}
+}
+
+// A run started anew is told the notification with the conversation, as it
+// is told every message (#3020): the run kept for the results is the one
+// that lost it.
+func TestClaudePromptToldTheTaskNotification(t *testing.T) {
+	got := promptText(t, parsed(t, ccTaskNotificationSystem))
+	if !strings.Contains(got, "<task-notification>") {
+		t.Fatalf("the notification isn't told a run started anew:\n%s", got)
+	}
+}
+
 // A run started anew, or a turn resumed, is told a notice after a result
 // with the result closed, not marked as the user's.
 func TestClaudePromptToldHookNoticesNotAsTheUsers(t *testing.T) {
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 656d9a86..cf87c864 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -3254,6 +3254,13 @@ func (r *subscriptionRun) untold(tools []Tool) (int, string) {
 // with a message the user sent mid-turn among them (midTurnSaid): only
 // those words are the user's. A system message is never the user's
 // otherwise.
+//
+// A background task's <task-notification> travels with them (#3020), in
+// the system message or as a text of its own. It is not the user's either,
+// but the run is told it (taskNotice): a request that carries it alone
+// tells a run started anew the whole conversation, and the model answered
+// as if no task had ended when the run kept for the results heard nothing
+// of it.
 func saidWithResults(msgs []Message) string {
 	i := len(msgs)
 	for i > 0 && msgs[i-1].Role != "assistant" {
@@ -3270,6 +3277,8 @@ func saidWithResults(msgs []Message) string {
 			case p.Kind != Text || !results || captions:
 			case midTurnHead.MatchString(p.Text):
 				said = append(said, midTurnSaid(p.Text)...)
+			case taskNotice(p.Text):
+				said = append(said, p.Text)
 			case m.Role == "system" || m.Role == "developer":
 			case !agentNotice(p.Text):
 				said = append(said, p.Text)
@@ -3282,6 +3291,14 @@ func saidWithResults(msgs []Message) string {
 	return strings.Join(said, "\n\n")
 }
 
+// taskNotice is a background task's notice, a <task-notification>: Claude
+// Code sends it with the request that carries the results, in the system
+// message beside the notices (#3020), or, older clients, as a text of its
+// own. Not the user's words, but the run's model is to hear of the task:
+// told nothing of it, the model went on as if no task had ended, and a
+// foreground wait on the task found nothing to wait for.
+func taskNotice(text string) bool { return strings.Contains(text, "<task-notification>") }
+
 var (
 	// midTurnHead heads a message the user sent while a tool ran, as
 	// Claude Code tells its model one: "The user sent a new message while
-- 
2.50.1 (Apple Git-155)
```
