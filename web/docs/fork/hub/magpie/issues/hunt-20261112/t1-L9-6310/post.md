Found by reading this report's data against the code; the reporter's numbers (482 of 497 tries with nothing but `Masking`, since v0.1.3257; all of them carry `net` again on 0.1.3233) reproduce the shape exactly, so the patch walks their rows as the verification below. Nothing here needs a real account.

## What's wrong

CalmHTTP2 (970a86ff3, in v0.1.3257) put the gateway's vendor transports' kept HTTP/2 connections into a connection pool of magpie's own (internal/netproxy/calm.go, `calmPool`). The pool built into x/net's HTTP/2 says a request's client trace `GetConn` every time it hands a connection out — net/http says it when it dials — and the trace's remaining times (`GotConn`, `WroteRequest`, the vendor's first byte) hang off it. `calmPool.GetClientConn` says none of it: a request it serves from a kept connection goes out with no `GetConn` at all.

The gateway's `netTrace` (internal/gateway/nettrace.go) reads a try's way out from `GetConn` above all — `timing` answers nil for a cycle whose `getConn` it never heard — so every try whose request rode a kept HTTP/2 connection wrote no `tries[].net` at all: that is the reporter's `sent == own` rows (a keep-alive pair to one vendor rides the first request's connection), and with `net` gone the Routing page's `timeParts()` has only `Masking` to add. The usage split the request record carries (`splitSent`, gateway.go) reads the same hooks (`asking`/`asked`/`wrote`), so its own/wait/head split lost the same rows — `flow` and `ms`/`ttft` were all that stayed.

## The fix

`calmPool.GetClientConn` says `GetConn` on the request's own trace when it hands a kept connection out, and doesn't for the first request on a connection net/http dialed, which has heard it already — the built-in pool's own `getConnCalled` flag, carried here. Every later hook then lands on the cycle as it does for a dialed request, and `timing` answers the kept connection's `reused: true` with its `own`/`send`/`wait`/`head`, exactly the row the reporter asked to keep.

## Verification (darwin/arm64, main at e9e63c6d7, head 4608e990086f316f)

| Check | Result |
| --- | --- |
| `TestCalmedPoolHandsAKeptConnectionOutWithGetConn` (new, internal/netproxy) | red first (the request on the kept connection said `GetConn` 0 times; the dialed one once), green after; also pins the dialed request at exactly one `GetConn` |
| `TestTimingOnAKeptCalmConnection` (new, internal/gateway) | red first (`a kept connection's try has no TryNet`), green after: the second try of a keep-alive pair carries `reused`, one ask, and its `net` again; the dialed try pins at one ask |
| whole `internal/netproxy`, `-count=1` | ok |
| whole `internal/gateway`, `-count=1 -timeout 25m` | ok, 929.2s at the pre-rebase tree; re-run on the pushed head below |
| `-race`: whole `internal/netproxy`, and the two new tests in `internal/gateway` | ok |
| gofmt; `go vet -tags nogui` on both packages | clean |
| `GOOS=linux,windows,darwin go build -tags nogui ./...` | ok |
| `git am` on a clean tree at upstream/main | zero conflict, tree identical |

## Ablation

- The firing block (and the import) taken out of `calmPool.GetClientConn`: both new tests red, the kept-connection request back to zero `GetConn` and no `TryNet`.
- The `getConnCalled` flag dropped (fire for the dialed request too): both red on the double fire — the dialed request says `GetConn` twice, its try two asks.

---
**Source**: reported in this issue (0xUwUi), whose routing/*.jsonl data across five versions and `timeParts()` reading pinpointed the shape; root cause found by code reading against it.

**Siblings**: the calmed pool is the only connection pool magpie keeps (`rg -n "ConnPool|GetClientConn" internal/netproxy`); `Dispatch` (netproxy.go) hands requests to a plain transport whose traces net/http carries itself; `GetConn`'s consumers are the gateway's `netTrace.hooks` (the `TryNet` and the usage split) and `upstream_stall.go`'s idle-conn watcher, which only ever sees dialed transports and is untouched. The GUI side needs nothing: `timeParts()` already shows `ms`/`ttft` shapes the moment `net` is present, and `SentBy` rows (plugin/claude) keep their wording — the reporter's second ask (a fallback when `net` is absent) stops applying once no `sent == own` row lacks it.

**When the read fails**: a request whose trace never hears `GetConn` still writes its row without `net` (as before); nothing new is read and nothing new can fail.

**Not verified**: a real keep-alive pair against a real vendor; the Routing page's rendering in a browser (the data shape is pinned at the `TryNet`/`timing` boundary the page reads).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt-20261112-t1-6310](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-6310) (head `4608e990086f316f`).

**Patch**: <details><summary>patch: netproxy: a request handed a kept HTTP/2 connection hears GetConn (#6310, 0xUwUi) — git am applies it as is; SHA-256 first 16: cf8b15781e2fafc7</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 03:42:52 +0800
Subject: [PATCH] netproxy: a request handed a kept HTTP/2 connection hears
 GetConn (#6310, 0xUwUi)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

CalmHTTP2 put the vendor transports' kept HTTP/2 connections in a pool
of magpie's own (970a86ff3). The built-in pool says the request's client
trace's GetConn each time it hands a connection out — net/http's own
dial is the other way it gets said — and this one didn't: the gateway's
netTrace reads a request's way out (own, asks, first, and the usage
split riding the same hooks) from GetConn above all, so since
v0.1.3257 every try whose request rode a kept HTTP/2 connection wrote
no tries[].net at all, and the Routing page's "where the time went"
said Masking alone (0xUwUi's keep-alive pair to one vendor: 482 of 497
tries with nothing but the masking line).

The pool now says GetConn when it hands a kept connection out, and
doesn't for the first request on one net/http dialed, which has heard
it already (the built-in pool's getConnCalled).

Red first: a second request on a calmed transport said GetConn zero
times, and a kept connection's try had no TryNet; with the pool saying
it, that try has its net again (reused, one ask, own, send, wait, head).

Fixes #6310

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/nettrace_calm_test.go | 81 ++++++++++++++++++++++++++
 internal/netproxy/calm.go              | 20 ++++++-
 internal/netproxy/calm_test.go         | 35 +++++++++++
 3 files changed, 135 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/nettrace_calm_test.go

diff --git a/internal/gateway/nettrace_calm_test.go b/internal/gateway/nettrace_calm_test.go
new file mode 100644
index 000000000..0fcf3cc3b
--- /dev/null
+++ b/internal/gateway/nettrace_calm_test.go
@@ -0,0 +1,81 @@
+package gateway
+
+import (
+	"context"
+	"crypto/tls"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"net/http/httptrace"
+	"strings"
+	"sync/atomic"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/netproxy"
+)
+
+// A try on a kept HTTP/2 connection has its TryNet: the calmed pool says
+// GetConn when it hands the connection out, so timing() has the request's
+// way out, and tries[].net keeps the Routing page's time — since the pool
+// stopped saying it, a kept connection's try wrote no net at all and the
+// page's "where the time went" said Masking alone (#6310, a keep-alive
+// pair to one vendor).
+func TestTimingOnAKeptCalmConnection(t *testing.T) {
+	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.Copy(io.Discard, r.Body)
+		io.WriteString(w, "ok")
+	}))
+	srv.EnableHTTP2 = true
+	srv.StartTLS()
+	t.Cleanup(srv.Close)
+
+	tr := &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
+	if err := netproxy.CalmHTTP2(tr); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(tr.CloseIdleConnections)
+	url := "https://" + srv.Listener.Addr().String() + "/turn"
+
+	// two tries, the second riding the first's connection, as the
+	// reporter's keep-alive pair: each with its own trace, as the try
+	// loop builds them
+	type one struct {
+		nt                 *netTrace
+		asking, asked, wrt atomic.Int64
+	}
+	tries := []*one{{nt: &netTrace{}}, {nt: &netTrace{}}}
+	var began time.Time
+	for i, o := range tries {
+		ctx := httptrace.WithClientTrace(context.Background(), o.nt.hooks(&o.asking, &o.asked, &o.wrt))
+		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader("{}"))
+		if err != nil {
+			t.Fatal(err)
+		}
+		res, err := tr.RoundTrip(req)
+		if err != nil {
+			t.Fatal(err)
+		}
+		res.Body.Close()
+		if i == len(tries)-1 {
+			began = time.Now().Add(-50 * time.Millisecond) // its own begin, before its GetConn
+		}
+	}
+	tn := tries[1].nt.timing(began, 0)
+	if tn == nil {
+		t.Fatal("a kept connection's try has no TryNet; the Routing page's time says Masking alone")
+	}
+	if !tn.Reused {
+		t.Errorf("the kept connection's try says reused %v; want it on the first's connection", tn.Reused)
+	}
+	if tn.Asks != 1 {
+		t.Errorf("the kept connection's try says %d asks; want 1", tn.Asks)
+	}
+	tn1 := tries[0].nt.timing(time.Now().Add(-50*time.Millisecond), 0)
+	if tn1 == nil {
+		t.Fatal("the dialed try has no TryNet")
+	}
+	if tn1.Asks != 1 {
+		t.Errorf("the dialed try says %d asks; want once, net/http's own", tn1.Asks)
+	}
+}
diff --git a/internal/netproxy/calm.go b/internal/netproxy/calm.go
index c1f3c9928..316a49f95 100644
--- a/internal/netproxy/calm.go
+++ b/internal/netproxy/calm.go
@@ -6,6 +6,7 @@ import (
 	"errors"
 	"net"
 	"net/http"
+	"net/http/httptrace"
 	"sync"
 	"time"
 
@@ -131,6 +132,11 @@ type calmPool struct {
 type calmConn struct {
 	cc *http2.ClientConn
 	w  *watchedConn
+	// getConnCalled: net/http dialed this connection itself, and said the
+	// request's client trace's GetConn on the way — the first request on
+	// it must not hear GetConn twice (the built-in pool's own word for
+	// this, getConnCalled)
+	getConnCalled bool
 }
 
 func (p *calmPool) add(authority string, c *tls.Conn) error {
@@ -142,7 +148,7 @@ func (p *calmPool) add(authority string, c *tls.Conn) error {
 		return err
 	}
 	p.mu.Lock()
-	p.conns[authority] = append(p.conns[authority], &calmConn{cc: cc, w: w})
+	p.conns[authority] = append(p.conns[authority], &calmConn{cc: cc, w: w, getConnCalled: true})
 	p.mu.Unlock()
 	go watch(cc, w, PingAfter, PingWait, PingAgain)
 	return nil
@@ -166,6 +172,18 @@ func (p *calmPool) GetClientConn(req *http.Request, addr string) (*http2.ClientC
 	if got == nil {
 		return nil, http2.ErrNoCachedConn
 	}
+	// a request handed a kept connection hears GetConn, as one whose
+	// connection is dialed does from net/http: the trace's later times
+	// (gotConn, wrote, the vendor's first byte) hang off it, and a
+	// client tracing its way out — the gateway's netTrace, whose
+	// tries[].net the Routing page's time reads — heard nothing of a
+	// request that rode a kept connection without it (#6310)
+	if !got.getConnCalled {
+		if t := httptrace.ContextClientTrace(req.Context()); t != nil && t.GetConn != nil {
+			t.GetConn(addr)
+		}
+	}
+	got.getConnCalled = false
 	got.w.asked()
 	return got.cc, nil
 }
diff --git a/internal/netproxy/calm_test.go b/internal/netproxy/calm_test.go
index 1cc606306..6c4f48379 100644
--- a/internal/netproxy/calm_test.go
+++ b/internal/netproxy/calm_test.go
@@ -7,6 +7,7 @@ import (
 	"net"
 	"net/http"
 	"net/http/httptest"
+	"net/http/httptrace"
 	"strings"
 	"sync"
 	"sync/atomic"
@@ -227,3 +228,37 @@ func waitFor(t *testing.T, ok func() bool, what string) {
 		time.Sleep(10 * time.Millisecond)
 	}
 }
+
+// A request's client trace rides with it on a kept connection too: the
+// pool handing a kept connection out is where the built-in pool says
+// GetConn (its getConnCalled flag), and the gateway's netTrace reads a
+// request's way out — own, asks, first, the usage split riding the same
+// hooks — from GetConn above all (#6310: since the calmed pool, every
+// request that rode a kept HTTP/2 connection wrote no tries[].net, and
+// the Routing page's time said Masking alone).
+func TestCalmedPoolHandsAKeptConnectionOutWithGetConn(t *testing.T) {
+	srv, open := slowH2(t, 0)
+	tr := calmTransport(t)
+	url := "https://" + srv.Listener.Addr().String() + "/turn"
+	var dials, kept atomic.Int32
+	trace := func(n *atomic.Int32) context.Context {
+		return httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
+			GetConn: func(string) { n.Add(1) },
+		})
+	}
+	if _, err := calmAsk(tr, trace(&dials), url); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := calmAsk(tr, trace(&kept), url); err != nil {
+		t.Fatal(err)
+	}
+	if got := open.Load(); got != 1 {
+		t.Fatalf("%d connections open after two turns; want the second on the first's", got)
+	}
+	if got := dials.Load(); got != 1 {
+		t.Fatalf("the dialed request said GetConn %d times; want once, net/http's own", got)
+	}
+	if got := kept.Load(); got == 0 {
+		t.Fatalf("the request on the kept connection said GetConn %d times (the dial's: %d); want it said for the kept one too", kept.Load(), dials.Load())
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
