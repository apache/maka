The largest Codex turns count as 0 tokens because `usageSniffer` held an SSE event to a megabyte in two places (`internal/gateway/sniff.go`), both dating from the usage page itself (30c489a0): a data line pushing the event past 1 MiB dropped it, and a line still arriving past 1 MiB dropped the buf — while `event: response.completed` still set `ended`, so the stream read as finished and only the numbers went missing. `sse.go`'s readers already take a 32 MiB line, so the sniffer takes the same room now; an event past the room is still let go whole, and what the client receives is unchanged. One commit: head `f73f75258` on tip `dbaeaec12`, branch [`fix/5505-oversize-event`](https://github.com/ggbdpq/magpie/tree/fix/5505-oversize-event). Patch below, `git am` applies it as is; SHA-256 first 16: `a9f70212e7091d89`.

**What changed**

- `internal/gateway/sniff.go`: both caps are `sniffEventMost` (32 MiB) now, the line `sse.go`'s scanner takes; `write` searches only what came new for the line's end (`scanned`), so a line of megabytes isn't searched from its start on each 32 KiB write.
- `internal/gateway/sse.go`: the scanner's max token is `sniffEventMost` — the same 32 MiB it already took, one name now.
- `internal/gateway/sniff_test.go`: `TestSniffUsagePastOneMiB`, `TestSniffEventPastTheCapIsLetGo`.

**Tests** (provider.Responses, `text/event-stream`, written in 32 KiB chunks as both copy loops — the pass-through's and the ChatGPT backend's — feed the sniffer)

| Test | on main `dbaeaec12` | here `f73f75258` |
| --- | --- | --- |
| `TestSniffUsagePastOneMiB` (a `response.completed` of 1 MiB + 126 bytes echoing the request's tools, usage 313000 in / 9000 out, `resp_big`) | FAIL: usage `in: 0, out: 0` and no `response_id` — the record the issue shows | PASS, and the stream still reads as ended |
| `TestSniffEventPastTheCapIsLetGo` (a whole event past the cap let go, a never-ending line dropped, what follows still counted) | PASS (the old cap let it go too) | PASS |
| every other `TestSniff*` | PASS | PASS |

Ablation, each caught by a FAIL: the data-line cap back at 1 MiB → the first test reads usage 0 again; both caps off → the giant event's own counts (999999/888888) read over the first reply's; the buf cap back at 1 MiB alone stays green — with a line just past the cap, the crossing 32 KiB write carries its end, so that cap bites only a line that stays runaway, which the never-ending subtest holds. `Usage.add` is later-wins, which is why the giant event is told last.

**Siblings** (compared, none touched)

- the two `sniff.write` callers — the pass-through copy loop (`gateway.go`) and the ChatGPT backend's (`codex_backend.go`) — hand the sniffer every byte in 32 KiB chunks; nothing between them drops the event first.
- `sse.go`'s scanner: the same limit it already had, one name now.
- the plain-JSON body cap (`8<<20`, `over`) is untouched: the issue is the SSE path.
- the other line accumulators (`chattidy` and its family, `claude_warmup`, `ollama_chat`, `sse_bare`, …) hold event-level buffers behind a reader's own line cap, or small working buffers; none drops usage on an oversized event.

**Verified** (head `f73f75258`, darwin/arm64, go1.25.5): `go test -tags nogui -count=1 -run TestSniff ./internal/gateway` ok; `go test -tags nogui -count=1 -timeout 25m -race ./internal/gateway` 23m47s with one FAIL, `TestBrowserKeyOffClosesItsBrowser`, a data race that `dbaeaec12` fails the same way (checked on a clean worktree) — every `TestSniff*` green under `-race`. `gofmt -l` clean on the changed files; `go vet -tags nogui ./internal/gateway` clean on GOOS=darwin, linux and windows; `go build -tags nogui ./...` ok on the three. Not run: the GUI suite (no GUI change), run time on Linux or Windows, and the live ChatGPT backend — the echo-tools shape is the report's own finding, replayed here, not re-confirmed against the real one.

Thanks @R1cK-ChaN for the report, the cause, and the branch — the diagnosis and the cap design are theirs; this patch is an independent implementation of the same idea (their 88c97cfb2 says it too, write-path scan included), and either applies.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a stream event over a megabyte keeps its usage — git am applies it as is; SHA-256 first 16: a9f70212e7091d89</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 23:00:31 +0800
Subject: [PATCH] gateway: a stream event over a megabyte keeps its usage

R1cK-ChaN: a Codex turn over ChatGPT with 1,102 tools sent inline had a
response.completed that echoed the tools back, an event of megabytes,
and the 27 largest turns of a day (all over 300k tokens) were recorded
as in: 0, out: 0, with no response_id, stop or served, on a 200 that
finished normally (#5505): the sniffer gave the event up, and only the
numbers went missing.

Cause: usageSniffer held an event to 1 MiB in two places, both dating
from the usage page itself (30c489a0) - a data line that pushed s.data
past 1 MiB dropped it, and a line still in s.buf past 1 MiB dropped the
buf. sse.go's readers already take a line of 32 MiB; the sniffer never
had the room, and the reply's own copy to the client is untouched by
either cap.

What changed: both caps are sniffEventMost now (32 MiB), the line
sse.go's scanner takes, so an unbounded event still can't pile up; and
write searches only what came new for the line's end (scanned), so a
line of megabytes is not searched from its start on each 32 KiB write.

Tests: TestSniffUsagePastOneMiB (a response.completed of over a
megabyte, written as the copy loops write, keeps its usage and the
stream still reads as ended), TestSniffEventPastTheCapIsLetGo (an event
past sniffEventMost is let go, a runaway line is dropped, and what
follows is counted; the giant event comes last, with figures of its
own, so a removed cap reads its counts over the first reply's).

Broken by hand, each caught by a FAIL: the data-line cap back at 1 MiB
(usage 0 again); both caps off (the giant event's counts read over the
first reply's); the buf cap back at 1 MiB alone left the test green -
with a line just past the cap, the crossing 32 KiB write carries the
line's end, so that cap bites only a line that stays runaway, which the
never-ending subtest holds.

Run at this head (base upstream/main dbaeaec12), darwin/arm64,
go1.25.5:
- gofmt -l on the changed files: nothing.
- go vet -tags nogui ./internal/gateway/, GOOS=linux and GOOS=windows
  too: clean. go build -tags nogui ./... on the three: ok.
- go test -tags nogui -count=1 -run TestSniff ./internal/gateway/: ok.
- go test -tags nogui -count=1 -timeout 25m -race ./internal/gateway/:
  23m47s, one FAIL, TestBrowserKeyOffClosesItsBrowser, a data race the
  base fails the same way (checked at dbaeaec12 on a clean worktree);
  every Sniff test green under -race.
- known reds on this machine, red at dbaeaec12 too: TestMothX,
  TestLaneLimitRoutes, TestProxyCheckSaysAProxyPassedBy.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/sniff.go      | 29 +++++++++++++++----
 internal/gateway/sniff_test.go | 52 ++++++++++++++++++++++++++++++++++
 internal/gateway/sse.go        |  2 +-
 3 files changed, 76 insertions(+), 7 deletions(-)

diff --git a/internal/gateway/sniff.go b/internal/gateway/sniff.go
index 77bec829f..bcb3ec7be 100644
--- a/internal/gateway/sniff.go
+++ b/internal/gateway/sniff.go
@@ -15,9 +15,13 @@ type usageSniffer struct {
 	proto provider.Protocol
 	sse   bool
 	buf   []byte
-	data  []byte // SSE data lines of the event in progress
-	over  bool   // the JSON body outgrew the cap; give up on it
-	u     Usage
+	// scanned is how much of buf has already been searched for a line's
+	// end: each write searches only what came new, so a line of megabytes
+	// isn't searched from its start on every write
+	scanned int
+	data    []byte // SSE data lines of the event in progress
+	over    bool   // the JSON body outgrew the cap; give up on it
+	u       Usage
 	// served: the model the reply says answered it, the last it named
 	served string
 	// ended: the stream's last event went by (message_stop, [DONE],
@@ -39,6 +43,14 @@ func newSniffer(proto provider.Protocol, contentType string) *usageSniffer {
 	return &usageSniffer{proto: proto, sse: strings.HasPrefix(contentType, "text/event-stream")}
 }
 
+// sniffEventMost is the most a stream event, or a line still arriving, may
+// hold before the sniffer gives up on it: the line sse.go's readers take.
+// A bigger event is let go whole, never accumulated without bound. It used
+// to be a meagre megabyte, and a response.completed that echoes a long
+// tool list grows past one, so the largest Codex turns were counted as 0
+// tokens (#5505).
+const sniffEventMost = 32 << 20
+
 func (s *usageSniffer) write(b []byte) {
 	if !s.sse {
 		if len(s.buf)+len(b) > 8<<20 {
@@ -50,16 +62,20 @@ func (s *usageSniffer) write(b []byte) {
 	}
 	s.buf = append(s.buf, b...)
 	for {
-		i := bytes.IndexByte(s.buf, '\n')
+		i := bytes.IndexByte(s.buf[s.scanned:], '\n')
 		if i < 0 {
+			s.scanned = len(s.buf)
 			break
 		}
+		i += s.scanned
 		s.line(bytes.TrimSuffix(s.buf[:i], []byte{'\r'}))
 		s.buf = s.buf[i+1:]
+		s.scanned = 0
 	}
-	if len(s.buf) > 1<<20 { // a runaway line is not one we can use
+	if len(s.buf) > sniffEventMost { // a runaway line is not one we can use
 		s.buf = nil
 		s.data = nil
+		s.scanned = 0
 	}
 }
 
@@ -77,7 +93,7 @@ func (s *usageSniffer) line(line []byte) {
 	}
 	if rest, ok := bytes.CutPrefix(line, []byte("data:")); ok {
 		rest = bytes.TrimPrefix(rest, []byte{' '})
-		if len(s.data)+len(rest)+1 > 1<<20 {
+		if len(s.data)+len(rest)+1 > sniffEventMost {
 			s.data = nil // never let an unbounded event accumulate
 			return
 		}
@@ -272,6 +288,7 @@ func (s *usageSniffer) drain() {
 		if len(s.buf) > 0 {
 			s.line(bytes.TrimSuffix(s.buf, []byte{'\r'}))
 			s.buf = nil
+			s.scanned = 0
 		}
 		s.flushEvent()
 	}
diff --git a/internal/gateway/sniff_test.go b/internal/gateway/sniff_test.go
index 5acb3c13b..5fecd3593 100644
--- a/internal/gateway/sniff_test.go
+++ b/internal/gateway/sniff_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"strings"
 	"testing"
 
 	"github.com/yetone/magpie/internal/provider"
@@ -86,3 +87,54 @@ func TestSniffSingleNewlineEvents(t *testing.T) {
 		t.Errorf("usage %+v", got)
 	}
 }
+
+// A stream event over a megabyte keeps its usage: a Codex turn with a long
+// tool list has a response.completed that echoes the tools, and those turns
+// used to be counted as 0 tokens (#5505). The copy loops feed the sniffer
+// in 32 KiB writes, so the event sits in the buf with no line end in sight
+// for most of its length.
+func TestSniffUsagePastOneMiB(t *testing.T) {
+	s := newSniffer(provider.Responses, "text/event-stream")
+	payload := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_big\",\"tools\":[\"" + strings.Repeat("x", 1<<20) + "\"],\"usage\":{\"input_tokens\":313000,\"output_tokens\":9000}}}\n\n"
+	for i := 0; i < len(payload); i += 32 << 10 {
+		end := i + (32 << 10)
+		if end > len(payload) {
+			end = len(payload)
+		}
+		s.write([]byte(payload[i:end]))
+	}
+	if got := s.usage(); got != (Usage{Input: 313000, Output: 9000, ResponseID: "resp_big"}) {
+		t.Fatalf("usage %+v", got)
+	}
+	if !s.whole() {
+		t.Fatal("the stream does not read as ended")
+	}
+}
+
+// An event past the cap itself is still let go — the sniffer never
+// accumulates without bound — and the stream goes on reading: what follows
+// is counted, and the end still reads as one.
+func TestSniffEventPastTheCapIsLetGo(t *testing.T) {
+	t.Run("a whole event past the cap", func(t *testing.T) {
+		s := newSniffer(provider.Responses, "text/event-stream")
+		s.write([]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_big\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n"))
+		// last, and with figures of its own: were the cap gone, its counts
+		// would overwrite the first reply's and the test would read them
+		s.write([]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"tools\":[\"" + strings.Repeat("x", sniffEventMost) + "\"],\"response\":{\"id\":\"resp_giant\",\"usage\":{\"input_tokens\":999999,\"output_tokens\":888888}}}\n\n"))
+		if got := s.usage(); got != (Usage{Input: 5, Output: 2, ResponseID: "resp_big"}) {
+			t.Fatalf("usage %+v", got)
+		}
+		if !s.whole() {
+			t.Fatal("the stream does not read as ended")
+		}
+	})
+	t.Run("a line that never ends", func(t *testing.T) {
+		s := newSniffer(provider.Responses, "text/event-stream")
+		s.write([]byte("data: " + strings.Repeat("x", sniffEventMost+(4<<10))))
+		s.write([]byte("\n\n"))
+		s.write([]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_big\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n"))
+		if got := s.usage(); got != (Usage{Input: 5, Output: 2, ResponseID: "resp_big"}) {
+			t.Fatalf("usage %+v", got)
+		}
+	})
+}
diff --git a/internal/gateway/sse.go b/internal/gateway/sse.go
index 927cd5f80..10fc02e09 100644
--- a/internal/gateway/sse.go
+++ b/internal/gateway/sse.go
@@ -26,7 +26,7 @@ func readSSEAlive(r io.Reader, fn func(event, data string) error, alive func())
 		r = bareErrors(r)
 	}
 	sc := bufio.NewScanner(r)
-	sc.Buffer(make([]byte, 0, 64<<10), 32<<20)
+	sc.Buffer(make([]byte, 0, 64<<10), sniffEventMost)
 	var event string
 	var data []string
 	flush := func() error {
-- 
2.50.1 (Apple Git-155)

```
</details>
