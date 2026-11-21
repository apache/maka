**Summary**

With `tools` declared and the model answering in text alone, the streamed reply's final frame carries `"function_call":{"name":"","arguments":""}` where OpenAI's contract has `null` (or the field absent). A client that checks every frame's shape reads the empty object for a legacy function call and refuses the whole turn — OpenMausBot's `legacy function_call is unsupported; use structured tool_calls` — so every text-only reply a tools-carrying request got was a turn lost. Loose clients merge the empty object into nothing, which is why this stayed hidden.

**Minimal repro**

The issue's curl against a WorkBuddy/DeepSeek route (`tools` + `stream: true`, the model told to answer in words) prints `"function_call":{"name":"","arguments":""}` from the last frame, 2/2 runs, while no-tools streams keep `"function_call":null` all through and a non-streamed message carries no `function_call` at all. In-repo, the new `TestStreamedEmptyFunctionCallLeftOut` reproduces it with no network: a Chat upstream that ends its stream the way WorkBuddy's does, a tools-carrying request, and the client's body read back.

**Root cause**

The frame crossed magpie's Chat relay untouched. chatTidy mended the frame's other quirks on the way — the `"finish_reason":""` became null, the empty `tool_calls:[]` was left out — but it had no rule for `function_call`, so an empty object went through as it came. Nothing on a relayed stream constructs that object in magpie: the tidy paths keep every field byte for byte or write null for null (I traced the encode paths and searched for any type or map that could marshal it), so the empty object is the upstream's own frame — its wire is a Go-style map encode, and the same final frame on a no-tools stream carries `"function_call":null`. Whichever end writes it, the gateway is where a client-facing frame gets mended, as #1475 did for a tool call that names no function: an empty `function_call` says nothing and runs nowhere, so it is no call.

**Fix**

chatTidy leaves out a delta's `function_call` that carries nothing — a name and arguments both empty strings or null, either absent (#4659). A `null` is the contract's own nothing and goes as it came. A call whose name or arguments hold something is one a client may still be reading, and a name or arguments of another kind than a string is not read: both untouched. Lines with `"function_call":null` never enter the mending path — the shape gate matches `"function_call":{` only — so the common frame costs one byte scan, like the gates already there.

**Verification**

| Check | Result |
| --- | --- |
| `TestStreamedEmptyFunctionCallLeftOut` (WorkBuddy's final frame, tools + text-only) | RED before the fix — "an empty function_call object went out where the contract has null"; GREEN after |
| `TestStreamedNamedFunctionCallKept` (a legacy call naming a function, its arguments fragment, its `function_call` finish) | GREEN, untouched by the mend |
| Ablation: `chattidy.go` reverted to the base commit, tests kept | the symptom test went RED again with the same output |
| `go test ./internal/gateway/ -tags nogui` (whole package) | ok |
| Targeted tests under `-race` | ok |
| `gofmt -l` on changed files, `go vet` on the package | clean |
| Builds: linux/amd64, windows/amd64, darwin/arm64 (`-tags nogui`) | ok (pre-existing C enum-conversion warnings in internal/gui on darwin) |
| `git apply --check` of the patch on upstream/main (5416fdb76) | applies cleanly |

**Not verified**

- Against the signed-in WorkBuddy route itself: the repro needs a real WorkBuddy/DeepSeek account with tools, so the vendor-side frame comes from this issue's capture and the repo's recorded WorkBuddy wire, not from a fresh run. The mend holds whichever end writes the empty object.
- No dedicated end-to-end run of the group and translated paths against a vendor: both are covered by the package suite, and the translated encoders never write a `function_call` field at all.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Chat legacy function_call carrying nothing is left out (#4659) — git am applies it as is; SHA-256 first 16: bc0d0899e33cc3f3</summary>

````
From 10865c44c58d6b98c364ee0bddfcb25663589e1f Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 16:12:51 +0800
Subject: [PATCH] gateway: a Chat legacy function_call carrying nothing is left
 out (#4659)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

jinccc-ctrl on #4659: with tools declared and the model answering in text
alone, WorkBuddy's stream ended on a frame whose function_call was an
empty object where the contract has null, and OpenMausBot, which checks
every frame's shape, read the empty object for a legacy call and refused
the whole turn ("legacy function_call is unsupported; use structured
tool_calls") — so every text reply a tools-carrying request got was a
turn lost, while clients that merge silently never noticed.

An empty function_call — a name and arguments both empty — says nothing
and runs nowhere, so chatTidy leaves it out, as it leaves out an empty
reasoning_content, an empty tool_calls and a nameless call (#1475). A
null goes as it came, and a call whose name or arguments hold something
is one a client may still be reading: both untouched, as is a name or
arguments of another kind than a string.

Run (darwin/arm64, go test ./internal/gateway/ -tags nogui):

  internal/gateway/function_call_null_test.go:32: an empty function_call
  object went out where the contract has null (#4659) — before the fix;
  after, TestStreamedEmptyFunctionCallLeftOut and
  TestStreamedNamedFunctionCallKept pass, the full gateway package
  passes, and gofmt, go vet, -race on the targeted tests and
  linux/windows/darwin builds are clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/chattidy.go                | 37 ++++++++++++-
 internal/gateway/function_call_null_test.go | 61 +++++++++++++++++++++
 2 files changed, 96 insertions(+), 2 deletions(-)
 create mode 100644 internal/gateway/function_call_null_test.go

diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index 01406ee69..fe7e23e6a 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -79,6 +79,16 @@ import (
 // is; a name of another kind on a later fragment is left out, the first
 // one's kept.
 //
+// And a legacy function_call that carries nothing — a name and arguments
+// both empty — is left out too (#4659): WorkBuddy's stream ends a reply
+// of plain text on a frame with "function_call":{"name":"","arguments":""}
+// where the contract has null, and a client that checks the shape of
+// every frame reads the empty object for a legacy call and refuses the
+// whole turn, so every text reply a tools-carrying request got was a
+// turn lost (jinccc-ctrl). An empty one runs nowhere, as a nameless call
+// is no call; a null goes as it came, and a call whose name or arguments
+// hold something is one a client may still be reading.
+//
 // Lines pass whole, as they came, unless one has any of them.
 type chatTidy struct {
 	buf     []byte
@@ -98,6 +108,7 @@ var (
 	contentParts      = []byte(`"content":[`)
 	contentPartsSpace = []byte(`"content": [`)
 	toolCallsField    = []byte(`"tool_calls"`)
+	functionCallField = []byte(`"function_call":{`)
 )
 
 // write takes what was read and gives back what to send on: every line
@@ -146,7 +157,8 @@ func needsTidy(line []byte) bool {
 		bytes.Contains(line, emptyToolCalls) ||
 		bytes.Contains(line, contentParts) ||
 		bytes.Contains(line, contentPartsSpace) ||
-		bytes.Contains(line, toolCallsField)
+		bytes.Contains(line, toolCallsField) ||
+		bytes.Contains(line, functionCallField)
 }
 
 // needs is needsTidy, a finish_reason once a choice made a call, and a
@@ -279,7 +291,12 @@ func (t *chatTidy) line(line []byte) []byte {
 		if calls, ok := delta["tool_calls"]; ok && string(calls) == "[]" {
 			delete(delta, "tool_calls")
 			inDelta = true
-		} else if ok {
+		}
+		if fc, ok := delta["function_call"]; ok && emptyFunctionCall(fc) {
+			delete(delta, "function_call")
+			inDelta = true
+		}
+		if calls, ok := delta["tool_calls"]; ok {
 			if t.indexes == nil {
 				t.indexes = streamCallIndexes{}
 			}
@@ -351,6 +368,22 @@ func (t *chatTidy) line(line []byte) []byte {
 	return append(append([]byte("data: "), nb...), end...)
 }
 
+// emptyFunctionCall reports whether raw is a legacy function_call
+// carrying nothing: a name and arguments both empty strings or nulls,
+// either absent (#4659). A null is the contract's own nothing and is not
+// this; a name or arguments of another kind than a string is not read,
+// and the call goes as it came.
+func emptyFunctionCall(raw json.RawMessage) bool {
+	if string(bytes.TrimSpace(raw)) == "null" {
+		return false
+	}
+	var fc struct {
+		Name      string `json:"name"`
+		Arguments string `json:"arguments"`
+	}
+	return decodeJSON(raw, &fc) == nil && fc.Name == "" && fc.Arguments == ""
+}
+
 // withoutEmptyNames drops the empty "name" on a delta's tool-call
 // fragments and reports whether any was dropped. A fragment whose
 // function carries no name at all is left as it is; one with a real name
diff --git a/internal/gateway/function_call_null_test.go b/internal/gateway/function_call_null_test.go
new file mode 100644
index 000000000..bd3ba53eb
--- /dev/null
+++ b/internal/gateway/function_call_null_test.go
@@ -0,0 +1,61 @@
+package gateway
+
+import (
+	"strings"
+	"testing"
+)
+
+// jinccc-ctrl on #4659: with tools declared and the model answering in
+// text alone, WorkBuddy's stream ends on a frame whose function_call is
+// an empty object where OpenAI's contract has null. A client that checks
+// every frame's shape reads the empty object for a legacy call and
+// refuses the whole turn ("legacy function_call is unsupported"), so a
+// reply of plain text is a turn lost whenever the client offered tools.
+// An empty function_call — a name and arguments both empty — says
+// nothing, so it is left out; a null goes as it came.
+func TestStreamedEmptyFunctionCallLeftOut(t *testing.T) {
+	fresh(t)
+	wire := sse(
+		`data: {"choices":[{"delta":{"content":"","extra_fields":null,"function_call":null,"refusal":"","role":"assistant","tool_calls":[]},"finish_reason":"","index":0,"logprobs":null}],"created":1793498714,"id":"bda44076918cd5aad55494cabc17cf51","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}`,
+		`data: {"choices":[{"delta":{"content":"你好！","extra_fields":null,"function_call":null,"refusal":"","role":"assistant","tool_calls":[]},"finish_reason":"","index":0,"logprobs":null}],"created":1793498714,"id":"bda44076918cd5aad55494cabc17cf51","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}`,
+		`data: {"choices":[{"delta":{"content":"","extra_fields":null,"function_call":{"name":"","arguments":""},"refusal":"","role":"assistant"},"finish_reason":"stop","index":0,"logprobs":null}],"created":0,"id":"bda44076918cd5aad55494cabc17cf51","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}`,
+		`data: [DONE]`)
+	a := &scripted{replies: []reply{{200, "text/event-stream", wire}}}
+	serveOn(t, "a", "ka", []string{"m"}, a)
+	s := New()
+	ask := `{"model":"m","stream":true,"messages":[{"role":"user","content":"说声你好，别调工具"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],"max_tokens":100}`
+	code, body := postAs(t, s, "", ask)
+	if code != 200 || !strings.Contains(body, "你好！") {
+		t.Fatalf("%d %s", code, body)
+	}
+	if strings.Contains(body, `"function_call":{"name":"","arguments":""}`) {
+		t.Fatalf("an empty function_call object went out where the contract has null (#4659): %s", body)
+	}
+	if !strings.Contains(body, `"function_call":null`) {
+		t.Fatalf("a function_call null did not go as it came: %s", body)
+	}
+}
+
+// A legacy function_call that names a function is a call a client may
+// still be reading, its arguments a later fragment's to finish: both go
+// as they came, and so does the finish that names one.
+func TestStreamedNamedFunctionCallKept(t *testing.T) {
+	fresh(t)
+	wire := sse(
+		`data: {"choices":[{"delta":{"function_call":{"name":"get_weather","arguments":""}},"finish_reason":null,"index":0}]}`,
+		`data: {"choices":[{"delta":{"function_call":{"name":"","arguments":"{\"city\":\"北京\"}"}},"finish_reason":null,"index":0}]}`,
+		`data: {"choices":[{"delta":{},"finish_reason":"function_call","index":0}]}`,
+		`data: [DONE]`)
+	a := &scripted{replies: []reply{{200, "text/event-stream", wire}}}
+	serveOn(t, "a", "ka", []string{"m"}, a)
+	s := New()
+	ask := `{"model":"m","stream":true,"messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}`
+	code, body := postAs(t, s, "", ask)
+	if code != 200 {
+		t.Fatalf("%d %s", code, body)
+	}
+	if !strings.Contains(body, `"function_call":{"name":"get_weather","arguments":""}`) ||
+		!strings.Contains(body, `"function_call":{"name":"","arguments":"{\"city\":\"北京\"}"}`) {
+		t.Fatalf("a legacy call naming a function did not go as it came: %s", body)
+	}
+}
-- 
2.50.1 (Apple Git-155)
````

</details>

Branch with the commit: [hunt115-a-4659](https://github.com/ggbdpq/magpie/tree/hunt115-a-4659) (head `10865c44c58d6b98c364ee0bddfcb25663589e1f`).
