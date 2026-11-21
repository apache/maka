A relayed Chat stream whose reply is text alone went out of magpie ending `finish_reason: "tool_calls"` with no tool call anywhere in the stream, and a client that reads `finish_reason` took the turn for one whose calls were dropped and re-prompted three times a reply.

## Summary

- Hermes (stream=true, tools, deep reasoning) through magpie: every narration-only reply ended on a frame saying `"finish_reason":"tool_calls"` whose whole stream carries no `tool_calls` delta — Hermes logged `finish_reason=tool_calls with empty tool_calls array (narration only) — re-prompting to emit the call (retry 1/3 … 3/3)`.
- Same client, same tools, same upstream model: another gateway on the same upstream said `stop`, zero errors; direct said `stop` (the reporter's #3259 comparison). Only magpie said `tool_calls`.

## Minimal reproduction

The reporter's bare call of the model (tools offered, calls produced) ends on this upstream frame — no `tool_calls` key in the final delta, the fragments went earlier:

```
data: {"choices":[{"index":0,"delta":{"reasoning_content":null},"logprobs":null,"finish_reason":"tool_calls","matched_stop":1}]}
```

and its text-only turns end on the same shape. `TestChatNoCallToolCallsFinishEndsStop` (chattidy_finish_test.go) feeds exactly these frames — reasoning, text, then that final frame — through the gateway: before the fix the client reads `finish_reason: "tool_calls"` with an empty call list; after, `stop`.

## Root cause

`chatTidy` (internal/gateway/chattidy.go) mends a relayed Chat stream. #1475 added the right mend — a finish of `tool_calls` with no call left ends `stop` — but it sat inside the `if t.called[choice]` guard that the opposite direction (a choice that made calls and ended `stop` ends `tool_calls`) needs. `called` is only set when a delta carries a `tool_calls` key. #3259's mimo carries `"tool_calls": null` in its final delta, so it reached the mend; this upstream's final frame carries no key at all, so no delta ever set `called`, the `tool_calls` finish skipped the mend, and the misleading frame passed through as it came. The reporter's reading of the difference was exact.

## Fix

The finish switch now runs for every choice's finish: a finish of `tool_calls` with no readable call ends `stop` whether or not a delta ever carried the key, and the `stop` of a choice that made calls still ends `tool_calls` (unchanged). A legacy `function_call` a client may still be reading (#4659) marks its choice, so a finish saying the turn ended in a call is kept, and `"function_call": null` stays the contract's own nothing. Whole replies are untouched: #1475's review narrowed `chatWhole` to a finish whose call was dropped and pinned a whole reply that came with no `tool_calls` at all as going as it came (`TestToolCallsFinishWithNoCallsStaysWhole`), and no report covers them.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 ./internal/gateway` (the 2 new tests and the family guards among them) | ok (2 new tests, 5 family guards) |
| `go test -tags nogui -count=1 -timeout 45m ./internal/...` | 74 packages ok; the 4 failures are all red at the parent 173b7e274 single-run too (agent/gui/plugin + the codex-pool one, the machine's known red, green single-run) |
| Ablation: `chattidy.go` from the parent 173b7e274, tests kept | the 2 new tests red with the reported symptom (`calls map[], finish "tool_calls"`), green again with the commit restored |
| `gofmt -l` | clean |
| `go vet -tags nogui ./...` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

Not verified: no live Hermes client and no account on the reporter's upstream — the fixtures are synthetic, their frames taken verbatim from the reporter's capture (the bare-call final frame) and their bad-tail description; the upstream's own text-only final frame was never captured raw through magpie, so what put `tool_calls` on it (the upstream, or anything between) is not decided here — magpie now ends such a finish `stop` regardless.

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Chat finish of tool_calls with no call in the stream ends stop (#4944) — git am applies it as is; SHA-256 first 16: 552be486eebc54cd</summary>

```
From b50f4c0327efe96c26e9d667007216f44e661e8f Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 06:47:58 +0800
Subject: [PATCH] gateway: a Chat finish of tool_calls with no call in the
 stream ends stop (#4944)

What changed: Hermes through magpie (stream=true, tools, deep
reasoning): a reply of text alone ended, on the reporter's upstream, on
a frame saying finish_reason "tool_calls" that no delta ever carried a
call for - the shape the reporter's bare call of the model ends its
real calls with ("delta":{"reasoning_content":null},
"finish_reason":"tool_calls","matched_stop":1); its text-only turns end
there too, and the client took every such turn for one whose calls were
dropped and re-prompted, three times a reply. The other gateway on the
same upstream said stop.

chatTidy's mend that ends a finish of tool_calls with no call left stop
(#1475) only ran for a choice some delta had carried a tool_calls key
for: the case "tool_calls" sat inside the t.called[choice] guard the
case "stop" needs, and a reply whose stream never carried the key
passed the misleading finish on. The switch now runs for every choice's
finish: a finish of tool_calls with no readable call ends stop whether
or not a delta carried the key, and the stop of a choice that made
calls still ends tool_calls. A legacy function_call a client may still
be reading (#4659) keeps a finish that says the turn ended in a call,
and a "function_call": null is still the contract's own nothing.

Whole replies are untouched: #1475's review narrowed chatWhole to a
finish whose call was dropped and pinned a whole reply that came with
no tool_calls at all as going as it came
(TestToolCallsFinishWithNoCallsStaysWhole); no report covers them.

Run: go test -tags nogui -count=1 ./internal/gateway: one red,
TestCodexPoolSaysTheClientsVersion, green on its own - the known
pre-existing red of this machine; the two new tests and the family
guards among the rest, ok. go test -tags nogui -count=1 -timeout 45m
./internal/...: 74 packages ok; the four failures are all red at the
parent 173b7e274 single-run too, none of this commit's own (TestMothX
in agent, TestProxyCheckSaysAProxyPassedBy in gui,
TestHostToldTheGatewayAddress in plugin, and the codex pool one above).
Red at the parent with chattidy.go from the parent and the tests kept:
TestChatNoCallToolCallsFinishEndsStop "calls map[], finish
"tool_calls"" and TestChatRelayLegacyCallFinish "finish "tool_calls"" -
the reported symptom; green again with the commit restored. gofmt -l:
clean. go vet -tags nogui ./...: clean. go build -tags nogui: darwin,
GOOS=linux, GOOS=windows: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/chattidy.go             | 63 +++++++++++++++++-------
 internal/gateway/chattidy_finish_test.go | 55 +++++++++++++++++++++
 2 files changed, 100 insertions(+), 18 deletions(-)

diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index fe7e23e6a..093f21dfe 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -77,7 +77,11 @@ import (
 // own log says the reply went (AricRedemption). A nameless call runs
 // nowhere, so it is no call, as a written block naming no offered tool
 // is; a name of another kind on a later fragment is left out, the first
-// one's kept.
+// one's kept. And a finish of tool_calls no delta ever carried a call
+// for (#4944, Hermes: a reply of text alone whose upstream ends it
+// "tool_calls" all the same) ends stop too — a client that reads
+// finish_reason took the turn for one whose calls were dropped and
+// re-prompted, three times a reply.
 //
 // And a legacy function_call that carries nothing — a name and arguments
 // both empty — is left out too (#4659): WorkBuddy's stream ends a reply
@@ -292,9 +296,18 @@ func (t *chatTidy) line(line []byte) []byte {
 			delete(delta, "tool_calls")
 			inDelta = true
 		}
-		if fc, ok := delta["function_call"]; ok && emptyFunctionCall(fc) {
-			delete(delta, "function_call")
-			inDelta = true
+		if fc, ok := delta["function_call"]; ok {
+			if fullFunctionCall(fc) {
+				// a legacy call a client may still be reading (#4659)
+				// keeps a finish that says the turn ended in a call
+				if t.named == nil {
+					t.named = map[int]bool{}
+				}
+				t.named[choice] = true
+			} else if emptyFunctionCall(fc) {
+				delete(delta, "function_call")
+				inDelta = true
+			}
 		}
 		if calls, ok := delta["tool_calls"]; ok {
 			if t.indexes == nil {
@@ -338,20 +351,19 @@ func (t *chatTidy) line(line []byte) []byte {
 			c["delta"], _ = json.Marshal(delta)
 			changed = true
 		}
-		if t.called[choice] {
-			switch end := string(bytes.TrimSpace(c["finish_reason"])); end {
-			case `"stop"`:
-				if t.named[choice] {
-					c["finish_reason"] = json.RawMessage(`"tool_calls"`)
-					changed = true
-				}
-			case `"tool_calls"`:
-				if !t.named[choice] {
-					// the call the finish named named no function: it ends
-					// stop, as a reply that made no call (#1475)
-					c["finish_reason"] = json.RawMessage(`"stop"`)
-					changed = true
-				}
+		switch end := string(bytes.TrimSpace(c["finish_reason"])); end {
+		case `"stop"`:
+			if t.called[choice] && t.named[choice] {
+				c["finish_reason"] = json.RawMessage(`"tool_calls"`)
+				changed = true
+			}
+		case `"tool_calls"`:
+			if !t.named[choice] {
+				// the call the finish named named no function, or no call
+				// was ever made and no delta carried the key (#4944): it
+				// ends stop, as a reply that made no call (#1475)
+				c["finish_reason"] = json.RawMessage(`"stop"`)
+				changed = true
 			}
 		}
 	}
@@ -384,6 +396,21 @@ func emptyFunctionCall(raw json.RawMessage) bool {
 	return decodeJSON(raw, &fc) == nil && fc.Name == "" && fc.Arguments == ""
 }
 
+// fullFunctionCall reports whether raw is a legacy function_call a client
+// may still be reading: a name or arguments that hold something (#4659).
+// A null is the contract's own nothing and an unreadable shape is no call
+// a client reads.
+func fullFunctionCall(raw json.RawMessage) bool {
+	if string(bytes.TrimSpace(raw)) == "null" {
+		return false
+	}
+	var fc struct {
+		Name      string `json:"name"`
+		Arguments string `json:"arguments"`
+	}
+	return decodeJSON(raw, &fc) == nil && (fc.Name != "" || fc.Arguments != "")
+}
+
 // withoutEmptyNames drops the empty "name" on a delta's tool-call
 // fragments and reports whether any was dropped. A fragment whose
 // function carries no name at all is left as it is; one with a real name
diff --git a/internal/gateway/chattidy_finish_test.go b/internal/gateway/chattidy_finish_test.go
index 4087353af..ad1114702 100644
--- a/internal/gateway/chattidy_finish_test.go
+++ b/internal/gateway/chattidy_finish_test.go
@@ -53,3 +53,58 @@ func TestChatCallsEndToolCalls(t *testing.T) {
 		t.Fatalf("whole, no call: finish %q\n%s", finish, raw)
 	}
 }
+
+// #4944 (Hermes through magpie): a stream whose reply is text alone ends,
+// on the reporter's upstream, on a frame that says finish_reason
+// "tool_calls" and carries no tool_calls key in any delta — the reporter's
+// bare call of the model ends its real calls with just that shape
+// ("delta":{"reasoning_content":null},"finish_reason":"tool_calls",
+// "matched_stop":1), and its text-only turns end there too. A client that
+// reads finish_reason took every such turn for one whose calls were
+// dropped and re-prompted, three times a reply. A finish of tool_calls
+// with no call the client could read ends stop, whether or not a delta
+// ever carried the key.
+func TestChatNoCallToolCallsFinishEndsStop(t *testing.T) {
+	up := []string{
+		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"The user said hi."}}]}`,
+		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"收到"}}]}`,
+		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":null},"logprobs":null,"finish_reason":"tool_calls","matched_stop":1}]}`,
+	}
+	for _, body := range []string{
+		`{"model":"a/m","stream":true,"messages":[{"role":"user","content":"只回复两个字：收到"}],"reasoning_effort":"max",` + execChatTool + `}`,
+		`{"model":"a/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`,
+	} {
+		_, calls, finish, raw := relayedChat(t, body, up...)
+		if finish != "stop" || len(calls) != 0 {
+			t.Fatalf("stream: calls %v finish %q\n%s", calls, finish, raw)
+		}
+	}
+	// the finish naming a call with the final delta's "tool_calls": null
+	// beside it (#3259's shape) ends stop the same way
+	_, _, finish, raw := relayedChat(t, `{"model":"a/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`,
+		`data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}`,
+		`data: {"choices":[{"index":0,"delta":{"content":null,"tool_calls":null},"finish_reason":"tool_calls"}]}`)
+	if finish != "stop" {
+		t.Fatalf("stream, tool_calls null and no call: finish %q\n%s", finish, raw)
+	}
+}
+
+// A legacy function_call a client may still be reading keeps a finish
+// that says the turn ended in a call, "tool_calls" or not (#4659); a
+// "function_call": null is the contract's own nothing and is not one.
+func TestChatRelayLegacyCallFinish(t *testing.T) {
+	tools := `{"model":"a/m","stream":true,"messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object"}}}]}`
+	_, _, finish, raw := relayedChat(t, tools,
+		`data: {"choices":[{"index":0,"delta":{"function_call":{"name":"get_weather","arguments":""}}}]}`,
+		`data: {"choices":[{"index":0,"delta":{"function_call":{"name":"","arguments":"{\"city\":\"北京\"}"}}}]}`,
+		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)
+	if finish != "tool_calls" {
+		t.Fatalf("stream, a legacy call: finish %q\n%s", finish, raw)
+	}
+	_, _, finish, raw = relayedChat(t, tools,
+		`data: {"choices":[{"index":0,"delta":{"content":"hi","function_call":null}}]}`,
+		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)
+	if finish != "stop" {
+		t.Fatalf("stream, function_call null and no call: finish %q\n%s", finish, raw)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4944-narration-toolcalls](https://github.com/ggbdpq/magpie/tree/fix/4944-narration-toolcalls) (head `b50f4c0327efe96c26e9d667007216f44e661e8f`).
