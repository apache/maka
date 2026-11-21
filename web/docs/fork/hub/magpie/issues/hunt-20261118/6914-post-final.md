@yetone Following @chiyan171's analysis in #6914, this patch handles the private Anthropic-compatible relay's explicit pre-dispatch cache-control rejection without removing `caller` provenance.

**Root cause**: `forward` currently retries the same rejected request. `caller` is not injected by magpie: the relayed client history already contains it. Anthropic's [programmatic tool calling documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) identifies `caller.tool_id` as the parent code execution and instructs clients to preserve the complete assistant response. Removing it globally would change programmatic tool-call semantics. The issue establishes the combined `tool_use` + `caller` + `cache_control` trigger; it does not establish that either field alone is rejected, or why Desktop emits a different history.

**The fix**: `internal/gateway/block_callers.go` retries once only for a custom Anthropic relay's HTTP 502 containing the full `Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)` message. Only `cache_control` on `tool_use` blocks also containing `caller` is removed. Caller provenance, call IDs, arguments, other block types and other cache marks stay. Accepted requests remain unchanged; unrelated failures, preset/account providers and `errors=pass` retain their behavior. This can shorten the cached prefix at the removed breakpoint. It deliberately trades that particular cache write for an accepted request after an explicit rejection, while retaining the other breakpoints. The workaround is not learned globally or across requests.

**Source and real-path evidence**: reported in #6914. The tests send real HTTP from a client through `New().Handler()` to an `httptest` upstream that rejects the reported combination with the exact 502 text and accepts the corrected retry. This verifies the gateway path against a local server, not the reporter's private upstream.

**Red without the fix**: after committing, in an isolated checkout with only `gateway.go` restored to parent `1e2287758c6d25ed1c3435bf39f8552e225be99b` (upstream/main), retaining the new tests and helper, `TestCallerCacheControlRefusal/CRAG_refusal` and `/programmatic_CRAG_refusal` fail with `status 502, want 200: {"error":{"message":"CRAG: Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)"}}`. The diff is exactly one product file, three deleted retry-entry lines. Restoring those lines returns the targeted run to green.

**Siblings**: repository-wide `caller` JSON-key inspection found no product insertion into tool-use blocks. Native CLI and Desktop Messages requests share `forward`; this fix keys off the response and actual block shape, not client identity. `server_tool_use`, tool results, tool-input `caller` values, `allowed_callers`, system/tool/text cache marks and other marks are intentionally preserved. Translation through `Part`/`buildAnthropic` does not carry caller provenance, so no new field removal is added there. Claude subscription execution has a separate bridge and is excluded. Count-token requests have a different endpoint; no model dispatch is introduced. `errors=pass` returns before this helper. Other refused-shape and hour-TTL retry rules remain in their existing branches.

**When reading fails**: malformed request JSON remains unchanged. Response inspection reads at most the first MiB; an unmatched response retains all prefix and remaining bytes and closes the original body. A failed read closes the body and propagates the original error through `forward`, without treating the request as compatible or silently converting the failure to EOF. `TestCallerCacheRefusalBodyRead` covers both a large body and `io.ErrUnexpectedEOF`.

**Not verified**: the reporter's private upstream, real Claude Code/Desktop sessions, actual cache hit rates and programmatic execution on that private service. No real account or paid request was used. GUI/browser checks: not run (no GUI changes).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`. The commit's `Co-authored-by: chiyan171 <7626898+chiyan171@users.noreply.github.com>` trailer stays for the reporter's analysis.

| Check | Result |
| --- | --- |
| `TestCallerCacheControlRefusal` | PASS; direct and programmatic CRAG cases fail at status 502/want 200 with the product retry entry removed |
| `TestCallerCacheRefusalBodyRead` | PASS (large response, original Close, original read error) |
| `TestWithoutCallerCacheOnlyDropsMatchingToolMark` | PASS |
| targeted `-race` on the caller-cache tests | PASS, exit 0 at head `b8fa79ec510f094571b9f1ffa88f748c87981a36`, package ok in 2.482s |
| `go test ./internal/gateway/ -tags nogui -timeout=45m -count=1` | PASS, exit 0, 918.475s at the pre-rebase tree `455058c86dee698bb2c790f19692b7f720633e28` (its diff is identical after the rebase, `git range-diff` `=`); the rebased tree is covered by the whole-repository suite below |
| `go test -tags nogui ./... -timeout=45m -count=1` | Completed, exit 1, 19m24s (2026-11-18T16:05:59Z to 16:25:23Z UTC), head `b8fa79ec510f094571b9f1ffa88f748c87981a36`, the same isolated environment as attempt 2 below (external go1.26.8, isolated HOME, private cold GOCACHE, scutil/PATH isolation, no real `claude`). 101 packages ok, 23 without test files, 3 packages with failures — none of them this patch's path or files: (1) the three known `internal/cli` gateway-discovery tests (`TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr`, `TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr`, `TestUpdateFindsAMagpieThatWroteNoRecord`), the #6223 known-environment set; (2) `TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` in `internal/gateway`, a test upstream added in `35e5989f1` (inside this rebase's base window): it asserts the literal `Prefer /tmp/opencode` while the env block writes `filepath.Join` of `os.TempDir()` after `EvalSymlinks`, which on darwin resolves to `/private/var/folders/…/T/opencode`, so the assertion cannot match on darwin at any TMPDIR (on macOS `/tmp` is itself a symlink); upstream CI (linux/amd64, linux/arm64) is green on `35e5989f1`; (3) `TestSetPortServesWhenTheOldOneWasTaken` in `internal/gui` failed only in `t.TempDir()` cleanup (`TempDir RemoveAll cleanup: directory not empty`), the under-load teardown race already documented in #1543, where it "passes alone". My three caller-cache tests are not among the failures. |
| `gofmt -l` changed Go files | No output (rebased tree `b8fa79ec5`) |
| `go vet ./...` | PASS, exit 0 (rebased tree `b8fa79ec5`) |
| `GOOS=linux go vet -tags nogui ./...` | PASS, exit 0 (rebased tree) |
| `GOOS=windows go vet ./...` | PASS, exit 0 (rebased tree) |
| `go build ./...` | PASS, exit 0 (rebased tree) |
| `GOOS=linux go build -tags nogui ./...` | PASS, exit 0 (rebased tree) |
| `GOOS=windows go build ./...` | PASS, exit 0 (rebased tree) |
| Isolated product ablation | RED at parent `1e2287758c6d25ed1c3435bf39f8552e225be99b` with only `gateway.go` restored: the two CRAG refusal subtests fail `status 502, want 200` with `CRAG_CACHE_CONTROL` in the reply; GREEN (exit 0) once the three entry lines are restored |
| Strict `git am` on parent `1e2287758c6d25ed1c3435bf39f8552e225be99b` | PASS, full tree identical (`8ad5afc78173d101a782bd348b2dd8da3f2f4444`), author and trailers preserved |
| Rebased onto current upstream/main | `1e2287758c6d25ed1c3435bf39f8552e225be99b`; `git range-diff` against the previous base reports `=` |
| Fork branch | pushed before posting; `git ls-remote` head matches the posted commit |

**Earlier whole-suite attempts (historical; both were killed by the tool, with no exit code)**:

1. Initial slot run, head `455058c86dee698bb2c790f19692b7f720633e28`, unchanged clean tree. Environment: PATH `/private/tmp/mg-6907-tools:/usr/local/go/bin:/usr/bin:/bin:/usr/sbin:/sbin`, `GOTOOLCHAIN=auto`, pinned GOPATH/GOMODCACHE and private `/tmp/mg-6914-gocache`; package TestMain provides test HOME isolation. This environment did not isolate scutil system proxy visibility and resolved go1.26.8 under GOMODCACHE. The preceding gateway package run completed: exit 0, 918.475s. The whole-suite task was subsequently reported killed by the tool, with no exit code. Its complete recorded package results are: root PASS (1.012s); build/assetpack and build/conpty have no test files; build/darwin FAIL (1.437s), specifically TestFreedHeapLeavesFootprint because runtime overlay replacements beneath GOMODCACHE are prohibited; internal/access PASS (8.270s). No results for later packages are recorded. Whole-suite exit and remaining coverage are unknown. Evidence: `/tmp/mg-6914-slot-all.log`, `/tmp/mg-6914-slot.meta`, `/tmp/mg-6914-slot-gateway.exit`, `/tmp/mg-6914-slot-gateway.log`.

2. Authorized single completion retry, the same clean head `455058c86dee698bb2c790f19692b7f720633e28`, started `2026-11-18T03:46:31Z`. Explicit external toolchain `/private/tmp/mg-6907-toolchain-copy/go1.26.8`, `GOTOOLCHAIN=local`, PATH `/private/tmp/mg-6930-v4-bin:/usr/bin:/bin:/usr/sbin:/sbin`; the derived go command is also go1.26.8, node/bun are retained, real Claude is absent, and a process-local scutil wrapper reports no proxy. HOME `/private/tmp/mg-6914-home-v2.31KuI6`, private GOCACHE `/tmp/mg-6914-gocache-v2`, fixed GOPATH `/Users/ggbdpq/go` and GOMODCACHE `/Users/ggbdpq/go/pkg/mod`. Command: `go test -tags nogui ./... -timeout=45m -count=1`, once; no preceding gateway rerun. This attempt too was killed by the tool, with no exit code. No exit file or ended timestamp exists, and no test processes survived. The complete recorded package results are: root PASS (3.084s); build/assetpack and build/conpty have no test files; build/darwin PASS (10.895s); internal/access PASS (11.692s). No later package results are recorded. This confirms the prior overlay failure disappears in this environment, but does not establish whole-suite completion. Evidence: `/tmp/mg-6914-full-v2.log`, `/tmp/mg-6914-full-v2.meta`, `/tmp/mg-6914-full-v2-process-audit.txt` (empty).

**Branch with the commit**: [fix/6914-caller-cache-control](https://github.com/ggbdpq/magpie/tree/fix/6914-caller-cache-control) (head `b8fa79ec510f094571b9f1ffa88f748c87981a36`).

<details><summary>patch: fix(gateway): retry a relay's caller cache-control refusal (#6914) — git am applies it as is; SHA-256 first 16: 260b246b4550cedd</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 18 Nov 2026 07:12:42 +0800
Subject: [PATCH] fix(gateway): retry a relay's caller cache-control refusal
 (#6914)

Following chiyan171's analysis, handle the private Anthropic-compatible
relay's exact 502 CRAG_CACHE_CONTROL pre-dispatch rejection. Retry once
without cache_control only on tool_use blocks that also carry caller.
Preserve caller provenance, tool arguments, and all other cache marks.
Accepted requests, unrelated failures, preset/account providers, and
errors=pass retain their existing behavior. A removed breakpoint can
shorten the cached prefix; this is narrower than dropping caller or all
cache controls and is only attempted after the relay rejects the request.

Bound inspection of the error body to 1 MiB, preserve unread bytes and
Close, and propagate a failed read instead of treating it as a refusal.

Tests: TestCallerCacheControlRefusal exercises real HTTP between a client,
the gateway and a local upstream, including programmatic caller metadata.
TestCallerCacheRefusalBodyRead checks large bodies, Close and failed
reads; TestWithoutCallerCacheOnlyDropsMatchingToolMark guards siblings.
All three pass, including -race. gofmt -l is empty; darwin/linux/windows
vet and builds pass. Package and repository suites are pending their
exclusive machine slot; real private-upstream verification is unavailable.

Co-authored-by: chiyan171 <7626898+chiyan171@users.noreply.github.com>
Generated-by: magpie/tiantoken/gpt-6.1-sol (ZCode)
---
 docs/subsystems/gateway-routing.md     |   2 +-
 internal/gateway/block_callers.go      |  94 +++++++++++++
 internal/gateway/block_callers_test.go | 174 +++++++++++++++++++++++++
 internal/gateway/gateway.go            |   3 +
 4 files changed, 272 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/block_callers.go
 create mode 100644 internal/gateway/block_callers_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 95ecc7d7e..c03f3f29f 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -460,7 +460,7 @@ the key's leaves the call as asked, with a log line (`compactRefused`).
 - magpie runs Claude Code's advisor itself where the upstream can't and the advisor's model is one magpie serves (`provider.Resolve` takes it; `advisedHere` in [`advisor_serve.go`](../../internal/gateway/advisor_serve.go), Awad_Yoo on X). Claude Code sends the advisor for any model only with `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` set (2.1.316), which the Claude Code advisor field writes (agent-wiring.md). Such a request is translated, a relay on Messages too (`ownAPI`): the server tool becomes `Request.Advisor`, and the model is offered a function tool `advisor` with no parameters (`advisorToolDef`, a neutral description naming neither magpie nor a vendor), Claude Code's instructions and `tool_addition` kept as written. A call of it is answered inside the reply's rounds, beside web search's (`searchRounds`, `adviceRound`): the advisor model is asked through the gateway (`advise`, User-Agent `magpie-advisor/1`, the executor's system prompt and conversation, what the model said before the call, its tools offered with `tool_choice` none, no reasoning, and a short ask appended to the last user message, `adviceFor`; Claude Code's advisor instructions are cut from its system prompt and messages, `advisorCut`, since with them, or `advisorGone` in their place, the advisor answered as the executor that it had no advisor, #6804), and the reply goes on with the advice as the call's result. Claude Code is told as Anthropic's server tells it: a `server_tool_use` (`srvtoolu_…`, empty input) and an `advisor_tool_result` with `{type: advisor_result, text}`, or `{type: advisor_tool_result_error, error_code}` (`unavailable`, `too_many_requests`, `overloaded`, `prompt_too_long`, `execution_time_exceeded`, or `max_uses_exceeded` past three calls a reply). Claude Code echoes both blocks in the next turn's assistant message; `readAdvised` reads them back as the model's call and its result, splitting the message around them (`adviceApart`). Not handled: a round that calls the advisor beside an agent tool keeps the agent's tool call only, as with web search. `TestAdvisorServedForAVendorModel`, `TestAdvisorHistoryGoesBackAsACall`, `TestAdvisorFailureIsAnErrorCode`, `TestAdvisedHere`.
 - An advisor Anthropic's server runs (the request relayed on Messages, `advisorTools` above) bills apart from the request's model: the reply's top-level `usage` is the executor's alone, and each call is an `advisor_message` entry of `usage.iterations`, with its `model` and token counts, billed at the advisor model's rates and in no top-level total (Anthropic's advisor tool page, "Usage and billing"). The ledger had the executor's row only, so an Opus advisor beside a Sonnet executor was in no row (#6977, Refeccd on Discord). `aUsage.Iterations` is read (whole, and from a stream's `message_delta`, whose list holds every call so far and replaces the one before: `Usage.advised`), and each advisor call is a usage row of its own (`advisorRows` in [`advisor_usage.go`](../../internal/gateway/advisor_usage.go), written by `appendAdvised` beside every row of a try that reached a provider, and on the native route): under the advisor's model by magpie's id (`advisorKeyModel` of the request's advisor tool, `advisedAs` in `passthrough`; else the vendor's name), its `Served` the vendor's, `Kind` `advisor` (`usage.KindAdvisor`, named Advisor on Usage's Requests and filters), the request's route, agent, account and session, status 200, no timing. It counts as a request of its own, as an advisor call magpie runs itself does (below). The executor's row is as the reply said; nothing is taken from it. Routing prices the calls too, before the request's own usage (`advisorRouteUsage`), so the prompt is still read from the last. Not captured from a real reply: the fixture is Anthropic's documented example word for word. `TestAdvisorIterationsRead`, `TestAdvisorCallHasItsOwnRow`.
 - Kiro is told where to cache the prompt (plugins#110: a Kiro subscription read 0 from its cache). Its API takes Bedrock's `cachePoint: {"type":"default"}` on a `userInputMessage`, an `assistantResponseMessage` or as a tool entry. The built-in (`buildKiro` in [`kiro.go`](../../internal/gateway/kiro.go)) marks the first message when there is a system prompt, which it folds into that message, and the current message, as `buildAnthropic` marks Anthropic's. A moved Kiro's plugin (opencode-kiro-auth 0.1.10, the mover's `min`) turns each `cache_control` in the Anthropic body it is handed into one, at most 4, the last kept.
-- The cache marks `buildAnthropic` adds for a Responses client (Codex) to a Claude model last an hour (`addedMark`, `Request.hourMarks`; 7eleven on Discord): Codex's turns are often more than five minutes apart, and Codex's own vendor keeps a thread cached an hour (`chatGPTCold`). A 1h write costs 2x the input price where Anthropic's default 5m costs 1.25x and a read 0.1x or less, so one turn read after a 5 to 60 minute pause, which a 5m mark would have written again, pays for the dearer writes of dozens of turns in quick succession. Every mark it adds has the same ttl, since Anthropic refuses a 1h mark after a 5m one. The client's `prompt_cache_retention: "in_memory"` keeps them at 5m. A Chat client's marks, a model that isn't Claude's, and marks a client placed itself (an Anthropic client's, relayed as sent) are unchanged. An upstream that answers 400 naming `cache_control` and `ttl` (a relay that knows no ttl) is asked again at 5m and remembered in `unfit` (`hourMarksRefused`) until magpie restarts. A Claude subscription is served by Claude Code, which asks 1h unless the user picked 5m ([Claude subscription bridge](claude-subscription-bridge.md)). `TestResponsesToClaudeMarksLastAnHour`, `TestHourMarksRefused`.
+- The cache marks `buildAnthropic` adds for a Responses client (Codex) to a Claude model last an hour (`addedMark`, `Request.hourMarks`; 7eleven on Discord): Codex's turns are often more than five minutes apart, and Codex's own vendor keeps a thread cached an hour (`chatGPTCold`). A 1h write costs 2x the input price where Anthropic's default 5m costs 1.25x and a read 0.1x or less, so one turn read after a 5 to 60 minute pause, which a 5m mark would have written again, pays for the dearer writes of dozens of turns in quick succession. Every mark it adds has the same ttl, since Anthropic refuses a 1h mark after a 5m one. The client's `prompt_cache_retention: "in_memory"` keeps them at 5m. A Chat client's marks, a model that isn't Claude's, and marks a client placed itself (an Anthropic client's, relayed as sent) are unchanged, except for a custom Anthropic relay's explicit HTTP 502 `Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)` (#6914): `retryCallerCache` in [`block_callers.go`](../../internal/gateway/block_callers.go) asks it once more without `cache_control` only on `tool_use` blocks also carrying `caller`. Caller provenance, arguments and other marks stay; removing that breakpoint can shorten the cached prefix. Accepted requests, unrelated errors, preset/account providers and `errors=pass` keep their behavior. `TestCallerCacheControlRefusal`. An upstream that answers 400 naming `cache_control` and `ttl` (a relay that knows no ttl) is asked again at 5m and remembered in `unfit` (`hourMarksRefused`) until magpie restarts. A Claude subscription is served by Claude Code, which asks 1h unless the user picked 5m ([Claude subscription bridge](claude-subscription-bridge.md)). `TestResponsesToClaudeMarksLastAnHour`, `TestHourMarksRefused`.
 - A model that refuses a conversation ending with the assistant's message (`refusesPrefill`: OpenCode Go's Claude models over Messages, "This model does not support assistant message prefill"; Volcengine's Agent Plan, "…for a model that does not support prefill"; Gemini's, "Requests ending with a model turn are not supported") is marked for that provider, model and API (`prefillRefused`, #1447); the provider's other models keep their prefill ([`prefill.go`](../../internal/gateway/prefill.go)). A Chat or Responses client's conversation ending with the assistant's message, which those APIs read as a turn already said (`Request.LastIsTurn`), is asked again with a user turn after it (`continueText`), translated (`forwardTranslated`) or relayed (`passthrough`, `userLastBody`), and so from then on. An Anthropic client's prefill is its own ask and gets the refusal as sent. magpie's own continuation of a cut reply (`continuation.go`) isn't asked of that model again; the try the model refused ends the reply with what cut it, not with the refusal. A request magpie builds in Gemini's own shape (`buildCodeAssistSent`: Vertex AI, Gemini CLI's and Antigravity's Code Assist, Factory) never ends with the model's turn, which all of them turn away: a user turn goes after it, `continueText`, or `compactLastText` when an agent is compacting with its ask in the system prompt (`modelLastAsk`), as one goes before a history that opens with the model's. Nor does it send a user turn that mixes a tool's `functionResponse` with text, which Vertex AI answers with the same "ending with a model turn" (#1533: Codex's compaction prompt after a tool's output): what the user said goes in a user turn of its own after the tools' responses (`hasResponse`), except for a Claude model on Antigravity, whose tool_result turn holds both.
 - A tool's `strict` that an upstream turns away (`toolStrictRefusal` in [`strict_refused.go`](../../internal/gateway/strict_refused.go): "Unsupported Chat Completions API field: tools[0].function.strict", OpenAI-style unknown_parameter, "Extra inputs are not permitted" and pydantic's extra_forbidden on it) is asked once more without it, in Chat's `tools[].function` and Responses' `tools[]` alike, and marked for that provider and API (`toolStrictRefused`): its next requests go without it at once. OpenCode 2 sends `"strict": false` on every tool through `@ai-sdk/openai-compatible`, and a custom provider that refused it ended the session (#1980). An upstream that hasn't refused it still gets it, as the ChatGPT backend needs it (#383). `TestToolStrictLeftOutWhereRefused` (real OpenCode 2.0.25 requests), `TestToolStrictRefusalWordings`.
 - A history call to a tool the request doesn't declare, which an agent that loads its tools on demand sends (pi's and T3 Code's `tool_search`: the tools a search found are called in the history but not declared in the next request's `tools`, and pi sends `"tools": []` with no tools left; Gearclickist on Discord), goes as sent where it is taken: OpenAI's Chat and Responses, the ChatGPT backend and Gemini take it, and Anthropic takes a call to a tool it isn't given ([`undeclared_tools.go`](../../internal/gateway/undeclared_tools.go)). Anthropic refuses calls with no tools at all ("Requests which include `tool_use` or `tool_result` blocks must define tools"), so `anthropicBody` declares a stub for each tool the history called when the request has none (description "Called earlier in this conversation; not available now.", any object as its input) with `tool_choice` `none`, as the Kiro plugin declares its history's tools for Kiro. An upstream that turns the request away naming such a tool as not found, unknown or not defined, or that says tools must be defined beside the calls (`refusesHistoryTools`: a relay in front of Kiro or Bedrock, a vendor checking each name), is asked once more with a stub declared for each tool the history called and `tools` lacks (`withHistoryTools`, Chat, Responses and Messages bodies, relayed or translated), `tool_choice` `none` only where the client offered no tools, and marked for that provider and API (`historyToolsRefused`): its next requests carry the stubs at once. A Responses call under a namespace is the namespace's, and a request whose calls are all declared goes as it was. `TestUndeclaredHistoryToolRefusedThenStubbed`, `TestToollessHistoryToAnthropicDeclaresStubs`, `TestToollessHistoryRefusedOnChat`, `TestUndeclaredHistoryToolTakenAsSent`, `TestRefusesHistoryToolsMatch`.
diff --git a/internal/gateway/block_callers.go b/internal/gateway/block_callers.go
new file mode 100644
index 000000000..eb493c766
--- /dev/null
+++ b/internal/gateway/block_callers.go
@@ -0,0 +1,94 @@
+package gateway
+
+import (
+	"bytes"
+	"context"
+	"encoding/json"
+	"io"
+	"net/http"
+
+	"github.com/tidwall/gjson"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+const callerCacheRefusal = "Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)"
+
+// retryCallerCache handles a custom relay's explicit pre-dispatch refusal
+// (#6914). caller must stay: programmatic calls name their parent code
+// execution there. Only the conflicting tool_use cache marks come out;
+// this can shorten the cached prefix, but other breakpoints remain.
+// Normal replies and other failures never change the request.
+func (s *Server) retryCallerCache(ctx context.Context, p provider.Provider, to provider.Protocol, path string, body []byte, in http.Header, res *http.Response) (*http.Response, error) {
+	if to != provider.Anthropic || res.StatusCode != http.StatusBadGateway || p.Preset != "" || p.Account != nil || p.PassErrors {
+		return res, nil
+	}
+	fixed := withoutCallerCache(body)
+	if bytes.Equal(fixed, body) {
+		return res, nil
+	}
+	b, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
+	if err != nil {
+		res.Body.Close()
+		return nil, err
+	}
+	res.Body = readCloser{io.MultiReader(bytes.NewReader(b), res.Body), res.Body}
+	if !bytes.Contains(b, []byte(callerCacheRefusal)) {
+		return res, nil
+	}
+	res.Body.Close()
+	return s.forwardOnce(ctx, p, to, path, fixed, in)
+}
+
+func withoutCallerCache(body []byte) []byte {
+	if !bodyHas(body, `"caller"`) || !bodyHas(body, `"cache_control"`) {
+		return body
+	}
+	var q map[string]json.RawMessage
+	var messages []json.RawMessage
+	if json.Unmarshal(body, &q) != nil || json.Unmarshal(q["messages"], &messages) != nil {
+		return body
+	}
+	changed := false
+	for i, raw := range messages {
+		content := gjson.GetBytes(raw, "content")
+		if !content.IsArray() {
+			continue
+		}
+		var blocks []json.RawMessage
+		if json.Unmarshal([]byte(content.Raw), &blocks) != nil {
+			return body
+		}
+		marked := false
+		for j, b := range content.Array() {
+			if b.Get("type").String() != "tool_use" || !b.Get("caller").Exists() || !b.Get("cache_control").Exists() {
+				continue
+			}
+			var block map[string]json.RawMessage
+			if json.Unmarshal(blocks[j], &block) != nil {
+				return body
+			}
+			delete(block, "cache_control")
+			blocks[j], _ = json.Marshal(block)
+			marked = true
+		}
+		if marked {
+			var message map[string]json.RawMessage
+			if json.Unmarshal(raw, &message) != nil {
+				return body
+			}
+			message["content"], _ = json.Marshal(blocks)
+			messages[i], _ = json.Marshal(message)
+			changed = true
+		}
+	}
+	if !changed {
+		return body
+	}
+	q["messages"], _ = json.Marshal(messages)
+	fixed, err := json.Marshal(q)
+	if err != nil {
+		return body
+	}
+	return fixed
+}
diff --git a/internal/gateway/block_callers_test.go b/internal/gateway/block_callers_test.go
new file mode 100644
index 000000000..93cfd7269
--- /dev/null
+++ b/internal/gateway/block_callers_test.go
@@ -0,0 +1,174 @@
+package gateway
+
+import (
+	"bytes"
+	"context"
+	"encoding/json"
+	"errors"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// chiyan171 (#6914): the private relay refuses a tool_use carrying both
+// caller and cache_control, before dispatch. Ordinary Anthropic endpoints
+// accept the pair; programmatic calls still need their caller provenance.
+func TestCallerCacheControlRefusal(t *testing.T) {
+	for _, tc := range []struct {
+		name      string
+		rejection string
+		pass      bool
+		want      int
+		calls     int
+	}{
+		{"accepts", "", false, 200, 1},
+		{"CRAG refusal", "Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)", false, 200, 2},
+		{"programmatic CRAG refusal", "Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)", false, 200, 2},
+		{"other 502", "upstream temporarily unavailable", false, 502, 0},
+		{"pass errors", "Gateway kernel rejected the request cache controls before dispatch (CRAG_CACHE_CONTROL)", true, 502, 1},
+	} {
+		t.Run(tc.name, func(t *testing.T) {
+			fresh(t)
+			var mu sync.Mutex
+			var bodies [][]byte
+			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+				b, err := io.ReadAll(r.Body)
+				if err != nil {
+					t.Error(err)
+					return
+				}
+				mu.Lock()
+				bodies = append(bodies, b)
+				mu.Unlock()
+				w.Header().Set("Content-Type", "application/json")
+				block := gjson.GetBytes(b, "messages.1.content.0")
+				if strings.HasSuffix(tc.name, "CRAG refusal") && block.Get("caller").Exists() && block.Get("cache_control").Exists() {
+					w.WriteHeader(502)
+					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": tc.rejection}})
+					return
+				}
+				if tc.name == "other 502" || tc.name == "pass errors" {
+					w.WriteHeader(502)
+					msg := tc.rejection
+					if tc.name == "pass errors" {
+						msg = callerCacheRefusal
+					}
+					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
+					return
+				}
+				io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
+			}))
+			t.Cleanup(up.Close)
+			p := provider.Provider{ID: "crag", Name: "CRAG", Key: "k", Anthropic: up.URL, Models: []string{"claude-sonnet-5-5"}}
+			if tc.pass {
+				p.PassErrors = true
+			}
+			if err := provider.Save(p); err != nil {
+				t.Fatal(err)
+			}
+			body := `{"model":"crag/claude-sonnet-5-5","max_tokens":128,"system":[{"type":"text","text":"rules","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"read"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read","caller":{"type":"direct"},"input":{"caller":"argument"},"cache_control":{"type":"ephemeral"}},{"type":"text","text":"reading","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`
+			caller := `{"type":"direct"}`
+			if tc.name == "programmatic CRAG refusal" {
+				caller = `{"type":"code_execution_20260120","tool_id":"srvtoolu_parent"}`
+				body = strings.Replace(body, `{"type":"direct"}`, caller, 1)
+			}
+			gw := httptest.NewServer(New().Handler())
+			t.Cleanup(gw.Close)
+			res, err := http.Post(gw.URL+"/v1/messages", "application/json", strings.NewReader(body))
+			if err != nil {
+				t.Fatal(err)
+			}
+			reply, err := io.ReadAll(res.Body)
+			res.Body.Close()
+			if err != nil {
+				t.Fatal(err)
+			}
+			if res.StatusCode != tc.want {
+				t.Fatalf("status %d, want %d: %s", res.StatusCode, tc.want, reply)
+			}
+			mu.Lock()
+			defer mu.Unlock()
+			if len(bodies) == 0 {
+				t.Fatal("no request reached the upstream")
+			}
+			if tc.calls > 0 && len(bodies) != tc.calls {
+				t.Fatalf("%d upstream calls, want %d", len(bodies), tc.calls)
+			}
+			for i, b := range bodies {
+				block := gjson.GetBytes(b, "messages.1.content.0")
+				if block.Get("caller.type").String() != gjson.Get(caller, "type").String() || block.Get("caller.tool_id").String() != gjson.Get(caller, "tool_id").String() || block.Get("input.caller").String() != "argument" || block.Get("id").String() != "toolu_1" {
+					t.Errorf("try %d changed the tool call: %s", i, block.Raw)
+				}
+				wantMark := !(strings.HasSuffix(tc.name, "CRAG refusal") && i == 1)
+				if block.Get("cache_control").Exists() != wantMark {
+					t.Errorf("try %d cache mark present=%v, want %v", i, block.Get("cache_control").Exists(), wantMark)
+				}
+				if !gjson.GetBytes(b, "system.0.cache_control").Exists() || !gjson.GetBytes(b, "messages.1.content.1.cache_control").Exists() {
+					t.Errorf("try %d removed unrelated cache marks: %s", i, b)
+				}
+			}
+		})
+	}
+}
+
+// Inspecting a refusal must neither consume the rest of a large response
+// nor hide a failed read. The retry decision is below the HTTP handler,
+// where these transport-level failures can be injected deterministically.
+func TestCallerCacheRefusalBodyRead(t *testing.T) {
+	body := []byte(`{"messages":[{"role":"assistant","content":[{"type":"tool_use","caller":{"type":"direct"},"cache_control":{"type":"ephemeral"}}]}]}`)
+	t.Run("large unrelated body stays readable and closable", func(t *testing.T) {
+		original := strings.Repeat("x", (1<<20)+100)
+		closed := false
+		res := &http.Response{StatusCode: 502, Body: callerCacheTestBody{Reader: strings.NewReader(original), closed: &closed}}
+		got, err := New().retryCallerCache(context.Background(), provider.Provider{}, provider.Anthropic, "/v1/messages", body, nil, res)
+		if err != nil || got != res {
+			t.Fatalf("unrelated response replaced: %v", err)
+		}
+		b, err := io.ReadAll(got.Body)
+		if err != nil || !bytes.Equal(b, []byte(original)) {
+			t.Fatalf("body changed: bytes=%d err=%v", len(b), err)
+		}
+		got.Body.Close()
+		if !closed {
+			t.Fatal("original body was not closed")
+		}
+	})
+	t.Run("read error survives", func(t *testing.T) {
+		closed := false
+		res := &http.Response{StatusCode: 502, Body: callerCacheTestBody{Reader: callerCacheErrorReader{}, closed: &closed}}
+		got, err := New().retryCallerCache(context.Background(), provider.Provider{}, provider.Anthropic, "/v1/messages", body, nil, res)
+		if got != nil || !errors.Is(err, io.ErrUnexpectedEOF) || !closed {
+			t.Fatalf("got response=%v error=%v closed=%v", got, err, closed)
+		}
+	})
+}
+
+type callerCacheTestBody struct {
+	io.Reader
+	closed *bool
+}
+
+func (b callerCacheTestBody) Close() error { *b.closed = true; return nil }
+
+type callerCacheErrorReader struct{}
+
+func (callerCacheErrorReader) Read(b []byte) (int, error) {
+	return copy(b, callerCacheRefusal), io.ErrUnexpectedEOF
+}
+
+func TestWithoutCallerCacheOnlyDropsMatchingToolMark(t *testing.T) {
+	body := []byte(`{"messages":[{"role":"assistant","content":[{"type":"tool_use","caller":{"type":"direct"},"cache_control":{"type":"ephemeral"}},{"type":"server_tool_use","caller":{"type":"direct"},"cache_control":{"type":"ephemeral"}},{"type":"tool_use","input":{"caller":"arg"},"cache_control":{"type":"ephemeral"}}]}]}`)
+	got := withoutCallerCache(body)
+	if !gjson.GetBytes(got, "messages.0.content.0.caller").Exists() || gjson.GetBytes(got, "messages.0.content.0.cache_control").Exists() {
+		t.Fatalf("matching tool_use mark not narrowly removed: %s", got)
+	}
+	if !gjson.GetBytes(got, "messages.0.content.1.cache_control").Exists() || !gjson.GetBytes(got, "messages.0.content.2.cache_control").Exists() {
+		t.Fatalf("unrelated marks removed: %s", got)
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index a774d1cfc..cbd43bd83 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6272,6 +6272,9 @@ func (s *Server) forward(ctx context.Context, p provider.Provider, to provider.P
 		// once, never again in another shape
 		return res, err
 	}
+	if err == nil {
+		res, err = s.retryCallerCache(ctx, p, to, path, body, in, res)
+	}
 	if err == nil && res.StatusCode >= 400 {
 		// a body over the provider's byte cap: asked again with its
 		// oldest images left out, or said as a 413 (body_cap.go)
-- 
2.50.1 (Apple Git-155)

```

</details>
