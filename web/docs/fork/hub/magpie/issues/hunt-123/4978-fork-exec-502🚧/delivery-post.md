**What's wrong**

A long auto-mode conversation on a Claude subscription, interactive mode on, dies on every turn with `502 Claude Code: fork/exec ~/.local/bin/magpie: argument list too long` (v0.1.2766, Linux x86_64; two users in the comments see the same). Claude Code asks again, every try fails the same way, and the conversation goes on nowhere — while shorter conversations on the same gateway and account work.

**Root cause**

The reporter's read of the source is right, and the code at today's tip (`c360d9d30`) still carries it: an interactive run is given its safeguards in one environment entry, `CLAUDE_CODE_EXTRA_BODY` (`startRun`), marshaled by `claudeExtraBody` with no size bound, read once by interactive Claude Code as it starts. The client's auto-mode classifier context grows turn by turn (`classifier_context.prior_turn_context` gains an entry every tool batch, #4804), and the kernel takes no exec argument or environment string longer than 32 pages — `MAX_ARG_STRLEN`, 131,072 bytes on Linux. Past that, every exec of the helper fails `E2BIG` with magpie's own binary named; the turn is answered 502 and the retry storm lands on the same wall each time.

Two findings beyond the report:

- The growth that *drove* the per-turn failure in the reported build is already gone from main: 3088872e6 (first released v0.1.2817, after the reporter's v0.1.2766) keeps an interactive run going when only Claude Code's varying classifier parts changed, so the run no longer restarts on every tool batch. But any *new* run start still receives the client's current safeguards in the one entry — a resumed conversation, a cancelled turn's replay, a change to what the user allows, an idle-evicted run's next turn — and in a 420k/470k-token conversation that entry is already past 128 KiB, so the hard failure stays reachable on main.
- The rest of the spawn surface is already out of this trap: the prompt and the settings updates go over stdin, the token and the system prompt go in files, and `--mcp-config` is a small constant. The only other sibling that rides one exec string is `--json-schema` (a client's answer schema, same 32-page bound) — unreported and untouched here.

**The fix**

A run whose safeguards entry cannot fit one environment string is refused *before* the exec, with the sizes said, instead of failing as a cryptic `fork/exec` after it:

- `maxArgStrlen` (131,072, the kernel's `MAX_ARG_STRLEN`) is the bound; the entry's length is `len("CLAUDE_CODE_EXTRA_BODY=") + len(tuiBody)`.
- Over it, `startRun` cleans up and returns a `tuiRefusal`: a 400, which no account is asked for and Claude Code does not ask again (#4778), instead of a 502 every account in turn retries into. The reply names the entry's size and the bound, so "argument list too long" no longer reads as a magpie bug unrelated to the conversation (the reporter's ask 2), and the log carries the size too.
- Print mode takes the same conversation with no such bound — its safeguards are handed over stdin — and `claudeTUIErr` already says where to turn the interactive mode off, so the refusal's own text carries the way out (the reporter's ask 1, its fallback form; the file-based delivery it prefers rests on whether interactive Claude Code applies a settings file's `env` as it starts, which nothing here can verify, so it is left to the maintainer).

The client now sees, in full: `Claude Code's interactive mode, on in Settings › Models › Replies, can't answer this request (its safety context is 200093 bytes as one environment entry, and one environment entry may not carry 131072 bytes or more), and magpie never runs it as claude -p instead; turned off there, every request runs as -p`.

Patch:

<details>
<summary>0001-claude-an-interactive-run-over-one-environment-entry-s.patch</summary>

```
From dc954ac28ee134d7a844a1e4f368eaecd8039034 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 03:43:01 +0800
Subject: [PATCH] claude: an interactive run over one environment entry's
 safeguards is refused before its exec (NickWilde18)

An interactive run is given its safeguards in one environment entry
(CLAUDE_CODE_EXTRA_BODY), read once as it starts. In a long auto-mode
conversation the classifier context the client sends grows turn by turn
(#4804), and where an exec argument or environment string carries at
most 32 pages (the kernel's MAX_ARG_STRLEN, 131072, on Linux), the exec
of the helper failed "argument list too long" naming magpie's own
binary: the turn was answered 502, Claude Code asked again, and every
try failed the same way, so the conversation went on nowhere (#4978).

Such a run is now refused before it is started, with the entry's size
and the bound said in the reply: a tuiRefusal, a 400 no account is asked
for and Claude Code does not ask again (#4778). The size is logged too.
Print mode takes the same conversation, its safeguards handed over
stdin, which carries no such bound.

Reported by NickWilde18 in #4978, with the sizes measured and the
environment entry named.

Fixes #4978

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_room_test.go          |  2 +-
 internal/gateway/claude_subscription.go       | 20 ++++++++++++++
 .../gateway/claude_tui_extra_body_test.go     | 26 +++++++++++++++++++
 3 files changed, 47 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/claude_room_test.go b/internal/gateway/claude_room_test.go
index 958ad43c8..a2c837d7b 100644
--- a/internal/gateway/claude_room_test.go
+++ b/internal/gateway/claude_room_test.go
@@ -84,7 +84,7 @@ func (h *resumeHarness) askCode(system string, said ...string) (int, string) {
 		}
 		msgs = append(msgs, fmt.Sprintf(`{"role":"user","content":%q}`, m))
 	}
-	body := `{"model":"claude-sonnet-5","max_tokens":100,"system":"` + system + `","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + strings.Join(msgs, ",") + `]}`
+	body := `{"model":"claude-sonnet-5","max_tokens":100,` + h.extra + `"system":"` + system + `","tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + strings.Join(msgs, ",") + `]}`
 	var u Usage
 	return h.s.serveClaudeSubscription(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, h.p, "claude-sonnet-5", []byte(body), &u)
 }
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 6004cebbc..d2ebbd00d 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -1141,6 +1141,18 @@ func (b *subscriptionBridge) startRun(ctx context.Context, req *Request, model,
 	tuiBody := ""
 	if tui && len(req.Safeguards) > 0 {
 		tuiBody = claudeExtraBody(req.Safeguards, "")
+		// The entry is one environment string, and the kernel takes no
+		// string that long: the exec failed "argument list too long" for
+		// magpie's own binary, the turn was answered 502, and Claude Code
+		// asked again, every try failing the same way, so the conversation
+		// went on nowhere (#4978). Refused here, the sizes are said, no
+		// account is asked for it (#4778), and print mode takes the same
+		// conversation, its safeguards handed over stdin.
+		if size := len("CLAUDE_CODE_EXTRA_BODY=") + len(tuiBody); size >= maxArgStrlen {
+			cleanup()
+			log.Printf("claude: the interactive run's safety context is %d bytes as one environment entry, and one carries at most %d; the run is refused", size, maxArgStrlen)
+			return nil, nil, &tuiRefusal{claudeTUIErr(fmt.Sprintf("its safety context is %d bytes as one environment entry, and one environment entry may not carry %d bytes or more", size, maxArgStrlen))}
+		}
 		env = append(env, "CLAUDE_CODE_EXTRA_BODY="+tuiBody)
 	}
 	if tui && (!client || configDir != "") {
@@ -1431,6 +1443,14 @@ func safeguardBody(raw json.RawMessage) string {
 	return claudeExtraBody(raw, "")
 }
 
+// maxArgStrlen is the most one exec argument or environment string carries
+// where the run is started: the kernel's MAX_ARG_STRLEN, 32 pages, on
+// Linux, the smallest per-string bound named here. Over it the exec fails
+// "argument list too long" (E2BIG) with magpie's own binary named, which
+// reads as a fault of magpie's, of the account's, or of the conversation's
+// size, none of which it is (#4978).
+const maxArgStrlen = 131072
+
 // claudeExtraBody passes the safety field and opted-in cache tail through
 // EXTRA_BODY. It leaves the CLI's own beta headers intact.
 func claudeExtraBody(raw json.RawMessage, tail string) string {
diff --git a/internal/gateway/claude_tui_extra_body_test.go b/internal/gateway/claude_tui_extra_body_test.go
index d18b26c9c..b9dbe398c 100644
--- a/internal/gateway/claude_tui_extra_body_test.go
+++ b/internal/gateway/claude_tui_extra_body_test.go
@@ -78,6 +78,32 @@ func TestClaudeTUISafeguardsInEnv(t *testing.T) {
 	}
 }
 
+// The interactive mode's Claude Code is given its safeguards in one
+// environment entry (CLAUDE_CODE_EXTRA_BODY), read once as it starts. In a
+// long auto-mode conversation the classifier context the client sends
+// grows turn by turn (#4804), and an entry over what one exec argument or
+// environment string may carry (the kernel's MAX_ARG_STRLEN, 32 pages, on
+// Linux) failed the exec "argument list too long" for magpie's own
+// binary: the turn was answered 502, Claude Code asked again, and every
+// try failed the same way, so the conversation went on nowhere (#4978).
+// Such a run is refused before it is started, with the sizes said, as a
+// 400 no account is asked for (#4778); turned to print mode, the same
+// conversation runs, its safeguards handed over stdin.
+func TestClaudeTUISafeguardsOverOneEnvEntryRefused(t *testing.T) {
+	h := tuiScriptHarness(t, `echo "extra ${CLAUDE_CODE_EXTRA_BODY-unset}" >> $log`)
+	h.extra = `"safeguards":[{"type":"dangerous_tool_use","classifier_context":"` + strings.Repeat("a", 200000) + `"}],`
+	code, msg := h.askCode("rules", "hi")
+	if code != 400 {
+		t.Fatalf("a run over one environment entry's bound was started: %d %s, want a refusal", code, msg)
+	}
+	if !strings.Contains(msg, "safety context") || !strings.Contains(msg, "environment entry") {
+		t.Fatalf("the refusal doesn't say the sizes: %s", msg)
+	}
+	if runs := h.runs(); len(runs) != 0 {
+		t.Fatalf("%d runs were started for a request refused before its exec", len(runs))
+	}
+}
+
 // Claude Code's auto-mode context changes on nearly every request in parts
 // of its own: the tool ids of the turns before, git's status, the
 // system-reminder ids. A turn whose safeguards differ only there goes on in
-- 
2.50.1 (Apple Git-155)

```

</details>

SHA-256 (first 16): `2a20e9fc4f361ee9`

**Verification**

| Check | Result |
| --- | --- |
| New test against the unfixed tip (`c360d9d30`, fix reverted, test kept) | red: the oversized run was started (200 on this machine, where no per-string bound bites; on Linux the same request is the reported `fork/exec … argument list too long`); the test wants a refusal and no run started, on every platform |
| New test with the fix | green: 400, the message names the safety context and the environment entry, and no run was started |
| Ablation (only the guard reverted, tests kept) | red; restored, green |
| Beside the pre-existing EXTRA_BODY family | `TestClaudeTUISafeguardsInEnv`, `TestClaudeTUISafeguardsVaryingPartsKeepTheRun`, `TestClaudeTUIClientCacheKeepsItsOwn` green unchanged |
| Full `internal/gateway` package, `-tags nogui`, one run | ok, 598.9s, nothing failed — this machine's known reds (`TestCodexPoolSaysTheClientsVersion`, `TestMothX`, `TestEveryRouteHasACommandOrIsNamed`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress`) did not fire this run |
| `-race` over the safeguards / interactive-mode spawn family | ok, 3.8s |
| `gofmt -l` on the three changed files; `go vet -tags nogui ./internal/gateway`; `go build ./...` | clean; clean; ok |

**Not verified + AI use**

Not verified: the `E2BIG` itself was not reproduced on this machine (darwin/arm64 has no per-string `MAX_ARG_STRLEN`, and no Linux box, Claude Max account or 470k-token conversation was run) — the guard fires on the entry's length before any exec, which the test pins on every platform; the reporter's own measurements (11–14 KB on short conversations, growing) and the kernel's bound carry the Linux side. The failure's reach on main after 3088872e6 is read from the code (which run starts receive the current safeguards), not measured on a long conversation. The file-based delivery the reporter prefers — safeguards through a `--settings` file's `env` — is not attempted: whether interactive Claude Code applies a settings file's env as it starts is not verifiable here, and silently dropping safeguards is not an option. Sibling left as it is: `--json-schema` rides one exec string too (same 32-page bound, no report); prompt, token and system prompt already go over stdin or files. Not run: the rest of the repository's packages (the change is inside `internal/gateway` alone), GUI tests.

Written by GLM-5.3-Flash (ZCode) — AI-written; author is ggbdpq <ggbdpq@gmail.com> alone, no Co-authored-by.

Branch: https://github.com/ggbdpq/magpie/tree/fix/4978-fork-exec-502 (head `dc954ac28ee134d7a844a1e4f368eaecd8039034`)
