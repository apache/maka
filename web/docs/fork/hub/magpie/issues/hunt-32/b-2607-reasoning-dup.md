认领跟进交付：已复现、已修复，patch 如下。

## 根因

`internal/gateway/chattidy.go` 的 `withReasoningOnToolTurns`：守卫只检查消息有没有自己的 `reasoning_content`（第 392 行），但第 395 行 `reasoningText(m)` 会按 `reasoning_content` → `reasoning` 的顺序取思考文本。客户端用 `reasoning` 回传思考时，第 399 行把文本写进**新**键 `reasoning_content`，而旧的 `reasoning` 键原样留在消息里——body 同时携带两个名字。该路径由 `gateway.go` 的 `provider.Chat` 分支在 `chatReplaysReasoning`（host 或模型含 `deepseek`，或 Command Code 插件）时调用，正是严格解析器最可能的供应商。同文件 `reasoningDetailsAsContent`（Kimi 路径）同类：写 `reasoning_content` 时删了 `reasoning_details` 却留着 `reasoning`——OpenRouter 客户端回传历史时两个键并存是常见形状。

## 最小复现

假上游按报告者的 serde alias 语义拒绝（任一 assistant 消息同时带 `reasoning` 与 `reasoning_content` 即 400，报错原文一致），走 `httptest` 全链路 `New().Handler()`：

```
--- FAIL: TestChatToolTurnReplayReasoningAlone (0.02s)
    chat_tool_reasoning_test.go:140: 400 after 1 calls, sent {"messages":[...,{"content":null,"reasoning":"A","reasoning_content":"A","role":"assistant","tool_calls":[...]}]}:
    {"error":{"message":"vllm: Failed to deserialize the JSON body into the target type: messages[1]: duplicate field `reasoning`",...}}
```

既有测试 `TestChatToolTurnWithoutReasoningRelayed` 第 87 行此前**明确锁定了双键形状**（`"reasoning":"OpenRouter's field.","reasoning_content":"OpenRouter's field."` 并存），本次一并改为单键预期。

## 修法

写 `reasoning_content` 前删掉其余拼写（文本已并入，无损）：

- `withReasoningOnToolTurns`：`think := reasoningText(m)` 之后 `delete(m, "reasoning")`、`delete(m, "reasoning_details")` 再写。
- `reasoningDetailsAsContent`：写 `reasoning_content` 的分支里 `delete(m, "reasoning")`。

自带 `reasoning_content` 的消息照旧原样保留；交换之外的普通回复照旧不动；非 replay 上游（Mistral 等）不受影响（现有 `TestChatToolTurnWithoutReasoningNotForMistral` 守护）。

## 验证

| 检查 | 结果 |
| --- | --- |
| 修前红（tip 138188a3）：`TestChatToolTurnReplayReasoningAlone` | FAIL，400 报错与报告一字不差 |
| 修前红：`TestChatToolTurnWithoutReasoningRelayed`（改预期后） | FAIL，双键形状被发往上游 |
| 修前红：`TestKimiGetsReasoningDetailsAsContent`（加 `reasoning`+`reasoning_details` 轮次） | FAIL，`reasoning` 留在 `reasoning_content` 旁 |
| 修复后三项 | PASS |
| 消融回红（摘回父版本 chattidy.go，保留测试） | FAIL，失败信息与修前红同形 |
| internal/gateway 全包（-tags nogui -p 2，295s） | ok |
| `gofmt -l internal/` | 无输出 |
| go vet（darwin / linux nogui / windows） | 干净 |
| go build（darwin / linux nogui / windows） | 通过（trayimage_darwin.go 的 cgo `-Wenum-conversion` 为已知环境警告） |

没跑什么：没有对真实 DeepSeek / Kimi / vLLM 端点发请求——拒绝语义按报告者贴的上游实测表与错误原文构造；`reasoning_details` 删除对「deny_unknown_fields 类上游」的收益是推断，没有实测样本。带思考回传的非工具轮次（不在 `withReasoningOnToolTurns` 编辑范围内）保持原样，未改。

补丁（`git format-patch -1 --stdout`，基于 main `138188a3`）：

<details>
<summary>patch</summary>

```
From 25dc5013cfade42e96779394a5e0424ecdc16697 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 17 Oct 2026 00:54:54 +0800
Subject: [PATCH] gateway: a turn's thinking replayed in reasoning or
 reasoning_details goes out as reasoning_content alone (#2607)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: withReasoningOnToolTurns copied a tool turn's thinking from
`reasoning` or `reasoning_details` into `reasoning_content` without dropping
the spelling it came in as, so the body carried both — and an upstream that
declares `reasoning_content` a serde alias of `reasoning` (the reporter's
vLLM frontend) reads the pair as a duplicate field and turns the whole
request away (400, every first attempt of an agent session's follow-ups).
reasoningDetailsAsContent, the Kimi path, had the same gap for a message
keeping `reasoning` beside `reasoning_details`. Both now write the one
spelling. A message with reasoning_content of its own is still left as it
came, and a reply with no tool call outside a tool exchange is untouched.

Tests: TestChatToolTurnReplayReasoningAlone refuses a body that carries
both names the way that upstream words it and checks the one-spelling
messages it gets; TestChatToolTurnWithoutReasoningRelayed's OpenRouter turn
now expects reasoning_content alone; TestKimiGetsReasoningDetailsAsContent
adds a turn holding `reasoning` beside `reasoning_details`.
gateway-routing.md says the same.

Run: full internal/gateway suite (-tags nogui -p 2, 295s) green; gofmt -l
clean; go vet and build on darwin, linux (nogui) and windows clean (the
known trayimage_darwin.go cgo -Wenum-conversion warning aside).

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md            |  4 +-
 internal/gateway/chat_tool_reasoning_test.go  | 47 ++++++++++++++++++-
 internal/gateway/chattidy.go                  | 16 ++++++-
 .../gateway/kimi_reasoning_details_test.go    |  9 +++-
 4 files changed, 69 insertions(+), 7 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index d126263c..43a89ba2 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -141,8 +141,8 @@ recorded as a prediction failure (`noPrediction`).
 - A Responses request Codex sends a Responses provider is fitted for a backend that isn't OpenAI's before it goes (`passthrough`): Responses Lite's `additional_tools` item lifted into `tools` (`liftAdditionalTools`, #350), the tool search as a function, OpenAI-only fields left out. A relay that checks a request is Codex's own turns that shape away (#1758: 400 "Codex 客户端请求特征无效", 10014). A provider set `codexAsSent` (`magpie provider set <id> codex=as-sent`) gets a request from Codex (`fromCodex`) as Codex sent it, its model name alone swapped, with Codex's own headers (`codexClientHeader`). Off is the default, and a subscription account is never sent so. `TestCodexAsSent`.
 - A tool a Chat request's message carries joins the request's `tools` (`liftMessageTools` in [`message_tools.go`](../../internal/gateway/message_tools.go), #2322). Pi with `supportsMidConvoToolAdditions` gives a tool it adds mid-conversation as `{"role":"system","tools":[…]}` with no content, and keeps top-level `tools` as they were at the start; no Chat API reads tools there, and `parseChat` read only the top-level ones, so the tool could be called on no route. `handle` lifts them for every Chat body before `serveAgent`, so the Chat relay, the schema fixers, redaction (the tool is a tool definition, not message text), the prompt shown and routing all see them; `parseChat` lifts too, for a body that never came through `handle` (the Claude subscription bridge's direct callers). Each tool joins once by name and the first definition wins: a top-level tool keeps its own, then the earliest message's, as `liftAdditionalTools` and a `tool_addition` (`withoutDeferredTools`) do. A system or developer message that carried only tools is left out, so it is neither relayed as an empty system message nor joined into the system text as an empty part; one with content keeps its place without `tools`. Messages stay where they are: the in-place system message the issue also asks for is not this change. `TestPiAddedToolReachesEveryRoute` sends deephbz's Pi 1.2.0 bytes through the Chat relay, Messages, Responses, Gemini and Codex, and `TestPiAddedToolOfferedToClaudeCode` through the Claude subscription bridge.
 - Every request to a key+URL provider goes with magpie's User-Agent (`magpie/<Version>`, `userAgentFor` in [`user_agent.go`](../../internal/gateway/user_agent.go)), except a provider set `passUserAgent` (#1851, `magpie provider set <id> user-agent=agent`, the editor's "Send the agent's own User-Agent"): it gets the User-Agent the inbound request carried, unchanged, for a coding plan that serves only the agents it names. One the agent didn't send, and magpie's own (`magpiesOwn`: another magpie's `magpie/…`, `magpie-router/1`, `magpie-vision/1`, `magpie-search/1`, and the image tool's `<client> magpie-image/1`, built from MCP's clientInfo, not a User-Agent), go as magpie; magpie never makes up another client's. `forwardOnce` sets it for chat, Anthropic, Responses, Gemini and count_tokens; embeddings, images and videos (`retrieveFrom`, `sendWith`, `remoteVideoContent`) set it with `stampUA` from the caller the request came with (`caller.ua`, `withCaller`), and before #1851 went with Go's default. Claude Code's and Codex's own headers are copied after, as before, and the user's `header.User-Agent` is put on when the request is signed, so it wins. `provider.PassesUserAgent` refuses it for a signed-in account, a plugin's, and a vendor whose own client magpie goes as (`OwnClient`: OpenCode, Cline, Kilo, another magpie); their signing sets their own. `TestUserAgentPassedOn`, `TestUserAgentAccountUntouched`, `TestUserAgentFor`, `TestPassesUserAgent`, `provider-user-agent.test.cjs`.
-- A Chat upstream that wants a turn's reasoning back (`chatReplaysReasoning` in [`chat.go`](../../internal/gateway/chat.go): a host or a model, as magpie or the provider names it, with `deepseek` in it, such as OpenCode Go's `deepseek-v4.1-flash`, or Command Code's plugin) gets every assistant tool call with `reasoning_content`, relayed (`withReasoningOnToolTurns` in `passthrough`) or translated (`buildChat`). DeepSeek turns the whole request away ("The `reasoning_content` in the thinking mode must be passed back to the API") when a tool call made since the user's last message has none, which a client sends for a turn it saw no thinking on: another model's, a translated one (#1462). The turn's own thinking goes back as it came; one sent in `reasoning` or `reasoning_details` is copied in; otherwise it goes with a space (`noReasoning`: DeepSeek's Chat API takes an empty one, but a relay that leaves empty fields out would drop it). An assistant message right after a tool result, a reply with no call of its own, gets one too: DeepSeek refuses it the same way (checked 2026-10-12, #1822). A reply to the user, any other model and Mistral (#494) are sent as before.
-- Kimi's Chat API (`isKimi`: the Kimi platform's and a Kimi Code membership's hosts or presets) turns `reasoning_details` in a message away in any shape: an entry with a stream's `index` ("the reasoning_details at position 1 entry 0 must not contain streaming index") and any other entry ("… has an invalid type"), checked against api.kimi.com/coding on 2026-10-12. pi keeps another vendor's thinking there (MiMo's, through Command Code, with `index: 0`), so a conversation routed on to Kimi was refused on every turn (#1765). `passthrough` sends it to Kimi as `reasoning_content` (`reasoningDetailsAsContent`), which Kimi takes; a message with `reasoning_content` of its own keeps that. Another upstream that refuses a thinking field "at position N", as Kimi words it (a relay in front of it), is asked once more the same way and marked (`refusedInMessages`, `withoutMessageReasoning`).
+- A Chat upstream that wants a turn's reasoning back (`chatReplaysReasoning` in [`chat.go`](../../internal/gateway/chat.go): a host or a model, as magpie or the provider names it, with `deepseek` in it, such as OpenCode Go's `deepseek-v4.1-flash`, or Command Code's plugin) gets every assistant tool call with `reasoning_content`, relayed (`withReasoningOnToolTurns` in `passthrough`) or translated (`buildChat`). DeepSeek turns the whole request away ("The `reasoning_content` in the thinking mode must be passed back to the API") when a tool call made since the user's last message has none, which a client sends for a turn it saw no thinking on: another model's, a translated one (#1462). The turn's own thinking goes back as it came; one sent in `reasoning` or `reasoning_details` is copied in and the spelling it came in as is left out, since an upstream that declares `reasoning_content` an alias of `reasoning` reads the pair as a duplicate field (#2607); otherwise it goes with a space (`noReasoning`: DeepSeek's Chat API takes an empty one, but a relay that leaves empty fields out would drop it). An assistant message right after a tool result, a reply with no call of its own, gets one too: DeepSeek refuses it the same way (checked 2026-10-12, #1822). A reply to the user, any other model and Mistral (#494) are sent as before.
+- Kimi's Chat API (`isKimi`: the Kimi platform's and a Kimi Code membership's hosts or presets) turns `reasoning_details` in a message away in any shape: an entry with a stream's `index` ("the reasoning_details at position 1 entry 0 must not contain streaming index") and any other entry ("… has an invalid type"), checked against api.kimi.com/coding on 2026-10-12. pi keeps another vendor's thinking there (MiMo's, through Command Code, with `index: 0`), so a conversation routed on to Kimi was refused on every turn (#1765). `passthrough` sends it to Kimi as `reasoning_content` (`reasoningDetailsAsContent`), which Kimi takes; a message with `reasoning_content` of its own keeps that, and one whose thinking also stood in `reasoning` goes out with `reasoning_content` alone (#2607). Another upstream that refuses a thinking field "at position N", as Kimi words it (a relay in front of it), is asked once more the same way and marked (`refusedInMessages`, `withoutMessageReasoning`).
 - Claude Code's deferred tools (ToolSearch, MCP tools that come and go) put blocks of their own in a message: a `tool_addition` (`tool` a `tool_reference` naming the tool, or a `tool_definition`), a `tool_removal`, and a `tool_reference`. Kimi's Anthropic endpoint refuses any of them with a whole-request 400 "Invalid request Error" that names nothing, so once a session had loaded a tool every turn failed (#2042); DeepSeek's takes a `tool_addition` naming a tool but refuses one defining it, a `tool_removal` and a message's `tool_reference` with 422 "unknown variant `tool_removal`" (both checked against the real endpoints on 2026-10-14). OpenCode Go also rejects DeepSeek inline definitions with a generic 422 "Upstream request failed: Endpoint is unavailable." (checked on 2026-10-15). Kimi and DeepSeek models on OpenCode are never sent these blocks (`forwardOnce`); a provider that refuses one in those words is asked again at once without them and not sent them again while magpie runs (`refuseShapes`, `shapeDeferred`; the retry loop reads a 422 as well as a 400). `withoutDeferredTools` drops the blocks and a message they leave empty; definitions present only in a `tool_addition.tool.definition` join the request's `tools` once by name (an existing top-level definition wins), and a `tool_reference` inside a `tool_result` (ToolSearch's answer, which both take) stays. Any other provider is sent them as Claude Code wrote them ([`anthropic_shapes.go`](../../internal/gateway/anthropic_shapes.go), `TestKimiIsSentNoDeferredToolBlocks`, `TestDeferredToolBlocksRefusedOnceLeftOut`, `TestOpenCodeDeepSeekInlineTools`, `TestDeferredInlineDefinitionPreserved`).
 - ToolSearch's answer is a `tool_result` whose content is `tool_reference` blocks alone. OpenDesign's Anthropic endpoint can't read one: 422 "Failed to deserialize the JSON body into the target type: messages[4]: missing field `content`" (#2124, the reporter's direct request without magpie fails the same way; the same result with a text block beside the references is taken). A provider that refuses in those words while the request holds such a result is asked again at once with a text block first in each, "Tool <name> is loaded and can be called now." (`toolLoadedText`, the words a translated route already gives a model in `stringOrText`), the references and the `tool_use`/`tool_result` pairing kept, and is sent it that way while magpie runs (`refuseShapes`, `shapeRefsOnly`, `withRefsSaid`). This is in `forward`, so `/v1/messages`, `count_tokens` and a group's member all get it; a request translated to another API already carries the references as that text. Any other provider is sent the bare references (`TestRefsOnlyToolResultRefusedGetsText`, `TestRefsSaidLeavesOtherResults`).
 - A Responses upstream that wants a turn's reasoning back (`replaysReasoning` in [`responses.go`](../../internal/gateway/responses.go): a model with `deepseek` in its name, on any host but OpenAI's, xAI's, Copilot's and Azure's) gets every reasoning item with a `reasoning_text` and every tool call after one, relayed (`withReasoningText` in `passthrough`) or translated (`buildResponses`). DeepSeek's `/v1/responses` turns the whole request away ("The `reasoning_text` in the thinking mode must be passed back to the API") over a reasoning item without text, one with an empty text, and a `function_call` whose step (since the last user message or tool output) has no reasoning item. Codex sends all three in a routing group that falls to DeepSeek after ChatGPT: the backend's sealed items (`encrypted_content` only), magpie's summary-only items, and another member's calls with none (#1104, #1592). DeepSeek reads a step (a run of reasoning, assistant messages and calls) as one assistant message whose thinking is the item it starts with: in the current turn, a step with a call or after a tool output must lead with a reasoning item, so [message, reasoning, call] and [output, message] are refused while [reasoning, message, call] and [output, reasoning, message] are taken (checked against api.deepseek.com on 2026-10-12). Codex sends a step that said something before its call with no reasoning for another model's turn, which magpie used to send [message, reasoning " ", call] and DeepSeek refused intermittently, only while the turn lasted (#1822, through OpenCode Go). An item's own text is kept; one without gets its summary, else a space (`noReasoning`); each such step leads with its reasoning (`reasonFirst`): its own first reasoning item moved ahead, else one holding a space. A sealed item keeps its id and `encrypted_content`; a body already in that shape goes byte for byte.
diff --git a/internal/gateway/chat_tool_reasoning_test.go b/internal/gateway/chat_tool_reasoning_test.go
index 4eb00eea..0f673be1 100644
--- a/internal/gateway/chat_tool_reasoning_test.go
+++ b/internal/gateway/chat_tool_reasoning_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"encoding/json"
+	"fmt"
 	"strings"
 	"testing"
 
@@ -84,7 +85,7 @@ func TestChatToolTurnWithoutReasoningRelayed(t *testing.T) {
 		sameJSON(t, ms[1], `{"role":"assistant","content":"Hello!"}`)
 		sameJSON(t, ms[3], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning_content":" "}`)
 		sameJSON(t, ms[5], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more."}`)
-		sameJSON(t, ms[7], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning":"OpenRouter's field.","reasoning_content":"OpenRouter's field."}`)
+		sameJSON(t, ms[7], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"OpenRouter's field."}`)
 		sameJSON(t, ms[4], `{"role":"tool","tool_call_id":"call_1","content":"12:00"}`)
 	}
 
@@ -99,6 +100,50 @@ func TestChatToolTurnWithoutReasoningRelayed(t *testing.T) {
 	}
 }
 
+// aliasRefuseDuplicate answers as the vLLM frontend of #2607 does:
+// reasoning_content is declared a serde alias of reasoning, so an
+// assistant message carrying both names reads as a duplicate field and the
+// whole request is turned away.
+func aliasRefuseDuplicate(body []byte) (int, string) {
+	var q struct {
+		Messages []map[string]json.RawMessage `json:"messages"`
+	}
+	json.Unmarshal(body, &q)
+	for i, m := range q.Messages {
+		_, hasReasoning := m["reasoning"]
+		_, hasContent := m["reasoning_content"]
+		if hasReasoning && hasContent {
+			return 400, fmt.Sprintf(`{"error":{"message":"Failed to deserialize the JSON body into the target type: messages[%d]: duplicate field `+"`reasoning`"+`","type":"invalid_request_error"}}`, i)
+		}
+	}
+	return 0, ""
+}
+
+const secondTimeCall = `{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}`
+
+// A turn's thinking the client kept in `reasoning` or `reasoning_details`
+// goes to an upstream that wants reasoning_content as reasoning_content
+// alone (#2607): writing it without dropping the spelling it came in as
+// sends both, and an upstream that declares reasoning_content an alias of
+// reasoning reads the pair as a duplicate field and turns the request away.
+func TestChatToolTurnReplayReasoningAlone(t *testing.T) {
+	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: aliasRefuseDuplicate}
+	up := setup(t, provider.Chat, f)
+	chatProvider(t, up.URL, provider.Provider{ID: "vllm", Models: []string{"deepseek-v4.1-flash"}})
+	code, body := postTo(t, New(), "/v1/chat/completions", `{"model":"vllm/deepseek-v4.1-flash","stream":false,"messages":[
+		{"role":"user","content":"hi"},
+		{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning":"A"},
+		{"role":"tool","tool_call_id":"call_1","content":"12:00"},
+		{"role":"assistant","content":null,"tool_calls":[`+secondTimeCall+`],"reasoning_details":[{"type":"reasoning.text","text":"B","format":"unknown","index":0}]},
+		{"role":"tool","tool_call_id":"call_2","content":"12:01"}]}`)
+	if code != 200 || f.calls != 1 {
+		t.Fatalf("%d after %d calls, sent %s: %s", code, f.calls, f.got, body)
+	}
+	ms := sentMessages(t, f.got)
+	sameJSON(t, ms[1], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning_content":"A"}`)
+	sameJSON(t, ms[3], `{"role":"assistant","content":null,"tool_calls":[`+secondTimeCall+`],"reasoning_content":"B"}`)
+}
+
 // Mistral, which turns reasoning_content away (#494), is given none for a
 // tool call without thinking.
 func TestChatToolTurnWithoutReasoningNotForMistral(t *testing.T) {
diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index 05680507..1deab085 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -369,7 +369,10 @@ const noReasoning = " "
 // api.deepseek.com on 2026-10-12, #1822). A message with reasoning_content
 // of its own keeps it, any other reply is left as it is (DeepSeek doesn't
 // ask for its thinking), and a body with no tool calls comes back byte for
-// byte.
+// byte. The thinking a turn kept in another spelling goes out as
+// reasoning_content alone, never beside it: an upstream that declares
+// reasoning_content an alias of reasoning reads the pair as a duplicate
+// field (#2607).
 func withReasoningOnToolTurns(body []byte) []byte {
 	afterTool := false
 	return editMessages(body, []string{"tool_calls"}, func(m map[string]json.RawMessage) bool {
@@ -396,6 +399,11 @@ func withReasoningOnToolTurns(body []byte) []byte {
 		if think == "" {
 			think = noReasoning
 		}
+		// the thinking now lives in reasoning_content; leaving beside it
+		// the spelling it came in as is a duplicate field to an upstream
+		// that declares reasoning_content an alias of reasoning (#2607)
+		delete(m, "reasoning")
+		delete(m, "reasoning_details")
 		m["reasoning_content"], _ = marshalPlain(think)
 		return true
 	})
@@ -407,7 +415,9 @@ func withReasoningOnToolTurns(body []byte) []byte {
 // shape it comes, OpenRouter's reasoning.text with a stream's index in it
 // (as another vendor's turn has it) or without ("the reasoning_details at
 // position 2 entry 0 must not contain streaming index", "… has an invalid
-// type", #1765), and takes reasoning_content.
+// type", #1765), and takes reasoning_content. A thinking the message kept
+// in reasoning beside reasoning_details goes out as reasoning_content
+// alone (#2607).
 func reasoningDetailsAsContent(body []byte) []byte {
 	return editMessages(body, []string{"reasoning_details"}, func(m map[string]json.RawMessage) bool {
 		if _, ok := m["reasoning_details"]; !ok {
@@ -417,6 +427,8 @@ func reasoningDetailsAsContent(body []byte) []byte {
 		if decodeJSON(m["reasoning_content"], &own) != nil || own == "" {
 			if think := reasoningText(m); think != "" {
 				m["reasoning_content"], _ = marshalPlain(think)
+				// one spelling goes out, not two (#2607)
+				delete(m, "reasoning")
 			}
 		}
 		delete(m, "reasoning_details")
diff --git a/internal/gateway/kimi_reasoning_details_test.go b/internal/gateway/kimi_reasoning_details_test.go
index 56e44c8a..1be44f2d 100644
--- a/internal/gateway/kimi_reasoning_details_test.go
+++ b/internal/gateway/kimi_reasoning_details_test.go
@@ -51,16 +51,21 @@ func TestKimiGetsReasoningDetailsAsContent(t *testing.T) {
         {"role":"assistant","content":"91 = 7 x 13.","reasoning_details":[{"type":"reasoning.text","text":"Check divisibility by 7: 7*13=91.","format":"unknown","index":0}]},
         {"role":"user","content":"And 93?"},
         {"role":"assistant","content":"93 = 3 x 31.","reasoning_content":"Digits sum to 12.","reasoning_details":[{"type":"reasoning.text","text":"Digits sum to 12.","format":"unknown","index":0}]},
-        {"role":"user","content":"And 97? One word."}]}`)
+        {"role":"user","content":"And 97? One word."},
+        {"role":"assistant","content":"97 stays prime.","reasoning":"Odd and no factors below 10.","reasoning_details":[{"type":"reasoning.text","text":"Odd and no factors below 10.","format":"unknown","index":0}]},
+        {"role":"user","content":"And 99?"}]}`)
 	if code != 200 || f.calls != 1 {
 		t.Fatalf("%d after %d calls, sent %s: %s", code, f.calls, f.got, body)
 	}
 	ms := sentMessages(t, f.got)
-	if string(ms[0]) != `{"role":"user","content":"Is 91 prime?"}` || string(ms[4]) != `{"role":"user","content":"And 97? One word."}` {
+	if string(ms[0]) != `{"role":"user","content":"Is 91 prime?"}` || string(ms[4]) != `{"role":"user","content":"And 97? One word."}` || string(ms[6]) != `{"role":"user","content":"And 99?"}` {
 		t.Errorf("other messages changed: %s", f.got)
 	}
 	sameJSON(t, ms[1], `{"role":"assistant","content":"91 = 7 x 13.","reasoning_content":"Check divisibility by 7: 7*13=91."}`)
 	sameJSON(t, ms[3], `{"role":"assistant","content":"93 = 3 x 31.","reasoning_content":"Digits sum to 12."}`)
+	// OpenRouter replays `reasoning` beside `reasoning_details`; Kimi is
+	// given the one spelling (#2607)
+	sameJSON(t, ms[5], `{"role":"assistant","content":"97 stays prime.","reasoning_content":"Odd and no factors below 10."}`)
 }
 
 // An upstream that isn't known to be Kimi (a relay in front of it) and
-- 
2.50.1 (Apple Git-155)
```

</details>

分支：[`ggbdpq/magpie@hunt32-b-gw-2607-reasoning-dup`](https://github.com/ggbdpq/magpie/tree/hunt32-b-gw-2607-reasoning-dup)（commit `25dc5013`）。合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
