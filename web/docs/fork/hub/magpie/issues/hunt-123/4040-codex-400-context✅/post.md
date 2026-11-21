Thanks @easyrev for the report — the HTTP/SSE comparison in it pins this down fast.

**What's wrong**: "Codex treats HTTP 400 context_length_exceeded as a generic error, but recognizes the equivalent SSE failure." In a real session magpie answered a turn past the model's window with a 400 JSON (`error.code: "context_length_exceeded"`), Codex recorded `codex_error_info: "other"` and showed the raw JSON, while the same error arriving as a `response.failed` gets Codex's context-window message and its compaction.

**Root cause** (at tip 2741b749f, before this patch): magpie already tells a streaming Codex an overflow inside its stream — `keptAlive.compactsInStream` (internal/gateway/fallback.go:2843) — but only when `tooLong(status, msg)` calls the words an overflow, and `tooLongRe` (internal/gateway/gateway.go:9566) had `longer than the model'?s context length`, which wants an s or 's on the model. The reporter's vendor says "The message is longer than the model context length" — no 's — so the words weren't read as an overflow, and the vendor's 400 was kept as it was said (`writeVendorError` passes its code through). Codex reads nothing but the code of a `response.failed` (codex-rs codex-api sse/responses_error.rs) and maps a 400 whose body has no code it knows to `InvalidRequest` of the whole body (codex-rs codex-api api_bridge.rs, `map_api_error_details`; read at rust-v0.165.0, the reporter's failing CLI was 0.164.0) — the raw JSON the turn displayed.

**The fix**: the s becomes optional in that one alternation of `tooLongRe`, the one place every overflow reading funnels through — `compactsInStream`, `writeErrorSaid`, `failure` and `retryable` all take their reading from it, so no other opening is needed. A streaming Codex is then told `response.failed context_length_exceeded` and compacts; any other client keeps a 400 whose code says `context_length_exceeded`, the same shape it got before; and the failure's `failOther` booking is unchanged, so resting and fall-through stay as they were.

<details><summary>git am applies it as is; SHA-256 first 16: b9da1859440ce0f5</summary>

```diff
From c935d0252a7b105473206b89ee3c6244b87396a9 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 10:06:03 +0800
Subject: [PATCH] gateway: an overflow said without the model's compacts Codex
 too (#4040)

A vendor of easyrev's (#4040) refuses a turn past the model's window
with a 400 whose message is "The message is longer than the model
context length" and whose code is context_length_exceeded. Magpie kept
that error as it was said, a 400 JSON, and Codex, which reads nothing
but the code of a response.failed (codex-rs codex-api
sse/responses_error.rs), took the 400 for an invalid request showing
the raw JSON (api_bridge.rs maps a 400 with no code it knows to
InvalidRequest of the whole body), so the turn ended with nothing
compacted.

CompactsInStream would have told Codex in its stream, the one place it
compacts on context_length_exceeded, but its words are read by
tooLongRe, whose "longer than the model'?s context length" wants an s
or 's on the model: Together's "longer than the model's context
length" is matched, the reporter's, without the 's, wasn't. The s is
now optional there, so the vendor's words are read as an overflow: a
streaming Codex is told response.failed context_length_exceeded and
compacts, another client keeps a 400 whose code says
context_length_exceeded all the same, and the failure is booked and
asked around as any overflow's.

Tests: TestEveryVendorsOverflow takes the reporter's words as a
conversation too long, and TestCodexByteCapBeforeStreamCompacts
replays the reporter's vendor body: red on the old code, where Codex
got the 400 JSON whole ("Codex wasn't told in its stream to compact:
400 application/json {...context_length_exceeded...}") and the words
"aren't taken for a conversation too long"; green with the change.

Run: go test -tags nogui ./internal/gateway: ok. go vet
./internal/gateway: ok. gofmt: clean. go build ./...: ok.

Not tried: a real Codex CLI against the reporter's vendor. Codex's
HTTP-side handling was read from openai/codex rust-v0.165.0 (the
reporter's failing CLI was 0.164.0), not run.

Fixes #4040
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_byte_cap_test.go | 3 +++
 internal/gateway/gateway.go             | 5 +++--
 internal/gateway/toolong_test.go        | 2 ++
 3 files changed, 8 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/codex_byte_cap_test.go b/internal/gateway/codex_byte_cap_test.go
index fe800db4f..75b44a44e 100644
--- a/internal/gateway/codex_byte_cap_test.go
+++ b/internal/gateway/codex_byte_cap_test.go
@@ -134,6 +134,9 @@ func TestCodexByteCapBeforeStreamCompacts(t *testing.T) {
 	}{
 		{"nginx 413", reply{413, "text/html", nginx413}},
 		{"overflow 400", reply{400, "application/json", `{"error":{"message":"This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.","type":"invalid_request_error","code":"invalid_request_error"}}`}},
+		// the reporter's vendor (#4040), whose words carry no 's on the
+		// model and only the code names the context
+		{"overflow 400 without the model's", reply{400, "application/json", `{"error":{"code":"context_length_exceeded","message":"The message is longer than the model context length","type":"invalid_request_error"}}`}},
 	} {
 		t.Run(c.name, func(t *testing.T) {
 			fresh(t)
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 077e3f3d7..1c63aed52 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -9542,7 +9542,8 @@ func writeErrorSaid(w http.ResponseWriter, proto provider.Protocol, status int,
 // "input token count … exceeds the maximum",
 // xAI's "maximum prompt length is", Groq's "reduce the length of the
 // messages", OpenRouter's "maximum allowed input length", Together's
-// "longer than the model's context length", llama.cpp's "available
+// "longer than the model's context length" or, without the 's, "longer
+// than the model context length" (#4040, easyrev), llama.cpp's "available
 // context size", LM Studio's "greater than the context length", Copilot's
 // "prompt token count of", MiniMax's "context window exceeds limit",
 // Kimi's "exceeded model token limit", DS4's "configured context size",
@@ -9563,7 +9564,7 @@ func writeErrorSaid(w http.ResponseWriter, proto provider.Protocol, status int,
 // "输出过长" (the reply) isn't taken; bare "token数量超过上限" isn't either,
 // as a day's allowance is said so too.
 var tooLongRe = regexp.MustCompile(`(?i)context_length_exceeded|prompt is too long|input is too long|(exceeds?|exceeded|over|beyond)( the)?( model'?s?)?( maximum)? context|context (length|limit|window) (exceeded|is exceeded)|context (window )?(is )?full\b|maximum context length|too many (input |prompt )?tokens|上下文(长度)?(超|过长)|超(过|出)(了)?(模型)?(的)?(最大)?上下文` +
-	`|input token count.*exceeds the maximum|maximum prompt length is \d|reduce the length of the messages|maximum allowed input length|longer than the model'?s context length|available context size|greater than the context length|prompt token count of [\d,]+ exceeds the limit|context window exceeds limit|exceeded model token limit|configured context size|prompt too long|prompt exceeds max length|context_window_exceeded|exceeded (max |maximum )?context length|range of input length should be|token limit exceeded|input tokens? (count )?(exceeds?|exceeded) (the )?(max(imum)? )?limit` +
+	`|input token count.*exceeds the maximum|maximum prompt length is \d|reduce the length of the messages|maximum allowed input length|longer than the model'?s? context length|available context size|greater than the context length|prompt token count of [\d,]+ exceeds the limit|context window exceeds limit|exceeded model token limit|configured context size|prompt too long|prompt exceeds max length|context_window_exceeded|exceeded (max |maximum )?context length|range of input length should be|token limit exceeded|input tokens? (count )?(exceeds?|exceeded) (the )?(max(imum)? )?limit` +
 	`|(内容|输入|文本|提示词?|prompt|问题|对话|消息)(内容|文本)?(长度)?\s*(太长|过长|超长)|字数(太多|过多)` +
 	`|(内容|输入|文本|提示词?|prompt|问题|对话|消息)[^，。,.;；!！]{0,12}超(过|出)[^，。,.;；!！]{0,12}(长度|token|令牌|字数)` +
 	`|(输入|提示词?|prompt)\s*的?\s*(长度|token|令牌|字数)[^，。,.;；!！]{0,8}超(过|出)`)
diff --git a/internal/gateway/toolong_test.go b/internal/gateway/toolong_test.go
index fc4d869f8..dd376ca91 100644
--- a/internal/gateway/toolong_test.go
+++ b/internal/gateway/toolong_test.go
@@ -71,6 +71,8 @@ func TestEveryVendorsOverflow(t *testing.T) {
 		{400, "Please reduce the length of the messages or completion"},
 		{400, "Input length 2000 exceeds the maximum allowed input length of 1000 tokens."},
 		{400, "The input (2000 tokens) is longer than the model's context length (1000 tokens)."},
+		// the reporter's vendor (#4040): no 's on the model
+		{400, "The message is longer than the model context length"},
 		{400, "the request exceeds the available context size, try increasing it"},
 		{400, "tokens to keep from the initial prompt is greater than the context length"},
 		{400, "prompt token count of 2000 exceeds the limit of 1000"},
-- 
2.50.1 (Apple Git-155)
```
</details>

**Verification**:

| check | result |
|---|---|
| RED | on 2741b749f's code both new cases fail: `TestCodexByteCapBeforeStreamCompacts/overflow_400_without_the_model's` — "Codex wasn't told in its stream to compact: 400 application/json {"error":{"code":"context_length_exceeded",...}}" (the reporter's raw JSON, exactly), and `TestEveryVendorsOverflow` — the words "isn't taken for a conversation too long" |
| ablation | reverting the product file internal/gateway/gateway.go to the parent commit 2741b749f with the tests kept turns both new cases red again |
| targeted | `go test -tags nogui -run 'TestEveryVendorsOverflow\|TestCodexByteCapBeforeStreamCompacts\|TestCodexByteCapInStreamCompacts\|TestByteCapBeforeStreamStaysStatusForOthers' ./internal/gateway` — ok |
| package | `go test -tags nogui -timeout 25m ./internal/gateway/...` — ok, 640s |
| race | `go test -race -tags nogui -run` over the targeted four (streaming end to end) — ok |
| gofmt / vet / build | `tr -d '\r' < file \| gofmt -l /dev/stdin` clean; `go vet -tags nogui ./internal/gateway` ok; `go build -tags nogui ./...` ok (two dockflap/trayimage cgo warnings predate this) |
| applied | `git am -3` of the patch onto upstream/main tip 247794c61 in a clean tree applies as is |
| siblings | `rg "longer than the model"` over the repo: only the tooLongRe line, its comment, and the two existing tests whose vendors say 's — nothing else reads these words, and this was the one funnel to close; `provider.apiError` copies only `error.message` into the text magpie classifies (the vendor's code never reaches it) — checked; hot path: one alternation gained an optional `?`, nothing measurable |

**Not verified**: no real Codex CLI run against a real vendor; Codex's HTTP-side reading comes from openai/codex rust-v0.165.0 source, not run. Codex over a WebSocket, and a non-streaming Responses request (the CLI doesn't send one), keep today's behavior untouched.

AI use: see the attribution below.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

Branch with the commit: fix/4040-codex-400-context (head c935d0252a7b105473206b89ee3c6244b87396a9)
