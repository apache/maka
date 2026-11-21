> 发布形态：#1475 的评论。嵌 patch（format-patch 全文进 <details>，commit 尾注含模型名 → 尾部 AI 项只写承诺句）。fork 分支链接待推送授权后补进正文占位处。若改为只贴分支链接：AI 项改为 "written with GLM-5.3-Flash (ZCode). I've read ..."。行间禁空行（Verification 表）。

The emit-boundary reading in the issue body holds on today's main (`b14784c0`): a whole reply whose `tool_calls` carry a call with no `name` leaves the gateway as it came, on both paths a whole reply can take. This closes that hole.

**What happens** (main, fake upstream that answers one JSON body where a streamed request was sent): the agent's stream carries

```json
"tool_calls":[{"function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"},"id":"call_1","index":0,"type":"function"},{"function":{"arguments":"{}"},"id":"call_2","index":1,"type":"function"}]
```

— the second call has no `name` key, the shape ai-sdk rejects with `AI_InvalidResponseDataError: Expected 'function.name' to be a string`, which is non-retryable and, since the malformed call is already in the history, kills every continue after it. The same body reaches a `stream:false` client untouched, because it goes through `chatWhole` (internal/gateway/chattidy.go), the mend every whole Chat reply passes — which until now read only the message's text and left existing `tool_calls` alone.

**Root cause**: `chatWhole`'s flush is where whole replies get mended (typed parts #483, calls written into text #1845, a call with no id #2611), and the structured calls were its one blind spot. From there a reply reaches the client two ways: as the `stream:false` body itself, or held and turned into the stream the agent asked for (`wholeAsStream`, whose `chatWholeEvents` patches only `index`, exactly as the issue reads it). A translated request never converts a whole reply into a stream — it fails 502 "did not stream" for the next candidate — so relayed whole replies are the one place the call can leave from. The streamed fragments' empty name is already dropped (`withoutEmptyNames`).

**Fix**: `chatWhole`'s flush now runs `withoutNamelessCalls`: a call whose `function` has no name, an empty one, or a non-string one is moved into the message's text as its own JSON, one line per call — the fallback `qoderParseCall` and `parseTextCalls` already choose for markup they can't make a call of. A named call beside it goes on as the call it is; a reply left calling no tool ends `stop`, not `tool_calls`. A `tool_calls` that doesn't parse, a content that is neither a string nor null, and a call whose JSON can't be marshaled leave the reply byte for byte. Whether this is the path your Qoder turn took is not claimed — yours was streamed — but whichever vendor answers whole with a nameless structured call now degrades instead of opening a stream the client rejects. (Qoder's built-in has since been retired to its plugin; the path fixed here is protocol-level.)

**Verification** (base `b14784c0`, Go 1.26.8, sandbox HOME, private GOCACHE, offline):

| What | Result |
|---|---|
| Two new cases in `TestQuietWholeReplyStreamed` (a nameless call beside a real one; a reply whose only call has no name) | red on main, green with the fix |
| `TestWholeReplyNamelessCallAsText` (the `stream:false` route) | red on main, green with the fix |
| Ablation: `chattidy.go` alone restored to baseline, tests kept | the three red again; fix restored, green |
| Mutation: finish rewrite off | red on "stop:tool" vs "stop:stop" |
| Mutation: the call dropped without its text | all three red on the text |
| Family: `TestTextWritten*`, `TestGLMTextCall*`, `TestPluginTextWrittenCall`, `TestEmptyCallID*`, `TestWholeReplyCallGivenAnID` | green |
| `go test -tags nogui ./internal/gateway` in full | ok (332.3s) |
| Targeted set with `-race` | ok |
| `gofmt -l`, `go vet -tags nogui` (darwin, linux, windows), `go build -tags nogui` (darwin/arm64, linux/arm64, windows/amd64) | clean / ok |

**Not run**: a replay of your real Qoder request (no live account here); real ai-sdk / Pi clients against the fixed gateway; the streamed path beyond the existing `withoutEmptyNames` (a complete nameless call assembled from fragments has no demonstrated shape — whether your turn took that path is what the replays couldn't pin down).

Patch against `b14784c0`, branch `hunt41-h3-1475-nameless-call` (fork link: _pending push_):

<details><summary>format-patch (0001-gateway-a-whole-reply-s-tool-call-with-no-name-goes-.patch)</summary>

```
From 00ba51a4d7139b02b071507a556d3ac9d7f38e16 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 18 Oct 2026 02:49:11 +0800
Subject: [PATCH] gateway: a whole reply's tool call with no name goes to the
 agent as the text it becomes (#1475)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Chat upstream that ignores stream:true and answers whole has its reply
mended by chatWhole, and the mended body is what both of its consumers
read: the stream:false request relayed to it, and the agent whose
stream's headers went out while the vendor said nothing (wholeAsStream
turns the body into the stream it asked for). A structured call in that
reply whose function carries no name — or an empty one, or one that
isn't a string — went out as it came, and a strict client turned the
whole turn away at the frame (AI_InvalidResponseDataError: Expected
'function.name' to be a string), dead for every turn after: the
malformed call is already in the conversation, and every continue fails
at the same place (#1475, AricRedemption, 0.1.1137).

- withoutNamelessCalls (chattidy.go) moves such a call into the
  message's text as its own JSON, one line per call, the way the
  parsers leave markup they can't make a call of, and a reply left
  calling no tool ends stop, not tool_calls. A named call beside it
  goes on as the call it is. A tool_calls that doesn't parse, a content
  that is neither a string nor null, and a call whose JSON can't be
  marshaled leave the reply byte for byte. It runs after the whole ids
  (#2611) and the whole text calls (#1845), the last mend a whole
  reply's calls get before they leave.
- The streamed fragments' empty name is already dropped
  (withoutEmptyNames), and a translated request never converts a whole
  reply into a stream (it fails "did not stream" for the next
  candidate), so a whole reply's relayed body is the one place the call
  could leave from.

Tests (quiet_whole_test.go): two cases in TestQuietWholeReplyStreamed —
a nameless call beside a real one, and a reply whose only call has no
name — and TestWholeReplyNamelessCallAsText for the stream:false route.
Each watched red on upstream/main b14784c03: the nameless call left as
the frame it came as, "tool_calls":[{"function":{"arguments":"{}"},
"id":"call_2",...}] with no name key. With the fix, green;
TestTextWritten*, TestGLMTextCall*, TestPluginTextWrittenCall,
TestEmptyCallID*, TestWholeReplyCallGivenAnID, TestQuietNotAReplyLastFails
and TestWholeAsStreamClientReads stay green. chattidy.go alone restored
to baseline, tests kept: the three red again; fix restored, green.
Mutations: the finish_reason rewrite off turns the only-call case red on
"stop:tool" vs "stop:stop"; the text move off (the call dropped without
its text) turns all three red on the text.

Run (Go 1.26.8, sandbox HOME, private GOCACHE, offline module cache):
- go test -tags nogui ./internal/gateway in full: ok (332.3s)
- targeted set with -race: ok
- gofmt -l clean; go vet -tags nogui on darwin, GOOS=linux and
  GOOS=windows clean; go build -tags nogui on darwin/arm64,
  linux/arm64 and windows/amd64 ok.

Not run: the full go test ./... (only internal/gateway); a real Qoder
or strict-client session (no live account here).

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md   |  2 +-
 internal/gateway/chattidy.go         | 74 ++++++++++++++++++++++++++--
 internal/gateway/quiet_whole_test.go | 37 ++++++++++++++
 3 files changed, 109 insertions(+), 4 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index ccea32f7..d0b708fd 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -135,7 +135,7 @@ recorded as a prediction failure (`noPrediction`).
 - A turn the agent stopped with its tool call still out is replayed by the client with the call and no result, and Google's APIs turn a history whose call turn goes unanswered away with 400, every later turn of the conversation with it. The Gemini build (`buildCodeAssistSent`, which serves a Google sign-in, Vertex AI and a custom provider's Gemini API alike) answers such a call with the synthetic result the chat build pairs an interrupted turn's call with (`pairToolMessages`, #1275), right after the calls (`pairFunctionTurns`, #1560): beside the answers the client sent there, or in a user turn of its own before what the user said, since a turn mixing a `functionResponse` with text is turned away too (#1533); a Claude model on Antigravity gets it in the one tool_result turn. A call with no id counts as answered by a response of its name. A second answer to one call is left out, with the images it carried, before the turns are built (`dropSecondAnswers`, #2262): Google refuses a call turn whose `functionResponse` count differs from its `functionCall` count, and the Chat and Messages builds already keep the first answer. The Responses build (`buildResponses`) leaves it out the same way. A call made again under the same id takes an answer of its own. A Gemini client that keeps no ids answers two calls of one function by name in their order, and each answer goes to its own call (`parseGemini`), not both to the latest. `TestGeminiDropsASecondAnswer`, `TestSecondAnswerDroppedWithItsImages`, `TestGeminiClientUnnamedCallsAnsweredInOrder`.
 - A request built for a Messages upstream (`buildAnthropic`: a Chat, Responses or Gemini client translated) has its tool exchanges mended after its messages are built (`pairToolBlocks`, #1558, ggbdpq), since Anthropic answers 400 for a `tool_use` the next message doesn't answer and for a `tool_result` naming no call of the message before it. A call left unanswered gets the synthetic interrupted result, `is_error` set, first in the user message after it or in one of its own; a result that answers no call goes as a text block with what it said (its images as they came); a second answer to one call is dropped. A well-formed exchange goes as it was built. An Anthropic client relayed to a Messages upstream isn't mended. [`anthropic_tool_pairing_test.go`](../../internal/gateway/anthropic_tool_pairing_test.go).
 - A Responses request bound for anything but a ChatGPT sign-in has its tool exchanges mended in `attempt`, before it is relayed or translated, plugins included ([`responses.go`](../../internal/gateway/responses.go)). An item inside a run of calls and results (after one of the run's results and before the last, or before any result when the model didn't write it) moves to the end of that run (`joinToolRuns`, #1752, Edward4226): Codex writes its `<image_resize_notice>` right after each result whose image it resized, so a batch of two calls had it between their results, and a strict upstream answered 400 (OpenCode Go/DeepSeek "No tool output found for tool call …", Volcengine's "must be followed by tool messages", #1822); a Chat translation answered the second call with a synthetic result. An item carrying a `call_id` never moves, the model's own reasoning between its calls stays, and its text between them (an assistant message, with the reasoning right before it) goes ahead of the run's first call, so the step's calls stand together: OpenCode Go opens a new assistant message at such text and answered the call before it "No tool output found for tool call …" (#2100). A call opens a run only when a result after it answers it. A result with no call id becomes a user message after its run (`orphanedToolOutputs`), and a call nothing answers gets a synthetic result at the end of its run (`pairToolItems`, #1341). `TestRelayedCodexImageBatchKeepsItsResultsTogether`, `TestJoinToolRunsOnlyMovesWhatBreaksARun`, `TestRelayedTextBetweenABatchsCallsIsAnswered`.
-- A Chat request has every tool call that came with no id (`""`, null or none) given one in `attempt`, before it is relayed or translated, plugins included (`chatCallIDs` in [`chat_call_ids.go`](../../internal/gateway/chat_call_ids.go), #2611, RunMintOn). An upstream that sometimes streams a call without an id (OpenCode Zen's free DeepSeek) has the agent keep it as `""`, which that upstream takes back, while WorkBuddy AI turns a streamed request carrying one away (400, code 11133) and Anthropic takes no empty `tool_use` id. The id is made from the call's place in the request, its name and its arguments, never at random, so the next turn's history goes byte for byte and the upstream's prompt cache holds; the tool messages after the call that answer with no `tool_call_id` take the made ids in the calls' order. A body whose calls all have ids goes as it came. On the reply side, a relayed Chat stream's call whose first fragment has no id is given one, and a later fragment's empty id is left out (`chatTidy`); a whole reply's call is given one too (`chatWhole`). `TestEmptyCallIDRelayedWithOne`, `TestEmptyCallIDReachesPluginWithOne`, `TestEmptyCallIDTranslatedWithOne`, `TestStreamedCallGivenAnID` in [`chat_call_ids_test.go`](../../internal/gateway/chat_call_ids_test.go).
+- A Chat request has every tool call that came with no id (`""`, null or none) given one in `attempt`, before it is relayed or translated, plugins included (`chatCallIDs` in [`chat_call_ids.go`](../../internal/gateway/chat_call_ids.go), #2611, RunMintOn). An upstream that sometimes streams a call without an id (OpenCode Zen's free DeepSeek) has the agent keep it as `""`, which that upstream takes back, while WorkBuddy AI turns a streamed request carrying one away (400, code 11133) and Anthropic takes no empty `tool_use` id. The id is made from the call's place in the request, its name and its arguments, never at random, so the next turn's history goes byte for byte and the upstream's prompt cache holds; the tool messages after the call that answer with no `tool_call_id` take the made ids in the calls' order. A body whose calls all have ids goes as it came. On the reply side, a relayed Chat stream's call whose first fragment has no id is given one, and a later fragment's empty id is left out (`chatTidy`); a whole reply's call is given one too (`chatWhole`). A whole reply's call whose function names no tool goes to the agent as the text it becomes instead (`withoutNamelessCalls` in [`chattidy.go`](../../internal/gateway/chattidy.go), #1475: a structured call with no name, or with the empty string or a non-string for one, went out as it came, and a strict client turned the whole turn away at the frame, dead for every turn after) — the call's own JSON, one line per call, beside the message's text; a reply left calling no tool ends `stop`, not `tool_calls`. `TestWholeReplyNamelessCallAsText`, and the two nameless cases in `TestQuietWholeReplyStreamed`.
 - Codex's model list from the backend path (`codexModels`) is the ChatGPT backend's for its sign-in and then magpie's (`provider.CodexListed`), its ETag and every reply's `X-Models-Etag` tagged with `provider.CodexListTag` so a change has Codex ask again. A Codex there only for account failover, not connected (`CodexOwnOnly`, `agent.CodexOwnOnly`; #1385), gets the backend's alone, tagged with `provider.CodexOwnListTag`; neither tag contains the other, so connecting or disconnecting has Codex fetch the list again. The user's picks on the codex provider (`provider.CodexNativePicked`) narrow the backend's listed models. They keep its hidden ones (`visibility: "hide"`), which no picker shows. One of those is `codex-auto-review`: when the list lacks it and no reviewer is set, Codex's auto-review runs on the conversation's model at low effort (#1460, `TestCodexModelListPicksKeepHidden`). The account's own models kept out of agents' lists for routing groups (`provider.CodexNativeUnlisted`) are dropped from it too, hidden ones kept: every one when the codex provider is "Only through routing groups" (`Provider.Unlisted`), and those a group that unlists its members names (`Group.Unlists`). A Codex there only for failover keeps them, as it is handed no groups; `spawnChoices` drops the same ones (#1602, `TestCodexModelListUnlistedForGroups`).
 - Reasoning state goes through magpie's translation as the vendor wrote it when the agent and the upstream speak the same API (#1445, XYenon): a non-streaming Messages request to a stream-only account, web search on the agent's own API, a plugin, failover. The IR carries it sealed (`Part.Sealed`, `SealedBy`; events `KThinkStart`, `KSealed`, `KTextSig` in [`ir.go`](../../internal/gateway/ir.go)), so each thinking block or reasoning item stays apart, whole or streamed, and a seal is written only for its own API (`sealedBy`). Anthropic's `redacted_thinking` goes back raw (to DeepSeek as a thinking block, below), and a thinking block signed with no text keeps its signature (`aBlock` still writes `"thinking": ""`, #1447), on Claude's subscription too. A Responses reasoning item keeps its id, summary and `encrypted_content`, and goes back to a Responses upstream as it came when it has no reasoning text (`sealedReasoning`; text, another vendor's, is still left out for OpenAI, #1411). Gemini's `thoughtSignature` stays on the call it signed and on text; a later call of a signed step goes without one, and only an unsigned step or Claude on Antigravity gets `skip_thought_signature_validator`. Another API's agent gets the call's signature in its id, as on chat (#687), with its length in the mark (`__ts<n>__`), so an id a client shortened carries no signature and the call goes as unsigned (#1536); it gets no one else's seal. The signature itself is kept in magpie's folder, `gemini-signatures/<key>`, named by its hash (`keepSignature` in [`gemini_sigstore.go`](../../internal/gateway/gemini_sigstore.go)), and the id carries only the key (`__tsk16__<key>`), so an id stays under 64 characters however long the step's signature (#2411: LobeHub's PostgreSQL index turned away a 3KB id). A key magpie no longer has, or whose file doesn't hash to it, reads as no signature; one not read for 90 days is removed. Where the folder can't be written, the id carries the signature as before. Carrying reasoning across APIs (an envelope) isn't done.
 - A translated Responses reply gives Codex the reasoning items a Responses upstream sent, as it sent them; any other upstream's reasoning becomes items magpie made: an `rs_` id and a summary, nothing sealed. Codex hands them back on every turn. A request relayed as is to OpenAI's API or Azure OpenAI goes without them (`withoutBareReasoning`) unless `store` is true, because both look the id up among stored items and answer 400 "Item with id 'rs_…' not found" (#1008). Any other Responses upstream gets them, because a DeepSeek model wants its reasoning back (#388). When one answers 400 naming the input (`refusesInput`: `param` is `input`, or the error names an item by id), as a relay in front of OpenAI does with a message of its own, `passthrough` asks once more without them and, once that works, leaves them out for that provider and model from then on (`bareReasoningRefused`, #1044). Codex's compaction offers no tools, so it is relayed even when its turns were translated. When a provider answers its summary request 404, or 400 for an item it didn't find (`itemNotFound`, a relay in front of either), `codexCompact` asks once more with the conversation as text (`plainCompact`), then compacts locally (#866, #1008). So does the ChatGPT backend's 502 "response protection is unavailable" (`protectionRefused`): a long history refused so was answered as text. Codex also compacts remotely, a `compaction_trigger` on `/responses` that wants exactly one compaction item back, on any provider table named "OpenAI", as CC Switch names its relay tables. magpie points those at `/v1` while a magpie model is on, so `handle` makes the summary there too (`codexInput`, `codexCompact`), and magpie's summaries go back to the model as text (#1301). A summary is wanted only whole (`askWhole`, `holdWriter.wantWhole`): its stream is held to its end, not let through at its first words, so a reply cut short (`errEndedShort`), failed halfway (a 429 "Individual quota reached" after some of it) or ended `incomplete` (`endedIncomplete`, `incompleteReply`) fails over to the next candidate like a failure before any of it, and rests the account as that failure would; one that reached its output limit rests nobody. With nobody left, `codexCompact` answers 502 and never hands Codex the words before the cut as the summary (#2274, huangzuomin: Antigravity cutting each summary short). Codex with context_management's experimental mode compacts in the background at every step while the conversation is over its threshold and drops a failed compaction without a word, so a conversation whose summaries keep failing is asked again every few seconds, each paying for the whole history (1169 compactions in 6 hours there). After `compactFailsMost` (3) failed summaries in a row of one conversation (`prompt_cache_key`) on one model, each within `compactHeldFor` (5 minutes) of the last, the next is answered at once with a 400 naming the last failure, which Codex doesn't ask again, and no model is asked until 5 minutes have passed (`compactFails` in [`codex_compact_guard.go`](../../internal/gateway/codex_compact_guard.go)); a summary that comes clears the count, and a sign-in's 401 or 403 isn't counted. `TestCodexCompactCutSummaryFailsOver`, `TestCodexCompactCutSummaryIsNoSummary`, `TestCodexCompactKeepsFailingIsHeld`.
diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index 9832d273..7a779bf0 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -281,9 +281,11 @@ func flattenContent(m map[string]json.RawMessage, whole bool) bool {
 // on with a string content and its thinking in reasoning_content, and,
 // when the request offered tools (names), calls the model wrote into its
 // text are made the calls they are, as textCallTidy makes them in a
-// stream (#1845), and a call the upstream gave no id is given one, as
-// chatTidy gives it in a stream (#2611). It is held until it ends; any
-// other reply passes byte for byte.
+// stream (#1845), a call the upstream gave no id is given one, as
+// chatTidy gives it in a stream (#2611), and a call the upstream gave no
+// name goes to the agent as the text it becomes, as the parsers leave
+// markup they can't make a call of (#1475). It is held until it ends;
+// any other reply passes byte for byte.
 type chatWhole struct {
 	names map[string]bool
 	buf   []byte
@@ -324,6 +326,15 @@ func (t *chatWhole) flush() []byte {
 			}
 			mended = true
 		}
+		// a call the upstream gave no name goes to the agent as its own
+		// text, not as the frame a strict client turns the whole turn
+		// away at (#1475)
+		if moved, left := withoutNamelessCalls(msg); moved {
+			if !left && string(c["finish_reason"]) == `"tool_calls"` {
+				c["finish_reason"] = json.RawMessage(`"stop"`)
+			}
+			mended = true
+		}
 		if !mended {
 			continue
 		}
@@ -341,6 +352,63 @@ func (t *chatWhole) flush() []byte {
 	return nb
 }
 
+// withoutNamelessCalls moves a whole reply's tool calls that carry no
+// name into the message's text, and says whether any moved and whether a
+// call is left. A call no client can route — its function names nothing,
+// or names it with the empty string or something that isn't a string —
+// can't go as a call: the parsers leave markup they can't make a call of
+// as the text it came as, and a stream's empty name is dropped
+// (withoutEmptyNames), but a whole reply's call went to the agent as it
+// came, and a strict client turned the whole turn away at the frame,
+// dead for every turn after (#1475). The call's own JSON is the text it
+// becomes, one line per call; a reply left calling no tool ends stop,
+// not tool_calls.
+func withoutNamelessCalls(msg map[string]json.RawMessage) (moved, left bool) {
+	var calls []map[string]json.RawMessage
+	if decodeJSON(msg["tool_calls"], &calls) != nil {
+		return false, false
+	}
+	// a content that is neither a string nor null is a shape this leaves
+	// as it came, whatever its calls
+	var had string
+	if msg["content"] != nil && decodeJSON(msg["content"], &had) != nil {
+		return false, false
+	}
+	var kept []map[string]json.RawMessage
+	var lines []string
+	for _, call := range calls {
+		var fn map[string]json.RawMessage
+		var name string
+		if decodeJSON(call["function"], &fn) == nil {
+			decodeJSON(fn["name"], &name)
+		}
+		if name != "" {
+			kept = append(kept, call)
+			continue
+		}
+		b, err := marshalPlain(call)
+		if err != nil {
+			kept = append(kept, call)
+			continue
+		}
+		lines = append(lines, string(b))
+	}
+	if len(lines) == 0 {
+		return false, len(kept) > 0
+	}
+	text := strings.Join(lines, "\n")
+	if had != "" {
+		text = had + "\n" + text
+	}
+	msg["content"], _ = marshalPlain(text)
+	if len(kept) == 0 {
+		delete(msg, "tool_calls")
+	} else {
+		msg["tool_calls"], _ = marshalPlain(kept)
+	}
+	return true, len(kept) > 0
+}
+
 // messageReasoning are the fields a Chat client sends an earlier
 // assistant turn's thinking back in: reasoning_content (DeepSeek's, which
 // OpenCode and most clients send), reasoning (OpenRouter's) and
diff --git a/internal/gateway/quiet_whole_test.go b/internal/gateway/quiet_whole_test.go
index 3742ae13..46b86732 100644
--- a/internal/gateway/quiet_whole_test.go
+++ b/internal/gateway/quiet_whole_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"bufio"
+	"encoding/json"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -44,6 +45,14 @@ func TestQuietWholeReplyStreamed(t *testing.T) {
 		// stream's would be (#1845)
 		{"chat with a call in its text", "application/json", `{"id":"chatcmpl-9f4","object":"chat.completion","created":1791370000,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"` + text + `\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"get_weather\">\n<｜DSML｜parameter name=\"city\" string=\"true\">Paris</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`,
 			provider.Chat, "text:" + text + "\n|tool:get_weather " + args + "|stop:tool", 0},
+		// a structured call with no name beside a real one goes to the
+		// agent as its own text, not as the frame a strict client turns
+		// the whole turn away at (#1475)
+		{"chat with a nameless call beside a real one", "application/json", `{"id":"chatcmpl-9f5","object":"chat.completion","created":1791370000,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"` + text + `","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}},{"id":"call_2","type":"function","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`,
+			provider.Chat, "text:" + text + "\n" + `{"function":{"arguments":"{}"},"id":"call_2","type":"function"}` + "|tool:get_weather " + args + "|stop:tool", 0},
+		// a reply whose only call has no name says its text and ends stop
+		{"chat whose only call has no name", "application/json", `{"id":"chatcmpl-9f6","object":"chat.completion","created":1791370000,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`,
+			provider.Chat, `text:{"function":{"arguments":"{}"},"id":"call_2","type":"function"}` + "|stop:stop", 0},
 		// a reply that isn't streamed, whatever its type says
 		{"chat as text/plain", "text/plain; charset=utf-8", `{"id":"chatcmpl-9f3","object":"chat.completion","created":1791370000,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"` + text + `"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}`,
 			provider.Chat, "text:" + text + "|stop:stop", 0},
@@ -351,3 +360,31 @@ func TestHeldUnsureStreamFailsHeld(t *testing.T) {
 		t.Fatalf("passing %v, failed %v, agent has %q", h.passing, h.failed(), rec.Body.String())
 	}
 }
+
+// A whole reply whose tool call carries no name goes to the agent as the
+// text it becomes, not as the call a strict client turns the whole turn
+// away at (#1475): a whole body the vendor gave a stream:false request
+// goes through chatWhole on its way out too.
+func TestWholeReplyNamelessCallAsText(t *testing.T) {
+	f := &fake{t: t, ctype: "application/json", reply: `{"id":"c1","object":"chat.completion","model":"m1","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`}
+	up := setup(t, provider.Chat, f)
+	chatProvider(t, up.URL, provider.Provider{ID: "zen", Models: []string{"deepseek-v4.1-flash-free"}})
+	code, body := postTo(t, New(), "/v1/chat/completions", `{"model":"zen/deepseek-v4.1-flash-free","stream":false,"messages":[{"role":"user","content":"ls"}]}`)
+	var got struct {
+		Choices []struct {
+			Message struct {
+				Content   *string `json:"content"`
+				ToolCalls []any   `json:"tool_calls"`
+			}
+			FinishReason string `json:"finish_reason"`
+		}
+	}
+	if code != http.StatusOK || json.Unmarshal([]byte(body), &got) != nil || len(got.Choices) != 1 {
+		t.Fatalf("%d %s", code, body)
+	}
+	msg := got.Choices[0].Message
+	if msg.Content == nil || *msg.Content != `{"function":{"arguments":"{}"},"id":"call_2","type":"function"}` ||
+		len(msg.ToolCalls) != 0 || got.Choices[0].FinishReason != "stop" {
+		t.Fatalf("%d %s", code, body)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

---
**Source**: reported here (#1475) — your real turn and client log; the fixed path is the demonstrable hole from your own reading of `whole_stream.go`, reproduced on main with a fake upstream that answers whole.

**Red without the fix** (base `b14784c0`): with `internal/gateway/chattidy.go` reverted and the new tests kept, `go test ./internal/gateway -run 'TestQuietWholeReplyStreamed|TestWholeReplyNamelessCallAsText'` fails:
```
--- FAIL: TestQuietWholeReplyStreamed/chat_with_a_nameless_call_beside_a_real_one
    the agent's stream says "text:Checking.|tool:get_weather {\"city\":\"Paris\"}|tool: {}|stop:tool", want "...|stop:tool"
--- FAIL: TestWholeReplyNamelessCallAsText
    200 {"...","tool_calls":[{"id":"call_2","type":"function","function":{"arguments":"{}"}}],...}
```
—the nameless call left as the frame it came as, no `name` key. With the fix: `ok`.

**Siblings**: the emit paths a whole reply's calls can leave from: `chatWhole` (fixed here); `chatTidy`'s `withoutEmptyNames` (the streamed path, already drops the empty name — left as is); `responsesWholeEvents` / `anthropicWholeEvents` (a Responses `function_call` item or Anthropic `tool_use` block with no name would flow through; no demonstrated client failure and no report — left); translations (a whole reply becomes a 502 "did not stream", never a stream — no hole). `rg -n "withoutNamelessCalls" internal/` → one caller.

**When the read fails**: a `tool_calls` that doesn't parse, a content that is neither string nor null, and a call whose JSON can't be marshaled leave the reply byte for byte as it came — nothing is corrupted, and the only thing ever removed from a call frame goes into the message's text.

**Not verified**: real Qoder session (the built-in retired to a plugin), real strict clients.

**AI**: I've read the whole diff and can answer questions on it myself.
