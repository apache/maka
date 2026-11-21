## Source & environment

From #3152 (1024MrL, 2026-10-21): Codex 0.163.0-alpha.11 against magpie 0.1.1307's gateway (`wire_api=responses`), model `opencode-go/muse-spark-1.3-contributor`. Every `tool_search` call failed before it ran when the model wrote `limit` as a whole float (`{"query": "exa web search", "limit": 8.0}`): Codex's log says `failed to parse tool_search arguments: invalid number`, then `Tool search output is missing for call id: …`, and the UI shows `No tools matched the search`, so the exa and firecrawl tools stayed undiscoverable. The same class for other numeric arguments: `floating point `25000.0`, expected u64`, `floating point `73472.0`, expected i32`. Asking again with the `limit` left out worked at once and both searches returned results — the reporter's proof that the MCP servers were fine.

## Minimal repro

A client that parses its tool arguments strictly (Codex reads `tool_search`'s `limit`, `exec_command`'s `yield_time_ms`/`max_output_tokens`, `write_stdin`'s `session_id` as u64/usize/i32 though its own schemas say `number`) behind magpie, on a model that writes a whole number with a fraction of zeros:

- the model calls `tool_search` with `{"query": "exa web search", "limit": 8.0}` — Codex turns the call away, the turn never searches;
- the model calls it with `{"query": "exa web search"}` — the tools come back.

## Root cause

A Responses tool call's arguments travel as a JSON string, and magpie relays that string byte for byte — nothing on the way decodes and re-encodes it. The rewrite that fixes exactly this has existed since #1431 (`grok_integral.go`): `wholeNums` scans a call's arguments as a stream of text and drops a fraction of zeros with no exponent (`2500.0` to `2500`, `-3.00` to `-3`), leaving strings, keys, other fractions (`2.5`, `2.50`) and exponents (`2.5e3`) as written, the same whole or cut into deltas anywhere. But it was installed only when the model was Grok's:

1. relayed replies got `intTidy` in `passthrough` only for `grokModel(model) || grokModel(upstream)`;
2. translated replies got `wholeEncoder`/`wholeResult` only when `translate` had set `Request.Grok` from `grokServed`.

muse-spark is nobody's Grok, so its `8.0` reached Codex as written. #1431's own rationale — JSON has one kind of number, `2500` is the same value as `2500.0` to every client, and one that took `2500.0` takes `2500` — never depended on the model; the assumption only Grok writes whole floats is what #3152 falsifies. The response-side half of the fix the report points at (CLIProxyAPI#6255) is the same shape: canonicalize integral float literals in emitted tool-call arguments, leave everything else untouched. This change is that half only; the request-side schema rewrite the report also proposes is left alone.

## Fix

- `internal/gateway/gateway.go`: `passthrough` installs `intTidy` for every Responses, Chat and Messages reply (the protocol gate stays); `translate` no longer sets `Request.Grok`; `encoder` wraps every reply in `wholeEncoder` (still outside `usageEncoder`, which reads its encoder's reply id) and `render` runs `wholeResult` unconditionally.
- `internal/gateway/ir.go`: `Request.Grok` is gone, and `grokServed` with it — they named a model match that no longer decides anything. `grokModel` stays: grok_schema.go's pattern rewrite is Grok's schema quirk alone (that one is request-side and not touched).
- `docs/subsystems/gateway-routing.md`: the paragraph says every model, not Grok's.
- `internal/gateway/grok_integral_test.go`: `TestOnlyGrokCallsGetIntegers` held the old scoping ("another vendor's model is relayed byte for byte"); it is `TestOtherModelsCallsGetCodexIntegers` now and holds the new one — gpt-5.5's calls reach Responses, Chat and Messages clients, relayed and translated, with integers, deltas and done alike, over every case in `integralCases`, the edges case among them, so `2500.5`, `2.50`, `2.5e3`, `1.0e3` and the string `"4000.0"` stay as written. `TestToolSearchWholeFloatLimitGivesCodexIntegers` is the report's own shape: `muse-spark-1.3-contributor`'s `tool_search` `{"query":"exa web search","limit":8.0}` relayed on Responses, streamed in one-byte deltas or whole, and the client reads `8`. `TestGrokCallsByUpstreamName` is gone: which name the model goes upstream under no longer decides anything.
- Siblings checked, unchanged: Gemini tool calls carry their arguments as a JSON object, not an arguments string, so `intTidy` has no Gemini case and none is added (no report of the shape there); the gathered route (a whole-body client of a plugin account) is rewritten by the same `passthrough` chain, `w` being its buffer; the Claude subscription's re-encoded replies go through the same `encoder()`. The hot path is what #1431 already paid for all Grok traffic, now on every traffic: per streamed chunk one append into `intTidy`'s buffer, a last-newline search and one marker scan (`function_call`, `"tool_calls"`, `tool_use`); lines without the marker pass as they came, and no JSON is decoded unless the marker is there.

## Verification

| Check | Command | Result |
|---|---|---|
| New tests, base commit | both product sides back at `f5b015742`, tests kept, `go test -tags nogui -run 'TestToolSearchWholeFloatLimitGivesCodexIntegers|TestOtherModelsCallsGetCodexIntegers' ./internal/gateway/` | FAIL: `deltas: limit is 8.0 in {"query":"exa web search","limit":8.0}, want 8` and `deltas: yield_time_ms is 2500.0 in {"cmd":…,"yield_time_ms":2500.0,"max_output_tokens":4000.0}, want 2500` |
| New tests, fixed | same command with the change restored | ok |
| Owning package | `go test -tags nogui ./internal/gateway/` (in the full run) | ok, 558.4s |
| Race | `go test -tags nogui -race -count=2` over the targeted set (wholeNums, Grok relayed/translated/plugin, other models, tool_search) | ok, 14.3s |
| gofmt | `gofmt -l` on the changed files | clean |
| go vet | host `go vet -tags nogui ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | clean (the host run keeps gui's pre-existing cgo `-Wenum-conversion` warning, with the change reverted too) |
| Builds | `go build .`; `GOOS=linux go build -tags nogui .`; `GOOS=windows go build -tags nogui .` | ok on all three |
| Full suite | `go test -tags nogui ./...` under a temp HOME with Go's caches pinned | `internal/gateway` ok; two FAILs, `TestMothX` (internal/agent) and `TestProxyCheckSaysAProxyPassedBy` (internal/gui), both failing the same with all five files back at `f5b015742` on this machine — not from this change |
| git am | fresh clone at `f5b015742`, `git am` of the patch below | applies as is, head is this commit |

## Not verified

- No real muse-spark turn and no real Codex run: the reporter's `logs_2.sqlite` lines and their omitting-limit retry stand in for both ends, and the tests hold magpie's side of the wire against fake upstreams built in the shape the report describes.
- The gathered route (a client that asked for one body, of an account that only streams) has no non-Grok test of its own; it is covered by the same `intTidy` chain the relayed tests exercise, `w` being the gather buffer.
- Gemini is untouched by design (its tool-call arguments are an object, not a string); no report of whole floats on a Gemini route was seen.

Branch with the commit: [hunt58-h-3152-whole-float](https://github.com/ggbdpq/magpie/tree/hunt58-h-3152-whole-float) (head `4c03aaacdf0fe0cccab5000e9bdacecc82371f3e`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: any model's 2500.0 in a call's arguments reaches the agent as 2500, not only Grok's (#3152) — git am applies it as is; SHA-256 first 16: 49c6f34623b3012f</summary>

```patch
From 4c03aaacdf0fe0cccab5000e9bdacecc82371f3e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 00:31:55 +0800
Subject: [PATCH] gateway: any model's 2500.0 in a call's arguments reaches the
 agent as 2500, not only Grok's (#3152)

Models other than Grok's write whole floats into tool-call arguments too:
muse-spark, served through the gateway by the opencode-go plugin, wrote
tool_search's limit as 8.0, and Codex turned every call away before it ran
("failed to parse tool_search arguments: invalid number"; the reporter's
omitting-limit retry is what proves the MCP servers were fine). The same
class showed as "floating point `25000.0`, expected u64" and "floating
point `73472.0`, expected i32" for other numeric arguments.

The rewrite that fixes this has existed since #1431 (grok_integral.go):
wholeNums scans a call's arguments as a stream of text and drops a
fraction of zeros with no exponent (2500.0 to 2500, -3.00 to -3), leaving
strings, keys, other fractions (2.5, 2.50) and exponents (2.5e3) as
written, the same whole or cut into deltas anywhere. But it was installed
only when the model was Grok's: relayed replies got intTidy only for
grokModel(model) || grokModel(upstream), and translated replies only when
translate had set Request.Grok from grokServed. #3152 falsifies that
assumption: a model nobody calls Grok writes whole floats.

What changed:
- passthrough installs intTidy for every Responses, Chat and Messages
  reply (the protocol gate stays; Gemini has no arguments string to scan).
- translate no longer sets Request.Grok; encoder wraps every reply in
  wholeEncoder (still outside usageEncoder) and render runs wholeResult
  unconditionally. Request.Grok and grokServed are gone: they named a
  model match that no longer decides anything.
- grokModel stays for grok_schema.go, whose pattern rewrite is Grok's
  schema quirk alone.
- gateway-routing.md says every model, not Grok's.
- TestOnlyGrokCallsGetIntegers held the old scoping ("any other model's
  reply is relayed byte for byte"); it is TestOtherModelsCallsGetCodexIntegers
  now and holds the new one: gpt-5.5's calls reach Responses, Chat and
  Messages clients, relayed and translated, with integers, deltas and done
  alike, over every case in integralCases - the edges case among them, so
  2500.5, 2.50, 2.5e3, 1.0e3 and the string "4000.0" stay as written.
  TestGrokCallsByUpstreamName is gone: which name the model goes upstream
  under no longer decides anything. TestToolSearchWholeFloatLimitGivesCodexIntegers
  is the report's own shape: muse-spark-1.3-contributor's tool_search
  {"query":"exa web search","limit":8.0} relayed on Responses, the client
  reads 8.

Hot path: a relayed stream pays one append into intTidy's buffer, a
last-newline search and one bytes.Contains marker scan (function_call,
"tool_calls", tool_use) per chunk; lines without the marker pass as they
came and no JSON is decoded unless the marker is there. A translated reply
pays wholeArgs' strings.Contains(".") fast path per call. This is the cost
#1431 already accepted for all Grok traffic, now on every traffic.

What a client reads changes only where the model wrote a whole number with
a fraction of zeros, and there the bytes change from 8.0 to 8, the same
JSON number: one that took 8.0 takes 8. Everything else is byte for byte.

Run: with the product files back at f5b015742 and the tests kept,
TestToolSearchWholeFloatLimitGivesCodexIntegers fails "deltas: limit is
8.0 in {\"query\":\"exa web search\",\"limit\":8.0}, want 8" and
TestOtherModelsCallsGetCodexIntegers fails "deltas: yield_time_ms is
2500.0 ..., want 2500"; with the change restored both pass. gofmt -l on
the changed files prints nothing; go vet -tags nogui ./... on darwin,
GOOS=linux and GOOS=windows; go build and GOOS=linux/GOOS=windows -tags
nogui builds; go test -tags nogui ./... under a temp HOME; -race -count=2
on the targeted tests.

Not verified: a real muse-spark turn or a real Codex run (the reporter's
logs_2.sqlite rows stand in); the gathered route (a whole-body client of a
plugin account) is covered by the same passthrough chain but has no
non-Grok test of its own.

Fixes #3152

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md     |   2 +-
 internal/gateway/gateway.go            |  26 ++---
 internal/gateway/grok_integral.go      |  61 ++++++------
 internal/gateway/grok_integral_test.go | 126 ++++++++++++++-----------
 internal/gateway/ir.go                 |   4 -
 5 files changed, 110 insertions(+), 109 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index e9e11d17..c917da13 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -159,7 +159,7 @@ recorded as a prediction failure (`noPrediction`).
 - A tool Claude Code's ToolSearch loads, translated to a Responses API, used to join the top-level `tools` on the next request, which changed the prompt from its first bytes and missed the cache on every load (#2660). A deferred tool (`defer_loading`, `Tool.Deferred`) that a `tool_result`'s `tool_reference` names (`toolRefs`, `Part.Loads`) now goes, where `Request.LoadedInPlace` is set, in an `{"type":"additional_tools","role":"developer","tools":[…]}` item right after the run of tool outputs that loaded it, once, and not in `tools` (`buildResponses`): tools loaded by parallel results or one result naming several share one item, a tool named again isn't repeated, and the tool output's text is as before. OpenAI's tool search guide documents the item and that its tools load at the end of the context so the cache is kept. A compacted or edited history whose loading result is gone puts the tool back in `tools`, a new prefix, as is expected. `LoadedInPlace` is set (`loadsInPlace`, in `forwardTranslated`) for OpenAI's own API with a key (`api.openai.com`, `*.api.openai.com`) and for a provider set `additionalTools` (`magpie provider set <id> additional-tools=on`); nothing else, since xAI answers the item 422 (#350), the ChatGPT backend has been seen to take it only for Codex's Responses Lite, and no relay or plugin's vendor has been tried. An upstream that refuses a request holding the item with a 400 or 422 naming `additional_tools` is asked again with every tool in `tools`, logged ("turned away additional_tools … loaded tools go in tools from now on") and not sent the item again while magpie runs. Not handled: a tool a `tool_addition` block loads (an MCP server's late tool, the advisor) stays in `tools`. `TestLoadedToolsKeepThePrefix`, `TestLoadedToolsInOneItem`, `TestLoadedToolsWhereNotTaken`, `TestLoadsInPlaceScope`, `TestLoadedToolsThroughTheGateway`.
 - A Responses upstream that wants a turn's reasoning back (`replaysReasoning` in [`responses.go`](../../internal/gateway/responses.go): a model with `deepseek` in its name, on any host but OpenAI's, xAI's, Copilot's and Azure's) gets every reasoning item with a `reasoning_text` and every tool call after one, relayed (`withReasoningText` in `passthrough`) or translated (`buildResponses`). DeepSeek's `/v1/responses` turns the whole request away ("The `reasoning_text` in the thinking mode must be passed back to the API") over a reasoning item without text, one with an empty text, and a `function_call` whose step (since the last user message or tool output) has no reasoning item. Codex sends all three in a routing group that falls to DeepSeek after ChatGPT: the backend's sealed items (`encrypted_content` only), magpie's summary-only items, and another member's calls with none (#1104, #1592). DeepSeek reads a step (a run of reasoning, assistant messages and calls) as one assistant message whose thinking is the item it starts with: in the current turn, a step with a call or after a tool output must lead with a reasoning item, so [message, reasoning, call] and [output, message] are refused while [reasoning, message, call] and [output, reasoning, message] are taken (checked against api.deepseek.com on 2026-10-12). Codex sends a step that said something before its call with no reasoning for another model's turn, which magpie used to send [message, reasoning " ", call] and DeepSeek refused intermittently, only while the turn lasted (#1822, through OpenCode Go). An item's own text is kept; one without gets its summary, else a space (`noReasoning`); each such step leads with its reasoning (`reasonFirst`): its own first reasoning item moved ahead, else one holding a space. A sealed item keeps its id and `encrypted_content`; a body already in that shape goes byte for byte.
 - A Messages upstream that wants a turn's thinking back (`anthropicReplaysThinking` in [`anthropic.go`](../../internal/gateway/anthropic.go): a host or a model with `deepseek` in it, never `api.anthropic.com` or a Claude model) gets a thinking block on every assistant message with a `tool_use` or right after tool results alone (refused the same way, checked 2026-10-12, #1822), relayed (`withThinkingOnToolTurns` in `passthrough`) or translated (`build`, which also keeps unsigned thinking as its text there). DeepSeek's `/anthropic/v1/messages`, thinking (its default, or asked for), turns the whole request away with 400 "The `content[].thinking` in the thinking mode must be passed back to the API" when such a message has none, and answers any `redacted_thinking` with 422, a block it can't read. Claude Code sends both in a routing group that falls to DeepSeek after Claude (#1611). A message with no thinking gets one holding a space (`noReasoning`) first; Claude's `redacted_thinking` becomes that block, or is left out beside thinking of the message's own. Signed thinking, DeepSeek's own and every other message go as they came. Checked against the real endpoint on 2026-10-11: it takes Claude's signed thinking, unsigned thinking and a space, anywhere in the message.
-- A Grok model writes a whole number in a call's arguments with a fraction of zeros (`2500.0`, `17277.0`), whoever serves it: the Grok subscription or its plugin, xAI, OpenRouter or a relay. Codex reads its integer fields as u64, usize or i32 even though their schemas say `number`, so serde turns away the whole call (#1431). In a reply to a request whose model, as magpie names it or as it is sent upstream, has a last `/` segment beginning with `grok` (`grokModel`, `grokServed`), every number in a call's arguments written with a fraction of zeros and no exponent loses the fraction: `2500.0` becomes `2500`, `-3.00` becomes `-3`. Strings, keys, other fractions (`2.5`, `2.50`) and exponents (`1.0e3`) stay as written. No tool schema is consulted, since JSON has one number type. The rule runs over the arguments as a stream of text (`wholeNums`), holding back only a fraction of zeros until the next byte. This gives the same arguments whether they come whole or in deltas cut anywhere, so what a call's deltas add up to is what its done events say. Relayed replies are rewritten in `passthrough` by `intTidy`: Responses' function_call items, argument deltas and done events and the completed response; Chat's `tool_calls` deltas and messages; Messages' `tool_use` input and `input_json_delta`, streamed or whole. Translated replies are rewritten at the encoder (`wholeEncoder`, outside `usageEncoder`) and at `render` (`wholeResult`) when `Request.Grok` is set. Any other model's reply is relayed byte for byte ([`grok_integral.go`](../../internal/gateway/grok_integral.go)).
+- A model writes a whole number in a call's arguments with a fraction of zeros (`2500.0`, `17277.0`, tool_search's `limit: 8.0`): Grok's on every turn, whoever serves it (#1431), and muse-spark through the gateway (#3152). Codex reads the integer fields it parses as u64, usize or i32 even though their schemas say `number`, so serde turns away the whole call ("invalid number" for tool_search's arguments). In every reply, every number in a call's arguments written with a fraction of zeros and no exponent loses the fraction: `2500.0` becomes `2500`, `-3.00` becomes `-3`. Strings, keys, other fractions (`2.5`, `2.50`) and exponents (`1.0e3`) stay as written. No tool schema is consulted, since JSON has one number type and one that took `2500.0` takes `2500`. The rule runs over the arguments as a stream of text (`wholeNums`), holding back only a fraction of zeros until the next byte. This gives the same arguments whether they come whole or in deltas cut anywhere, so what a call's deltas add up to is what its done events say. Relayed replies are rewritten in `passthrough` by `intTidy`: Responses' function_call items, argument deltas and done events and the completed response; Chat's `tool_calls` deltas and messages; Messages' `tool_use` input and `input_json_delta`, streamed or whole. Translated replies are rewritten at the encoder (`wholeEncoder`, outside `usageEncoder`) and at `render` (`wholeResult`). Grok's schema quirks stay `grokModel`'s ([`grok_integral.go`](../../internal/gateway/grok_integral.go)).
 - A tool call a model writes into its reply's text, when the request offered tools, is made the call it is ([`textcalls.go`](../../internal/gateway/textcalls.go), #823): Hermes' `<tool_call>{…}</tool_call>`, DeepSeek's DSML (`<｜DSML｜invoke name=…>` with its parameters; its mark found as the parse regexes read it, by `dsmlMark`, not from a list of spellings: any run of pipes, ASCII or full-width or mixed, spaces after `<` and around `/`, `<｜｜DSML｜｜` too, #2623), DeepSeek's half-Hermes `<parameter>` form (#917) and GLM's `<arg_key>`/`<arg_value>` (#906), read by `parseTextCalls`. Each block must name an offered tool and have arguments that can be read; else the text goes on as it came. The text before the first block is kept, what is left of the tags goes, and the reply ends as one that called tools (`finish_reason` `tool_calls`, `stop_reason` `tool_use`). A reply whose model made a call itself is left alone. Every route reads it the same way: a relayed Chat stream (`textCallTidy`), a relayed Chat reply that came whole, JSON or under `text/plain` or no type (`chatWhole` with `wholeTextCalls`, #1845: a `stream:false` request kept the markup and `finish_reason` `stop`), which also covers a vendor that answered a streamed request whole (`wholeAsStream`), and every translation, which magpie always asks streamed, a plugin's included, whatever the client asked (`textCallSee`). A relayed Responses or Messages upstream's text is not read for calls. Covered by `TestTextWritten*`, `TestGLMTextCall*`, `TestPluginTextWrittenCall` and `TestQuietWholeReplyStreamed`.
 - Structured output is carried across every translation (`Format`, [`format.go`](../../internal/gateway/format.go)). It is read from Responses' `text.format`, Chat's `response_format`, Anthropic's `output_config.format` and Gemini's `responseMimeType` with `responseJsonSchema`/`responseSchema`: `json_schema` with its name, description, schema and strict, or `json_object`. Each upstream is asked in its own field: `text.format` on Responses, `response_format` on Chat, `output_config.format` on Messages, and `generationConfig.responseMimeType`/`responseJsonSchema` on Gemini and Code Assist. An API with no name for it gets `response`. Messages and the Claude subscription's `--json-schema` take a schema only, so `json_object` is told in the system prompt there (`inSystem`). A 400 or 422 that names the field (`refusesFormat`: DeepSeek's "This response_format type is unavailable now", a schema Anthropic can't hold) marks the provider and model (`formatRefused`), and the request is asked again with the format told in the system prompt, as are later requests to that provider and model. A relayed request keeps its format as sent. A Gemini client's format is also still told in its system prompt, as before. A model may still wrap its JSON answer in a Markdown code fence; a client that asked for structured output, in a field or told in the system prompt (`wantsJSON`), gets the JSON inside a single unlabelled or json-labelled fence when that content is a complete valid JSON value, streamed (`fenceEncoder`) or whole (`unfencedResult`), in [`format_fence.go`](../../internal/gateway/format_fence.go). Invalid or truncated JSON, other fence languages, text outside the fence, and answers to plain-text clients reach the client as they came. This normalization applies to translated replies; native protocol passthrough stays byte-preserving.
 - A tool's images reach the model on every translation (`toolOutput` in [`ir.go`](../../internal/gateway/ir.go) reads them from Anthropic's `tool_result`, Responses' `function_call_output`, such as Codex's `view_image` output `[{"type":"input_image","image_url":"data:…"}]`, and a Chat tool message). Anthropic's Messages keeps them in the `tool_result`. Chat puts them in a user message right after the results, and the result says they follow; Gemini and Code Assist after the function's response. Kiro's results hold text alone, so Kiro's plugin (from 0.1.9 on) sends them with the message that answers the call, and only the latest images go again (#369, #1861). `TestCodexToolImageReachesAnthropicPlugin` and the Kiro plugin's `tool-images.test.mjs`.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f315b819..5ec08c91 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4707,10 +4707,10 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	if named != nil {
 		spaces = &nsTidy{named: named, sse: sse}
 	}
-	// a Grok model's 2500.0 in a call's arguments, which Codex turns away
-	// (grok_integral.go, #1431); any other model's reply goes as it came
+	// a model's 2500.0 in a call's arguments, which Codex turns away
+	// (grok_integral.go, #1431, #3152: Grok's models and muse-spark alike)
 	var ints *intTidy
-	if (proto == provider.Responses || proto == provider.Chat || proto == provider.Anthropic) && (grokModel(model) || grokModel(upstream)) {
+	if proto == provider.Responses || proto == provider.Chat || proto == provider.Anthropic {
 		ints = &intTidy{proto: proto, sse: sse}
 	}
 	// a message the upstream gave no phase gets one, as OpenAI's own
@@ -5819,9 +5819,9 @@ func (s *Server) translate(w http.ResponseWriter, r *http.Request, p provider.Pr
 	if err != nil {
 		return writeError(w, from, 400, err.Error()), err.Error()
 	}
-	// a Grok model's 2500.0 in a call's arguments, which Codex turns away
-	// (grok_integral.go, #1431)
-	request.Grok = grokServed(wiresOf(r.Context()), p, model)
+	// a model's 2500.0 in a call's arguments, which Codex turns away, is
+	// rewritten at the encoder and at render (grok_integral.go, #1431,
+	// #3152)
 	if from == provider.Anthropic {
 		// Claude Code's auto mode classifier, on a model that reasons
 		// whatever it is told (#250)
@@ -6208,10 +6208,10 @@ func encoder(proto provider.Protocol, w *sseWriter, r *Request, usage ...*Usage)
 	if len(usage) > 0 && usage[0] != nil {
 		enc = &usageEncoder{streamEncoder: enc, usage: usage[0]}
 	}
-	if r.Grok {
-		// outside usageEncoder, which reads its encoder's reply id
-		enc = &wholeEncoder{streamEncoder: enc}
-	}
+	// a model's whole floats in a call's arguments reach the client as
+	// integers (grok_integral.go, #1431, #3152), outside usageEncoder,
+	// which reads its encoder's reply id
+	enc = &wholeEncoder{streamEncoder: enc}
 	if r.wantsJSON() {
 		// a fenced JSON answer reaches a structured-output client as the
 		// JSON it asked for (format_fence.go)
@@ -6235,9 +6235,9 @@ func makeEncoder(proto provider.Protocol, w *sseWriter, r *Request) streamEncode
 
 func render(proto provider.Protocol, res Result, r *Request) []byte {
 	model := r.Model
-	if r.Grok {
-		res = wholeResult(res)
-	}
+	// a model's whole floats in a call's arguments reach the client as
+	// integers (grok_integral.go, #1431, #3152)
+	res = wholeResult(res)
 	res = unfencedResult(res, r)
 	switch proto {
 	case provider.Chat:
diff --git a/internal/gateway/grok_integral.go b/internal/gateway/grok_integral.go
index da0d4b17..afc1373f 100644
--- a/internal/gateway/grok_integral.go
+++ b/internal/gateway/grok_integral.go
@@ -9,24 +9,23 @@ import (
 	"github.com/yetone/magpie/internal/provider"
 )
 
-// Grok's models write a whole number in a tool call's arguments with a
-// fraction of zeros ("yield_time_ms":2500.0, "session_id":17277.0), whoever
-// serves them: a Grok subscription or its plugin, xAI's API, OpenRouter's
-// x-ai/grok-*, or a relay in front of any of them. Codex reads such fields
-// as u64, usize, i32 or i64 (exec_command, write_stdin, shell's timeout_ms,
-// sleep, tool_search's limit, wait), though their schemas say "number", and
-// serde turns the whole call away: "failed to parse function arguments:
-// invalid type: floating point `2500.0`, expected u64" (#1431, 11 of 11
-// turns on grok-4.6 and grok-4.7 through a relay). Any client that types
-// its arguments strictly does the same.
+// Models write a whole number in a tool call's arguments with a fraction
+// of zeros ("yield_time_ms":2500.0, "session_id":17277.0), whoever serves
+// them: Grok's do it on every turn (#1431, 11 of 11 turns on grok-4.6 and
+// grok-4.7 through a relay), and muse-spark wrote tool_search's limit as
+// 8.0 through the gateway (#3152). Codex reads such fields as u64, usize,
+// i32 or i64 (exec_command, write_stdin, shell's timeout_ms, sleep,
+// tool_search's limit, wait), though their schemas say "number", and serde
+// turns the whole call away: "failed to parse function arguments: invalid
+// type: floating point `2500.0`, expected u64". Any client that types its
+// arguments strictly does the same.
 //
-// In a reply from a Grok model, a number in a call's arguments written with
-// a fraction of zeros and no exponent loses that fraction: 2500.0 is
-// written 2500. JSON has one kind of number, so 2500 is the same value to
-// every client, and one that took 2500.0 takes 2500; a tool's schema isn't
-// asked, since Codex's own say "number" for the integers it reads. Strings,
-// keys, other fractions (2.5) and exponents (2.5e3) stay as written, and
-// so does every other model's reply.
+// In a reply, a number in a call's arguments written with a fraction of
+// zeros and no exponent loses that fraction: 2500.0 is written 2500. JSON
+// has one kind of number, so 2500 is the same value to every client, and
+// one that took 2500.0 takes 2500; a tool's schema isn't asked, since
+// Codex's own say "number" for the integers it reads. Strings, keys, other
+// fractions (2.5) and exponents (2.5e3) stay as written.
 //
 // The rule is applied to the arguments as a stream of text, so it gives
 // the same arguments whether they come whole or in deltas cut anywhere:
@@ -34,7 +33,8 @@ import (
 
 // grokModel is whether id, the model as magpie or its upstream names it, is
 // one of Grok's, under whatever vendor prefix a relay or router gives it
-// (xai/grok-4.5, x-ai/grok-4).
+// (xai/grok-4.5, x-ai/grok-4). Grok's schema quirks (grok_schema.go) are
+// still Grok's alone; whole floats in calls' arguments are every model's.
 func grokModel(id string) bool {
 	if i := strings.LastIndexByte(id, '/'); i >= 0 {
 		id = id[i+1:]
@@ -42,12 +42,6 @@ func grokModel(id string) bool {
 	return strings.HasPrefix(strings.ToLower(id), "grok")
 }
 
-// grokServed is whether a request for model on p goes to a Grok model,
-// by magpie's id for it or the name it is sent upstream under.
-func grokServed(wires map[string]string, p provider.Provider, model string) bool {
-	return grokModel(model) || grokModel(provider.UpstreamNameIn(wires, p.ID, model))
-}
-
 // wholeNums drops the zero fraction of each number in a stream of JSON
 // text, fed to it a piece at a time. It holds only a fraction of zeros
 // (".0", ".00") until it knows whether the number ends there, in which
@@ -119,8 +113,8 @@ func wholeArgs(s string) string {
 	return n.feed(s)
 }
 
-// wholeEncoder hands its encoder a Grok model's reply with the zero
-// fractions dropped from its calls' arguments, streamed in pieces.
+// wholeEncoder hands its encoder a reply with the zero fractions dropped
+// from its calls' arguments, streamed in pieces.
 type wholeEncoder struct {
 	streamEncoder
 	args wholeNums
@@ -138,8 +132,8 @@ func (e *wholeEncoder) event(ev Event) {
 	e.streamEncoder.event(ev)
 }
 
-// wholeResult is a whole reply from a Grok model with its calls'
-// arguments' zero fractions dropped.
+// wholeResult is a whole reply with its calls' arguments' zero fractions
+// dropped.
 func wholeResult(res Result) Result {
 	var parts []Part
 	for i, p := range res.Parts {
@@ -159,12 +153,11 @@ func wholeResult(res Result) Result {
 	return res
 }
 
-// intTidy drops, in a Grok model's reply relayed as it came, the zero
-// fractions of its calls' arguments: Responses' function_call items and
-// argument deltas, Chat's tool_calls, and Messages' tool_use input. A
-// stream's lines pass as they came unless one carries arguments that
-// change; a reply that isn't one is held whole and gone through at the
-// end.
+// intTidy drops, in a reply relayed as it came, the zero fractions of its
+// calls' arguments: Responses' function_call items and argument deltas,
+// Chat's tool_calls, and Messages' tool_use input. A stream's lines pass
+// as they came unless one carries arguments that change; a reply that
+// isn't one is held whole and gone through at the end.
 type intTidy struct {
 	proto provider.Protocol
 	sse   bool
diff --git a/internal/gateway/grok_integral_test.go b/internal/gateway/grok_integral_test.go
index eb4c3506..e59f9c69 100644
--- a/internal/gateway/grok_integral_test.go
+++ b/internal/gateway/grok_integral_test.go
@@ -2,7 +2,6 @@ package gateway
 
 import (
 	"bufio"
-	"bytes"
 	"encoding/json"
 	"io"
 	"net/http"
@@ -623,72 +622,85 @@ func TestGrokCallsGiveIntegersOnEveryProtocol(t *testing.T) {
 	}
 }
 
-// A model magpie names otherwise but sends upstream as a Grok model is
-// Grok's too.
-func TestGrokCallsByUpstreamName(t *testing.T) {
-	c := integralCases(t)[0]
-	fresh(t)
-	up := httptest.NewServer(responsesCall(c.tool, c.args, []string{c.args}))
-	defer up.Close()
-	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"x-ai/grok-4.6"}, Responses: up.URL + "/v1"}); err != nil {
-		t.Fatal(err)
-	}
-	for _, stream := range []bool{true, false} {
-		checkResponses(t, c, askGrok(t, "/v1/responses", codexShellTurn("relay/x-ai/grok-4.6", stream)), stream)
-	}
-}
+// Another vendor's model writes whole floats too (#3152: muse-spark's
+// tool_search limit 8.0, which Codex turns away as "invalid number"): a
+// model nobody calls Grok reaches the client with integers, relayed on
+// every protocol and translated from Chat, deltas and done alike. The
+// edges case in integralCases holds the look-alikes that stay as written:
+// 2500.5, 2.50, 2.5e3, 1.0e3, the string "4000.0".
+func TestOtherModelsCallsGetCodexIntegers(t *testing.T) {
+	for _, c := range integralCases(t) {
+		pieces := someCuts(c.args)["by byte"]
+		for _, stream := range []bool{true, false} {
+			for _, rc := range []struct {
+				path, body string
+				up         http.HandlerFunc
+				p          provider.Provider
+			}{
+				{"/v1/responses", codexShellTurn("relay/gpt-5.5", stream), responsesCall(c.tool, c.args, pieces), provider.Provider{Responses: "/v1"}},
+				{"/v1/chat/completions", chatShellTurn("relay/gpt-5.5", stream), chatCall(c.tool, c.args, pieces), provider.Provider{Chat: "/v1"}},
+				{"/v1/messages", messagesShellTurn("relay/gpt-5.5", stream), messagesCall(c.tool, c.args, pieces), provider.Provider{Anthropic: "/v1"}},
+			} {
+				fresh(t)
+				up := httptest.NewServer(rc.up)
+				p := rc.p
+				p.ID, p.Name, p.Key, p.Models = "relay", "relay", "k", []string{"gpt-5.5"}
+				if p.Responses != "" {
+					p.Responses = up.URL + p.Responses
+				}
+				if p.Chat != "" {
+					p.Chat = up.URL + p.Chat
+				}
+				if p.Anthropic != "" {
+					p.Anthropic = up.URL + p.Anthropic
+				}
+				if err := provider.Save(p); err != nil {
+					t.Fatal(err)
+				}
+				check := func(where string, got []byte) {
+					t.Helper()
+					switch rc.path {
+					case "/v1/responses":
+						checkResponses(t, c, got, stream)
+					case "/v1/chat/completions":
+						c.check(t, where, chatRead(t, got, stream))
+					case "/v1/messages":
+						c.check(t, where, messagesRead(t, got, stream))
+					}
+				}
+				check(rc.path+map[bool]string{true: " stream", false: ""}[stream], askGrok(t, rc.path, rc.body))
+				up.Close()
+			}
 
-// Another vendor's model is not Grok's: the same call reaches the client
-// as it came, relayed byte for byte, and translated with its floats.
-func TestOnlyGrokCallsGetIntegers(t *testing.T) {
-	c := rollout(t, "grok_4_6_exec_command.jsonl")
-	pieces := []string{c.Arguments[:60], c.Arguments[60:]}
-	for _, stream := range []bool{true, false} {
-		for _, rc := range []struct {
-			path, body string
-			up         http.HandlerFunc
-			p          provider.Provider
-		}{
-			{"/v1/responses", codexShellTurn("relay/gpt-5.5", stream), responsesCall(c.Name, c.Arguments, pieces), provider.Provider{Responses: "/v1"}},
-			{"/v1/chat/completions", chatShellTurn("relay/gpt-5.5", stream), chatCall(c.Name, c.Arguments, pieces), provider.Provider{Chat: "/v1"}},
-			{"/v1/messages", messagesShellTurn("relay/gpt-5.5", stream), messagesCall(c.Name, c.Arguments, pieces), provider.Provider{Anthropic: "/v1"}},
-		} {
 			fresh(t)
-			up := httptest.NewServer(rc.up)
-			p := rc.p
-			p.ID, p.Name, p.Key, p.Models = "relay", "relay", "k", []string{"gpt-5.5"}
-			if p.Responses != "" {
-				p.Responses = up.URL + p.Responses
-			}
-			if p.Chat != "" {
-				p.Chat = up.URL + p.Chat
-			}
-			if p.Anthropic != "" {
-				p.Anthropic = up.URL + p.Anthropic
-			}
-			if err := provider.Save(p); err != nil {
+			chat := httptest.NewServer(chatCall(c.tool, c.args, pieces))
+			if err := provider.Save(provider.Provider{ID: "relay", Name: "relay", Key: "k", Models: []string{"gpt-5.5"}, Chat: chat.URL + "/v1"}); err != nil {
 				t.Fatal(err)
 			}
-			// what the relay itself answers
-			direct := httptest.NewRecorder()
-			rc.up(direct, httptest.NewRequest("POST", rc.path, strings.NewReader(strings.Replace(rc.body, "relay/gpt-5.5", "gpt-5.5", 1))))
-			if got := askGrok(t, rc.path, rc.body); !bytes.Equal(got, direct.Body.Bytes()) {
-				t.Fatalf("%s stream %v:\n%s\nwant\n%s", rc.path, stream, got, direct.Body)
+			for where, got := range responsesRead(t, askGrok(t, "/v1/responses", codexShellTurn("relay/gpt-5.5", stream)), stream) {
+				c.check(t, "translated "+where, got)
 			}
-			up.Close()
+			chat.Close()
 		}
+	}
+}
 
+// #3152: a model that is not Grok's writes tool_search's limit as a whole
+// float, and Codex turns the call away before it runs ("invalid number";
+// omitting limit is the reporter's proof the MCP servers were fine).
+// Relayed Responses, streamed in deltas or whole, the client reads 8.
+func TestToolSearchWholeFloatLimitGivesCodexIntegers(t *testing.T) {
+	c := integralCase{name: "tool_search limit 8.0", tool: "tool_search",
+		args: `{"query":"exa web search","limit":8.0}`,
+		want: map[string]string{"query": `"exa web search"`, "limit": "8"}}
+	for _, stream := range []bool{true, false} {
 		fresh(t)
-		chat := httptest.NewServer(chatCall(c.Name, c.Arguments, pieces))
-		if err := provider.Save(provider.Provider{ID: "relay", Name: "relay", Key: "k", Models: []string{"gpt-5.5"}, Chat: chat.URL + "/v1"}); err != nil {
+		up := httptest.NewServer(responsesCall(c.tool, c.args, someCuts(c.args)["by byte"]))
+		defer up.Close()
+		if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"muse-spark-1.3-contributor"}, Responses: up.URL + "/v1"}); err != nil {
 			t.Fatal(err)
 		}
-		for where, got := range responsesRead(t, askGrok(t, "/v1/responses", codexShellTurn("relay/gpt-5.5", stream)), stream) {
-			if got != c.Arguments {
-				t.Fatalf("stream %v: %s translated %q, want %q", stream, where, got, c.Arguments)
-			}
-		}
-		chat.Close()
+		checkResponses(t, c, askGrok(t, "/v1/responses", codexShellTurn("relay/muse-spark-1.3-contributor", stream)), stream)
 	}
 }
 
diff --git a/internal/gateway/ir.go b/internal/gateway/ir.go
index 2426c2ed..7ab7c675 100644
--- a/internal/gateway/ir.go
+++ b/internal/gateway/ir.go
@@ -258,10 +258,6 @@ type Request struct {
 	// and the conversation sent before stay as they were, so its prompt
 	// cache does (#2660). Every other upstream gets them in tools.
 	LoadedInPlace bool
-	// Grok is set when the model asked is one of Grok's, whose calls'
-	// arguments reach the client with their zero fractions dropped
-	// (grok_integral.go).
-	Grok bool
 }
 
 // nsTool is a tool as a Responses client knows it: by its namespace and its
-- 
2.50.1 (Apple Git-155)

```

</details>
