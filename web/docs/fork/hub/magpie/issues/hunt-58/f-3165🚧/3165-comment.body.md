## Source & environment

- #3165 (wmfan2002-cloud): Chat passthrough to a self-hosted DeepSeek-compatible engine whose serde reads `reasoning_content` as an alias of `reasoning`. magpie's tool-turn replay (`withReasoningOnToolTurns`, `internal/gateway/chattidy.go`, reached from the `provider.Chat` branch in `internal/gateway/gateway.go` when `chatReplaysReasoning` matches) adds `reasoning_content` beside the `reasoning` the client echoes back, and the engine turns every such request away with `400 messages[N]: duplicate field \`reasoning\``.
- Fixed at `f5b01574` (= current `main`), branch `hunt58-f-3165-reasoning-dup`, macOS arm64, Go 1.25. All checks run locally: magpie's own gateway test stack, the upstream an in-process `httptest` fake (`internal/gateway`'s `fake`), no network, no real accounts.

## Minimal repro

`TestChatToolTurnReasoningCarriedOnce` (new, `internal/gateway/chat_tool_reasoning_test.go`): a Chat request relayed as sent to a provider whose model contains `deepseek`, where the client echoes the engine's streamed thinking in `reasoning` — an assistant tool-call turn with `"reasoning":"Thinking about the time."` and no `reasoning_content`, a reply after the tool result likewise. The fake upstream refuses, as the issue's engine does, any message carrying both fields:

```text
400 after 1 calls: {"error":{"code":null,"message":"dsflash: deepseek: Failed to deserialize the JSON body into the target type: messages[1]: duplicate field `reasoning` at line 1 column 70565","param":null,"type":"invalid_request_error"}}
```

Without the fix that is the issue's failure: 200 on the turn that made the call, 400 on every request after it.

## Root cause

`withReasoningOnToolTurns` takes the turn's thinking with `reasoningText` (reasoning_content, else `reasoning`, else `reasoning_details`' text) and writes `reasoning_content`, but leaves the field the thinking rode in on in place. A serde that maps both names onto one struct field rejects the two-key message (`duplicate field \`reasoning\``), exactly as the issue's A/B table shows (either field alone 200, both 400). The early-return branch — a message with a `reasoning_content` of its own — left an echoed `reasoning` standing beside it the same way.

## Fix

- Injection branch: after taking the text, the fields it was taken from (`reasoning`, `reasoning_details` — `messageReasoning[1:]`) go, before `reasoning_content` is written. The thinking reaches the model exactly once, under the name the replay path reads; lossless for official-style upstreams.
- Early-return branch: a leftover `reasoning`/`reasoning_details` beside a message's own `reasoning_content` is dropped, and the message is reported changed only when something went.
- `docs/subsystems/gateway-routing.md`: "is copied in" → "moves in — carried once".
- `TestChatToolTurnWithoutReasoningRelayed`'s expectation updated to the single-field shape.

Sibling surfaces checked, not changed: `buildChat`'s replay branch (`chat.go`) builds those messages itself, so there is no client field to collide with; `withReasoningText` (`responses.go`, the Responses replay) fills a `reasoning` item's `content` and adds no second name; `reasoningDetailsAsContent` (Kimi) still keeps `reasoning` when it writes `reasoning_content` — the issue leaves Kimi's aliasing behavior unchecked ("not checked"), so that path stays as it is.

## Verification

| Check | Result |
| --- | --- |
| `TestChatToolTurnReasoningCarriedOnce` without the fix (ablation: `chattidy.go` back at `f5b01574`, test kept) | FAIL — the 400 `duplicate field \`reasoning\`` above |
| `TestChatToolTurnReasoningCarriedOnce` with the fix | PASS |
| `TestChatToolTurnWithoutReasoningRelayed`, `TestChatToolTurnWithoutReasoningNotForMistral`, `TestTranslatedToolTurnWithoutReasoning`, `TestReasoningReplayed` | PASS |
| `go test -tags nogui ./internal/gateway/` (whole package) | ok 329s |
| `gofmt -l` (changed files) | nothing |
| `go vet ./...` | clean (a pre-existing cgo warning in `internal/gui` only) |
| `GOOS=linux go vet -tags nogui ./...` / `GOOS=windows go vet -tags nogui ./...` | clean |
| `go build` / `GOOS=linux go build -tags nogui ./...` / `GOOS=windows go build -tags nogui ./...` | ok |

## Not verified

- Not tried against the reporter's engine or api.deepseek.com: the aliasing serde semantics come from the issue's A/B table and its exact error text, reproduced through a fake upstream built to the same semantics.
- The Responses-side shape the issue mentions in passing (`withReasoningText`, `input[…]`-level errors) was not reproduced; this change does not touch that path.
- Kimi's path (`reasoningDetailsAsContent` keeping `reasoning`): the same collision is conceivable if a Kimi upstream aliases the names; unchecked there, unchanged here.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Chat tool turn's thinking sent in `reasoning` moves into `reasoning_content`, carried once (#3165) — git am applies it as is; SHA-256 first 16: e51ed8ce8802b63b</summary>

```patch
From 130b761baf6d7c23114ef5444a517928abbb59fe Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 00:01:04 +0800
Subject: [PATCH] gateway: a Chat tool turn's thinking sent in `reasoning`
 moves into `reasoning_content`, carried once
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: withReasoningOnToolTurns (internal/gateway/chattidy.go) put
reasoning_content beside the `reasoning` or `reasoning_details` field the
client echoed the turn's thinking in. A self-hosted DeepSeek engine whose
serde reads reasoning_content as an alias of `reasoning` turns a message
carrying both away ("duplicate field `reasoning`", #3165), so every
request after its first tool call failed with a 400. The field the
thinking rode in on now goes when reasoning_content is written, and a
message with reasoning_content of its own loses the `reasoning` left
beside it: the thinking reaches the model exactly once, under the name
the replay path reads. docs/subsystems/gateway-routing.md says "moves in"
where it said "is copied in".

Run (darwin/arm64, worktree hunt58-f-3165-reasoning-dup at f5b01574):
- TestChatToolTurnReasoningCarriedOnce (new) fails without the change:
  400 after 1 calls: {"error":{...,"message":"dsflash: deepseek: Failed
  to deserialize the JSON body into the target type: messages[1]:
  duplicate field `reasoning` at line 1 column 70565",...}}; passes with
  it. Ablation: chattidy.go back at baseline, test kept, same red.
- TestChatToolTurnWithoutReasoningRelayed, updated: a turn's thinking
  sent in `reasoning` used to be expected beside reasoning_content; it
  now goes as reasoning_content alone.
- go test -tags nogui ./internal/gateway/ — ok 329s.
- gofmt -l (changed files): nothing. go vet ./..., GOOS=linux go vet
  -tags nogui ./..., GOOS=windows go vet -tags nogui ./... — clean.
- go build, GOOS=linux go build -tags nogui ./..., GOOS=windows go build
  -tags nogui ./... — ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md           |  2 +-
 internal/gateway/chat_tool_reasoning_test.go | 57 ++++++++++++++++++--
 internal/gateway/chattidy.go                 | 27 +++++++---
 3 files changed, 75 insertions(+), 11 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index e9e11d17..3f6c211d 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -151,7 +151,7 @@ recorded as a prediction failure (`noPrediction`).
 - A tool a Chat request's message carries joins the request's `tools` (`liftMessageTools` in [`message_tools.go`](../../internal/gateway/message_tools.go), #2322). Pi with `supportsMidConvoToolAdditions` gives a tool it adds mid-conversation as `{"role":"system","tools":[…]}` with no content, and keeps top-level `tools` as they were at the start; no Chat API reads tools there, and `parseChat` read only the top-level ones, so the tool could be called on no route. `handle` lifts them for every Chat body before `serveAgent`, so the Chat relay, the schema fixers, redaction (the tool is a tool definition, not message text), the prompt shown and routing all see them; `parseChat` lifts too, for a body that never came through `handle` (the Claude subscription bridge's direct callers). Each tool joins once by name and the first definition wins: a top-level tool keeps its own, then the earliest message's, as `liftAdditionalTools` and a `tool_addition` (`withoutDeferredTools`) do. A system or developer message that carried only tools is left out, so it is neither relayed as an empty system message nor joined into the system text as an empty part; one with content keeps its place without `tools`. Messages stay where they are: the in-place system message the issue also asks for is not this change. `TestPiAddedToolReachesEveryRoute` sends deephbz's Pi 1.2.0 bytes through the Chat relay, Messages, Responses, Gemini and Codex, and `TestPiAddedToolOfferedToClaudeCode` through the Claude subscription bridge.
 - A Chat request's tool in another API's shape is put in the Chat shape, `{"type":"function","function":{name, description, parameters, strict}}` (`shapeChatTools` in [`chat_tool_shape.go`](../../internal/gateway/chat_tool_shape.go), #2622, jinyue806): MCP's `{"name","description","inputSchema"}` (ZCode), Anthropic's `input_schema`, a bare `{"name","parameters"}` and Responses' flat `{"type":"function","name",…}`. No Chat API takes those (SenseNova: "field Tools[0].Type invalid, should be set" and "function cannot be empty"), and `parseChat` read no name from them, so a translated request offered a tool named "". It runs right after `liftMessageTools`, in `handle` for every Chat body and in `parseChat`, so it holds for every Chat upstream, not SenseNova's alone. A tool with its `function`, a hosted tool (any other `type`) and one with no name are left as they came, and a request with none to shape is relayed byte for byte. `TestChatToolInAnotherShapeIsShaped` sends the report's request with each of its four tools through the Chat relay, Messages and Responses; `TestShapeChatToolsLeavesChatShape`.
 - Every request to a key+URL provider goes with magpie's User-Agent (`magpie/<Version>`, `userAgentFor` in [`user_agent.go`](../../internal/gateway/user_agent.go)), except a provider set `passUserAgent` (#1851, `magpie provider set <id> user-agent=agent`, the editor's "Send the agent's own User-Agent"): it gets the User-Agent the inbound request carried, unchanged, for a coding plan that serves only the agents it names. One the agent didn't send, and magpie's own (`magpiesOwn`: another magpie's `magpie/…`, `magpie-router/1`, `magpie-vision/1`, `magpie-search/1`, and the image tool's `<client> magpie-image/1`, built from MCP's clientInfo, not a User-Agent), go as magpie; magpie never makes up another client's. `forwardOnce` sets it for chat, Anthropic, Responses, Gemini and count_tokens; embeddings, images and videos (`retrieveFrom`, `sendWith`, `remoteVideoContent`) set it with `stampUA` from the caller the request came with (`caller.ua`, `withCaller`), and before #1851 went with Go's default. Claude Code's and Codex's own headers are copied after, as before, and the user's `header.User-Agent` is put on when the request is signed, so it wins. `provider.PassesUserAgent` refuses it for a signed-in account, a plugin's, and a vendor whose own client magpie goes as (`OwnClient`: OpenCode, Cline, Kilo, another magpie); their signing sets their own. `TestUserAgentPassedOn`, `TestUserAgentAccountUntouched`, `TestUserAgentFor`, `TestPassesUserAgent`, `provider-user-agent.test.cjs`.
-- A Chat upstream that wants a turn's reasoning back (`chatReplaysReasoning` in [`chat.go`](../../internal/gateway/chat.go): a host or a model, as magpie or the provider names it, with `deepseek` in it, such as OpenCode Go's `deepseek-v4.1-flash`, or Command Code's plugin) gets every assistant tool call with `reasoning_content`, relayed (`withReasoningOnToolTurns` in `passthrough`) or translated (`buildChat`). DeepSeek turns the whole request away ("The `reasoning_content` in the thinking mode must be passed back to the API") when a tool call made since the user's last message has none, which a client sends for a turn it saw no thinking on: another model's, a translated one (#1462). The turn's own thinking goes back as it came; one sent in `reasoning` or `reasoning_details` is copied in; otherwise it goes with a space (`noReasoning`: DeepSeek's Chat API takes an empty one, but a relay that leaves empty fields out would drop it). An assistant message right after a tool result, a reply with no call of its own, gets one too: DeepSeek refuses it the same way (checked 2026-10-12, #1822). A reply to the user, any other model and Mistral (#494) are sent as before.
+- A Chat upstream that wants a turn's reasoning back (`chatReplaysReasoning` in [`chat.go`](../../internal/gateway/chat.go): a host or a model, as magpie or the provider names it, with `deepseek` in it, such as OpenCode Go's `deepseek-v4.1-flash`, or Command Code's plugin) gets every assistant tool call with `reasoning_content`, relayed (`withReasoningOnToolTurns` in `passthrough`) or translated (`buildChat`). DeepSeek turns the whole request away ("The `reasoning_content` in the thinking mode must be passed back to the API") when a tool call made since the user's last message has none, which a client sends for a turn it saw no thinking on: another model's, a translated one (#1462). The turn's own thinking goes back as it came; one sent in `reasoning` or `reasoning_details` moves in — carried once, since a self-hosted DeepSeek engine's serde reads `reasoning_content` as an alias of `reasoning` and turns a message carrying both away ("duplicate field `reasoning`", #3165); otherwise it goes with a space (`noReasoning`: DeepSeek's Chat API takes an empty one, but a relay that leaves empty fields out would drop it). An assistant message right after a tool result, a reply with no call of its own, gets one too: DeepSeek refuses it the same way (checked 2026-10-12, #1822). A reply to the user, any other model and Mistral (#494) are sent as before.
 - An assistant turn the user cut off before it said anything (only its thinking, an empty text, nothing; an isolated Codex reasoning item; a Gemini thought alone) stays in the agent's history and is sent on every later turn. DeepSeek and Kimi turn the whole request away over an assistant message with neither content nor tool calls, `reasoning_content` alone included ("Invalid assistant message: content or tool_calls must be set", #2599). Every Chat upstream gets such a turn left out, translated (`buildChat`, before `pairToolMessages`) or relayed (`silentAssistantsOut` in `passthrough`), by one rule (`withoutSilentAssistants` in [`chat.go`](../../internal/gateway/chat.go)): the two user messages it stood between join into one, and after a tool result the user's message follows the tool message. A prefill to go on from (`prefix`, `partial`, a Resume), a legacy `function_call`, a refusal and an audio reply stay, and a relayed body without such a turn goes byte for byte. `TestChatEmptyAssistantLeftOutFromAnthropic`, `…FromResponses`, `…FromGemini`, `TestChatRelayLeavesOutEmptyAssistant`, `TestChatRelaySilentAssistantsOnly`.
 - Kimi's Chat API (`isKimi`: the Kimi platform's and a Kimi Code membership's hosts or presets) turns `reasoning_details` in a message away in any shape: an entry with a stream's `index` ("the reasoning_details at position 1 entry 0 must not contain streaming index") and any other entry ("… has an invalid type"), checked against api.kimi.com/coding on 2026-10-12. pi keeps another vendor's thinking there (MiMo's, through Command Code, with `index: 0`), so a conversation routed on to Kimi was refused on every turn (#1765). `passthrough` sends it to Kimi as `reasoning_content` (`reasoningDetailsAsContent`), which Kimi takes; a message with `reasoning_content` of its own keeps that. Another upstream that refuses a thinking field "at position N", as Kimi words it (a relay in front of it), is asked once more the same way and marked (`refusedInMessages`, `withoutMessageReasoning`).
 - Claude Code's deferred tools (ToolSearch, MCP tools that come and go) put blocks of their own in a message: a `tool_addition` (`tool` a `tool_reference` naming the tool, or a `tool_definition`), a `tool_removal`, and a `tool_reference`. Kimi's Anthropic endpoint refuses any of them with a whole-request 400 "Invalid request Error" that names nothing, so once a session had loaded a tool every turn failed (#2042); DeepSeek's takes a `tool_addition` naming a tool but refuses one defining it, a `tool_removal` and a message's `tool_reference` with 422 "unknown variant `tool_removal`" (both checked against the real endpoints on 2026-10-14). OpenCode Go also rejects DeepSeek inline definitions with a generic 422 "Upstream request failed: Endpoint is unavailable." (checked on 2026-10-15). Kimi and DeepSeek models on OpenCode are never sent these blocks (`forwardOnce`); a provider that refuses one in those words is asked again at once without them and not sent them again while magpie runs (`refuseShapes`, `shapeDeferred`; the retry loop reads a 422 as well as a 400). `withoutDeferredTools` drops the blocks and a message they leave empty; definitions present only in a `tool_addition.tool.definition` join the request's `tools` once by name (an existing top-level definition wins), and a `tool_reference` inside a `tool_result` (ToolSearch's answer, which both take) stays. Any other provider is sent them as Claude Code wrote them ([`anthropic_shapes.go`](../../internal/gateway/anthropic_shapes.go), `TestKimiIsSentNoDeferredToolBlocks`, `TestDeferredToolBlocksRefusedOnceLeftOut`, `TestOpenCodeDeepSeekInlineTools`, `TestDeferredInlineDefinitionPreserved`).
diff --git a/internal/gateway/chat_tool_reasoning_test.go b/internal/gateway/chat_tool_reasoning_test.go
index 4eb00eea..f84c1194 100644
--- a/internal/gateway/chat_tool_reasoning_test.go
+++ b/internal/gateway/chat_tool_reasoning_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"encoding/json"
+	"strconv"
 	"strings"
 	"testing"
 
@@ -51,6 +52,54 @@ const toolTurnsNoReasoning = `{"model":"%s","stream":false,"tools":[{"type":"fun
 	{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning":"OpenRouter's field."},
 	{"role":"tool","tool_call_id":"call_3","content":"12:02"}]}`
 
+// deepseekAliasSerde answers as the self-hosted DeepSeek engine of #3165
+// does: its serde reads reasoning_content as an alias of reasoning, so a
+// message carrying both turns the whole request away.
+func deepseekAliasSerde(body []byte) (int, string) {
+	var q struct {
+		Messages []map[string]json.RawMessage `json:"messages"`
+	}
+	json.Unmarshal(body, &q)
+	for i, m := range q.Messages {
+		if _, echoed := m["reasoning"]; !echoed {
+			continue
+		}
+		if _, injected := m["reasoning_content"]; injected {
+			return 400, `{"code":"json_parse_error","message":"deepseek: Failed to deserialize the JSON body into the target type: messages[` + strconv.Itoa(i) + `]: duplicate field ` + "`reasoning`" + ` at line 1 column 70565","param":null,"type":"invalid_request_error"}`
+		}
+	}
+	return 0, ""
+}
+
+// A Chat request relayed as it came to a DeepSeek engine that streams its
+// thinking in `reasoning` (#3165): the client echoes that field back, and
+// the replay of a tool turn would put reasoning_content beside it, which
+// such a serde takes apart ("duplicate field `reasoning`"). The thinking
+// moves into reasoning_content instead: it is carried once, and a message
+// that echoed reasoning_content of its own loses the `reasoning` left
+// beside it.
+func TestChatToolTurnReasoningCarriedOnce(t *testing.T) {
+	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: deepseekAliasSerde}
+	up := setup(t, provider.Chat, f)
+	chatProvider(t, up.URL, provider.Provider{ID: "dsflash", Models: []string{"deepseek-v4.1-flash"}})
+	code, body := postTo(t, New(), "/v1/chat/completions", `{"model":"dsflash/deepseek-v4.1-flash","stream":false,"messages":[
+		{"role":"user","content":"hi"},
+		{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning":"Thinking about the time."},
+		{"role":"tool","tool_call_id":"call_1","content":"12:00"},
+		{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more.","reasoning":"Echoed."},
+		{"role":"tool","tool_call_id":"call_2","content":"12:01"},
+		{"role":"assistant","content":"It is 12:01.","reasoning":"Reply thinking."}]}`)
+	if code != 200 || f.calls != 1 {
+		t.Fatalf("%d after %d calls: %s", code, f.calls, body)
+	}
+	ms := sentMessages(t, f.got)
+	sameJSON(t, ms[1], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning_content":"Thinking about the time."}`)
+	sameJSON(t, ms[2], `{"role":"tool","tool_call_id":"call_1","content":"12:00"}`)
+	sameJSON(t, ms[3], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more."}`)
+	sameJSON(t, ms[4], `{"role":"tool","tool_call_id":"call_2","content":"12:01"}`)
+	sameJSON(t, ms[5], `{"role":"assistant","content":"It is 12:01.","reasoning_content":"Reply thinking."}`)
+}
+
 func chatProvider(t *testing.T, up string, p provider.Provider) {
 	t.Helper()
 	p.Name, p.Key, p.Chat = p.ID, "k", up+"/v1"
@@ -62,8 +111,10 @@ func chatProvider(t *testing.T, up string, p provider.Provider) {
 // A Chat request relayed as it came to a DeepSeek model, here behind
 // OpenCode Go whose host doesn't say DeepSeek, gives every tool call
 // without reasoning_content one, so DeepSeek takes it (#1462). The
-// thinking a turn has keeps it, one sent in another field goes there too,
-// and every other message goes as it was sent.
+// thinking a turn has keeps it, one sent in another field moves there —
+// carried once, since a DeepSeek-style serde reading both names into one
+// field takes the message apart (#3165) — and every other message goes as
+// it was sent.
 func TestChatToolTurnWithoutReasoningRelayed(t *testing.T) {
 	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: deepseekRefuseToolTurns}
 	up := setup(t, provider.Chat, f)
@@ -84,7 +135,7 @@ func TestChatToolTurnWithoutReasoningRelayed(t *testing.T) {
 		sameJSON(t, ms[1], `{"role":"assistant","content":"Hello!"}`)
 		sameJSON(t, ms[3], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning_content":" "}`)
 		sameJSON(t, ms[5], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more."}`)
-		sameJSON(t, ms[7], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning":"OpenRouter's field.","reasoning_content":"OpenRouter's field."}`)
+		sameJSON(t, ms[7], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"OpenRouter's field."}`)
 		sameJSON(t, ms[4], `{"role":"tool","tool_call_id":"call_1","content":"12:00"}`)
 	}
 
diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index c872e7b3..706eb8f1 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -387,12 +387,15 @@ const noReasoning = " "
 // withReasoningOnToolTurns gives each assistant message of a Chat request
 // that has tool calls, or that follows a tool message of its turn, and no
 // reasoning_content one: the thinking it sent back in another field
-// (reasoning, reasoning_details), else noReasoning. DeepSeek turns away a
-// reply after a tool result with none as it does a call (checked against
-// api.deepseek.com on 2026-10-12, #1822). A message with reasoning_content
-// of its own keeps it, any other reply is left as it is (DeepSeek doesn't
-// ask for its thinking), and a body with no tool calls comes back byte for
-// byte.
+// (reasoning, reasoning_details), else noReasoning. The field the thinking
+// rode in on goes, so it is carried once: a self-hosted DeepSeek engine's
+// serde reads reasoning_content as an alias of reasoning and takes a
+// message carrying both apart ("duplicate field `reasoning`", #3165).
+// DeepSeek turns away a reply after a tool result with none as it does a
+// call (checked against api.deepseek.com on 2026-10-12, #1822). A message
+// with reasoning_content of its own keeps it, any other reply is left as
+// it is (DeepSeek doesn't ask for its thinking), and a body with no tool
+// calls comes back byte for byte.
 func withReasoningOnToolTurns(body []byte) []byte {
 	afterTool := false
 	return editMessages(body, []string{"tool_calls"}, func(m map[string]json.RawMessage) bool {
@@ -413,12 +416,22 @@ func withReasoningOnToolTurns(body []byte) []byte {
 		}
 		var own *string
 		if decodeJSON(m["reasoning_content"], &own) == nil && own != nil {
-			return false
+			changed := false
+			for _, f := range messageReasoning[1:] {
+				if _, ok := m[f]; ok {
+					delete(m, f)
+					changed = true
+				}
+			}
+			return changed
 		}
 		think := reasoningText(m)
 		if think == "" {
 			think = noReasoning
 		}
+		for _, f := range messageReasoning[1:] {
+			delete(m, f)
+		}
 		m["reasoning_content"], _ = marshalPlain(think)
 		return true
 	})
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt58-f-3165-reasoning-dup](https://github.com/ggbdpq/magpie/tree/hunt58-f-3165-reasoning-dup) (head `130b761baf6d7c23114ef5444a517928abbb59fe`).
