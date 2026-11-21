The relay already ended a stream whose upstream died mid-reply with the protocol's own error event, but what it appended began after a blank line — and that blank line completed whatever half line the upstream's last write had left standing into an event of its own. Pi read that event's truncated JSON as `malformed server-sent event JSON` and hung, the error event after it unread; a Chat stream ended with no `[DONE]` either. Failover before the first byte was never the problem (the report's own e68d… → 5f32… hop shows it working), and once output has started the gateway cannot switch accounts, so the fix is in how the relayed stream ends.

**What changed** (internal/gateway/gateway.go, the passthrough relay):

- A stream's last line — the one a read left unfinished — is no longer the client's until it ends: held back, handed on when the stream ends cleanly, dropped when the read fails. A severed upstream can no longer leave a half event behind. A body that is not events (a plain JSON reply) goes through as it came, and a held line that outgrows any event (1 MiB, the same bound where the usage sniffer gives up on a runaway line) is handed on unheld, so nothing buffers without end.
- A stream the read failed on now ends, after its error event, with `data: [DONE]` when the client speaks Chat Completions — the end the report asks for, so a client reading to `[DONE]` stops there and says the error it read. A stream that ended cleanly but short still ends at the error event: there a `[DONE]` would read the cut reply as whole, which TestGeminiCompatRelayEndedShort pins. Anthropic (`event: error`), Responses (`response.failed`) and Gemini end on their error events as they did; Gemini's stream has no `[DONE]`.
- Whether a mid-stream failure joins the group's own failover stays as it is: the agent retries its own stream, which is the ending #3197 asks for, and nobody rests or re-asks here.

**Red before the fix** — two tests in internal/gateway/passthrough_severed_test.go, a fake upstream that serves valid chunks and then dies inside a data line under a lying Content-Length (no network). On base `9b0f4861` with the tests alone:

```
--- FAIL: TestPassthroughChatSeveredMidLine (0.10s)
    passthrough_severed_test.go:137: the severed stream left an event no client can read: "{\"id\":\"c1\",\"model\":\"m\",\"cho"
--- FAIL: TestPassthroughChatSeveredAtLineEnd (0.01s)
    passthrough_severed_test.go:172: the error event was not followed by [DONE]: connection lost mid-reply (unexpected EOF)","type":"api_error"}}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.032s
```

With the fix both pass: every event the client can read parses as JSON (or is `[DONE]`), the error stands, and `[DONE]` follows it. Ablation: the product back to base with the tests kept, both fail again; restored, green. A first shape of this fix appended `[DONE]` after every failure event; the full gateway suite turned up TestGeminiCompatRelayEndedShort, which pins a cleanly-cut reply as ending exactly at the error event — the `[DONE]` now belongs to the severed case only, and the suite is green at the submitted head.

**Siblings** — the protocols' mid-stream exits, one by one:

- Chat passthrough (this fix): the half event is kept from the client, and the severed case ends `[DONE]`.
- Chat translated (streamTranslated): the error event is synthesized from events magpie decoded, so no half line can reach the client, and the stream ends on the connection's close after the error. Its missing `[DONE]` is the same shape but has no report and no failing case, so it stands as it is.
- Anthropic passthrough: `event: error` is terminal for its clients; a `message_stop` after an error would say the reply completed. Unchanged.
- Responses passthrough: `response.failed` likewise terminal. Unchanged.
- Gemini passthrough: ends on a candidate's finishReason, and its OpenAI-compatible relay has no `[DONE]` to add; TestGeminiCompatRelayEndedShort is green at this head. Unchanged.
- In flight: my #2873 patch (hunt48-e-cutshort-retry) classifies a plugin's cut-short error and re-asks the same member — routing policy, not the wire; it sits in serve's try loop and routing.go's failure words, not in the relay's write path. The two compose: this patch decides what the client's stream ends with, that one whether the gateway asks again.

| Check | Command | Result |
| --- | --- | --- |
| Red on base | `go test -run '^(TestPassthroughChatSeveredMidLine\|TestPassthroughChatSeveredAtLineEnd)$' ./internal/gateway/`, gateway.go at `9b0f4861`, tests kept | FAIL ×2, excerpt above |
| Green with the fix | the same, fix restored | ok |
| Ablation round trip | product to base and back | FAIL ×2 → ok |
| Severed and Gemini-compat families | `go test -run 'Passthrough\|Severed\|LoopCut\|StreamCut\|NonStream\|GeminiCompat\|Gemini' ./internal/gateway/` | ok |
| Race | `go test -race -run 'Passthrough\|Severed\|LoopCut\|GeminiCompat' ./internal/gateway/` | ok |
| Full changed package | `go test -tags nogui -count=1 ./internal/gateway/` | ok, 318s |
| Format | `gofmt -l` on the two changed files | empty |
| Vet | `go vet ./...` darwin; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | clean (darwin prints a pre-existing cgo warning in internal/gui/trayimage_darwin.go, a file this patch never touches) |
| Builds | `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | ok |
| Patch applies | `git am` of the patch below on a fresh `9b0f4861` worktree | applies; the gateway package is then identical to the branch's |

**What the client reads now**: only whole lines, then the protocol's error event — for Chat one it can parse and show, then `[DONE]` — and a close. An upstream failure and a normal end tell apart again: a normal end is the reply's own last event (or `[DONE]`), a failed one carries the error naming the provider.

**Not verified**: against a real Z.ai account — the fake delivers the shape the report describes (a 200 stream that stops mid-line, connection reset) but no real account was spent on it; Pi's own reader is not run here — that the hang ends once the stream is well-formed rests on #470 and #1644's accounts of pi-ai, not on a Pi run; the suite ran on darwin only (Linux and Windows are vet and build, not test); the 1 MiB runaway-line hand-on rests on the sniffer's same bound rather than a test of its own.

Branch with the commit: [hunt59-d-3197-midstream-fail](https://github.com/ggbdpq/magpie/tree/hunt59-d-3197-midstream-fail) (head `52f5fbaaa2d88c368b7b082cb6a5fd684a354402`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a severed upstream leaves the client no half event, and a Chat stream ends [DONE] (#3197) — git am applies it as is; SHA-256 first 16: 26ea880c04c2f722</summary>

```patch
From 52f5fbaaa2d88c368b7b082cb6a5fd684a354402 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 04:32:28 +0800
Subject: [PATCH] gateway: a severed upstream leaves the client no half event,
 and a Chat stream ends [DONE] (#3197)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An upstream that died mid-line (Z.ai's 502 mid-reply, a connection
reset) left the relay's last line half written, and the blank line
before the failure event magpie appends completed it into an event of
its own: the client read its truncated JSON as "malformed server-sent
event JSON" and hung, the error event after it unread. A Chat stream
ended there with no [DONE] either. Failover before the first byte was
never the problem.

What changed: a relayed stream's last line, the one a read left
unfinished, is no longer the client's until it ends — held back,
handed on when the stream ends cleanly, dropped when the read fails,
so a severed upstream can leave no half event behind. A stream the
read failed on ends, after its error event, with data: [DONE] for
Chat, the end a Chat client reads to; one that ended cleanly ends at
the error event as before, where [DONE] would read the cut reply as
whole (TestGeminiCompatRelayEndedShort). Anthropic, Responses and
Gemini end on their error event; Gemini has no [DONE]. Whole streams
are untouched: a line is only held until its end or the stream's, and
one that outgrows an event (1 MiB, the sniffer's runaway-line bound)
goes through as it came. Whether a mid-stream failure joins the
group's own failover stays as it is today: the client retries its own
stream, and nobody rests or re-asks here.

Run: TestPassthroughChatSeveredMidLine and TestPassthroughChatSeveredAtLineEnd
(internal/gateway/passthrough_severed_test.go, a fake upstream serving
valid chunks then dying mid-line under a lying Content-Length, no
network) fail on the unfixed tree — the first reads an event whose
data is `{"id":"c1","model":"m","cho`, the second finds no [DONE]
after the error; with the fix every event the client can read parses,
the error stands, and [DONE] follows. Ablation: the product back to
base with the tests kept, both fail again; restored, green. The whole
severed and Gemini-compat families pass, gofmt is clean, go vet ./...
and GOOS=linux and GOOS=windows go vet -tags nogui ./... are clean,
the build is fine on darwin, linux (nogui) and windows, and the full
gateway package is green under -tags nogui (a first run at an earlier
shape of this fix turned up TestGeminiCompatRelayEndedShort, whose
"ends at the error" suffix the [DONE] broke; the [DONE] is the severed
case's since).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                  | 66 +++++++++++++++-
 internal/gateway/passthrough_severed_test.go | 81 ++++++++++++++++++++
 2 files changed, 144 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index a9a868a2..c790edbb 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4746,12 +4746,49 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	// client reads one event it can't parse where the protocol's error was
 	// meant (TestPassthroughStreamCutMidLine)
 	atLine := true
+	// pending is the line a stream's last read left unfinished. It is not
+	// the client's until its end: held here, given on when the stream ends
+	// cleanly, dropped when the read fails — the half event the old blank
+	// line closing made of it is what Pi read as "malformed server-sent
+	// event JSON" and hung on, the error event after it unread (#3197).
+	// A body that is no events goes through as it comes.
+	var pending []byte
 	write := func(b []byte) (int, error) {
 		if len(b) > 0 {
 			atLine = b[len(b)-1] == '\n'
 		}
 		return w.Write(b)
 	}
+	if sse {
+		write = func(b []byte) (int, error) {
+			if len(pending) > 0 {
+				nb := make([]byte, 0, len(pending)+len(b))
+				nb = append(nb, pending...)
+				nb = append(nb, b...)
+				b, pending = nb, pending[:0]
+			}
+			if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
+				pending = append(pending, b[i+1:]...)
+				b = b[:i+1]
+			} else {
+				pending = append(pending, b...)
+				b = b[:0]
+			}
+			if len(pending) > 1<<20 {
+				// a line that outgrew any event is no event's data any
+				// more: it goes as it came, held no longer, where the
+				// sniffer gives up on one this long for the same reason
+				atLine = false
+				w.Write(pending)
+				pending = pending[:0]
+			}
+			if len(b) > 0 {
+				atLine = b[len(b)-1] == '\n'
+				return w.Write(b)
+			}
+			return 0, nil
+		}
+	}
 	// apart is what goes before an event magpie appends: a blank line,
 	// after the line still pending if the upstream's last write stopped
 	// inside one
@@ -4862,6 +4899,19 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	if phases != nil {
 		write(phases.flush())
 	}
+	// what a stream's last read left of a line: a clean end hands it on
+	// as when the stream went through as it came, a failed one drops it —
+	// half an event is nothing a client can read (#3197)
+	if len(pending) > 0 {
+		if rerr == nil || rerr == io.EOF {
+			atLine = pending[len(pending)-1] == '\n'
+			w.Write(pending)
+			if f != nil {
+				f.Flush()
+			}
+		}
+		pending = nil
+	}
 	if sse {
 		sniff.drain()
 	}
@@ -4904,10 +4954,20 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			failed = p.Name + ": " + errEndedShort.Error()
 		}
 		if failed != "" {
-			// what is appended begins after a blank line: the event still
-			// pending is left to stand, and the failure is read as an
-			// event of its own (TestPassthroughStreamEndsOnLineEnd)
+			// what is appended begins after a blank line: the line the
+			// upstream finished stands as the event it completed, and the
+			// failure is read as an event of its own
+			// (TestPassthroughStreamEndsOnLineEnd)
 			w.Write(append(apart(), streamFailure(proto, failed)...))
+			if proto == provider.Chat && rerr != nil && rerr != io.EOF {
+				// a Chat stream the upstream severed ends on [DONE] too: a
+				// client that reads to it stops there and says the error it
+				// read, instead of waiting on a connection that only
+				// closes (#3197). One that ended cleanly ends at the error,
+				// as a cut reply is not to end as if whole
+				// (TestGeminiCompatRelayEndedShort).
+				w.Write([]byte("data: [DONE]\n\n"))
+			}
 			if f != nil {
 				f.Flush()
 			}
diff --git a/internal/gateway/passthrough_severed_test.go b/internal/gateway/passthrough_severed_test.go
index 853590c7..37f086bc 100644
--- a/internal/gateway/passthrough_severed_test.go
+++ b/internal/gateway/passthrough_severed_test.go
@@ -2,9 +2,14 @@ package gateway
 
 import (
 	"encoding/json"
+	"fmt"
+	"io"
+	"net/http"
 	"net/http/httptest"
 	"strings"
 	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
 )
 
 // postMessages sends an Anthropic Messages request to the gateway, as dsh's
@@ -91,6 +96,82 @@ func atLineEnd(t *testing.T, body string) {
 	}
 }
 
+// severedChat is severed for an upstream the client speaks Chat to, as Pi
+// does an OpenAI-compatible provider (#3197).
+func severedChat(t *testing.T, events ...string) {
+	t.Helper()
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		hj, ok := w.(http.Hijacker)
+		if !ok {
+			panic("no hijacker")
+		}
+		conn, buf, err := hj.Hijack()
+		if err != nil {
+			panic(err)
+		}
+		defer conn.Close()
+		body := strings.Join(events, "")
+		fmt.Fprintf(buf, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: %d\r\n\r\n", len(body)+100)
+		io.WriteString(buf, body)
+		buf.Flush()
+	}))
+	t.Cleanup(up.Close)
+	p := provider.Provider{ID: "up", Name: "UP", Key: "k", Models: []string{"m"}, Chat: up.URL + "/v1"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// chatEventsSevered asks a Chat relay of the severed upstream and fails
+// when any event it left the client is no JSON a client can read, or the
+// stream doesn't end error, then [DONE].
+func chatEventsSevered(t *testing.T) {
+	t.Helper()
+	code, body := post(t, "/v1/chat/completions", `{"model":"up/m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	readSSE(strings.NewReader(body), func(_, data string) error {
+		if data != "[DONE]" && json.Valid([]byte(data)) == false {
+			t.Fatalf("the severed stream left an event no client can read: %q", data)
+		}
+		return nil
+	})
+	i := strings.Index(body, "connection lost mid-reply")
+	if i < 0 {
+		t.Fatalf("the severed stream ended without the failure said: %s", body)
+	}
+	if !strings.Contains(body[i:], "data: [DONE]\n\n") {
+		t.Fatalf("the error event was not followed by [DONE]: %s", body[i:])
+	}
+}
+
+// A Chat stream the upstream severs inside a data line: what the client
+// has is half an event, and the blank line the relay's ending writes made
+// it one — Pi read its truncated JSON as "malformed server-sent event
+// JSON" and hung, the error event after it unread (#3197). The half line
+// never goes out, and the stream ends with the error and the [DONE] a
+// Chat client reads to.
+func TestPassthroughChatSeveredMidLine(t *testing.T) {
+	fresh(t)
+	severedChat(t,
+		`data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}`+"\n\n",
+		`data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"hel"}}]}`+"\n\n",
+		`data: {"id":"c1","model":"m","cho`)
+	chatEventsSevered(t)
+}
+
+// One severed at a line's end keeps the line it finished: the event it
+// completes stands, and the error and [DONE] follow as events of their own.
+func TestPassthroughChatSeveredAtLineEnd(t *testing.T) {
+	fresh(t)
+	severedChat(t,
+		`data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}`+"\n\n",
+		`data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"lo"}}]}`+"\n")
+	chatEventsSevered(t)
+}
+
 // A reply the loop guard cuts (cutLoop) while the client is mid-line ends
 // in the same joined event: what is appended after it must begin after a
 // blank line too.
-- 
2.50.1 (Apple Git-155)

```

</details>
