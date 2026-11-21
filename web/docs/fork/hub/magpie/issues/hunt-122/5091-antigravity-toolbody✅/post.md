**Summary**
On the Antigravity route, a model turn whose text carries a whole tool call written out — a completion call with its `result` — and the answer repeated after it now goes upstream without the call: the history keeps what the model said, not the wrapper that teaches it to write the next call the same way (#5091). The live reply is untouched: it still streams as it came, and no call is read out of text a reply is already streaming.

**What changed**
- `buildCodeAssistSent` (`internal/gateway/codeassist.go`) hands an Antigravity request's history through `dropPseudoCalls` (`internal/gateway/textcalls.go`).
- A turn is rewritten only when nothing structured is in it, a whole written-out call is there — of a tool the request offers, its arguments readable by the readers Chat replies already go through (`<tool_call>`'s Hermes JSON, GLM's pairs, an invoke with its parameters), closed — and the text after it says the call's `result` again, up to punctuation, spacing and case. Anything less — a bare tool name, a JSON fragment, a wrapper of a tool not offered, a result the answer doesn't repeat — stays as it is.
- `gemini` and `vertex` requests keep their histories as they came; the report is the Antigravity route.

**Why**
The report's two-sided SSE capture shows every part Google returned is text — none a `functionCall` — so there is nothing to decode better on the way down: gemini-4-argon deep in a long session wrote the completion call it meant into its reply's text, the client ran nothing and read the arguments as the answer's lead, and the turn came back in the history as that text. Every later turn read its own wrapper back and wrote the next one the same way; clearing such turns from the history restored normal calls in the report's own controlled try. That cleanup is what this ports, at request-build time, under the report's own conditions.

**Verification**
| Check | Result |
| --- | --- |
| `TestAntigravityPseudoCallOutOfHistory` (whole wrapper; the wrapper split across two text blocks; an invoke with thinking beside it; a turn with a real call; a tool not offered; no `result` in the arguments; a result the answer doesn't repeat; a fragment that is no call; a user's turn; the `gemini` agent) | red 3 of 9 on the code before the change, green after, red 3 of 9 again with the `ag` wiring taken back out |
| `go test -tags nogui -count=1 -run 'TestAntigravityPseudoCallOutOfHistory\|TestCodeAssist\|TestTextCall\|TestTextWritten' ./internal/gateway/` | ok 5.016s |
| `go test -race -tags nogui -count=1 -run 'TestAntigravityPseudoCall\|TestCodeAssistTextCalls\|TestTextWrittenCall\|TestTextCalls' ./internal/gateway/` | ok 2.952s |
| `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | ok 600.353s |
| `gofmt -l` on the three changed files | empty |
| `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean |
| `go build`, `GOOS=linux go build -tags nogui`, `GOOS=windows go build` | ok |

**Not tried**
- Not tried against the real Antigravity: the report's session, account and gemini-4-argon aren't available here. The tests use the synthetic shapes the report's own conditions describe, plus the invoke shape the Chat path already reads.
- Not added: the receive-side counter the report sketches first — a reply's decoder has no logger of its own, and the exact shape the real replies use is the report's open question; the optional streaming hold (the report's #3) — sent deltas can't be taken back, and the report leaves it as a policy of its own.
- A wrapper the readers can't read — a shape with none of the marks, or a `call:default_api:` whose arguments `textArgs` refuses — stays in the history, as the report's only-when-it-can-be-checked asks.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details><summary>patch: gateway: a completion call Antigravity's model wrote into its text goes out of the history, the answer it repeated staying (#5091) — git am applies it as is; SHA-256 first 16: 87a048e4fb99a4d5</summary>

```patch
From 7d9612fa6fb609045d0f2ce1285aed1f05a9e7a7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 22:32:08 +0800
Subject: [PATCH] gateway: a completion call Antigravity's model wrote into its
 text goes out of the history, the answer it repeated staying (#5091)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- buildCodeAssistSent (internal/gateway/codeassist.go) hands an Antigravity
  request's history through dropPseudoCalls (internal/gateway/textcalls.go).
- dropPseudoCalls rewrites a model turn only when nothing structured is in
  it, a whole call written out in its text is there — of a tool the request
  offers, its arguments readable by the readers Chat replies already go
  through (<tool_call>'s JSON and pairs, an invoke with its parameters),
  closed — and the text after it says the call's result again, up to
  punctuation, spacing and case. The turn then goes upstream as that text
  without the call. msgs is not changed: a fallback builds from the same
  request.

Why
- #5091 (Phoenix12580): gemini-4-argon deep in a long session wrote the
  completion call it meant into its reply's text — the report's two-sided
  SSE capture shows every part Google returned is text, none a
  functionCall — so the client ran nothing and read the call's arguments
  as the answer's lead. The turn came back in the history as that text,
  and every later turn read its own wrapper back and wrote the next one
  the same way; clearing such turns from the history restored normal
  calls in the report's own controlled try.

Not changed
- A reply that carries its call as text still streams as it came: the
  report asks for no call read out of a live reply, and none is made.
- The gemini and vertex requests keep their histories as they came; the
  report is the Antigravity route.
- A wrapper the readers can't read — a call:default_api: whose arguments
  textArgs refuses, a shape with none of the marks, a call example inside
  a code fence — stays in the history; the report's conditions are kept
  to what can be checked.
- No receive-side counter is added: the reply's decoder has no logger of
  its own, and the shapes it reads are the report's own open question.

Run
- TestAntigravityPseudoCallOutOfHistory
  (internal/gateway/textcalls_pseudo_test.go): red before the change, the
  wrapper, the split-block and the invoke cases each failing with the call
  still in the turn, green after, and red again with the ag wiring taken
  back out of buildCodeAssistSent
- go test -tags nogui -count=1 -run 'TestAntigravityPseudoCallOutOfHistory|TestCodeAssist|TestTextCall|TestTextWritten' ./internal/gateway/: ok 5.016s
- go test -race -tags nogui -count=1 -run 'TestAntigravityPseudoCall|TestCodeAssistTextCalls|TestTextWrittenCall|TestTextCalls' ./internal/gateway/: ok 2.952s
- go test -tags nogui -count=1 -timeout 25m ./internal/gateway/: ok 600.353s
- gofmt -l internal/gateway/codeassist.go internal/gateway/textcalls.go
  internal/gateway/textcalls_pseudo_test.go: empty
- go vet ./..., GOOS=linux go vet -tags nogui ./..., GOOS=windows go vet
  ./...: clean
- go build, GOOS=linux go build -tags nogui, GOOS=windows go build: ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codeassist.go            |   8 +-
 internal/gateway/textcalls.go             | 143 ++++++++++++++++++
 internal/gateway/textcalls_pseudo_test.go | 167 ++++++++++++++++++++++
 3 files changed, 317 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/textcalls_pseudo_test.go

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index 82102026b..3d439fd3b 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -341,7 +341,13 @@ func buildCodeAssistSent(r *Request, sent, agent string) []byte {
 	}
 	names := map[string]string{}
 	var contents []map[string]any
-	for _, m := range dropSecondAnswers(r.Messages) {
+	msgs := dropSecondAnswers(r.Messages)
+	if ag {
+		// a model turn that carried its call written out in the text goes
+		// as the answer it repeated (dropPseudoCalls)
+		msgs = dropPseudoCalls(msgs, r.Tools)
+	}
+	for _, m := range msgs {
 		role := "user"
 		if m.Role == "assistant" {
 			role = "model"
diff --git a/internal/gateway/textcalls.go b/internal/gateway/textcalls.go
index 83af83c7c..0b38e00a4 100644
--- a/internal/gateway/textcalls.go
+++ b/internal/gateway/textcalls.go
@@ -7,6 +7,7 @@ import (
 	"regexp"
 	"strings"
 	"sync/atomic"
+	"unicode"
 )
 
 // A model deep into a long conversation may write its tool calls into its
@@ -137,6 +138,148 @@ func textCallNames(tools []Tool) map[string]bool {
 	return m
 }
 
+// dropPseudoCalls is a history's model turns with the call one of them
+// wrote out in its text gone, the answer after it staying (#5091).
+func dropPseudoCalls(msgs []Message, tools []Tool) []Message {
+	names := textCallNames(tools)
+	if names == nil {
+		return msgs
+	}
+	var out []Message
+	for i, m := range msgs {
+		kept, ok := withoutPseudoCall(m, names)
+		if ok && out == nil {
+			out = append(make([]Message, 0, len(msgs)), msgs[:i]...)
+		}
+		if out != nil {
+			out = append(out, kept)
+		}
+	}
+	if out == nil {
+		return msgs
+	}
+	return out
+}
+
+// withoutPseudoCall is m with the completion call it wrote out in its text
+// gone, and whether it was. A turn is rewritten only when nothing
+// structured is in it, the whole call written out is there — of a tool the
+// request offers, its arguments readable, closed — and the text after it
+// says the call's result again, up to punctuation and spaces; anything
+// less, a bare tool name or a JSON fragment, stays as it is (#5091, as
+// gemini-4-argon deep in a long session wrote its completion call into the
+// text and the answer after it, and every later turn read its own wrapper
+// back and wrote the next one the same way). The text's signatures go with
+// the turn it was: history a client sends back carries none.
+func withoutPseudoCall(m Message, names map[string]bool) (Message, bool) {
+	if m.Role != "assistant" {
+		return m, false
+	}
+	for _, p := range m.Parts {
+		if p.Kind != Text && p.Kind != Thinking {
+			// a real call, its result, a picture: they stand
+			return m, false
+		}
+	}
+	joined := false
+	for _, p := range m.Parts {
+		if p.Kind == Text && strings.Contains(p.Text, "<") {
+			joined = true
+			break
+		}
+	}
+	if !joined {
+		return m, false
+	}
+	var b strings.Builder
+	for _, p := range m.Parts {
+		if p.Kind == Text {
+			b.WriteString(p.Text)
+		}
+	}
+	said := b.String()
+	at, _ := textCallAt(said)
+	if at < 0 {
+		return m, false
+	}
+	c, n, good := historyCall(said[at:], names)
+	if !good {
+		return m, false
+	}
+	if block := strings.TrimRight(said[at:at+n], " \t\r\n"); !strings.HasSuffix(block, ">") {
+		// no close the model wrote: not a whole wrapper
+		return m, false
+	}
+	res, ok := callResult(c.Args)
+	if !ok || !saysAgain(said[at+n:], res) {
+		// no result to compare, or the answer says something else
+		return m, false
+	}
+	kept := strings.TrimLeft(said[:at]+said[at+n:], " \t\r\n")
+	return Message{Role: m.Role, Parts: []Part{{Kind: Text, Text: kept}}}, true
+}
+
+// historyCall reads one call written out at the start of s, the way
+// parseTextCalls reads a reply's: a <tool_call> block, Hermes' JSON, GLM's
+// pairs, an invoke — of one of names, with arguments that can be read. n is
+// how much of s the block took, its close included where it wrote one.
+func historyCall(s string, names map[string]bool) (c writtenCall, n int, good bool) {
+	if strings.HasPrefix(s, "<tool_call>") {
+		s = s[len("<tool_call>"):]
+		if c, n, good = paramCall(s, names); !good {
+			if c, n, good = hermesCall(s, names); !good && !strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "{") {
+				c, n, good = glmCall(s, names)
+			}
+		}
+		return c, n + len("<tool_call>"), good
+	}
+	if d := dsmlInvoke.FindStringSubmatchIndex(s); d != nil {
+		c, n, good = dsmlCall(s, s[d[2]:d[3]], d[1]-d[0], names)
+		return c, n, good
+	}
+	return writtenCall{}, 0, false
+}
+
+// callResult is a written-out call's result: its result member, a string as
+// it stands, any other JSON as it marshals. The completion call of #5091
+// carries the answer it went on to repeat there.
+func callResult(args json.RawMessage) (string, bool) {
+	var a map[string]json.RawMessage
+	if decodeJSON(args, &a) != nil {
+		return "", false
+	}
+	r, ok := a["result"]
+	if !ok {
+		return "", false
+	}
+	var s string
+	if decodeJSON(r, &s) == nil {
+		return s, true
+	}
+	return string(r), true
+}
+
+// saysAgain says whether t says s again, up to the punctuation, spaces and
+// case the answer and its result may differ by (#5091).
+func saysAgain(t, s string) bool {
+	if w := plainWords(s); w != "" {
+		return strings.Contains(plainWords(t), w)
+	}
+	return false
+}
+
+// plainWords is s with its letters and digits kept, lowercased: everything
+// the model's punctuation and spacing may differ by goes.
+func plainWords(s string) string {
+	var b strings.Builder
+	for _, r := range s {
+		if unicode.IsLetter(r) || unicode.IsDigit(r) {
+			b.WriteRune(unicode.ToLower(r))
+		}
+	}
+	return b.String()
+}
+
 // chatToolNames are the function tools of a Chat Completions request.
 func chatToolNames(body []byte) map[string]bool {
 	var q struct {
diff --git a/internal/gateway/textcalls_pseudo_test.go b/internal/gateway/textcalls_pseudo_test.go
new file mode 100644
index 000000000..ae718caae
--- /dev/null
+++ b/internal/gateway/textcalls_pseudo_test.go
@@ -0,0 +1,167 @@
+package gateway
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+// jsq is s as the JSON string a request's content carries it as.
+func jsq(s string) string {
+	b, _ := json.Marshal(s)
+	return string(b)
+}
+
+// A completion call Antigravity's gemini-4-argon wrote out in its reply's
+// text, and the answer it repeated after it, is history twice over once the
+// client sends the turn back: shown its own wrapper, the model writes its
+// next calls out as text the same way, turn after turn, and the client
+// reads the call's arguments twice and sees no tool (#5091). The turn goes
+// to Antigravity without the written-out call — of a tool the request
+// offers, whole, closed, its result said again in the text after it — and
+// with the rest of the turn as it came. A turn with a real call in it, a
+// wrapper of a tool not offered, a fragment that is no call, a result the
+// answer doesn't repeat, a user's turn and another agent's request all
+// stay as they are.
+func TestAntigravityPseudoCallOutOfHistory(t *testing.T) {
+	const completion = "12 checks green, build ready"
+	wrapper := `<tool_call>{"name":"attempt_completion","arguments":{"result":"` + completion + `"}}</tool_call>`
+	pseudo := "I'll wrap up now.\n" + wrapper + "\nAll done: " + completion
+	want := "I'll wrap up now.\n\nAll done: " + completion
+	const tools = `[{"name":"attempt_completion","input_schema":{"type":"object","properties":{"result":{"type":"string"}}}},
+		{"name":"bash","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}]`
+
+	// modelParts builds a request whose assistant turn holds content, and
+	// gives the model turn the envelope holds, "call" for each call
+	modelParts := func(t *testing.T, agent, content string) []string {
+		t.Helper()
+		body := `{"model":"gemini-4-argon-high","max_tokens":100,"tools":` + tools +
+			`,"messages":[{"role":"user","content":"run the checks"},
+			{"role":"assistant","content":` + content + `},
+			{"role":"user","content":"go on"}]}`
+		r, err := parseAnthropic([]byte(body))
+		if err != nil {
+			t.Fatal(err)
+		}
+		var env struct {
+			Request struct {
+				Contents []struct {
+					Role  string                       `json:"role"`
+					Parts []map[string]json.RawMessage `json:"parts"`
+				} `json:"contents"`
+			} `json:"request"`
+		}
+		if err := json.Unmarshal(buildCodeAssist(r, "gemini-4-argon-high", agent), &env); err != nil {
+			t.Fatal(err)
+		}
+		for _, c := range env.Request.Contents {
+			if c.Role != "model" {
+				continue
+			}
+			var out []string
+			for _, p := range c.Parts {
+				if _, ok := p["functionCall"]; ok {
+					out = append(out, "call")
+					continue
+				}
+				var s string
+				if err := json.Unmarshal(p["text"], &s); err != nil {
+					t.Fatalf("unreadable part %q: %v", string(p["text"]), err)
+				}
+				out = append(out, s)
+			}
+			return out
+		}
+		t.Fatalf("no model turn in the envelope for %s", agent)
+		return nil
+	}
+
+	if got := modelParts(t, "antigravity", `[{"type":"text","text":`+jsq(pseudo)+`}]`); len(got) != 1 || got[0] != want {
+		t.Errorf("the pseudo call stayed in the turn sent to Antigravity: %q, want %q", got, want)
+	}
+	// the same turn split over two text blocks, the wrapper cut across them,
+	// goes as one answer too
+	split := `[{"type":"text","text":` + jsq("I'll wrap up now.\n<tool_call>{\"name\":\"attempt") +
+		`},{"type":"text","text":` + jsq("_completion\",\"arguments\":{\"result\":\""+completion+"\"}}</tool_call>\nAll done: "+completion) + `}]`
+	if got := modelParts(t, "antigravity", split); len(got) != 1 || got[0] != want {
+		t.Errorf("the pseudo call cut across two blocks stayed: %q, want %q", got, want)
+	}
+	// the same wrapper in an invoke of Claude's own shape, with its thinking
+	// beside it, goes the way too: what the client sends back of a thought
+	// is not what goes upstream
+	invoked := `[{"type":"thinking","thinking":"the work is done","signature":"sig"},` +
+		`{"type":"text","text":` + jsq(`<invoke name="attempt_completion">
+<parameter name="result">`+completion+`</parameter>
+</invoke>
+All done: `+completion) + `}]`
+	if got := modelParts(t, "antigravity", invoked); len(got) != 1 || got[0] != "All done: "+completion {
+		t.Errorf("a written-out invoke stayed: %q", got)
+	}
+	// a turn that made a real call stands, wrapper text and all
+	real := `[{"type":"tool_use","id":"t1","name":"attempt_completion","input":{"result":"` + completion + `"}},` +
+		`{"type":"text","text":` + jsq(pseudo) + `}]`
+	if got := modelParts(t, "antigravity", real); len(got) != 2 || got[0] != "call" || got[1] != pseudo {
+		t.Errorf("a turn with a real call was rewritten: %q", got)
+	}
+
+	stays := []struct {
+		name     string
+		agent    string
+		content  string
+		contains string
+	}{
+		{"a wrapper of a tool not offered", "antigravity",
+			`[{"type":"text","text":` + jsq("Done.\n"+strings.Replace(wrapper, "attempt_completion", "hidden_tool", 1)+"\nDone: "+completion) + `}]`,
+			"hidden_tool"},
+		{"no result in the arguments", "antigravity",
+			`[{"type":"text","text":` + jsq(`<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>`+"\nls is done") + `}]`,
+			"<tool_call>"},
+		{"a result the answer doesn't repeat", "antigravity",
+			`[{"type":"text","text":` + jsq(`<tool_call>{"name":"attempt_completion","arguments":{"result":"ABCD"}}</tool_call>`+"\nThe work is finished") + `}]`,
+			"<tool_call>"},
+		{"a fragment that is no call", "antigravity",
+			`[{"type":"text","text":` + jsq("I'll use <tool_call> and the tool runs\n"+completion) + `}]`,
+			"<tool_call>"},
+		{"another agent's request keeps the wrapper", "gemini",
+			`[{"type":"text","text":` + jsq(pseudo) + `}]`,
+			"<tool_call>"},
+	}
+	for _, s := range stays {
+		got := modelParts(t, s.agent, s.content)
+		if len(got) != 1 || !strings.Contains(got[0], s.contains) {
+			t.Errorf("%s: the turn was rewritten: %q", s.name, got)
+		}
+	}
+
+	// a user's turn holding the same wrapper keeps it: only what the model
+	// said is rewritten
+	body := `{"model":"gemini-4-argon-high","max_tokens":100,"tools":` + tools +
+		`,"messages":[{"role":"user","content":` + jsq(pseudo) + `}]}`
+	r, err := parseAnthropic([]byte(body))
+	if err != nil {
+		t.Fatal(err)
+	}
+	var env struct {
+		Request struct {
+			Contents []struct {
+				Role  string                       `json:"role"`
+				Parts []map[string]json.RawMessage `json:"parts"`
+			} `json:"contents"`
+		} `json:"request"`
+	}
+	if err := json.Unmarshal(buildCodeAssist(r, "gemini-4-argon-high", "antigravity"), &env); err != nil {
+		t.Fatal(err)
+	}
+	if len(env.Request.Contents) == 0 {
+		t.Fatal("no contents")
+	}
+	var user string
+	for _, p := range env.Request.Contents[0].Parts {
+		var s string
+		json.Unmarshal(p["text"], &s)
+		user += s
+	}
+	if !strings.Contains(user, "<tool_call>") {
+		t.Errorf("a user's turn was rewritten: %q", user)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/5091-antigravity-toolbody](https://github.com/ggbdpq/magpie/tree/fix/5091-antigravity-toolbody) (head `7d9612fa6fb609045d0f2ce1285aed1f05a9e7a7`).
