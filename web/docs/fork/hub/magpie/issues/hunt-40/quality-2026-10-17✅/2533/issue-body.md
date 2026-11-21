# 待发布标题：流头先发出的 413 保留 request_too_large，供 Pi 识别字节上限

本稿仅完成本地完善，尚未发布。补丁基于当前已核验的 main `6f950653fcdb46c73044a071328cdc508f12ccef`，不是旧分支 `13b4d139` 的重发。

## 问题来源与现象

本单是对已有 413/Pi 报告的代码路径追踪；本轮沿用原提交的 nginx 413 HTML 样本，构造厂商延迟到网关先发保活后再返回 413。样本不是本轮真实厂商录包。

流头还未发出时，`writeErrorSaid` 已给 JSON 413 标记 `request_too_large`。先发了 HTTP 200 和 keepalive 后，状态已不能改，旧 `streamError` 只传 `A: 413 Request Entity Too Large`。真实 Pi 1.2.0 的 Chat SDK 将其读成 `stopReason=error`，其原版 `isContextOverflow` 返回 `false`。

**纠正旧描述**：Pi 并非只认 `request_too_large` 一个词；它有多种溢出模式。本样本的 `Request Entity Too Large` 没有命中，而补上语义明确的字节上限标记后可以命中。

## 最小修复与影响范围

- `gateway.streamError` 仅给非上下文过长的 413、非 Gemini 输出追加一次 `(request_too_large)`。
- Chat/Anthropic 的同一错误类型为 `request_too_large`；Responses 保留自己的 `response.failed` 外层形状，文本携带标记。
- token 上下文错误仍带 `context_length_exceeded`，普通 400 不增加字节标记。Gemini 没有静默期保活，仍按原 HTTP/JSON 413 形状返回。

补丁没有重构、依赖升级、账户重试或计费行为变更，也没有伪造新 commit。旧 patch 在当前 main 的 `chat.go` import 上重放失败；下附更新后的 unified patch 已在独立 main archive 上实际 clean apply、逆向回滚并核对源码哈希。

## 已执行的本地验证

用户确认的接缝是 **网关 Handler 的 HTTP/SSE 输出 → Pi 的真实错误处理**。Go 测试让假厂商等到客户端真正收到 HTTP 200 后才返回失败，不靠任意 sleep 猜顺序；每次请求带 10 秒终止边界。

1. 新测试先在旧产品代码上失败。全部三个产品文件消融后，Chat/Anthropic/Responses 的三个字节上限分支均真实 FAIL；token 上下文、普通 400、Gemini 护栏均 PASS。恢复产品文件后，同一组测试 PASS（1.347s，exit 0）。
2. 三协议 × 字节/token/普通错误，共 9 份网关原始 SSE，交给本机已安装且版本锁定为 `@earendil-works/pi-coding-agent@1.2.0` 与 `pi-ai@1.2.0` 的真实 SDK 通过本地 HTTP 回放消费。实际 `errorMessage` 进入原版 `isContextOverflow`：字节上限 3/3 为 true、token 错误 3/3 为 true、普通错误 3/3 为 false。消融输出的字节上限 3/3 为 false。不是复制一段正则充当 Pi。
3. 新测试及相邻错误形状/重试提示测试 PASS（2.765s，exit 0）；新测试 `-race` PASS（2.589s，exit 0）；触达 Go 文件 `gofmt -l` 无输出（exit 0）。
4. 第二份 archive 上执行真实 apply → `ROLLBACK.sh` → 源码 SHA256 比对 PASS。回滚后的同一回归探针恢复旧字节上限失败（1.503s，exit 1，预期），随后移除临时探针。工作副本仍保留修复。

精确命令、输入、原始 stdout/stderr、退出码、Pi 版本/实际源文件路径/哈希和 SSE 文件保存在本地 `verification.json` 与 `logs/`。回归可用：

```sh
GOTOOLCHAIN=auto go test -tags nogui -count=1 -p 2 -timeout 4m -run '^Test(StreamedByteCap|PayloadTooLargeSaysRequestTooLargeToPi|StreamErrorSaysItPasses|GroupLastFailureInStreamSaysItPasses|ContextOverflowSaidTheClientsWay|BodyRejectionErrorShapes)' ./internal/gateway
GOTOOLCHAIN=auto go test -race -tags nogui -count=1 -p 2 -timeout 3m -run '^TestStreamedByteCap' ./internal/gateway
```

## 尚未完成的验收

本轮证明的是**真实 Pi SDK 对网关错误的识别**，没有把真实厂商发来的字节拒绝、Pi 自动摘要压缩成功、再次请求并得到回答整个闭环跑完；不能写成“Pi 已保证自动压缩成功”。压缩还受客户端设置、会话状态与摘要请求是否成功影响。其他 Pi 版本没有测试。

四份补丁叠在同一副本上的 `go test -tags nogui ./...` 已跑完，退出码 1。`internal/gateway` 通过；`internal/gui` 的 `TestProxyCheckSaysAProxyPassedBy` 失败。记录在 [组合结果](../integration/RESULT.md)。这不是全仓通过，也不代替 `go vet` 和三平台构建。本次没有运行真实厂商/用户账户，没有更改线上网关。

AI 协作披露：原提交由 AI 辅助生成；本轮由 Codex 辅助重放、修正断言、扩展 HTTP/SSE 回归并运行真实 Pi SDK 核验。提交者仍需逐项解释补丁和验证边界。

<details><summary>更新后的 unified patch（应用于 6f950653）</summary>

```diff
diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -109,7 +109,7 @@
 - A 2xx from Zhipu or Z.ai holding the platform's refusal envelope (`{"code":1000,"msg":…,"success":false}`, which their Responses API at `/api/v1` answers a refused key) is the refusal it stands for (`provider.ZhipuEnveloped` in `forwardOnce`): 401 for a key refused, 429 for a limit or no balance, as Zhipu's error codes give, so it fails over and rests as those do and the agent is told why. `TestZhipuResponsesRefusalIsRefusal`.
 - A streamed request is never left silent while its vendor says nothing. `holdWriter.watch` runs beside each try: past `keepHeldAfter` (15s) it sends a held try's agent the stream's 200 and SSE comments (`keepAlive`), none of the try, so another candidate may still answer in the same stream; once the reply passes, it puts a comment between two of its lines after `keepaliveEvery` of quiet. It stops after `keepaliveLongest` (5 minutes) with nothing from the vendor. A try waiting for its key's or account's slot or for room in its minute (`lanes.take`, `rpms.wait`) is kept alive the same way (`keepQueued`), for as long as it waits; once the 200 is out, the try is held, and its failure or its queue turning it away reaches the agent as the stream's error (`failTo`), not a status (coeo91 on Discord). A wait shorter than `keepHeldAfter` sends nothing, so its 429 keeps its `Retry-After`. A proxy in front such as Cloudflare (125s) otherwise ends the request (#947). Gemini streams get no comments (#934). A vendor that then ignores `stream:true` and answers 200 with its reply whole has it sent as the agent's stream (`wholeAsStream`: Chat, Responses, Anthropic), not as the stream's error, while a reply under a type that says neither JSON nor a stream is held as a stream when its first bytes are one (`sseStart`), read event by event like one that says so, so an error among its frames still goes to the next candidate (#1418: it went through at once); a 200 that is no reply of the protocol's fails as a translated reply that didn't stream does (502, "… did not stream"), for the next candidate to answer, and the last one's reaches the agent as the stream's error. A held stream that has sent nothing but the frames before a reply (`response.created`, `response.in_progress`, `codex.rate_limits`, pings, an empty part begun, and any event `streamEvent` doesn't know to carry text, reasoning, a call or a reply's end (`replyEvent`), or an item not known that isn't a call or a tool's (`streamPart.said`): `eventLead`; Aliceonly on #1418: an unknown event was taken for content and let a frames-only 200 through, and its `server_is_overloaded` reached Codex with five candidates left) stays held as long as its agent is kept alive, up to `holdLead` (4 minutes, under the 300s Codex waits for an event; `keptQuiet`), so a `server_is_overloaded` that comes after it is a failure the next candidate answers (#1418: let through at 15s, the ChatGPT backend's failure 36s in ended Codex's turn with sub2api, next in the group, never asked). A stream whose agent can't be kept alive (Gemini's) is let through after `holdLongest` (15s), as before. Codex counts only events toward that 300s, not comments, so the bound is the request's, not each try's: once Codex on Responses has heard no event for `agentQuietMost` (4 minutes) since the request began or its last event (`keptAlive.tooQuiet`), the try in hand is let through (`scan`, `keepQuiet`), and no group replan or same-one retry is taken whose pause would end past it (fadenoob on Discord: held tries and replan pauses added up past 300s and Codex reconnected on "idle timeout waiting for SSE"). A translated reply whose upstream stream stops before it said its reply had — an Anthropic one with no stop_reason and no message_stop, a Responses one with no `response.completed`, the same two a relayed one is told by (`sniff.whole`; a Chat stream may end without `[DONE]` and be whole), a Gemini or Code Assist one whose last chunk has no candidate's `finishReason` (`geminiEnds`, #1643: `usageMetadata` is no end, Vertex AI sends it on every chunk; a chunk with no candidate at all is the empty reply's to answer, #667), and a relayed Gemini one told the same way (#1644; it ends in Gemini's own `{"error":{"code":502,…,"status":"UNAVAILABLE"}}` data line from `streamFailure`, `TestGeminiRelayEndedShort`; whatever a relayed stream gets appended, that error or a filled-in `finish_reason`, begins after a blank line, two newlines when the upstream's last write stopped inside a line, so it is an event of its own rather than more of the half-written one, #2446, `TestPassthroughStreamCutMidLine`, `TestGeminiCompatFinishAfterPartialLine`), and a Chat one from Gemini's OpenAI-compatible API (`geminiCompat`) with no `finish_reason`, relayed or translated (`saysItsEnd`; Linka on Discord: the upstream hung up between a whole function call and its `finish_reason`, and Pi threw the call away as "Stream ended without finish_reason"; that API counts the usage only once the generation is done, so when the last chunk carried it only the `finish_reason` was lost and it is filled in, `tool_calls` after a call and `stop` otherwise, as a relayed chunk before `[DONE]` or a translated reply's end, and the reply counts as whole (`chatTail`); only one with no usage at its end is a cut, `TestGeminiCompatRelayEndedShort`, `TestGeminiCompatTranslatedEndedShort`) — ends the turn with "the reply ended before it was complete" (`errEndedShort`, `TestResponsesUpstreamEndedShort`, `TestGeminiUpstreamEndedShort`), asked again in place where the upstream goes on from a prefill (`continuation.go`). A client that asked for no stream is told the same 502 of such a cut (`translate`, `TestNonStreamEndedShort`, `TestGeminiNonStreamEndedShort`), rather than handed what came as its whole reply. A translated reply from an Anthropic or Responses upstream that ended but said nothing (no text, call, search or image) and counted no token at all is no reply either, whatever its end says (`repliesCounted`, #2086: an Anthropic-compatible proxy's 200 ended a Codex turn as `response.completed` with no output, no usage and no served model, and Codex didn't ask again). It is the empty reply's to answer (#667): asked again in place, then failed with "an empty reply", streamed or not, for every client (`TestUncountedEmptyReplyFails`, `TestUncountedEmptyReplyFailsEveryClient`). Claude's own empty `end_turn` counts its prompt and stays a whole reply (`TestWellFormedStreamsStillComplete`). A reply passed through in its own protocol isn't read this way.
 - A vendor's error keeps its `code` and `param` on its way to an OpenAI-shaped client (`writeVendorError`), where `writeError` used to set both to null: a status error relayed or translated, and a request refused inside a Responses stream. A Responses stream's `error` event or failed response whose error is of type `invalid_request_error` is the request at fault (`requestRefused`, read by its type, not its words): its `Event` carries status 400 and the vendor's error (`Event.Said`), so a client answered whole gets the vendor's 400 with its code and param (the whole-translated path wrote 502 `api_error`), a reply cut by it isn't resumed (`continuation.again`), and a translated stream's error says the vendor's type, code and param (`saidError`), so `holdWriter` reads it as the 400 it is. Before, the hold read magpie's `api_error` as a 502: the same request was sent three times, then to the other accounts, and every one rested (magpie-releases#18: the ChatGPT backend answers `access_programs` naming a program the workspace hasn't got with a 200 stream whose error is `access_program_not_enabled`). Asked once, nobody rests ([`codex_access_programs_test.go`](../../internal/gateway/codex_access_programs_test.go)).
-- An error that reaches the agent in a stream already begun can't carry its status, so `streamError` says it in the words (`saysPassing`, #2372, zminds): for a status that may pass (408, 429, 5xx) whose text names none of the words a text-judging agent retries on (Pi decides by its `errorMessage` alone), it appends `(<status>: you can retry your request)`; a request's own fault (400, 401, 404 …) and a text that already says so are left as they were. `TestStreamErrorSaysItPasses` holds Pi's own lists; `TestGroupLastFailureInStreamSaysItPasses` runs a group whose last member fails after the keepalive.
+- An error that reaches the agent in a stream already begun can't carry its status, so `streamError` says it in the words (`saysPassing`, #2372, zminds): for a status that may pass (408, 429, 5xx) whose text names none of the words a text-judging agent retries on (Pi decides by its `errorMessage` alone), it appends `(<status>: you can retry your request)`; a request's own fault (400, 401, 404 …) and a text that already says so are left as they were. `TestStreamErrorSaysItPasses` holds Pi's own lists; `TestGroupLastFailureInStreamSaysItPasses` runs a group whose last member fails after the keepalive. A 413 byte cap after that keepalive also says `request_too_large` in its text, and Chat and Anthropic use that error type; Responses keeps its own error envelope. A token context overflow keeps `context_length_exceeded`, ordinary invalid requests get no byte-cap marker, and Gemini keeps its own HTTP/JSON shape, with no quiet-period keepalive (`TestStreamedByteCapErrorShapes`, `TestStreamedByteCapLeavesGeminiShape`). The marker lets Pi's error consumer identify the byte cap; a successful compaction and retry still depend on the client's settings and summarization request.
 - Claude's, GPT's and Gemini's reasoning is held (`refusesAfterThinking`, up to `holdThinking`, 4 minutes) so that a refusal after it goes to the next candidate unseen (#248). It is held only while one could: on the last candidate a refusal isn't asked again, so Claude's and GPT's reasoning streams as it comes there, and a refusal after it reaches the agent as the vendor's own. Held there, a lone relay's Claude or GPT showed Claude Code its thinking all at once with the text, and Codex none until then (iTianbao on X). Gemini's stays held on the last candidate too, for a reply that only reasoned to be asked again (#667). Any other model's reasoning is never held.
 - A streamed reply stuck in a loop is ended, not let run to its output limit (#1359, Moody-Sin: WorkBuddy's DeepSeek v4.1 flash reasoned round "Now." "Writing." "Go." "Let me write." "OK." until max tokens while dsh and Pi waited). `holdWriter.Write` feeds every streamed try, passed through or translated, a key's, a built-in subscription's or a plugin's (a moved WorkBuddy's fetch in the plugin host, `TestLoopEndsWorkBuddysReply`), in each of the agent's protocols, to a `loopGuard` ([`loop_guard.go`](../../internal/gateway/loop_guard.go)). It cuts the reasoning and the text, each apart, into units, its lines and sentences (a list's `1.` or a decimal is no sentence's end), compared without case or a closing stop. A unit with no word in it (a letter run with no digit: not a brace, a rule, `0x00`, a hash or a row of numbers) isn't counted. When the last `loopWindow` (256) counted units of either are among no more than `loopDistinct` (24) different ones, the try is cut (`cutLoop`): what came with that write goes out, then, after a blank line (two newlines when that write stopped inside a line, `holdWriter.atLine`, #2446), the protocol's stream error (`streamError`, 502) naming the loop and quoting its units, and the vendor's request is cancelled. It falls back to nobody and rests nobody (`failLoop`); its usage record's error type is `reply_loop` (`usage.LoopErrType`), and Usage counts them per model (`Totals.Loops`), as "{n} looped" beside the model's failures in the Overview's rows and the Requests ranking (#1858, `TestLoopsCountedPerModel`, `usage-loops.test.cjs`). A reply magpie translates into the agent's protocol (`streamTranslated`) whose *reasoning* loops before it has said a text or a call, and isn't a continuation, is asked again once in place instead (`loopReasks`, through `holdWriter.onLoop`; cdredfox on X, WorkBuddy AI's DeepSeek v4 flash): the agent keeps the reasoning it has, the next try's follows it in the same stream, as an empty reply's re-ask does (#667), and only a loop on that try ends the reply with the error (`TestReasoningLoopIsAskedAgain`). A reply passed through in the agent's own protocol is asked again once too, at the fallback loop (`holdWriter.mayReloop`, `letGoLoop`; #2436, lqisgod: pi's Chat stream to WorkBuddy was cut at once): when nothing of the try has reached the agent yet, in any protocol, its held bytes are dropped; when its reasoning is already passing, only a Chat stream goes on, written up to the end of the tripping event, with the next try's chunks after it. An Anthropic or Responses stream already passing still ends with the error, since a second `message_start` or `response.created` can't follow. Each re-ask, in place or at the fallback loop, counts in the usage record's tries. A loop in the text, or after a text or call, is ended at once (`TestLoopAfterTextIsNotAskedAgain`). A cycle need not be exact. Code, tables, lists, logs, CSV and base64 differ line to line or have no words, and don't trip it (`TestLoopGuardLeavesOrdinaryRepliesAlone` feeds magpie's own sources and docs through it). A reply sent whole (no stream, or Gemini without `alt=sse`) isn't read. Settings › Models › Replies › *Stop looping replies* (`noLoopGuard`) turns it off.
 - A Chat request's earlier turns carry the assistant's thinking back in the spelling its own client used: `reasoning_content` (DeepSeek's, which OpenCode and most clients send), `reasoning` (OpenRouter's) or `reasoning_details` (OpenRouter's structured one). A request translated to a non-Chat upstream reads whichever of the three the turn has, in that order, as the turn's thinking (`messageReasoning`, `reasoningText`, read by `parseChat` in [chat.go](../../internal/gateway/chat.go)); the passthrough has read all three since `mistralThinking` (#494), which was the one place that did. Before that the parse layer read `reasoning_content` alone, so a tool-calling session whose client spelled it another way went on from its second turn without the model's own reasoning.
diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -6,6 +6,7 @@
 	"encoding/base64"
 	"encoding/json"
 	"fmt"
+	"net/http"
 	"regexp"
 	"slices"
 	"strconv"
@@ -1522,7 +1523,11 @@
 		e.index++
 	case KError:
 		e.close()
-		failed := map[string]any{"type": "api_error", "message": ev.Text}
+		typ := "api_error"
+		if ev.Status == http.StatusRequestEntityTooLarge && ev.Code != "context_length_exceeded" {
+			typ = "request_too_large"
+		}
+		failed := map[string]any{"type": typ, "message": ev.Text}
 		if ev.Code != "" {
 			failed["code"] = ev.Code // preserve the upstream error type, including refusals
 		}
diff --git a/internal/gateway/chat.go b/internal/gateway/chat.go
--- a/internal/gateway/chat.go
+++ b/internal/gateway/chat.go
@@ -8,6 +8,7 @@
 	"maps"
 	"mime"
 	"net"
+	"net/http"
 	"path"
 	"regexp"
 	"slices"
@@ -1347,7 +1348,11 @@
 				"function": map[string]any{"arguments": ev.Text}}}}, nil, nil)
 		}
 	case KError:
-		failed := map[string]any{"message": ev.Text, "type": "api_error"}
+		typ := "api_error"
+		if ev.Status == http.StatusRequestEntityTooLarge && ev.Code != "context_length_exceeded" {
+			typ = "request_too_large"
+		}
+		failed := map[string]any{"message": ev.Text, "type": typ}
 		if ev.Code != "" {
 			failed["code"] = ev.Code // preserve the upstream error type, including refusals
 		}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6474,6 +6474,9 @@
 	ev := Event{Kind: KError, Text: saysPassing(status, msg), Status: status}
 	if tooLong(status, msg) {
 		ev.Code = "context_length_exceeded"
+	} else if status == http.StatusRequestEntityTooLarge && proto != provider.Gemini && !strings.Contains(strings.ToLower(ev.Text), "request_too_large") {
+		// Pi 只拿错误文本判断溢出；字节上限沿用 JSON 413 的名称。
+		ev.Text += " (request_too_large)"
 	}
 	makeEncoder(proto, sw, &Request{}).event(ev)
 }
diff --git a/internal/gateway/stream_byte_cap_test.go b/internal/gateway/stream_byte_cap_test.go
new file mode 100644
--- /dev/null
+++ b/internal/gateway/stream_byte_cap_test.go
@@ -0,0 +1,122 @@
+package gateway
+
+import (
+	"context"
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// HTTP 200 必须先于厂商的失败到达，随后 SSE 仍须区分字节上限、
+// token 上下文上限与普通坏请求。测试观察真实 Handler 的 HTTP 输出。
+func TestStreamedByteCapErrorShapes(t *testing.T) {
+	const nginx = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"
+	for _, failure := range []struct {
+		name, contentType, body string
+		status                  int
+	}{
+		{"byte", "text/html", nginx, 413},
+		{"context", "application/json", `{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum","type":"invalid_request_error","code":"context_length_exceeded"}}`, 413},
+		{"ordinary", "application/json", `{"error":{"message":"invalid tool schema","type":"invalid_request_error"}}`, 400},
+	} {
+		for _, client := range []struct {
+			name, path, request string
+		}{
+			{"chat", "/v1/chat/completions", `{"model":"a/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`},
+			{"anthropic", "/v1/messages", `{"model":"a/m","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`},
+			{"responses", "/v1/responses", `{"model":"a/m","stream":true,"input":"hi"}`},
+		} {
+			t.Run(failure.name+"/"+client.name, func(t *testing.T) {
+				fresh(t)
+				quietFast(t)
+				release := make(chan struct{})
+				up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+					io.Copy(io.Discard, r.Body)
+					select {
+					case <-release:
+					case <-r.Context().Done():
+						return
+					}
+					w.Header().Set("Content-Type", failure.contentType)
+					w.WriteHeader(failure.status)
+					io.WriteString(w, failure.body)
+				}))
+				t.Cleanup(up.Close)
+				if err := provider.Save(provider.Provider{ID: "a", Name: "A", Key: "k", Models: []string{"m"}, Chat: up.URL + "/v1"}); err != nil {
+					t.Fatal(err)
+				}
+				gw := httptest.NewServer(New().Handler())
+				t.Cleanup(gw.Close)
+				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
+				defer cancel()
+				req, err := http.NewRequestWithContext(ctx, http.MethodPost, gw.URL+client.path, strings.NewReader(client.request))
+				if err != nil {
+					t.Fatal(err)
+				}
+				req.Header.Set("Content-Type", "application/json")
+				resp, err := http.DefaultClient.Do(req)
+				close(release)
+				if err != nil {
+					t.Fatal(err)
+				}
+				defer resp.Body.Close()
+				body, err := io.ReadAll(resp.Body)
+				if err != nil {
+					t.Fatal(err)
+				}
+				// 保留网关原始字节，供真实 Pi SDK 离线重放；不复制 Pi 的正则。
+				if err := os.WriteFile(filepath.Join(t.ArtifactDir(), failure.name+"-"+client.name+".sse"), body, 0o600); err != nil {
+					t.Fatal(err)
+				}
+				if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), ": keepalive") {
+					t.Fatalf("headers did not precede the failure: %d %s", resp.StatusCode, body)
+				}
+				type apiError struct{ Type, Message, Code string }
+				var failed apiError
+				for line := range strings.SplitSeq(string(body), "\n") {
+					if !strings.HasPrefix(line, "data: ") {
+						continue
+					}
+					var frame struct {
+						Error    apiError
+						Response struct{ Error apiError }
+					}
+					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame); err != nil {
+						t.Fatal(err)
+					}
+					if client.name == "responses" {
+						frame.Error = frame.Response.Error
+					}
+					if frame.Error.Message != "" {
+						failed = frame.Error
+					}
+				}
+				byteCap := failure.name == "byte"
+				if failed.Message == "" || strings.Contains(failed.Message, "request_too_large") != byteCap || (failed.Code == "context_length_exceeded") != (failure.name == "context") {
+					t.Fatalf("failure class changed: %d %s", resp.StatusCode, body)
+				}
+				if client.name != "responses" && (failed.Type == "request_too_large") != byteCap {
+					t.Fatalf("byte cap error type changed: %d %s", resp.StatusCode, body)
+				}
+			})
+		}
+	}
+}
+
+// Gemini 不接收静默期保活；相同字节拒绝仍保持原来的 HTTP/JSON 形状。
+func TestStreamedByteCapLeavesGeminiShape(t *testing.T) {
+	fresh(t)
+	scriptedOn(t, "a", provider.Chat, &scripted{replies: []reply{{413, "text/html", "<h1>413 Request Entity Too Large</h1>"}}})
+	code, body := postTo(t, New(), "/v1beta/models/a/m:streamGenerateContent?alt=sse", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)
+	if code != 413 || !strings.Contains(body, `"status":"INVALID_ARGUMENT"`) || strings.Contains(body, "request_too_large") || strings.Contains(body, "context_length_exceeded") {
+		t.Fatalf("Gemini byte cap shape changed: %d %s", code, body)
+	}
+}
```

</details>
