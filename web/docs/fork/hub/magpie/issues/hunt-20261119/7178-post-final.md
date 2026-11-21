Following the reporter's chain, this patch keeps a skill's body from pushing the Skill call's result past Claude Code's persistence line: the body is cut to fit, with a word of what was left out, so the model still reads the skill's head and the client never swaps the result for a reference to a file it cannot open.

**Root cause:** `withSkillBodies` hands the run each skill's SKILL.md in the Skill call's result (#5403 — without it the model loads a skill and never sees what it says). Claude Code persists a text result above 50,000 characters to a file on its own home and gives the model a reference instead; the reporter's skill was about 77,000 characters, and the reference's path (`~/.claude/projects/<gateway-project>/<session>/tool-results/mcp-magpie-Skill-….txt`) sits under the **gateway's** project and session — a client on another computer (macOS client, Linux Docker gateway) finds no such file, and both the skill's content and the turn's next step were lost with it. The gateway file itself was not checked by the reporter; the chain from `withSkillBodies` (claude_subscription.go) through `mcpResult` is read off the code here, and the reporter's transcript carries the dead reference.

**The fix:** the body handed to a result is cut so the result stays under the line (`clientResultLine`, 50,000 bytes — bytes bound characters from above, so cutting to a byte count cannot leave the result over the line), with a closing word: `(the rest of the skill's body was left out: a result this long would be saved to a file the client cannot read)`. A body that fits is handed whole, unchanged. The line guards only what magpie adds — a tool result that is over the line on its own is the tool's, and stands as it did. The reporter's own framing stands: larger results still need a way to be read from the correct host, which is a design beyond this cut.

**Source:** reported in #7178 with the transcript (the `Skill` load, the `Bash` and `Read` misses on the `mcp-magpie-Skill-` file) and the code chain; the new test replays the cut at the package's own table.

**Red without the fix:** `TestSkillBodyKeepsTheResultUnderThePersistenceLine` (new) — `an 80,081-byte result: it will be saved to the client's home, where the reference reads nothing`.

**Siblings:** `TestSkillBodyReachesTheSkillResult` and `TestSkillBodiesTwoSkills` pass unchanged (a body that fits is untouched, and the #5403 semantics — the body rides the Skill result, not the user's words — stand). `mcpResult` is unchanged: it says what the result says. The images face of `mcpResult` carries URLs as text already, and a result of its own over the line is out of this patch's reach.

| Check | Result |
| --- | --- |
| `TestSkillBodyKeepsTheResultUnderThePersistenceLine` | Green at final head (an 80,000-byte body cut under the line with the word said; a fitting body handed whole); without the fix: `an 80,081-byte result: it will be saved to the client's home, where the reference reads nothing` |
| Ablation (the cut reverted, test kept) | Same failure; restored, green |
| `TestSkillBodyReachesTheSkillResult`, `TestSkillBodiesTwoSkills` | Pass unchanged |
| Targeted `-race` (`TestSkillBody*`) | Pass |
| `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/` | Exit 1 with the three pre-existing failures the #7182 verification lists (`TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` and the two `TestOpenAIProvider` socket tests, all failing on the bare base); nothing else, 894.9s |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Actual rebase onto `ddfc9b17d` | Clean; `git range-diff` `=` (no drift) |
| Strict `git am` on `ddfc9b17d` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** against a live cross-host Claude Code — the 50,000-character line and the reference path are the reporter's citation of Claude Code's documented behavior, and the fix's cut is asserted at the gateway's own table; a same-host gateway (client and gateway sharing a home) reads the reference fine and now sees a cut body instead, which is the price of the line holding for both.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7178-skill-spill-explicit](https://github.com/ggbdpq/magpie/tree/fix/7178-skill-spill-explicit), head `911a1cb64b79c70ebbcfaa6eced9af3d304bc058`.

<details><summary>patch: gateway: a skill's body is cut to keep its result under the client's persistence line (#7178) — git am applies it as is; SHA-256 first 16: 220e3b4e6bb6098b</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 20 Nov 2026 02:44:23 +0800
Subject: [PATCH] gateway: a skill's body is cut to keep its result under the
 client's persistence line (#7178)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: withSkillBodies hands the run each skill's SKILL.md in the
Skill call's result (#5403). A skill whose body pushes that result past
50,000 characters — the reporter's was about 77,000 — had it saved by
Claude Code to a file on its own home and replaced in the model's hands
by a reference to it, under the gateway's project and session: a path
the client cannot read (the reporter's Bash and Read both found nothing
there, and the skill's content was lost with it). The body is now cut to
keep the result under the line, with a word of what was left out; a body
that fits is handed whole, as before.

Run: TestSkillBodyKeepsTheResultUnderThePersistenceLine (new) fails
without the fix (an 80,081-byte result: it will be saved to the client's
home, where the reference reads nothing) and passes with it, the
body-that-fits case included; TestSkillBodyReachesTheSkillResult and
TestSkillBodiesTwoSkills pass unchanged. See the issue post for the
matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_skill_body_test.go | 36 ++++++++++++++++++++++
 internal/gateway/claude_subscription.go    | 12 ++++++++
 2 files changed, 48 insertions(+)

diff --git a/internal/gateway/claude_skill_body_test.go b/internal/gateway/claude_skill_body_test.go
index 7f1631c2b..75d5326ca 100644
--- a/internal/gateway/claude_skill_body_test.go
+++ b/internal/gateway/claude_skill_body_test.go
@@ -101,3 +101,39 @@ func TestSkillBodyRealClaudeCode(t *testing.T) {
 		t.Fatalf("said as the user's: %q", said)
 	}
 }
+
+// A skill whose body pushes the result past Claude Code's persistence
+// line: the client saves a text result above 50,000 characters to a file
+// on its own home and hands the model a reference instead — under the
+// gateway's project and session, which a client on another computer
+// cannot read (the reporter's Bash and Read both found nothing there,
+// #7178). The body is cut to keep the result under the line, with a word
+// of what was left out; a body that fits is handed whole, as before.
+func TestSkillBodyKeepsTheResultUnderThePersistenceLine(t *testing.T) {
+	build := func(body string) ([]Part, []Message) {
+		msgs := []Message{
+			{Role: "user", Parts: []Part{{Kind: Text, Text: "run the skill"}}},
+			{Role: "assistant", Parts: []Part{{Kind: ToolCall, CallID: "c1", Name: "Skill"}}},
+			{Role: "user", Parts: []Part{
+				{Kind: ToolResult, CallID: "c1", Text: "Launching skill: big"},
+				{Kind: Text, Text: body},
+			}},
+		}
+		return msgs[2].Parts[:1], msgs
+	}
+	long := "Base directory for this skill: /home/u/.claude/skills/big\n\n" + strings.Repeat("x", 80_000)
+	results, msgs := build(long)
+	got := withSkillBodies(results, msgs)
+	if len(got[0].Text) > 50_000 {
+		t.Fatalf("a %d-byte result: it will be saved to the client's home, where the reference reads nothing", len(got[0].Text))
+	}
+	if !strings.Contains(got[0].Text, "left out") {
+		t.Fatalf("the cut was not said: %q", got[0].Text[len(got[0].Text)-200:])
+	}
+	short := "Base directory for this skill: /home/u/.claude/skills/small\n\nUse it well."
+	results, msgs = build(short)
+	got = withSkillBodies(results, msgs)
+	if !strings.HasSuffix(got[0].Text, "Use it well.") {
+		t.Fatalf("a body that fits was cut: %q", got[0].Text)
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 85a6ce53b..3c41e914d 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -6237,6 +6237,15 @@ var skillBody = lazyre.New(`^Base directory for this skill: `)
 // as a text block after the results; since #5403 that text counts as the
 // agent's (desktopNote), not the user's, and was handed to no one, so the
 // run's model loaded a skill and never saw what it says.
+// clientResultLine is where Claude Code stops reading a tool result and
+// saves it to a file on its own home instead, handing the model a
+// reference — under the gateway's project and session, which a client on
+// another computer cannot read (#7178). A skill's body is cut to keep
+// the result it rides under this.
+const clientResultLine = 50_000
+
+const skillBodyCut = "\n\n(the rest of the skill's body was left out: a result this long would be saved to a file the client cannot read)"
+
 func withSkillBodies(results []Part, msgs []Message) []Part {
 	if len(results) == 0 {
 		return results
@@ -6285,6 +6294,9 @@ func withSkillBodies(results []Part, msgs []Message) []Part {
 				if k < 0 {
 					k = len(out) - 1
 				}
+				if room := clientResultLine - len(out[k].Text) - len(skillBodyCut) - 2; len(body) > room {
+					body = body[:room] + skillBodyCut
+				}
 				if out[k].Text != "" {
 					out[k].Text += "\n\n"
 				}
-- 
2.50.1 (Apple Git-155)

```

</details>

