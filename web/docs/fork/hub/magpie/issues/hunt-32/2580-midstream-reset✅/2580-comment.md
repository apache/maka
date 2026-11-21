## 根因

直通流（relay，同协议透传——Z.ai 的 Chat 上游对 pi 的 Chat 客户端正是这条路）被上游在**事件中间**重置时（`connection reset by peer` / 半截 body），`internal/gateway/gateway.go` 的 `passthrough` 转发循环把上游最后一读的半截 SSE 行**原样发给客户端**，然后才补发格式正确的错误事件（#2446 已保证它从空行后开始）：

```
data: {"id":"c1","model":"glm-5.3","choices":[{"index":0,"delta":{"reasoning_content":"the VM program itself hit an undefined

data: {"error":{"message":"UP: connection lost mid-reply (unexpected EOF)","type":"api_error"}}
```

严格的 SSE 客户端在**第一个事件**上就死了：半截行的 JSON 解析失败，pi 报 `malformed server-sent event JSON` 后整轮失败——后面的错误事件根本没被读到，更不用说据此重试或换号。issue 里贴的那块「含截断 reasoning 与 error 的合并 JSON」正是这条半行 + 补发错误的产物。本机的复现测试在修复前（upstream/main 基线）输出同样的形状：

```
--- FAIL: TestChatStreamCutMidLineLeavesNoHalfEvent (0.57s)
    passthrough_severed_test.go:190: a half event the upstream never ended went to the client as data: ...
```

流一旦 pass 给客户端，magpie 无法再换号重发（头已发出、已转发的内容收不回）；本修让客户端**至少拿到一条它能解析的错误**，agent 的轮换/重试逻辑由客户端自己的错误处理接管。

## 修法（很小，复用 #2446 的 atLine/apart 机制）

上游没写完的行从来不是一个事件。`passthrough` 的 `write` 闭包对流式回复改为**行缓冲**：只写出已以 `\n` 结尾的完整行，最后一个未完成行扣在本地（`pending`）；

- 回复整体结束（whole）：`unheld()` 把扣住的半行照常发出，透传语义不变；
- 失败路径（`streamFailure` 的两处 append：断流错误、Gemini 兼容 API 补的 `finish_reason`）：`dropHalf()` 先把半行丢掉再 apart 补发——客户端读到的只有完整事件 + 错误事件，没有需要解析失败的东西；

非流式回复（`sse=false`）的 write 保持原样。`holdWriter.cutLoop`（组路径循环保卫切断）不在本修范围：它已写出的字节收不回，其 append 本就从独立行开始（#2446）。组内 failover、continuation 续问等机制不动。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增 `TestChatStreamCutMidLineLeavesNoHalfEvent`（Chat 直通，severed 上游在事件中间断开；断言错误事件在、半行内容不在、逐事件全部可解析） | 修前红（半行在流里），修后绿 |
| 消融回红（write 退回直写，半行放行） | 同形转红；恢复后复绿 |
| `severed` helper 扩了 Chat 形态，既有 4 处调用补 `provider.Anthropic` 参数；定向邻居：`TestPassthroughStream{SeveredUpstream,EndsShort,CutMidLine,EndsOnLineEnd,Whole,ResponsesEndsShort,ResponsesBigLastEvent}`、`TestLoopCutMidLine`、`TestGeminiCompat{RelayEndedShort,TranslatedEndedShort,FinishAfterPartialLine}`、`TestTranslateBufferedSeveredUpstream`、`TestRequestBodyProgressRenewsIdleDeadline`（上游 a751f528 新测试） | 全绿（半行被丢不破坏任何既有断言——#2446 的测试只断言补发事件独立成行） |
| `go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/gateway/` | ok，0 FAIL（293s，沙盒 HOME） |
| `gofmt -l internal/gateway/ docs/` | 干净 |
| `go vet -tags nogui ./internal/gateway/`（darwin + GOOS=linux + GOOS=windows） | 过 |
| `go build -tags nogui .` | 过（trayimage cgo `-Wenum-conversion` 警告为本机已知预存） |

## 补丁与分支

- 分支：[ggbdpq/magpie@hunt/2580-midstream-reset](https://github.com/ggbdpq/magpie/tree/hunt/2580-midstream-reset)（基于 upstream/main `a751f528`，commit `2acffddf`）
- 合入时请保留原作者（git am/cherry-pick）或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
From 2acffddf61484414a31eb18ba6e0a88db1e81b53 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 22:17:34 +0800
Subject: [PATCH] gateway: a stream cut mid-line sends no half event ahead of
 its error (#2580)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A passthrough stream the upstream reset inside an event sent the half
event's data line on to the client, and the client's SSE parser died
reading it — "malformed server-sent event JSON" (pi, on a glm-5.3
stream Z.ai cut mid-reply) — so the error event magpie appended after
it was never reached, and the turn failed without a word of what went
wrong. The appended event itself already began on its own line (#2446);
what the client couldn't survive was the half event ahead of it.

A line the upstream never ended is no event of its own. passthrough's
write holds the line still pending back until its rest arrives (a
stream alone; a whole reply goes through unheld, as it came), and the
two appends on a failed stream — the finish_reason filled in for a
Gemini OpenAI-compatible reply that ended done, and streamFailure —
drop it first: the error is the only thing left to read. holdWriter's
cutLoop still writes what came with the write that trips it, as it did;
what it appends begins on its own line already (#2446).

Tests: TestChatStreamCutMidLineLeavesNoHalfEvent (severed speaks Chat
too now). Red before the fix (the half event in the stream), green
after; broken by hand again — write unbuffered — red, restored, green.
Neighbors: the passthrough severed and Gemini-compat cut tests stay
green, atLineEnd and all.

go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/gateway/ at
base 9b04c4e2: ok, 0 FAIL (293s; sandbox HOME, macOS, cached go1.26.8).
gofmt -l internal/gateway docs clean; go vet -tags nogui clean on
darwin, linux and windows; go build -tags nogui .

Fixes #2580
Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md           |  2 +-
 internal/gateway/gateway.go                  | 57 +++++++++++++++++---
 internal/gateway/passthrough_severed_test.go | 35 +++++++++++-
 internal/gateway/stream_cut_test.go          |  2 +-
 internal/gateway/translate_severed_test.go   | 14 +++--
 5 files changed, 96 insertions(+), 14 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index d126263c..e6694cdf 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -107,7 +107,7 @@ recorded as a prediction failure (`noPrediction`).
 - A request whose key is a Claude sign-in (`claudeSignIn`: `Authorization: Bearer sk-ant-oat…`, Claude Code signed in to claude.ai with magpie as its base URL) is never told a 401, nor a 403 saying "OAuth token has been revoked". magpie never passes that sign-in on, so such an answer is a provider refusing magpie's credential, or one of magpie's own Claude accounts lapsing; told it, Claude Code renews its own sign-in before each of its retries (ten for one request) and then asks to `/login`. Any error whose message mentions x-api-key, whatever its status, Claude Code tells as "Not logged in · Please run /login" too. It is told as a 502 in magpie's words, an `api_error` saying "<provider> refused magpie's credential (HTTP 401): …" with x-api-key said as "API key", and any other error such a request is told keeps its status with x-api-key said as "API key", as does a stream's error after its 200 (`keepsSignIn`, `claude_signin.go`). Recent calls and the usage log keep the provider's status and message. Any other 403, and a request with magpie's key or an API key, is answered as before. The sign-in's beta (`oauth-…` in `anthropic-beta`) isn't passed on either (`askedBetas`), so a provider gets the request as Claude Code with magpie's key sends it; a provider's own `header.anthropic-beta` still goes.
 - A 2xx that can't be an API's answer is the 502 it stands for (`notAnAPIReply`, #1012): a web page (`text/html`, or a body that begins as one: a sign-in page, Cloudflare's challenge), a body with nothing in it, or one sent as JSON that doesn't begin as JSON. Every upstream request goes through it (`forwardOnce`, and the built-in clients' own: the ChatGPT backend's `/responses`, Kiro, Zed, Qoder, Devin, Cursor, Command Code), so it fails over, rests and is logged as a 502 does, its reason naming the page's title. Only the first bytes are peeked, which a stream waits for anyway, and a compressed body is left as it came.
 - A 2xx from Zhipu or Z.ai holding the platform's refusal envelope (`{"code":1000,"msg":…,"success":false}`, which their Responses API at `/api/v1` answers a refused key) is the refusal it stands for (`provider.ZhipuEnveloped` in `forwardOnce`): 401 for a key refused, 429 for a limit or no balance, as Zhipu's error codes give, so it fails over and rests as those do and the agent is told why. `TestZhipuResponsesRefusalIsRefusal`.
-- A streamed request is never left silent while its vendor says nothing. `holdWriter.watch` runs beside each try: past `keepHeldAfter` (15s) it sends a held try's agent the stream's 200 and SSE comments (`keepAlive`), none of the try, so another candidate may still answer in the same stream; once the reply passes, it puts a comment between two of its lines after `keepaliveEvery` of quiet. It stops after `keepaliveLongest` (5 minutes) with nothing from the vendor. A try waiting for its key's or account's slot or for room in its minute (`lanes.take`, `rpms.wait`) is kept alive the same way (`keepQueued`), for as long as it waits; once the 200 is out, the try is held, and its failure or its queue turning it away reaches the agent as the stream's error (`failTo`), not a status (coeo91 on Discord). A wait shorter than `keepHeldAfter` sends nothing, so its 429 keeps its `Retry-After`. A proxy in front such as Cloudflare (125s) otherwise ends the request (#947). Gemini streams get no comments (#934). A vendor that then ignores `stream:true` and answers 200 with its reply whole has it sent as the agent's stream (`wholeAsStream`: Chat, Responses, Anthropic), not as the stream's error, while a reply under a type that says neither JSON nor a stream is held as a stream when its first bytes are one (`sseStart`), read event by event like one that says so, so an error among its frames still goes to the next candidate (#1418: it went through at once); a 200 that is no reply of the protocol's fails as a translated reply that didn't stream does (502, "… did not stream"), for the next candidate to answer, and the last one's reaches the agent as the stream's error. A held stream that has sent nothing but the frames before a reply (`response.created`, `response.in_progress`, `codex.rate_limits`, pings, an empty part begun, and any event `streamEvent` doesn't know to carry text, reasoning, a call or a reply's end (`replyEvent`), or an item not known that isn't a call or a tool's (`streamPart.said`): `eventLead`; Aliceonly on #1418: an unknown event was taken for content and let a frames-only 200 through, and its `server_is_overloaded` reached Codex with five candidates left) stays held as long as its agent is kept alive, up to `holdLead` (4 minutes, under the 300s Codex waits for an event; `keptQuiet`), so a `server_is_overloaded` that comes after it is a failure the next candidate answers (#1418: let through at 15s, the ChatGPT backend's failure 36s in ended Codex's turn with sub2api, next in the group, never asked). A stream whose agent can't be kept alive (Gemini's) is let through after `holdLongest` (15s), as before. Codex counts only events toward that 300s, not comments, so the bound is the request's, not each try's: once Codex on Responses has heard no event for `agentQuietMost` (4 minutes) since the request began or its last event (`keptAlive.tooQuiet`), the try in hand is let through (`scan`, `keepQuiet`), and no group replan or same-one retry is taken whose pause would end past it (fadenoob on Discord: held tries and replan pauses added up past 300s and Codex reconnected on "idle timeout waiting for SSE"). A translated reply whose upstream stream stops before it said its reply had — an Anthropic one with no stop_reason and no message_stop, a Responses one with no `response.completed`, the same two a relayed one is told by (`sniff.whole`; a Chat stream may end without `[DONE]` and be whole), a Gemini or Code Assist one whose last chunk has no candidate's `finishReason` (`geminiEnds`, #1643: `usageMetadata` is no end, Vertex AI sends it on every chunk; a chunk with no candidate at all is the empty reply's to answer, #667), and a relayed Gemini one told the same way (#1644; it ends in Gemini's own `{"error":{"code":502,…,"status":"UNAVAILABLE"}}` data line from `streamFailure`, `TestGeminiRelayEndedShort`; whatever a relayed stream gets appended, that error or a filled-in `finish_reason`, begins after a blank line, two newlines when the upstream's last write stopped inside a line, so it is an event of its own rather than more of the half-written one, #2446, `TestPassthroughStreamCutMidLine`, `TestGeminiCompatFinishAfterPartialLine`), and a Chat one from Gemini's OpenAI-compatible API (`geminiCompat`) with no `finish_reason`, relayed or translated (`saysItsEnd`; Linka on Discord: the upstream hung up between a whole function call and its `finish_reason`, and Pi threw the call away as "Stream ended without finish_reason"; that API counts the usage only once the generation is done, so when the last chunk carried it only the `finish_reason` was lost and it is filled in, `tool_calls` after a call and `stop` otherwise, as a relayed chunk before `[DONE]` or a translated reply's end, and the reply counts as whole (`chatTail`); only one with no usage at its end is a cut, `TestGeminiCompatRelayEndedShort`, `TestGeminiCompatTranslatedEndedShort`) — ends the turn with "the reply ended before it was complete" (`errEndedShort`, `TestResponsesUpstreamEndedShort`, `TestGeminiUpstreamEndedShort`), asked again in place where the upstream goes on from a prefill (`continuation.go`). A client that asked for no stream is told the same 502 of such a cut (`translate`, `TestNonStreamEndedShort`, `TestGeminiNonStreamEndedShort`), rather than handed what came as its whole reply. A translated reply from an Anthropic or Responses upstream that ended but said nothing (no text, call, search or image) and counted no token at all is no reply either, whatever its end says (`repliesCounted`, #2086: an Anthropic-compatible proxy's 200 ended a Codex turn as `response.completed` with no output, no usage and no served model, and Codex didn't ask again). It is the empty reply's to answer (#667): asked again in place, then failed with "an empty reply", streamed or not, for every client (`TestUncountedEmptyReplyFails`, `TestUncountedEmptyReplyFailsEveryClient`). Claude's own empty `end_turn` counts its prompt and stays a whole reply (`TestWellFormedStreamsStillComplete`). A reply passed through in its own protocol isn't read this way.
+- A streamed request is never left silent while its vendor says nothing. `holdWriter.watch` runs beside each try: past `keepHeldAfter` (15s) it sends a held try's agent the stream's 200 and SSE comments (`keepAlive`), none of the try, so another candidate may still answer in the same stream; once the reply passes, it puts a comment between two of its lines after `keepaliveEvery` of quiet. It stops after `keepaliveLongest` (5 minutes) with nothing from the vendor. A try waiting for its key's or account's slot or for room in its minute (`lanes.take`, `rpms.wait`) is kept alive the same way (`keepQueued`), for as long as it waits; once the 200 is out, the try is held, and its failure or its queue turning it away reaches the agent as the stream's error (`failTo`), not a status (coeo91 on Discord). A wait shorter than `keepHeldAfter` sends nothing, so its 429 keeps its `Retry-After`. A proxy in front such as Cloudflare (125s) otherwise ends the request (#947). Gemini streams get no comments (#934). A vendor that then ignores `stream:true` and answers 200 with its reply whole has it sent as the agent's stream (`wholeAsStream`: Chat, Responses, Anthropic), not as the stream's error, while a reply under a type that says neither JSON nor a stream is held as a stream when its first bytes are one (`sseStart`), read event by event like one that says so, so an error among its frames still goes to the next candidate (#1418: it went through at once); a 200 that is no reply of the protocol's fails as a translated reply that didn't stream does (502, "… did not stream"), for the next candidate to answer, and the last one's reaches the agent as the stream's error. A held stream that has sent nothing but the frames before a reply (`response.created`, `response.in_progress`, `codex.rate_limits`, pings, an empty part begun, and any event `streamEvent` doesn't know to carry text, reasoning, a call or a reply's end (`replyEvent`), or an item not known that isn't a call or a tool's (`streamPart.said`): `eventLead`; Aliceonly on #1418: an unknown event was taken for content and let a frames-only 200 through, and its `server_is_overloaded` reached Codex with five candidates left) stays held as long as its agent is kept alive, up to `holdLead` (4 minutes, under the 300s Codex waits for an event; `keptQuiet`), so a `server_is_overloaded` that comes after it is a failure the next candidate answers (#1418: let through at 15s, the ChatGPT backend's failure 36s in ended Codex's turn with sub2api, next in the group, never asked). A stream whose agent can't be kept alive (Gemini's) is let through after `holdLongest` (15s), as before. Codex counts only events toward that 300s, not comments, so the bound is the request's, not each try's: once Codex on Responses has heard no event for `agentQuietMost` (4 minutes) since the request began or its last event (`keptAlive.tooQuiet`), the try in hand is let through (`scan`, `keepQuiet`), and no group replan or same-one retry is taken whose pause would end past it (fadenoob on Discord: held tries and replan pauses added up past 300s and Codex reconnected on "idle timeout waiting for SSE"). A translated reply whose upstream stream stops before it said its reply had — an Anthropic one with no stop_reason and no message_stop, a Responses one with no `response.completed`, the same two a relayed one is told by (`sniff.whole`; a Chat stream may end without `[DONE]` and be whole), a Gemini or Code Assist one whose last chunk has no candidate's `finishReason` (`geminiEnds`, #1643: `usageMetadata` is no end, Vertex AI sends it on every chunk; a chunk with no candidate at all is the empty reply's to answer, #667), and a relayed Gemini one told the same way (#1644; it ends in Gemini's own `{"error":{"code":502,…,"status":"UNAVAILABLE"}}` data line from `streamFailure`, `TestGeminiRelayEndedShort`; whatever a relayed stream gets appended, that error or a filled-in `finish_reason`, begins after a blank line, so it is an event of its own rather than more of the half-written one, and the half event itself is dropped: a relayed stream holds the line the upstream never ended back, puts it out when the reply ends whole, and throws it away when a failure is appended in its place, for no client can parse it — pi read "malformed server-sent event JSON" off a stream Z.ai reset mid-line, and died before the error after it (#2446, #2580, `TestPassthroughStreamCutMidLine`, `TestChatStreamCutMidLineLeavesNoHalfEvent`, `TestGeminiCompatFinishAfterPartialLine`), and a Chat one from Gemini's OpenAI-compatible API (`geminiCompat`) with no `finish_reason`, relayed or translated (`saysItsEnd`; Linka on Discord: the upstream hung up between a whole function call and its `finish_reason`, and Pi threw the call away as "Stream ended without finish_reason"; that API counts the usage only once the generation is done, so when the last chunk carried it only the `finish_reason` was lost and it is filled in, `tool_calls` after a call and `stop` otherwise, as a relayed chunk before `[DONE]` or a translated reply's end, and the reply counts as whole (`chatTail`); only one with no usage at its end is a cut, `TestGeminiCompatRelayEndedShort`, `TestGeminiCompatTranslatedEndedShort`) — ends the turn with "the reply ended before it was complete" (`errEndedShort`, `TestResponsesUpstreamEndedShort`, `TestGeminiUpstreamEndedShort`), asked again in place where the upstream goes on from a prefill (`continuation.go`). A client that asked for no stream is told the same 502 of such a cut (`translate`, `TestNonStreamEndedShort`, `TestGeminiNonStreamEndedShort`), rather than handed what came as its whole reply. A translated reply from an Anthropic or Responses upstream that ended but said nothing (no text, call, search or image) and counted no token at all is no reply either, whatever its end says (`repliesCounted`, #2086: an Anthropic-compatible proxy's 200 ended a Codex turn as `response.completed` with no output, no usage and no served model, and Codex didn't ask again). It is the empty reply's to answer (#667): asked again in place, then failed with "an empty reply", streamed or not, for every client (`TestUncountedEmptyReplyFails`, `TestUncountedEmptyReplyFailsEveryClient`). Claude's own empty `end_turn` counts its prompt and stays a whole reply (`TestWellFormedStreamsStillComplete`). A reply passed through in its own protocol isn't read this way.
 - A vendor's error keeps its `code` and `param` on its way to an OpenAI-shaped client (`writeVendorError`), where `writeError` used to set both to null: a status error relayed or translated, and a request refused inside a Responses stream. A Responses stream's `error` event or failed response whose error is of type `invalid_request_error` is the request at fault (`requestRefused`, read by its type, not its words): its `Event` carries status 400 and the vendor's error (`Event.Said`), so a client answered whole gets the vendor's 400 with its code and param (the whole-translated path wrote 502 `api_error`), a reply cut by it isn't resumed (`continuation.again`), and a translated stream's error says the vendor's type, code and param (`saidError`), so `holdWriter` reads it as the 400 it is. Before, the hold read magpie's `api_error` as a 502: the same request was sent three times, then to the other accounts, and every one rested (magpie-releases#18: the ChatGPT backend answers `access_programs` naming a program the workspace hasn't got with a 200 stream whose error is `access_program_not_enabled`). Asked once, nobody rests ([`codex_access_programs_test.go`](../../internal/gateway/codex_access_programs_test.go)).
 - An error that reaches the agent in a stream already begun can't carry its status, so `streamError` says it in the words (`saysPassing`, #2372, zminds): for a status that may pass (408, 429, 5xx) whose text names none of the words a text-judging agent retries on (Pi decides by its `errorMessage` alone), it appends `(<status>: you can retry your request)`; a request's own fault (400, 401, 404 …) and a text that already says so are left as they were. `TestStreamErrorSaysItPasses` holds Pi's own lists; `TestGroupLastFailureInStreamSaysItPasses` runs a group whose last member fails after the keepalive.
 - Claude's, GPT's and Gemini's reasoning is held (`refusesAfterThinking`, up to `holdThinking`, 4 minutes) so that a refusal after it goes to the next candidate unseen (#248). It is held only while one could: on the last candidate a refusal isn't asked again, so Claude's and GPT's reasoning streams as it comes there, and a refusal after it reaches the agent as the vendor's own. Held there, a lone relay's Claude or GPT showed Claude Code its thinking all at once with the text, and Codex none until then (iTianbao on X). Gemini's stays held on the last candidate too, for a reply that only reasoned to be asked again (#667). Any other model's reasoning is never held.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index a6a49973..fbf023a6 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4478,11 +4478,46 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	// client reads one event it can't parse where the protocol's error was
 	// meant (TestPassthroughStreamCutMidLine)
 	atLine := true
+	// pending is the line the upstream has begun but not ended: a stream
+	// read stops there on a failure, and what of it went out already is
+	// data the client's SSE parser dies on — a half event's JSON doesn't
+	// parse — so the error event appended after it is never reached
+	// (#2580: a stream Z.ai reset mid-line reached pi as "malformed
+	// server-sent event JSON"). Only lines that ended go out as they
+	// come; the half line waits for its rest, unheld puts it out when
+	// the reply ends whole, and dropHalf throws it away when the failure
+	// is appended, for no client can read it and the error is what there
+	// is left to say
+	var pending []byte
 	write := func(b []byte) (int, error) {
-		if len(b) > 0 {
-			atLine = b[len(b)-1] == '\n'
+		if !sse {
+			if len(b) > 0 {
+				atLine = b[len(b)-1] == '\n'
+			}
+			return w.Write(b)
+		}
+		pending = append(pending, b...)
+		i := bytes.LastIndexByte(pending, '\n')
+		var err error
+		if i >= 0 {
+			_, err = w.Write(pending[:i+1])
+			pending = pending[i+1:]
+			atLine = true
+		}
+		return len(b), err
+	}
+	// unheld puts out the half line a whole reply ended inside: it goes
+	// as it came, as a stream the upstream itself ended short
+	unheld := func() {
+		if len(pending) > 0 {
+			w.Write(pending)
+			pending = nil
 		}
-		return w.Write(b)
+	}
+	// dropHalf throws the line still pending away
+	dropHalf := func() {
+		pending = pending[:0]
+		atLine = true
 	}
 	// apart is what goes before an event magpie appends: a blank line,
 	// after the line still pending if the upstream's last write stopped
@@ -4600,7 +4635,10 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	unfinished := proto == provider.Chat && sniff.failed == "" && sniff.u.Stop == "" && saysItsEnd(p, proto, upstream)
 	if fin := sniff.tail.finish(); sse && unfinished && fin != "" && (rerr == nil || rerr == io.EOF) && r.Context().Err() == nil {
 		// only the finish_reason was lost, after the generation was done
-		// (chatTail): the client gets it, and the reply is whole
+		// (chatTail): the client gets it, and the reply is whole. The
+		// event the upstream began and never ended has no rest coming:
+		// dropped, for it is nothing a client can parse
+		dropHalf()
 		w.Write(append(apart(), "data: "+string(finishChunk(fin))+"\n\n"...))
 		if !sniff.ended {
 			w.Write([]byte("data: [DONE]\n\n"))
@@ -4626,9 +4664,11 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			failed = p.Name + ": " + errEndedShort.Error()
 		}
 		if failed != "" {
-			// what is appended begins after a blank line: the event still
-			// pending is left to stand, and the failure is read as an
-			// event of its own (TestPassthroughStreamEndsOnLineEnd)
+			// what is appended begins after a blank line, as an event of
+			// its own (TestPassthroughStreamEndsOnLineEnd); the half
+			// event the upstream left is dropped (#2580): a client
+			// reading it dies on its JSON before the error is reached
+			dropHalf()
 			w.Write(append(apart(), streamFailure(proto, failed)...))
 			if f != nil {
 				f.Flush()
@@ -4636,6 +4676,9 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			return res.StatusCode, failed, true
 		}
 	}
+	if sse {
+		unheld()
+	}
 	return res.StatusCode, sniff.failed, true
 }
 
diff --git a/internal/gateway/passthrough_severed_test.go b/internal/gateway/passthrough_severed_test.go
index 853590c7..2a0dc444 100644
--- a/internal/gateway/passthrough_severed_test.go
+++ b/internal/gateway/passthrough_severed_test.go
@@ -5,6 +5,8 @@ import (
 	"net/http/httptest"
 	"strings"
 	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
 )
 
 // postMessages sends an Anthropic Messages request to the gateway, as dsh's
@@ -24,7 +26,7 @@ func postMessages(t *testing.T, body string) (int, string) {
 // retry and which says nothing of what went wrong (#370).
 func TestPassthroughStreamSeveredUpstream(t *testing.T) {
 	fresh(t)
-	severed(t, anthropicStart, anthropicText)
+	severed(t, provider.Anthropic, anthropicStart, anthropicText)
 	code, body := postMessages(t, `{"model":"up/m","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)
 	if code != 200 {
 		t.Fatalf("status = %d, want 200; body: %s", code, body)
@@ -165,3 +167,34 @@ func TestPassthroughResponsesBigLastEvent(t *testing.T) {
 		t.Fatalf("a whole stream with a big last event was changed: %d, %d bytes added", code, len(body)-len(reply))
 	}
 }
+
+// The upstream reset inside an event (#2580: Z.ai cut a glm-5.3 stream
+// mid-line under pi): the half event went to the client as data, and the
+// client's SSE parser died reading it — "malformed server-sent event
+// JSON" — so the error event magpie appended after it was never reached,
+// and the turn failed without a word of what went wrong. A line the
+// upstream never ended is no event of its own: the client reads the
+// events that were whole and then the error, nothing it has to fail on.
+func TestChatStreamCutMidLineLeavesNoHalfEvent(t *testing.T) {
+	fresh(t)
+	severed(t, provider.Chat, sse(chatThink("glm-5.3", "thinking")),
+		`data: {"id":"c1","model":"glm-5.3","choices":[{"index":0,"delta":{"reasoning_content":"the VM program itself hit an undefined`)
+	code, body := post(t, "/v1/chat/completions", `{"model":"up/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	if !strings.Contains(body, "connection lost mid-reply") {
+		t.Fatalf("a cut Chat stream ended without the error event: %s", body)
+	}
+	if strings.Contains(body, "undefined") {
+		t.Fatalf("a half event the upstream never ended went to the client as data: %s", body[max(0, len(body)-300):])
+	}
+	// every event the client reads parses, the error included: the
+	// stream is one a strict SSE reader goes through to the end of
+	readSSE(strings.NewReader(body), func(_, data string) error {
+		if data != "[DONE]" && !json.Valid([]byte(data)) {
+			t.Errorf("an event the client reads is no JSON: %q", data)
+		}
+		return nil
+	})
+}
diff --git a/internal/gateway/stream_cut_test.go b/internal/gateway/stream_cut_test.go
index 8a534ee2..a146ea97 100644
--- a/internal/gateway/stream_cut_test.go
+++ b/internal/gateway/stream_cut_test.go
@@ -41,7 +41,7 @@ func TestStreamCutSaysConnection(t *testing.T) {
 	if err := provider.Save(provider.Provider{ID: "go", Name: "OpenCode Go", Key: "k", Models: []string{"m"}, Chat: up.URL + "/v1"}); err != nil {
 		t.Fatal(err)
 	}
-	severed(t, anthropicStart, anthropicText) // up/m, spoken to in Messages: the reply translated
+	severed(t, provider.Anthropic, anthropicStart, anthropicText) // up/m, spoken to in Messages: the reply translated
 
 	cases := []struct{ model, name string }{{"go/m", "OpenCode Go"}, {"up/m", "UP"}}
 	var wg sync.WaitGroup
diff --git a/internal/gateway/translate_severed_test.go b/internal/gateway/translate_severed_test.go
index a947f353..b0d687f6 100644
--- a/internal/gateway/translate_severed_test.go
+++ b/internal/gateway/translate_severed_test.go
@@ -14,7 +14,7 @@ import (
 // severed speaks HTTP until it doesn't: it writes headers that promise more
 // body than it sends, delivers the events given, then closes the connection.
 // The client's stream read fails the way an upstream dying mid-reply fails.
-func severed(t *testing.T, events ...string) {
+func severed(t *testing.T, proto provider.Protocol, events ...string) {
 	t.Helper()
 	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
 		io.ReadAll(r.Body)
@@ -33,7 +33,13 @@ func severed(t *testing.T, events ...string) {
 		buf.Flush()
 	}))
 	t.Cleanup(up.Close)
-	p := provider.Provider{ID: "up", Name: "UP", Key: "k", Models: []string{"m"}, Anthropic: up.URL}
+	p := provider.Provider{ID: "up", Name: "UP", Key: "k", Models: []string{"m"}}
+	switch proto {
+	case provider.Chat:
+		p.Chat = up.URL + "/v1"
+	default:
+		p.Anthropic = up.URL
+	}
 	if err := provider.Save(p); err != nil {
 		t.Fatal(err)
 	}
@@ -54,7 +60,7 @@ const (
 // upstream died, as if the reply were whole.
 func TestTranslateBufferedSeveredUpstream(t *testing.T) {
 	fresh(t)
-	severed(t, anthropicStart, anthropicText)
+	severed(t, provider.Anthropic, anthropicStart, anthropicText)
 	code, body := postAs(t, New(), "", `{"model":"up/m","messages":[{"role":"user","content":"hi"}]}`)
 	if code != 502 {
 		t.Fatalf("status = %d, want 502; body: %s", code, body)
@@ -68,7 +74,7 @@ func TestTranslateBufferedSeveredUpstream(t *testing.T) {
 // [DONE] - over a reply the upstream never finished.
 func TestTranslateStreamSeveredUpstream(t *testing.T) {
 	fresh(t)
-	severed(t, anthropicStart, anthropicText)
+	severed(t, provider.Anthropic, anthropicStart, anthropicText)
 	code, body := postAs(t, New(), "", `{"model":"up/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
 	if code != 200 {
 		t.Fatalf("status = %d, want 200; body: %s", code, body)
-- 
2.50.1 (Apple Git-155)

```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
