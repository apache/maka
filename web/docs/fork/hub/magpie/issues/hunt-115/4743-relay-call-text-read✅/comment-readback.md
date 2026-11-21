**Summary**

A reply relayed as it came on the Responses API or the Gemini API was the one remaining kind that wasn't read for calls written into its text: a model there that wrote `<invoke name="…">`, DSML or `<tool_call>` text reached the agent as text, and the turn ended with nothing run. Every translated route was read (`textCallSee`), and so were a relayed Chat stream or whole reply (`textCallTidy`, `chatWhole`) and a relayed Messages reply (`anthropicTextCalls`); a relayed Responses or Gemini reply now is too, streamed and whole.

**What changed**

- `textcalls_relay.go`:
  - `responsesTextCalls` reads a Responses reply relayed as it came. Text is held from `response.output_text.delta` where a call begins; the part's `output_text.done`, its `content_part.done` and the message item's `output_item.done` wait with it; at `response.completed` the held blocks become `function_call` items (`output_item.added`, `function_call_arguments.delta`/`done`, `output_item.done`), and the completed response's `output` says the same. A reply that came whole is read over its output's message items. Synthesized events carry `sequence_number` on from the last one the upstream sent.
  - `geminiTextCalls` reads a Gemini reply relayed as it came over `candidates[].content.parts`: text parts held or trimmed as the chunks come, the held calls made `functionCall` parts at the candidate's `finishReason`; Vertex AI's whole `generateContent` reply the same. Thought parts are left alone, and a candidate that made a call itself goes as `textCallTidy` lets a Chat one go: only the tags left in its text go.
- `gateway.go`: both wired into the relay funnel beside `textCallTidy` and `anthropicTextCalls`; `geminiToolNames` reads a Gemini request's `functionDeclarations` (Responses tools' names the existing readers already find).

**Verification**

| Check | Result |
|---|---|
| `TestInvokeReportedResponsesPassthrough` (new): the reporter's bytes on a Responses relay, streamed and whole, lead text, and an unoffered invoke left as text | red on the old code, green now |
| `TestInvokeReportedGeminiPassthrough` (new): the same on a Gemini relay, streamed and whole (Vertex AI's `generateContent`) | red on the old code, green now |
| Ablation: the two new tests with only the product files reverted (tests kept) | both red, as expected |
| `go test ./internal/gateway/ -count=1 -tags nogui` (the whole package) | ok, 520s |
| `gofmt -l` on the touched files, `go vet` on darwin/linux/windows | clean |
| `go build` of the server on linux/amd64, windows/amd64, darwin/arm64 | ok |

**Not verified**

Against real Codex-to-a-Responses-speaking-provider and Gemini CLI-to-a-custom-URL traffic; the tests script the reporter's literal bytes on both wire shapes.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): a relayed Responses or Gemini reply's text is read for the calls written into it (#4743) — git am applies it as is; SHA-256 first 16: 7a9f09ec87dce81a</summary>

````text
From c1ade7e72c8e511f801628cc4a55dd63e5eac7c8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 19:22:57 +0800
Subject: [PATCH] fix(gateway): a relayed Responses or Gemini reply's text is
 read for the calls written into it (#4743)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- textcalls_relay.go: responsesTextCalls reads a Responses reply relayed as
  it came — a Codex turn to a provider that speaks Responses itself. Text
  from where a call is written into it is held from output_text.delta on;
  the part's output_text.done, content_part.done and the message item's
  output_item.done wait with it; at response.completed the held calls
  become function_call items (added, arguments deltas, done) and the
  completed output says them too. A reply that came whole is read over its
  output's message items.
- geminiTextCalls does the same over candidates[].content.parts: text
  parts held or trimmed as the chunks come, the held calls functionCall
  parts at the candidate's finishReason; a whole generateContent reply
  (Vertex AI) the same. A reply that made calls itself (native) goes as
  textCallTidy lets a Chat one: only tags left in its text go.
- gateway.go: both wired into the relay funnel beside textCallTidy and
  anthropicTextCalls; geminiToolNames reads a Gemini request's
  functionDeclarations.

Run
- go test ./internal/gateway/ -run TestInvokeReported -count=1: the two new
  passthrough cases red before, green after; the package's full run green.
---
 internal/gateway/gateway.go               |   6 +
 internal/gateway/textcalls_invoke_test.go | 305 +++++++++
 internal/gateway/textcalls_relay.go       | 715 ++++++++++++++++++++++
 3 files changed, 1026 insertions(+)
 create mode 100644 internal/gateway/textcalls_relay.go

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b19da3873..21e3f77c6 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5769,6 +5769,12 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	} else if proto == provider.Anthropic && names != nil {
 		// a Messages reply, streamed or whole (textcalls_anthropic.go)
 		written = &anthropicTextCalls{names: names, sse: sse}
+	} else if proto == provider.Responses && names != nil {
+		// a Responses reply, streamed or whole (textcalls_relay.go)
+		written = &responsesTextCalls{names: names, sse: sse, seq: -1}
+	} else if names := geminiToolNames(body); proto == provider.Gemini && names != nil {
+		// a Gemini reply, streamed or whole (textcalls_relay.go)
+		written = &geminiTextCalls{names: names, sse: sse}
 	}
 	// a reply that came whole: JSON, or one under text/plain or no type
 	// that eventStream found isn't a stream
diff --git a/internal/gateway/textcalls_invoke_test.go b/internal/gateway/textcalls_invoke_test.go
index a96be95b7..32847a24a 100644
--- a/internal/gateway/textcalls_invoke_test.go
+++ b/internal/gateway/textcalls_invoke_test.go
@@ -249,6 +249,311 @@ func TestInvokeReportedAnthropicPassthrough(t *testing.T) {
 	}
 }
 
+// responsesSSE is a Responses stream whose one message item's output_text
+// says text, in pieces, as OpenAI's own send one.
+func responsesSSE(text string) string {
+	ev := func(typ string, v any) string {
+		b, _ := json.Marshal(v)
+		return "event: " + typ + "\ndata: " + string(b)
+	}
+	part := map[string]any{"type": "output_text", "text": text, "annotations": []any{}}
+	lines := []string{
+		ev("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "r1", "model": "m"}}),
+		ev("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0,
+			"item": map[string]any{"type": "message", "role": "assistant", "id": "msg_1", "status": "in_progress", "content": []any{}}}),
+		ev("response.content_part.added", map[string]any{"type": "response.content_part.added", "item_id": "msg_1",
+			"output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}}),
+	}
+	for i, p := range cutInto(text, 9) {
+		lines = append(lines, ev("response.output_text.delta", map[string]any{"type": "response.output_text.delta",
+			"item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": p, "sequence_number": i}))
+	}
+	lines = append(lines,
+		ev("response.output_text.done", map[string]any{"type": "response.output_text.done", "item_id": "msg_1",
+			"output_index": 0, "content_index": 0, "text": text}),
+		ev("response.content_part.done", map[string]any{"type": "response.content_part.done", "item_id": "msg_1",
+			"output_index": 0, "content_index": 0, "part": part}),
+		ev("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0,
+			"item": map[string]any{"type": "message", "role": "assistant", "id": "msg_1", "status": "completed", "content": []any{part}}}),
+		ev("response.completed", map[string]any{"type": "response.completed",
+			"response": map[string]any{"id": "r1", "model": "m", "status": "completed", "output": []any{
+				map[string]any{"type": "message", "role": "assistant", "id": "msg_1", "status": "completed", "content": []any{part}}}}}))
+	return sse(lines...)
+}
+
+// responsesRead is what a Responses client reads of a stream: the text the
+// deltas carried, each function_call item's name and arguments as its
+// output_item.done said them, and the items the completed reply's output
+// named.
+func responsesStreamRead(t *testing.T, raw string) (text string, names, args []string, done, output []map[string]any) {
+	t.Helper()
+	for _, e := range events(raw) {
+		switch e["type"] {
+		case "response.output_text.delta":
+			text += e["delta"].(string)
+		case "response.output_item.done":
+			it := e["item"].(map[string]any)
+			done = append(done, it)
+			if it["type"] == "function_call" {
+				names = append(names, it["name"].(string))
+				args = append(args, it["arguments"].(string))
+			}
+		case "response.completed":
+			out, _ := e["response"].(map[string]any)["output"].([]any)
+			for _, it := range out {
+				output = append(output, it.(map[string]any))
+			}
+		}
+	}
+	return text, names, args, done, output
+}
+
+// The reported case on the Responses path: Codex to a provider that speaks
+// Responses itself, relayed as it came. It reaches Codex as the ToolSearch
+// call, and the turn stops for it; the completed reply's output says so
+// too. A reply that came whole the same.
+func TestInvokeReportedResponsesPassthrough(t *testing.T) {
+	fresh(t)
+	a := &scripted{}
+	scriptedOn(t, "a", provider.Responses, a)
+	ask := func(stream bool) string {
+		rec := httptest.NewRecorder()
+		s := "false"
+		if stream {
+			s = "true"
+		}
+		New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(
+			`{"model":"a/m","stream":`+s+`,"store":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我使用magpie的browser打开谷歌"}]}],
+"tools":[{"type":"function","name":"ToolSearch","parameters":{"type":"object"}},{"type":"function","name":"Bash","parameters":{"type":"object"}}]}`)))
+		if rec.Code != 200 {
+			t.Fatalf("%d %s", rec.Code, rec.Body.String())
+		}
+		return rec.Body.String()
+	}
+
+	a.replies, a.n = []reply{{200, "text/event-stream", responsesSSE(invokeReported)}}, 0
+	raw := ask(true)
+	text, names, args, done, output := responsesStreamRead(t, raw)
+	if text != "" || len(names) != 1 || names[0] != "ToolSearch" || args[0] != invokeQuery ||
+		strings.Contains(raw, "Result") || strings.Contains(raw, "invoke") {
+		t.Fatalf("text %q names %v args %v\n%s", text, names, args, raw)
+	}
+	if len(output) != 2 || output[0]["type"] != "message" {
+		t.Fatalf("completed's output %v", output)
+	}
+	// the completed output's call is the one the stream ended with
+	last, _ := json.Marshal(done[len(done)-1])
+	matched, _ := json.Marshal(output[1])
+	if string(last) != string(matched) {
+		t.Fatalf("completed's output[1] %s, the stream's item %s", matched, last)
+	}
+
+	// text before the call stays, and the call follows it
+	a.replies, a.n = []reply{{200, "text/event-stream", responsesSSE("我来打开谷歌。\n\n" + invokeReported)}}, 0
+	raw = ask(true)
+	text, names, args, _, _ = responsesStreamRead(t, raw)
+	if text != "我来打开谷歌。\n\n" || len(names) != 1 || args[0] != invokeQuery {
+		t.Fatalf("lead: text %q names %v args %v\n%s", text, names, args, raw)
+	}
+
+	// text that only names an invoke of no offered tool goes as it came
+	plain := "Write it as <invoke name=\"rm_rf\"><parameter name=\"p\">/</parameter></invoke>, then stop."
+	a.replies, a.n = []reply{{200, "text/event-stream", responsesSSE(plain)}}, 0
+	raw = ask(true)
+	text, names, _, _, _ = responsesStreamRead(t, raw)
+	if text != plain || len(names) != 0 {
+		t.Fatalf("plain: text %q names %v\n%s", text, names, raw)
+	}
+
+	whole, _ := json.Marshal(map[string]any{"id": "r1", "object": "response", "model": "m", "status": "completed",
+		"output": []any{map[string]any{"type": "message", "role": "assistant", "id": "msg_1", "status": "completed",
+			"content": []any{map[string]any{"type": "output_text", "text": "好的。\n" + invokeReported}}}}})
+	a.replies, a.n = []reply{{200, "application/json", string(whole)}}, 0
+	raw = ask(false)
+	var got struct {
+		Output []struct {
+			Type string `json:"type"`
+			Name string `json:"name"`
+			Args string `json:"arguments"`
+		} `json:"output"`
+	}
+	if err := json.Unmarshal([]byte(raw), &got); err != nil {
+		t.Fatalf("%v: %s", err, raw)
+	}
+	if len(got.Output) != 2 || got.Output[0].Type != "message" || got.Output[1].Type != "function_call" ||
+		got.Output[1].Name != "ToolSearch" || got.Output[1].Args != invokeQuery {
+		t.Fatalf("whole: %s", raw)
+	}
+}
+
+// geminiTextChunk is one chunk of a Gemini stream: the model's parts, and
+// finish for the last one's finishReason.
+func geminiTextChunk(parts []map[string]any, finish string) string {
+	cand := map[string]any{"content": map[string]any{"role": "model", "parts": parts}}
+	if finish != "" {
+		cand["finishReason"] = "STOP"
+	}
+	c := map[string]any{"candidates": []any{cand}}
+	if finish != "" {
+		c["usageMetadata"] = map[string]any{"promptTokenCount": 9, "candidatesTokenCount": 40}
+	}
+	b, _ := json.Marshal(c)
+	return "data: " + string(b)
+}
+
+// geminiSSE is a Gemini stream whose answer parts say text, in pieces.
+func geminiSSE(text string) string {
+	var chunks []string
+	for _, p := range cutInto(text, 9) {
+		b, _ := json.Marshal(p)
+		chunks = append(chunks, geminiTextChunk([]map[string]any{{"text": json.RawMessage(b)}}, ""))
+	}
+	chunks = append(chunks, geminiTextChunk([]map[string]any{{"text": ""}}, "STOP"))
+	return sse(chunks...)
+}
+
+// geminiRead is what a Gemini client reads of a stream: the answer text
+// and each functionCall's name and args.
+func geminiRead(t *testing.T, raw string) (text string, names []string, args []json.RawMessage) {
+	t.Helper()
+	for _, line := range strings.Split(raw, "\n") {
+		data, ok := strings.CutPrefix(line, "data: ")
+		if !ok {
+			continue
+		}
+		var ch struct {
+			Candidates []struct {
+				Content struct {
+					Parts []struct {
+						Text    string `json:"text"`
+						Thought bool   `json:"thought"`
+						Call    struct {
+							Name string          `json:"name"`
+							Args json.RawMessage `json:"args"`
+						} `json:"functionCall"`
+					} `json:"parts"`
+				} `json:"content"`
+			} `json:"candidates"`
+		}
+		if err := json.Unmarshal([]byte(data), &ch); err != nil {
+			t.Fatalf("unreadable chunk %q: %v", data, err)
+		}
+		for _, c := range ch.Candidates {
+			for _, p := range c.Content.Parts {
+				if !p.Thought {
+					text += p.Text
+				}
+				if p.Call.Name != "" {
+					names = append(names, p.Call.Name)
+					args = append(args, p.Call.Args)
+				}
+			}
+		}
+	}
+	return text, names, args
+}
+
+// The reported case on the Gemini path: Gemini CLI to a custom provider's
+// Gemini URL, relayed as it came, and Vertex AI's whole generateContent
+// reply the same.
+func TestInvokeReportedGeminiPassthrough(t *testing.T) {
+	fresh(t)
+	geminiTools := `"tools":[{"functionDeclarations":[{"name":"ToolSearch","parameters":{"type":"object"}},{"name":"Bash","parameters":{"type":"object"}}]}]`
+	ask := func(stream bool) string {
+		rec := httptest.NewRecorder()
+		path := "/v1beta/models/a/m:generateContent"
+		if stream {
+			path = "/v1beta/models/a/m:streamGenerateContent?alt=sse"
+		}
+		New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", path, strings.NewReader(
+			`{"contents":[{"role":"user","parts":[{"text":"帮我使用magpie的browser打开谷歌"}]}],`+geminiTools+`}`)))
+		if rec.Code != 200 {
+			t.Fatalf("%d %s", rec.Code, rec.Body.String())
+		}
+		return rec.Body.String()
+	}
+
+	stream := func(sse string) string {
+		srv := &scripted{replies: []reply{{200, "text/event-stream", sse}}}
+		upSSE := httptest.NewServer(srv)
+		t.Cleanup(upSSE.Close)
+		if err := provider.Save(provider.Provider{ID: "a", Name: "A", Key: "k", Models: []string{"m"}, Gemini: upSSE.URL + "/v1beta"}); err != nil {
+			t.Fatal(err)
+		}
+		return ask(true)
+	}
+
+	raw := stream(geminiSSE(invokeReported))
+	text, names, args := geminiRead(t, raw)
+	var texts string
+	if text != "" || len(names) != 1 || names[0] != "ToolSearch" || string(args[0]) != invokeQuery ||
+		strings.Contains(raw, "Result") || strings.Contains(raw, "invoke") {
+		t.Fatalf("text %q names %v args %v\n%s", text, names, args, raw)
+	}
+
+	// text before the call stays, and the call follows it
+	raw = stream(geminiSSE("我来打开谷歌。\n\n" + invokeReported))
+	text, names, args = geminiRead(t, raw)
+	if text != "我来打开谷歌。\n\n" || len(names) != 1 || string(args[0]) != invokeQuery {
+		t.Fatalf("lead: text %q names %v args %v\n%s", text, names, args, raw)
+	}
+
+	// text that only names an invoke of no offered tool goes as it came
+	plain := "Write it as <invoke name=\"rm_rf\"><parameter name=\"p\">/</parameter></invoke>, then stop."
+	raw = stream(geminiSSE(plain))
+	text, names, _ = geminiRead(t, raw)
+	if text != plain || len(names) != 0 {
+		t.Fatalf("plain: text %q names %v\n%s", text, names, raw)
+	}
+
+	// Vertex AI's whole generateContent reply
+	v := &vertexUp{reply: func(n int, body map[string]any) (int, string) {
+		cand := map[string]any{
+			"content":      map[string]any{"role": "model", "parts": []any{map[string]any{"text": "好的。\n" + invokeReported}}},
+			"finishReason": "STOP",
+		}
+		b, _ := json.Marshal(map[string]any{"candidates": []any{cand}})
+		return 200, string(b)
+	}}
+	vs := vertexServe(t, v, vertexLevels)
+	rec := httptest.NewRecorder()
+	vs.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1beta/models/google-vertex/gemini-3.8-flash:generateContent", strings.NewReader(
+		`{"contents":[{"role":"user","parts":[{"text":"帮我使用magpie的browser打开谷歌"}]}],`+geminiTools+`}`)))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	raw = rec.Body.String()
+	var gots struct {
+		Candidates []struct {
+			Content struct {
+				Parts []struct {
+					Text string `json:"text"`
+					Call struct {
+						Name string          `json:"name"`
+						Args json.RawMessage `json:"args"`
+					} `json:"functionCall"`
+				} `json:"parts"`
+			} `json:"content"`
+		} `json:"candidates"`
+	}
+	if err := json.Unmarshal([]byte(raw), &gots); err != nil {
+		t.Fatalf("%v: %s", err, raw)
+	}
+	names, args, texts = nil, nil, ""
+	for _, c := range gots.Candidates {
+		for _, p := range c.Content.Parts {
+			if p.Call.Name != "" {
+				names, args = append(names, p.Call.Name), append(args, p.Call.Args)
+			} else {
+				texts += p.Text
+			}
+		}
+	}
+	if texts != "好的。\n" || len(names) != 1 || names[0] != "ToolSearch" || string(args[0]) != invokeQuery {
+		t.Fatalf("whole: texts %q names %v args %v\n%s", texts, names, args, raw)
+	}
+}
+
 // Translated, the reported reply from a Chat model reaches a Messages
 // client (Claude Code) as the call, streamed and whole.
 func TestInvokeReportedTranslated(t *testing.T) {
diff --git a/internal/gateway/textcalls_relay.go b/internal/gateway/textcalls_relay.go
new file mode 100644
index 000000000..fea3d7764
--- /dev/null
+++ b/internal/gateway/textcalls_relay.go
@@ -0,0 +1,715 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/json"
+	"strings"
+
+	"github.com/tidwall/gjson"
+)
+
+// responsesTextCalls does what textCallTidy does in a Responses reply
+// relayed as it came (passthrough): a Responses client (Codex) on a
+// provider that speaks Responses itself, whose model wrote its calls into
+// its text (#4743: it reached the agent as text, and the turn ended with
+// nothing run). Only a translated reply was read for them before. Text
+// from where a call begins is held; the message item's output_text.done,
+// content_part.done and output_item.done wait with it; at the reply's end
+// the held calls become function_call items after it, in the events and
+// in response.completed's output, which must match. Held text that isn't
+// calls goes on as it came. A reply that came whole is read as
+// wholeTextCalls reads a Chat one.
+
+// responsesToolNames are the function tools of a Responses request.
+func responsesToolNames(body []byte) map[string]bool {
+	var q struct {
+		Tools []struct {
+			Name string `json:"name"`
+		} `json:"tools"`
+	}
+	if decodeJSON(body, &q) != nil || len(q.Tools) == 0 {
+		return nil
+	}
+	m := map[string]bool{}
+	for _, t := range q.Tools {
+		if t.Name != "" {
+			m[t.Name] = true
+		}
+	}
+	if len(m) == 0 {
+		return nil
+	}
+	return m
+}
+
+// geminiToolNames are the function tools of a Gemini request.
+func geminiToolNames(body []byte) map[string]bool {
+	var q struct {
+		Tools []struct {
+			FunctionDeclarations []struct {
+				Name string `json:"name"`
+			} `json:"functionDeclarations"`
+		} `json:"tools"`
+	}
+	if decodeJSON(body, &q) != nil || len(q.Tools) == 0 {
+		return nil
+	}
+	m := map[string]bool{}
+	for _, t := range q.Tools {
+		for _, d := range t.FunctionDeclarations {
+			if d.Name != "" {
+				m[d.Name] = true
+			}
+		}
+	}
+	if len(m) == 0 {
+		return nil
+	}
+	return m
+}
+
+type responsesTextCalls struct {
+	names map[string]bool
+	sse   bool
+	buf   []byte
+	seq   int // the last sequence_number the stream carried, -1 for none
+
+	pending string
+	held    string
+	holding bool
+	native  bool // the reply made a call itself
+
+	itemID   string // the held text's item, as its deltas name it
+	itemIdx  int    // its output_index
+	partIdx  int    // its content_index
+	top      int    // one past the highest output_index seen
+	textDone []byte // its output_text.done, held
+	partDone []byte // its content_part.done, held
+	itemDone []byte // its output_item.done, held
+}
+
+func (t *responsesTextCalls) write(b []byte) []byte {
+	t.buf = append(t.buf, b...)
+	if !t.sse {
+		return nil
+	}
+	out, rest := tidyEvents(t.buf, t.event)
+	t.buf = rest
+	return out
+}
+
+func (t *responsesTextCalls) flush() []byte {
+	b := t.buf
+	t.buf = nil
+	if !t.sse {
+		return t.whole(b)
+	}
+	var out []byte
+	if len(b) > 0 {
+		out = t.event(b)
+	}
+	return append(out, t.release()...)
+}
+
+// reData is ev with its data given again as v said, nil when it can't be
+// said.
+func reData(ev []byte, v any) []byte {
+	nb, err := marshalPlain(v)
+	if err != nil {
+		return nil
+	}
+	return withData(ev, nb)
+}
+
+// send is one event of the reply's own, numbered on from the last one the
+// upstream sent.
+func (t *responsesTextCalls) send(typ string, fields map[string]any) []byte {
+	if t.seq >= 0 {
+		t.seq++
+		fields["sequence_number"] = t.seq
+	}
+	fields["type"] = typ
+	b, err := marshalPlain(fields)
+	if err != nil {
+		return nil
+	}
+	return []byte("event: " + typ + "\ndata: " + string(b) + "\n\n")
+}
+
+// textDelta is the held text's part given another delta of text.
+func (t *responsesTextCalls) textDelta(s string) []byte {
+	if s == "" {
+		return nil
+	}
+	return t.send("response.output_text.delta", map[string]any{"item_id": t.itemID,
+		"output_index": t.itemIdx, "content_index": t.partIdx, "delta": s, "logprobs": []any{}})
+}
+
+// release hands back what is held: the text as a delta of its own, the
+// part's and the item's done events as they came.
+func (t *responsesTextCalls) release() []byte {
+	out := t.textDelta(t.pending + t.held)
+	t.pending, t.held, t.holding = "", "", false
+	out = append(out, t.textDone...)
+	out = append(out, t.partDone...)
+	out = append(out, t.itemDone...)
+	t.textDone, t.partDone, t.itemDone = nil, nil, nil
+	return out
+}
+
+// doneText rewrites the text of the held done events to s.
+func (t *responsesTextCalls) doneText(s string) []byte {
+	var out []byte
+	for _, ev := range [][]byte{t.textDone, t.partDone} {
+		if ev == nil {
+			continue
+		}
+		var e map[string]any
+		ne := ev
+		if decodeNumbers(eventData(ev), &e) == nil {
+			if _, ok := e["part"]; ok {
+				if part, _ := e["part"].(map[string]any); part != nil {
+					part["text"] = s
+				}
+			} else {
+				e["text"] = s
+			}
+			if nb := reData(ev, e); nb != nil {
+				ne = nb
+			}
+		}
+		out = append(out, ne...)
+	}
+	return out
+}
+
+// itemText rewrites the held message item's part's text to s.
+func (t *responsesTextCalls) itemText(s string) []byte {
+	if t.itemDone == nil {
+		return nil
+	}
+	var e map[string]any
+	ne := t.itemDone
+	if decodeNumbers(eventData(t.itemDone), &e) == nil {
+		if item, _ := e["item"].(map[string]any); item != nil {
+			if content, _ := item["content"].([]any); len(content) > t.partIdx {
+				if part, _ := content[t.partIdx].(map[string]any); part != nil && part["type"] == "output_text" {
+					part["text"] = s
+					if nb := reData(t.itemDone, e); nb != nil {
+						ne = nb
+					}
+				}
+			}
+		}
+	}
+	return ne
+}
+
+// event is one whole event of the stream, given on, held or made into
+// others.
+func (t *responsesTextCalls) event(ev []byte) []byte {
+	data := eventData(ev)
+	typ := gjson.GetBytes(data, "type").String()
+	if sq := gjson.GetBytes(data, "sequence_number"); sq.Exists() {
+		t.seq = int(sq.Int())
+	}
+	if oi := gjson.GetBytes(data, "output_index"); oi.Exists() {
+		t.top = max(t.top, int(oi.Int())+1)
+	}
+	switch typ {
+	case "response.output_item.added":
+		// a call the reply made itself (a function_call, Codex's
+		// custom_tool_call and tool_search_call, a shell's or search's):
+		// no call is read out of the text beside it
+		if s := gjson.GetBytes(data, "item.type").String(); strings.HasSuffix(s, "_call") {
+			t.native = true
+		}
+		return ev
+	case "response.output_text.delta":
+		t.itemID = gjson.GetBytes(data, "item_id").String()
+		t.itemIdx = int(gjson.GetBytes(data, "output_index").Int())
+		t.partIdx = int(gjson.GetBytes(data, "content_index").Int())
+		s := t.pending + gjson.GetBytes(data, "delta").String()
+		t.pending = ""
+		if t.holding {
+			t.held += s
+			return nil
+		}
+		if at, tail := textCallAt(s); at >= 0 {
+			t.holding, t.held, s = true, s[at:], s[:at]
+		} else {
+			t.pending, s = s[len(s)-tail:], s[:len(s)-tail]
+		}
+		t.pending, t.held, s = spaceBack(t.native, t.holding, t.pending, t.held, s)
+		if s == "" {
+			return nil
+		}
+		var e map[string]any
+		if decodeNumbers(data, &e) != nil {
+			return ev
+		}
+		e["delta"] = s
+		if nb := reData(ev, e); nb != nil {
+			return nb
+		}
+		return ev
+	case "response.output_text.done":
+		if !t.holding {
+			// a mark's beginning cut short at the part's end is just text
+			out := t.textDelta(t.pending)
+			t.pending = ""
+			return append(out, ev...)
+		}
+		if t.textDone == nil {
+			t.textDone = append([]byte(nil), ev...)
+			return nil
+		}
+		return ev
+	case "response.content_part.done":
+		if t.holding && t.partDone == nil {
+			t.partDone = append([]byte(nil), ev...)
+			return nil
+		}
+		return ev
+	case "response.output_item.done":
+		if t.holding && t.itemDone == nil && gjson.GetBytes(data, "item.type").String() == "message" &&
+			gjson.GetBytes(data, "item.id").String() == t.itemID {
+			t.itemDone = append([]byte(nil), ev...)
+			return nil
+		}
+		return ev
+	case "response.completed":
+		return t.completed(ev, data)
+	case "response.incomplete", "response.failed", "error":
+		return append(t.release(), ev...)
+	}
+	return ev
+}
+
+// completed is the reply's end: the held calls become the items the reply
+// made, in the events and in the completed response's output.
+func (t *responsesTextCalls) completed(ev, data []byte) []byte {
+	if !t.holding {
+		return append(t.release(), ev...)
+	}
+	prefix := func(done []byte) string {
+		s := gjson.GetBytes(eventData(done), "text").String()
+		if s == "" {
+			if part := gjson.GetBytes(eventData(done), "part.text"); part.Exists() {
+				s = part.String()
+			}
+		}
+		return strings.TrimSuffix(s, t.held)
+	}
+	if t.native {
+		// tags left in the text of a reply that made calls itself go, as
+		// a Chat reply's do; anything else goes as it came
+		if !tagsOnly(t.held) {
+			return append(t.release(), ev...)
+		}
+		s := strings.TrimRight(prefix(t.textDone), " \t\r\n")
+		out := t.doneText(s)
+		out = append(out, t.itemText(s)...)
+		t.pending, t.held, t.holding = "", "", false
+		t.textDone, t.partDone, t.itemDone = nil, nil, nil
+		return append(out, t.rewritten(ev, data, s, nil)...)
+	}
+	calls, rest, ok := parseTextCalls(t.held, t.names)
+	if !ok {
+		return append(t.release(), ev...)
+	}
+	s := prefix(t.textDone) + rest
+	out := t.doneText(s)
+	var items []map[string]any
+	next := t.top
+	if t.itemDone == nil {
+		// nothing of the item's end went: the calls take its place from
+		// its own index on
+		next = t.itemIdx
+	} else {
+		// the item's done, with its part's text said again
+		out = append(out, t.itemText(s)...)
+	}
+	t.pending, t.held, t.holding = "", "", false
+	t.textDone, t.partDone, t.itemDone = nil, nil, nil
+	for _, c := range calls {
+		id, callID := "fc_"+newID(), "call_"+newID()
+		item := map[string]any{"type": "function_call", "id": id, "call_id": callID,
+			"name": c.Name, "arguments": string(c.Args), "status": "completed"}
+		out = append(out, t.send("response.output_item.added", map[string]any{"output_index": next,
+			"item": map[string]any{"type": "function_call", "id": id, "call_id": callID,
+				"name": c.Name, "arguments": "", "status": "in_progress"}})...)
+		out = append(out, t.send("response.function_call_arguments.delta", map[string]any{"item_id": id,
+			"output_index": next, "delta": string(c.Args)})...)
+		out = append(out, t.send("response.function_call_arguments.done", map[string]any{"item_id": id,
+			"output_index": next, "call_id": callID, "arguments": string(c.Args)})...)
+		out = append(out, t.send("response.output_item.done", map[string]any{"output_index": next, "item": item})...)
+		items = append(items, item)
+		next++
+	}
+	t.top = next
+	return append(out, t.rewritten(ev, data, s, items)...)
+}
+
+// rewritten is the reply's last event with its output saying what the
+// client was told: the held text's item's part saying s, the calls made
+// items of the reply.
+func (t *responsesTextCalls) rewritten(ev, data []byte, s string, items []map[string]any) []byte {
+	if len(items) == 0 && t.itemDone == nil {
+		return ev
+	}
+	var e map[string]any
+	if decodeNumbers(data, &e) != nil {
+		return ev
+	}
+	res, _ := e["response"].(map[string]any)
+	if res == nil {
+		return ev
+	}
+	out, _ := res["output"].([]any)
+	changed := len(items) > 0
+	for _, it := range out {
+		m, _ := it.(map[string]any)
+		if m == nil || m["id"] != t.itemID {
+			continue
+		}
+		content, _ := m["content"].([]any)
+		if len(content) > t.partIdx {
+			if part, _ := content[t.partIdx].(map[string]any); part != nil && part["type"] == "output_text" {
+				part["text"] = s
+				changed = true
+			}
+		}
+		break
+	}
+	for _, it := range items {
+		out = append(out, it)
+	}
+	if !changed {
+		return ev
+	}
+	res["output"] = out
+	if nb := reData(ev, e); nb != nil {
+		return nb
+	}
+	return ev
+}
+
+// whole reads the calls written into the last text part of a Responses
+// reply that came whole: they become function_call items of the reply's
+// output. A reply that made a call itself, or whose written blocks aren't
+// all calls of names, goes as it came.
+func (t *responsesTextCalls) whole(b []byte) []byte {
+	if !mayWriteCalls(b, t.names) {
+		return b
+	}
+	var reply map[string]any
+	if decodeNumbers(b, &reply) != nil || reply == nil {
+		return b
+	}
+	out, _ := reply["output"].([]any)
+	if len(out) == 0 {
+		return b
+	}
+	native := false
+	for _, it := range out {
+		if m, _ := it.(map[string]any); m != nil {
+			if s, _ := m["type"].(string); strings.HasSuffix(s, "_call") {
+				native = true
+			}
+		}
+	}
+	at := -1
+	var part map[string]any
+	for _, it := range out {
+		m, _ := it.(map[string]any)
+		if m == nil || m["type"] != "message" {
+			continue
+		}
+		content, _ := m["content"].([]any)
+		for _, c := range content {
+			p, _ := c.(map[string]any)
+			if p == nil || p["type"] != "output_text" {
+				continue
+			}
+			s, _ := p["text"].(string)
+			if n, _ := textCallAt(s); n >= 0 {
+				at, part = n, p
+			}
+		}
+	}
+	if part == nil {
+		return b
+	}
+	s, _ := part["text"].(string)
+	if native {
+		// tags left in the text of a reply that made calls itself go, as
+		// a Chat reply's do
+		if !tagsOnly(s[at:]) {
+			return b
+		}
+		part["text"] = strings.TrimRight(s[:at], " \t\r\n")
+	} else {
+		calls, rest, ok := parseTextCalls(s[at:], t.names)
+		if !ok {
+			return b
+		}
+		part["text"] = s[:at] + rest
+		for _, c := range calls {
+			out = append(out, map[string]any{"type": "function_call", "id": "fc_" + newID(),
+				"call_id": "call_" + newID(), "name": c.Name, "arguments": string(c.Args), "status": "completed"})
+		}
+	}
+	reply["output"] = out
+	nb, err := marshalPlain(reply)
+	if err != nil {
+		return b
+	}
+	return nb
+}
+
+// geminiTextCalls does the same in a Gemini reply relayed as it came
+// (#4743): a Gemini client (Gemini CLI) on a custom provider's Gemini URL
+// or Vertex AI, whose model wrote its calls into its text. Text parts are
+// read as the chunks come; at the candidate's finishReason the held calls
+// become functionCall parts after the text. A reply that came whole
+// (Vertex AI's generateContent) is read the same over its
+// candidates[].content.parts.
+
+type gemHold struct {
+	pending string
+	held    string
+	holding bool
+	native  bool // the candidate made a call itself
+}
+
+type geminiTextCalls struct {
+	names map[string]bool
+	sse   bool
+	buf   []byte
+	holds map[int]*gemHold
+}
+
+func (t *geminiTextCalls) hold(i int) *gemHold {
+	if t.holds == nil {
+		t.holds = map[int]*gemHold{}
+	}
+	if t.holds[i] == nil {
+		t.holds[i] = &gemHold{}
+	}
+	return t.holds[i]
+}
+
+func (t *geminiTextCalls) write(b []byte) []byte {
+	t.buf = append(t.buf, b...)
+	if !t.sse {
+		return nil
+	}
+	i := bytes.LastIndexByte(t.buf, '\n')
+	if i < 0 {
+		return nil
+	}
+	var out []byte
+	for _, line := range bytes.SplitAfter(t.buf[:i+1], []byte("\n")) {
+		out = append(out, t.line(line)...)
+	}
+	t.buf = append(t.buf[:0], t.buf[i+1:]...)
+	return out
+}
+
+func (t *geminiTextCalls) flush() []byte {
+	b := t.buf
+	t.buf = nil
+	if !t.sse {
+		return t.whole(b)
+	}
+	var out []byte
+	if len(b) > 0 {
+		out = t.line(b)
+	}
+	return out
+}
+
+func (t *geminiTextCalls) line(line []byte) []byte {
+	body := bytes.TrimRight(line, "\r\n")
+	data, ok := bytes.CutPrefix(body, []byte("data:"))
+	if !ok {
+		return line
+	}
+	data = bytes.TrimSpace(data)
+	if len(data) == 0 || string(data) == "[DONE]" {
+		return line
+	}
+	var ch map[string]any
+	if decodeNumbers(data, &ch) != nil || ch == nil {
+		return line
+	}
+	if !t.candidates(ch) {
+		return line
+	}
+	nb, err := marshalPlain(ch)
+	if err != nil {
+		return line
+	}
+	return append(append([]byte("data: "), nb...), line[len(body):]...)
+}
+
+// candidates reads a chunk's candidates in place: text parts held or
+// trimmed, the held calls made functionCall parts at the finishReason. It
+// says whether the chunk changed.
+func (t *geminiTextCalls) candidates(ch map[string]any) bool {
+	cands, _ := ch["candidates"].([]any)
+	changed := false
+	for i, ci := range cands {
+		c, _ := ci.(map[string]any)
+		if c == nil {
+			continue
+		}
+		h := t.hold(i)
+		content, _ := c["content"].(map[string]any)
+		parts, _ := content["parts"].([]any)
+		keep := parts[:0:0]
+		for _, pi := range parts {
+			p, _ := pi.(map[string]any)
+			switch {
+			case p == nil:
+				keep = append(keep, p)
+			case p["functionCall"] != nil:
+				h.native = true
+				keep = append(keep, p)
+			default:
+				was, isText := p["text"].(string)
+				if !isText {
+					keep = append(keep, p)
+					continue
+				}
+				if thought, _ := p["thought"].(bool); thought {
+					keep = append(keep, p)
+					continue
+				}
+				s := h.pending + was
+				h.pending = ""
+				if h.holding {
+					h.held += s
+					changed = true
+					continue
+				}
+				if at, tail := textCallAt(s); at >= 0 {
+					h.holding, h.held, s = true, s[at:], s[:at]
+				} else {
+					h.pending, s = s[len(s)-tail:], s[:len(s)-tail]
+				}
+				if s != was {
+					changed = true
+				}
+				if s != "" {
+					p["text"] = s
+					keep = append(keep, p)
+				}
+			}
+		}
+		if fin, _ := c["finishReason"].(string); fin != "" {
+			// the candidate is done: what it held becomes calls, or goes
+			// back as the text it was; tags left beside calls of its own go
+			s := h.pending
+			h.pending = ""
+			if h.holding {
+				h.holding = false
+				switch {
+				case !h.native:
+					if calls, rest, ok := parseTextCalls(h.held, t.names); ok {
+						h.held = ""
+						s += rest
+						for _, c := range calls {
+							keep = append(keep, map[string]any{"functionCall": map[string]any{
+								"name": c.Name, "args": json.RawMessage(c.Args)}})
+						}
+					} else {
+						s += h.held
+					}
+					h.held = ""
+				case tagsOnly(h.held):
+					h.held = ""
+				default:
+					s += h.held
+					h.held = ""
+				}
+				changed = true
+			}
+			if s != "" {
+				keep = append(keep, map[string]any{"text": s})
+				changed = true
+			}
+		}
+		if changed && content != nil {
+			content["parts"] = keep
+		}
+	}
+	return changed
+}
+
+// whole reads the calls written into the last text part of each of a
+// Gemini reply's candidates: they become functionCall parts after it. A
+// candidate that made a call itself goes as it came.
+func (t *geminiTextCalls) whole(b []byte) []byte {
+	if !mayWriteCalls(b, t.names) {
+		return b
+	}
+	var ch map[string]any
+	if decodeNumbers(b, &ch) != nil || ch == nil {
+		return b
+	}
+	cands, _ := ch["candidates"].([]any)
+	changed := false
+	for _, ci := range cands {
+		c, _ := ci.(map[string]any)
+		if c == nil {
+			continue
+		}
+		content, _ := c["content"].(map[string]any)
+		parts, _ := content["parts"].([]any)
+		native, part := false, map[string]any(nil)
+		for _, pi := range parts {
+			p, _ := pi.(map[string]any)
+			if p == nil {
+				continue
+			}
+			if p["functionCall"] != nil {
+				native = true
+				continue
+			}
+			if _, ok := p["text"].(string); ok {
+				if thought, _ := p["thought"].(bool); !thought {
+					part = p
+				}
+			}
+		}
+		if part == nil || native {
+			continue
+		}
+		s, _ := part["text"].(string)
+		at, _ := textCallAt(s)
+		if at < 0 {
+			continue
+		}
+		calls, rest, ok := parseTextCalls(s[at:], t.names)
+		if !ok {
+			continue
+		}
+		part["text"] = s[:at] + rest
+		for _, c := range calls {
+			parts = append(parts, map[string]any{"functionCall": map[string]any{
+				"name": c.Name, "args": json.RawMessage(c.Args)}})
+		}
+		content["parts"] = parts
+		changed = true
+	}
+	if !changed {
+		return b
+	}
+	nb, err := marshalPlain(ch)
+	if err != nil {
+		return b
+	}
+	return nb
+}
-- 
2.50.1 (Apple Git-155)

````

</details>

Branch with the commit: [fix/4743-relay-call-text-read](https://github.com/ggbdpq/magpie/tree/fix/4743-relay-call-text-read) (head `c1ade7e72c8e511f801628cc4a55dd63e5eac7c8`).

