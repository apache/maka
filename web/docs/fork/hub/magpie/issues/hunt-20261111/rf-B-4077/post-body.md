Refreshed on current `main` (`e6bf4adf1`) — refreshed, not redesigned: same change, rebased with the one conflict resolved to keep both sides (`stallGuard` from upstream's body-stall work wraps the same transports inside this patch's `ClassicalRetry`).

**Red without the fix** (bare `e6bf4adf1`, the gateway tests from this branch — they run the public `upstreamTransport` path, no new symbols):

```
--- FAIL: TestTLSHandshakeTimeoutGoesAgainWithoutThePostQuantumShare (45.00s)
--- FAIL: TestPostWithABodyGoesAgainWholeWithoutTheShare (45.00s)
```

With the fix: both `ok`; `netproxy`'s full package `ok` (9.0s). When the read fails: a body that cannot be had again (`GetBody` nil or erroring) is not sent again — it ends with `ErrPQHandshake`, Go's own words kept in front, and the host is marked so the next requests go straight to the classical transport.

**Verification** (all on `e6bf4adf1`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/gateway -run 'TestTLSHandshake…|TestPostWithABody…'` | ok 60.5s |
| full `go test -timeout 25m ./internal/gateway` | ok 988.5s, zero failures (the default 10m watchdog kills the suite on this machine — `-timeout` raised, nothing skipped) |
| full `go test ./internal/netproxy` | ok 8.9s, zero failures |
| `go test -race ./internal/netproxy` | ok 10.5s |
| `gofmt` / `go vet` | clean |
| `GOOS=linux/windows go build -tags nogui` | ok |
| ablation (netproxy: `HandshakeTimedOut` answers false) | both retry tests red; restored, green |
| ablation (gateway: `Alt` nil — no classical transport) | both gateway tests red (30s); restored, green |
| `git am` on detached `e6bf4adf1` | applies as is; tree identical to the branch head |

**Siblings**: `ClassicalRetry` has two consumers, both in this patch — the vendor transports (`upstream_transport.go`) and magpie's own default client (`netproxy.go:41`). `HandshakeTimedOut` is defined and read once. The `TLS handshake timeout` word already sits in the failure-classification tables (`fallback.go` `transportWords`, `offline.go` `connFailed`); `ErrPQHandshake` keeps Go's words in front of its text, so those classifications keep matching — untouched on purpose.

**Branch with the commit**: [hunt-20261111-rf-4077](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4077) (head `d23ec8a08023a6d7`).

**Not verified**: the reporter's network itself (a middlebox that drops the ~1500-byte X25519MLKEM768 ClientHello — the fixture simulates the handshake timing out; curl-succeeds-Go-fails on the same machine is the reporter's A/B).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: netproxy: a host whose TLS handshake times out on the post-quantum key share goes without it (#4077) — git am applies it as is; SHA-256 first 16: b704e3ef5caaffba</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 10:20:29 +0800
Subject: [PATCH] netproxy: a host whose TLS handshake times out on the
 post-quantum key share goes without it
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Go 1.24 sends a hybrid post-quantum key exchange first (X25519MLKEM768),
whose ClientHello is ~1500 bytes where the classical ones are ~300: on
some network paths that ClientHello is dropped, the handshake gets no
answer, and every request to the provider ends in "net/http: TLS
handshake timeout" — while curl, and the same request through a proxy,
go through (#4077, with the reporter's controlled A/B: X25519MLKEM768
timed out 4/4 direct, X25519 and P-256 answered every time, and
GODEBUG=tlsmlkem=0 restored the connection).

A host whose handshake fails this way is now remembered for half an
hour, and its requests go on the classical curves alone: the request
that met the failure goes again at once on a copy of its body, and one
whose body can't be had again fails saying why (ErrPQHandshake), with
the host marked so the next ones go without from the start. The mark
fades after pqBroken, so a host whose path got fixed speaks the hybrid
share again. The default posture is untouched: only a host met with the
timeout is sent without the share, and no per-provider setting or
process-wide GODEBUG is needed.

The wrapper (netproxy.ClassicalRetry) sits over the gateway's vendor
transports and over http.DefaultClient's (netproxy.Install), which the
provider tests, the model lists and the other provider requests go
through. The gateway's handshake itself gets a 30s bound
(upstreamTLSHandshakeWait), so a hung handshake is given up on and sent
again instead of waiting out the whole header wait.

Fixes #4077

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gateway/upstream_pq_handshake_test.go     | 152 +++++++++++++
 internal/gateway/upstream_transport.go        |  39 +++-
 internal/netproxy/classical.go                | 129 ++++++++++++
 internal/netproxy/classical_test.go           | 199 ++++++++++++++++++
 internal/netproxy/netproxy.go                 |   5 +-
 5 files changed, 514 insertions(+), 10 deletions(-)
 create mode 100644 internal/gateway/upstream_pq_handshake_test.go
 create mode 100644 internal/netproxy/classical.go
 create mode 100644 internal/netproxy/classical_test.go

diff --git a/internal/gateway/upstream_pq_handshake_test.go b/internal/gateway/upstream_pq_handshake_test.go
new file mode 100644
index 000000000..56738e6d8
--- /dev/null
+++ b/internal/gateway/upstream_pq_handshake_test.go
@@ -0,0 +1,152 @@
+package gateway
+
+import (
+	"bytes"
+	"context"
+	"crypto/tls"
+	"io"
+	"net"
+	"net/http"
+	"net/http/httptest"
+	"strconv"
+	"sync/atomic"
+	"testing"
+	"time"
+)
+
+// silentFirstUpstream is a TLS vendor whose first silentFirst new
+// connections are accepted and then say nothing, so the client's handshake
+// times out (a middlebox dropping the large post-quantum ClientHello,
+// #4077); the rest are answered 200 with the body's length.
+type silentFirstUpstream struct {
+	addr    string
+	accepts atomic.Int32
+}
+
+func newSilentFirstUpstream(t *testing.T, silentFirst int32) *silentFirstUpstream {
+	t.Helper()
+	srv := httptest.NewUnstartedServer(nil)
+	srv.StartTLS()
+	cert := srv.TLS.Certificates
+	srv.Close()
+	ln, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	u := &silentFirstUpstream{addr: ln.Addr().String()}
+	served := make(chan net.Conn)
+	done := make(chan struct{})
+	conf := &tls.Config{Certificates: cert, NextProtos: []string{"http/1.1"}}
+	go func() {
+		for {
+			c, err := ln.Accept()
+			if err != nil {
+				return
+			}
+			n := u.accepts.Add(1)
+			go func() {
+				if n <= silentFirst {
+					// accepted, then silent: the handshake never completes
+					select {
+					case <-done:
+					}
+					c.Close()
+					return
+				}
+				tc := tls.Server(c, conf)
+				if tc.Handshake() != nil {
+					c.Close()
+					return
+				}
+				select {
+				case served <- tc:
+				case <-done:
+					c.Close()
+				}
+			}()
+		}
+	}()
+	hs := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		n, _ := io.Copy(io.Discard, r.Body)
+		io.WriteString(w, http.StatusText(200)+" "+strconv.FormatInt(n, 10))
+	})}
+	go hs.Serve(&chanListener{c: served, done: done, addr: ln.Addr()})
+	t.Cleanup(func() {
+		ln.Close()
+		close(done)
+		hs.Close()
+	})
+	return u
+}
+
+func pqTestClient(t *testing.T) *http.Client {
+	t.Helper()
+	was := upstreamTLS
+	upstreamTLS = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // the test's own server
+	t.Cleanup(func() { upstreamTLS = was })
+	cl := &http.Client{Transport: upstreamTransport()}
+	t.Cleanup(cl.CloseIdleConnections)
+	return cl
+}
+
+// pqGet sends a GET within pqTestWait: without the fix, a hung handshake
+// is never given up on, and the request fails with its deadline.
+func pqGet(t *testing.T, cl *http.Client, url string) (*http.Response, error) {
+	t.Helper()
+	ctx, cancel := context.WithTimeout(context.Background(), pqTestWait)
+	defer cancel()
+	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
+	if err != nil {
+		t.Fatal(err)
+	}
+	return cl.Do(req)
+}
+
+// pqTestWait bounds a test request past the handshake's own 30s: the retry
+// after it fits, the hung-handshake failure does not.
+const pqTestWait = 45 * time.Second
+
+// A vendor whose first handshake hangs — the middlebox dropped the large
+// post-quantum ClientHello — is not the end of the request: it goes again
+// without the hybrid share, on a new connection, and is answered.
+func TestTLSHandshakeTimeoutGoesAgainWithoutThePostQuantumShare(t *testing.T) {
+	u := newSilentFirstUpstream(t, 1)
+	res, err := pqGet(t, pqTestClient(t), "https://"+u.addr+"/v1/models")
+	if err != nil {
+		t.Fatalf("a hung handshake did not go again without the post-quantum share: %v", err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if res.StatusCode != 200 {
+		t.Errorf("answered %d %q, want 200", res.StatusCode, b)
+	}
+	if n := u.accepts.Load(); n != 2 {
+		t.Errorf("%d connections, want 2: one hung, one answered", n)
+	}
+}
+
+// A POST whose body is replayable goes again whole: the vendor reads the
+// same bytes on the connection that answers.
+func TestPostWithABodyGoesAgainWholeWithoutTheShare(t *testing.T) {
+	u := newSilentFirstUpstream(t, 1)
+	body := bytes.Repeat([]byte("x"), 1<<20)
+	ctx, cancel := context.WithTimeout(context.Background(), pqTestWait)
+	defer cancel()
+	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+u.addr+"/v1/responses", bytes.NewReader(body))
+	if err != nil {
+		t.Fatal(err)
+	}
+	req.Header.Set("Content-Type", "application/json")
+	res, err := pqTestClient(t).Do(req)
+	if err != nil {
+		t.Fatalf("a POST whose handshake hung did not go again whole: %v", err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if res.StatusCode != 200 || string(b) != "OK "+strconv.Itoa(len(body)) {
+		t.Errorf("answered %d %q, want 200 with the whole body", res.StatusCode, b)
+	}
+	if n := u.accepts.Load(); n != 2 {
+		t.Errorf("%d connections, want 2", n)
+	}
+}
diff --git a/internal/gateway/upstream_transport.go b/internal/gateway/upstream_transport.go
index abeeb3031..ea0217b10 100644
--- a/internal/gateway/upstream_transport.go
+++ b/internal/gateway/upstream_transport.go
@@ -36,14 +36,27 @@ var upstreamTLS *tls.Config
 // it goes through a transport of its own that waits as long as Settings'
 // Image generation timeout gives it (drawWithin), up to 60 minutes.
 func upstreamTransport() http.RoundTripper {
-	return drawsApart{
-		any:     codexSocket{replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(vendorTransport(upstreamHeaderWait))})}},
-		draws:   replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(vendorTransport(0))})},
-		uploads: codexSocket{replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(uploadTransport(upstreamHeaderWait))})}},
-		slow:    new(atomic.Int64),
+	return netproxy.ClassicalRetry{
+		RoundTripper: drawsApart{
+			any:     codexSocket{replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(vendorTransport(upstreamHeaderWait))})}},
+			draws:   replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(vendorTransport(0))})},
+			uploads: codexSocket{replayable{freshAfterRegion(stallGuard{netproxy.Dispatch(uploadTransport(upstreamHeaderWait))})}},
+			slow:    new(atomic.Int64),
+		},
+		Alt: netproxy.Dispatch(classicalVendor()),
 	}
 }
 
+// classicalVendor is a transport to the vendors without the hybrid
+// post-quantum key share: what the upstream transports' ClassicalRetry
+// sends a host through once its handshake has timed out on the share
+// (netproxy, #4077).
+func classicalVendor() *http.Transport {
+	t := vendorTransport(upstreamHeaderWait)
+	t.TLSClientConfig = netproxy.ClassicalTLS(t.TLSClientConfig)
+	return t
+}
+
 // upstreamHeaderWait is how long a vendor is given to begin answering a
 // request that isn't a drawing.
 var upstreamHeaderWait = 10 * time.Minute
@@ -66,10 +79,13 @@ var slowFor = 30 * time.Minute
 var uploadStall = time.Minute
 
 // vendorTransport is a transport to the vendors that gives one wait to
-// begin answering, none for 0: the request's context then bounds it.
-// A silent HTTP/2 connection is pinged and dropped (#2843), by a health
-// check that doesn't ping a vendor still thinking into ending the
-// connection (netproxy.CalmHTTP2).
+// begin answering, none for 0: the request's context then bounds it. The
+// handshake itself gets upstreamTLSHandshakeWait, so one that gets no
+// answer — the large post-quantum ClientHello dropped by the path
+// (netproxy.ClassicalRetry) — is given up on and sent again, not waited
+// out for the whole header wait. A silent HTTP/2 connection is pinged
+// and dropped (#2843), by a health check that doesn't ping a vendor
+// still thinking into ending the connection (netproxy.CalmHTTP2).
 func vendorTransport(wait time.Duration) *http.Transport {
 	t := plainVendorTransport(wait)
 	netproxy.CalmHTTP2(t)
@@ -80,6 +96,7 @@ func plainVendorTransport(wait time.Duration) *http.Transport {
 	return &http.Transport{
 		Proxy:                 netproxy.Func,
 		ResponseHeaderTimeout: wait,
+		TLSHandshakeTimeout:   upstreamTLSHandshakeWait,
 		MaxIdleConnsPerHost:   8,
 		IdleConnTimeout:       90 * time.Second,
 		ForceAttemptHTTP2:     true,
@@ -87,6 +104,10 @@ func plainVendorTransport(wait time.Duration) *http.Transport {
 	}
 }
 
+// upstreamTLSHandshakeWait is how long a vendor's TLS handshake may take
+// before the connection is given up on.
+var upstreamTLSHandshakeWait = 30 * time.Second
+
 // uploadTransport is vendorTransport for a request whose body may still be
 // under way when the connection has had no frame for a while: an HTTP/2
 // ping is written behind that body's own DATA, so its answer comes only
diff --git a/internal/netproxy/classical.go b/internal/netproxy/classical.go
new file mode 100644
index 000000000..af7465271
--- /dev/null
+++ b/internal/netproxy/classical.go
@@ -0,0 +1,129 @@
+package netproxy
+
+import (
+	"crypto/tls"
+	"fmt"
+	"net/http"
+	"strings"
+	"sync"
+	"time"
+)
+
+// The hybrid post-quantum key share (#4077: a provider's API answered
+// curl, and Go alone timed its TLS handshake out, direct, on every model
+// test). Go 1.24 sends a hybrid post-quantum key exchange first by
+// default, X25519MLKEM768, whose ClientHello is ~1500 bytes where the
+// classical ones are ~300 — big enough that some networks and middleboxes
+// drop it, and the handshake never completes. A host whose handshake
+// fails this way is remembered for a while, and its requests go without
+// the hybrid share — classical curves alone: the request that met the
+// failure goes again at once when its body can be had again, and is said
+// plainly why when it can't. The mark fades after pqBroken, so a host
+// whose path got fixed speaks the hybrid share again.
+
+// pqBroken is how long a host:port whose TLS handshake timed out this way
+// goes without the hybrid key share.
+const pqBroken = 30 * time.Minute
+
+var pqOnly struct {
+	sync.Mutex
+	at map[string]time.Time // host:port → when its handshake timed out
+}
+
+func pqSince(addr string) time.Time {
+	pqOnly.Lock()
+	defer pqOnly.Unlock()
+	at := pqOnly.at[addr]
+	if !at.IsZero() && time.Since(at) > pqBroken {
+		delete(pqOnly.at, addr)
+		return time.Time{}
+	}
+	return at
+}
+
+func markPQ(addr string) {
+	pqOnly.Lock()
+	defer pqOnly.Unlock()
+	if pqOnly.at == nil {
+		pqOnly.at = map[string]time.Time{}
+	}
+	pqOnly.at[addr] = time.Now()
+}
+
+// ClassicalTLS is base with the classical key exchanges alone (X25519,
+// then P-256), no hybrid post-quantum share; base's other settings kept.
+func ClassicalTLS(base *tls.Config) *tls.Config {
+	if base == nil {
+		return &tls.Config{CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256}}
+	}
+	c := base.Clone()
+	c.CurvePreferences = []tls.CurveID{tls.X25519, tls.CurveP256}
+	return c
+}
+
+// ClassicalRetry sends a request through RoundTripper — and when that
+// fails with a timed-out TLS handshake, the way one whose large
+// post-quantum ClientHello the path drops fails (HandshakeTimedOut),
+// through Alt, which goes without the share: at once, on a copy of the
+// body, when the request can be sent again; never (the host marked, so
+// the next ones go without from the start) when it can't, with
+// ErrPQHandshake saying why. A host marked before, within pqBroken, goes
+// to Alt from the start.
+type ClassicalRetry struct {
+	RoundTripper http.RoundTripper
+	Alt          http.RoundTripper
+}
+
+func (t ClassicalRetry) RoundTrip(req *http.Request) (*http.Response, error) {
+	if req.URL != nil && !pqSince(hostPort(req)).IsZero() {
+		return t.Alt.RoundTrip(req)
+	}
+	res, err := t.RoundTripper.RoundTrip(req)
+	if err == nil || req.URL == nil || !HandshakeTimedOut(err) {
+		return res, err
+	}
+	markPQ(hostPort(req))
+	if t.Alt == nil || req.Context().Err() != nil {
+		return nil, ErrPQHandshake{err}
+	}
+	again := req.Clone(req.Context())
+	if req.Body != nil && req.Body != http.NoBody {
+		if req.GetBody == nil {
+			return nil, ErrPQHandshake{err}
+		}
+		body, berr := req.GetBody()
+		if berr != nil {
+			return nil, err
+		}
+		again.Body = body
+	}
+	return t.Alt.RoundTrip(again)
+}
+
+// classicalDefault is a transport like the default one, with the
+// classical key exchanges alone: what ClassicalRetry's Alt goes through.
+func classicalDefault() *http.Transport {
+	t := http.DefaultTransport.(*http.Transport).Clone()
+	t.TLSClientConfig = ClassicalTLS(t.TLSClientConfig)
+	return t
+}
+
+// HandshakeTimedOut says err is Go's transport giving up on a TLS
+// handshake that got no answer — the way one whose ClientHello the path
+// drops times out. A vendor that answers slowly later in the request is
+// another error.
+func HandshakeTimedOut(err error) bool {
+	return strings.Contains(err.Error(), "TLS handshake timeout")
+}
+
+// ErrPQHandshake is the error a request ends with when its TLS handshake
+// timed out this way and it could not be sent again: what happened, with
+// Go's own words kept in front (the request log and the offline words
+// read them) and what it means for the next requests.
+type ErrPQHandshake struct{ err error }
+
+func (e ErrPQHandshake) Error() string {
+	return fmt.Sprintf("%v (the TLS handshake got no answer: this network drops Go's large post-quantum key share, so this host's requests go without it from now on)", e.err)
+}
+
+func (e ErrPQHandshake) Unwrap() error { return e.err }
diff --git a/internal/netproxy/classical_test.go b/internal/netproxy/classical_test.go
new file mode 100644
index 000000000..314db29be
--- /dev/null
+++ b/internal/netproxy/classical_test.go
@@ -0,0 +1,199 @@
+package netproxy
+
+import (
+	"context"
+	"crypto/tls"
+	"errors"
+	"io"
+	"net"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+)
+
+// The vendor is example.com: the base transport dials a connection that is
+// accepted and then says nothing — the handshake times out, the way one
+// whose large post-quantum ClientHello the path dropped does (#4077) —
+// and Alt dials a real TLS server.
+type pqTestUpstream struct {
+	srv   *httptest.Server
+	hole  net.Listener
+	held  chan net.Conn
+	done  chan struct{}
+	dials []string
+	mu    sync.Mutex
+}
+
+func newPQTestUpstream(t *testing.T) *pqTestUpstream {
+	t.Helper()
+	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		io.WriteString(w, r.Method+" "+string(b))
+	}))
+	srv.EnableHTTP2 = false
+	srv.StartTLS()
+	holeLn, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	q := &pqTestUpstream{srv: srv, hole: holeLn, held: make(chan net.Conn, 8), done: make(chan struct{})}
+	go func() {
+		for {
+			c, err := holeLn.Accept()
+			if err != nil {
+				return
+			}
+			select {
+			case q.held <- c:
+			case <-q.done:
+				c.Close()
+			}
+		}
+	}()
+	t.Cleanup(func() {
+		close(q.done)
+		holeLn.Close()
+		srv.Close()
+		for {
+			select {
+			case c := <-q.held:
+				c.Close()
+			default:
+				return
+			}
+		}
+	})
+	return q
+}
+
+func (q *pqTestUpstream) client() *http.Client {
+	tlsConf := q.srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
+	dialer := &net.Dialer{}
+	base := &http.Transport{
+		TLSClientConfig:     tlsConf,
+		TLSHandshakeTimeout: 300 * time.Millisecond,
+	}
+	base.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
+		q.mu.Lock()
+		q.dials = append(q.dials, "base")
+		q.mu.Unlock()
+		return dialer.DialContext(ctx, "tcp", q.hole.Addr().String())
+	}
+	alt := &http.Transport{
+		TLSClientConfig:     ClassicalTLS(tlsConf),
+		TLSHandshakeTimeout: 300 * time.Millisecond,
+	}
+	alt.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
+		q.mu.Lock()
+		q.dials = append(q.dials, "alt")
+		q.mu.Unlock()
+		return dialer.DialContext(ctx, "tcp", q.srv.Listener.Addr().String())
+	}
+	return &http.Client{Transport: ClassicalRetry{RoundTripper: base, Alt: alt}}
+}
+
+func (q *pqTestUpstream) dialed() string {
+	q.mu.Lock()
+	defer q.mu.Unlock()
+	return strings.Join(q.dials, ",")
+}
+
+func cleanPQMarks(t *testing.T) {
+	t.Cleanup(func() { pqOnly.Lock(); pqOnly.at = nil; pqOnly.Unlock() })
+}
+
+// A handshake that gets no answer — the large post-quantum ClientHello
+// dropped by the path — is not the end of the request: it goes again
+// without the hybrid share and is answered, and the host goes without it
+// from the start after that.
+func TestClassicalRetrySendsAgainWithoutTheHybridShare(t *testing.T) {
+	cleanPQMarks(t)
+	q := newPQTestUpstream(t)
+	cl := q.client()
+	res, err := cl.Get("https://example.com/v1/models")
+	if err != nil {
+		t.Fatalf("a request whose handshake got no answer did not go again without the share: %v", err)
+	}
+	io.Copy(io.Discard, res.Body)
+	res.Body.Close()
+	if got := q.dialed(); got != "base,alt" {
+		t.Fatalf("dials %s, want base,alt", got)
+	}
+	if pqSince("example.com:443").IsZero() {
+		t.Fatalf("the host was not marked")
+	}
+	// the next request goes without the share from the start, on the
+	// connection the first one's second try left
+	res, err = cl.Get("https://example.com/v1/models")
+	if err != nil {
+		t.Fatalf("a marked host's request failed: %v", err)
+	}
+	io.Copy(io.Discard, res.Body)
+	res.Body.Close()
+	if got := q.dialed(); got != "base,alt" {
+		t.Fatalf("dials %s, want base,alt", got)
+	}
+}
+
+// A body that can't be had again is not sent again: the request fails
+// saying why, and the host still goes without the share from the next
+// request on.
+func TestAnUnreplayableBodySaysWhyAndMarksTheHost(t *testing.T) {
+	cleanPQMarks(t)
+	q := newPQTestUpstream(t)
+	cl := q.client()
+	req, _ := http.NewRequest(http.MethodPost, "https://example.com/v1/responses", plainReader{strings.NewReader("turn")})
+	_, err := cl.Do(req)
+	var pq ErrPQHandshake
+	if !errors.As(err, &pq) {
+		t.Fatalf("err = %v, want ErrPQHandshake", err)
+	}
+	if !strings.Contains(err.Error(), "TLS handshake timeout") || !strings.Contains(err.Error(), "without it") {
+		t.Errorf("err = %v, want Go's words and the why", err)
+	}
+	res, err := cl.Get("https://example.com/v1/models")
+	if err != nil {
+		t.Fatalf("the marked host's next request failed: %v", err)
+	}
+	res.Body.Close()
+	if got := q.dialed(); got != "base,alt" {
+		t.Fatalf("dials %s, want base,alt", got)
+	}
+}
+
+type plainReader struct{ io.Reader }
+
+// The classical config keeps base's settings and drops the hybrid share
+// alone.
+func TestTheClassicalConfigDropsTheHybridShareAlone(t *testing.T) {
+	base := &tls.Config{MinVersion: tls.VersionTLS12}
+	c := ClassicalTLS(base)
+	if c.MinVersion != tls.VersionTLS12 || c == base {
+		t.Errorf("base's settings not kept, or the config shared")
+	}
+	if len(c.CurvePreferences) != 2 || c.CurvePreferences[0] != tls.X25519 || c.CurvePreferences[1] != tls.CurveP256 {
+		t.Errorf("CurvePreferences %v, want X25519 then P-256", c.CurvePreferences)
+	}
+}
+
+// The mark fades: after pqBroken the host is asked with the share again,
+// and met with the timeout, it is marked and sent without once more.
+func TestTheMarkFades(t *testing.T) {
+	cleanPQMarks(t)
+	q := newPQTestUpstream(t)
+	cl := q.client()
+	pqOnly.Lock()
+	pqOnly.at = map[string]time.Time{"example.com:443": time.Now().Add(-pqBroken - time.Minute)}
+	pqOnly.Unlock()
+	res, err := cl.Get("https://example.com/v1/models")
+	if err != nil {
+		t.Fatalf("a request after the mark faded did not go again without the share: %v", err)
+	}
+	res.Body.Close()
+	if got := q.dialed(); got != "base,alt" {
+		t.Fatalf("dials %s, want base,alt", got)
+	}
+}
diff --git a/internal/netproxy/netproxy.go b/internal/netproxy/netproxy.go
index f07ba522c..2ee17142d 100644
--- a/internal/netproxy/netproxy.go
+++ b/internal/netproxy/netproxy.go
@@ -38,7 +38,10 @@ func Install() {
 		}
 		// a request magpie sends a provider on its own (a Test, a model
 		// list) is written into the request log as it goes (probelog)
-		http.DefaultClient.Transport = probelog.Transport(Dispatch(t))
+		http.DefaultClient.Transport = probelog.Transport(ClassicalRetry{
+			RoundTripper: Dispatch(t),
+			Alt:          Dispatch(classicalDefault()),
+		})
 	}
 }
 
-- 
2.50.1 (Apple Git-155)

```
</details>
