@yetone @lbjxr — the sync wasn't lying about the backup, only about the turn: the file in your screenshot (`magpie.magpie-backup`, 91.34 KB, that morning) had gone up fine. What failed was a **read** of it a later sync began with — Go gave up on the TLS handshake to InfiniCLOUD's server after its 10-second limit ("net/http: TLS handshake timeout") — and that read error was written up as "同步失败", though nothing was lost. InfiniCLOUD's server just times handshakes out often enough (a busy origin on a far line) that a sync of theirs says this while the backup sits there intact.

**Root cause**: a sync request ended by the TLS handshake timing out was written off at once (`internal/davsync/stall.go`, `stallTransport.RoundTrip`). But the handshake comes **before** any byte of the request is written — Go writes the HTTP request only once the handshake is done — so a request that dies there never reached the server, and nothing was attempted, let alone lost.

**The fix**: the request goes again on a fresh connection, with its whole stall time back — the same shape the gateway has sent a request that died before its write began since #5519 (`d4a6e9315`). Two guards keep it to that shape: a request whose body can't be had again is not sent again, and a stall **after** the request was sent (where the server may have had it) is not either. Every sync request this covers is safe to repeat: WebDAV's GET, PUT and PROPFIND, S3's condition-guarded PUT, GitHub's content-addressed blob POST.

<details><summary>patch: davsync: a TLS handshake that times out sends the request again (#5424) — git am applies it as is; SHA-256 first 16: 697406b41e26a726</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 11:03:27 +0800
Subject: [PATCH] davsync: a TLS handshake that times out sends the request
 again (#5424)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

InfiniCLOUD's WebDAV times TLS handshakes out often enough that a sync
of theirs said "net/http: TLS handshake timeout" while the backup
itself had gone up fine (lbjxr): the turn was written off as a failure
that never was one.

The handshake ends before any byte of the request is written — Go
writes the HTTP request only once the handshake is done — so a request
ended by a handshake timeout never reached the server, and is sent
again on a fresh connection with its whole stall time back, as the
gateway has sent a request that died before its write began since
#5519. A request with a body that can't be had again is not sent
again, and a stall after the request was sent (the server may have had
it) is not either.
---
 internal/davsync/stall.go                |  34 +++++++
 internal/davsync/stall_handshake_test.go | 122 +++++++++++++++++++++++
 2 files changed, 156 insertions(+)
 create mode 100644 internal/davsync/stall_handshake_test.go

diff --git a/internal/davsync/stall.go b/internal/davsync/stall.go
index c3e1578f5..9f5a57d12 100644
--- a/internal/davsync/stall.go
+++ b/internal/davsync/stall.go
@@ -5,7 +5,9 @@ import (
 	"errors"
 	"fmt"
 	"io"
+	"net"
 	"net/http"
+	"strings"
 	"sync"
 	"time"
 
@@ -88,6 +90,24 @@ func (t stallTransport) RoundTrip(req *http.Request) (*http.Response, error) {
 		r.Body = &watched{ReadCloser: req.Body, w: w, ctx: ctx}
 	}
 	res, err := t.base.RoundTrip(r)
+	if err != nil && handshakeTimeout(err) && replayable(r) {
+		// the handshake never finished, so nothing of the request reached
+		// the server (#5424: InfiniCLOUD times handshakes out often
+		// enough that sync said "TLS handshake timeout" while the backup
+		// itself had gone up fine): it goes again on a fresh connection,
+		// with its whole time back
+		if req.GetBody != nil {
+			b, e := req.GetBody()
+			if e != nil {
+				return nil, cause(ctx, err)
+			}
+			r.Body = &watched{ReadCloser: b, w: w, ctx: ctx}
+		}
+		w.mu.Lock()
+		w.timer.Reset(after)
+		w.mu.Unlock()
+		res, err = t.base.RoundTrip(r)
+	}
 	if err != nil {
 		done()
 		return nil, cause(ctx, err)
@@ -97,6 +117,20 @@ func (t stallTransport) RoundTrip(req *http.Request) (*http.Response, error) {
 	return res, nil
 }
 
+// replayable is whether r is sent again whole: a request with no body, or
+// one whose body can be had again.
+func replayable(r *http.Request) bool {
+	return r.Body == nil || r.Body == http.NoBody || r.GetBody != nil
+}
+
+// handshakeTimeout is whether err is Go's TLS handshake timing out
+// (transport's TLSHandshakeTimeout): net's timing out on the handshake
+// itself, before the request was written.
+func handshakeTimeout(err error) bool {
+	var ne net.Error
+	return errors.As(err, &ne) && ne.Timeout() && strings.Contains(ne.Error(), "TLS handshake")
+}
+
 // cause is err, or why ctx was ended when the watchdog ended it.
 func cause(ctx context.Context, err error) error {
 	var s *errStalled
diff --git a/internal/davsync/stall_handshake_test.go b/internal/davsync/stall_handshake_test.go
new file mode 100644
index 000000000..54ea32a72
--- /dev/null
+++ b/internal/davsync/stall_handshake_test.go
@@ -0,0 +1,122 @@
+package davsync
+
+// A TLS handshake that times out ends a request before any byte of it
+// reached the server — the HTTP request is written only once the
+// handshake is done — so it is sent again on a new connection (#5424:
+// InfiniCLOUD's server times handshakes out often enough that sync said
+// "TLS handshake timeout" while the backup itself had gone up fine).
+// A stall after the request was sent is another matter and is not sent
+// again: the server may have had it.
+
+import (
+	"errors"
+	"fmt"
+	"io"
+	"net/http"
+	"strings"
+	"sync/atomic"
+	"testing"
+)
+
+// tlsHandshakeTimeoutError is what Go's transport answers with when the
+// TLS handshake itself times out, as net/http's own type has it.
+type tlsHandshakeTimeoutError struct{}
+
+func (tlsHandshakeTimeoutError) Error() string   { return "net/http: TLS handshake timeout" }
+func (tlsHandshakeTimeoutError) Timeout() bool   { return true }
+func (tlsHandshakeTimeoutError) Temporary() bool { return true }
+
+// funcTransport is a transport a test scripts each answer of.
+type funcTransport func(*http.Request) (*http.Response, error)
+
+func (f funcTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
+
+func answer(n int) (*http.Response, error) {
+	return &http.Response{StatusCode: 200, Status: fmt.Sprintf("%d OK", n),
+		Body: io.NopCloser(strings.NewReader("ok")), Header: http.Header{}, ContentLength: 2}, nil
+}
+
+func TestHandshakeTimeoutIsSentAgain(t *testing.T) {
+	var calls atomic.Int32
+	tr := stallTransport{funcTransport(func(r *http.Request) (*http.Response, error) {
+		if calls.Add(1) == 1 {
+			return nil, tlsHandshakeTimeoutError{}
+		}
+		if err := r.Context().Err(); err != nil {
+			t.Errorf("the attempt sent again runs on a cancelled context: %v", err)
+		}
+		return answer(2)
+	})}
+	req, _ := http.NewRequest(http.MethodGet, "https://higa.example.jp/dav/magpie/magpie.magpie-backup", nil)
+	res, err := tr.RoundTrip(req)
+	if err != nil {
+		t.Fatal(err)
+	}
+	res.Body.Close()
+	if got := calls.Load(); got != 2 {
+		t.Fatalf("a handshake timeout is sent again, %d attempts", got)
+	}
+	if res.StatusCode != http.StatusOK {
+		t.Fatalf("the answer of the second attempt comes back, got %s", res.Status)
+	}
+}
+
+func TestHandshakeTimeoutBodyIsSentAgain(t *testing.T) {
+	var calls atomic.Int32
+	var got string
+	tr := stallTransport{funcTransport(func(r *http.Request) (*http.Response, error) {
+		if calls.Add(1) == 1 {
+			return nil, tlsHandshakeTimeoutError{}
+		}
+		b, err := io.ReadAll(r.Body)
+		if err != nil {
+			t.Errorf("body of the attempt sent again: %v", err)
+		}
+		got = string(b)
+		return answer(2)
+	})}
+	req, _ := http.NewRequest(http.MethodPut, "https://higa.example.jp/dav/magpie/magpie.magpie-backup", strings.NewReader("backup bytes"))
+	res, err := tr.RoundTrip(req)
+	if err != nil {
+		t.Fatal(err)
+	}
+	res.Body.Close()
+	if got != "backup bytes" || calls.Load() != 2 {
+		t.Fatalf("a PUT over a handshake timeout goes again whole: %d attempts, body %q", calls.Load(), got)
+	}
+}
+
+func TestHandshakeTimeoutWithoutGetBodyIsNotSentAgain(t *testing.T) {
+	var calls atomic.Int32
+	tr := stallTransport{funcTransport(func(r *http.Request) (*http.Response, error) {
+		calls.Add(1)
+		return nil, tlsHandshakeTimeoutError{}
+	})}
+	req, _ := http.NewRequest(http.MethodPost, "https://higa.example.jp/x", io.NopCloser(strings.NewReader("once")))
+	req.GetBody = nil // a body that can't be had again is not sent again
+	_, err := tr.RoundTrip(req)
+	if err == nil {
+		t.Fatal("the error comes back")
+	}
+	if got := calls.Load(); got != 1 {
+		t.Fatalf("a body without GetBody is not sent again, %d attempts", got)
+	}
+}
+
+func TestStallAfterSentIsNotSentAgain(t *testing.T) {
+	var calls atomic.Int32
+	tr := stallTransport{funcTransport(func(r *http.Request) (*http.Response, error) {
+		calls.Add(1)
+		// a timeout on the line after the request went — the watchdog's
+		// shape, not the handshake's
+		return nil, errors.New(`Get "https://higa.example.jp/dav/f": timeout`)
+	})}
+	req, _ := http.NewRequest(http.MethodGet, "https://higa.example.jp/dav/f", nil)
+	_, err := tr.RoundTrip(req)
+	if err == nil {
+		t.Fatal("the error comes back")
+	}
+	if got := calls.Load(); got != 1 {
+		t.Fatalf("a stall after the request was sent is not sent again, %d attempts", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5424-dav-tls-handshake-retry`](https://github.com/ggbdpq/magpie/tree/fix/5424-dav-tls-handshake-retry) (head `3684d2087c7ad63024bab62f153ddc90773650cf`), rebased onto current `upstream/main` (`0fc3455e2`); on a fresh checkout `git am` applies clean and the tree is identical.

| Check | Result |
| --- | --- |
| `TestHandshakeTimeoutIsSentAgain` (new) | red before the fix, pass after |
| `TestHandshakeTimeoutBodyIsSentAgain` (new) | red before the fix, pass after |
| `TestHandshakeTimeoutWithoutGetBodyIsNotSentAgain` (new) | pass (the guard) |
| `TestStallAfterSentIsNotSentAgain` (new) | pass (the other guard); red under the ablation below |
| `go test ./internal/davsync/ -tags nogui -timeout 30m -count=1` | ok (48s), zero failures |
| targeted `-race` (`TestHandshakeTimeout*`, `TestStallAfterSent*`, and the rest of the stall domain: slow, stalled, metadata, GitHub blob, proxy switch) | ok (15s) |
| `gofmt -l internal/davsync` | prints nothing |
| `go vet -tags nogui ./internal/davsync/...`; `GOOS=linux go vet -tags nogui ./internal/davsync/`; `GOOS=windows go vet -tags nogui ./internal/davsync/` | clean |
| `go build -tags nogui` (darwin/arm64); `GOOS=linux GOARCH=amd64 go build -tags nogui`; `GOOS=windows GOARCH=amd64 go build -tags nogui` | clean |
| `go test -tags nogui -run 'TestGitHubCmd|TestWebdavCmd|TestS3Cmd' ./internal/cli/` | ok (1.3s) |
| `go test -tags nogui ./...` (whole repo) | not run |
| Ablation | dropping the `handshakeTimeout(err)` condition (any error resent) turns `TestStallAfterSentIsNotSentAgain` red (2 attempts); restored, green |
| Re-verified on upstream/main `0fc3455e2` | the branch is cut from that tip; nothing to rebase |

**Not verified**: InfiniCLOUD's real server — Go's handshake timeout can't be held at that point from outside `net/http`, so the tests inject what its transport answers there (as #5519's do); the difference is yours to see on a line to `*.teracloud.jp`. A whole-repo `go test -tags nogui ./...` was not run; the changed package and its CLI surface are covered above.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
