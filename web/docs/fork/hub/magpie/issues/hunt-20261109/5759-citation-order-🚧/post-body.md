@FunJim — thank you for the wire capture; it left nothing to guess. The order swap is magpie's own: a text block that a relay holds while it looks for a call written into its text lets the block's `citations_delta` out before its held `content_block_start`, and Claude Code — like its log says — reads a delta for a block it never saw start as a stream cut short and finalizes there ("The search was cut off before any results arrived"). This is the third order fault on the same hold/release path, after #4874 (a start lost when a tool block begins before the stop) and #5439 (a released start under the wrong `event:` name).

**Root cause** (`internal/gateway/textcalls_anthropic.go`, `anthropicTextCalls.event`, the `content_block_delta` branch): the branch's guard was `if !t.text || index != t.idx || d.Type != "text_delta" { return ev }`. An empty text block's start is held in `startHeld` while the relay reads the text for written calls; a `citations_delta` of that block passes the first two tests but not the third, so it went out as it came — with its block's start still held, to be released only by the block's `content_block_stop`. OpenRouter's searched reply is exactly the shape that triggers this: a `server_tool_use`, then a text block whose start says `"text": ""` and whose only deltas are citations, then the answer's text block.

**The fix**: the guard keeps only the block tests, and a delta of the held block that is not `text_delta` — a citation, or any other delta of it — hands on the held start first, the way the block's first `text_delta` with text already does. The hold itself stays: an empty text block is still read for a call written into it, and a citations-only block holds nothing after its first delta, so its stop, answer and `message_delta` follow as before. The branch is entered by deltas of the held block alone — for every other delta the path is the same two tests as before, no added cost on the hot path.

Sibling-face scan of the same hold/release path, each point left as it is, with its reason:

- the `text_delta` release (`textcalls_anthropic.go:128`, after this change): already hands the held start on before the block's first text goes; untouched.
- the `content_block_stop` release (`:139`): for a cited block the start is already gone by then (`startHeld` nil, no duplicate); for a block that held its start with no delta at all it stays the only release point; untouched.
- the `message_delta` written-calls branch (`:150` rest-text release, `:155` whole block replaced by tool_use blocks): a citations-only block carries no text, so `parseTextCalls` never sees one as a written call; untouched.
- `release()` (`:196`): the catch-all; a start the new branch handed on is nil there, so nothing is sent twice; untouched.
- citations emitters outside this file: `whole_stream.go` `responsesWholeEvents` (annotations sent after the item and part they belong to, same function, in order) and `anthropic.go` `sayCited` (`openBlock` first, `citations_delta` after, no hold between) — both emit their own starts immediately; untouched.
- the Chat Completions and Responses relays (`textcalls.go` `textCallTidy`, `textcalls_relay.go` `responsesTextCalls`): protocols without a `content_block_start`/`citations_delta` pairing, nothing to order; untouched.

Failure-to-read semantics: an unreadable `delta` decodes as the zero struct, which is not `text_delta`, so the held start goes first and the unreadable event passes as it came — the order guarantee holds and nothing is swallowed. A start already released makes the new branch a plain pass-through (`append(nil, ev...)`).

**Verification**:

- `TestAnthropicTextCallsCitationFollowsItsBlockStart` (new): replays the wire capture — `server_tool_use` with its `input_json_delta`, the empty cited text block with two `citations_delta`, the answer's text block — fed whole, in events, in lines, in bytes and with CRLF. Red on the parent (`dae104bfa`'s tree) in all five: `block 1 got a delta while block -1 was open`, the test-side name of what Claude Code logs. Green with the change.
- Ablation: with only `textcalls_anthropic.go` reverted to the parent (test kept), the new test fails again as above; restored, it passes. The mutation sits on the guard line that lets the citation through, which is the line where the order goes wrong.
- `gofmt -l` clean; `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` clean; `go build` on darwin, linux (nogui) and windows clean.
- `go test -tags nogui -count=1 ./internal/gateway -run 'TestAnthropicTextCalls|TestAnthropicMessagesSSEChunksKeepFraming|TestTextWritten|TestInvokeReported|TestDSML|TestGLMTextCall|TestQuietWholeReplyStreamed'` ok (20s).
- the whole gateway package (`go test -tags nogui -count=1 -timeout 30m ./internal/gateway`) ok (1077s, `TestLaneLimitRoutes` included). At go's default 10m per-package cap this machine tonight can't finish the package (timeout panic at 600s both in the full run and alone, zero failing assertions before it) — the cap, not a red.
- Not run / environment: the rest of the full `-tags nogui ./...` suite beyond the gateway package was not completed tonight — `internal/agent`, `internal/gui` and `internal/plugin` each hit the same 10m cap under the machine's load, and within them three known local reds unrelated to this change fail as they always do (`TestMothX`, `TestProxyCheckSaysAProxyPassedBy`, local proxy :7897) and `TestHostToldTheGatewayAddress` fails identically on the unpatched parent (`07a06617e`) — machine, not patch. The end-to-end run through Claude Code's `WebSearch` (issue's Verification) is NOT-RUNNABLE here: no OpenRouter key in this sandbox; the fixture replays the captured stream instead.

<details><summary>patch: gateway: a held text block's citations go after its content_block_start — git am applies it as is; SHA-256 first 16: 9bf4f4ff302b6edd</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:09:06 +0800
Subject: [PATCH] gateway: a held text block's citations go after its
 content_block_start (#5759)

A relayed Messages stream holds an empty text block's start while it
looks for a call written into the text. Its content_block_delta branch
handed on any delta that was not text_delta as it came, start still
held: OpenRouter's searched reply writes a text block that carries only
citations_delta and no text, so the citations reached the client before
the block's start. Claude Code reads a delta for a block it never saw
start as a stream cut short and ends the reply ("The search was cut off
before any results arrived").

A delta of the held block that is not text_delta now hands on the held
start first, as the first text_delta of it always did.
---
 internal/gateway/textcalls_anthropic.go       | 13 +++-
 .../textcalls_anthropic_chunks_test.go        | 73 ++++++++++++++++++-
 2 files changed, 84 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/textcalls_anthropic.go b/internal/gateway/textcalls_anthropic.go
index de352c63b..fc23c60da 100644
--- a/internal/gateway/textcalls_anthropic.go
+++ b/internal/gateway/textcalls_anthropic.go
@@ -107,9 +107,20 @@ func (t *anthropicTextCalls) event(ev []byte) []byte {
 			Text string `json:"text"`
 		}
 		decodeJSON(m["delta"], &d)
-		if !t.text || index != t.idx || d.Type != "text_delta" {
+		if !t.text || index != t.idx {
 			return ev
 		}
+		if d.Type != "text_delta" {
+			// a citation of the held block (OpenRouter's searched reply
+			// writes a text block that carries only citations_delta, no
+			// text): its start goes before any delta of it — a client
+			// reads a delta for a block it never saw start as a stream
+			// cut short, and Claude Code ends the search there ("The
+			// search was cut off before any results arrived", #5759)
+			out := t.startHeld
+			t.startHeld = nil
+			return append(out, ev...)
+		}
 		s := t.pending + d.Text
 		t.pending = ""
 		if t.holding {
diff --git a/internal/gateway/textcalls_anthropic_chunks_test.go b/internal/gateway/textcalls_anthropic_chunks_test.go
index 24b0e4614..ad286d18d 100644
--- a/internal/gateway/textcalls_anthropic_chunks_test.go
+++ b/internal/gateway/textcalls_anthropic_chunks_test.go
@@ -113,6 +113,53 @@ data: {"type":"message_stop"}
 
 `
 
+// citedAnthropicStream is a Messages reply the way OpenRouter's Messages
+// endpoint writes one for a model that searched with web_search_20250305:
+// the search's call, a text block that carries only its citations (its
+// start says "text": "" and no text follows it), then the answer in
+// another text block. The cited block's empty start is what the relay
+// holds while it looks for a call written into the text.
+const citedAnthropicStream = `event: message_start
+data: {"type":"message_start","message":{"id":"msg_cited","type":"message","role":"assistant","model":"relay-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":30,"output_tokens":1}}}
+
+event: content_block_start
+data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"call_01","name":"web_search","input":{}}}
+
+event: content_block_delta
+data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"Tokyo current time\"}"}}
+
+event: content_block_stop
+data: {"type":"content_block_stop","index":0}
+
+event: content_block_start
+data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"","citations":[]}}
+
+event: content_block_delta
+data: {"type":"content_block_delta","index":1,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://www.timeanddate.com/worldclock/japan/tokyo","title":"Current Local Time in Tokyo, Japan","cited_text":"Monday, November 9, 2026"}}}
+
+event: content_block_delta
+data: {"type":"content_block_delta","index":1,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://time.is/Tokyo","title":"Time in Tokyo, Japan now","cited_text":"Monday, November 9, 2026"}}}
+
+event: content_block_stop
+data: {"type":"content_block_stop","index":1}
+
+event: content_block_start
+data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}
+
+event: content_block_delta
+data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"It is 12:00 in Tokyo."}}
+
+event: content_block_stop
+data: {"type":"content_block_stop","index":2}
+
+event: message_delta
+data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9}}
+
+event: message_stop
+data: {"type":"message_stop"}
+
+`
+
 type anthropicSSEChunk struct {
 	Type         string `json:"type"`
 	Index        int    `json:"index"`
@@ -223,7 +270,7 @@ func checkAnthropicStream(t *testing.T, frames []anthropicSSEFrame, wantBlocks [
 			}
 			open, next = f.chunk.Index, next+1
 			blocks = append(blocks, f.chunk.ContentBlock.Type)
-			if f.chunk.ContentBlock.Type == "tool_use" {
+			if f.chunk.ContentBlock.Type == "tool_use" || f.chunk.ContentBlock.Type == "server_tool_use" {
 				tools = append(tools, &toolBlock{id: f.chunk.ContentBlock.ID, name: f.chunk.ContentBlock.Name})
 			}
 		case "content_block_delta":
@@ -238,6 +285,9 @@ func checkAnthropicStream(t *testing.T, frames []anthropicSSEFrame, wantBlocks [
 					t.Fatalf("input for block %d reached the client without its start", f.chunk.Index)
 				}
 				tools[len(tools)-1].input += f.chunk.Delta.PartialJSON
+			case "citations_delta":
+				// the block opened above is what it cites for; the check
+				// before the switch already said its start went first
 			default:
 				t.Fatalf("block %d has an unexpected delta type %q", f.chunk.Index, f.chunk.Delta.Type)
 			}
@@ -392,6 +442,27 @@ func TestAnthropicTextCallsSSEChunksKeepFraming(t *testing.T) {
 	}
 }
 
+// A cited block's start is held with its text while the relay looks for a
+// call written into it, but a citation is not text: it must not go out
+// before the block's start. Claude Code reads a delta for a block it never
+// saw start as a stream cut short and ends the reply ("The search was cut
+// off before any results arrived", #5759).
+func TestAnthropicTextCallsCitationFollowsItsBlockStart(t *testing.T) {
+	for _, how := range []string{"whole", "events", "lines", "bytes", "crlf lines"} {
+		t.Run(how, func(t *testing.T) {
+			tc := &anthropicTextCalls{names: map[string]bool{"web_search": true}, sse: true}
+			var out strings.Builder
+			for _, part := range chunkAnthropicSSE(citedAnthropicStream, how) {
+				out.Write(tc.write([]byte(part)))
+			}
+			out.Write(tc.flush())
+			checkAnthropicStream(t, readAnthropicSSE(t, out.String()),
+				[]string{"server_tool_use", "text", "text"}, "It is 12:00 in Tokyo.", "end_turn",
+				[]wantAnthropicCall{{name: "web_search", id: "call_01", args: `{"query":"Tokyo current time"}`}})
+		})
+	}
+}
+
 // lineCuts is the stream in two reads, cut after each of its lines.
 func lineCuts(stream string) [][]string {
 	var out [][]string
-- 
2.50.1 (Apple Git-155)
```

</details>

Reported-by: FunJim (yetone/magpie#5759)
Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)

Branch: [`fix/5759-citation-block-order`](https://github.com/ggbdpq/magpie/tree/fix/5759-citation-block-order)
