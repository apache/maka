Could not reproduce this one: the `[1m]` mark never reaches an upstream — the relay is asked for the bare id. Two layers take it off:

1. **Claude Code drops it before asking.** `[1m]` is Claude Code's own convention for a 1M window; a build that knows the mark sends the plain id in the request body.
2. **magpie's gateway drops it regardless.** Everything Claude Code sends while it runs on magpie goes through the gateway, and the one place a model is resolved there — `provider.Resolve` — takes the mark off whatever id comes in, before anything is asked. That holds on every route: a relay speaking Anthropic's API itself, an OpenAI-compatible one (New API, litellm) the request is translated for, `count_tokens` too. So the body that leaves magpie carries `claude-opus-4.6-us`, never `claude-opus-4.6-us[1m]`.

The mark lives only in what magpie writes on this machine: `settings.json`, the `/model` picker, the `/v1/models` listing Claude Desktop reads. Taking it off there would hand the 200K thrash back to older Claude Code builds — the reason you noted yourself — so I would keep it.

Tests: `internal/gateway/claude_dashed_test.go` already holds a native relay to the dotted id when asked `relay/claude-opus-4-6-us[1m]`. I have added one for the shape you named (New API / litellm, OpenAI-compatible): a relay and a native Anthropic relay, both models of a 1M window, asked by the marked ids magpie writes — both upstreams are held to the bare id. With the strip lifted from `provider.Resolve` the new test fails with your exact symptom (`the relay asked for "claude-opus-4.6-us[1m]"`). Patch below.

If a `[1m]` really did reach your relay, I would like to pin down where it came from:

- which magpie version, and was Claude Code routed through magpie (`ANTHROPIC_BASE_URL` = magpie's gateway) or pointed at the relay directly? Pointed directly, magpie writes nothing into that `settings.json` — every write is gated on the routing — so the marked id would have been set by hand.
- the request magpie's Routing / usage log archived for a failing call: its `model` field is what actually went out.

A client that is not Claude Code, pointed straight at the relay with an id copied from magpie's UI, would send the label as it is — that request never goes through magpie, so there is nothing on magpie's way to strip.

---

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details>
<summary>patch: gateway tests: the [1m] id an agent asks a relay by reaches it bare (#5058) — git am applies it as is; SHA-256 first 16: 32e0ceb57cb5fcc4</summary>

```diff
From ec654d6910a47b005d627f7585db7fc192452d1a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 18:37:22 +0800
Subject: [PATCH] gateway tests: the [1m] id an agent asks a relay by reaches
 it bare (#5058)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A report says a relay is asked for the "[1m]" id magpie hands Claude Code
for a model of a 1M window, and turns it away as one it doesn't serve.
The mark is a signal for Claude Code alone and never leaves magpie: it
drops the mark before asking, and the gateway's provider.Resolve takes
it off whatever id comes in, before any upstream is asked — a relay
speaking Anthropic's API itself (TestClaudeDashedIDsReachTheDottedModel)
or an OpenAI-shaped one (New API, litellm), which the request is
translated for, untested until now. The test asks both by the ids
magpie writes, marked, and holds the upstream to the bare id; with the
strip lifted from Resolve it fails with the report's own symptom, the
relay asked for "claude-opus-4.6-us[1m]".

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_1m_relay_test.go | 78 ++++++++++++++++++++++++
 1 file changed, 78 insertions(+)
 create mode 100644 internal/gateway/claude_1m_relay_test.go

diff --git a/internal/gateway/claude_1m_relay_test.go b/internal/gateway/claude_1m_relay_test.go
new file mode 100644
index 000000000..3fe59b1ac
--- /dev/null
+++ b/internal/gateway/claude_1m_relay_test.go
@@ -0,0 +1,78 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A model of a 1M window magpie hands Claude Code by its "[1m]" id
+// (agent/claude_1m_test.go), and the id an agent sends back carries it:
+// the mark is Claude Code's own signal for the window, and it never
+// reaches an upstream. Claude Code drops it before asking, and the
+// gateway's provider.Resolve takes it off whatever id comes in, whatever
+// serves the model — a relay speaking Anthropic's API itself, or an
+// OpenAI-compatible one (New API, litellm), which the request is
+// translated for (#5058: a relay was reported the mark asked for).
+func TestClaude1MIDsReachTheUpstreamBare(t *testing.T) {
+	fresh(t)
+	chat := &fake{t: t, reply: deepseekReply}
+	native := &fake{t: t, reply: sse(
+		`event: message_start`+"\n"+`data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
+		`event: message_stop`+"\n"+`data: {"type":"message_stop"}`)}
+	cu := httptest.NewServer(chat)
+	t.Cleanup(cu.Close)
+	au := httptest.NewServer(native)
+	t.Cleanup(au.Close)
+	for _, p := range []provider.Provider{
+		// a relay by its address, OpenAI-shaped, and one speaking
+		// Anthropic's API as itself
+		{ID: "relay", Name: "Relay", Key: "k", Chat: cu.URL + "/v1", Models: []string{"claude-opus-4.6-us"}},
+		{ID: "arelay", Name: "ARelay", Key: "k", Anthropic: au.URL, Models: []string{"claude-opus-4-6"}},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	// both models are of a 1M window, which is why magpie marks them
+	if err := catalog.SaveLive("relay", "https://relay.example/v1", []catalog.Model{{ID: "claude-opus-4.6-us", Context: 1_000_000}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("arelay", "https://arelay.example", []catalog.Model{{ID: "claude-opus-4-6", Context: 1_000_000}}); err != nil {
+		t.Fatal(err)
+	}
+	send := func(model string) (int, string) {
+		t.Helper()
+		body := `{"model":"` + model + `","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
+		return post(t, "/v1/messages", body)
+	}
+	for _, c := range []struct{ asked, want string }{
+		// the ids magpie writes, marked: the dotted one whole, the dotted
+		// one as Claude Code is given it (dashes)
+		{"relay/claude-opus-4.6-us[1m]", "claude-opus-4.6-us"},
+		{"relay/claude-opus-4-6-us[1m]", "claude-opus-4.6-us"},
+		{"arelay/claude-opus-4-6[1m]", "claude-opus-4-6"},
+	} {
+		chat.got, native.got = nil, nil
+		code, body := send(c.asked)
+		if code != 200 {
+			t.Fatalf("%s: %d %s", c.asked, code, body)
+		}
+		who, got := "the native relay", chat.got
+		if chat.got == nil {
+			got = native.got
+		} else {
+			who = "the relay"
+		}
+		if id := gjson.GetBytes(got, "model").String(); id != c.want {
+			t.Fatalf("%s: %s asked for %q, want %q", c.asked, who, id, c.want)
+		}
+		if strings.Contains(string(got), "[1m]") {
+			t.Fatalf("%s: the mark reached the upstream: %s", c.asked, got)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>


Branch with the commit: [fix/5058-claude-1m-suffix](https://github.com/ggbdpq/magpie/tree/fix/5058-claude-1m-suffix) (head `ec654d6910a47b005d627f7585db7fc192452d1a`).
