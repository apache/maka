The reported break: a `: keepalive` that reaches the redact writer while its buffer stands inside a `data:` line is appended to that line, and the next blank line hands the half frame out as one complete event of truncated JSON — OpenCode's `InvalidProviderOutput`, non-retryable, the turn lost. Following the reporter's analysis and their suggested direction (pass a comment through only at a line boundary), this patch holds a mid-line comment instead of splicing it.

**Root cause:** `Writer.Write` passes comment lines through only when they open its buffer (`commentLines(b)`), and its doc assumes "b starts where an event does". Nothing enforces that: a write may leave the buffer mid-line, and a comment written next is appended to the pending line. Once the blank line arrives, `eventEnd` returns the half frame plus the comment as one event.

**The fix:** before buffering, a write that opens with comment lines while the buffer stands mid-line (`midLine`: non-empty, last byte no `\n`/`\r`) has those lines moved to `heldComment`. They go out once the line's own end has passed: ahead of the next comment run at the buffer's start, or right after the event the line closed. `Finish` does not release them — the unterminated line then reaches the client as an incomplete stream, which it retries, instead of an event it refuses. Between events nothing changes: a comment that arrives at a line boundary goes out as it comes (#2402's silence-keeper).

One difference from the suggested sketch: leaving the comment in the buffer is what splices it today, since the buffer is one byte sequence; it has to be set aside to keep it out of the line.

**Source:** reported in #7012 with two captured byte sequences and a writer-level reproduction; the new test is that reproduction.

**Red without the fix:** `TestKeepaliveHeldMidLine` (new) — `the keepalive landed inside the pending data line: "data: {\"id\":\"gw-1\",\"object\":\"chat.completion.chunk\",\"cre: keepalive\n\n"`. With the fix the output is the half frame alone.

**Siblings:**
- `TestWriterHeldAcrossKeepalive` (placeholder split across a keepalive event, #5287 / plugins#738) passes unchanged; that path is whole events, not comments.
- `internal/middleware/run.go:339`: the plugin middleware's stream writer has the same `commentLines`-at-buffer-start logic and the same doc assumption. It has the same exposure if a comment reaches it mid-line; not changed here.
- What writes the comment mid-line in the reporter's path is not pinned. The redact writer forwards bytes in arrival order, so the splice means a producer wrote `: keepalive\n` while the client's line was open. In the gateway, `keepQuiet` checks `h.atLine` before its keepalive (`internal/gateway/fallback.go:3905`), but `holdWriter.keepAlive` (`fallback.go:3418`, reached from the hold tick at :3302, `keepQueued` at :3781, `keepQuiet`'s not-yet-passing branch at :3901, and `patience.go:238`) writes `: keepalive\n` with no `atLine` check and then sets `atLine = true`. This patch makes the masking writer robust whatever the producer; with masking off the redact writer is not in the chain, and a producer-side guard there would be the matching fix. Left for you.

| Check | Result |
| --- | --- |
| `TestKeepaliveHeldMidLine` | Green at final head; without the fix: `the keepalive landed inside the pending data line` |
| `TestKeepaliveStillPassesAtLineBoundaries` (new) | Green: a keepalive between events passes, both events unchanged |
| Ablation (`writer.go` reverted, tests kept) | Same assertion-level failure; restored, green |
| `go test -tags nogui -timeout=45m -count=1 ./internal/redact/` | Pass (13.9s), `TestWriterHeldAcrossKeepalive` included |
| Targeted `-race` (`TestKeepalive`, `TestWriter` families) | Pass |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet ./…`; `GOOS=linux go vet -tags nogui ./…`; `GOOS=windows go vet ./…` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Strict `git am` on base `b332ef7ef` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's live path (`group/deepseek-v4.1-flash` through OpenCode 2.3.0) end-to-end; which producer wrote the mid-line comment in their captures; the middleware writer's behavior with a mid-line comment.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7012-redact-keepalive-partial-line](https://github.com/ggbdpq/magpie/tree/fix/7012-redact-keepalive-partial-line), head `b053aabf9594859e9d86b75f2f5b6f89e24f413c`.

<details><summary>patch: redact: a keepalive that lands mid-line is held, not spliced (#7012) — git am applies it as is; SHA-256 first 16: 73dbee96b0d87d6d</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 04:38:48 +0800
Subject: [PATCH] redact: a keepalive that lands mid-line is held, not spliced
 (#7012)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the streaming Writer looked for comment lines at the start
of its buffer, and nothing said the buffer starts where an event does —
the relay hands over whatever a read returned, mid-line as often as not.
A ": keepalive" the vendor sent while a data: line stood half-written
was appended inside the pending JSON payload, and the next blank line
closed the frame as truncated output: OpenCode refuses it whole,
invalid-output is non-retryable, the turn and its agent loop are lost
(#7012, two captures on a cut Chat stream). A comment that arrives
mid-line is now held whole and goes out when the line's own end has
passed the buffer, ahead of the event it arrived with; at Finish it
goes nowhere, and the unterminated line reads as an incomplete stream,
which the client retries. Between events nothing changes (#2402's
silence-keeper included), and a comment that opens a chunk holding more
rides held while the rest continues the line.

Run: TestKeepaliveHeldMidLine (new) fails without the fix (the
keepalive inside the pending data line) and passes with it;
TestKeepaliveStillPassesAtLineBoundaries (new) locks the between-events
pass-through. The package whole, TestWriterHeldAcrossKeepalive's
placeholder-splitting included, passes unchanged. See the issue post
for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/keepalive_midline_test.go | 57 +++++++++++++++++++++++
 internal/redact/writer.go                 | 48 ++++++++++++++++++-
 2 files changed, 103 insertions(+), 2 deletions(-)
 create mode 100644 internal/redact/keepalive_midline_test.go

diff --git a/internal/redact/keepalive_midline_test.go b/internal/redact/keepalive_midline_test.go
new file mode 100644
index 000000000..3f75ec3b3
--- /dev/null
+++ b/internal/redact/keepalive_midline_test.go
@@ -0,0 +1,57 @@
+package redact
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+)
+
+// A keepalive that arrives while the buffer stands inside a data: line —
+// the relay hands over whatever a read returned, mid-line as often as not
+// — was appended to the pending line, and the next blank line closed the
+// frame as truncated JSON the client refuses whole and will not retry
+// (#7012, two captures on a cut Chat stream). Mid-line, the comment is
+// held whole: the frame stands unterminated, which reads as an
+// incomplete stream and retries.
+func TestKeepaliveHeldMidLine(t *testing.T) {
+	rec := httptest.NewRecorder()
+	rec.Header().Set("Content-Type", "text/event-stream")
+	w := NewWriter(rec)
+	w.WriteHeader(200)
+
+	half := `data: {"id":"gw-1","object":"chat.completion.chunk","cre`
+	w.Write([]byte(half))
+	w.Write([]byte(": keepalive\n"))
+	w.Write([]byte("\n"))
+	w.Finish()
+
+	got := rec.Body.String()
+	if strings.Contains(got, ": keepalive") {
+		t.Fatalf("the keepalive landed inside the pending data line:\n%q", got)
+	}
+	if got != half {
+		t.Fatalf("the half-written frame stands as itself:\ngot  %q\nwant %q", got, half)
+	}
+}
+
+// A keepalive between two events still goes through at a line boundary,
+// ahead of the event it arrived with (#2402's proxy silence).
+func TestKeepaliveStillPassesAtLineBoundaries(t *testing.T) {
+	rec := httptest.NewRecorder()
+	rec.Header().Set("Content-Type", "text/event-stream")
+	w := NewWriter(rec)
+	w.WriteHeader(200)
+
+	w.Write([]byte("data: {\"id\":\"a\"}\n\n"))
+	w.Write([]byte(": keepalive\n\n"))
+	w.Write([]byte("data: {\"id\":\"b\"}\n\n"))
+	w.Finish()
+
+	got := rec.Body.String()
+	if !strings.Contains(got, ": keepalive") {
+		t.Fatalf("the keepalive between events was held:\n%q", got)
+	}
+	if strings.Count(got, "data: {") != 2 {
+		t.Fatalf("the boundary events changed:\n%q", got)
+	}
+}
diff --git a/internal/redact/writer.go b/internal/redact/writer.go
index 876cda68d..3b4f43202 100644
--- a/internal/redact/writer.go
+++ b/internal/redact/writer.go
@@ -21,8 +21,16 @@ type Writer struct {
 	mode    int // 0 not yet known, 1 a stream, 2 a whole body, 3 left as it is
 	buf     bytes.Buffer
 	pending *held
-	done    bool
-	put     map[string]int // placeholders put back, each place counted
+	// heldComment is a comment line (": keepalive") that arrived while
+	// the buffer stood inside a data: line: appended, it would land
+	// inside the JSON payload and the next blank line would close the
+	// frame as truncated output the client refuses whole (#7012). It
+	// goes out at the line's end, and nowhere at Finish — the
+	// unterminated line reads as an incomplete stream, which the client
+	// retries.
+	heldComment []byte
+	done        bool
+	put         map[string]int // placeholders put back, each place counted
 }
 
 const (
@@ -115,6 +123,21 @@ func (rw *Writer) Write(p []byte) (int, error) {
 	case whole:
 		return rw.buf.Write(p)
 	}
+	// a comment that arrives while the buffer stands inside a data: line
+	// is held whole: appended, it lands inside the pending JSON payload,
+	// and the next blank line closes the frame as truncated output the
+	// client refuses whole and will not retry (#7012). It goes out when
+	// the line's own end has passed the buffer, ahead of the event it
+	// arrived with.
+	if b := rw.buf.Bytes(); midLine(b) {
+		if cl := commentLines(p); cl > 0 {
+			rw.heldComment = append(rw.heldComment, p[:cl]...)
+			p = p[cl:]
+			if len(p) == 0 {
+				return cl, nil
+			}
+		}
+	}
 	rw.buf.Write(p)
 	for {
 		b := rw.buf.Bytes()
@@ -123,7 +146,15 @@ func (rw *Writer) Write(p []byte) (int, error) {
 		// heard nothing while its vendor reasoned silently, and the
 		// proxy hung up (#2402). It carries nothing to put back, and an
 		// event held for its placeholder's tail goes on after it as well.
+		// A comment held for a line that ran long goes ahead of it: it
+		// came later in the stream, and goes out between events alike.
 		if c := commentLines(b); c > 0 {
+			if rw.heldComment != nil {
+				if _, err := rw.w.Write(rw.heldComment); err != nil {
+					return len(p), err
+				}
+				rw.heldComment = nil
+			}
 			if _, err := rw.w.Write(b[:c]); err != nil {
 				return len(p), err
 			}
@@ -139,10 +170,23 @@ func (rw *Writer) Write(p []byte) (int, error) {
 		if err := rw.event(ev); err != nil {
 			return len(p), err
 		}
+		// the held comment rides after the frame its line closed
+		if rw.heldComment != nil {
+			if _, err := rw.w.Write(rw.heldComment); err != nil {
+				return len(p), err
+			}
+			rw.heldComment = nil
+		}
 	}
 	return len(p), nil
 }
 
+// midLine says the buffer stands inside a line: not empty, and its last
+// byte is no line's end.
+func midLine(b []byte) bool {
+	return len(b) > 0 && b[len(b)-1] != '\n' && b[len(b)-1] != '\r'
+}
+
 // commentLines is how long the whole comment lines (": keepalive") and
 // blank lines at the start of b are: b starts where an event does, so none
 // of them is part of one.
-- 
2.50.1 (Apple Git-155)

```

</details>
