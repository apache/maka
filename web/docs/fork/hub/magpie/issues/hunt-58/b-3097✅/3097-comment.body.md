## Source & environment

Reported in yetone/magpie#3097 (0 comments when this was written): magpie
v0.1.1294 (Docker, Linux aarch64), a client (Hermes Agent) with an
OpenAI-compatible provider whose base URL is the gateway's `/v1`, routed to
the `google` preset (Gemini / Studio API key), model
`google/models/gemini-3.8-flash`. Every call fails before any of the reply
with Google's `400 ... Unknown name "options": Cannot find field`; the same
request without a top-level `options` returns 200.

Reproduced locally on a worktree of f5b01574 (= upstream/main at the time),
go1.25.5 darwin/arm64, against an httptest upstream that stands in for
Gemini's OpenAI-compatible endpoint and records what it is sent.

## Minimal repro

The reporter's (their curl, key elided):

```
curl $GATEWAY/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"model":"google/models/gemini-3.8-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"options":{"num_ctx":1048576}}'
# 400 Invalid JSON payload received. Unknown name "options": Cannot find field.
# the same without "options": 200
```

Locally, the same shape through the real server stack
(`TestGeminiCompatRelayLeavesOutOllamaOptions`, red on the old code):

```
upstream asked /v1beta/openai/chat/completions body:
{"model":"models/gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"hi"}],"max_tokens":8,"options":{"num_ctx":1048576}}
```

## Root cause

The `google` preset speaks Chat at
`https://generativelanguage.googleapis.com/v1beta/openai`
(`internal/provider/presets.go`), so a `/v1/chat/completions` request is
relayable on the client's own API and `s.passthrough` sends the body as it
came, the model name alone swapped (`internal/gateway/gateway.go`).
Nothing on that path judged unknown top-level fields, so `options` — Ollama's
per-request runner settings, which the client sends because magpie's
`/api/show` answers in Ollama's shape and it took the gateway for an Ollama
server — reached Google's endpoint whole. That endpoint parses proto JSON
and turns the whole request away over a name it doesn't know, hence the
constant 400. The translated path never carries the field: `parseChat`
decodes into a typed struct and unknown fields are dropped there, which is
why a custom provider with a Gemini URL only (no Chat URL) was never
affected. magpie's own judgment of the field agrees: the Ollama routes'
body builder (`ollamaChatBody`) copies only the Chat Completions-compatible
options (temperature, top_p, seed, stop, the penalties, a positive
num_predict as max_tokens) and leaves the runner settings out.

## Fix

In `passthrough`'s Chat case, a body relayed to a Gemini OpenAI-compatible
upstream (`geminiCompat`, the same predicate the thought-signature and
thinking-config handling already use) now goes without the top-level
`options` (`withoutFields`, the existing top-level-field drop used for
Qwen's `enable_thinking` and Kimi's `thinking` at OpenAI and Azure). The
runner settings in it have no place on a Chat API, as `ollamaChatBody`
already judges. Another vendor's Chat upstream still gets the body as the
client sent it; translated requests are unchanged (they are built from the
request's own fields, which never carried `options`). `geminiCompat` is
worked out once where the thought signatures ask for it too, so the relayed
Chat path pays no extra predicate call; bodies without the `"options"`
substring are returned untouched by `withoutFields`' bytes.Contains gate.
`docs/subsystems/gateway-routing.md` gains the rule in the relayed-Chat
list. #3110 (tool_choice) is a different refusal and is not touched.

## Verification

| Check | Result |
| --- | --- |
| New test on the old code (fix stashed, f5b01574) | `TestGeminiCompatRelayLeavesOutOllamaOptions` FAIL: `Ollama's options reached Gemini's OpenAI-compatible API: {...,"options":{"num_ctx":1048576}}` |
| New test with the change | PASS |
| Another vendor unchanged | the same test relays `km/kimi-k3` (no Gemini in the model, plain Chat base) and asserts the upstream still receives `"options":{"num_ctx":1048576}` |
| Changed package whole | `go test ./internal/gateway/ -count=1` ok 346.6s, 0 failures |
| Whole suite | `go test ./... -count=1 -timeout 45m`: 66 packages ok; `internal/agent` TestMothX and `internal/gui` TestProxyCheckSaysAProxyPassedBy red — both red with the change stashed on f5b01574 too, this machine's, not this change's |
| Hand-broken guard | ablation: product file restored to f5b01574 with the test kept → red (above); fix restored → green |
| gofmt -l (changed files) | prints nothing |
| go vet ./... | exit 0 (a cgo warning in internal/gui is on the baseline too) |
| GOOS=linux GOARCH=amd64 go vet -tags nogui ./... | exit 0 |
| GOOS=windows GOARCH=amd64 go vet ./... | exit 0 |
| GOOS=linux GOARCH=amd64 go vet ./... | fails inside wails v3 beta (`undefined: pointer`), red on the baseline too |
| go build (darwin/arm64 native) | ok |
| GOOS=windows GOARCH=amd64 go build | ok |
| GOOS=linux GOARCH=amd64 go build -tags nogui | ok |
| GOOS=linux/darwin GOARCH=amd64 go build | fails inside wails v3 beta, red on the baseline too |

## Not verified

- Not tried against Google's real endpoint
  (`generativelanguage.googleapis.com/v1beta/openai`): no key here. What the
  fix changes is what magpie puts on the wire, and the test asserts that
  directly; the reporter's 400 names the very field the fix drops.
- `keep_alive`, another Ollama-only field, is not stripped: nothing in the
  report says a client sends it on this route. If one surfaces, it is the
  same one-line drop.
- The issue's other suggestions — a marker in `/api/show`'s Ollama-shaped
  answer, and a strip-and-retry when an upstream refuses an unknown field —
  are not part of this change.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt58-b-3097](https://github.com/ggbdpq/magpie/tree/hunt58-b-3097) (head `e5b407b81ca089b9999efe382777eda7e62a4c39`).

<details><summary>patch: gateway: a Chat body relayed to Gemini's OpenAI-compatible API goes without Ollama's options (#3097) — git am applies it as is; SHA-256 first 16: 84cb047a204b1581</summary>

```
From e5b407b81ca089b9999efe382777eda7e62a4c39 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 23:28:30 +0800
Subject: [PATCH] gateway: a Chat body relayed to Gemini's OpenAI-compatible
 API goes without Ollama's options (#3097)

What changed: a client that takes the gateway for an Ollama server (its
/api/show is answered in Ollama's shape) sends Ollama's per-request
options beside its Chat fields. The google preset serves a model on
Gemini's OpenAI-compatible endpoint, so such a request is relayed as it
came, and that endpoint reads proto JSON: an unknown name turns the
whole request away with 400 "Invalid JSON payload received. Unknown
name \"options\": Cannot find field", every call, whatever the effort.
A body relayed to a Gemini OpenAI-compatible upstream (geminiCompat)
now goes without the top-level options, whose runner settings have no
place on a Chat API, as the Ollama route's own body builder already
leaves them out (ollamaChatBody). Another vendor's Chat upstream still
gets the body as the client sent it, and translated requests are
unchanged: they are built from the request's own fields, which never
carried options. geminiCompat is worked out once where the thought
signatures ask for it too.

Run: TestGeminiCompatRelayLeavesOutOllamaOptions fails on the old code
with "Ollama's options reached Gemini's OpenAI-compatible API" and
passes with the change; a request to another vendor's Chat upstream
still carries options there. go test ./internal/gateway/ ok (346.6s);
go test ./... -timeout 45m: 66 packages ok, internal/agent TestMothX
and internal/gui TestProxyCheckSaysAProxyPassedBy red, both red with
the change stashed on f5b01574 too (this machine's, not this change's);
gofmt -l clean; go vet ./... exits 0 (a cgo warning in internal/gui is
the baseline's); GOOS=linux GOARCH=amd64 go vet -tags nogui ./... and
GOOS=windows GOARCH=amd64 go vet ./... clean (GOOS=linux/darwin vet of
the gui fails in wails v3 beta on the baseline too); go build (darwin
arm64), GOOS=windows GOARCH=amd64 and GOOS=linux GOARCH=amd64
-tags nogui builds ok (a plain GOOS=linux/darwin build fails inside
wails v3 beta on the baseline too). Not tried against Google's real
endpoint: the reporter's 400 names the unknown field, and the fake
upstream checks what it is sent.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md         |  1 +
 internal/gateway/gateway.go                | 13 ++++-
 internal/gateway/gemini_compat_cut_test.go | 63 ++++++++++++++++++++++
 3 files changed, 76 insertions(+), 1 deletion(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index e9e11d17..3c51b706 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -154,6 +154,7 @@ recorded as a prediction failure (`noPrediction`).
 - A Chat upstream that wants a turn's reasoning back (`chatReplaysReasoning` in [`chat.go`](../../internal/gateway/chat.go): a host or a model, as magpie or the provider names it, with `deepseek` in it, such as OpenCode Go's `deepseek-v4.1-flash`, or Command Code's plugin) gets every assistant tool call with `reasoning_content`, relayed (`withReasoningOnToolTurns` in `passthrough`) or translated (`buildChat`). DeepSeek turns the whole request away ("The `reasoning_content` in the thinking mode must be passed back to the API") when a tool call made since the user's last message has none, which a client sends for a turn it saw no thinking on: another model's, a translated one (#1462). The turn's own thinking goes back as it came; one sent in `reasoning` or `reasoning_details` is copied in; otherwise it goes with a space (`noReasoning`: DeepSeek's Chat API takes an empty one, but a relay that leaves empty fields out would drop it). An assistant message right after a tool result, a reply with no call of its own, gets one too: DeepSeek refuses it the same way (checked 2026-10-12, #1822). A reply to the user, any other model and Mistral (#494) are sent as before.
 - An assistant turn the user cut off before it said anything (only its thinking, an empty text, nothing; an isolated Codex reasoning item; a Gemini thought alone) stays in the agent's history and is sent on every later turn. DeepSeek and Kimi turn the whole request away over an assistant message with neither content nor tool calls, `reasoning_content` alone included ("Invalid assistant message: content or tool_calls must be set", #2599). Every Chat upstream gets such a turn left out, translated (`buildChat`, before `pairToolMessages`) or relayed (`silentAssistantsOut` in `passthrough`), by one rule (`withoutSilentAssistants` in [`chat.go`](../../internal/gateway/chat.go)): the two user messages it stood between join into one, and after a tool result the user's message follows the tool message. A prefill to go on from (`prefix`, `partial`, a Resume), a legacy `function_call`, a refusal and an audio reply stay, and a relayed body without such a turn goes byte for byte. `TestChatEmptyAssistantLeftOutFromAnthropic`, `…FromResponses`, `…FromGemini`, `TestChatRelayLeavesOutEmptyAssistant`, `TestChatRelaySilentAssistantsOnly`.
 - Kimi's Chat API (`isKimi`: the Kimi platform's and a Kimi Code membership's hosts or presets) turns `reasoning_details` in a message away in any shape: an entry with a stream's `index` ("the reasoning_details at position 1 entry 0 must not contain streaming index") and any other entry ("… has an invalid type"), checked against api.kimi.com/coding on 2026-10-12. pi keeps another vendor's thinking there (MiMo's, through Command Code, with `index: 0`), so a conversation routed on to Kimi was refused on every turn (#1765). `passthrough` sends it to Kimi as `reasoning_content` (`reasoningDetailsAsContent`), which Kimi takes; a message with `reasoning_content` of its own keeps that. Another upstream that refuses a thinking field "at position N", as Kimi words it (a relay in front of it), is asked once more the same way and marked (`refusedInMessages`, `withoutMessageReasoning`).
+- A client that took the gateway for an Ollama server (its `/api/show` is answered in Ollama's shape) sends Ollama's per-request `options` beside its Chat fields. Gemini's OpenAI-compatible API (`geminiCompat`: AI Studio's, or a local proxy in front of it) reads proto JSON and turns the whole request away over a name it doesn't know (#3097), so a body relayed to one goes without `options`, whose runner settings have no place on a Chat API, as the Ollama route's own body builder leaves them out (`ollamaChatBody`). Another vendor's Chat upstream gets `options` as the client sent it. `TestGeminiCompatRelayLeavesOutOllamaOptions`.
 - Claude Code's deferred tools (ToolSearch, MCP tools that come and go) put blocks of their own in a message: a `tool_addition` (`tool` a `tool_reference` naming the tool, or a `tool_definition`), a `tool_removal`, and a `tool_reference`. Kimi's Anthropic endpoint refuses any of them with a whole-request 400 "Invalid request Error" that names nothing, so once a session had loaded a tool every turn failed (#2042); DeepSeek's takes a `tool_addition` naming a tool but refuses one defining it, a `tool_removal` and a message's `tool_reference` with 422 "unknown variant `tool_removal`" (both checked against the real endpoints on 2026-10-14). OpenCode Go also rejects DeepSeek inline definitions with a generic 422 "Upstream request failed: Endpoint is unavailable." (checked on 2026-10-15). Kimi and DeepSeek models on OpenCode are never sent these blocks (`forwardOnce`); a provider that refuses one in those words is asked again at once without them and not sent them again while magpie runs (`refuseShapes`, `shapeDeferred`; the retry loop reads a 422 as well as a 400). `withoutDeferredTools` drops the blocks and a message they leave empty; definitions present only in a `tool_addition.tool.definition` join the request's `tools` once by name (an existing top-level definition wins), and a `tool_reference` inside a `tool_result` (ToolSearch's answer, which both take) stays. Any other provider is sent them as Claude Code wrote them ([`anthropic_shapes.go`](../../internal/gateway/anthropic_shapes.go), `TestKimiIsSentNoDeferredToolBlocks`, `TestDeferredToolBlocksRefusedOnceLeftOut`, `TestOpenCodeDeepSeekInlineTools`, `TestDeferredInlineDefinitionPreserved`).
 - ToolSearch's answer is a `tool_result` whose content is `tool_reference` blocks alone. OpenDesign's Anthropic endpoint can't read one: 422 "Failed to deserialize the JSON body into the target type: messages[4]: missing field `content`" (#2124, the reporter's direct request without magpie fails the same way; the same result with a text block beside the references is taken). A provider that refuses in those words while the request holds such a result is asked again at once with a text block first in each, "Tool <name> is loaded and can be called now." (`toolLoadedText`, the words a translated route already gives a model in `stringOrText`), the references and the `tool_use`/`tool_result` pairing kept, and is sent it that way while magpie runs (`refuseShapes`, `shapeRefsOnly`, `withRefsSaid`). This is in `forward`, so `/v1/messages`, `count_tokens` and a group's member all get it; a request translated to another API already carries the references as that text. Any other provider is sent the bare references (`TestRefsOnlyToolResultRefusedGetsText`, `TestRefsSaidLeavesOtherResults`).
 - A tool Claude Code's ToolSearch loads, translated to a Responses API, used to join the top-level `tools` on the next request, which changed the prompt from its first bytes and missed the cache on every load (#2660). A deferred tool (`defer_loading`, `Tool.Deferred`) that a `tool_result`'s `tool_reference` names (`toolRefs`, `Part.Loads`) now goes, where `Request.LoadedInPlace` is set, in an `{"type":"additional_tools","role":"developer","tools":[…]}` item right after the run of tool outputs that loaded it, once, and not in `tools` (`buildResponses`): tools loaded by parallel results or one result naming several share one item, a tool named again isn't repeated, and the tool output's text is as before. OpenAI's tool search guide documents the item and that its tools load at the end of the context so the cache is kept. A compacted or edited history whose loading result is gone puts the tool back in `tools`, a new prefix, as is expected. `LoadedInPlace` is set (`loadsInPlace`, in `forwardTranslated`) for OpenAI's own API with a key (`api.openai.com`, `*.api.openai.com`) and for a provider set `additionalTools` (`magpie provider set <id> additional-tools=on`); nothing else, since xAI answers the item 422 (#350), the ChatGPT backend has been seen to take it only for Codex's Responses Lite, and no relay or plugin's vendor has been tried. An upstream that refuses a request holding the item with a 400 or 422 naming `additional_tools` is asked again with every tool in `tools`, logged ("turned away additional_tools … loaded tools go in tools from now on") and not sent the item again while magpie runs. Not handled: a tool a `tool_addition` block loads (an MCP server's late tool, the advisor) stays in `tools`. `TestLoadedToolsKeepThePrefix`, `TestLoadedToolsInOneItem`, `TestLoadedToolsWhereNotTaken`, `TestLoadsInPlaceScope`, `TestLoadedToolsThroughTheGateway`.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f315b819..d2dc1624 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4255,10 +4255,21 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			// turns the whole request away for (#1462)
 			body = withReasoningOnToolTurns(body)
 		}
+		compat := geminiCompat(p.Host(), model)
+		if compat {
+			// a client that took the gateway for an Ollama server (its
+			// /api/show is answered in Ollama's shape) sends Ollama's
+			// per-request options beside its Chat fields. Gemini's
+			// OpenAI-compatible API reads proto JSON and turns the whole
+			// request away over a name it doesn't know (#3097), and the
+			// runner settings in options have no place on a Chat API, as
+			// the Ollama route's own body builder judges (ollamaChatBody)
+			body = withoutFields(body, "options")
+		}
 		// Gemini's thought signatures, which came to the client in its
 		// calls' ids, go back where Gemini wants them; another upstream
 		// gets the calls' own ids (#687)
-		body = chatCallSignatures(body, geminiCompat(p.Host(), model))
+		body = chatCallSignatures(body, compat)
 		if p.Preset == "mistral" || p.Host() == "api.mistral.ai" {
 			// an earlier turn's reasoning_content, which Mistral turns
 			// away, as the thinking part it takes (#494)
diff --git a/internal/gateway/gemini_compat_cut_test.go b/internal/gateway/gemini_compat_cut_test.go
index 9a785fc4..abc53abc 100644
--- a/internal/gateway/gemini_compat_cut_test.go
+++ b/internal/gateway/gemini_compat_cut_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"encoding/json"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -157,3 +158,65 @@ func TestGeminiCompatFinishAfterPartialLine(t *testing.T) {
 		t.Errorf("the finish_reason began inside the line still pending: %q", body)
 	}
 }
+
+// A client that took the gateway for an Ollama server (its /api/show is
+// answered in Ollama's shape) sends Ollama's per-request options beside
+// its Chat fields. Gemini's OpenAI-compatible API reads proto JSON and
+// turns the whole request away over a name it doesn't know (#3097), so a
+// body relayed to one goes without options; another vendor's gets it as
+// the client sent it.
+func TestGeminiCompatRelayLeavesOutOllamaOptions(t *testing.T) {
+	// a whole text reply, as Gemini's OpenAI-compatible API streams one
+	hi := `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hi there"}}],"model":"models/gemini-3.8-flash","object":"chat.completion.chunk"}` + "\n\n"
+	whole := hi + compatStop + compatDone
+	ask := func(model string) string {
+		return `{"model":"` + model + `","stream":true,"messages":[{"role":"user","content":"hi"}],"max_tokens":8,"options":{"num_ctx":1048576}}`
+	}
+	// served saves the provider (Chat at base) and hands back what its
+	// upstream is sent, readable once the call has come back
+	served := func(t *testing.T, id, model, base string) func() []byte {
+		t.Helper()
+		fresh(t)
+		var got []byte
+		up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+			got, _ = io.ReadAll(r.Body)
+			w.Header().Set("Content-Type", "text/event-stream")
+			io.WriteString(w, whole)
+		}))
+		t.Cleanup(up.Close)
+		if err := provider.Save(provider.Provider{ID: id, Name: "UP", Key: "k", Models: []string{model}, Chat: up.URL + base}); err != nil {
+			t.Fatal(err)
+		}
+		return func() []byte { return got }
+	}
+
+	// as the google preset serves Gemini: an OpenAI-compatible Chat
+	// endpoint under generativelanguage.googleapis.com/v1beta/openai,
+	// stood in for by this machine's own address, where a Gemini model's
+	// Chat API is taken for Gemini's OpenAI-compatible one (geminiCompat)
+	read := served(t, "google", "models/gemini-3.8-flash", "/v1beta/openai")
+	code, body := post(t, "/v1/chat/completions", ask("google/models/gemini-3.8-flash"))
+	if code != 200 || !strings.Contains(body, `"content":"hi there"`) {
+		t.Fatalf("status %d: %s", code, body)
+	}
+	var sent map[string]json.RawMessage
+	if err := json.Unmarshal(read(), &sent); err != nil {
+		t.Fatalf("the upstream was sent %s", read())
+	}
+	if _, ok := sent["options"]; ok {
+		t.Errorf("Ollama's options reached Gemini's OpenAI-compatible API: %s", read())
+	}
+	if !strings.Contains(string(sent["messages"]), `"hi"`) || string(sent["max_tokens"]) != "8" {
+		t.Errorf("the rest of the request didn't go as asked: %s", read())
+	}
+
+	// another vendor's Chat upstream, no Gemini model there: the body goes
+	// as the client sent it
+	read = served(t, "km", "kimi-k3", "/v1")
+	if code, body := post(t, "/v1/chat/completions", ask("km/kimi-k3")); code != 200 || !strings.Contains(body, `"content":"hi there"`) {
+		t.Fatalf("another vendor: %d %s", code, body)
+	}
+	if !strings.Contains(string(read()), `"options":{"num_ctx":1048576}`) {
+		t.Errorf("another vendor's Chat upstream lost the client's options: %s", read())
+	}
+}
-- 
2.50.1 (Apple Git-155)
```
</details>
