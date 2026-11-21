Pinned the passthrough leg to both halves of the thinking-back mechanism — verdict: **no code change needed on current magpie; the second half of the fix landed after 0.1.1984**. (hellowind777 your diagnosis was right on both counts — it is the #1462 shape, and the placeholder fill is exactly what handles it.)

**What the trace shows**

Your request goes through magpie's passthrough leg (client Anthropic → upstream Anthropic, relayed as it came). Two mechanisms fill the missing `content[].thinking` on that leg, and both hang off `forwardOnce`, which the passthrough and the translated leg go through alike:

1. **Static gate** (`anthropicReplaysThinking`, #1611, first in v0.1.1198): fills the tool turns at once for a model whose name — or whose wire name — says "deepseek". Your `deepseek-v4.1-flash-1017` is covered here; so were the zhipu and api.deepseek.com sessions in your routing-log table (0 of 42 and 0 of 245 refused).
2. **Learned gate** (`refuseThinkingBack` / `withThinkingBack`, qisishiqi's report, first in **v0.1.2707**): a model whose name says nothing (a glm-5.3-flash alias, a claude-named seat on the relay) is learned from the 400 itself — asked once more with a space-filled thinking block, then filled from then on, and a provider that never asks is never sent one.

**Why 0.1.1984 still showed the 400**: that version has the static gate but predates the learned one (0.1.1984 is 2026-10-29; the learned gate landed 2026-11-02, v0.1.2707). On 0.1.1984 the fill only ran while a name said deepseek — a seat named otherwise went out bare, and a strict GLM-family relay refused the whole request. Anthropic's protocol allows the history back with no thinking block, so Claude Code's retry after a stream break, Esc-continue and post-compact turns are legitimate requests, not client misuse.

**Verified on current main** (`df7c94bdf`), against a fake upstream that refuses with your 400's own wording:

| model name | first ask | next ask |
|---|---|---|
| `deepseek-v4.1-flash-1017` | filled, 200 on call 1 | 200 on call 1 |
| `glm-5.3-flash` | 400 → refilled, 200 on call 2 | 200 on call 1 (learned) |
| `claude-sonnet-4-6` | 400 → refilled, 200 on call 2 | 200 on call 1 (learned) |

The thinking block is asserted off the wire the upstream actually received (`messages.#(role=="assistant").content[0].type == "thinking"`, thinking = a space, the only placeholder DeepSeek-family endpoints take). Full `internal/gateway` suite (`-tags nogui`): ok in 601s; the four thinking-back tests also green under `-race`; gofmt/vet/build clean.

**What to do**: update magpie past **v0.1.2707** — the learned gate covers exactly your relay shape, model name or none. If a relay still refuses after that, it is a new refusal wording and a fresh report would be welcome.

<details>
<summary>Patch (test pinning the passthrough leg, `git am` format) — SHA-256 (first 16): <code>a4e9542517e71f74</code></summary>

```patch
From 709d2456d20a887c6be4a8968b61e9cd8fdc6695 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 09:38:41 +0800
Subject: [PATCH] gateway: an Anthropic tool turn relayed as it came goes with
 the thinking a GLM relay asks back (#4165)

An Anthropic client continuing a tool round it has no thinking for - a
turn another model made (a routing group's fall, a retry after a broken
stream, a compact) - was refused whole by a GLM-family relay on its
Anthropic endpoint: 400 "The `content[].thinking` in the thinking mode
must be passed back to the API" (hellowind777, magpie 0.1.1984). The
request was relayed as it came (passthrough), so the Messages builder's
fill didn't run.

What was there already, and what each covers, checked against
upstream/main df7c94bdf:

- withThinkingOnToolTurns filled the tool turns of a relayed request
  since 9ce12eec7 (v0.1.1198, #1611) for a model whose name or wire name
  says DeepSeek (anthropicReplaysThinking).
- refuseThinkingBack learned it from the refusal itself since
  4bd0d6f38 (v0.1.2707, qisishiqi): asked once more with the thinking
  filled in, and from then on at once - on the passthrough leg too, the
  fill hanging off forwardOnce, which both legs go through. 0.1.1984
  predates that, and its relay's model (deepseek-v4.1-flash-1017) was
  filled at once besides: the two names its session shows working
  (zhipu, api.deepseek.com) are the hosts that gate covers.

So this lands as the test pinning the passthrough leg to both halves of
the mechanism: a DeepSeek-named model filled on the first ask, a
glm-5.3-flash-named one and a claude-sonnet-named one learned from the
refusal (one extra ask, then filled at once), and the thinking block
read back off the wire the upstream got. A provider that never asked is
sent none. No product code changed.

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gateway/thinking_back_passthrough_test.go | 106 ++++++++++++++++++
 1 file changed, 106 insertions(+)
 create mode 100644 internal/gateway/thinking_back_passthrough_test.go

diff --git a/internal/gateway/thinking_back_passthrough_test.go b/internal/gateway/thinking_back_passthrough_test.go
new file mode 100644
index 000000000..35e3fa946
--- /dev/null
+++ b/internal/gateway/thinking_back_passthrough_test.go
@@ -0,0 +1,106 @@
+package gateway
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// glmRefuseThinkingBack plays a GLM-family relay's Anthropic endpoint
+// (tokenrhythm.studio, #4165): thinking on, an assistant tool turn with
+// no thinking block turns the whole request away, word for word as the
+// reporter's 400 said. Unlike deepseekRefuseAnthropic it takes neither a
+// redacted_thinking nor a bare tool_use, and a plain reply is taken.
+func glmRefuseThinkingBack(body []byte) (int, string) {
+	var q struct {
+		Messages []struct {
+			Role    string          `json:"role"`
+			Content json.RawMessage `json:"content"`
+		} `json:"messages"`
+	}
+	json.Unmarshal(body, &q)
+	afterTool := false
+	for _, m := range q.Messages {
+		var blocks []struct {
+			Type string `json:"type"`
+		}
+		json.Unmarshal(m.Content, &blocks)
+		after := afterTool
+		afterTool = m.Role == "user" && len(blocks) > 0
+		thought, called := false, false
+		for _, b := range blocks {
+			afterTool = afterTool && b.Type == "tool_result"
+			switch b.Type {
+			case "thinking":
+				thought = true
+			case "tool_use":
+				called = true
+			}
+		}
+		if m.Role == "assistant" && (called || after) && !thought {
+			return 400, `{"error":{"message":"基元: The ` + "`content[].thinking`" + ` in the thinking mode must be passed back to the API. (request_id: 3f0b7c0c-66a3-4a4e-8f1d-561ae82608e2)","type":"invalid_request_error"}}`
+		}
+	}
+	return 0, ""
+}
+
+// glmToolTurnNoThinking is Claude Code's continuation of a tool round it
+// has no thinking for: the turn another model made (a routing group's
+// fall, a retry after a broken stream, a compact), Anthropic's protocol
+// allowing the history back with no thinking block. The model is named
+// as the client named it, which says neither DeepSeek nor a vendor's
+// anything: the wire, if any, names it upstream alone.
+const glmToolTurnNoThinking = `{"model":"%s","max_tokens":4096,"stream":true,"thinking":{"type":"adaptive"},
+	"tools":[{"name":"Read","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}}}}],
+	"messages":[
+	{"role":"user","content":[{"type":"text","text":"read a.go"}]},
+	{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.go"}}]},
+	{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"package a"}]}]}`
+
+// The reporter's own direction (#4165): an Anthropic client's tool round
+// relayed as it came (passthrough) to a GLM-family relay which asks the
+// assistant tool turn's thinking back and turns the whole request away
+// without it. A model whose name says DeepSeek is filled at once
+// (anthropicReplaysThinking, #1611); one whose name and host say nothing
+// is learned from the refusal (thinking_back.go, qisishiqi), asked once
+// more with a space for it, and from then on sent it at once; a provider
+// that never asked is sent none.
+func TestThinkingBackLearnedOnPassthrough(t *testing.T) {
+	for _, c := range []struct {
+		model string
+		calls int // the first request's: filled at once, or learned on the second
+	}{
+		{"deepseek-v4.1-flash-1017", 1},
+		{"claude-sonnet-4-6", 2},
+		{"glm-5.3-flash", 2},
+	} {
+		t.Run(c.model, func(t *testing.T) {
+			f := &fake{t: t, reply: thinkingBackStream, refuse: glmRefuseThinkingBack}
+			up := setup(t, provider.Anthropic, f)
+			p := provider.Provider{ID: "glmrelay", Name: "GLM Relay", Models: []string{c.model}}
+			p.Name, p.Key, p.Anthropic = p.ID, "k", up.URL
+			if err := provider.Save(p); err != nil {
+				t.Fatal(err)
+			}
+			srv := New()
+			code, body := postTo(t, srv, "/v1/messages", strings.Replace(glmToolTurnNoThinking, "%s", "glmrelay/"+c.model, 1))
+			if code != 200 || f.calls != c.calls {
+				t.Fatalf("%s: %d after %d calls, want 200 on the %dth: %s", c.model, code, f.calls, c.calls, body)
+			}
+			turn := gjson.GetBytes(f.got, `messages.#(role=="assistant")`)
+			if th := turn.Get(`content.#(type=="thinking")`); th.Get("thinking").String() != noReasoning || turn.Get("content.0.type").String() != "thinking" {
+				t.Errorf("%s: the tool turn went as %s, want a thinking block first", c.model, turn.Raw)
+			}
+
+			// learned: the next request is taken the first time
+			f.calls = 0
+			if code, body = postTo(t, srv, "/v1/messages", strings.Replace(glmToolTurnNoThinking, "%s", "glmrelay/"+c.model, 1)); code != 200 || f.calls != 1 {
+				t.Fatalf("%s: %d after %d calls, want 200 on the first: %s", c.model, code, f.calls, body)
+			}
+		})
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

- Branch: https://github.com/ggbdpq/magpie/tree/fix/4165-passthrough-thinking (head 709d2456d20a887c6be4a8968b61e9cd8fdc6695)
- Test-only commit: author **ggbdpq**; Attribution: written by AI (GLM-5.3-Flash via ZCode), keep author ggbdpq.

