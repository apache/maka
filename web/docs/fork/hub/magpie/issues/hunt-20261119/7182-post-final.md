Following the reporter's isolation, this patch ends the stalled try over HTTP/2 by its own cancellation instead of closing the connection whole, and retires the connection only once the try is over — when it is idle if nothing else rides it — so new requests stop being put on a connection whose flow-control window stayed shut while the replies already streaming on it finish.

**Root cause:** the watchdog's stall path (`st.onStall` in `internal/gateway/upstream_stall.go`) called `st.dropConn()` unconditionally, and `dropConn` closes the TCP connection the try rides. Over HTTP/1.1 that connection carries this one request, so the close costs nothing else; over HTTP/2 it carries every try's streams — the sibling reply the reporter streamed died with `http2: client connection force closed via ClientConn.Close` while the stalled body's vendor never even saw its end. The close existed to keep requests off a connection whose window shut for good; it did that by killing everything already on it.

**The fix:** `onStall` closes the connection only when it cannot multiplex (`h2Conn`: a TLS connection negotiated to ALPN `h2` says it can; HTTP/1.1's one-request connection, as before, is closed at once). Over HTTP/2 the try's own `cancel(errUploadStalled)` resets just its stream, and `stallGuard.RoundTrip` — at the `errUploadStalled` exit, after the transport has returned and the stream is over — calls `CloseIdleConnections()`: with nothing else on the connection it is idle and retired there (the close's original purpose, kept); with the reporter's sibling reply still streaming it is not idle, the sibling finishes, and the connection goes when its streams do. The `GetBody` retry still starts the next try on a fresh connection. A connection left up because a sibling rides it is not closed until its streams end (or its idle timeout); a request that lands on it then stalls and is cancelled the same way, not killed.

**Source:** reported in #7182 with a standalone reproduction (same HTTP/2 connection, one streaming reply and one upload the vendor never reads) and a control build with the close removed; the new test is that reproduction inside the package, asserting both requests multiplexed (`RemoteAddr` equal) and the stalled words in the upload's failure.

**Red without the fix:** `TestStalledUploadLeavesOtherStreamsOnTheConnection` (new) — `the reply on the same connection died with the stalled upload: "", http2: client connection force closed via ClientConn.Close`.

**Siblings:** the stall family (`TestBodyStalledByFlowControlIsGivenUp`, `TestBodySlowButMovingIsNotCut`, `TestStallBodyClock`, `TestMCPRelayBodyStalledIsGivenUp`) passes unchanged — the MCP relay's client rides the same guard. #3191's stall detection itself is untouched; this only changes what a detected stall does to the connection. `CloseIdleConnections` at the stall exit retires any other idle connection too; they are re-established on demand.

| Check | Result |
| --- | --- |
| `TestStalledUploadLeavesOtherStreamsOnTheConnection` | Green at final head: the stalled upload ends with `request body stalled`, the sibling reply delivers its tail on the same connection; without the fix: `http2: client connection force closed via ClientConn.Close` |
| Ablation (unconditional `dropConn` and the idle retirement reverted) | Same failure; restored, green |
| Stall family (the four tests above, plus `TestMCPRelayBodyStalledIsGivenUp`) | Pass unchanged |
| Targeted `-race` (stall family) | Pass |
| `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/` | Exit 1 with 3 failures, all pre-existing — the same three fail on the bare base `0a37c9368` (`TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes`, upstream 35e5989f1's documented darwin assertion, and `TestOpenAIProviderTurnsGoOverWebSocketByDefault`/`TestOpenAIProviderSocketOffNeverDials`, both 401 from the socket fixture's key check); nothing else, 909.5s |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Actual rebase onto `b17d9e3fc` | Clean; `git range-diff` `=` (no drift) |
| Strict `git am` on `b17d9e3fc` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's proxy-fronted production path (the reproduction is localhost-only by design, as theirs was); whether the vendor's window ever reopens while a sibling stream holds the connection up — while it does, requests that land on it spend `bodyStall` before their own retry, which is the price of not killing the sibling.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7182-stall-soft-retire](https://github.com/ggbdpq/magpie/tree/fix/7182-stall-soft-retire), head `4270ce961ea5bb22396eae439b29cc9606009777`.

<details><summary>patch: gateway: a stalled upload's try ends without killing the connection's other streams (#7182) — git am applies it as is; SHA-256 first 16: 8bc94f9c3aee4768</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 20 Nov 2026 00:34:38 +0800
Subject: [PATCH] gateway: a stalled upload's try ends without killing the
 connection's other streams (#7182)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: stallGuard's stall ended its try by closing the whole
connection, and over HTTP/2 that connection carried other tries' streams
— replies already streaming died with "http2: client connection force
closed via ClientConn.Close" while the vendor never even saw the end of
the stalled body. The try's own cancellation ends it over HTTP/2; the
connection is retired once the try is over (RoundTrip has returned, the
stream is closed), when CloseIdleConnections puts it out if nothing else
rides it — requests stop being put on a connection whose flow-control
window stays shut, and the streams already on it finish. A connection
that carries the stalled try alone (HTTP/1.1's one-request connection)
is still closed at once, as before.

Run: TestStalledUploadLeavesOtherStreamsOnTheConnection (new) fails
without the fix (the reply on the same connection died with the stalled
upload: "http2: client connection force closed via ClientConn.Close")
and passes with it, the stalled upload still ending with "request body
stalled"; TestBodyStalledByFlowControlIsGivenUp, TestBodySlowButMoving-
IsNotCut, TestStallBodyClock and TestMCPRelayBodyStalledIsGivenUp pass
unchanged. See the issue post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/upstream_stall.go      | 34 +++++++++-
 internal/gateway/upstream_stall_test.go | 83 +++++++++++++++++++++++++
 2 files changed, 116 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/upstream_stall.go b/internal/gateway/upstream_stall.go
index d1b558cf5..0f25ba018 100644
--- a/internal/gateway/upstream_stall.go
+++ b/internal/gateway/upstream_stall.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"context"
+	"crypto/tls"
 	"errors"
 	"fmt"
 	"io"
@@ -55,6 +56,11 @@ func (g stallGuard) RoundTrip(r *http.Request) (*http.Response, error) {
 	if !ok || r.GetBody == nil {
 		return res, err
 	}
+	// the cancelled try's stream is over: the connection it was on is
+	// idle now if nothing else rides it, and is retired before the retry,
+	// so requests stop being put on a connection whose flow-control
+	// window stayed shut; streams still on it are left to finish (#7182)
+	g.CloseIdleConnections()
 	// once more, on a new connection. The one just closed can still be
 	// the pool's for a moment, and a request put on it fails as closed:
 	// that is asked again, a few times, not counted as the vendor's
@@ -91,7 +97,17 @@ func (g stallGuard) try(r *http.Request) (*http.Response, error) {
 	st.onStall = func() {
 		dropOnce.Do(func() {
 			cancel(errUploadStalled{after: bodyStall})
-			st.dropConn()
+			// a connection that multiplexes carries other tries' streams:
+			// closing it whole killed the replies already streaming on it,
+			// and h2's own reset of the cancelled try's stream ends this
+			// one just as dead — the connection itself is retired once the
+			// try is over, when RoundTrip has returned and the connection
+			// is idle if nothing else rides it (#7182). A connection that
+			// carries this try alone is closed here, so nothing is put on
+			// it again.
+			if !h2Conn(st.theConn()) {
+				st.dropConn()
+			}
 			close(dropped)
 		})
 	}
@@ -177,6 +193,22 @@ func (st *stallTry) setConn(c net.Conn) {
 	st.mu.Unlock()
 }
 
+// theConn is the connection the try rides, once the transport said which.
+func (st *stallTry) theConn() net.Conn {
+	st.mu.Lock()
+	defer st.mu.Unlock()
+	return st.conn
+}
+
+// h2Conn says whether a connection multiplexes: a TLS one negotiated to
+// ALPN h2 carries every try's stream, so closing it whole kills the
+// replies already streaming on it (#7182). Anything else — HTTP/1.1's
+// one-request connection, or a plain one — is the stalled try's alone.
+func h2Conn(c net.Conn) bool {
+	tc, ok := c.(*tls.Conn)
+	return ok && tc.ConnectionState().NegotiatedProtocol == "h2"
+}
+
 func (st *stallTry) dropConn() {
 	st.mu.Lock()
 	c := st.conn
diff --git a/internal/gateway/upstream_stall_test.go b/internal/gateway/upstream_stall_test.go
index c6da4efaa..ba98b1419 100644
--- a/internal/gateway/upstream_stall_test.go
+++ b/internal/gateway/upstream_stall_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"bufio"
 	"bytes"
 	"context"
 	"crypto/tls"
@@ -205,3 +206,85 @@ func TestMCPRelayBodyStalledIsGivenUp(t *testing.T) {
 		t.Fatalf("error = %v (ctx: %v); want one saying %q", err, ctx.Err(), stalledWords)
 	}
 }
+
+// A stalled upload's try is cancelled and the connection it was on was
+// closed whole: over HTTP/2 that connection also carried replies already
+// streaming to other requests, which died with it ("http2: client
+// connection force closed via ClientConn.Close") while the vendor never
+// even saw the end of the stalled body. The stalled try's own cancel is
+// enough to end it; the connection is retired once the try is over, when
+// it is idle if nothing else is on it, so requests stop being put on a
+// connection whose flow-control window stays shut while the streams
+// already on it finish (#7182).
+func TestStalledUploadLeavesOtherStreamsOnTheConnection(t *testing.T) {
+	was := bodyStall
+	bodyStall = 300 * time.Millisecond
+	t.Cleanup(func() { bodyStall = was })
+
+	addrs := make(chan string, 2)
+	release := make(chan struct{})
+	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		addrs <- r.RemoteAddr
+		if r.URL.Path == "/stream" {
+			io.WriteString(w, "first\n")
+			w.(http.Flusher).Flush()
+			select {
+			case <-release:
+				io.WriteString(w, "tail\n")
+			case <-r.Context().Done():
+			}
+			return
+		}
+		<-r.Context().Done()
+	}))
+	server.EnableHTTP2 = true
+	server.Config.HTTP2 = &http.HTTP2Config{MaxReceiveBufferPerConnection: 128 << 10, MaxReceiveBufferPerStream: 128 << 10}
+	server.StartTLS()
+	t.Cleanup(func() {
+		closeIfOpen(release)
+		server.Close()
+	})
+	client := server.Client()
+	client.Transport = stallGuard{next: client.Transport}
+	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
+	defer cancel()
+	get, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/stream", nil)
+	stream, err := client.Do(get)
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer stream.Body.Close()
+	if stream.ProtoMajor != 2 {
+		t.Fatalf("expected HTTP/2, got %s", stream.Proto)
+	}
+	br := bufio.NewReader(stream.Body)
+	first, err := br.ReadString('\n')
+	if err != nil || first != "first\n" {
+		t.Fatalf("first = %q, %v", first, err)
+	}
+	post, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/upload", io.NopCloser(bytes.NewReader(make([]byte, 512<<10))))
+	upload, err := client.Do(post)
+	if upload != nil {
+		upload.Body.Close()
+	}
+	if err == nil || !strings.Contains(err.Error(), stalledWords) {
+		t.Fatalf("upload should end with %q: %v", stalledWords, err)
+	}
+	a, b := <-addrs, <-addrs
+	if a != b {
+		t.Fatalf("not multiplexed: %s versus %s", a, b)
+	}
+	close(release)
+	tail, err := br.ReadString('\n')
+	if err != nil || tail != "tail\n" {
+		t.Fatalf("the reply on the same connection died with the stalled upload: %q, %v", tail, err)
+	}
+}
+
+func closeIfOpen(ch chan struct{}) {
+	select {
+	case <-ch:
+	default:
+		close(ch)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

